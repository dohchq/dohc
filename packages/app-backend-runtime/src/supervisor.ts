import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isAppBackendRuntimeError, approvedTables, boundedText, DEFAULT_LIMITS } from "./protocol.js";
import type { AppOperationFile, JsonValue } from "./protocol.js";
import type { DatasetCursor, DatasetJournal, DatasetScope, CommitOperationInput, TransitionCheckpointInput, CheckpointStage, CheckpointStageAllocation } from "./journal.js";
import { openPersistentAppBackend, type PersistentAppBackend, type PersistentRuntimeOptions } from "./persistent.js";
import { acquireSupervisorOwnership } from "./worker-ownership.js";

interface DatasetAccess {
  scope: DatasetScope;
  tables: string[];
  signal?: AbortSignal;
  authorize(): void;
}
export interface DatasetInvocation extends DatasetAccess {
  operation: string;
  caller: JsonValue;
  callerKey: string;
  input: JsonValue;
  idempotencyKey: string;
  payloadSha256: string;
  readOnly: boolean;
  files?: AppOperationFile[];
  /** Derived by the trusted host. Called again at commit and before disclosure. */
  authorize(): void;
  accountAndAttach?: CommitOperationInput["accountAndAttach"];
}
export interface DatasetMigration extends DatasetAccess {
  expected: DatasetCursor;
  newTables: string[];
  schemaSql: string;
  source: string;
  definitionJson: string;
  approvedRevisionHash: string;
  migrationSql: string;
  /** Current owner membership and immutable approval; the journal checks the old cursor. */
  authorize(): void;
  account?: TransitionCheckpointInput["account"];
  /** Reserve and release checkpoint staging bytes in the authoritative host transaction. */
  accountStage?: (allocation: Readonly<CheckpointStageAllocation>) => unknown;
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
type Job = { bytes: number; work(): Promise<unknown>; resolve(result: unknown): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout>; abort(): void; signal?: AbortSignal };
type Lane = { scope: DatasetScope; queue: Job[]; active: boolean; worker?: Worker; stopping?: Promise<void>; idle?: ReturnType<typeof setTimeout>; done?: Promise<void> };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function copyScope(value:DatasetScope):DatasetScope {
  if(!value||![value.workspaceId,value.datasetId].every(part=>typeof part==="string"&&/^[A-Za-z0-9._:-]{1,128}$/.test(part)))throw new Error("Invalid dataset scope.");
  return {workspaceId:value.workspaceId,datasetId:value.datasetId};
}
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
  const ownership=await acquireSupervisorOwnership(root);
  const lanes = new Map<string, Lane>();
  let closed = false, workerCount = 0, queuedCount = 0, queuedBytes = 0;
  const now = options.nowMs ?? Date.now;

