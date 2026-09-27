import { parseDatasetRevision } from "@dohc/security-contract/dataset";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { APP_BACKEND_OPERATION_FILES } from "@dohc/security-contract/app-backend";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { isAppBackendRuntimeError, approvedTables, boundedText, DEFAULT_LIMITS } from "./protocol.js";
import type { AppOperationFile, JsonValue } from "./protocol.js";
import type { DatasetCursor, DatasetJournal, DatasetScope, CommitOperationInput, JournalCommit, TransitionCheckpointInput, CheckpointStage, CheckpointStageAllocation } from "./journal.js";
import { openPersistentAppBackend, PersistentRuntimeError, type PersistentAppBackend, type PersistentRuntimeOptions } from "./persistent.js";
import { acquireSupervisorOwnership } from "./worker-ownership.js";
import { readMigrationPreviewReportPage, type MigrationPreviewReportPage, type MigrationPreviewTableSummary } from "./migration-preview-report.js";
export type { MigrationPreviewValue, MigrationPreviewChange, MigrationPreviewTableSummary, MigrationPreviewReportPage } from "./migration-preview-report.js";

interface DatasetAccess {
  scope: DatasetScope;
  tables: string[];
  signal?: AbortSignal;
  authorize(): void;
}
export interface DatasetInvocation extends DatasetAccess {
  /** Recover the full host-approved schema, but grant the operation only tables. */
  restrictTables?: true;
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
  /** Runs inside the commit transaction. A receipt replay never reaches it. */
  recordCommit?: (commit: Readonly<DatasetCommit>) => unknown;
}
/** A committed change, with each approved table's columns in the order a changeset records them. */
export interface DatasetCommit extends JournalCommit { columns: Readonly<Record<string, readonly string[]>> }
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
export interface DatasetMigrationCandidate {
  candidateId: string;
  expected: DatasetCursor;
  approvedRevisionHash: string;
  checkpointSha256: string;
  expiresAtMs: number;
  preview: { tables: MigrationPreviewTableSummary[]; firstPage: MigrationPreviewReportPage };
}
export interface DatasetMigrationCandidateAccess extends DatasetAccess {
  candidateId: string;
  /** Fresh host-derived owner and lifecycle identity, never supplied by the browser. */
  authorityKey: string;
}
export interface DatasetMigrationApproval extends DatasetMigrationCandidateAccess {
  checkpointSha256: string;
  account?: TransitionCheckpointInput["account"];
  accountStage?: DatasetMigration["accountStage"];
}
type Candidate = {
  result: DatasetMigrationCandidate;
  authorityKey: string;
  directory: string;
  path: string;
  reportPath: string;
  capacityBytes: number;
  source: string;
  schemaSql: string;
  definitionJson: string;
  timer: ReturnType<typeof setTimeout>;
  committed?: DatasetCursor;
  busy?: boolean;
  reservations:CheckpointStage[];
  filesRemoved?:boolean;
};
export interface DatasetSupervisorOptions {
  journal: DatasetJournal;
  /** Private host-owned directory, never an app-supplied path. */
  directory: string;
  runtime?: PersistentRuntimeOptions;
  maxWorkers?: number;
  idleMs?: number;
  queueMs?: number;
  nowMs?: () => number;
  /** Maximum journal events between successful materialization caches. */
  materializationEvents?: number;
  /** A journal replay that takes at least this long is cached at once, so a later reopen does not repeat it. */
  replayCacheMs?: number;
  /**
   * Longest wait before reopening a dataset whose last reopen or replay ran out of time or CPU. The wait keeps one
   * app from holding shared workers with the same failing work. 0 turns it off, for a host that serves only its owner.
   */
  reopenWaitCapMs?: number;
  onMaintenanceError?: (scope: DatasetScope, error: unknown) => void;
  /** Host-lifetime maintenance authority and quota, independent of any request credential. */
  maintenanceStorage?: { authorize():void; account(allocation:Readonly<CheckpointStageAllocation>):unknown };
}
type Worker = { runtime: PersistentAppBackend; directory: string; cursor: DatasetCursor; tables: string[] };
type Job = { bytes: number; deadline: number; work(): Promise<unknown>; resolve(result: unknown): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout>; abort(): void; signal?: AbortSignal };
type Lane = { scope: DatasetScope; lifecycle: AbortController; admission?: {bytes:number;deadline:number}; idleWork?: Promise<void>; queue: Job[]; active: boolean; worker?: Worker; stopping?: Promise<void>; idle?: ReturnType<typeof setTimeout>; done?: Promise<void>; nextMaterializationRevision?: number;
  /** A cache that failed validation at reopen. It counts as no cache, so a replay replaces it. */
  rejectedCacheId?: string };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const REOPEN_WAIT_MS = 5_000;
/** A dataset whose reopen ran out of time or CPU refuses to reopen until its wait ends. */
export class DatasetReopenWaitError extends Error {
  readonly code = "dataset_reopen_wait";
  constructor(readonly retryAfterMs: number) {
    super(`dohc's work on this Collection stopped before it finished. Try again in ${Math.ceil(retryAfterMs / 1000)} s.`);
    this.name = "DatasetReopenWaitError";
  }
}
// A worker that ran out of CPU or time, stopped, could not save its replay, or could not be reopened.
const WORKER_FAILURES = new Set(["worker_budget", "worker_stalled", "worker_deadline", "worker_stopped", "replay_not_saved", "reopen_failed"]);
/**
 * A dataset worker failure the caller can retry. `retryAfterMs` is set when the failure made the dataset wait before it
 * reopens. Public package entrypoints can contain separate bundled copies of the error class.
 */
