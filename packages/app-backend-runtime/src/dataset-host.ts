import { createHash, randomUUID } from "node:crypto";
import { parseAppBackendCaller, parseAppBackendJson, type AppBackendCaller } from "@dohc/security-contract/app-backend";
import { DATASET_UNDO_BYTES, datasetRevisionsPreserveAccess, describeApprovedDataset, parseDatasetRevision, type AppDatasetBinding, type DatasetDescription, type DatasetOperation, type DatasetRevision } from "@dohc/security-contract/dataset";
import { effectiveDatasetOperations, parseDatasetBinding, hasGeneratedDatasetRevision } from "@dohc/security-contract/dataset-authorization";
export type { DatasetDescription } from "@dohc/security-contract/dataset";
import { validateDatasetReadResult } from "./dataset-read-result.js";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import { initializeAppDatabase, type AppBackendRuntimeOptions } from "./index.js";
import type { PersistentRuntimeOptions } from "./persistent.js";
import type { DatasetCursor, DatasetJournal, DatasetScope, JournalDb } from "./journal.js";
import type { DatasetInvocation, DatasetInvocationResult, DatasetMigration, createDatasetSupervisor, DatasetMigrationCandidate } from "./supervisor.js";
import type { AppOperationRefusal, JsonValue } from "./protocol.js";
import { prepareDatasetRecoveryExport, type RecoveryAttachment } from "./recovery-export.js";
import { stageDatasetRecovery, type RecoveryLimits } from "./recovery.js";
import { validateDatasetRecovery } from "./recovery-import.js";
import { createRecoveryInstaller, type RecoveryInstallOptions } from "./recovery-install.js";
import { equalRecoveryCursor } from "./recovery-record.js";
import type { CheckpointStageAllocation } from "./checkpoint-storage.js";
import { createDatasetReplicaHost } from "./replica-host.js";
import { readDatasetHistory, readDatasetHistoryRevision } from "./dataset-history.js";
import { initializeDatasetAttempts, reviewDatasetAttempts, reconcileDatasetAttempt, cancelDatasetAttempt, assertDatasetAttemptsCommitted, assertDatasetAttemptNotCancelled } from "./dataset-attempts.js";
import { createDatasetAutomationClaims, DATASET_AUTOMATION_CHAIN_DEPTH, type DatasetActor, type DatasetPressed, type DatasetPressInput } from "./dataset-automation-claims.js";

