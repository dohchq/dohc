import { createLocalDatasetHistoryReader } from "./localDatasetHistoryReader";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, open as openFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AutomationPressActor, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { APP_BACKEND_OPERATION_FILES, appBackendFileSignatureMatches, parseAppBackendUploadRequest, parseAppBackendFile, type AppBackendFile } from "@dohc/security-contract/app-backend";
import { parseDatasetDefinition, type DatasetDefinition, type DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetAutomationClaim, DatasetAutomationSubscription, DatasetPressed, DatasetPressInput } from "@dohc/app-backend-runtime/dataset-automation-claims";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { resolveCompatibleDatasetRevision, createDatasetHost, DatasetHostError, type DatasetHostOptions } from "@dohc/app-backend-runtime/dataset-host";
import { createDatasetJournal, type JournalDb } from "@dohc/app-backend-runtime/journal";
import { createRecoveryInstaller } from "@dohc/app-backend-runtime/recovery-install";
import { createDatasetSupervisor, type DatasetInvocationResult, type DatasetSupervisorOptions } from "@dohc/app-backend-runtime/supervisor";
import type { AppBackendRuntimeOptions, JsonValue } from "@dohc/app-backend-runtime";
import type { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";
import { createLocalAppStore, type LocalAppStore } from "./localAppStore";
import { createLocalApps } from "./localApps";
import { createLocalDatasetApps, localDatasetAppStorage, type LocalDatasetAppContext } from "./localDatasetApps";
import { createLocalCollectionApps, localCollectionAppStorage, type LocalCollectionEngine } from "./localCollectionApps";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { createDatasetAttempts } from "@dohc/app-backend-runtime/dataset-attempts";
import { createLocalDatasetMigrations, type PrepareLocalDatasetMigration } from "./localDatasetMigration";
import { createLocalDatasetRecovery } from "./localDatasetRecovery";
import { createLocalDatasetTransfers, type DatasetTransferTarget } from "./localDatasetTransfer";
import { localDatasetFolder, OLD_STORE_PATH, readLocalDatasetExports, STORE_FILE, STORE_PATH, type LocalDatasetFolder } from "./localDatasetFolders";
import { currentLocalStateOpen, localStateOpened, LocalStateUnavailableError, readOwnedLocalState, type LocalStateWorkspace } from "./workspaceLocalState";
import { renameWithRetry } from "../atomicReplaceFile";
import { admitCollectionsStore, CollectionsRefusalError, createHoldingCheck, holderWork, recordCollectionsStore, type CollectionsAdmission, type CollectionsHolderCheck } from "./collectionsHolder";
import { hasGeneratedDatasetOperations } from "@dohc/security-contract/dataset-operations";
import { DatasetPermissionsPage } from "@dohc/cli/dataset";

type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources">;
type OwnerContext = { readonly owner: true };
/**
 * One automation run's authority on this computer's datasets: the automation
 * caller, which the host holds to the owner's approved operations and which
 * operation code sees as an automation, not the owner. Only main creates
 * one, through the host, and the host object never leaves main. `depth` is
 * the chain depth its writes declare, one more than the claim that started
 * the run. `person` is who its writes are made for: the person whose change
 * started it, or null for nobody.
 */
export interface LocalDatasetAutomationContext { readonly automationId: string; readonly claimId: string; readonly depth: number; readonly person: string | null; readonly authorizeOperation?: (datasetId: string, operationId: string) => void }
/**
 * The owner's agent, as main derives it for one invocation: the owner's
 * authority, attributed to the agent at its run's chain depth, 0 outside a
 * chain. Attribution never grants access.
 */
export interface LocalDatasetAgent { readonly depth: number; readonly approvalAgent?: import("@dohc/security-contract/approval-provenance").ApprovalAgent }
type AgentContext = { readonly agent: LocalDatasetAgent };
type LocalContext = OwnerContext | LocalDatasetAppContext | LocalDatasetAutomationContext | AgentContext;
type Resources = Pick<DatasetHostOptions<LocalContext>, "operationResources" | "accountCreation" | "accountMigration" | "accountCheckpointStage">;
export interface LocalDatasetHostOptions {
  workspaceId: string;
  workspaceRoot: string;
  /**
   * Whether this installation keeps the workspace's Collections, read
   * before the store is opened or created and again before each piece of work.
   */
  holder: CollectionsHolderCheck;
  /** The attachment whose engine open prepares `.dohc/local`, where the store, workers and exports live. */
  attachmentId?: symbol;
  /**
   * Puts a file in the system trash, where a person can recover it. The
   * holder trashes a store it moved into `.dohc/local`. Without it, the old
   * store stays where it was.
   */
  trashItem?(path: string): Promise<void>;
  /** The main process checks that this workspace session still belongs to the caller. */
  assertCurrent?(): void;
  runtime?: AppBackendRuntimeOptions;
  persistentRuntime?: DatasetSupervisorOptions["runtime"];
  /** Electron supplies its installed, supervised compiler. Node tests may use the direct compiler. */
  compile?(source: string, path: string, signal: AbortSignal): Promise<string>;
  maxWorkers?: number;
  /** Retained journal and checkpoint bytes plus reserved materialization capacity. */
  maxStoredBytes?: number;
  capacityBytes?: number;
  /** File associations must use this database and transaction, never a later write. */
  resources?(storage: { db: JournalDb; transaction: <T>(run: () => T) => T }): Resources;
  /**
   * The agent run active in this workspace attachment now, or null. Main
   * derives it, and throws when the attachment is no longer current. A local
   * app's invocation reads it once at its start and writes as that run's
   * agent, whoever clicked.
   */
  agentRun?(): LocalDatasetAgent | null;
  /**
   * The person on this computer: the account, or this installation's id when
   * signed out. The owner's, the agent's and a local app's commits are made
   * for them. Never the dataset owner key, which only authorizes.
   */
  localPersonId(): string;
  /**
   * A commit made automation claims, and `failed` when it made any failed, as
   * a chain stop does. A hint for the executor, which also drains and
   * reports failures at open.
   */
  onAutomationClaims?(failed: boolean): void;
  /** A dataset's approved rules or lifecycle changed, so the executor re-indexes. */
  onDatasetsChanged?(): void;
  /** This attachment's workspace engine for document Collection apps. Throws while it is unavailable. */
  collectionEngine?(): LocalCollectionEngine;
  /** Who a local Collection app's response is made by: the agent run active now, or the person here. */
  collectionAuthor?(): Promise<MomentWriteAuthor>;
}
export interface LocalDatasetPreparation {
  preparationId: string;
  revision: DatasetRevision;
  sourceDigest: string;
}
export interface LocalDatasetInvocation {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  operationId: string;
  input: JsonValue;
  idempotencyKey: string;
  signal?: AbortSignal;
  /**
   * Set by main when the owner's agent invokes, so its commit names the
   * agent and the claims it makes carry the run's chain on.
   */
  agent?: LocalDatasetAgent;
}
export interface LocalDatasetUpload {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  idempotencyKey: string;
  name: string;
  contentType: string;
  bytesBase64: string;
  signal?: AbortSignal;
}
export interface LocalDatasetFileRequest {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  fileId: string;
  signal?: AbortSignal;
}

const artifactBytes = 256 * 1024;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const allowed = (path: string) => isShareablePath(path) && !isSharedWithMePath(path) && !path.toLowerCase().split("/").includes(".dohc");

/** Owner-only local data authority. Apps do not receive this object or its storage paths. */
export async function createLocalDatasetHost(options: LocalDatasetHostOptions) {
  if (typeof options.workspaceId !== "string" || !options.workspaceId || options.workspaceId.includes("\0") || Buffer.byteLength(options.workspaceId) > 256) throw new Error("Invalid workspace identity.");
  const maxStoredBytes = options.maxStoredBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 4096) throw new Error("Invalid Collection storage limit.");
  if (process.versions.electron && !options.compile) throw new Error("Electron must configure the installed Collection compiler.");
  const compile = options.compile ?? (async (source: string, path: string, signal: AbortSignal) => {
    const modulePath = pathToFileURL(createRequire(import.meta.url).resolve("@dohc/app-backend-runtime/dataset-compiler")).href;
    const compiler = await import(/* @vite-ignore */ modulePath) as { compileDatasetOperations: typeof compileDatasetOperations };
    return compiler.compileDatasetOperations(source, path, { signal });
  });
  const root = await realpath(options.workspaceRoot);
  const localState = { workspaceId: options.workspaceId, rootPath: options.workspaceRoot, attachmentId: options.attachmentId };
  const { db, path } = await holderWork(options.workspaceId, () => openHeldStore(root, localState, options.holder, options.trashItem));
  const historyReader = createLocalDatasetHistoryReader(path, options.workspaceId);
  const holding = createHoldingCheck(root, options.workspaceId, options.holder, () => storeIdOf(db));
  // Set once the record names another computer or store: every use after refuses too.
  let refusal: CollectionsRefusalError | null = null;
  let closed = false, closePromise: Promise<void> | undefined, transactionSequence = 0;
  const lifetime = new AbortController(), active = new Set<Promise<unknown>>();
  const owner: OwnerContext = { owner: true };
  const workspaceId = options.workspaceId;
  // Owner retries must retain their identity when a fenced local dataset moves to the relay.
  // The workspace owns this identity, so it does not depend on a device or account session.
  const ownerId = digest(JSON.stringify(["dohc-dataset-owner-v1", workspaceId]));
  // Each automation's retries keep their own identity, derived from the workspace like the owner's.
  const automationKey = (automationId: string) => digest(JSON.stringify(["dohc-dataset-automation-v1", workspaceId, automationId]));
  const automationContexts = new WeakSet<LocalDatasetAutomationContext>();
  const agentContexts = new WeakSet<AgentContext>();
  // The owner, or the owner's agent: both reach every file the owner can.
  const ownerAuthority = (context: LocalContext) => context === owner || agentContexts.has(context as AgentContext);
  const pending = new Map<string, { preparation: LocalDatasetPreparation; schemaSql: string; operationSource: string; expires: number }>();
  function assertCurrent() {
    if (closed) throw new Error("This Collection session ended. Reopen the workspace.");
    assertHeld();
    options.assertCurrent?.();
  }
  // Every admission and every write checks the record first, app requests too.
  function assertHeld() {
    if (refusal) throw refusal;
    try { holding(); }
    catch (error) { if (error instanceof CollectionsRefusalError) refusal = error; throw error; }
  }
  function signal(input?: AbortSignal) { assertCurrent(); return input ? AbortSignal.any([input, lifetime.signal]) : lifetime.signal; }
  function transaction<T>(work: () => T): T {
    assertCurrent();
    return commit(work);
  }
  /**
   * Every write to the store, its schema too, runs through here: through
   * `transaction`, or directly where it must skip the session check, so
   * admitted Collection creates still record their outcomes while the host
   * closes. Only the claims and the move, in openHeldStore, and
   * adoptLocalDatasetStore write outside it, before the record names the
   * store or before the host opens it, and the read-only
   * History thread reads through its own connection. The record check runs
   * before the work and again after it: a record that changed while the
   * work ran rolls the work back, savepoint or transaction.
   */
  function commit<T>(work: () => T): T {
    assertHeld();
    const nested = db.isTransaction, savepoint = `local_dataset_${++transactionSequence}`;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try { const result = work(); assertHeld(); db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT"); return result; }
    catch (error) { db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK"); throw error; }
  }
  async function tracked<T>(work: () => Promise<T>): Promise<T> {
    assertCurrent(); const result = work(); active.add(result);
    try { return await result; } finally { active.delete(result); }
  }
  /** Charges a Dataset's usage, or with null the Collection app ledger. */
  function charge(datasetId: string | null, bytes: number) {
    if (!Number.isSafeInteger(bytes)) throw new Error("Invalid Collection storage allocation.");
    const changed = db.prepare("UPDATE local_dataset_budget SET bytes=bytes+? WHERE singleton=1 AND bytes+?>=0 AND bytes+?<=?").run(bytes, bytes, bytes, maxStoredBytes);
    if (changed.changes !== 1) throw new Error("Collection storage is full. Delete an unused Collection permanently to release storage. Exporting alone does not release storage.");
    if (datasetId === null) { db.prepare("UPDATE local_collection_app_usage SET bytes=bytes+? WHERE singleton=1").run(bytes); return; }
    db.prepare("INSERT OR IGNORE INTO local_dataset_usage VALUES(?,0)").run(datasetId);
    db.prepare("UPDATE local_dataset_usage SET bytes=bytes+? WHERE dataset_id=?").run(bytes,datasetId);
  }
  let supervisor: Awaited<ReturnType<typeof createDatasetSupervisor>> | undefined;
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS local_dataset_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),workspace_id TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS local_dataset_budget(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL CHECK(bytes>=0)) STRICT;
      CREATE TABLE IF NOT EXISTS local_dataset_usage(dataset_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0)) STRICT;
      CREATE TABLE IF NOT EXISTS local_collection_app_usage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL CHECK(bytes>=0)) STRICT;
      CREATE TABLE IF NOT EXISTS local_dataset_files(
        workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,file_id TEXT NOT NULL,key TEXT NOT NULL,
        metadata TEXT NOT NULL,content BLOB NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,
        attached_revision INTEGER,storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
        PRIMARY KEY(workspace_id,dataset_id,file_id),UNIQUE(workspace_id,dataset_id,key)) STRICT;
      CREATE TABLE IF NOT EXISTS local_dataset_recovery_files(import_id TEXT NOT NULL,workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,file_id TEXT NOT NULL,key TEXT NOT NULL,metadata TEXT NOT NULL,content BLOB NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,attached_revision INTEGER NOT NULL,storage_bytes INTEGER NOT NULL,PRIMARY KEY(import_id,file_id)) STRICT;`);
      db.prepare("INSERT OR IGNORE INTO local_dataset_identity VALUES(1,?)").run(workspaceId);
      if (db.prepare("SELECT workspace_id FROM local_dataset_identity WHERE singleton=1").get()!.workspace_id !== workspaceId) throw new Error("This Collection store belongs to another workspace.");
      db.prepare("INSERT OR IGNORE INTO local_dataset_budget VALUES(1,0)").run();
      db.prepare("INSERT OR IGNORE INTO local_collection_app_usage VALUES(1,0)").run();
      // Collection app storage is outside Dataset usage, so a build without it refuses the store.
      const budget = Number(db.prepare("SELECT bytes FROM local_dataset_budget WHERE singleton=1").get()!.bytes);
      const tracked = Number(db.prepare("SELECT coalesce(sum(bytes),0)+(SELECT bytes FROM local_collection_app_usage) AS bytes FROM local_dataset_usage").get()!.bytes);
      if (budget !== tracked) throw new Error("This development Collection store predates per-Collection storage accounting. Export it with the previous build before resetting the store.");
    });
    const journal = createDatasetJournal({ db, transaction });
    const attempts = createDatasetAttempts({ db, transaction, account: (scope, bytes) => charge(scope.datasetId,bytes) });
    // Workers and exports are this computer's, in `.dohc/local`, beside the
    // store. The engine's open prepared it before the store opened, but a
    // close or a rebind can end that open later. Anything that needs a
    // worker or a staged file then waits for an open already under way,
    // never starts one, and refuses if the folder still isn't ready.
    const folderOnce = (folder: LocalDatasetFolder) => folderOnceOpened(localState, folder);
    const resources: Resources | undefined = options.resources?.({ db, transaction });
    createRecoveryInstaller({ db, transaction, journal });
    // While the host opens, it takes the worker folder only if it is ready, so opening never waits again.
    supervisor = await createDatasetSupervisor({ journal, directory: () => supervisor ? folderOnce("workers") : localDatasetFolder(localState, "workers"), runtime: options.persistentRuntime, maxWorkers: options.maxWorkers, reopenWaitCapMs: 60_000,
      onMaintenanceError(scope){console.warn("dataset_materialization_deferred",scope);},
      maintenanceStorage:{authorize(){if(!db.isOpen)throw new Error("Collection storage is closed.");},account(allocation){charge(allocation.scope.datasetId,allocation.bytes);return resources?.accountCheckpointStage?.(owner,allocation);}},
      // Holding the worker folder makes this the only dohc staging work here.
      async startup() {
        let stageCursor: string | undefined;
        do {
          stageCursor = journal.reclaimCheckpointStages({ after: stageCursor, authorize: assertCurrent,
            retain: stage => Boolean(db.prepare("SELECT 1 FROM dohc_dataset_import_checkpoints WHERE stage_id=?").get(stage.stageId)),
            account(allocation) { charge(allocation.scope.datasetId,allocation.bytes); return resources?.accountCheckpointStage?.(owner, allocation); },
          }).after;
          if (stageCursor) await new Promise<void>(resolve => setImmediate(resolve));
        } while (stageCursor);
      } });
    let apps: ReturnType<typeof createLocalDatasetApps>;
    let appStore: LocalAppStore;
    let localApps: ReturnType<typeof createLocalApps>;
    const exportDirectory = () => folderOnce("exports");
    const host = createDatasetHost<LocalContext>({ db, transaction, journal, supervisor, runtime: options.runtime, persistentRuntime: options.persistentRuntime,
      wakeAutomations: (_scope, failed) => { if (!closed) options.onAutomationClaims?.(failed); },
      recovery: {
        directory: exportDirectory, limits: { maxTotalBytes: maxStoredBytes },
        install: { allowOwnerRecoveryClaim: true, account(_context, allocation) { charge(allocation.datasetId,allocation.bytes); },
          installAttachment: async (_context, input) => {
            const chunks: Uint8Array[] = []; let size = 0;
            for await (const chunk of input.stream) { assertCurrent(); size += chunk.byteLength; if (size > input.file.byteLength) throw new Error("Recovery attachment exceeds its declared length."); chunks.push(chunk); }
            if (size !== input.file.byteLength) throw new Error("Recovery attachment is incomplete.");
            const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
            if (digest(bytes) !== input.file.sha256) throw new Error("Recovery attachment integrity check failed.");
            const { revision, ...file } = input.file;
            const now = Date.now(), metadata = JSON.stringify(file), key = JSON.stringify([workspaceId,input.datasetId,"recovery",input.file.fileId]);
            const retained = bytes.byteLength + Buffer.byteLength(metadata) + Buffer.byteLength(key) + 384;
            transaction(() => { charge(input.datasetId,retained); db.prepare("INSERT INTO local_dataset_recovery_files VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(input.importId,workspaceId,input.datasetId,input.file.fileId,key,metadata,bytes,now,now+86_400_000,revision,retained); });
          },
          commitAttachments(_context, input) {
            db.prepare("INSERT INTO local_dataset_files SELECT workspace_id,dataset_id,file_id,key,metadata,content,created_at_ms,expires_at_ms,attached_revision,storage_bytes FROM local_dataset_recovery_files WHERE import_id=? AND workspace_id=? AND dataset_id=?").run(input.importId,workspaceId,input.datasetId);
            db.prepare("DELETE FROM local_dataset_recovery_files WHERE import_id=? AND workspace_id=? AND dataset_id=?").run(input.importId,workspaceId,input.datasetId);
          },
          async discardAttachments(_context, input) {
            transaction(() => {
              const row = db.prepare("SELECT coalesce(sum(storage_bytes),0) bytes FROM local_dataset_recovery_files WHERE import_id=? AND workspace_id=? AND dataset_id=?").get(input.importId,workspaceId,input.datasetId)!;
              charge(input.datasetId,-Number(row.bytes)); db.prepare("DELETE FROM local_dataset_recovery_files WHERE import_id=? AND workspace_id=? AND dataset_id=?").run(input.importId,workspaceId,input.datasetId);
            });
          },
        },
        captureAttachments(_context, key, cursor) {
          return db.prepare("SELECT metadata,attached_revision FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND attached_revision IS NOT NULL AND attached_revision<=? ORDER BY file_id")
            .all(key.workspaceId, key.datasetId, cursor.revision).map(row => ({ ...parseAppBackendFile(JSON.parse(String(row.metadata))), revision: Number(row.attached_revision) }));
        },
        async *openAttachment(_context, key, file) {
          for (let offset = 0; offset < file.byteLength; offset += 1024 * 1024) {
            assertCurrent();
            const row = db.prepare("SELECT substr(content,?,?) bytes FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=? AND attached_revision IS NOT NULL")
              .get(offset + 1, Math.min(1024 * 1024, file.byteLength - offset), key.workspaceId, key.datasetId, file.fileId);
            if (!row || !(row.bytes instanceof Uint8Array)) throw Error("This Collection file is unavailable.");
            yield row.bytes;
          }
        },
      },
      resolveAuthority(context, request) {
        assertCurrent();
        const automation = automationContexts.has(context as LocalDatasetAutomationContext) ? context as LocalDatasetAutomationContext : null;
        const agent = agentContexts.has(context as AgentContext) ? context as AgentContext : null;
        if (context !== owner && automation === null && agent === null) return apps.resolveAuthority(context as LocalDatasetAppContext, request);
        if (request.workspaceId !== workspaceId || request.access.kind !== "data") throw new Error("Collection access is not permitted.");
        if (agent !== null) return { caller: { kind: "owner", userId: ownerId }, principalKey: ownerId, agent: { depth: agent.agent.depth }, person: options.localPersonId() };
        if (automation === null) return { caller: { kind: "owner", userId: ownerId }, principalKey: ownerId, person: options.localPersonId() };
        return { caller: { kind: "automation", automationId: automation.automationId }, principalKey: automationKey(automation.automationId),
          chainDepth: automation.depth, authorizeOperation: automation.authorizeOperation, ...(automation.person === null ? {} : { person: automation.person }) };
      },
      async compileOperations(source, sourcePath) {
        const compiled = await compile(source, sourcePath, lifetime.signal);
        assertCurrent(); lifetime.signal.throwIfAborted();
        return compiled;
      },
      accountCreation(context, allocation) { charge(allocation.datasetId,allocation.bytes); return resources?.accountCreation?.(context, allocation); },
      accountMetadata(_context, allocation) { charge(allocation.datasetId,allocation.bytes); },
      accountAutomations(allocation) { charge(allocation.datasetId,allocation.bytes); },
      accountMigration(context, allocation) { charge(allocation.datasetId,allocation.bytes); return resources?.accountMigration?.(context, allocation); },
      accountCheckpointStage(context, allocation) { charge(allocation.scope.datasetId,allocation.bytes); return resources?.accountCheckpointStage?.(context, allocation); },
      deleteResources(_context, key) {
        const bytes = db.prepare("SELECT bytes FROM local_dataset_usage WHERE dataset_id=?").get(key.datasetId);
        if (!bytes) throw new Error("Collection storage accounting is missing.");
        charge(key.datasetId,-Number(bytes.bytes));
        db.prepare("DELETE FROM local_dataset_usage WHERE dataset_id=?").run(key.datasetId);
        for (const table of ["local_dataset_files","local_dataset_recovery_files"])
          db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND dataset_id=?`).run(workspaceId,key.datasetId);
        appStore.deleteResources("dataset", key.datasetId);
      },
      operationResources(context, request) {
        const extra = resources?.operationResources?.(context, request);
        const ids = new Set<string>();
        const collect = (value: unknown) => {
          if (typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value)) ids.add(value);
          else if (Array.isArray(value)) value.forEach(collect);
          else if (value && typeof value === "object") Object.values(value).forEach(collect);
        };
        collect(request.input);
        const files: AppBackendFile[] = [];
        for (const fileId of ids) {
          const row = db.prepare("SELECT metadata,key,attached_revision FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=? AND (attached_revision IS NOT NULL OR expires_at_ms>?)").get(workspaceId, request.datasetId, fileId, Date.now());
          if (row && (ownerAuthority(context) || JSON.parse(String(row.key))[2] === request.authority.principalKey)) files.push(parseAppBackendFile(JSON.parse(String(row.metadata))));
        }
        if (files.length > APP_BACKEND_OPERATION_FILES) throw new Error(`A Collection action can attach at most ${APP_BACKEND_OPERATION_FILES} files.`);
        const capturedFiles = new Set(files.map(file => file.fileId));
        return { files: [...(extra?.files ?? []), ...files], accountAndAttach(allocation) {
          // The journal already owns the transaction containing this callback.
          for (const fileId of allocation.attachedFileIds) {
            if (!capturedFiles.has(fileId)) throw new Error("This Collection file is unavailable.");
            const current=db.prepare("SELECT key FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=?").get(workspaceId,request.datasetId,fileId);
            if (!current || (!ownerAuthority(context) && JSON.parse(String(current.key))[2] !== request.authority.principalKey)) throw new Error("This Collection file is unavailable.");
            const changed = db.prepare("UPDATE local_dataset_files SET attached_revision=coalesce(attached_revision,?) WHERE workspace_id=? AND dataset_id=? AND file_id=? AND (attached_revision IS NOT NULL OR expires_at_ms>?)")
              .run(allocation.revision, workspaceId, request.datasetId, fileId, Date.now());
            if (changed.changes !== 1) throw new Error("This Collection file expired. Upload it again.");
          }
          charge(request.datasetId,allocation.bytes); return extra?.accountAndAttach?.(allocation);
        } };
      },
    });
    function readFile(input: LocalDatasetFileRequest, attachedOnly: boolean) {
      assertCurrent();signal(input.signal).throwIfAborted();
      if (typeof input.fileId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.fileId)) throw new Error("Invalid Collection file.");
      const row = db.prepare("SELECT metadata,content,expires_at_ms,attached_revision FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=?").get(workspaceId, input.datasetId, input.fileId) as {metadata:string;content:Uint8Array;expires_at_ms:number;attached_revision:number|null}|undefined;
      if (!row || (row.attached_revision === null && (attachedOnly || row.expires_at_ms <= Date.now()))) throw new Error("This Collection file is unavailable.");
      const file = parseAppBackendFile(JSON.parse(row.metadata));
      if (row.content.byteLength !== file.byteLength || digest(row.content) !== file.sha256) throw new Error("Collection file integrity check failed.");
      return {file, bytesBase64: Buffer.from(row.content).toString("base64")};
    }
    const migrations = createLocalDatasetMigrations({ workspaceId, assertCurrent,
      approvedArtifacts: datasetId => host.approvedArtifacts(owner, { workspaceId, datasetId }),
      prepareMigrationCandidate: input => host.prepareMigration(owner, input),
      approveMigrationCandidate: input => host.approveMigration(owner, input),
      discardMigrationCandidate: input => host.discardMigration(owner, input) });
    const transfers = createLocalDatasetTransfers({ db, journal, workspaceId, inExportDirectory: (read) => readLocalDatasetExports(options.workspaceRoot, read), limits: { maxTotalBytes: maxStoredBytes },
      transaction, assertCurrent, exportRecovery: (datasetId, abort) => host.exportRecovery(owner, { workspaceId, datasetId, signal: abort }),
      fenced: () => changed(undefined) });
    async function prepare(input: { descriptorPath: string; adapter: SourceAdapter; signal?: AbortSignal }): Promise<LocalDatasetPreparation> {
      return tracked(async () => {
        const abort = signal(input.signal);
        if (!allowed(input.descriptorPath) || (input.descriptorPath !== "dataset.json" && !input.descriptorPath.endsWith("/dataset.json"))) throw new Error("Choose a Collection descriptor in this workspace.");
        for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
        if (pending.size >= 8) throw new Error("Too many Collections are waiting for approval. Finish or discard an approval.");
        async function capture(paths: string[]) {
          assertCurrent(); abort.throwIfAborted();
          const metadata = await input.adapter.captureSourceMetadata({workspaceId, versionId: "main", paths, bounds: {maxInputFiles: 3, maxInputBytes: artifactBytes * 3}, signal: abort});
          assertCurrent(); abort.throwIfAborted();
          const files = await input.adapter.hydrateCapturedSources(metadata, abort);
          assertCurrent(); abort.throwIfAborted();
          if (metadata.workspaceId !== workspaceId || files.length !== paths.length || files.some(file => !paths.includes(file.path) || file.bytes.byteLength > artifactBytes || digest(file.bytes) !== file.sha256)) throw new Error("Collection source capture is invalid.");
          return { metadata, files };
        }
        const first = await capture([input.descriptorPath]);
        const definition = parseDatasetDefinition(JSON.parse(decode(first.files[0]!.bytes)));
        const paths = [input.descriptorPath, definition.schemaPath, definition.operationsPath];
        if (new Set(paths).size !== 3 || paths.some(path => !allowed(path))) throw new Error("Collection source paths must stay inside this workspace.");
        const captured = await capture(paths);
        const descriptor = captured.files.find(file => file.path === input.descriptorPath);
        if (descriptor?.sha256 !== first.files[0]!.sha256) throw new Error("The Collection definition changed. Prepare it again.");
        const schemaSql = decode(captured.files.find(file => file.path === definition.schemaPath)!.bytes);
        const operationSource = decode(captured.files.find(file => file.path === definition.operationsPath)!.bytes);
        const revision = describeDatasetRevision({definition, revision: 1, schemaSql, operationSource});
        const preparation = {preparationId: randomUUID(), revision, sourceDigest: captured.metadata.sourceDigest};
        pending.set(preparation.preparationId, {preparation: structuredClone(preparation), schemaSql, operationSource, expires: Date.now() + 10 * 60_000});
        return preparation;
      });
    }
    function checkRevision(input: Pick<LocalDatasetInvocation, "datasetId" | "revision" | "revisionSha256">) {
      assertCurrent();
      const description = host.describe(owner, {workspaceId, datasetId: input.datasetId});
      resolveCompatibleDatasetRevision(db,{workspaceId,datasetId:input.datasetId},input);
      return description;
    }
    function checkInvocation(input: LocalDatasetInvocation, readOnly?: boolean) {
      const description = checkRevision(input);
      if (readOnly !== undefined && !description.operations.some(operation => operation.operationId === input.operationId && operation.readOnly === readOnly)) throw new Error("Choose an approved Collection action.");
    }
    function invoke(input: LocalDatasetInvocation, readOnly?: boolean): Promise<DatasetInvocationResult> {
      return tracked(async () => {
        checkInvocation(input, readOnly);
        const context = input.agent === undefined ? owner : agentContext(input.agent);
        return host.invoke(context, {workspaceId, datasetId: input.datasetId, revision: input.revision, revisionSha256: input.revisionSha256, operationId: input.operationId, input: input.input,
          idempotencyKey: input.idempotencyKey, signal: signal(input.signal)});
      });
    }
    function agentContext(agent: LocalDatasetAgent): AgentContext {
      const context = Object.freeze({ agent: Object.freeze({ depth: agent.depth }) });
      agentContexts.add(context);
      return context;
    }
    const recovery = createLocalDatasetRecovery({workspaceId,maxBytes:maxStoredBytes+2*1024*1024,signal:lifetime.signal,assertCurrent,
      prepare: input => host.prepareRecovery(owner,input),claim: input => host.claimRecovery(owner,input)});
    // After a change to which rules a dataset runs, or whether it runs.
    const changed = <T>(value: T): T => { if (!closed) options.onDatasetsChanged?.(); return value; };
    const local = {
      /**
       * Throws when this installation no longer keeps this store, as every
       * use after does, so a caller that reuses an open host can close it.
       */
      held(): void { assertCurrent(); },
      prepare,
      prepareMigration(input: PrepareLocalDatasetMigration) { return tracked(() => migrations.prepareMigration({ ...input, signal: signal(input.signal) })); },
      approveMigration(input: Parameters<typeof migrations.approveMigration>[0]) { return tracked(() => migrations.approveMigration({ ...input, signal: signal(input.signal) })).then(changed); },
      discardMigration: migrations.discardMigration,

      discard(preparationId: string) { assertCurrent(); pending.delete(preparationId); },
      approve(input: {preparationId: string; revisionSha256: string; approvalAgent?: import("@dohc/security-contract/approval-provenance").ApprovalAgent | null; signal?: AbortSignal}) {
        return tracked(async () => {
          const captured = pending.get(input.preparationId);
          if (!captured || captured.expires < Date.now() || captured.preparation.revision.revisionSha256 !== input.revisionSha256) throw new Error("This Collection approval expired or changed. Prepare it again.");
          const approved = await host.activate(owner, {workspaceId, revision: captured.preparation.revision, schemaSql: captured.schemaSql,
            operationSource: captured.operationSource, approvalAgent:input.approvalAgent, capacityBytes: options.capacityBytes, signal: signal(input.signal)});
          pending.delete(input.preparationId); return changed(approved);
        });
      },
      list(input: {after?: string; limit?: number; includeArchived?: boolean} = {}) { assertCurrent(); return host.list(owner, {workspaceId, ...input}); },
      describe(datasetId: string, input: { includeArchived?: boolean } = {}) { assertCurrent(); return host.describe(owner, {workspaceId, datasetId, ...input}); },
      lifecycle(input: { datasetId: string; after?: string; limit?: number }) { assertCurrent(); return host.lifecycle(owner, { workspaceId, ...input }); },
      archive(input: { datasetId: string }) { assertCurrent(); return changed(host.archiveDataset(owner, { workspaceId, datasetId: input.datasetId })); },
      restore(input: { datasetId: string }) { assertCurrent(); return changed(host.restoreDataset(owner, { workspaceId, datasetId: input.datasetId })); },
      deletePreview(input: { datasetId: string; after?: string; limit?: number }) { assertCurrent(); return host.deletePreview(owner,{workspaceId,...input}); },
      deletionStatus(input: { datasetId: string }) { assertCurrent(); return host.deletionStatus(owner,{workspaceId,...input}); },
      deleteDataset(input: { datasetId: string; expected: import("@dohc/app-backend-runtime/journal").DatasetCursor; reviewToken: string; acknowledge: true }) {
        return tracked(() => host.deleteDataset(owner,{workspaceId,...input})).then(changed);
      },
      pendingAttempts(input: { datasetId: string; after?: number; limit?: number }) { assertCurrent(); return host.pendingAttempts(owner, { workspaceId, ...input }); },
      reconcileAttempt(input: { datasetId: string; reference: string; acknowledge: true }) { assertCurrent(); return host.reconcileAttempt(owner, { workspaceId, ...input }); },
      cancelAttempt(input: { datasetId: string; reference: string; acknowledge: true }) { assertCurrent(); return host.cancelAttempt(owner, { workspaceId, ...input }); },
      historyRevision(input: { datasetId: string; revisionSha256: string }) { assertCurrent(); return host.historyRevision(owner, { workspaceId, ...input }); },
      historyHeads(input: { positions?: Array<{ datasetId: string; beforeRevision: number }>; limit?: number; sourceIds?: string[] } = {}) {
        return tracked(async () => {
          const result = await historyReader.read(input);
          assertCurrent();
          return result;
        });
      },
      history(input: { datasetId: string; beforeRevision?: number; limit?: number; metadataOnly?: boolean; signal?: AbortSignal }) { assertCurrent(); return host.history(owner, { workspaceId, ...input }); },
      async permissions(input: { datasetId: string; after?: string; limit?: number }) {
        assertCurrent();
        return DatasetPermissionsPage.parse(host.permissions(owner, { workspaceId, datasetId: input.datasetId, after: input.after, limit: input.limit }));
      },
      approvedArtifacts(datasetId: string) { assertCurrent(); return host.approvedArtifacts(owner, {workspaceId, datasetId}); },
      prepareRecovery(input: Parameters<typeof recovery.prepare>[0]) { return tracked(() => recovery.prepare(input)); },
      claimRecovery(input: Parameters<typeof recovery.claim>[0]) { return tracked(() => recovery.claim(input)).then(changed); },
      discardRecovery(transferId: string) { return tracked(() => recovery.discard(transferId)); },
      prepareMigrationCandidate(input: Parameters<typeof host.prepareMigration>[1]) { assertCurrent(); if (input.workspaceId !== workspaceId) throw new Error("This Collection belongs to another workspace."); return tracked(() => host.prepareMigration(owner, { ...input, signal: signal(input.signal) })); },
      approveMigrationCandidate(input: Parameters<typeof host.approveMigration>[1]) { assertCurrent(); if (input.workspaceId !== workspaceId) throw new Error("This Collection belongs to another workspace."); return tracked(() => host.approveMigration(owner, { ...input, signal: signal(input.signal) })).then(changed); },
      migrationPreviewPage(input: Parameters<typeof host.migrationPreviewPage>[1]) { assertCurrent(); if (input.workspaceId !== workspaceId) throw new Error("This Collection belongs to another workspace."); return tracked(async () => host.migrationPreviewPage(owner, { ...input, signal: signal(input.signal) })); },
      discardMigrationCandidate(input: Parameters<typeof host.discardMigration>[1]) { assertCurrent(); if (input.workspaceId !== workspaceId) throw new Error("This Collection belongs to another workspace."); return tracked(async () => host.discardMigration(owner, { ...input, signal: signal(input.signal) })); },
      prepareExport(datasetId: string, input: { signal?: AbortSignal } = {}) {
        return tracked(async () => {
          const archive = await host.exportRecovery(owner, { workspaceId, datasetId, signal: signal(input.signal) });
          return { ...archive, maxBytes: maxStoredBytes + 2 * 1024 * 1024 };
        });
      },
      transferStatus(datasetId: string) { assertCurrent(); return transfers.status(datasetId); },
      transferInFlight(datasetId: string) { assertCurrent(); return transfers.inFlight(datasetId); },
      // The fence and a finished move tell the automation runner, which reads the transfer record again. A stop
      // changes nothing it reads: the reads a change sets off would resume the move, and its next stop would set off more.
      transferToShared(input: { datasetId: string; targetOrigin: string; target: DatasetTransferTarget; signal?: AbortSignal }) {
        return tracked(() => transfers.transfer({ ...input, signal: signal(input.signal) })).then(changed);
      },
      upload(input: LocalDatasetUpload, appContext?: LocalDatasetAppContext) {
        return tracked(async () => {
          signal(input.signal).throwIfAborted(); checkRevision(input);
          const authorize = () => {
            assertCurrent(); signal(input.signal).throwIfAborted();
            return appContext ? apps.resolveAuthority(appContext, { workspaceId, datasetId: input.datasetId, access: { kind: "app", appId: appContext.publicationId } }).principalKey : ownerId;
          };
          const principal = authorize();
          const parsed = parseAppBackendUploadRequest({authorityRevision: input.revision, idempotencyKey: input.idempotencyKey, name: input.name, contentType: input.contentType, bytesBase64: input.bytesBase64});
          const bytes = Buffer.from(parsed.bytesBase64, "base64"), sha256 = digest(bytes);
          if (!appBackendFileSignatureMatches(parsed.contentType, bytes)) throw new Error("File content does not match its type.");
          const now = Date.now();
          return transaction(() => {
            const head = journal.head({workspaceId, datasetId:input.datasetId}, () => { authorize(); });
            if (!head.active || head.cursor.approvedRevisionHash !== checkRevision(input).revisionSha256) throw new Error("This Collection changed. Reload the Collection.");
            const stale = db.prepare("SELECT file_id, storage_bytes FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND attached_revision IS NULL AND expires_at_ms<=?").all(workspaceId, input.datasetId, now);
            for (const row of stale) { db.prepare("DELETE FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=? AND attached_revision IS NULL").run(workspaceId, input.datasetId, String(row.file_id)); charge(input.datasetId,-Number(row.storage_bytes)); }
            const key = JSON.stringify([workspaceId, input.datasetId, principal, parsed.idempotencyKey]);
            const existing = db.prepare("SELECT metadata FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND key=?").get(workspaceId, input.datasetId, key) as {metadata:string}|undefined;
            if (existing) {
              const file = parseAppBackendFile(JSON.parse(existing.metadata));
              if (file.sha256 !== sha256 || file.name !== parsed.name || file.contentType !== parsed.contentType) throw new Error("This retry key was already used for another upload.");
              authorize(); return {file, replayed:true};
            }
            const staged = Number(db.prepare("SELECT count(*) AS count FROM local_dataset_files WHERE workspace_id=? AND dataset_id=? AND attached_revision IS NULL").get(workspaceId, input.datasetId)!.count);
            if (staged >= APP_BACKEND_OPERATION_FILES) throw new Error("Attach or wait for existing uploads before uploading more files.");
            const file: AppBackendFile = {fileId: randomBytes(24).toString("base64url"), name: parsed.name, contentType: parsed.contentType, byteLength: bytes.byteLength, sha256};
            const metadata = JSON.stringify(file), storageBytes = bytes.byteLength + Buffer.byteLength(metadata) + Buffer.byteLength(key) + 384;
            db.prepare("INSERT INTO local_dataset_files VALUES(?,?,?,?,?,?,?,?,NULL,?)").run(workspaceId, input.datasetId, file.fileId, key, metadata, bytes, now, now + 86_400_000, storageBytes);
            charge(input.datasetId,storageBytes);
            authorize(); return {file, replayed:false};
          });
        });
      },
      file(input: LocalDatasetFileRequest) {
        return tracked(async () => {
          signal(input.signal).throwIfAborted(); checkRevision(input);
          return transaction(() => readFile(input,false));
        });
      },
      invoke: (input: LocalDatasetInvocation) => invoke(input),
      query: (input: LocalDatasetInvocation) => invoke(input, true),
      action: (input: LocalDatasetInvocation) => invoke(input, false),
      /** For main's automation executor only. Claims are this workspace's, from the host's ledger. */
      automations: {
        context(input: LocalDatasetAutomationContext): LocalDatasetAutomationContext {
          assertCurrent();
          const context = Object.freeze({ automationId: input.automationId, claimId: input.claimId, depth: input.depth, person: input.person, authorizeOperation: input.authorizeOperation });
          automationContexts.add(context);
          return context;
        },
        invoke(context: LocalDatasetAutomationContext, input: LocalDatasetInvocation): Promise<DatasetInvocationResult> {
          return tracked(async () => {
            checkInvocation(input);
            return host.invoke(context, { workspaceId, datasetId: input.datasetId, revision: input.revision, revisionSha256: input.revisionSha256,
              operationId: input.operationId, input: input.input, idempotencyKey: input.idempotencyKey, signal: signal(input.signal) });
          });
        },
        /**
         * Each approved, unarchived dataset's definition, and each dataset whose rules cannot be read.
         * A dataset moving or moved to a server is not here: the server runs its automations.
         */
        datasets(): { definitions: DatasetDefinition[]; failures: Array<{ datasetId: string; error: unknown }> } {
          assertCurrent();
          const definitions: DatasetDefinition[] = [], failures: Array<{ datasetId: string; error: unknown }> = [];
          // Each dataset's rules are read on their own, so one that cannot be read hides no other.
          for (const datasetId of host.datasetIds(owner, { workspaceId })) {
            if (transfers.status(datasetId) !== null) continue;
            try { definitions.push(host.approvedRevision(owner, { workspaceId, datasetId }).definition); }
            catch (error) { failures.push({ datasetId, error }); }
          }
          return { definitions, failures };
        },
        /** Invokes an operation as the owner, the person on this computer, as an Undo does. */
        invokeAsOwner: (input: LocalDatasetInvocation) => invoke(input),
        /** The dataset's current data grants: each principal and the operations it may use. */
        dataGrants(datasetId: string): { workspaceId: string; grants: Array<{ principalKey: string; operationIds: string[] }> } {
          assertCurrent();
          const grants: Array<{ principalKey: string; operationIds: string[] }> = [];
          for (let after: string | undefined; ;) {
            const page = host.permissions(owner, { workspaceId, datasetId, after, limit: 100 });
            for (const permission of page.permissions) {
              const operationIds = (permission.metadata as { operationIds?: unknown }).operationIds;
              if (permission.kind !== "data" || !permission.current || !Array.isArray(operationIds)) continue;
              grants.push({ principalKey: permission.principal, operationIds: operationIds.filter((value): value is string => typeof value === "string") });
            }
            if (page.nextCursor === null) return { workspaceId, grants };
            after = page.nextCursor;
          }
        },
        /** A dataset's approved revision now. */
        revision(datasetId: string): DatasetRevision { assertCurrent(); return host.approvedRevision(owner, { workspaceId, datasetId }); },
        /** Whether dohc generated the dataset's operations, the only ones automations can use at launch. */
        generated(datasetId: string): boolean {
          assertCurrent();
          const approved = host.approvedArtifacts(owner, { workspaceId, datasetId });
          return hasGeneratedDatasetOperations(approved.operationSource, approved.revision.definition);
        },
        /** Whether an invocation under a saved revision would still run under the rules approved now. */
        resolves(reference: { datasetId: string; revision: number; revisionSha256: string }): boolean {
          assertCurrent();
          try { resolveCompatibleDatasetRevision(db, { workspaceId, datasetId: reference.datasetId }, reference); return true; }
          catch (error) { if (error instanceof DatasetHostError) return false; throw error; }
        },
        subscribe(datasetId: string, subscription: DatasetAutomationSubscription) { assertCurrent(); host.automationClaims.subscribe({ workspaceId, datasetId }, subscription); },
        unsubscribe(datasetId: string, automationId: string) { assertCurrent(); host.automationClaims.unsubscribe({ workspaceId, datasetId }, automationId); },
        subscriptions() { assertCurrent(); return host.automationClaims.subscriptions(workspaceId); },
        next() { assertCurrent(); return host.automationClaims.next(workspaceId); },
        settle(started: Pick<DatasetAutomationClaim, "claimId" | "attempts">, outcome: Parameters<typeof host.automationClaims.settle>[1]) {
          assertCurrent(); return host.automationClaims.settle({ workspaceId, claimId: started.claimId, attempts: started.attempts }, outcome);
        },
        release(started: Pick<DatasetAutomationClaim, "claimId" | "attempts">) {
          assertCurrent(); host.automationClaims.release({ workspaceId, claimId: started.claimId, attempts: started.attempts });
        },
        retry(claimId: string) { assertCurrent(); return host.automationClaims.retry({ workspaceId, claimId }); },
        claims(automationId: string, page?: { before?: string; limit?: number }) { assertCurrent(); return host.automationClaims.claims(workspaceId, automationId, page); },
        pruneHistory(keep: readonly string[]) { assertCurrent(); return host.automationClaims.pruneHistory(workspaceId, keep); },
        claim(automationId: string, claimId: string) { assertCurrent(); return host.automationClaims.claim(workspaceId, automationId, claimId); },
        failures() { assertCurrent(); return host.automationClaims.failures(workspaceId); },
        /**
         * Claims a press by `pressedBy`, the account main pressed for. Every
         * person on this computer is the owner of its datasets, so the run
         * uses the owner's approved operations, which are theirs, through the
         * automation caller.
         */
        press(datasetId: string, input: Omit<DatasetPressInput, "presser"> & { pressedBy: string; by: AutomationPressActor }): DatasetPressed {
          assertCurrent();
          const { pressedBy, by, ...press } = input;
          // An agent's press carries its run's depth; the dataset has no agent origin to record.
          const agent = by.kind === "agent" ? { agent: { depth: by.depth } } : {};
          return host.automationClaims.press({ workspaceId, datasetId, ...press, presser: { kind: "owner", userId: pressedBy, ...agent } });
        },
        /** Throws why this host cannot take a press of this button, as `press` would. */
        assertPressable(datasetId: string, button: Pick<DatasetPressInput, "tableId" | "fieldId">) {
          assertCurrent(); host.automationClaims.assertPressable({ workspaceId, datasetId, ...button });
        },
        /** A press the ledger remembers, with its claim, or null. */
        pressed(pressId: string) { assertCurrent(); return host.automationClaims.pressed(workspaceId, pressId); },
      },
      close(): Promise<void> {
        return closePromise ??= (async () => {
          closed = true; pending.clear(); migrations.clear(); lifetime.abort();
          // Admitted Collection responses settle within their own deadline and still record their outcomes.
          await localApps.close();
          await Promise.allSettled([...active]);
          await recovery.close();
          try { await historyReader.close(); } finally {
            try { await supervisor!.close(); } finally { db.close(); }
          }
        })();
      },
    };
    appStore = createLocalAppStore({ db, sources: [localDatasetAppStorage(db), localCollectionAppStorage(db)], assertCurrent, transaction,
      charge: (kind, resourceId, bytes) => charge(kind === "dataset" ? resourceId : null, bytes) });
    const collections = createLocalCollectionApps({ db, store: appStore, workspaceId, assertCurrent, transaction: commit, charge: bytes => charge(null, bytes),
      engine() {
        if (!options.collectionEngine) throw new Error("Document Collection apps are unavailable here.");
        return options.collectionEngine();
      },
      author() {
        if (!options.collectionAuthor) throw new Error("Document Collection apps are unavailable here.");
        return options.collectionAuthor();
      } });
    apps = createLocalDatasetApps({ db, store: appStore, workspaceId, ownerId, assertCurrent, agentRun: () => options.agentRun?.() ?? null, localPersonId: () => options.localPersonId(),
      approved: datasetId => host.approvedArtifacts(owner, { workspaceId, datasetId }),
      bind: (datasetId, appId, binding, commit) => host.setBinding(owner, { workspaceId, datasetId, appId, binding }, commit),
      invoke: (context, input) => tracked(() => host.invoke(context, { ...input, signal: signal(input.signal) })),
      upload: (context, input) => local.upload(input, context),
      readFile: (context,input,fileId) => tracked(() => host.readOperation(context,{...input,signal:signal(input.signal)},result=>{
        if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 || result.fileId !== fileId) throw new Error("This action does not grant access to the file.");
        return readFile({...input,fileId},true);
      })),
      attempt(context, input, request) {
        const admitted = host.authorize(context, input);
        const authority = admitted.authority;
        if (admitted.operation.readOnly || !authority.appId) throw new Error("This action cannot keep a pending submission.");
        return attempts.request({ workspaceId, datasetId: input.datasetId, appId: authority.appId, principalKey: authority.principalKey,
          operationId: input.operationId, revisionSha256: input.revisionSha256 }, request, () => {
          const current = host.authorize(context, input);
          if (current.operation.readOnly || JSON.stringify(current.authority) !== JSON.stringify(authority)) throw new Error("This app approval changed. Prepare the app again.");
        });
      },
    });
    localApps = createLocalApps(appStore, apps, collections);
    return { ...local, apps: localApps };
  } catch (error) {
    closed = true; lifetime.abort();
    try { await historyReader.close(); } finally {
      try { await supervisor?.close(); } finally { db.close(); }
    }
    throw error;
  }
}
export type LocalDatasetHost = Awaited<ReturnType<typeof createLocalDatasetHost>>;

