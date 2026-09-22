import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { AppBackendRuntimeError, approvedTables, boundedText, DEFAULT_LIMITS } from "./protocol.js";
import type { AppOperationFile, JsonValue } from "./protocol.js";
import type { DatasetCursor, DatasetJournal, DatasetScope, CommitOperationInput } from "./journal.js";
import { openPersistentAppBackend, type PersistentAppBackend, type PersistentRuntimeOptions } from "./persistent.js";

export interface DatasetInvocation {
  scope: DatasetScope;
  tables: string[];
  operation: string;
  caller: JsonValue;
  callerKey: string;
  input: JsonValue;
  idempotencyKey: string;
  payloadSha256: string;
  readOnly: boolean;
  files?: AppOperationFile[];
  signal?: AbortSignal;
  /** Derived by the trusted host. Called again at commit and before disclosure. */
  authorize(): void;
  accountAndAttach?: CommitOperationInput["accountAndAttach"];
}
export interface DatasetInvocationResult { result: JsonValue; revision: number; replayed: boolean }
export interface DatasetSupervisorOptions {
  journal: DatasetJournal;
  /** Private host-owned directory, never an app-supplied path. */
  directory: string;
  runtime?: PersistentRuntimeOptions;
  maxWorkers?: number;
  idleMs?: number;
  queueMs?: number;
  nowMs?: () => number;
}
type Worker = { runtime: PersistentAppBackend; directory: string; cursor: DatasetCursor; tables: string[] };
type Job = { bytes: number; work(): Promise<DatasetInvocationResult>; resolve(result: DatasetInvocationResult): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout>; abort(): void; signal?: AbortSignal };
type Lane = { scope: DatasetScope; queue: Job[]; active: boolean; worker?: Worker; stopping?: Promise<void>; idle?: ReturnType<typeof setTimeout>; done?: Promise<void> };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sameCursor = (left: DatasetCursor, right: DatasetCursor) => left.workspaceId === right.workspaceId && left.datasetId === right.datasetId &&
  left.hostEpoch === right.hostEpoch && left.approvedRevisionHash === right.approvedRevisionHash && left.revision === right.revision && left.digest === right.digest;
const sameAuthority = (left: DatasetCursor, right: DatasetCursor) => left.workspaceId === right.workspaceId && left.datasetId === right.datasetId &&
  left.hostEpoch === right.hostEpoch && left.approvedRevisionHash === right.approvedRevisionHash;