export type DatasetAccess = { kind: "data" } | { kind: "app"; appId: string };
export class DatasetHostError extends Error {
  constructor(readonly code: "not_authorized" | "conflict" | "invalid", message: string) {
    super(message); this.name = "DatasetHostError";
  }
}
/** Resolve only immutable revisions already approved at this host; callers cannot supply compatibility. */
export function resolveCompatibleDatasetRevision(db: JournalDb, key: DatasetScope, reference: { revision: number; revisionSha256: string }, current?: DatasetRevision): DatasetRevision {
  const row = current ? undefined : db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
  const approved = current ?? (row ? parseDatasetRevision(JSON.parse(String(row.revision_json))) : undefined);
  if (!approved) throw new DatasetHostError("not_authorized", "You do not have access to this Collection.");
  if (reference.revision === approved.revision && reference.revisionSha256 === approved.revisionSha256) return approved;
  const saved = db.prepare("SELECT revision_json FROM dohc_dataset_catalog_history WHERE workspace_id=? AND dataset_id=? AND revision>=? ORDER BY revision").all(key.workspaceId,key.datasetId,reference.revision);
  const history = saved.map(row => parseDatasetRevision(JSON.parse(String(row.revision_json))));
  const previous = history[0];
  const executable = db.prepare("SELECT source FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
  if (!previous || previous.revision !== reference.revision || previous.revisionSha256 !== reference.revisionSha256 || history.length !== approved.revision-reference.revision || !executable)
    throw new DatasetHostError("conflict", "The Collection's rules changed. Its owner must approve this access again.");
  for (const [index, revision] of history.entries()) {
    const checkpoint = db.prepare("SELECT source FROM dohc_dataset_checkpoint_history WHERE workspace_id=? AND dataset_id=? AND json_extract(cursor_json,'$.approvedRevisionHash')=? LIMIT 1").get(key.workspaceId,key.datasetId,revision.revisionSha256);
    if (revision.revision !== reference.revision+index || !datasetRevisionsPreserveAccess(revision,approved) || !checkpoint || checkpoint.source !== executable.source)
      throw new DatasetHostError("conflict", "The Collection's rules changed. Its owner must approve this access again.");
  }
  return previous;
}
export interface DatasetAuthority {
  caller: AppBackendCaller;
  /** Stable identity derived from the credential, never from request JSON. */
  principalKey: string;
  /** Required for app access, after checking the current publication credential. */
  appId?: string;
  /** Host permission/publication generation; changes invalidate in-flight work. */
  authorityToken?: string;
  /**
   * The chain depth an automation caller's writes declare, one more than the
   * change that started its run. Required for that caller, refused for any
   * other.
   */
  chainDepth?: number;
  /**
   * Set only when the owner's agent writes in a run an automation started,
   * with the chain depth the run's writes declare. Attribution that grants
   * nothing: it requires the owner caller, and owner administration refuses
   * it.
   */
  agent?: { depth: number };
}
export interface DatasetDataGrant { operationIds: string[]; discover: boolean; revision: number; revisionSha256: string }
export interface DatasetHostOptions<Context> {
  db: JournalDb;
  transaction: <T>(run: () => T) => T;
  journal: DatasetJournal;
  supervisor: { invoke(input: DatasetInvocation): Promise<DatasetInvocationResult>; migrate(input: DatasetMigration): Promise<DatasetCursor>; retire?(scope: DatasetScope): Promise<void> } & Partial<Pick<Awaited<ReturnType<typeof createDatasetSupervisor>>, "prepareMigration"|"approveMigration"|"migrationPreviewPage"|"discardMigration">>;
  /** Synchronous. Validate current workspace membership or current app credential here. */
  /** datasetId is absent only for workspace catalog discovery. */
  resolveAuthority(context: Context, request: { workspaceId: string; datasetId?: string; access: DatasetAccess }): DatasetAuthority;
  runtime?: AppBackendRuntimeOptions;
  persistentRuntime?: PersistentRuntimeOptions;
  /** Compile the captured operations artifact to the runtime's supported JavaScript. */
  compileOperations?(source: string, path: string): string | Promise<string>;
  /** Runs in the journal transaction and includes retained catalog artifact bytes. */
  accountCreation?(context: Context, allocation: DatasetScope & { bytes: number; capacityBytes: number }): void;
  /** Signed retained-byte delta; runs in the binding or grant transaction. */
  accountMetadata?(context: Context, allocation: DatasetScope & { bytes: number }): void;
  /** Remove host-private resources and refund their ledger inside the destruction transaction. */
  deleteResources?(context: Context, scope: DatasetScope): void;
  /** Checkpoint retention and signed catalog replacement delta, in the transition transaction. */
  accountMigration?(context: Context, allocation: DatasetScope & { bytes: number; capacityBytes: number; capacityDeltaBytes: number }): void;
  /** Signed staging reservation; use the same retained-byte counter as accountMigration. */
  accountCheckpointStage?(context: Context, allocation: Readonly<CheckpointStageAllocation>): void;
  /** Resolve uploaded files and quota accounting from trusted host state. */
  operationResources?(context: Context, request: DatasetScope & { authority: DatasetAuthority; operation: DatasetOperation; input: JsonValue }): Pick<DatasetInvocation, "files" | "accountAndAttach">;
  /**
   * Signed retained bytes of automation claims and History rows, in the ledger's
   * transaction. It takes no context: the executor settles claims outside any request.
   */
  accountAutomations?(allocation: DatasetScope & { bytes: number }): void;
  /** Called after a commit that made automation claims. A hint: the executor also drains at open. */
  wakeAutomations?(scope: DatasetScope): void;
  recovery?: {
    directory: string;
    limits: RecoveryLimits;
    captureAttachments?(context: Context, scope: DatasetScope, cursor: DatasetCursor): RecoveryAttachment[];
    openAttachment?(context: Context, scope: DatasetScope, file: RecoveryAttachment): AsyncIterable<Uint8Array>;
    install?: Omit<RecoveryInstallOptions<Context>, "db" | "transaction" | "journal">;
  };
}
export interface ActivateDatasetInput {
  workspaceId: string;
  revision: DatasetRevision;
  schemaSql: string;
  operationSource: string;
  capacityBytes?: number;
  signal?: AbortSignal;
}
export interface InvokeDatasetInput extends DatasetScope {
  revision: number;
  revisionSha256: string;
  operationId: string;
  input: JsonValue;
  idempotencyKey: string;
  access?: DatasetAccess;
  signal?: AbortSignal;
}
export interface MigrateDatasetInput extends Omit<ActivateDatasetInput, "capacityBytes"> {
  expected: DatasetCursor;
  migrationSql: string;
}
type StoredGrant = DatasetDataGrant;
type Permission = { authority: DatasetAuthority; revision: DatasetRevision; operations: DatasetOperation[]; token: string; discover: boolean; linkReads?: AppDatasetBinding["linkReads"]; createFields?: AppDatasetBinding["createFields"] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function text(value: string, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.includes("\0") || Buffer.byteLength(value) > maximum) throw new DatasetHostError("invalid", "Invalid Collection id.");
  return value;
}
function synchronous<T>(run: () => T): T {
  if (run.constructor.name === "AsyncFunction") throw new Error("Dataset host callbacks must be synchronous.");
  const result = run();
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Dataset host callbacks must be synchronous.");
  return result;
}
/**
 * Why a reversible action's result cannot commit, or null: it must hold
 * `undo`, the input its reverse action takes, within DATASET_UNDO_BYTES, so
 * every change it makes has a way back.
 */
function missingUndo(operation: DatasetOperation, result: JsonValue): AppOperationRefusal | null {
  const undo = result !== null && typeof result === "object" && !Array.isArray(result) && Object.hasOwn(result, "undo") ? result.undo : undefined;
  if (undo !== undefined) {
    try { parseAppBackendJson(undo, DATASET_UNDO_BYTES); return null; } catch { /* Refused below. */ }
  }
  return { code: "undo_missing", message: `${operation.label} is reversed by ${operation.reversedBy}, so it must return undo: the input ${operation.reversedBy} takes to reverse it, at most 16 KB.` };
}
function denied(): never { throw new DatasetHostError("not_authorized", "You do not have access to this Collection."); }
function chainDepth(value: number | undefined, caller: AppBackendCaller): number | undefined {
  if (caller.kind !== "automation") {
    if (value !== undefined) denied();
    return undefined;
  }
  if (value === undefined || !Number.isSafeInteger(value) || value < 1 || value > DATASET_AUTOMATION_CHAIN_DEPTH) denied();
  return value;
}
/** The engine's bound on any declared chain depth. The chain stops well before it. */
const MAX_DECLARED_DEPTH = 64;
function agent(value: DatasetAuthority["agent"], caller: AppBackendCaller): DatasetAuthority["agent"] {
  if (value === undefined) return undefined;
  if (caller.kind !== "owner" || !Number.isSafeInteger(value.depth) || value.depth < 1 || value.depth > MAX_DECLARED_DEPTH) denied();
  return { depth: value.depth };
}
/** Who made a commit, from the authority the host derived. */
function actor(authority: DatasetAuthority): DatasetActor {
  if (authority.caller.kind === "automation") return { kind: "automation", automationId: authority.caller.automationId, depth: authority.chainDepth! };
  if (authority.agent) return { kind: "agent", depth: authority.agent.depth };
  const app = authority.appId === undefined ? {} : { appId: authority.appId }, caller = authority.caller;
  if (caller.kind === "named") return { kind: "named", userId: caller.userId, ...app };
  return caller.kind === "owner" ? { kind: "owner", ...app } : { kind: "link", ...app };
}
function scope(input: DatasetScope): DatasetScope { return { workspaceId: text(input.workspaceId), datasetId: text(input.datasetId) }; }
function access(input: DatasetAccess = { kind: "data" }): DatasetAccess {
  if (input.kind === "data" && Object.keys(input).length === 1) return { kind: "data" };
  if (input.kind === "app" && Object.keys(input).length === 2) return { kind: "app", appId: text(input.appId) };
  throw new DatasetHostError("invalid", "Invalid Collection access path.");
}

/** Captures approved source once. Every consumer uses that source and current host authority. */
export function createDatasetHost<Context>(options: DatasetHostOptions<Context>) {
  for (const callback of [options.transaction, options.resolveAuthority, options.accountCreation, options.accountMetadata, options.accountMigration, options.accountCheckpointStage, options.operationResources, options.deleteResources, options.accountAutomations]) {
    if (callback?.constructor.name === "AsyncFunction") throw new Error("Dataset host callbacks must be synchronous.");
  }
  const { db, journal } = options;
  // Only artifact-verified revisions read from this host's catalog reach this cache.
  const generatedVerdicts = new Map<string, boolean>();
  function generatedRevision(approved: DatasetRevision): boolean {
    const cached = generatedVerdicts.get(approved.revisionSha256);
    if (cached !== undefined) return cached;
    const verdict = hasGeneratedDatasetRevision(approved);
    if (generatedVerdicts.size >= 64) generatedVerdicts.delete(generatedVerdicts.keys().next().value!);
    generatedVerdicts.set(approved.revisionSha256, verdict);
    return verdict;
  }
  const migrationCandidates=new Map<string,{candidate:DatasetMigrationCandidate;authorityKey:string;approved:DatasetRevision;previous:DatasetRevision;schemaSql:string;source:string}>();
  const transaction = <T>(run: () => T): T => synchronous(() => options.transaction(() => synchronous(run)));
  transaction(() => initializeDatasetAttempts(db));
  // The journal's own database, so each commit's claims are part of it.
  const automations = createDatasetAutomationClaims({ db, transaction, wake: options.wakeAutomations,
    account(key, bytes) { if (options.accountAutomations) synchronous(() => options.accountAutomations!({ ...key, bytes })); } });
  transaction(() => db.exec(`
    CREATE INDEX IF NOT EXISTS dohc_dataset_checkpoint_approval ON dohc_dataset_checkpoint_history(workspace_id,dataset_id,json_extract(cursor_json,'$.approvedRevisionHash'));
    CREATE TABLE IF NOT EXISTS dohc_dataset_catalog (
      workspace_id TEXT NOT NULL, dataset_id TEXT NOT NULL, revision_json TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_catalog_history (
      workspace_id TEXT NOT NULL, dataset_id TEXT NOT NULL, revision INTEGER NOT NULL,
      revision_json TEXT NOT NULL, artifacts_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id,revision)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_bindings (
      workspace_id TEXT NOT NULL, dataset_id TEXT NOT NULL, app_id TEXT NOT NULL,
      binding_json TEXT NOT NULL, token TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id,app_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_data_grants (
      workspace_id TEXT NOT NULL, dataset_id TEXT NOT NULL, principal_key TEXT NOT NULL,
      grant_json TEXT NOT NULL, token TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id,principal_key)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_lifecycle (
      workspace_id TEXT NOT NULL, dataset_id TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN(0,1)),
      generation INTEGER NOT NULL, reason TEXT NOT NULL, archived_at_ms INTEGER,
      PRIMARY KEY(workspace_id,dataset_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_review_generations (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,generation INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id)) STRICT;
  `));
  transaction(() => {
    for (const table of ["dohc_dataset_bindings", "dohc_dataset_data_grants", "dohc_dataset_lifecycle"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const row = operation === "DELETE" ? "OLD" : "NEW";
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_review_${operation} AFTER ${operation} ON ${table} BEGIN
          INSERT INTO dohc_dataset_review_generations VALUES(${row}.workspace_id,${row}.dataset_id,1)
          ON CONFLICT(workspace_id,dataset_id) DO UPDATE SET generation=generation+1; END;`);
      }
    }
  });
  function reviewToken(key: DatasetScope, cursor: DatasetCursor) {
    const generation = db.prepare("SELECT generation FROM dohc_dataset_review_generations WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId)?.generation ?? 0;
    return hash(JSON.stringify([cursor.workspaceId,cursor.datasetId,cursor.hostEpoch,cursor.approvedRevisionHash,cursor.revision,cursor.digest,generation]));
  }
  function authority(context: Context, key: { workspaceId: string; datasetId?: string }, through: DatasetAccess): DatasetAuthority {
    const result = synchronous(() => options.resolveAuthority(context, { ...key, access: through }));
    const caller = parseAppBackendCaller(result.caller);
    const verified = { caller, principalKey: text(result.principalKey),
      appId: result.appId === undefined ? undefined : text(result.appId),
      authorityToken: result.authorityToken === undefined ? undefined : text(result.authorityToken, 1024),
      chainDepth: chainDepth(result.chainDepth, caller), agent: agent(result.agent, caller) };
    if (through.kind === "app" && verified.appId !== through.appId) denied();
    // An automation acts for its Collection, never as an app.
    if (caller.kind === "automation" && through.kind !== "data") denied();
    return verified;
  }
  function owner(context: Context, key: { workspaceId: string; datasetId?: string }): DatasetAuthority {
    const result = authority(context, key, { kind: "data" });
    if (result.caller.kind !== "owner" || result.agent) denied();
    return result;
  }
  function revision(key: DatasetScope): DatasetRevision {
    const row = db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
    if (!row) denied();
    return parseDatasetRevision(JSON.parse(String(row.revision_json)));
  }
  function lifecycle(key: DatasetScope): { archived: boolean; generation: number; reason: string } {
    const row = db.prepare("SELECT archived,generation,reason FROM dohc_dataset_lifecycle WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
    return row ? { archived: Number(row.archived) === 1, generation: Number(row.generation), reason: String(row.reason) } : { archived: false, generation: 0, reason: "" };
  }
  function live(key: DatasetScope) { if (lifecycle(key).archived) throw new DatasetHostError("conflict", "This Collection is archived. Its owner can restore it."); }
  function artifacts(key: DatasetScope): { schemaSql: string; operationSource: string } {
    const row = db.prepare("SELECT artifacts_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
    if (!row) denied();
    const value = JSON.parse(String(row.artifacts_json));
    if (!value || typeof value.schemaSql !== "string" || typeof value.operationSource !== "string") throw new Error("This Collection's saved rules are damaged.");
    return value;
  }
  async function compile(source: string, path: string): Promise<string> {
    if (path.endsWith(".ts") && !options.compileOperations) throw new Error("This host cannot build TypeScript Collection actions.");
    const result = options.compileOperations ? await options.compileOperations(source, path) : source;
    if (typeof result !== "string" || !result.length || Buffer.byteLength(result) > 256 * 1024 || result.includes("\0")) throw new Error("The built Collection actions are larger than this host allows.");
    return result;
  }
  function currentGrant(key: DatasetScope, value: unknown, approved: DatasetRevision): StoredGrant {
    const grant = value as StoredGrant;
    resolveCompatibleDatasetRevision(db,key,grant,approved);
    return grant;
  }
  function permissions(context: Context, key: DatasetScope, through: DatasetAccess, includeArchived = false): Permission {
    const verified = authority(context, key, through), approved = revision(key);
    const state = lifecycle(key);
    if (state.archived && !(includeArchived && verified.caller.kind === "owner" && through.kind === "data")) throw new DatasetHostError("conflict", "This Collection is archived. Its owner can restore it.");
    // The owner and an automation start from every approved operation. An
    // automation's run checks its reach (ADR 0012) before it invokes one.
    let operations = approved.definition.operations, token = "owner", discover = true, createFields: AppDatasetBinding["createFields"], linkReads: AppDatasetBinding["linkReads"];
    if (through.kind === "app") {
      const row = db.prepare("SELECT binding_json,token FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?").get(key.workspaceId, key.datasetId, through.appId);
      if (!row) denied();
      const binding = JSON.parse(String(row.binding_json)) as AppDatasetBinding;
      const boundRevision = resolveCompatibleDatasetRevision(db,key,binding,approved);
      let dataToken = "", allowedHelperIds = new Set<string>();
      if (verified.caller.kind === "named") {
        const grant = db.prepare("SELECT grant_json,token FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").get(key.workspaceId, key.datasetId, verified.principalKey);
        if (grant) {
          const parsed = JSON.parse(String(grant.grant_json)) as StoredGrant;
          try { currentGrant(key,parsed,approved); allowedHelperIds = new Set(parsed.operationIds); }
          catch (error) { if (!(error instanceof DatasetHostError) || error.code !== "conflict") throw error; }
          dataToken = String(grant.token);
        }
        verified.caller = { ...verified.caller, helper: allowedHelperIds.size > 0 };
      }
      operations = effectiveDatasetOperations(binding, boundRevision, verified.caller, generatedRevision)
        .filter(operation => verified.caller.kind === "owner" || operation.access !== "helper" || allowedHelperIds.has(operation.operationId));
      token = JSON.stringify([row.token, dataToken]); discover = false;
      createFields = binding.createFields; linkReads = binding.linkReads;
    } else if (verified.caller.kind !== "owner" && verified.caller.kind !== "automation") {
      const row = db.prepare("SELECT grant_json,token FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").get(key.workspaceId, key.datasetId, verified.principalKey);
      if (!row) denied();
      const grant = currentGrant(key,JSON.parse(String(row.grant_json)), approved);
      // A data grant supplies organizer authority without requiring source Edit.
      if (verified.caller.kind === "named") verified.caller = { ...verified.caller, helper: true };
      operations = effectiveDatasetOperations({ kind: "dataset", datasetId: approved.datasetId, revision: approved.revision,
        revisionSha256: approved.revisionSha256, operationIds: grant.operationIds }, approved, verified.caller);
      token = String(row.token); discover = grant.discover;
    }
    return { authority: verified, revision: approved, operations, token: hash(JSON.stringify([verified, approved.revisionSha256, token, state.generation])), discover, createFields, linkReads };
  }
  function describePermission(permission: Permission): DatasetDescription {
    return describeApprovedDataset(permission.revision, permission.operations);
  }
  // The head a press of this button claims at, while this host writes the dataset and its rules have the button.
  function pressableHead(raw: DatasetScope & Pick<DatasetPressInput, "tableId" | "fieldId">): DatasetCursor {
    const key = scope(raw);
    const head = journal.head(key, () => undefined);
    if (!head.active) throw new DatasetHostError("conflict", "This Collection moved to a server, so its buttons can't run here.");
    live(key);
    const table = revision(key).definition.tables.find(candidate => candidate.tableId === raw.tableId);
    if (!table?.fields.some(field => field.fieldId === raw.fieldId && field.type === "button")) throw new DatasetHostError("invalid", "This button is not in the Collection's approved rules.");
    return head.cursor;
  }
  const host = {
    /** For the trusted executor. Commits and presses claim through the host; deleting a dataset forgets its claims. */
    automationClaims: { subscribe: automations.subscribe, unsubscribe: automations.unsubscribe, subscriptions: automations.subscriptions,
      next: automations.next, settle: automations.settle, release: automations.release, retry: automations.retry,
      claims: automations.claims, claim: automations.claim, failures: automations.failures, pressed: automations.pressed,
      /** Throws why this host cannot take a press of this button, as `press` would. */
      assertPressable(raw: DatasetScope & Pick<DatasetPressInput, "tableId" | "fieldId">): void { pressableHead(raw); },
      /**
       * A press of a Button field in the approved rules, on a dataset this
       * host still writes. The caller has checked who pressed and what they
       * may use.
       */
      press(raw: DatasetScope & DatasetPressInput): DatasetPressed {
        return automations.press({ ...raw, cursor: pressableHead(raw) });
      } },
    deletionStatus(context: Context, raw: DatasetScope) {
      const key = scope(raw); owner(context,key);
      return { deleted: Boolean(db.prepare("SELECT 1 FROM dohc_dataset_deletions WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId)) };
    },
    deletePreview(context: Context, raw: DatasetScope & { after?: string; limit?: number }) {
      const key = scope(raw);
      return journal.captureExport({ scope: key, authorize: () => { owner(context,key); }, capture(cursor) {
        if (db.prepare("SELECT active FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId)?.active !== 1)
          throw new DatasetHostError("conflict", "Delete this Collection at its current host.");
        return { ...host.lifecycle(context,raw), name: revision(key).definition.name, cursor,
          reviewToken: reviewToken(key,cursor), irreversible: true as const };
      } }).captured;
    },
    async deleteDataset(context: Context, raw: DatasetScope & { expected: DatasetCursor; reviewToken: string; acknowledge: true }) {
      const key = scope(raw), expected = structuredClone(raw.expected);
      if (raw.acknowledge !== true || expected.workspaceId !== key.workspaceId || expected.datasetId !== key.datasetId)
        throw new DatasetHostError("invalid", "Review the Collection before permanently deleting it.");
      journal.destroy({ expected, authorize: () => { owner(context,key); }, cleanup() {
          revision(key);
          if (raw.reviewToken !== reviewToken(key,expected)) throw new DatasetHostError("conflict", "Collection access changed. Review deletion again.");
          if (options.deleteResources) synchronous(() => options.deleteResources!(context,key));
          automations.forget(key);
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dohc_dataset_imports'").get()) {
            for (const table of ["dohc_dataset_import_records", "dohc_dataset_import_metadata", "dohc_dataset_import_checkpoints", "dohc_dataset_recovered_permissions"])
              db.prepare(`DELETE FROM ${table} WHERE import_id IN(SELECT import_id FROM dohc_dataset_imports WHERE workspace_id=? AND dataset_id=?)`).run(key.workspaceId,key.datasetId);
            db.prepare("DELETE FROM dohc_dataset_imports WHERE workspace_id=? AND dataset_id=?").run(key.workspaceId,key.datasetId);
          }
          for (const table of ["dohc_dataset_bindings", "dohc_dataset_data_grants", "dohc_dataset_lifecycle", "dohc_dataset_catalog", "dohc_dataset_catalog_history", "dohc_dataset_attempts", "dohc_dataset_cancelled_attempts", "dohc_dataset_review_generations"])
            db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND dataset_id=?`).run(key.workspaceId,key.datasetId);
      } });
      await options.supervisor.retire?.(key);
      for(const [id,saved] of migrationCandidates)if(saved.candidate.expected.workspaceId===key.workspaceId&&saved.candidate.expected.datasetId===key.datasetId)migrationCandidates.delete(id);
      return { deleted: true as const, datasetId: key.datasetId };
    },
    async prepareMigration(context:Context,raw:MigrateDatasetInput):Promise<DatasetMigrationCandidate> {
      if(!options.supervisor.prepareMigration)throw new DatasetHostError("invalid","This host cannot preview Collection changes.");
      const approved=verifyDatasetArtifacts(raw),key=scope({workspaceId:raw.workspaceId,datasetId:approved.datasetId}),previous=revision(key),expected={...raw.expected};
      live(key);const generation=lifecycle(key).generation,ownerToken=JSON.stringify(owner(context,key)),authorityKey=hash(JSON.stringify([ownerToken,generation]));
      if(expected.workspaceId!==key.workspaceId||expected.datasetId!==key.datasetId||expected.approvedRevisionHash!==previous.revisionSha256||approved.revision!==previous.revision+1)throw new DatasetHostError("conflict","The Collection's rules changed since this change was prepared. Prepare it again.");
      const authorize=()=>{raw.signal?.throwIfAborted();live(key);if(lifecycle(key).generation!==generation||JSON.stringify(owner(context,key))!==ownerToken)denied();assertDatasetAttemptsCommitted(db,key);};
      authorize();const schemaSql=raw.schemaSql,source=raw.operationSource,migrationSql=text(raw.migrationSql,256*1024),compiled=await compile(source,approved.definition.operationsPath);authorize();
      const candidate=await options.supervisor.prepareMigration({scope:key,expected,tables:previous.definition.tables.map(table=>table.sqlName),newTables:approved.definition.tables.map(table=>table.sqlName),
        schemaSql,source:compiled,definitionJson:JSON.stringify(approved),approvedRevisionHash:approved.revisionSha256,migrationSql,authorize,authorityKey,signal:raw.signal,
        ...(options.accountCheckpointStage?{accountStage:allocation=>synchronous(()=>options.accountCheckpointStage!(context,allocation))}:{})});
      authorize();
      for(const [id,saved] of migrationCandidates)if(saved.candidate.expiresAtMs<=Date.now()||(saved.candidate.expected.workspaceId===key.workspaceId&&saved.candidate.expected.datasetId===key.datasetId))migrationCandidates.delete(id);
      migrationCandidates.set(candidate.candidateId,{candidate:structuredClone(candidate),authorityKey,approved,previous,schemaSql,source});return candidate;
    },
    async approveMigration(context:Context,raw:DatasetScope & {candidateId:string;checkpointSha256:string;signal?:AbortSignal}):Promise<{revision:DatasetRevision;cursor:DatasetCursor}> {
      if(!options.supervisor.approveMigration)throw new DatasetHostError("invalid","This host cannot preview Collection changes.");
      const key=scope(raw),saved=migrationCandidates.get(text(raw.candidateId));
      if(!saved||saved.candidate.expected.workspaceId!==key.workspaceId||saved.candidate.expected.datasetId!==key.datasetId)throw new DatasetHostError("conflict","This preview is no longer available. Preview the change again.");
      const authorityKey=hash(JSON.stringify([JSON.stringify(owner(context,key)),lifecycle(key).generation]));
      const authorize=()=>{raw.signal?.throwIfAborted();live(key);if(hash(JSON.stringify([JSON.stringify(owner(context,key)),lifecycle(key).generation]))!==saved.authorityKey)denied();assertDatasetAttemptsCommitted(db,key);};
      authorize();
      const cursor=await options.supervisor.approveMigration({scope:key,tables:saved.previous.definition.tables.map(table=>table.sqlName),candidateId:raw.candidateId,checkpointSha256:raw.checkpointSha256,authorityKey,authorize,signal:raw.signal,
        accountStage(allocation){if(options.accountCheckpointStage)synchronous(()=>options.accountCheckpointStage!(context,allocation));},
        account(allocation){
          const row=db.prepare("SELECT revision_json,artifacts_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
          if(!row||parseDatasetRevision(JSON.parse(String(row.revision_json))).revisionSha256!==saved.previous.revisionSha256)throw new DatasetHostError("conflict","The Collection's rules changed while dohc applied this change. Prepare it again.");
          const revisionJson=JSON.stringify(saved.approved),artifactsJson=JSON.stringify({schemaSql:saved.schemaSql,operationSource:saved.source}),delta=Buffer.byteLength(revisionJson)+Buffer.byteLength(artifactsJson)+256;
          if(options.accountMigration)synchronous(()=>options.accountMigration!(context,{...key,bytes:allocation.bytes-allocation.stagedCreditBytes+delta,capacityBytes:allocation.capacityBytes,capacityDeltaBytes:allocation.capacityDeltaBytes}));
          db.prepare("INSERT INTO dohc_dataset_catalog_history VALUES(?,?,?,?,?)").run(key.workspaceId,key.datasetId,saved.previous.revision,row.revision_json,row.artifacts_json);
          db.prepare("UPDATE dohc_dataset_catalog SET revision_json=?,artifacts_json=? WHERE workspace_id=? AND dataset_id=?").run(revisionJson,artifactsJson,key.workspaceId,key.datasetId);
          generatedVerdicts.delete(saved.previous.revisionSha256);
        }});
      authorize();migrationCandidates.delete(raw.candidateId);return {revision:saved.approved,cursor};
    },
    migrationPreviewPage(context:Context,raw:DatasetScope & {candidateId:string;after?:string;limit?:number;signal?:AbortSignal}) {
      if(!options.supervisor.migrationPreviewPage)throw new DatasetHostError("invalid","This host cannot preview Collection changes.");
      const key=scope(raw),saved=migrationCandidates.get(text(raw.candidateId));if(!saved)throw new DatasetHostError("conflict","This preview is no longer available. Preview the change again.");
      const authorityKey=hash(JSON.stringify([JSON.stringify(owner(context,key)),lifecycle(key).generation]));
      const authorize=()=>{raw.signal?.throwIfAborted();live(key);if(hash(JSON.stringify([JSON.stringify(owner(context,key)),lifecycle(key).generation]))!==saved.authorityKey)denied();};
      return options.supervisor.migrationPreviewPage({scope:key,tables:saved.previous.definition.tables.map(table=>table.sqlName),candidateId:raw.candidateId,authorityKey,authorize,signal:raw.signal,after:raw.after,limit:raw.limit});
    },
    async discardMigration(context:Context,raw:DatasetScope & {candidateId:string;signal?:AbortSignal}):Promise<void> {
      if(!options.supervisor.discardMigration)throw new DatasetHostError("invalid","This host cannot preview Collection changes.");
      const key=scope(raw),saved=migrationCandidates.get(text(raw.candidateId));owner(context,key);if(!saved)return;
      const authorityKey=hash(JSON.stringify([JSON.stringify(owner(context,key)),lifecycle(key).generation]));
      await options.supervisor.discardMigration({scope:key,tables:saved.previous.definition.tables.map(table=>table.sqlName),candidateId:raw.candidateId,authorityKey,signal:raw.signal,authorize(){raw.signal?.throwIfAborted();owner(context,key);}});
      migrationCandidates.delete(raw.candidateId);
    },
    archiveDataset(context: Context, raw: DatasetScope & { reason?: string }) {
      const key = scope(raw), reason = raw.reason === undefined ? "archived by owner" : text(raw.reason, 1024);
      return transaction(() => {
        owner(context, key); const head = db.prepare("SELECT active FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
        if (!head || head.active !== 1) throw new DatasetHostError("conflict", "This host stopped accepting changes to this Collection, so dohc cannot archive it here.");
        const current = lifecycle(key); if (current.archived) return { archived: true, generation: current.generation, reason: current.reason };
        const generation = current.generation + 1;
        if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: Buffer.byteLength(reason) - Buffer.byteLength(current.reason) + (current.generation === 0 ? 256 : 0) }));
        db.prepare("INSERT INTO dohc_dataset_lifecycle VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id) DO UPDATE SET archived=1,generation=excluded.generation,reason=excluded.reason,archived_at_ms=excluded.archived_at_ms")
          .run(key.workspaceId,key.datasetId,1,generation,reason,Date.now());
        generatedVerdicts.clear();
        return { archived: true, generation, reason };
      });
    },
    restoreDataset(context: Context, raw: DatasetScope) {
      const key = scope(raw);
      return transaction(() => {
        revision(key);
        owner(context, key); const state = lifecycle(key), head = db.prepare("SELECT active FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
        if (!state.archived) return { archived: false, generation: state.generation };
        if (!head || head.active !== 1) throw new DatasetHostError("conflict", "This host stopped accepting changes to this Collection, so dohc cannot restore it here.");
        const generation = state.generation + 1;
        if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: -Buffer.byteLength(state.reason) }));
        db.prepare("UPDATE dohc_dataset_lifecycle SET archived=0,generation=?,reason='',archived_at_ms=NULL WHERE workspace_id=? AND dataset_id=? AND archived=1 AND generation=?")
          .run(generation,key.workspaceId,key.datasetId,state.generation);
        if (Number(db.prepare("SELECT changes() AS n").get()!.n) !== 1) throw new DatasetHostError("conflict", "The Collection changed while dohc restored it. Try again.");
        return { archived: false, generation };
      });
    },
    lifecycle(context: Context, raw: DatasetScope & { after?: string; limit?: number }) {
      const key = scope(raw); owner(context, key); const state = lifecycle(key);
      revision(key); const limit = raw.limit ?? 50, after = raw.after ?? "";
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DatasetHostError("invalid", "Choose a page size from 1 to 100.");
      const rows = db.prepare("SELECT app_id,length(CAST(binding_json AS BLOB)) AS bytes FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id>? ORDER BY app_id LIMIT ?").all(key.workspaceId,key.datasetId,after,limit+1);
      const apps: Array<{ appId: string; binding: AppDatasetBinding }> = []; let bytes = 0;
      for (const row of rows.slice(0,limit)) {
        const size = Number(row.bytes) + Buffer.byteLength(String(row.app_id));
        if (size > 1024 * 1024) throw new DatasetHostError("invalid", "This app's Collection access is too large. Choose fewer actions or fields.");
        if (bytes + size > 1024 * 1024) break;
        const binding = db.prepare("SELECT binding_json FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?").get(key.workspaceId,key.datasetId,row.app_id)!;
        apps.push({ appId: String(row.app_id), binding: JSON.parse(String(binding.binding_json)) }); bytes += size;
      }
      return { ...state, apps, nextCursor: rows.length > apps.length ? apps.at(-1)!.appId : null };
    },
    recoveryStatus(context: Context, raw: DatasetScope & { transferId: string }) {
      const key = scope(raw), recovery = options.recovery;
      if (!recovery?.install) throw new DatasetHostError("invalid", "This host cannot restore Collections.");
      const installer = createRecoveryInstaller({ ...recovery.install, db, transaction, journal });
      return installer.status({ ...key, transferId: raw.transferId, authorize: () => { owner(context, key); } });
    },
    async discardRecovery(context: Context, raw: DatasetScope & { transferId: string }) {
      const key = scope(raw), recovery = options.recovery;
      if (!recovery?.install) throw new DatasetHostError("invalid", "This host cannot restore Collections.");
      const installer = createRecoveryInstaller({ ...recovery.install, db, transaction, journal });
      await installer.discard(context, { ...key, transferId: raw.transferId, authorize: () => { owner(context, key); } });
    },
    claimRecovery(context: Context, raw: DatasetScope & { transferId: string; sourceCursor: DatasetCursor; manifestSha256: string; oldHostStopped: true; signal?: AbortSignal }) {
      const key = scope(raw), recovery = options.recovery;
      if (!recovery?.install?.allowOwnerRecoveryClaim || raw.oldHostStopped !== true) throw new DatasetHostError("invalid", "Confirm that you stopped the old host before restoring this Collection.");
      const ownerToken = JSON.stringify(owner(context, key));
      const authorize = () => { raw.signal?.throwIfAborted(); if (JSON.stringify(owner(context, key)) !== ownerToken) denied(); };
      return createRecoveryInstaller({ ...recovery.install, db, transaction, journal }).claim(context, { ...raw, ...key, authorize });
    },
    async prepareRecovery(context: Context, raw: { workspaceId: string; transferId: string; manifestSha256: string; stream: AsyncIterable<Uint8Array>; signal?: AbortSignal }) {
      const recovery = options.recovery;
      if (!recovery?.install?.allowOwnerRecoveryClaim) throw new DatasetHostError("invalid", "This host cannot restore Collections from a recovery file.");
      const ownerToken = JSON.stringify(owner(context, { workspaceId: raw.workspaceId }));
      const authorize = () => { raw.signal?.throwIfAborted(); if (JSON.stringify(owner(context, { workspaceId: raw.workspaceId })) !== ownerToken) denied(); };
      const staged = await stageDatasetRecovery({ ...raw, stagingParent: recovery.directory, expectedManifestSha256: raw.manifestSha256, limits: recovery.limits, authorize });
      const validated = await validateDatasetRecovery({ staged, authorize, signal: raw.signal, runtime: options.persistentRuntime, compileOperations: options.compileOperations });
      try {
        const key = scope(validated.manifest.cursor);
        if (key.workspaceId !== raw.workspaceId) throw new DatasetHostError("invalid", "This recovery file belongs to another workspace.");
        const installer = createRecoveryInstaller({ ...recovery.install!, db, transaction, journal });
        // Installation and authority claim are separate durable steps. Opening
        // the identical archive recovers the saved identity after a restart;
        // the owner still must confirm the old host stopped before claiming.
        const installed = db.prepare("SELECT import_id FROM dohc_dataset_imports WHERE workspace_id=? AND dataset_id=? AND manifest_hash=? AND phase='installed'")
          .get(key.workspaceId, key.datasetId, raw.manifestSha256);
        const saved = installed ? installer.status({ ...key, transferId: String(installed.import_id), authorize }) : null;
        if (saved && equalRecoveryCursor(saved.sourceCursor, validated.manifest.cursor)) {
          return { ...saved, revision: parseDatasetRevision(JSON.parse(validated.catalog.revisionJson)),
            dispose: () => validated.dispose(),
            async install() {
              const current = installer.status({ ...key, transferId: saved.transferId, authorize });
              if (!current || current.manifestSha256 !== saved.manifestSha256 || !equalRecoveryCursor(current.sourceCursor, saved.sourceCursor)) {
                throw new DatasetHostError("conflict", "This recovery file differs from the one you started restoring. Choose the same file, or cancel the recovery.");
              }
              return current;
            } };
        }
        const assertAbsent = () => { journal.assertNotDeleted(key,authorize); if (db.prepare("SELECT 1 FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId) || db.prepare("SELECT 1 FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId)) throw new DatasetHostError("conflict", "This Collection already exists. Recovery does not replace existing data."); };
        assertAbsent();
        return { transferId: raw.transferId, manifestSha256: raw.manifestSha256, sourceCursor: structuredClone(validated.manifest.cursor),
          revision: parseDatasetRevision(JSON.parse(validated.catalog.revisionJson)), dispose: () => validated.dispose(),
          async install() {
            assertAbsent();
            const installer = createRecoveryInstaller({ ...recovery.install!, db, transaction, journal });
            return installer.install(context, { transferId: raw.transferId, manifestSha256: raw.manifestSha256, recovery: validated, authorize });
          } };
      } catch (error) { await validated.dispose(); throw error; }
    },
    async importRecovery(context: Context, raw: DatasetScope & { transferId: string; sourceCursor: DatasetCursor; manifestSha256: string; stream: AsyncIterable<Uint8Array>; activate?: boolean; signal?: AbortSignal }) {
      const key = scope(raw), recovery = options.recovery;
      if (!recovery?.install) throw new DatasetHostError("invalid", "This host cannot restore Collections.");
      const sourceCursor = structuredClone(raw.sourceCursor), manifestSha256 = raw.manifestSha256, transferId = text(raw.transferId), activate = raw.activate === true;
      if (sourceCursor.workspaceId !== key.workspaceId || sourceCursor.datasetId !== key.datasetId) throw new DatasetHostError("invalid", "This recovery file holds a different Collection.");
      const ownerToken = JSON.stringify(owner(context, key)), authorize = () => { raw.signal?.throwIfAborted(); if (JSON.stringify(owner(context, key)) !== ownerToken) denied(); };
      const installer = createRecoveryInstaller({ ...recovery.install, db, transaction, journal });
      const prior = installer.status({ ...key, transferId, authorize });
      if (prior) {
        if (prior.manifestSha256 !== manifestSha256 || !equalRecoveryCursor(prior.sourceCursor, sourceCursor)) throw new DatasetHostError("conflict", "This recovery file differs from the one you started restoring. Choose the same file, or cancel the recovery.");
        return activate ? installer.claim(context, { ...key, transferId, sourceCursor, manifestSha256, authorize }) : prior;
      }
      const staged = await stageDatasetRecovery({ stream: raw.stream, stagingParent: recovery.directory, expectedManifestSha256: manifestSha256, limits: recovery.limits, signal: raw.signal, authorize });
      const validated = await validateDatasetRecovery({ staged, authorize, signal: raw.signal, runtime: options.persistentRuntime, compileOperations: options.compileOperations });
      try {
        if (!equalRecoveryCursor(validated.manifest.cursor, sourceCursor)) throw new DatasetHostError("conflict", "This recovery file is from a different point in the Collection's history.");
        if (activate && validated.manifest.sourceState !== "fenced") throw new DatasetHostError("invalid", "This recovery file was saved while the Collection still accepted changes, so it cannot move the Collection. Publish the Collection's app to your sharing server to move it.");
        const result = await installer.install(context, { transferId, manifestSha256, recovery: validated, authorize });
        return activate ? installer.claim(context, { ...key, transferId, sourceCursor, manifestSha256, authorize }) : result;
      } finally { await validated.dispose(); }
    },
    ...createDatasetReplicaHost({ journal, owner(context: Context, key: DatasetScope) { const authority=owner(context,key);live(key);return authority; } }),
    async exportRecovery(context: Context, raw: DatasetScope & { signal?: AbortSignal }) {
      const key=scope(raw),recovery=options.recovery;
      if(!recovery)throw new DatasetHostError("invalid","This host cannot export Collections.");
      if(Boolean(recovery.captureAttachments)!==Boolean(recovery.openAttachment))throw new Error("Dataset recovery attachments require capture and read callbacks.");
      const ownerToken=JSON.stringify(owner(context,key)),authorize=()=>{if(JSON.stringify(owner(context,key))!==ownerToken)denied();};
      return prepareDatasetRecoveryExport({db,journal,scope:key,directory:recovery.directory,limits:recovery.limits,signal:raw.signal,authorize,
        attachments:recovery.captureAttachments&&recovery.openAttachment?{
          capture:cursor=>recovery.captureAttachments!(context,key,cursor),open:file=>recovery.openAttachment!(context,key,file),
        }:undefined});
    },
    /** Trusted host admission only; adapters must not publish this unfiltered metadata. */
    authorize(context: Context, raw: Pick<InvokeDatasetInput,"workspaceId"|"datasetId"|"revision"|"revisionSha256"|"operationId"|"access">) {
      const key=scope(raw),permitted=permissions(context,key,access(raw.access)),operation=permitted.operations.find(operation=>operation.operationId===text(raw.operationId));
      resolveCompatibleDatasetRevision(db,key,raw,permitted.revision);
      if(!operation)denied();
      return { authority: permitted.authority, revision: permitted.revision, operation };
    },
    async activate(context: Context, raw: ActivateDatasetInput): Promise<DatasetRevision> {
      const approved = verifyDatasetArtifacts(raw), key = scope({ workspaceId: raw.workspaceId, datasetId: approved.datasetId });
      if (approved.revision !== 1) throw new Error("A new Collection's rules must be revision 1. Change existing rules with a Collection change.");
      const schemaSql = raw.schemaSql, source = raw.operationSource, capacityBytes = raw.capacityBytes, signal = raw.signal;
      const captured = owner(context, key), ownerToken = JSON.stringify(captured);
      const authorize = () => { signal?.throwIfAborted(); if (JSON.stringify(owner(context, key)) !== ownerToken) denied(); };
      journal.assertNotDeleted(key,authorize);
      const existing = db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
      if (existing) {
        const current = parseDatasetRevision(JSON.parse(String(existing.revision_json)));
        if (current.revisionSha256 !== approved.revisionSha256) throw new DatasetHostError("conflict", "This Collection's rules are already approved. Review a Collection change to change them.");
        const currentHead = journal.head(key, authorize);
        if (!currentHead.active || currentHead.cursor.approvedRevisionHash !== current.revisionSha256) throw new Error("This host stopped accepting changes to this Collection. Its owner can publish its app again to finish moving it, or finish restoring it from its recovery file.");
        authorize(); return current;
      }
      const compiledSource = await compile(source, approved.definition.operationsPath);
      const checkpoint = await initializeAppDatabase({ schemaSql, tables: approved.definition.tables.map(table => table.sqlName), signal, journaled: true }, options.runtime);
      authorize();
      journal.initialize({ scope: key, hostEpoch: randomUUID(), approvedRevisionHash: approved.revisionSha256, source: compiledSource, schemaSql,
        definitionJson: JSON.stringify(approved), checkpoint, capacityBytes, authorize,
        account(allocation) {
          const revisionJson = JSON.stringify(approved), artifactsJson = JSON.stringify({ schemaSql, operationSource: source });
          if (options.accountCreation) synchronous(() => options.accountCreation!(context, { ...key, ...allocation,
            bytes: allocation.bytes + Buffer.byteLength(revisionJson) + Buffer.byteLength(artifactsJson) + 512 }));
          db.prepare("INSERT INTO dohc_dataset_catalog VALUES(?,?,?,?)").run(key.workspaceId, key.datasetId, revisionJson, artifactsJson);
        } });
      authorize();
      return approved;
    },
    async migrate(context: Context, raw: MigrateDatasetInput): Promise<{ revision: DatasetRevision; cursor: DatasetCursor }> {
      if (options.accountMigration && !options.accountCheckpointStage) throw new Error("Dataset migration requires checkpoint staging quota accounting.");
      const approved = verifyDatasetArtifacts(raw), key = scope({ workspaceId: raw.workspaceId, datasetId: approved.datasetId });
      const expected = { ...raw.expected }, migrationSql = text(raw.migrationSql, 256 * 1024), schemaSql = raw.schemaSql, source = raw.operationSource, signal = raw.signal;
      live(key); const generation = lifecycle(key).generation;
      const captured = owner(context, key), ownerToken = JSON.stringify(captured), previous = revision(key);
      if (expected.workspaceId !== key.workspaceId || expected.datasetId !== key.datasetId || expected.approvedRevisionHash !== previous.revisionSha256 || approved.revision !== previous.revision + 1) {
        throw new DatasetHostError("conflict", "The Collection's rules changed since this change was prepared. Prepare it again.");
      }
      const authorize = () => { signal?.throwIfAborted(); live(key); if (lifecycle(key).generation !== generation || JSON.stringify(owner(context, key)) !== ownerToken) denied(); assertDatasetAttemptsCommitted(db, key); };
      authorize();
      const compiledSource = await compile(source, approved.definition.operationsPath);
      authorize();
      const cursor = await options.supervisor.migrate({ scope: key, expected, tables: previous.definition.tables.map(table => table.sqlName),
        newTables: approved.definition.tables.map(table => table.sqlName), schemaSql, source: compiledSource, definitionJson: JSON.stringify(approved),
        approvedRevisionHash: approved.revisionSha256, migrationSql, signal, authorize,
        accountStage(allocation) { if (options.accountCheckpointStage) synchronous(() => options.accountCheckpointStage!(context, allocation)); },
        account(allocation) {
          const row = db.prepare("SELECT revision_json,artifacts_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
          if (!row || parseDatasetRevision(JSON.parse(String(row.revision_json))).revisionSha256 !== previous.revisionSha256) throw new Error("The Collection's rules changed while dohc applied this change. Prepare it again.");
          const revisionJson = JSON.stringify(approved), artifactsJson = JSON.stringify({ schemaSql, operationSource: source });
          const delta = Buffer.byteLength(revisionJson) + Buffer.byteLength(artifactsJson) + 256;
          if (options.accountMigration) synchronous(() => options.accountMigration!(context, { ...key, bytes: allocation.bytes - allocation.stagedCreditBytes + delta,
            capacityBytes: allocation.capacityBytes, capacityDeltaBytes: allocation.capacityDeltaBytes }));
          db.prepare("INSERT INTO dohc_dataset_catalog_history VALUES(?,?,?,?,?)").run(key.workspaceId,key.datasetId,previous.revision,row.revision_json,row.artifacts_json);
          db.prepare("UPDATE dohc_dataset_catalog SET revision_json=?,artifacts_json=? WHERE workspace_id=? AND dataset_id=?").run(revisionJson, artifactsJson, key.workspaceId, key.datasetId);
          generatedVerdicts.delete(previous.revisionSha256);
        } });
      return { revision: approved, cursor };
    },
    setBinding(context: Context, raw: DatasetScope & { appId: string; binding: AppDatasetBinding | null }, commitPublication?: () => void): void {
      const key = scope(raw), appId = text(raw.appId);
      transaction(() => {
        owner(context, key);
        if (raw.binding !== null) live(key);
        const approved = revision(key);
        const existing = db.prepare("SELECT binding_json FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?").get(key.workspaceId, key.datasetId, appId);
        const previousBytes = existing ? Buffer.byteLength(String(existing.binding_json)) + Buffer.byteLength(appId) + 256 : 0;
        if (raw.binding === null) {
          if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: -previousBytes }));
          db.prepare("DELETE FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?").run(key.workspaceId, key.datasetId, appId);
        }
        else {
          if (!existing && db.prepare("SELECT 1 FROM dohc_dataset_attempts WHERE workspace_id=? AND dataset_id=? AND app_id!=? LIMIT 1").get(key.workspaceId, key.datasetId, appId)) {
            throw new DatasetHostError("conflict", "A response is pending in another app. Confirm it there before publishing this app.");
          }
          const binding = parseDatasetBinding(raw.binding, approved, generatedRevision);
          const json = JSON.stringify(binding);
          if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: Buffer.byteLength(json) + Buffer.byteLength(appId) + 256 - previousBytes }));
          db.prepare("INSERT INTO dohc_dataset_bindings VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id,app_id) DO UPDATE SET binding_json=excluded.binding_json,token=excluded.token")
            .run(key.workspaceId, key.datasetId, appId, json, randomUUID());
        }
        if (commitPublication) synchronous(commitPublication);
        owner(context, key);
      });
    },
    setDataGrant(context: Context, raw: DatasetScope & { principalKey: string; grant: DatasetDataGrant | null }): void {
      const key = scope(raw), principalKey = text(raw.principalKey);
      transaction(() => {
        owner(context, key);
        if (raw.grant !== null) live(key);
        const approved = revision(key);
        const existing = db.prepare("SELECT grant_json FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").get(key.workspaceId, key.datasetId, principalKey);
        const previousBytes = existing ? Buffer.byteLength(String(existing.grant_json)) + Buffer.byteLength(principalKey) + 256 : 0;
        if (raw.grant === null) {
          if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: -previousBytes }));
          db.prepare("DELETE FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").run(key.workspaceId, key.datasetId, principalKey);
        }
        else {
          if (typeof raw.grant.discover !== "boolean" || Object.keys(raw.grant).some(key => !["operationIds", "discover", "revision", "revisionSha256"].includes(key))) throw new Error("Invalid Collection access.");
          if (raw.grant.revision !== approved.revision || raw.grant.revisionSha256 !== approved.revisionSha256) throw new DatasetHostError("conflict", "The Collection's rules changed after you chose this access. Choose it again.");
          const binding = parseDatasetBinding({ kind: "dataset", datasetId: approved.datasetId, revision: approved.revision,
            revisionSha256: approved.revisionSha256, operationIds: raw.grant.operationIds }, approved);
          if (approved.definition.operations.some(operation => binding.operationIds.includes(operation.operationId) && operation.access === "owner")) throw new Error("Owner-only Collection actions cannot be granted to anyone else.");
          const json = JSON.stringify({ operationIds: binding.operationIds, discover: raw.grant.discover, revision: approved.revision, revisionSha256: approved.revisionSha256 });
          if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: Buffer.byteLength(json) + Buffer.byteLength(principalKey) + 256 - previousBytes }));
          db.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id,principal_key) DO UPDATE SET grant_json=excluded.grant_json,token=excluded.token")
            .run(key.workspaceId, key.datasetId, principalKey, json, randomUUID());
        }
        owner(context, key);
      });
    },
    describe(context: Context, raw: DatasetScope & { includeArchived?: boolean }): DatasetDescription {
      const key = scope(raw);
      if (raw.includeArchived) owner(context, key);
      const permitted = permissions(context, key, { kind: "data" }, raw.includeArchived === true);
      if (!permitted.discover) denied();
      const archived = lifecycle(key).archived;
      return { ...describePermission(permitted), archived, ...(archived ? { operations: [] } : {}) };
    },
    list(context: Context, raw: { workspaceId: string; after?: string; limit?: number; includeArchived?: boolean }): { datasets: Array<DatasetDescription & { archived: boolean }>; nextCursor: string | null } {
      const workspaceId = text(raw.workspaceId), after = raw.after === undefined ? "" : text(raw.after), limit = raw.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Choose a page size from 1 to 100.");
      // Apply data grants in SQL so inaccessible datasets do not create page gaps or counts.
      const verified = authority(context, { workspaceId }, { kind: "data" });
      const includeArchived = raw.includeArchived === true;
      if (includeArchived && verified.caller.kind !== "owner") denied();
      const rows = verified.caller.kind === "owner"
        ? db.prepare("SELECT c.dataset_id FROM dohc_dataset_catalog c LEFT JOIN dohc_dataset_lifecycle l ON l.workspace_id=c.workspace_id AND l.dataset_id=c.dataset_id WHERE c.workspace_id=? AND c.dataset_id>? AND (?=1 OR COALESCE(l.archived,0)=0) ORDER BY c.dataset_id LIMIT ?").all(workspaceId, after, includeArchived ? 1 : 0, limit + 1)
        : db.prepare(`SELECT c.dataset_id FROM dohc_dataset_catalog c JOIN dohc_dataset_data_grants g
            ON c.workspace_id=g.workspace_id AND c.dataset_id=g.dataset_id WHERE c.workspace_id=? AND g.principal_key=? AND c.dataset_id>?
            AND json_extract(g.grant_json,'$.discover')=1
            AND json_extract(g.grant_json,'$.revisionSha256')=json_extract(c.revision_json,'$.revisionSha256')
            AND COALESCE((SELECT archived FROM dohc_dataset_lifecycle l WHERE l.workspace_id=c.workspace_id AND l.dataset_id=c.dataset_id),0)=0
            ORDER BY c.dataset_id LIMIT ?`).all(workspaceId, verified.principalKey, after, limit + 1);
      const selected = rows.slice(0, limit), datasets: Array<DatasetDescription & { archived: boolean }> = [];
      let bytes = 0;
      for (const row of selected) {
        const key = { workspaceId, datasetId: String(row.dataset_id) };
        const permitted = permissions(context, key, { kind: "data" }, includeArchived);
        if (!permitted.discover) denied();
        const description = { ...describePermission(permitted), archived: lifecycle(key).archived }, size = Buffer.byteLength(JSON.stringify(description));
        if (bytes + size > 1024 * 1024) break;
        datasets.push(description); bytes += size;
      }
      return { datasets, nextCursor: rows.length > datasets.length ? datasets.at(-1)!.datasetId : null };
    },
    /** Every unarchived dataset's id, owner only, without reading any dataset's rules. */
    datasetIds(context: Context, raw: { workspaceId: string }): string[] {
      const workspaceId = text(raw.workspaceId); owner(context, { workspaceId });
      return db.prepare("SELECT c.dataset_id FROM dohc_dataset_catalog c LEFT JOIN dohc_dataset_lifecycle l ON l.workspace_id=c.workspace_id AND l.dataset_id=c.dataset_id WHERE c.workspace_id=? AND COALESCE(l.archived,0)=0 ORDER BY c.dataset_id")
        .all(workspaceId).map(row => String(row.dataset_id));
    },
    /** The approved revision alone, without its source artifacts. */
    approvedRevision(context: Context, raw: DatasetScope): DatasetRevision {
      const key = scope(raw); owner(context, key); return revision(key);
    },
    approvedArtifacts(context: Context, raw: DatasetScope) {
      const key = scope(raw);
      const current = journal.head(key, () => { owner(context, key); });
      return { revision: revision(key), ...artifacts(key), active: current.active && !lifecycle(key).archived, cursor: current.cursor };
    },
    history(context: Context, raw: DatasetScope & { beforeRevision?: number; limit?: number }) {
      const key = scope(raw), limit = raw.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || raw.beforeRevision !== undefined && (!Number.isSafeInteger(raw.beforeRevision) || raw.beforeRevision < 1)) throw new DatasetHostError("invalid", "Invalid Collection history page.");
      return transaction(() => {
        owner(context, key); const approved = revision(key);
        const head = db.prepare("SELECT revision FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
        if (!head) throw new DatasetHostError("conflict", "Collection history is unavailable.");
        const before = raw.beforeRevision ?? Number.MAX_SAFE_INTEGER;
        const page = readDatasetHistory(db, key, approved, before, limit);
        owner(context, key);
        return { datasetId: key.datasetId, headRevision: Number(head.revision), ...page };
      });
    },
    historyRevision(context: Context, raw: DatasetScope & { revisionSha256: string }) {
      const key = scope(raw);
      return transaction(() => {
        owner(context, key); revision(key);
        const result = readDatasetHistoryRevision(db, key, raw.revisionSha256);
        owner(context, key); return result;
      });
    },
    pendingAttempts(context: Context, raw: DatasetScope & {after?: number; limit?: number}) {
      const key = scope(raw);
      return transaction(() => {
        owner(context, key); revision(key);
        const result = reviewDatasetAttempts(db, key, raw.after, raw.limit);
        owner(context, key); return result;
      });
    },
    reconcileAttempt(context: Context, raw: DatasetScope & {reference: string; acknowledge: true}) {
      const key = scope(raw);
      if (raw.acknowledge !== true) throw new DatasetHostError("invalid", "Review this response before clearing its retry.");
      return transaction(() => {
        owner(context, key); revision(key);
        const bytes = reconcileDatasetAttempt(db, key, raw.reference);
        if (bytes && options.accountMetadata) synchronous(() => options.accountMetadata!(context, {...key, bytes: -bytes}));
        owner(context, key); return {cleared: true as const};
      });
    },
    cancelAttempt(context: Context, raw: DatasetScope & {reference: string; acknowledge: true}) {
      const key = scope(raw);
      if (raw.acknowledge !== true) throw new DatasetHostError("invalid", "Review this response before cancelling it.");
      return transaction(() => {
        owner(context, key); revision(key);
        const bytes = cancelDatasetAttempt(db, key, raw.reference);
        if (bytes && options.accountMetadata) synchronous(() => options.accountMetadata!(context, {...key, bytes}));
        owner(context, key); return {cancelled: true as const};
      });
    },
    permissions(context: Context, raw: DatasetScope & { after?: string; limit?: number }) {
      const key = scope(raw), after = raw.after === undefined ? "" : text(raw.after, 1024), limit = raw.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Choose a page size from 1 to 100.");
      owner(context, key); const approved = revision(key);
      const rows = db.prepare(`SELECT 'app:'||app_id AS cursor,app_id AS principal,binding_json AS metadata,'app' AS kind
          FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND 'app:'||app_id>?
          UNION ALL SELECT 'data:'||principal_key AS cursor,principal_key AS principal,grant_json AS metadata,'data' AS kind
          FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND 'data:'||principal_key>?
          ORDER BY cursor LIMIT ?`).all(key.workspaceId, key.datasetId, after, key.workspaceId, key.datasetId, after, limit + 1);
      const selected = rows.slice(0, limit);
      return { permissions: selected.map(row => {
        const metadata = JSON.parse(String(row.metadata));
        return { kind: String(row.kind) as "app" | "data", principal: String(row.principal),
          current: (() => { try { resolveCompatibleDatasetRevision(db,key,metadata,approved); return true; } catch (error) { if (error instanceof DatasetHostError && error.code === "conflict") return false; throw error; } })(), metadata };
      }), nextCursor: rows.length > limit ? String(selected.at(-1)!.cursor) : null };
    },
    async invoke(context: Context, raw: InvokeDatasetInput): Promise<DatasetInvocationResult> {
      const key = scope(raw), through = access(raw.access), operationId = text(raw.operationId), idempotencyKey = text(raw.idempotencyKey, 128);
      const input = parseAppBackendJson(raw.input, 64 * 1024), permitted = permissions(context, key, through);
      resolveCompatibleDatasetRevision(db,key,raw,permitted.revision);
      const operation = permitted.operations.find(operation => operation.operationId === operationId);
      if (!operation) denied();
      const restricted = permitted.createFields?.find(entry => entry.operationId === operationId);
      if (restricted) {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input,"values") ||
          !input.values || typeof input.values !== "object" || Array.isArray(input.values) || Object.keys(input.values).some(fieldId => !restricted.fieldIds.includes(fieldId))) {
          throw new DatasetHostError("not_authorized", "This form cannot submit those fields.");
        }
      }
      const authorize = () => {
        const current = permissions(context, key, through);
        if (current.token !== permitted.token || !current.operations.some(candidate => candidate.operationId === operationId)) denied();
        try { assertDatasetAttemptNotCancelled(db, key, hash(JSON.stringify([permitted.authority.principalKey, through])), idempotencyKey); }
        catch (error) { throw new DatasetHostError("conflict", error instanceof Error ? error.message : "This submission was cancelled."); }
      };
      authorize();
      const resources = options.operationResources ? synchronous(() => options.operationResources!(context, { ...key, authority: permitted.authority, operation, input })) : {};
      const committedBy = actor(permitted.authority);
      const approvedLinkRead = (permitted.authority.caller.kind === "link" || permitted.authority.caller.kind === "named") && permitted.linkReads?.some(read => read.operationId === operationId);
      const table = permitted.revision.definition.tables.find(table => table.tableId === operation.tableId)!;
      if (approvedLinkRead) {
        if (!hasGeneratedDatasetRevision(permitted.revision, generatedRevision)) denied();
        if (hash(artifacts(key).operationSource) !== permitted.revision.operationsSha256) denied();
        journal.head(key, authorize);
      }
      const response = await options.supervisor.invoke({ scope: key, tables: approvedLinkRead ? [table.sqlName] : permitted.revision.definition.tables.map(table => table.sqlName),
        restrictTables: approvedLinkRead || undefined,
        operation: operation.name, caller: approvedLinkRead ? { ...permitted.authority.caller, approvedRead: operationId } : permitted.authority.caller, callerKey: hash(JSON.stringify([permitted.authority.principalKey, through])),
        input, idempotencyKey, payloadSha256: hash(JSON.stringify([raw.revisionSha256, operationId, input])), readOnly: operation.readOnly,
        files: resources.files, accountAndAttach: resources.accountAndAttach, signal: raw.signal, authorize,
        recordCommit: commit => automations.recordCommit({ ...commit, approved: permitted.revision, actor: committedBy }),
        ...(operation.reversedBy === undefined ? {} : { refuseResult: (result: JsonValue) => missingUndo(operation, result) }) });
      if (approvedLinkRead) {
        const result = validateDatasetReadResult(response.result, input, permitted.revision.definition, operation);
        authorize();
        return { ...response, result };
      }
      return response;
    },
    /** Resolve a protected resource only while the operation's data revision and grants still hold. */
    async readOperation<T>(context: Context, raw: InvokeDatasetInput, read: (result: JsonValue, revision: number) => T): Promise<T> {
      if(read.constructor.name==="AsyncFunction")throw new DatasetHostError("invalid","Protected file reads must be synchronous.");
      const key=scope(raw),through=access(raw.access),permitted=permissions(context,key,through);
      const operation=permitted.operations.find(operation=>operation.operationId===raw.operationId);
      if(!operation?.readOnly)throw new DatasetHostError("invalid","Choose a Collection action that only reads to open this file.");
      const result=await host.invoke(context,raw);
      return transaction(()=>{
        const check=()=>{
          raw.signal?.throwIfAborted();
          const current=permissions(context,key,through);
          if(current.token!==permitted.token)denied();
          const head=db.prepare("SELECT revision,approved_revision_hash,active FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
          if(!head||head.active!==1||head.revision!==result.revision||head.approved_revision_hash!==permitted.revision.revisionSha256)throw new DatasetHostError("conflict","The Collection changed before dohc opened this file. Try again.");
        };
        check();const value=synchronous(()=>read(result.result,result.revision));check();return value;
      });
    },
  };
  return host;
}