const STORE_TABLE = "CREATE TABLE IF NOT EXISTS local_dataset_store(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL) STRICT";
// A copy of the store that a move has not renamed into place yet.
const MOVING_FILE = `${STORE_FILE}.moving`;
const sqliteFiles = (path: string) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`] as const;

const statOrNull = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
  throw error;
});

// Each store file that exists is a plain file with one name.
async function assertStoreFiles(path: string): Promise<void> {
  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    const stat = await statOrNull(filePath);
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("Invalid Collection storage file.");
  }
}

// A Collection folder in `.dohc/local`, which only the engine's open
// prepares. It waits for an open already under way, never starts one, and
// refuses if the folder still isn't ready.
async function folderOnceOpened(localState: LocalStateWorkspace, folder: LocalDatasetFolder): Promise<string> {
  try { return await localDatasetFolder(localState, folder); }
  catch (error) {
    if (!(error instanceof LocalStateUnavailableError) || error.refusal !== "not-opened") throw error;
    await localStateOpened(localState);
    return await localDatasetFolder(localState, folder);
  }
}

// The folder of the store at `store`, such as OLD_STORE_PATH, once each
// folder on the way is a real folder inside the workspace, or null when one
// is not there. Creates nothing.
async function storeFolderOf(root: string, store: string): Promise<string | null> {
  let directory = root;
  for (const part of store.split("/").slice(0, -1)) {
    directory = join(directory, part);
    const stat = await statOrNull(directory);
    if (stat === null) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) throw new Error("Collection storage must remain inside this workspace.");
  }
  return directory;
}

// Runs `work` on the store in .dohc/local, or else on one not yet moved from
// .dohc/datasets, or on null when neither is there. Creates nothing. On
// Windows a store in .dohc/local is used only while the engine's open holds
// that folder, as every reader of it is: a folder that was missing when
// dohc looked has no open behind it, so a store there now is not used.
async function withStoreHere<T>(root: string, work: (path: string | null) => Promise<T>): Promise<T> {
  const inLocalState = async (): Promise<{ value: T } | null> => {
    const folder = await storeFolderOf(root, STORE_PATH), path = folder && join(folder, STORE_FILE);
    if (!path || !(await statOrNull(path))) return null;
    await assertStoreFiles(path);
    return { value: await work(path) };
  };
  const here = process.platform === "win32"
    ? await readOwnedLocalState(root, (dir) => dir === null ? Promise.resolve(null) : inLocalState())
    : await inLocalState();
  if (here) return here.value;
  const folder = await storeFolderOf(root, OLD_STORE_PATH), old = folder && join(folder, STORE_FILE);
  if (!old || !(await statOrNull(old))) return work(null);
  await assertStoreFiles(old);
  return work(old);
}

const sqlite = () => createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

// A read-only connection still reads the -wal, but never checkpoints into
// the store or removes its -wal and -shm when it closes. It may create the
// -shm index, and an empty -wal when there is none.
function openStore(path: string, readOnly = false): DatabaseSync {
  return new (sqlite().DatabaseSync)(path, { allowExtension: false, readOnly });
}

/** The id the store keeps for the record to name, or null when it keeps none. */
function storeIdOf(db: DatabaseSync): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_dataset_store'").get()) return null;
  const row = db.prepare("SELECT store_id FROM local_dataset_store WHERE singleton=1").get();
  return row ? String(row.store_id) : null;
}

const tableCount = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS count FROM sqlite_master").get()!.count);

// Writes a file's bytes, or a folder's entries, to disk. Windows opens no folder.
async function flush(path: string, folder = false): Promise<void> {
  if (folder && process.platform === "win32") return;
  const handle = await openFile(path, folder ? "r" : "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Copies the store the record names from .dohc/datasets, which iCloud Drive
 * syncs, to `path` in .dohc/local, which it skips. With Optimize Mac
 * Storage, iCloud Drive can keep a synced file's bytes only in iCloud, and
 * moving such a file out of the synced folder can lose them. So SQLite
 * reads the old store read-only, which downloads it, and its backup API
 * copies it page by page, -wal included, off the main thread. The copy is
 * reopened to check its id and flushed under another name. Before the
 * rename to `path`, and before each retry of it, `held` checks that the
 * record still names this installation and store, so `path` is either
 * missing or this store whole.
 * A crash before the rename leaves the old store, which the next open
 * copies again.
 */
async function copyOldStore(root: string, path: string, storeId: string, held: () => void): Promise<void> {
  const folder = await storeFolderOf(root, OLD_STORE_PATH), old = folder && join(folder, STORE_FILE);
  if (!old || !(await statOrNull(old))) throw new CollectionsRefusalError({ kind: "missing" });
  await assertStoreFiles(old);
  const copy = join(dirname(path), MOVING_FILE);
  try {
    const source = openStore(old, true);
    try {
      if (storeIdOf(source) !== storeId) throw new CollectionsRefusalError({ kind: "replaced", path: OLD_STORE_PATH });
      await sqlite().backup(source, copy);
    } finally { source.close(); }
    const db = openStore(copy);
    try { if (storeIdOf(db) !== storeId) throw new Error("The copy is not the store."); } finally { db.close(); }
    await flush(copy);
    held();
    await renameWithRetry(copy, path, {}, async () => held());
  } catch (error) {
    await Promise.all(sqliteFiles(copy).map(file => rm(file, { force: true }))).catch(() => undefined);
    if (error instanceof CollectionsRefusalError) throw error;
    throw new Error(`dohc could not copy this workspace's Collections to ${STORE_PATH}, so they stay in ${OLD_STORE_PATH}. Try again.`, { cause: error });
  }
  await flush(dirname(path), true);
}

