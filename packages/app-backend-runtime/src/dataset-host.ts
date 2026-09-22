import { createHash, randomUUID } from "node:crypto";
import { parseAppBackendCaller, parseAppBackendJson, type AppBackendCaller } from "@dohc/security-contract/app-backend";
import { effectiveDatasetOperations, parseDatasetBinding, parseDatasetRevision, type AppDatasetBinding, type DatasetDescription, type DatasetOperation, type DatasetRevision } from "@dohc/security-contract/dataset";
export type { DatasetDescription } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import { initializeAppDatabase, type AppBackendRuntimeOptions } from "./index.js";
import type { DatasetCursor, DatasetJournal, DatasetScope, JournalDb } from "./journal.js";
import type { DatasetInvocation, DatasetInvocationResult, DatasetMigration } from "./supervisor.js";
import type { JsonValue } from "./protocol.js";
import { prepareDatasetRecoveryExport, type RecoveryAttachment } from "./recovery-export.js";
import { stageDatasetRecovery, type RecoveryLimits } from "./recovery.js";
import { validateDatasetRecovery } from "./recovery-import.js";
import { createRecoveryInstaller, type RecoveryInstallOptions } from "./recovery-install.js";
import { equalRecoveryCursor } from "./recovery-record.js";
import type { CheckpointStageAllocation } from "./checkpoint-storage.js";