/** Coordinates one authority journal and recoverable workers. This is not a public request handler. */
export async function createDatasetSupervisor(options: DatasetSupervisorOptions) {
  const maxWorkers = options.maxWorkers ?? 4, idleMs = options.idleMs ?? 30_000, queueMs = options.queueMs ?? 30_000;
  for (const [value, max] of [[maxWorkers, 16], [idleMs, 300_000], [queueMs, 60_000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("Invalid dataset worker limit.");
  }
  await mkdir(options.directory, { recursive: true });
  const root = await realpath(options.directory);
  const lanes = new Map<string, Lane>();
  let closed = false, workerCount = 0, queuedCount = 0, queuedBytes = 0;
  const now = options.nowMs ?? Date.now;

  async function removeDirectory(path: string): Promise<void> {
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || rel.includes("/") || rel.includes("\\") || !rel.startsWith("worker-")) throw new Error("Invalid dataset worker cleanup path.");
    await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
  async function stopWorker(lane: Lane): Promise<void> {
    if (lane.stopping) return lane.stopping;
    const worker = lane.worker;
    if (!worker) return;
    lane.worker = undefined;
    lane.stopping = (async () => {
      try { await worker.runtime.close(); }
      finally { workerCount--; await removeDirectory(worker.directory); }
    })();
    try { await lane.stopping; } finally { lane.stopping = undefined; }
  }
  function standing(input: DatasetInvocation): void {
    if (closed) throw new Error("Dataset host is closed.");
    input.signal?.throwIfAborted();
    const result: unknown = input.authorize();
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Dataset authority checks must be synchronous.");
  }
  function head(input: DatasetInvocation) {
    return options.journal.head(input.scope, () => standing(input));
  }
  async function openWorker(lane: Lane, input: DatasetInvocation): Promise<Worker> {
    if (lane.stopping) await lane.stopping;
    while (workerCount >= maxWorkers) {
      const idle = [...lanes.values()].find(candidate => candidate !== lane && !candidate.active && candidate.worker);
      if (!idle) throw new Error("Dataset workers are busy. Retry this operation.");
      if (idle.idle) clearTimeout(idle.idle);
      await stopWorker(idle);
    }
    standing(input);
    // Reserve before asynchronous opening so different datasets cannot exceed the pool.
    workerCount++;
    let directory: string | undefined;
    try {
      const current = head(input);
      if (!current.active) throw new Error("Dataset authority was transferred.");
      const checkpoint = options.journal.checkpoint({ scope: input.scope, authorize: () => standing(input) });
      if (!sameAuthority(checkpoint.cursor, current.cursor) || digest(checkpoint.bytes) !== checkpoint.sha256) throw new Error("Dataset checkpoint is invalid.");
      directory = await mkdtemp(join(root, "worker-"));
      const checkpointPath = join(directory, "checkpoint.sqlite");
      await writeFile(checkpointPath, checkpoint.bytes, { flag: "wx", mode: 0o600 });
      standing(input);
      const runtime = await openPersistentAppBackend({ directory, checkpointPath, schemaSql: current.schemaSql, tables: input.tables,
        scope: { workspaceId: current.cursor.workspaceId, datasetId: current.cursor.datasetId, hostEpoch: current.cursor.hostEpoch,
          approvedRevisionHash: current.cursor.approvedRevisionHash }, cursor: { revision: checkpoint.cursor.revision, digest: checkpoint.cursor.digest },
        databaseBytes: current.capacityBytes }, options.runtime);
      const worker = { runtime, directory, cursor: checkpoint.cursor, tables: [...input.tables] };
      lane.worker = worker;
      return worker;
    } catch (error) {
      workerCount--;
      if (directory) await removeDirectory(directory);
      throw error;
    }
  }
  async function recover(lane: Lane, input: DatasetInvocation): Promise<Worker> {
    const current = head(input);
    if (!current.active) throw new Error("Dataset authority was transferred.");
    if (lane.worker && (!sameAuthority(lane.worker.cursor, current.cursor) || JSON.stringify(lane.worker.tables) !== JSON.stringify(input.tables))) await stopWorker(lane);
    const worker = lane.worker ?? await openWorker(lane, input);
    if (worker.cursor.revision > current.cursor.revision) throw new Error("Dataset materialization is ahead of its journal.");
    while (!sameCursor(worker.cursor, current.cursor)) {
      const page = options.journal.events({ scope: input.scope, after: worker.cursor, limit: 64, authorize: () => standing(input) });
      if (!page.events.length) throw new Error("Dataset recovery history is incomplete.");
      for (const event of page.events) {
        if (event.cursor.revision > current.cursor.revision) throw new Error("Dataset head changed during recovery.");
        await worker.runtime.apply({ ...event.cursor, previousDigest: event.previousDigest, changeset: event.changeset, changesetSha256: event.changesetSha256 });
        worker.cursor = event.cursor;
        standing(input);
      }
    }
    return worker;
  }
  async function execute(lane: Lane, input: DatasetInvocation): Promise<DatasetInvocationResult> {
    const captured = head(input);
    if (!captured.active) throw new Error("Dataset authority was transferred.");
    let worker: Worker | undefined;
    const abort = () => { void worker?.runtime.abort("Dataset operation was cancelled.").catch(() => {}); };
    const currentAuthority = () => {
      const current = head(input);
      if (!current.active || !sameAuthority(captured.cursor, current.cursor)) throw new Error("Dataset approval changed. Reload it before retrying.");
    };
    try {
      worker = await recover(lane, input);
      currentAuthority();
      input.signal?.addEventListener("abort", abort, { once: true });
      if (!input.readOnly) {
        const receipt = options.journal.receipt({ ...input, authorize: () => standing(input) });
        if (receipt) { currentAuthority(); return { result: JSON.parse(receipt.resultJson), revision: receipt.revision, replayed: true }; }
      }
      const prepared = await worker.runtime.prepare({ expected: worker.cursor, source: captured.source, operation: input.operation,
        caller: input.caller, input: input.input, nowMs: now(), requestId: randomUUID(), secret: randomBytes(32).toString("base64url"),
        files: input.files, readOnly: input.readOnly });
      currentAuthority();
      if (input.readOnly) {
        const after = head(input);
        if (!sameCursor(after.cursor, worker.cursor)) throw new Error("Dataset changed during the read. Retry it.");
        return { result: prepared.result, revision: worker.cursor.revision, replayed: false };
      }
      const resultJson = boundedText(JSON.stringify(prepared.result), DEFAULT_LIMITS.resultBytes, "Operation result");
      const committed = options.journal.commitOperation({ expected: worker.cursor, proposalId: prepared.proposalId, operation: input.operation,
        callerKey: input.callerKey, idempotencyKey: input.idempotencyKey, payloadSha256: input.payloadSha256, resultJson,
        changeset: prepared.changeset, changesetSha256: prepared.changesetSha256, attachedFileIds: prepared.attachedFileIds,
        authorize: () => standing(input), accountAndAttach: input.accountAndAttach });
      if (committed.kind === "replayed") {
        await worker.runtime.discard(prepared.proposalId);
        await recover(lane, input);
      } else {
        await worker.runtime.finalize({ proposalId: prepared.proposalId, previousDigest: committed.event.previousDigest,
          ...committed.event.cursor, changesetSha256: committed.event.changesetSha256 });
        worker.cursor = committed.event.cursor;
      }
      currentAuthority();
      return { result: JSON.parse(committed.receipt.resultJson), revision: committed.receipt.revision, replayed: committed.kind === "replayed" };
    } catch (error) {
      if (error instanceof AppBackendRuntimeError) {
        try { currentAuthority(); } catch (authorityError) { await stopWorker(lane); throw authorityError; }
        throw error;
      }
      // Closing rolls back any proposal. A durable host event remains and is replayed next time.
      await stopWorker(lane);
      currentAuthority();
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }

  function pump(lane: Lane): void {
    if (lane.active) return;
    const job = lane.queue.shift();
    if (!job) {
      if (lane.worker) {
        lane.idle = setTimeout(() => {
          lane.done = stopWorker(lane).finally(() => {
            const key = JSON.stringify(lane.scope);
            if (!lane.active && !lane.queue.length && !lane.worker && lanes.get(key) === lane) lanes.delete(key);
          });
          // close observes cleanup failures; timers must not reject without a handler.
          void lane.done.catch(() => {});
        }, idleMs);
        lane.idle.unref();
      } else if (!lane.stopping) lanes.delete(JSON.stringify(lane.scope));
      return;
    }
    clearTimeout(job.timeout);
    queuedCount--;
    queuedBytes -= job.bytes;
    job.signal?.removeEventListener("abort", job.abort);
    lane.active = true;
    lane.done = (async () => {
      try {
        const result = await job.work();
        lane.active = false;
        pump(lane);
        job.resolve(result);
      } catch (error) {
        lane.active = false;
        pump(lane);
        job.reject(error);
      }
    })();
  }
  return {
    invoke(raw: DatasetInvocation): Promise<DatasetInvocationResult> {
      try {
        if (raw.files && (!Array.isArray(raw.files) || raw.files.length > 32)) throw new Error("Too many files in dataset operation.");
        const filesJson = boundedText(JSON.stringify(raw.files ?? []), 32 * 1024, "Operation files");
        const callerJson = boundedText(JSON.stringify(raw.caller), DEFAULT_LIMITS.inputBytes, "Caller");
        const inputJson = boundedText(JSON.stringify(raw.input), DEFAULT_LIMITS.inputBytes, "Operation input");
        const bytes = Buffer.byteLength(filesJson) + Buffer.byteLength(callerJson) + Buffer.byteLength(inputJson);
        // Copy bounded request data before retaining anything in a queue.
        const input: DatasetInvocation = { ...raw, scope: { ...raw.scope }, tables: approvedTables(raw.tables),
          caller: JSON.parse(callerJson), input: JSON.parse(inputJson), files: JSON.parse(filesJson) };
        boundedText(input.operation, 64, "Operation");
        boundedText(input.callerKey, 1024, "Caller key");
        boundedText(input.idempotencyKey, 128, "Retry key");
        standing(input);
        head(input);
        if (queuedCount >= 128 || queuedBytes + bytes > 16 * 1024 * 1024) throw new Error("Dataset host queue is full. Retry this operation.");
        const key = JSON.stringify(input.scope);
        let lane = lanes.get(key);
        if (!lane) { lane = { scope: input.scope, queue: [], active: false }; lanes.set(key, lane); }
        if (lane.queue.length + Number(lane.active) >= 64) throw new Error("Dataset operation queue is full. Retry this operation.");
        if (lane.idle) { clearTimeout(lane.idle); lane.idle = undefined; }
        const target = lane;
        return new Promise((resolve, reject) => {
          const expire = () => {
            const index = target.queue.indexOf(job);
            if (index < 0) return;
            target.queue.splice(index, 1);
            queuedCount--;
            queuedBytes -= job.bytes;
            clearTimeout(job.timeout); input.signal?.removeEventListener("abort", job.abort);
            reject(new Error("Dataset operation expired before execution."));
          };
          const job: Job = { bytes, signal: input.signal, abort: expire, timeout: setTimeout(expire, queueMs), resolve, reject,
            work: async () => { standing(input); return execute(target, input); } };
          input.signal?.addEventListener("abort", expire, { once: true });
          target.queue.push(job);
          queuedCount++;
          queuedBytes += bytes;
          pump(target);
        });
      } catch (error) { return Promise.reject(error); }
    },
    async close(): Promise<void> {
      closed = true;
      for (const lane of lanes.values()) {
        if (lane.idle) clearTimeout(lane.idle);
        if (lane.active && lane.worker) void lane.worker.runtime.abort("Dataset host closed.").catch(() => {});
        for (const job of lane.queue.splice(0)) { queuedCount--; queuedBytes -= job.bytes; clearTimeout(job.timeout); job.signal?.removeEventListener("abort", job.abort); job.reject(new Error("Dataset host closed.")); }
      }
      await Promise.all([...lanes.values()].map(async lane => { await lane.done; await stopWorker(lane); }));
      lanes.clear();
    },
  };
}