/**
 * Once the store opened in .dohc/local, puts what is left in .dohc/datasets
 * in the system trash, where a person can still recover it: a store with
 * this store's id, then its -wal, -shm and -journal, and those files alone
 * once their store is gone. A store with another id may be another
 * computer's, so it stays. Before each file, `held` checks that the record
 * still names this installation and store, and its refusal stops the trash.
 * Any other failure leaves the files for the next open.
 */
async function trashOldStore(root: string, storeId: string, trashItem: ((path: string) => Promise<void>) | undefined, held: () => void): Promise<void> {
  if (!trashItem) return;
  try {
    const folder = await storeFolderOf(root, OLD_STORE_PATH);
    if (folder === null) return;
    const [store, ...sidecars] = sqliteFiles(join(folder, STORE_FILE));
    if (await statOrNull(store)) {
      await assertStoreFiles(store);
      const db = openStore(store, true);
      try { if (storeIdOf(db) !== storeId) return; } finally { db.close(); }
      held();
      await trashItem(store);
    }
    for (const file of sidecars) if (await statOrNull(file)) { held(); await trashItem(file); }
  } catch (error) {
    if (error instanceof CollectionsRefusalError) throw error;
    console.warn(`[desktop] dohc left the Collections store in ${OLD_STORE_PATH} and will try again at the next open:`, error);
  }
}

