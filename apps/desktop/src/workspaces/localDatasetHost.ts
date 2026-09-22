import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { parseDatasetDefinition, type DatasetRevision } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { createDatasetHost, type DatasetHostOptions } from "@dohc/app-backend-runtime/dataset-host";
import { createDatasetJournal, type JournalDb } from "@dohc/app-backend-runtime/journal";
import { createDatasetSupervisor, type DatasetInvocationResult, type DatasetSupervisorOptions } from "@dohc/app-backend-runtime/supervisor";
import type { AppBackendRuntimeOptions, JsonValue } from "@dohc/app-backend-runtime";
import { compileClosedApp } from "./closedAppCompiler";

type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources">;
type OwnerContext = { readonly owner: true };
type Resources = Pick<DatasetHostOptions<OwnerContext>, "operationResources" | "accountCreation">;
export interface LocalDatasetHostOptions {
  workspaceId: string;
  workspaceRoot: string;
  /** The main process checks that this workspace session still belongs to the caller. */
  assertCurrent?(): void;
  runtime?: AppBackendRuntimeOptions;
  persistentRuntime?: DatasetSupervisorOptions["runtime"];
  maxWorkers?: number;
  /** Retained journal and checkpoint bytes plus reserved materialization capacity. */
  maxStoredBytes?: number;
  capacityBytes?: number;
  /** File associations must use this database and transaction, never a later write. */
  resources?(storage: { db: JournalDb; transaction: <T>(run: () => T) => T }): Resources;
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
  const root = await realpath(options.workspaceRoot);
  let directory = root;
  for (const part of [".dohc", "datasets"]) {
    directory = join(directory, part);
    await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) throw new Error("Collection storage must remain inside this workspace.");
  }
  const path = join(directory, "state.sqlite");
  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    const stat = await lstat(filePath).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("Invalid Collection storage file.");
  }
  const { DatabaseSync: Sqlite } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db: DatabaseSync = new Sqlite(path, { allowExtension: false });
  let closed = false, closePromise: Promise<void> | undefined;
  const lifetime = new AbortController(), active = new Set<Promise<unknown>>();
  const owner: OwnerContext = { owner: true };
  const workspaceId = options.workspaceId;
  const pending = new Map<string, { preparation: LocalDatasetPreparation; schemaSql: string; operationSource: string; expires: number }>();
  function assertCurrent() {
    if (closed) throw new Error("This Collection session ended. Reopen the workspace.");
    options.assertCurrent?.();
  }
  function signal(input?: AbortSignal) { assertCurrent(); return input ? AbortSignal.any([input, lifetime.signal]) : lifetime.signal; }
  function transaction<T>(work: () => T): T {
    assertCurrent(); db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  async function tracked<T>(work: () => Promise<T>): Promise<T> {
    assertCurrent(); const result = work(); active.add(result);
    try { return await result; } finally { active.delete(result); }
  }
  function charge(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid Collection storage allocation.");
    const changed = db.prepare("UPDATE local_dataset_budget SET bytes=bytes+? WHERE singleton=1 AND bytes+?<=?").run(bytes, bytes, maxStoredBytes);
    if (changed.changes !== 1) throw new Error("Collection storage is full. Export your data before continuing.");
  }
  let supervisor: Awaited<ReturnType<typeof createDatasetSupervisor>> | undefined;
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS local_dataset_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),workspace_id TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS local_dataset_budget(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL CHECK(bytes>=0)) STRICT;`);
    transaction(() => {
      db.prepare("INSERT OR IGNORE INTO local_dataset_identity VALUES(1,?)").run(workspaceId);
      if (db.prepare("SELECT workspace_id FROM local_dataset_identity WHERE singleton=1").get()!.workspace_id !== workspaceId) throw new Error("This Collection store belongs to another workspace.");
      db.prepare("INSERT OR IGNORE INTO local_dataset_budget VALUES(1,0)").run();
    });
    const journal = createDatasetJournal({ db, transaction });
    const workerDirectory = join(directory, "workers");
    await mkdir(workerDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const workerStat = await lstat(workerDirectory);
    if (!workerStat.isDirectory() || workerStat.isSymbolicLink() || resolve(await realpath(workerDirectory)) !== resolve(workerDirectory)) throw new Error("Invalid Collection worker directory.");
    supervisor = await createDatasetSupervisor({ journal, directory: workerDirectory, runtime: options.persistentRuntime, maxWorkers: options.maxWorkers });
    const resources = options.resources?.({ db, transaction });
    const host = createDatasetHost<OwnerContext>({ db, transaction, journal, supervisor, runtime: options.runtime,
      resolveAuthority(context, request) {
        assertCurrent();
        if (context !== owner || request.workspaceId !== workspaceId || request.access.kind !== "data") throw new Error("Collection access is not permitted.");
        return { caller: { kind: "owner", userId: `local:${workspaceId}` }, principalKey: `local:${workspaceId}` };
      },
      async compileOperations(source, sourcePath) {
        const bytes = Buffer.from(source);
        const built = await compileClosedApp({ entryPath: sourcePath, inputs: [{path: sourcePath, bytes, sha256: digest(bytes)}],
          packageMap: {}, bounds: {maxInputFiles: 1, maxInputBytes: artifactBytes, maxOutputBytes: artifactBytes} });
        assertCurrent(); lifetime.signal.throwIfAborted();
        if (built.files.length !== 1 || built.files[0]?.path !== "bundle.js") throw new Error("Collection actions must compile to one script.");
        return decode(built.files[0].bytes);
      },
      accountCreation(context, allocation) { charge(allocation.bytes); resources?.accountCreation?.(context, allocation); },
      operationResources(context, request) {
        const extra = resources?.operationResources?.(context, request);
        return { files: extra?.files, accountAndAttach(allocation) {
          if (allocation.attachedFileIds.length && !extra?.accountAndAttach) throw new Error("Collection attachments are unavailable.");
          charge(allocation.bytes); extra?.accountAndAttach?.(allocation);
        } };
      },
    });
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
    function checkInvocation(input: LocalDatasetInvocation, readOnly?: boolean) {
      assertCurrent();
      const description = host.describe(owner, {workspaceId, datasetId: input.datasetId});
      if (input.revision !== description.revision || input.revisionSha256 !== description.revisionSha256) throw new Error("Collection rules changed. Reload the Collection.");
      if (readOnly !== undefined && !description.operations.some(operation => operation.operationId === input.operationId && operation.readOnly === readOnly)) throw new Error("Choose an approved Collection action.");
    }
    function invoke(input: LocalDatasetInvocation, readOnly?: boolean): Promise<DatasetInvocationResult> {
      return tracked(async () => {
        checkInvocation(input, readOnly);
        return host.invoke(owner, {workspaceId, datasetId: input.datasetId, revision: input.revision, revisionSha256: input.revisionSha256, operationId: input.operationId, input: input.input,
          idempotencyKey: input.idempotencyKey, signal: signal(input.signal)});
      });
    }
    return {
      prepare,
      discard(preparationId: string) { assertCurrent(); pending.delete(preparationId); },
      approve(input: {preparationId: string; revisionSha256: string; signal?: AbortSignal}) {
        return tracked(async () => {
          const captured = pending.get(input.preparationId);
          if (!captured || captured.expires < Date.now() || captured.preparation.revision.revisionSha256 !== input.revisionSha256) throw new Error("This Collection approval expired or changed. Prepare it again.");
          const approved = await host.activate(owner, {workspaceId, revision: captured.preparation.revision, schemaSql: captured.schemaSql,
            operationSource: captured.operationSource, capacityBytes: options.capacityBytes, signal: signal(input.signal)});
          pending.delete(input.preparationId); return approved;
        });
      },
      list(input: {after?: string; limit?: number} = {}) { assertCurrent(); return host.list(owner, {workspaceId, ...input}); },
      describe(datasetId: string) { assertCurrent(); return host.describe(owner, {workspaceId, datasetId}); },
      approvedArtifacts(datasetId: string) { assertCurrent(); return host.approvedArtifacts(owner, {workspaceId, datasetId}); },
      invoke: (input: LocalDatasetInvocation) => invoke(input),
      query: (input: LocalDatasetInvocation) => invoke(input, true),
      action: (input: LocalDatasetInvocation) => invoke(input, false),
      close(): Promise<void> {
        return closePromise ??= (async () => {
          closed = true; pending.clear(); lifetime.abort();
          await Promise.allSettled([...active]);
          try { await supervisor!.close(); } finally { db.close(); }
        })();
      },
    };
  } catch (error) {
    closed = true; lifetime.abort();
    try { await supervisor?.close(); } finally { db.close(); }
    throw error;
  }
}
export type LocalDatasetHost = Awaited<ReturnType<typeof createLocalDatasetHost>>;