export type DatasetAccess = { kind: "data" } | { kind: "app"; appId: string };
export class DatasetHostError extends Error {
  constructor(readonly code: "not_authorized" | "conflict" | "invalid", message: string) {
    super(message); this.name = "DatasetHostError";
  }
}
export interface DatasetAuthority {
  caller: AppBackendCaller;
  /** Stable identity derived from the credential, never from request JSON. */
  principalKey: string;
  /** Required for app access, after checking the current publication credential. */
  appId?: string;
  /** Host permission/publication generation; changes invalidate in-flight work. */
  authorityToken?: string;
}
export interface DatasetDataGrant { operationIds: string[]; discover: boolean; revision: number; revisionSha256: string }
export interface DatasetHostOptions<Context> {
  db: JournalDb;
  transaction: <T>(run: () => T) => T;
  journal: DatasetJournal;
  supervisor: { invoke(input: DatasetInvocation): Promise<DatasetInvocationResult>; migrate(input: DatasetMigration): Promise<DatasetCursor> };
  /** Synchronous. Validate current workspace membership or current app credential here. */
  /** datasetId is absent only for workspace catalog discovery. */
  resolveAuthority(context: Context, request: { workspaceId: string; datasetId?: string; access: DatasetAccess }): DatasetAuthority;
  runtime?: AppBackendRuntimeOptions;
  /** Compile the captured operations artifact to the runtime's supported JavaScript. */
  compileOperations?(source: string, path: string): string | Promise<string>;
  /** Runs in the journal transaction and includes retained catalog artifact bytes. */
  accountCreation?(context: Context, allocation: DatasetScope & { bytes: number; capacityBytes: number }): void;
  /** Signed retained-byte delta; runs in the binding or grant transaction. */
  accountMetadata?(context: Context, allocation: DatasetScope & { bytes: number }): void;
  /** Checkpoint retention and signed catalog replacement delta, in the transition transaction. */
  accountMigration?(context: Context, allocation: DatasetScope & { bytes: number; capacityBytes: number; capacityDeltaBytes: number }): void;
  /** Signed staging reservation; use the same retained-byte counter as accountMigration. */
  accountCheckpointStage?(context: Context, allocation: Readonly<CheckpointStageAllocation>): void;
  /** Resolve uploaded files and quota accounting from trusted host state. */
  operationResources?(context: Context, request: DatasetScope & { authority: DatasetAuthority; operation: DatasetOperation; input: JsonValue }): Pick<DatasetInvocation, "files" | "accountAndAttach">;
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
type Permission = { authority: DatasetAuthority; revision: DatasetRevision; operations: DatasetOperation[]; token: string; discover: boolean; createFields?: AppDatasetBinding["createFields"] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function text(value: string, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.includes("\0") || Buffer.byteLength(value) > maximum) throw new DatasetHostError("invalid", "Invalid dataset identifier.");
  return value;
}
function synchronous<T>(run: () => T): T {
  if (run.constructor.name === "AsyncFunction") throw new Error("Dataset host callbacks must be synchronous.");
  const result = run();
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Dataset host callbacks must be synchronous.");
  return result;
}
function denied(): never { throw new DatasetHostError("not_authorized", "Dataset access is not permitted."); }
function scope(input: DatasetScope): DatasetScope { return { workspaceId: text(input.workspaceId), datasetId: text(input.datasetId) }; }
function access(input: DatasetAccess = { kind: "data" }): DatasetAccess {
  if (input.kind === "data" && Object.keys(input).length === 1) return { kind: "data" };
  if (input.kind === "app" && Object.keys(input).length === 2) return { kind: "app", appId: text(input.appId) };
  throw new DatasetHostError("invalid", "Invalid dataset access path.");
}

/** Captures approved source once. Every consumer uses that source and current host authority. */
export function createDatasetHost<Context>(options: DatasetHostOptions<Context>) {
  for (const callback of [options.transaction, options.resolveAuthority, options.accountCreation, options.accountMetadata, options.accountMigration, options.accountCheckpointStage, options.operationResources]) {
    if (callback?.constructor.name === "AsyncFunction") throw new Error("Dataset host callbacks must be synchronous.");
  }
  const { db, journal } = options;
  const transaction = <T>(run: () => T): T => synchronous(() => options.transaction(() => synchronous(run)));
  transaction(() => db.exec(`
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
  `));
  function authority(context: Context, key: { workspaceId: string; datasetId?: string }, through: DatasetAccess): DatasetAuthority {
    const result = synchronous(() => options.resolveAuthority(context, { ...key, access: through }));
    const verified = { caller: parseAppBackendCaller(result.caller), principalKey: text(result.principalKey),
      appId: result.appId === undefined ? undefined : text(result.appId),
      authorityToken: result.authorityToken === undefined ? undefined : text(result.authorityToken, 1024) };
    if (through.kind === "app" && verified.appId !== through.appId) denied();
    return verified;
  }
  function owner(context: Context, key: DatasetScope): DatasetAuthority {
    const result = authority(context, key, { kind: "data" });
    if (result.caller.kind !== "owner") denied();
    return result;
  }
  function revision(key: DatasetScope): DatasetRevision {
    const row = db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
    if (!row) denied();
    return parseDatasetRevision(JSON.parse(String(row.revision_json)));
  }
  function artifacts(key: DatasetScope): { schemaSql: string; operationSource: string } {
    const row = db.prepare("SELECT artifacts_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
    if (!row) denied();
    const value = JSON.parse(String(row.artifacts_json));
    if (!value || typeof value.schemaSql !== "string" || typeof value.operationSource !== "string") throw new Error("Dataset artifacts are corrupt.");
    return value;
  }
  async function compile(source: string, path: string): Promise<string> {
    if (path.endsWith(".ts") && !options.compileOperations) throw new Error("TypeScript dataset operations require the configured host compiler.");
    const result = options.compileOperations ? await options.compileOperations(source, path) : source;
    if (typeof result !== "string" || !result.length || Buffer.byteLength(result) > 256 * 1024 || result.includes("\0")) throw new Error("Compiled dataset operations exceed the host limit.");
    return result;
  }
  function currentGrant(value: unknown, approved: DatasetRevision): StoredGrant {
    const grant = value as StoredGrant;
    if (grant.revision !== approved.revision || grant.revisionSha256 !== approved.revisionSha256) throw new DatasetHostError("conflict", "Dataset data grant needs approval for the current revision.");
    return grant;
  }
  function permissions(context: Context, key: DatasetScope, through: DatasetAccess): Permission {
    const verified = authority(context, key, through), approved = revision(key);
    let operations = approved.definition.operations, token = "owner", discover = true, createFields: AppDatasetBinding["createFields"];
    if (through.kind === "app") {
      const row = db.prepare("SELECT binding_json,token FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?").get(key.workspaceId, key.datasetId, through.appId);
      if (!row) denied();
      const binding = JSON.parse(String(row.binding_json)) as AppDatasetBinding;
      if (binding.revision !== approved.revision || binding.revisionSha256 !== approved.revisionSha256) throw new DatasetHostError("conflict", "App binding needs approval for the current dataset revision.");
      let dataToken = "", allowedHelperIds = new Set<string>();
      if (verified.caller.kind === "named") {
        const grant = db.prepare("SELECT grant_json,token FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").get(key.workspaceId, key.datasetId, verified.principalKey);
        if (grant) {
          const parsed = JSON.parse(String(grant.grant_json)) as StoredGrant;
          if (parsed.revision === approved.revision && parsed.revisionSha256 === approved.revisionSha256) allowedHelperIds = new Set(parsed.operationIds);
          dataToken = String(grant.token);
        }
        verified.caller = { ...verified.caller, helper: allowedHelperIds.size > 0 };
      }
      operations = effectiveDatasetOperations(binding, approved, verified.caller)
        .filter(operation => verified.caller.kind === "owner" || operation.access !== "helper" || allowedHelperIds.has(operation.operationId));
      token = JSON.stringify([row.token, dataToken]); discover = false;
      createFields = binding.createFields;
    } else if (verified.caller.kind !== "owner") {
      const row = db.prepare("SELECT grant_json,token FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").get(key.workspaceId, key.datasetId, verified.principalKey);
      if (!row) denied();
      const grant = currentGrant(JSON.parse(String(row.grant_json)), approved);
      // A data grant supplies organizer authority without requiring source Edit.
      if (verified.caller.kind === "named") verified.caller = { ...verified.caller, helper: true };
      operations = effectiveDatasetOperations({ kind: "dataset", datasetId: approved.datasetId, revision: approved.revision,
        revisionSha256: approved.revisionSha256, operationIds: grant.operationIds }, approved, verified.caller);
      token = String(row.token); discover = grant.discover;
    }
    return { authority: verified, revision: approved, operations, token: hash(JSON.stringify([verified, approved.revisionSha256, token])), discover, createFields };
  }
  function describePermission(permission: Permission): DatasetDescription {
    const { revision: approved, operations } = permission;
    const fields = new Set(operations.flatMap(operation => operation.fieldIds));
    const tables = new Set(operations.map(operation => operation.tableId));
    return { datasetId: approved.datasetId, name: approved.definition.name, revision: approved.revision, revisionSha256: approved.revisionSha256,
      tables: approved.definition.tables.filter(table => tables.has(table.tableId)).map(table => ({ tableId: table.tableId, name: table.name,
        fields: table.fields.filter(field => fields.has(field.fieldId)).map(field => {
          const { sqlColumn: _sqlColumn, ...description } = field;
          if (description.relation && !fields.has(description.relation.fieldId)) delete description.relation;
          return description;
        }) })), operations };
  }
  const host = {
    recoveryStatus(context: Context, raw: DatasetScope & { transferId: string }) {
      const key = scope(raw), recovery = options.recovery;
      if (!recovery?.install) throw new DatasetHostError("invalid", "Dataset recovery installation is not configured.");
      const installer = createRecoveryInstaller({ ...recovery.install, db, transaction, journal });
      return installer.status({ ...key, transferId: raw.transferId, authorize: () => { owner(context, key); } });
    },
    async discardRecovery(context: Context, raw: DatasetScope & { transferId: string }) {
      const key = scope(raw), recovery = options.recovery;
      if (!recovery?.install) throw new DatasetHostError("invalid", "Dataset recovery installation is not configured.");
      const installer = createRecoveryInstaller({ ...recovery.install, db, transaction, journal });
      await installer.discard(context, { ...key, transferId: raw.transferId, authorize: () => { owner(context, key); } });
    },
    async importRecovery(context: Context, raw: DatasetScope & { transferId: string; sourceCursor: DatasetCursor; manifestSha256: string; stream: AsyncIterable<Uint8Array>; activate?: boolean; signal?: AbortSignal }) {
      const key = scope(raw), recovery = options.recovery;
      if (!recovery?.install) throw new DatasetHostError("invalid", "Dataset recovery installation is not configured.");
      const sourceCursor = structuredClone(raw.sourceCursor), manifestSha256 = raw.manifestSha256, transferId = text(raw.transferId), activate = raw.activate === true;
      if (sourceCursor.workspaceId !== key.workspaceId || sourceCursor.datasetId !== key.datasetId) throw new DatasetHostError("invalid", "Recovery dataset differs from the requested dataset.");
      const ownerToken = JSON.stringify(owner(context, key)), authorize = () => { raw.signal?.throwIfAborted(); if (JSON.stringify(owner(context, key)) !== ownerToken) denied(); };
      const installer = createRecoveryInstaller({ ...recovery.install, db, transaction, journal });
      const prior = installer.status({ ...key, transferId, authorize });
      if (prior) {
        if (prior.manifestSha256 !== manifestSha256 || !equalRecoveryCursor(prior.sourceCursor, sourceCursor)) throw new DatasetHostError("conflict", "Recovery transfer differs from its saved receipt.");
        return activate ? installer.claim(context, { ...key, transferId, sourceCursor, manifestSha256, authorize }) : prior;
      }
      const staged = await stageDatasetRecovery({ stream: raw.stream, stagingParent: recovery.directory, expectedManifestSha256: manifestSha256, limits: recovery.limits, signal: raw.signal, authorize });
      const validated = await validateDatasetRecovery({ staged, authorize, signal: raw.signal, runtime: options.runtime, compileOperations: options.compileOperations });
      try {
        if (!equalRecoveryCursor(validated.manifest.cursor, sourceCursor)) throw new DatasetHostError("conflict", "Recovery source cursor differs.");
        if (activate && validated.manifest.sourceState !== "fenced") throw new DatasetHostError("invalid", "Transfer requires a fenced source dataset.");
        const result = await installer.install(context, { transferId, manifestSha256, recovery: validated, authorize });
        return activate ? installer.claim(context, { ...key, transferId, sourceCursor, manifestSha256, authorize }) : result;
      } finally { await validated.dispose(); }
    },
    async exportRecovery(context: Context, raw: DatasetScope & { signal?: AbortSignal }) {
      const key=scope(raw),recovery=options.recovery;
      if(!recovery)throw new DatasetHostError("invalid","Dataset recovery storage is not configured.");
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
      if(raw.revision!==permitted.revision.revision||raw.revisionSha256!==permitted.revision.revisionSha256)throw new DatasetHostError("conflict","Dataset revision is stale. Reload it before retrying.");
      if(!operation)denied();
      return { authority: permitted.authority, revision: permitted.revision, operation };
    },
    async activate(context: Context, raw: ActivateDatasetInput): Promise<DatasetRevision> {
      const approved = verifyDatasetArtifacts(raw), key = scope({ workspaceId: raw.workspaceId, datasetId: approved.datasetId });
      if (approved.revision !== 1) throw new Error("Initial dataset revision must be 1. Schema changes require a revision transition.");
      const schemaSql = raw.schemaSql, source = raw.operationSource, capacityBytes = raw.capacityBytes, signal = raw.signal;
      const captured = owner(context, key), ownerToken = JSON.stringify(captured);
      const authorize = () => { signal?.throwIfAborted(); if (JSON.stringify(owner(context, key)) !== ownerToken) denied(); };
      const existing = db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
      if (existing) {
        const current = parseDatasetRevision(JSON.parse(String(existing.revision_json)));
        if (current.revisionSha256 !== approved.revisionSha256) throw new DatasetHostError("conflict", "Dataset rules are already approved. Use a revision transition to change them.");
        const currentHead = journal.head(key, authorize);
        if (!currentHead.active || currentHead.cursor.approvedRevisionHash !== current.revisionSha256) throw new Error("Dataset authority is no longer active on this host.");
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
      const captured = owner(context, key), ownerToken = JSON.stringify(captured), previous = revision(key);
      if (expected.workspaceId !== key.workspaceId || expected.datasetId !== key.datasetId || expected.approvedRevisionHash !== previous.revisionSha256 || approved.revision !== previous.revision + 1) {
        throw new DatasetHostError("conflict", "Dataset revision transition does not match the current approval.");
      }
      const authorize = () => { signal?.throwIfAborted(); if (JSON.stringify(owner(context, key)) !== ownerToken) denied(); };
      const compiledSource = await compile(source, approved.definition.operationsPath);
      authorize();
      const cursor = await options.supervisor.migrate({ scope: key, expected, tables: previous.definition.tables.map(table => table.sqlName),
        newTables: approved.definition.tables.map(table => table.sqlName), schemaSql, source: compiledSource, definitionJson: JSON.stringify(approved),
        approvedRevisionHash: approved.revisionSha256, migrationSql, signal, authorize,
        accountStage(allocation) { if (options.accountCheckpointStage) synchronous(() => options.accountCheckpointStage!(context, allocation)); },
        account(allocation) {
          const row = db.prepare("SELECT revision_json,artifacts_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId, key.datasetId);
          if (!row || parseDatasetRevision(JSON.parse(String(row.revision_json))).revisionSha256 !== previous.revisionSha256) throw new Error("Dataset approval changed during migration.");
          const revisionJson = JSON.stringify(approved), artifactsJson = JSON.stringify({ schemaSql, operationSource: source });
          const delta = Buffer.byteLength(revisionJson) + Buffer.byteLength(artifactsJson) + 256;
          if (options.accountMigration) synchronous(() => options.accountMigration!(context, { ...key, bytes: allocation.bytes - allocation.stagedCreditBytes + delta,
            capacityBytes: allocation.capacityBytes, capacityDeltaBytes: allocation.capacityDeltaBytes }));
          db.prepare("INSERT INTO dohc_dataset_catalog_history VALUES(?,?,?,?,?)").run(key.workspaceId,key.datasetId,previous.revision,row.revision_json,row.artifacts_json);
          db.prepare("UPDATE dohc_dataset_catalog SET revision_json=?,artifacts_json=? WHERE workspace_id=? AND dataset_id=?").run(revisionJson, artifactsJson, key.workspaceId, key.datasetId);
        } });
      return { revision: approved, cursor };
    },
    setBinding(context: Context, raw: DatasetScope & { appId: string; binding: AppDatasetBinding | null }, commitPublication?: () => void): void {
      const key = scope(raw), appId = text(raw.appId);
      transaction(() => {
        owner(context, key);
        const approved = revision(key);
        const existing = db.prepare("SELECT binding_json FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?").get(key.workspaceId, key.datasetId, appId);
        const previousBytes = existing ? Buffer.byteLength(String(existing.binding_json)) + Buffer.byteLength(appId) + 256 : 0;
        if (raw.binding === null) {
          if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: -previousBytes }));
          db.prepare("DELETE FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?").run(key.workspaceId, key.datasetId, appId);
        }
        else {
          const binding = parseDatasetBinding(raw.binding, approved);
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
        const approved = revision(key);
        const existing = db.prepare("SELECT grant_json FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").get(key.workspaceId, key.datasetId, principalKey);
        const previousBytes = existing ? Buffer.byteLength(String(existing.grant_json)) + Buffer.byteLength(principalKey) + 256 : 0;
        if (raw.grant === null) {
          if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: -previousBytes }));
          db.prepare("DELETE FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?").run(key.workspaceId, key.datasetId, principalKey);
        }
        else {
          if (typeof raw.grant.discover !== "boolean" || Object.keys(raw.grant).some(key => !["operationIds", "discover", "revision", "revisionSha256"].includes(key))) throw new Error("Invalid dataset data grant.");
          currentGrant(raw.grant, approved);
          const binding = parseDatasetBinding({ kind: "dataset", datasetId: approved.datasetId, revision: approved.revision,
            revisionSha256: approved.revisionSha256, operationIds: raw.grant.operationIds }, approved);
          if (approved.definition.operations.some(operation => binding.operationIds.includes(operation.operationId) && operation.access === "owner")) throw new Error("Owner-only operations cannot be granted.");
          const json = JSON.stringify({ operationIds: binding.operationIds, discover: raw.grant.discover, revision: approved.revision, revisionSha256: approved.revisionSha256 });
          if (options.accountMetadata) synchronous(() => options.accountMetadata!(context, { ...key, bytes: Buffer.byteLength(json) + Buffer.byteLength(principalKey) + 256 - previousBytes }));
          db.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id,principal_key) DO UPDATE SET grant_json=excluded.grant_json,token=excluded.token")
            .run(key.workspaceId, key.datasetId, principalKey, json, randomUUID());
        }
        owner(context, key);
      });
    },
    describe(context: Context, raw: DatasetScope): DatasetDescription {
      const key = scope(raw), permitted = permissions(context, key, { kind: "data" });
      if (!permitted.discover) denied();
      return describePermission(permitted);
    },
    list(context: Context, raw: { workspaceId: string; after?: string; limit?: number }): { datasets: DatasetDescription[]; nextCursor: string | null } {
      const workspaceId = text(raw.workspaceId), after = raw.after === undefined ? "" : text(raw.after), limit = raw.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid dataset page size.");
      // Apply data grants in SQL so inaccessible datasets do not create page gaps or counts.
      const verified = authority(context, { workspaceId }, { kind: "data" });
      const rows = verified.caller.kind === "owner"
        ? db.prepare("SELECT dataset_id FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id>? ORDER BY dataset_id LIMIT ?").all(workspaceId, after, limit + 1)
        : db.prepare(`SELECT c.dataset_id FROM dohc_dataset_catalog c JOIN dohc_dataset_data_grants g
            ON c.workspace_id=g.workspace_id AND c.dataset_id=g.dataset_id WHERE c.workspace_id=? AND g.principal_key=? AND c.dataset_id>?
            AND json_extract(g.grant_json,'$.discover')=1
            AND json_extract(g.grant_json,'$.revisionSha256')=json_extract(c.revision_json,'$.revisionSha256')
            ORDER BY c.dataset_id LIMIT ?`).all(workspaceId, verified.principalKey, after, limit + 1);
      const selected = rows.slice(0, limit), datasets: DatasetDescription[] = [];
      let bytes = 0;
      for (const row of selected) {
        const permitted = permissions(context, { workspaceId, datasetId: String(row.dataset_id) }, { kind: "data" });
        if (!permitted.discover) denied();
        const description = describePermission(permitted), size = Buffer.byteLength(JSON.stringify(description));
        if (bytes + size > 1024 * 1024) break;
        datasets.push(description); bytes += size;
      }
      return { datasets, nextCursor: rows.length > datasets.length ? datasets.at(-1)!.datasetId : null };
    },
    approvedArtifacts(context: Context, raw: DatasetScope) {
      const key = scope(raw);
      const current = journal.head(key, () => { owner(context, key); });
      return { revision: revision(key), ...artifacts(key), active: current.active, cursor: current.cursor };
    },
    permissions(context: Context, raw: DatasetScope & { after?: string; limit?: number }) {
      const key = scope(raw), after = raw.after === undefined ? "" : text(raw.after, 1024), limit = raw.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid dataset page size.");
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
          current: metadata.revision === approved.revision && metadata.revisionSha256 === approved.revisionSha256, metadata };
      }), nextCursor: rows.length > limit ? String(selected.at(-1)!.cursor) : null };
    },
    async invoke(context: Context, raw: InvokeDatasetInput): Promise<DatasetInvocationResult> {
      const key = scope(raw), through = access(raw.access), operationId = text(raw.operationId), idempotencyKey = text(raw.idempotencyKey, 128);
      const input = parseAppBackendJson(raw.input, 64 * 1024), permitted = permissions(context, key, through);
      if (raw.revision !== permitted.revision.revision || raw.revisionSha256 !== permitted.revision.revisionSha256) throw new DatasetHostError("conflict", "Dataset revision is stale. Reload it before retrying.");
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
      };
      const resources = options.operationResources ? synchronous(() => options.operationResources!(context, { ...key, authority: permitted.authority, operation, input })) : {};
      return options.supervisor.invoke({ scope: key, tables: permitted.revision.definition.tables.map(table => table.sqlName),
        operation: operation.name, caller: permitted.authority.caller, callerKey: hash(JSON.stringify([permitted.authority.principalKey, through])),
        input, idempotencyKey, payloadSha256: hash(JSON.stringify([permitted.revision.revisionSha256, operationId, input])), readOnly: operation.readOnly,
        files: resources.files, accountAndAttach: resources.accountAndAttach, signal: raw.signal, authorize });
    },
    /** Resolve a protected resource only while the operation's data revision and grants still hold. */
    async readOperation<T>(context: Context, raw: InvokeDatasetInput, read: (result: JsonValue, revision: number) => T): Promise<T> {
      if(read.constructor.name==="AsyncFunction")throw new DatasetHostError("invalid","Protected file reads must be synchronous.");
      const key=scope(raw),through=access(raw.access),permitted=permissions(context,key,through);
      const operation=permitted.operations.find(operation=>operation.operationId===raw.operationId);
      if(!operation?.readOnly)throw new DatasetHostError("invalid","A protected file read requires a read-only dataset operation.");
      const result=await host.invoke(context,raw);
      return transaction(()=>{
        const check=()=>{
          raw.signal?.throwIfAborted();
          const current=permissions(context,key,through);
          if(current.token!==permitted.token)denied();
          const head=db.prepare("SELECT revision,approved_revision_hash,active FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
          if(!head||head.active!==1||head.revision!==result.revision||head.approved_revision_hash!==permitted.revision.revisionSha256)throw new DatasetHostError("conflict","Dataset changed before the protected file was read. Retry it.");
        };
        check();const value=synchronous(()=>read(result.result,result.revision));check();return value;
      });
    },
  };
  return host;
}