// Opens the store this installation keeps, or creates it, before anything
// else is made: another computer's Collections, a store that is not
// there, and a store the record does not name are refused. A new store is
// a file this call creates, never one that arrived meanwhile, even empty.
// It takes its id before the record names it. The store is in .dohc/local,
// so it waits for the engine's open to prepare that folder. A store the
// record names that is still in .dohc/datasets is copied here first, unless
// one is here already: that one wins, and a store with another id here is
// refused without touching either. The record can change while this waits
// for the engine or copies, so it is checked again before the copy takes
// the store's place and before the old store goes to the trash.
async function openHeldStore(root: string, localState: LocalStateWorkspace, holder: CollectionsHolderCheck, trashItem: ((path: string) => Promise<void>) | undefined): Promise<{ db: DatabaseSync; path: string }> {
  const { workspaceId } = localState;
  const admission: CollectionsAdmission = await admitCollectionsStore(root, workspaceId, holder);
  const path = join(await folderOnceOpened(localState, "store"), STORE_FILE);
  // The engine's open that prepared the store's folder. On Windows what dohc
  // opens there counts only while that open still holds the folder.
  const prepared = currentLocalStateOpen(localState);
  const held = createHoldingCheck(root, workspaceId, holder, () => admission.kind === "open" ? admission.storeId : null);
  if (admission.kind === "open") {
    // A copy a crash left before its rename.
    await Promise.all(sqliteFiles(join(dirname(path), MOVING_FILE)).map(file => rm(file, { force: true })));
    if (!(await statOrNull(path))) await copyOldStore(root, path, admission.storeId, held);
  }
  await assertStoreFiles(path);
  if (admission.kind === "create") {
    await writeFile(path, "", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "EEXIST" ? new CollectionsRefusalError({ kind: "unclaimed" }) : error;
    });
  }
  const db = openStore(path);
  try {
    // First, so a workspace that closed meanwhile is refused as not opened, not as replaced.
    if (process.platform === "win32" && !prepared?.current()) throw new LocalStateUnavailableError("not-opened");
    if (admission.kind === "open" && storeIdOf(db) !== admission.storeId) throw new CollectionsRefusalError({ kind: "replaced", path: STORE_PATH });
    if (admission.kind === "create") {
      if (tableCount(db) !== 0) throw new CollectionsRefusalError({ kind: "unclaimed" });
      db.exec(`BEGIN IMMEDIATE; ${STORE_TABLE};`);
      try { db.prepare("INSERT INTO local_dataset_store VALUES(1,?)").run(admission.storeId); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      await recordCollectionsStore(root, workspaceId, holder.here(), admission.storeId, admission.seen);
    }
    if (admission.kind === "open") { held(); await trashOldStore(root, admission.storeId, trashItem, held); }
    return { db, path };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The id the workspace's store keeps, or null when it keeps none or is not
 * there. A store not yet moved from .dohc/datasets counts. Creates no store.
 */
export async function localDatasetStoreId(workspaceRoot: string): Promise<string | null> {
  return withStoreHere(await realpath(workspaceRoot), async (path) => {
    if (path === null) return null;
    const db = openStore(path, true);
    try { return storeIdOf(db); } finally { db.close(); }
  });
}

/**
 * Writes `storeId` into the workspace's existing store, so a record can
 * name it: the one in .dohc/local, or else one not yet moved from
 * .dohc/datasets, which the holder moves when it next opens. Refuses a store
 * that belongs to another workspace, and never creates one.
 */
export async function adoptLocalDatasetStore(workspaceRoot: string, workspaceId: string, storeId: string): Promise<void> {
  const root = await realpath(workspaceRoot);
  await withStoreHere(root, async (path) => {
    if (path === null) throw new Error(`dohc could not find ${STORE_PATH}. Restore it from a backup, then try again.`);
    const db = openStore(path);
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      try {
        if (tableCount(db) === 0) {
          // A file with no store in it may be one still syncing from another
          // computer. In .dohc/local, it is one a creation cut short.
          throw new Error(path === join(root, ...STORE_PATH.split("/"))
            ? `${STORE_PATH} is empty. Delete it, then try again.`
            : `${OLD_STORE_PATH} is empty here, and may still be syncing from another computer. Try again once it has synced.`);
        }
        const identity = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_dataset_identity'").get()
          ? db.prepare("SELECT workspace_id FROM local_dataset_identity WHERE singleton=1").get() : undefined;
        if (identity && identity.workspace_id !== workspaceId) throw new Error("This Collection store belongs to another workspace.");
        db.exec(STORE_TABLE);
        db.prepare("INSERT OR REPLACE INTO local_dataset_store VALUES(1,?)").run(storeId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  });
}

/**
 * Whether the workspace already has its local store, in .dohc/local or not
 * yet moved from .dohc/datasets, so opening it moves it. Checking never
 * creates one.
 */
export async function localDatasetStoreExists(workspaceRoot: string): Promise<boolean> {
  const found = await Promise.all([STORE_PATH, OLD_STORE_PATH].map(path => lstat(join(workspaceRoot, path)).then(() => true, () => false)));
  return found.includes(true);
}
/** After attachment or engine reconnection, settles admitted Collection app responses in an existing store. */
export async function reconcileExistingLocalCollectionApps(workspaceRoot: string, open: () => Promise<Pick<LocalDatasetHost, "apps">>): Promise<void> {
  if (await localDatasetStoreExists(workspaceRoot)) (await open()).apps.reconcile();
}