  async function removeDirectory(path: string): Promise<void> {
    await ownership.removeDirectory(path);
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
  function standing(input: DatasetAccess): void {
    if (closed) throw new Error("Dataset host is closed.");
    input.signal?.throwIfAborted();
    const result: unknown = input.authorize();
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Dataset authority checks must be synchronous.");
  }
  function head(input: DatasetAccess) {
    return options.journal.head(input.scope, () => standing(input));
  }
  async function openWorker(lane: Lane, input: DatasetAccess): Promise<Worker> {
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
      const checkpoint = options.journal.captureExport({ scope: input.scope, authorize: () => standing(input), capture: () => null }).checkpoint;
      if (!sameAuthority(checkpoint.cursor, current.cursor)) throw new Error("Dataset checkpoint is invalid.");
      directory = await ownership.createDirectory();
      const checkpointPath = join(directory, "checkpoint.sqlite");
      const file=await open(checkpointPath,"wx",0o600),hash=createHash("sha256");
      try {
        for(let offset=0;offset<checkpoint.byteLength;) {
          const bytes=options.journal.exportBlob({scope:input.scope,record:checkpoint,offset,length:Math.min(1024*1024,checkpoint.byteLength-offset),authorize:()=>standing(input)});
          if(!bytes.byteLength||bytes.byteLength>Math.min(1024*1024,checkpoint.byteLength-offset))throw new Error("Dataset checkpoint range is invalid.");
          hash.update(bytes);
          for(let written=0;written<bytes.byteLength;) {
            const result=await file.write(bytes,written,bytes.byteLength-written,offset+written);
            if(!result.bytesWritten)throw new Error("Dataset checkpoint write made no progress.");
            written+=result.bytesWritten;
          }
          offset+=bytes.byteLength;
        }
        if(hash.digest("hex")!==checkpoint.sha256)throw new Error("Dataset checkpoint is invalid.");
      }finally{await file.close();}
      standing(input);
      const runtime = await openPersistentAppBackend({ directory, checkpointPath, schemaSql: current.schemaSql, tables: input.tables,
        ownership:{root:ownership.root,session:ownership.session},
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
  async function recover(lane: Lane, input: DatasetAccess): Promise<Worker> {
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
      if (isAppBackendRuntimeError(error)) {
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

  async function migrate(lane: Lane, input: DatasetMigration): Promise<DatasetCursor> {
    if(input.account&&!input.accountStage)throw new Error("Dataset migration requires checkpoint staging quota accounting.");
    const captured=head(input);
    if(!captured.active||!sameCursor(captured.cursor,input.expected))throw new Error("Dataset changed after the migration was approved. Preview it again.");
    let worker:Worker|undefined,stage:CheckpointStage|undefined;
    const abort=()=>{void worker?.runtime.abort("Dataset migration was cancelled.").catch(()=>{});};
    try {
      worker=await recover(lane,input);standing(input);
      input.signal?.addEventListener("abort",abort,{once:true});
      const path=join(worker.directory,`migration-${randomUUID()}.sqlite`);
      const migrated=await worker.runtime.migrateCheckpoint({path,schemaSql:input.schemaSql,tables:input.newTables,migrationSql:input.migrationSql});
      if(migrated.path!==path||migrated.cursor.revision!==captured.cursor.revision||migrated.cursor.digest!==captured.cursor.digest)throw new Error("Migration checkpoint differs from its source dataset.");
      const info=await lstat(path);
      if(!info.isFile()||info.size<100||info.size>captured.capacityBytes)throw new Error("Migration checkpoint exceeds its storage reservation.");
      const file=await open(path,"r");
      try {
        const hash=createHash("sha256"),buffer=Buffer.alloc(1024*1024);
        for(let offset=0;offset<info.size;) {
          standing(input);const read=await file.read(buffer,0,Math.min(buffer.byteLength,info.size-offset),offset);
          if(!read.bytesRead)throw new Error("Migration checkpoint is truncated.");
          hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;
        }
        stage=options.journal.stageCheckpoint({scope:input.scope,expectedBytes:info.size,sha256:hash.digest("hex"),authorize:()=>standing(input),account:input.accountStage});
        for(let index=0,offset=0;offset<info.size;index++) {
          const length=Math.min(buffer.byteLength,info.size-offset);let readBytes=0;
          while(readBytes<length) {
            standing(input);const read=await file.read(buffer,readBytes,length-readBytes,offset+readBytes);
            if(!read.bytesRead)throw new Error("Migration checkpoint is truncated.");readBytes+=read.bytesRead;
          }
          options.journal.appendCheckpointChunk({stage,index,bytes:buffer.subarray(0,length),authorize:()=>standing(input)});offset+=length;
        }
        stage=options.journal.sealCheckpoint({stage,authorize:()=>standing(input)});
      }finally{await file.close();}
      standing(input);
      const current=head(input);
      if(!current.active||!sameCursor(current.cursor,captured.cursor))throw new Error("Dataset changed during migration. Preview it again.");
      const committed=options.journal.transitionCheckpoint({expected:captured.cursor,hostEpoch:captured.cursor.hostEpoch,
        approvedRevisionHash:input.approvedRevisionHash,source:input.source,schemaSql:input.schemaSql,definitionJson:input.definitionJson,
        checkpoint:stage,capacityBytes:captured.capacityBytes,authorize:()=>standing(input),account:input.account});
      stage=undefined;
      await stopWorker(lane);
      const after=head(input);
      if(!after.active||!sameCursor(after.cursor,committed))throw new Error("Dataset approval changed after migration. Reload it.");
      return committed;
    } catch(error) {
      // An uncertain journal commit is resolved on the next recovery, never rerun here.
      if(stage) {
        // Revocation preserves the reservation for owner cleanup instead of bypassing authority.
        try{options.journal.discardCheckpoint({stage,authorize:()=>standing(input),account:input.accountStage});}catch{}
      }
      await stopWorker(lane);standing(input);throw error;
    } finally {input.signal?.removeEventListener("abort",abort);}
  }

  function enqueue<T>(input:DatasetAccess,bytes:number,work:(lane:Lane)=>Promise<T>):Promise<T> {
    standing(input);head(input);
    if (queuedCount >= 128 || queuedBytes + bytes > 16 * 1024 * 1024) throw new Error("Dataset host queue is full. Retry this operation.");
    const key=JSON.stringify(input.scope);
    let lane=lanes.get(key);
    if(!lane){lane={scope:input.scope,queue:[],active:false};lanes.set(key,lane);}
    if(lane.queue.length+Number(lane.active)>=64)throw new Error("Dataset operation queue is full. Retry this operation.");
    if(lane.idle){clearTimeout(lane.idle);lane.idle=undefined;}
    const target=lane;
    return new Promise<T>((resolve,reject)=>{
      const expire=()=>{
        const index=target.queue.indexOf(job);if(index<0)return;
        target.queue.splice(index,1);queuedCount--;queuedBytes-=job.bytes;
        clearTimeout(job.timeout);input.signal?.removeEventListener("abort",job.abort);
        reject(new Error("Dataset operation expired before execution."));
      };
      const job:Job={bytes,signal:input.signal,abort:expire,timeout:setTimeout(expire,queueMs),resolve:result=>resolve(result as T),reject,
        work:async()=>{standing(input);return work(target);}};
      input.signal?.addEventListener("abort",expire,{once:true});target.queue.push(job);queuedCount++;queuedBytes+=bytes;pump(target);
    });
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
        const input: DatasetInvocation = { ...raw, scope: copyScope(raw.scope), tables: approvedTables(raw.tables),
          caller: JSON.parse(callerJson), input: JSON.parse(inputJson), files: JSON.parse(filesJson) };
        boundedText(input.operation, 64, "Operation");
        boundedText(input.callerKey, 1024, "Caller key");
        boundedText(input.idempotencyKey, 128, "Retry key");
        return enqueue(input,bytes,lane=>execute(lane,input));
      } catch (error) { return Promise.reject(error); }
    },
    migrate(raw:DatasetMigration):Promise<DatasetCursor> {
      try {
        const input:DatasetMigration={...raw,scope:copyScope(raw.scope),expected:{...copyScope(raw.expected),hostEpoch:raw.expected.hostEpoch,
          approvedRevisionHash:raw.expected.approvedRevisionHash,revision:raw.expected.revision,digest:raw.expected.digest},tables:approvedTables(raw.tables),newTables:approvedTables(raw.newTables),
          source:boundedText(raw.source,DEFAULT_LIMITS.sourceBytes,"Dataset source"),schemaSql:boundedText(raw.schemaSql,DEFAULT_LIMITS.sourceBytes,"Dataset schema"),
          definitionJson:boundedText(raw.definitionJson,256*1024,"Dataset definition"),migrationSql:boundedText(raw.migrationSql,DEFAULT_LIMITS.sourceBytes,"Dataset migration")};
        if(!/^[a-f0-9]{64}$/.test(input.approvedRevisionHash)||input.expected.workspaceId!==input.scope.workspaceId||input.expected.datasetId!==input.scope.datasetId)throw new Error("Invalid migration authority.");
        JSON.parse(input.definitionJson);
        const bytes=Buffer.byteLength(JSON.stringify([input.scope,input.expected,input.tables,input.newTables,input.source,input.schemaSql,input.definitionJson,input.migrationSql]));
        return enqueue(input,bytes,lane=>migrate(lane,input));
      }catch(error){return Promise.reject(error);}
    },
    async close(): Promise<void> {
      closed = true;
      for (const lane of lanes.values()) {
        if (lane.idle) clearTimeout(lane.idle);
        if (lane.active && lane.worker) void lane.worker.runtime.abort("Dataset host closed.").catch(() => {});
        for (const job of lane.queue.splice(0)) { queuedCount--; queuedBytes -= job.bytes; clearTimeout(job.timeout); job.signal?.removeEventListener("abort", job.abort); job.reject(new Error("Dataset host closed.")); }
      }
      const results=await Promise.allSettled([...lanes.values()].map(async lane => { await lane.done; await stopWorker(lane); }));
      lanes.clear();ownership.close();
      const failed=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");
      if(failed)throw failed.reason;
    },
  };
}