export function isDatasetWorkerFailure(error: unknown): error is Error & { code: string; retryAfterMs?: number } {
  const code = (error as {code?: unknown} | undefined)?.code, retryAfterMs = (error as {retryAfterMs?: unknown} | undefined)?.retryAfterMs;
  return error instanceof Error && error.name === "PersistentRuntimeError" && typeof code === "string" && WORKER_FAILURES.has(code) &&
    (retryAfterMs === undefined || (Number.isSafeInteger(retryAfterMs) && Number(retryAfterMs) > 0));
}
/** Public package entrypoints can contain separate bundled copies of the error class. */
export function isDatasetReopenWaitError(error: unknown): error is DatasetReopenWaitError {
  return error instanceof Error && error.name === "DatasetReopenWaitError" && (error as Partial<DatasetReopenWaitError>).code === "dataset_reopen_wait" &&
    Number.isSafeInteger((error as Partial<DatasetReopenWaitError>).retryAfterMs) && (error as DatasetReopenWaitError).retryAfterMs > 0;
}
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
  const materializationEvents = options.materializationEvents ?? 128, replayCacheMs = options.replayCacheMs ?? 1000;
  const reopenWaitCapMs = options.reopenWaitCapMs ?? 30 * 60_000;
  for (const [value, max] of [[maxWorkers, 16], [idleMs, 300_000], [queueMs, 60_000], [materializationEvents, 4096]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("Invalid dataset worker limit.");
  }
  if (!Number.isSafeInteger(replayCacheMs) || replayCacheMs < 0 || replayCacheMs > 60_000) throw new Error("Invalid dataset worker limit.");
  if (!Number.isSafeInteger(reopenWaitCapMs) || reopenWaitCapMs < 0 || reopenWaitCapMs > 24 * 60 * 60_000) throw new Error("Invalid dataset worker limit.");
  await mkdir(options.directory, { recursive: true });
  const root = await realpath(options.directory);
  const ownership=await acquireSupervisorOwnership(root);
  const lanes = new Map<string, Lane>();
  const blockedMaintenance = new Set<string>();
  const maintenanceWarnings = new Set<string>();
  const maintenance = new Map<string,{cancel:AbortController;done:Promise<void>}>();
  const candidates = new Map<string, Candidate>();
  const candidateCleanup = new Set<Promise<void>>();
  // A failed reopen or replay would repeat the same work, so each such failure
  // in a row doubles the wait before the next reopen. The count starts over
  // once the longest wait has passed since the last wait ended.
  const reopenWaits = new Map<string, { failures: number; untilMs: number }>();
  function reopenFailure(scope: DatasetScope, error: unknown): unknown {
    if (!reopenWaitCapMs) return error;
    const key = JSON.stringify(scope), previous = reopenWaits.get(key), at = now();
    const failures = previous && at - previous.untilMs < reopenWaitCapMs ? previous.failures + 1 : 1;
    // A storage or validation error can name host paths, so callers get a plain one.
    const failure = error instanceof PersistentRuntimeError && WORKER_FAILURES.has(error.code) ? error
      : Object.assign(new PersistentRuntimeError("reopen_failed", "dohc could not reopen this Collection. Try again."), { cause: error });
    failure.retryAfterMs = Math.min(REOPEN_WAIT_MS * 2 ** (failures - 1), reopenWaitCapMs);
    reopenWaits.set(key, { failures, untilMs: at + failure.retryAfterMs });
    return failure;
  }
  let preparingCandidates = 0;
  let closed = false, workerCount = 0, queuedCount = 0, queuedBytes = 0, capacityWaiters = 0, capacityWaitBytes = 0;
  const now = options.nowMs ?? Date.now;

  function reportMaintenanceError(scope:DatasetScope,error:unknown):void {
    const key=JSON.stringify(scope);
    if(maintenanceWarnings.has(key))return;
    maintenanceWarnings.add(key);
    try {options.onMaintenanceError?.({...scope},error);} catch { /* Diagnostics cannot change a committed response. */ }
  }
  async function maintainMaterialization(lane:Lane,afterCostlyReplay=false):Promise<void> {
    const storage=options.maintenanceStorage,worker=lane.worker;
    const key=JSON.stringify(lane.scope);
    if(!storage||!worker||closed)return;
    const notSaved=(cause?:unknown)=>Object.assign(new PersistentRuntimeError("replay_not_saved","dohc could not save this Collection's records. Try again."),{cause});
    if(afterCostlyReplay)await maintenance.get(key)?.done;
    if(maintenance.has(key)||maintenance.size>=maxWorkers||blockedMaintenance.has(key)){if(afterCostlyReplay)throw notSaved();return;}
    const expected={...worker.cursor},cancel=new AbortController();
    const reservations:CheckpointStage[]=[];
    let path:string|undefined,directory:string|undefined,captured=false,failure:unknown;
    let releaseCapture!:()=>void;
    const captureReady=new Promise<void>(resolve=>releaseCapture=resolve);
    const authorize=()=>{
      if(closed)throw new Error("dohc closed this workspace's Collections. Open the workspace again.");
      cancel.signal.throwIfAborted();lane.lifecycle.signal.throwIfAborted();
      storage.authorize();
    };
    const done=Promise.resolve().then(async()=>{
    try {
      authorize();
      const current=options.journal.head(lane.scope,storage.authorize);
      if(!current.active||!sameCursor(current.cursor,expected))throw new Error("The Collection changed while dohc saved its records.");
      const cached=options.journal.materialization({scope:lane.scope,authorize});
      const previous=cached&&cached.checkpointId!==lane.rejectedCacheId?cached:null;
      const after=previous?.cursor.revision??options.journal.captureExport({scope:lane.scope,authorize,capture:()=>null}).checkpoint.cursor.revision;
      if(expected.revision<=after||(!afterCostlyReplay&&expected.revision<Math.max(after+materializationEvents,lane.nextMaterializationRevision??0)))return;
      lane.nextMaterializationRevision=expected.revision+materializationEvents;
      // Account the physical snapshot before SQLite creates it, including its overlap with chunk staging.
      reservations.push(options.journal.stageCheckpoint({scope:lane.scope,expectedBytes:current.capacityBytes,
        sha256:digest(`materialization-reservation-${randomUUID()}`),authorize,account:storage.account}));
      directory=await ownership.createDirectory();authorize();
      path=join(directory,"materialization.sqlite");
      const snapshot=await worker.runtime.snapshot(path);
      if(snapshot.path!==path||snapshot.cursor.revision!==expected.revision||snapshot.cursor.digest!==expected.digest)throw new Error("The Collection changed while dohc saved its records.");
      const info=await lstat(path);
      if(!info.isFile()||info.isSymbolicLink()||info.size<100||info.size>current.capacityBytes)throw new Error("This Collection's records are larger than the space reserved for them.");
      // The immutable snapshot owns its cursor and directory. Later operations can use the worker.
      captured=true;releaseCapture();
      const file=await open(path,"r"),buffer=Buffer.alloc(1024*1024),hash=createHash("sha256");
      try {
        for(let offset=0;offset<info.size;) {
          authorize();const result=await file.read(buffer,0,Math.min(buffer.length,info.size-offset),offset);
          if(!result.bytesRead)throw new Error("dohc did not finish saving this Collection's records.");
          hash.update(buffer.subarray(0,result.bytesRead));offset+=result.bytesRead;
        }
        let stage=options.journal.stageCheckpoint({scope:lane.scope,expectedBytes:info.size,sha256:hash.digest("hex"),authorize,account:storage.account});
        reservations.push(stage);
        for(let index=0,offset=0;offset<info.size;index++) {
          const length=Math.min(buffer.length,info.size-offset);let bytesRead=0;
          while(bytesRead<length) {
            authorize();const result=await file.read(buffer,bytesRead,length-bytesRead,offset+bytesRead);
            if(!result.bytesRead)throw new Error("dohc did not finish saving this Collection's records.");bytesRead+=result.bytesRead;
          }
          options.journal.appendCheckpointChunk({stage,index,bytes:buffer.subarray(0,length),authorize});offset+=length;
        }
        stage=await options.journal.sealMaterializationCheckpoint({stage,authorize});
        options.journal.cacheMaterialization({expected,checkpoint:stage,authorize,account:allocation=>storage.account({
          scope:lane.scope,stage,bytes:allocation.bytes-allocation.stagedCreditBytes-allocation.releasedBytes})});
        maintenanceWarnings.delete(JSON.stringify(lane.scope));
        reservations.pop();
      } finally {await file.close();}
    } catch(error) {
      failure=error;
      if(!cancel.signal.aborted&&!closed)reportMaintenanceError(lane.scope,error);
      if(path&&!captured)try{await stopWorker(lane);}catch(stopError){reportMaintenanceError(lane.scope,stopError);}
    }
    finally {
      let removed=true;
      if(directory)try{await removeDirectory(directory);}catch(error){removed=false;blockedMaintenance.add(key);reportMaintenanceError(lane.scope,error);}
      // If a file cannot be removed, retain its reservation until exclusive startup reclaims both.
      for(let index=reservations.length-1;index>=0;index--) {
        if(index===0&&!removed)continue;
        try{options.journal.discardCheckpoint({stage:reservations[index]!,...storage});}
        catch(error){blockedMaintenance.add(JSON.stringify(lane.scope));reportMaintenanceError(lane.scope,error);}
      }
      maintenance.delete(key);releaseCapture();
    }
    });
    maintenance.set(key,{cancel,done});
    // Ordinary maintenance lets foreground work continue once its snapshot is
    // captured. A costly replay continues only once its cache is installed.
    if(!afterCostlyReplay){await captureReady;return;}
    await done;
    if(failure!==undefined)throw notSaved(failure);
  }
  async function cancelMaintenance(scope:DatasetScope):Promise<void> {
    const task=maintenance.get(JSON.stringify(scope));
    if(task){task.cancel.abort(new Error("dohc stopped saving this Collection's records."));await task.done;}
  }

  async function dropCandidate(candidate: Candidate) {
    if(candidates.get(candidate.result.candidateId)!==candidate)return;
    clearTimeout(candidate.timer);
    const removing=candidate.filesRemoved?Promise.resolve():removeDirectory(candidate.directory); candidateCleanup.add(removing);
    try {
      await removing;
      candidate.filesRemoved=true;
      if(options.maintenanceStorage)while(candidate.reservations.length) {
        try {options.journal.discardCheckpoint({stage:candidate.reservations[0]!,...options.maintenanceStorage});candidate.reservations.shift();}
        catch(error) {if(!closed)throw error;break;} // Closed authority leaves durable reservations for exclusive startup maintenance.
      }
      candidates.delete(candidate.result.candidateId);
    }finally{candidateCleanup.delete(removing);}
  }
  function expireCandidate(candidate:Candidate) {
    if(candidate.busy) {candidate.timer=setTimeout(()=>expireCandidate(candidate),1000);candidate.timer.unref();return;}
    void dropCandidate(candidate).catch(()=>{});
  }
  function findCandidate(input:DatasetMigrationCandidateAccess,checkHead=true):Candidate {
    standing(input);
    const candidate=candidates.get(input.candidateId);
    if(!candidate||candidate.authorityKey!==input.authorityKey||candidate.result.expected.workspaceId!==input.scope.workspaceId||candidate.result.expected.datasetId!==input.scope.datasetId)throw new Error("This preview is no longer available. Preview the change again.");
    if(checkHead&&candidate.result.expiresAtMs<=now())throw new Error("This preview expired. Preview the change again.");
    if(checkHead) {
      const current=head(input),expected=candidate.committed??candidate.result.expected;
      if(!current.active||!sameCursor(current.cursor,expected))throw new Error("The Collection changed after this preview. Preview the change again.");
    }
    return candidate;
  }

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
    if (closed) throw new Error("dohc closed this workspace's Collections. Open the workspace again.");
    input.signal?.throwIfAborted();
    const result: unknown = input.authorize();
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Dataset authority checks must be synchronous.");
  }
  function head(input: DatasetAccess) {
    return options.journal.head(input.scope, () => standing(input));
  }
  async function waitForCapacity(lane:Lane,input:DatasetAccess,pending:Promise<void>[]):Promise<void> {
    standing(input);lane.lifecycle.signal.throwIfAborted();
    const remaining=lane.admission!.deadline-performance.now();
    if(remaining<=0)throw new Error("This Collection stayed busy too long, so dohc stopped waiting. Try again.");
    let timer:ReturnType<typeof setTimeout>|undefined;
    let abort:()=>void=()=>{};
    try {
      await new Promise<void>((resolve,reject)=>{
        abort=()=>reject(input.signal?.aborted ? input.signal.reason : lane.lifecycle.signal.reason);
        input.signal?.addEventListener("abort",abort,{once:true});
        lane.lifecycle.signal.addEventListener("abort",abort,{once:true});
        if(input.signal?.aborted||lane.lifecycle.signal.aborted)abort();
        timer=setTimeout(()=>reject(new Error("This Collection stayed busy too long, so dohc stopped waiting. Try again.")),remaining);
        // A different dataset's cleanup error does not determine this request's authority.
        Promise.race(pending.map(promise=>promise.catch(()=>{}))).then(resolve);
      });
    } finally {
      if(timer)clearTimeout(timer);
      input.signal?.removeEventListener("abort",abort);
      lane.lifecycle.signal.removeEventListener("abort",abort);
    }
    standing(input);lane.lifecycle.signal.throwIfAborted();
    if(performance.now()>=lane.admission!.deadline)throw new Error("This Collection stayed busy too long, so dohc stopped waiting. Try again.");
    if(!head(input).active)throw new Error("This host stopped accepting changes to this Collection. Its owner can publish its app again to finish moving it, or finish restoring it from its recovery file.");
  }
  async function openWorker(lane: Lane, input: DatasetAccess, reopen: { admitted: boolean }): Promise<Worker> {
    const wait=reopenWaits.get(JSON.stringify(lane.scope));
    if(wait&&now()<wait.untilMs)throw new DatasetReopenWaitError(wait.untilMs-now());
    let waiting=false;
    const admitWait=()=>{
      if(waiting)return;
      const bytes=lane.admission!.bytes;
      if(queuedCount+capacityWaiters>=128||queuedBytes+capacityWaitBytes+bytes>16*1024*1024)throw new Error("dohc has too much Collection work waiting. Try again in a moment.");
      waiting=true;capacityWaiters++;capacityWaitBytes+=bytes;
    };
    try {
      if(lane.stopping){admitWait();await waitForCapacity(lane,input,[lane.stopping]);}
      while(workerCount>=maxWorkers) {
        standing(input);lane.lifecycle.signal.throwIfAborted();
        const idle=[...lanes.values()].find(candidate=>candidate!==lane&&!candidate.active&&candidate.worker);
        if(idle) {
          admitWait();if(idle.idle)clearTimeout(idle.idle);
          await waitForCapacity(lane,input,[stopWorker(idle)]);
        } else {
          const pending=[...lanes.values()].filter(candidate=>candidate!==lane)
            .flatMap(candidate=>candidate.idleWork?[candidate.idleWork]:candidate.stopping?[candidate.stopping]:[]);
          if(!pending.length)throw new Error("dohc is busy with other Collections. Try again in a moment.");
          admitWait();await waitForCapacity(lane,input,pending);
        }
      }
      standing(input);lane.lifecycle.signal.throwIfAborted();
      if(!head(input).active)throw new Error("This host stopped accepting changes to this Collection. Its owner can publish its app again to finish moving it, or finish restoring it from its recovery file.");
      // Reserve before asynchronous opening so different datasets cannot exceed the pool.
      workerCount++;reopen.admitted=true;
    } finally {
      if(waiting){capacityWaiters--;capacityWaitBytes-=lane.admission!.bytes;}
    }
    let directory: string | undefined;
    // A cancelled request, retirement, or host close stops a worker that is still starting.
    const signal=input.signal ? AbortSignal.any([input.signal,lane.lifecycle.signal]) : lane.lifecycle.signal;
    try {
      const current = head(input);
      if (!current.active) throw new Error("This host stopped accepting changes to this Collection. Its owner can publish its app again to finish moving it, or finish restoring it from its recovery file.");
      const canonical = options.journal.captureExport({ scope: input.scope, authorize: () => standing(input), capture: () => null }).checkpoint;
      if (!sameAuthority(canonical.cursor, current.cursor)) throw new Error("This Collection's saved records are damaged.");
      const cache = options.journal.materialization({scope: input.scope, authorize: () => standing(input)});
      async function restore(useCache: boolean): Promise<Worker> {
        const checkpoint = useCache ? cache! : canonical;
        directory = await ownership.createDirectory();
        const checkpointPath = join(directory, "checkpoint.sqlite");
        const file=await open(checkpointPath,"wx",0o600),hash=createHash("sha256");
        try {
          for(let offset=0;offset<checkpoint.byteLength;) {
            const range={scope:input.scope,offset,length:Math.min(1024*1024,checkpoint.byteLength-offset),authorize:()=>standing(input)};
            const bytes=useCache ? options.journal.materializationBlob({...range,cache:cache!}) : options.journal.exportBlob({...range,record:canonical});
            if(!bytes?.byteLength||bytes.byteLength>range.length)throw new Error("Invalid range in the Collection's saved records.");
            hash.update(bytes);
            for(let written=0;written<bytes.byteLength;) {
              const result=await file.write(bytes,written,bytes.byteLength-written,offset+written);
              if(!result.bytesWritten)throw new Error("dohc could not write this Collection's saved records. Try again.");
              written+=result.bytesWritten;
            }
            offset+=bytes.byteLength;
          }
          if(hash.digest("hex")!==checkpoint.sha256)throw new Error("This Collection's saved records are damaged.");
        }finally{await file.close();}
        standing(input);
        const runtime = await openPersistentAppBackend({ directory, checkpointPath, requireCheckpointCursor:useCache, schemaSql: current.schemaSql, tables: input.tables,
          ownership:{root:ownership.root,session:ownership.session},
          scope: { workspaceId: current.cursor.workspaceId, datasetId: current.cursor.datasetId, hostEpoch: current.cursor.hostEpoch,
            approvedRevisionHash: current.cursor.approvedRevisionHash }, cursor: { revision: checkpoint.cursor.revision, digest: checkpoint.cursor.digest },
          databaseBytes: current.capacityBytes, signal }, options.runtime);
        return { runtime, directory, cursor: checkpoint.cursor, tables: [...input.tables] };
      }
      let worker:Worker;
      if(cache) {
        try {worker=await restore(true);}
        catch(error) {
          const after=head(input);
          if(signal.aborted||!after.active||!sameCursor(after.cursor,current.cursor))throw error;
          if(directory)await removeDirectory(directory);
          directory=undefined;
          reportMaintenanceError(input.scope,error);
          lane.rejectedCacheId=cache.checkpointId;
          worker=await restore(false);
        }
      } else worker=await restore(false);
      lane.nextMaterializationRevision=worker.cursor.revision+materializationEvents;
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
    if (!current.active) throw new Error("This host stopped accepting changes to this Collection. Its owner can publish its app again to finish moving it, or finish restoring it from its recovery file.");
    if (lane.worker && (!sameAuthority(lane.worker.cursor, current.cursor) || JSON.stringify(lane.worker.tables) !== JSON.stringify(input.tables))) await stopWorker(lane);
    // Waiting for a worker slot is admission, not reopening, so it earns no wait.
    const reopen = { admitted: Boolean(lane.worker) };
    try {
      const worker = await reopenAndReplay(lane, input, current.cursor, reopen);
      reopenWaits.delete(JSON.stringify(lane.scope));
      return worker;
    } catch (error) {
      if (!reopen.admitted || !reopenFailed(lane, input, current.cursor)) throw error;
      throw reopenFailure(lane.scope, error);
    }
  }
  // Whether a reopen or replay failed on its own work, such as its worker,
  // storage, or checkpoint, rather than because the caller lost access, the
  // request was cancelled, or the dataset changed under it.
  function reopenFailed(lane: Lane, input: DatasetAccess, target: DatasetCursor): boolean {
    if (lane.lifecycle.signal.aborted) return false;
    try { standing(input); const current = head(input); return current.active && sameCursor(current.cursor, target); }
    catch { return false; }
  }
  async function reopenAndReplay(lane: Lane, input: DatasetAccess, target: DatasetCursor, reopen: { admitted: boolean }): Promise<Worker> {
    const worker = lane.worker ?? await openWorker(lane, input, reopen);
    if (worker.cursor.revision > target.revision) throw new Error("This Collection's saved records are newer than its history.");
    const replayStart = performance.now();
    let replayed = false;
    while (!sameCursor(worker.cursor, target)) {
      const page = options.journal.events({ scope: input.scope, after: worker.cursor, limit: 64, authorize: () => standing(input) });
      if (!page.events.length) throw new Error("This Collection's history is incomplete.");
      for (const event of page.events) {
        if (event.cursor.revision > target.revision) throw new Error("The Collection changed while dohc reopened it. Try again.");
      }
      await worker.runtime.applyBatch(page.events.map(event=>({...event.cursor,previousDigest:event.previousDigest,changeset:event.changeset,changesetSha256:event.changesetSha256})));
      worker.cursor=page.events.at(-1)!.cursor;
      standing(input);
      replayed = true;
    }
    // An app's events can make every replay rebuild the whole dataset. Cache a
    // costly replay now, before this job can fail and stop the worker, so no
    // later reopen repeats it.
    if (replayed && performance.now() - replayStart >= replayCacheMs) {
      await maintainMaterialization(lane, true);
    }
    return worker;
  }
  async function execute(lane: Lane, input: DatasetInvocation): Promise<DatasetInvocationResult> {
    const captured = head(input);
    if (!captured.active) throw new Error("This host stopped accepting changes to this Collection. Its owner can publish its app again to finish moving it, or finish restoring it from its recovery file.");
    let worker: Worker | undefined;
    const abort = () => { void worker?.runtime.abort("The Collection action stopped before it finished.").catch(() => {}); };
    const currentAuthority = () => {
      const current = head(input);
      if (!current.active || !sameAuthority(captured.cursor, current.cursor)) throw new Error("The Collection's rules changed. Reload the Collection. Then try again.");
    };
    try {
      worker = await recover(lane, input.restrictTables ? { ...input, tables: parseDatasetRevision(JSON.parse(captured.definitionJson)).definition.tables.map(table => table.sqlName) } : input);
      currentAuthority();
      input.signal?.addEventListener("abort", abort, { once: true });
      if (!input.readOnly) {
        const receipt = options.journal.receipt({ ...input, authorize: () => standing(input) });
        if (receipt) { currentAuthority(); return { result: JSON.parse(receipt.resultJson), revision: receipt.revision, replayed: true }; }
      }
      const prepared = await worker.runtime.prepare({ expected: worker.cursor, source: captured.source, operation: input.operation,
        caller: input.caller, input: input.input, nowMs: now(), requestId: randomUUID(), secret: randomBytes(32).toString("base64url"),
        files: input.files, readOnly: input.readOnly, tables: input.tables });
      currentAuthority();
      if (input.readOnly) {
        const after = head(input);
        if (!sameCursor(after.cursor, worker.cursor)) throw new Error("The Collection changed while dohc read it. Try again.");
        return { result: prepared.result, revision: worker.cursor.revision, replayed: false };
      }
      const resultJson = boundedText(JSON.stringify(prepared.result), DEFAULT_LIMITS.resultBytes, "Operation result");
      const committed = options.journal.commitOperation({ expected: worker.cursor, proposalId: prepared.proposalId, operation: input.operation,
        callerKey: input.callerKey, idempotencyKey: input.idempotencyKey, payloadSha256: input.payloadSha256, resultJson,
        changeset: prepared.changeset, changesetSha256: prepared.changesetSha256, attachedFileIds: prepared.attachedFileIds,
        authorize: () => standing(input), accountAndAttach: input.accountAndAttach,
        recordCommit: input.recordCommit && (commit => input.recordCommit!({ ...commit, columns: prepared.columns })) });
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
        try { currentAuthority(); } catch (authorityError) { if(lane.worker)await stopWorker(lane); throw authorityError; }
        throw error;
      }
      // Closing rolls back any proposal. A durable host event remains and is replayed next time.
      if(lane.worker)await stopWorker(lane);
      currentAuthority();
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }

  async function prepareMigration(lane:Lane,input:DatasetMigration & {authorityKey:string}):Promise<DatasetMigrationCandidate> {
    for(const previous of candidates.values())if(previous.result.expected.workspaceId===input.scope.workspaceId&&previous.result.expected.datasetId===input.scope.datasetId)await dropCandidate(previous);
    if(candidates.size+preparingCandidates>=4)throw new Error("Too many Collection changes are waiting for review. Discard one. Then try again.");
    if([...candidates.values()].some(candidate=>candidate.result.expected.workspaceId===input.scope.workspaceId&&candidate.result.expected.datasetId===input.scope.datasetId))throw new Error("This Collection already has a change waiting for review. Discard it first.");
    const captured=head(input);
    if(!captured.active||!sameCursor(captured.cursor,input.expected))throw new Error("The Collection changed before this preview. Preview the change again.");
    preparingCandidates++;
    let worker:Worker|undefined,directory:string|undefined;
    const reservations:CheckpointStage[]=[];
    const abort=()=>{void worker?.runtime.abort("This preview stopped before it finished.").catch(()=>{});};
    try {
      if(input.accountStage&&!options.maintenanceStorage)throw new Error("Migration previews require host-lifetime storage accounting.");
      if(options.maintenanceStorage)for(let index=0;index<2;index++)reservations.push(options.journal.stageCheckpoint({scope:input.scope,expectedBytes:captured.capacityBytes,
        sha256:digest(`migration-preview-reservation-${randomUUID()}`),authorize:()=>standing(input),account:options.maintenanceStorage.account}));
      worker=await recover(lane,input);standing(input);
      input.signal?.addEventListener("abort",abort,{once:true});
      directory=await ownership.createDirectory();
      const path=join(directory,"candidate.sqlite"),reportPath=join(directory,"report.jsonl");
      const migrated=await worker.runtime.migrateCheckpoint({path,reportPath,schemaSql:input.schemaSql,tables:input.newTables,migrationSql:input.migrationSql});
      if(migrated.path!==path||!migrated.report||migrated.cursor.revision!==captured.cursor.revision||migrated.cursor.digest!==captured.cursor.digest)throw new Error("This preview does not match the Collection. Preview the change again.");
      const info=await lstat(path),reportInfo=await lstat(reportPath);
      if(!info.isFile()||info.isSymbolicLink()||info.size<100||info.size>captured.capacityBytes||!reportInfo.isFile()||reportInfo.isSymbolicLink()||reportInfo.size!==migrated.report.bytes||reportInfo.size>captured.capacityBytes)throw new Error("This preview needs more space than the Collection has reserved.");
      const hash=createHash("sha256"),file=await open(path,"r"),buffer=Buffer.alloc(1024*1024);
      try {for(let offset=0;offset<info.size;) {standing(input);const result=await file.read(buffer,0,Math.min(buffer.length,info.size-offset),offset);if(!result.bytesRead)throw new Error("dohc did not finish this preview. Preview the change again.");hash.update(buffer.subarray(0,result.bytesRead));offset+=result.bytesRead;}}finally{await file.close();}
      standing(input);if(!sameCursor(head(input).cursor,captured.cursor))throw new Error("The Collection changed during this preview. Preview the change again.");
      const result:DatasetMigrationCandidate={candidateId:randomUUID(),expected:{...captured.cursor},approvedRevisionHash:input.approvedRevisionHash,
        checkpointSha256:hash.digest("hex"),expiresAtMs:now()+10*60_000,preview:{tables:migrated.report.tables,firstPage:readMigrationPreviewReportPage({path:reportPath,limit:100})}};
      const candidate:Candidate={result,authorityKey:input.authorityKey,directory,path,reportPath,capacityBytes:captured.capacityBytes,source:input.source,schemaSql:input.schemaSql,definitionJson:input.definitionJson,timer:undefined!,reservations:[...reservations]};
      candidate.timer=setTimeout(()=>expireCandidate(candidate),10*60_000);candidate.timer.unref();candidates.set(result.candidateId,candidate);directory=undefined;
      reservations.length=0;return structuredClone(result);
    }catch(error){if(lane.worker)await stopWorker(lane);standing(input);throw error;}
    finally{
      preparingCandidates--;input.signal?.removeEventListener("abort",abort);if(directory)await removeDirectory(directory);
      if(options.maintenanceStorage)for(const stage of reservations)try{options.journal.discardCheckpoint({stage,...options.maintenanceStorage});}catch{}
    }
  }

  async function approveMigration(lane:Lane,input:DatasetMigrationApproval):Promise<DatasetCursor> {
    const candidate=findCandidate(input);
    if(candidate.result.checkpointSha256!==input.checkpointSha256)throw new Error("This preview changed. Preview the change again.");
    if(candidate.committed)return {...candidate.committed};
    candidate.busy=true;
    try {
      const result=await migrate(lane,{...input,expected:candidate.result.expected,newTables:input.tables,source:candidate.source,schemaSql:candidate.schemaSql,
        definitionJson:candidate.definitionJson,approvedRevisionHash:candidate.result.approvedRevisionHash,migrationSql:""},candidate.path,candidate.result.checkpointSha256);
      candidate.committed=result;await dropCandidate(candidate);return {...result};
    }finally{candidate.busy=false;}
  }

  async function migrate(lane: Lane, input: DatasetMigration, candidatePath?:string, checkpointSha256?:string): Promise<DatasetCursor> {
    await cancelMaintenance(lane.scope);
    if(input.account&&!input.accountStage)throw new Error("Dataset migration requires checkpoint staging quota accounting.");
    const captured=head(input);
    if(!captured.active||!sameCursor(captured.cursor,input.expected))throw new Error("The Collection changed after you approved this change. Preview it again.");
    let worker:Worker|undefined,stage:CheckpointStage|undefined;
    const abort=()=>{void worker?.runtime.abort("This Collection change stopped before it finished.").catch(()=>{});};
    try {
      let path=candidatePath;
      if(!path) {
        worker=await recover(lane,input);standing(input);
        input.signal?.addEventListener("abort",abort,{once:true});
        path=join(worker.directory,`migration-${randomUUID()}.sqlite`);
        const migrated=await worker.runtime.migrateCheckpoint({path,schemaSql:input.schemaSql,tables:input.newTables,migrationSql:input.migrationSql});
        if(migrated.path!==path||migrated.cursor.revision!==captured.cursor.revision||migrated.cursor.digest!==captured.cursor.digest)throw new Error("The changed records do not match the Collection. Preview the change again.");
      }
      const info=await lstat(path);
      if(!info.isFile()||info.size<100||info.size>captured.capacityBytes)throw new Error("This change needs more space than the Collection has reserved.");
      const file=await open(path,"r");
      try {
        const hash=createHash("sha256"),buffer=Buffer.alloc(1024*1024);
        for(let offset=0;offset<info.size;) {
          standing(input);const read=await file.read(buffer,0,Math.min(buffer.byteLength,info.size-offset),offset);
          if(!read.bytesRead)throw new Error("dohc did not finish saving the changed records. Preview the change again.");
          hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;
        }
        const sha256=hash.digest("hex");
        if(checkpointSha256&&sha256!==checkpointSha256)throw new Error("This preview changed. Preview the change again.");
        stage=options.journal.stageCheckpoint({scope:input.scope,expectedBytes:info.size,sha256,authorize:()=>standing(input),account:input.accountStage});
        for(let index=0,offset=0;offset<info.size;index++) {
          const length=Math.min(buffer.byteLength,info.size-offset);let readBytes=0;
          while(readBytes<length) {
            standing(input);const read=await file.read(buffer,readBytes,length-readBytes,offset+readBytes);
            if(!read.bytesRead)throw new Error("dohc did not finish saving the changed records. Preview the change again.");readBytes+=read.bytesRead;
          }
          options.journal.appendCheckpointChunk({stage,index,bytes:buffer.subarray(0,length),authorize:()=>standing(input)});offset+=length;
        }
        stage=options.journal.sealCheckpoint({stage,authorize:()=>standing(input)});
      }finally{await file.close();}
      standing(input);
      const current=head(input);
      if(!current.active||!sameCursor(current.cursor,captured.cursor))throw new Error("The Collection changed while dohc applied this change. Preview it again.");
      const committed=options.journal.transitionCheckpoint({expected:captured.cursor,hostEpoch:captured.cursor.hostEpoch,
        approvedRevisionHash:input.approvedRevisionHash,source:input.source,schemaSql:input.schemaSql,definitionJson:input.definitionJson,
        checkpoint:stage,capacityBytes:captured.capacityBytes,authorize:()=>standing(input),account:input.account});
      stage=undefined;
      await stopWorker(lane);
      const after=head(input);
      if(!after.active||!sameCursor(after.cursor,committed))throw new Error("The Collection's rules changed after this change. Reload the Collection.");
      return committed;
    } catch(error) {
      // An uncertain journal commit is resolved on the next recovery, never rerun here.
      if(stage) {
        // Revocation preserves the reservation for owner cleanup instead of bypassing authority.
        try{options.journal.discardCheckpoint({stage,authorize:()=>standing(input),account:input.accountStage});}catch{}
      }
      if(lane.worker)await stopWorker(lane);standing(input);throw error;
    } finally {input.signal?.removeEventListener("abort",abort);}
  }

  function enqueue<T>(input:DatasetAccess,bytes:number,work:(lane:Lane)=>Promise<T>):Promise<T> {
    standing(input);head(input);
    if (queuedCount + capacityWaiters >= 128 || queuedBytes + capacityWaitBytes + bytes > 16 * 1024 * 1024) throw new Error("dohc has too much Collection work waiting. Try again in a moment.");
    const key=JSON.stringify(input.scope);
    let lane=lanes.get(key);
    if(!lane){lane={scope:input.scope,lifecycle:new AbortController(),queue:[],active:false};lanes.set(key,lane);}
    if(lane.queue.length+Number(lane.active)>=64)throw new Error("This Collection has too much work waiting. Try again in a moment.");
    if(lane.idle){clearTimeout(lane.idle);lane.idle=undefined;}
    const target=lane;
    return new Promise<T>((resolve,reject)=>{
      const expire=()=>{
        const index=target.queue.indexOf(job);if(index<0)return;
        target.queue.splice(index,1);queuedCount--;queuedBytes-=job.bytes;
        clearTimeout(job.timeout);input.signal?.removeEventListener("abort",job.abort);
        reject(new Error("This Collection stayed busy too long, so dohc stopped waiting. Try again."));
      };
      const job:Job={bytes,deadline:performance.now()+queueMs,signal:input.signal,abort:expire,timeout:setTimeout(expire,queueMs),resolve:result=>resolve(result as T),reject,
        work:async()=>{standing(input);return work(target);}};
      input.signal?.addEventListener("abort",expire,{once:true});target.queue.push(job);queuedCount++;queuedBytes+=bytes;pump(target);
    });
  }

  function pump(lane: Lane): void {
    if (lane.active || closed) return;
    const job = lane.queue.shift();
    if (!job) {
      if (lane.worker) {
        lane.idle = setTimeout(() => {
          lane.active=true;
          lane.idleWork=(async()=>{
            try {await maintainMaterialization(lane);await stopWorker(lane);}
            finally {lane.idleWork=undefined;lane.active=false;pump(lane);}
          })();
          lane.done=lane.idleWork;
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
    lane.admission={bytes:job.bytes,deadline:job.deadline};
    lane.done = (async () => {
      let released=false;
      try {
        const result = await job.work();
        if(options.maintenanceStorage&&lane.worker&&!blockedMaintenance.has(JSON.stringify(lane.scope))&&lane.worker.cursor.revision>=(lane.nextMaterializationRevision??materializationEvents)) {
          job.resolve(result);
          // Capture an immutable cache, then let foreground work continue during its staging.
          lane.idleWork=(async()=>{
            try {await new Promise<void>(resolve=>setImmediate(resolve));await maintainMaterialization(lane);}
            finally {lane.idleWork=undefined;}
          })();
          await lane.idleWork;
        } else {released=true;lane.admission=undefined;lane.active=false;pump(lane);job.resolve(result);return;}
      } catch (error) { job.reject(error); }
      finally {if(!released){lane.admission=undefined;lane.active=false;pump(lane);}}
    })();
  }

  function migrationInput(raw:DatasetMigration):DatasetMigration {
    const input:DatasetMigration={...raw,scope:copyScope(raw.scope),expected:{...copyScope(raw.expected),hostEpoch:raw.expected.hostEpoch,
      approvedRevisionHash:raw.expected.approvedRevisionHash,revision:raw.expected.revision,digest:raw.expected.digest},tables:approvedTables(raw.tables),newTables:approvedTables(raw.newTables),
      source:boundedText(raw.source,DEFAULT_LIMITS.sourceBytes,"Collection source"),schemaSql:boundedText(raw.schemaSql,DEFAULT_LIMITS.sourceBytes,"Collection schema"),
      definitionJson:boundedText(raw.definitionJson,256*1024,"Collection definition"),migrationSql:boundedText(raw.migrationSql,DEFAULT_LIMITS.sourceBytes,"Migration SQL")};
    if(!/^[a-f0-9]{64}$/.test(input.approvedRevisionHash)||input.expected.workspaceId!==input.scope.workspaceId||input.expected.datasetId!==input.scope.datasetId)throw new Error("Invalid migration authority.");
    JSON.parse(input.definitionJson);return input;
  }
  function candidateInput<T extends DatasetMigrationCandidateAccess>(raw:T):T {
    return {...raw,scope:copyScope(raw.scope),tables:approvedTables(raw.tables),candidateId:boundedText(raw.candidateId,128,"Migration candidate"),authorityKey:boundedText(raw.authorityKey,4096,"Migration authority")};
  }
  async function retireMigrationCandidates(scope:DatasetScope):Promise<void> {
    const key=copyScope(scope);
    for(const candidate of candidates.values())if(candidate.result.expected.workspaceId===key.workspaceId&&candidate.result.expected.datasetId===key.datasetId) {
      candidate.reservations.length=0;await dropCandidate(candidate);
    }
  }
  return {
    /** Called only after durable dataset deletion reclaimed all checkpoint reservations. */
    retireMigrationCandidates,
    prepareMigration(raw:DatasetMigration & {authorityKey:string}):Promise<DatasetMigrationCandidate> {
      try {
        const input={...migrationInput(raw),authorityKey:boundedText(raw.authorityKey,4096,"Migration authority")};
        return enqueue(input,Buffer.byteLength(JSON.stringify([input.source,input.schemaSql,input.definitionJson,input.migrationSql])),lane=>prepareMigration(lane,input));
      }catch(error){return Promise.reject(error);}
    },
    approveMigration(raw:DatasetMigrationApproval):Promise<DatasetCursor> {
      try {const input=candidateInput(raw);return enqueue(input,1024,lane=>approveMigration(lane,input));}catch(error){return Promise.reject(error);}
    },
    migrationPreviewPage(raw:DatasetMigrationCandidateAccess & {after?:string;limit?:number}):MigrationPreviewReportPage {
      const input=candidateInput(raw),candidate=findCandidate(input);
      const page=readMigrationPreviewReportPage({path:candidate.reportPath,after:raw.after,limit:raw.limit});
      standing(input);return page;
    },
    async discardMigration(raw:DatasetMigrationCandidateAccess):Promise<void> {
      const input=candidateInput(raw),candidate=findCandidate(input,false);
      return enqueue(input,1024,async()=>{standing(input);await dropCandidate(candidate);});
    },
    invoke(raw: DatasetInvocation): Promise<DatasetInvocationResult> {
      try {
        if (raw.files && (!Array.isArray(raw.files) || raw.files.length > APP_BACKEND_OPERATION_FILES)) throw new Error("This Collection action uses too many files.");
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
        const input=migrationInput(raw);
        const bytes=Buffer.byteLength(JSON.stringify([input.scope,input.expected,input.tables,input.newTables,input.source,input.schemaSql,input.definitionJson,input.migrationSql]));
        return enqueue(input,bytes,lane=>migrate(lane,input));
      }catch(error){return Promise.reject(error);}
    },
    /** Called after the authority has durably deleted the dataset. */
    async retire(raw: DatasetScope): Promise<void> {
      const scope = copyScope(raw), key = JSON.stringify(scope), lane = lanes.get(key);
      reopenWaits.delete(key);
      if(lane)lane.lifecycle.abort(new Error("This Collection was permanently deleted."));
      await cancelMaintenance(scope);
      if (!lane) {await retireMigrationCandidates(scope);return;}
      if (lane.idle) { clearTimeout(lane.idle); lane.idle = undefined; }
      for (const job of lane.queue.splice(0)) {
        queuedCount--; queuedBytes -= job.bytes; clearTimeout(job.timeout);
        job.signal?.removeEventListener("abort",job.abort); job.reject(new Error("This Collection was permanently deleted."));
      }
      if (lane.active && lane.worker) await lane.worker.runtime.abort("This Collection was permanently deleted.").catch(() => {});
      await lane.done;
      if (lane.idle) clearTimeout(lane.idle);
      await stopWorker(lane);
      if (lanes.get(key) === lane) lanes.delete(key);
      await retireMigrationCandidates(scope);
    },
    async close(): Promise<void> {
      closed = true;
      for (const lane of lanes.values()) {
        lane.lifecycle.abort(new Error("dohc closed this workspace's Collections. Open the workspace again."));
        if (lane.idle) clearTimeout(lane.idle);
        if (lane.active && lane.worker) void lane.worker.runtime.abort("dohc closed this workspace's Collections. Open the workspace again.").catch(() => {});
        for (const job of lane.queue.splice(0)) { queuedCount--; queuedBytes -= job.bytes; clearTimeout(job.timeout); job.signal?.removeEventListener("abort", job.abort); job.reject(new Error("dohc closed this workspace's Collections. Open the workspace again.")); }
      }
      const results=await Promise.allSettled([...lanes.values()].map(async lane => { await lane.done; await stopWorker(lane); }));
      for(const task of maintenance.values())task.cancel.abort(new Error("dohc closed this workspace's Collections. Open the workspace again."));
      await Promise.all([...maintenance.values()].map(task=>task.done));
      const candidateResults=await Promise.allSettled([...candidates.values()].map(dropCandidate));
      const cleanupResults=await Promise.allSettled([...candidateCleanup]);
      lanes.clear();ownership.close();
      const failed=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");
      if(failed)throw failed.reason;
      const cleanupFailed=[...candidateResults,...cleanupResults].find((result):result is PromiseRejectedResult=>result.status==="rejected");
      if(cleanupFailed)throw cleanupFailed.reason;
    },
  };
}
