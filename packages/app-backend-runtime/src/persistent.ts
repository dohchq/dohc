import { spawn } from "node:child_process";
import { APP_BACKEND_OPERATION_FILES } from "@dohc/security-contract/app-backend";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { AppBackendRuntimeError, approvedTables, boundedText } from "./protocol.js";
import type { AppRuntimeChild, AppRuntimeLauncher } from "./protocol.js";
import { CPU_BUDGET_MARKER, checkCursor, checkDigest, digest, openRequest, PersistentRuntimeError, reject, trustedPath, REPLAY_BATCH_BYTES, REPLAY_BATCH_EVENTS } from "./persistent-protocol.js";
import type { CommittedChangeset, DatasetCursor, FinalizeOperation, MigrateCheckpointInput, MigratedCheckpoint, PersistentCommand, PersistentOpenInput, PersistentPrepareInput, PersistentProgress, PersistentReply, PersistentResult, PreparedOperation } from "./persistent-protocol.js";
export type { CommittedChangeset, DatasetCursor, DatasetScope, FinalizeOperation, MigrateCheckpointInput, PersistentOpenInput, PersistentPrepareInput, PreparedOperation } from "./persistent-protocol.js";
export type { WorkerOwnership } from "./worker-ownership.js";
export { PersistentRuntimeError } from "./persistent-protocol.js";

// A worker command fails only when it stops making progress. The worker reports
// each step as it starts; a step may block on one fsync, which took up to 8.4 s
// on a slow Windows disk, so 30 s of silence means it stopped. The cap per
// command is far beyond healthy work and catches a worker that keeps reporting
// without finishing. The app's own code is bounded by CPU time inside the
// worker (RuntimeLimits.cpuBudgetMs), so a slow disk never counts against it.
export const WORKER_SILENCE_MS=30_000;
export const WORKER_COMMAND_CAP_MS=600_000;
// A dataset check such as the integrity check reports nothing until it ends,
// so it may stay quiet longer than other steps, up to this bound. The slowest
// measured check, the integrity check of a 128 MiB dataset with six indexes on
// random keys, took 87 s on a loaded desktop machine; this is twice that.
export const CHECK_SILENCE_CAP_MS=180_000;
export interface PersistentRuntimeOptions { launch?:AppRuntimeLauncher; entryPath?:string; silenceMs?:number; commandCapMs?:number }
// How long a command waits for the worker by default. A loaded machine can take seconds to start a worker process.
const WORKER_WAIT_MS=30_000;
// SQLite's ceiling on columns in a table (SQLITE_MAX_COLUMN).
const MAX_TABLE_COLUMNS=32_767;
// A plain object naming every approved table's columns, and nothing else.
function tableColumns(value:unknown,tables:readonly string[]):boolean {
  if(value===null || typeof value!=="object" || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype) return false;
  const entries=Object.entries(value);
  return entries.length===tables.length && entries.every(([table,names])=>tables.includes(table) && columnNames(names));
}
// A non-empty list with a name at every index, each distinct in any letter case, as SQLite compares column names.
function columnNames(names:unknown):boolean {
  if(!Array.isArray(names) || names.length===0 || names.length>MAX_TABLE_COLUMNS) return false;
  const seen=new Set<string>();
  for(let index=0;index<names.length;index+=1) {
    if(!Object.hasOwn(names,index)) return false;
    const name:unknown=names[index];
    if(typeof name!=="string" || name.length===0 || seen.has(name.toLowerCase())) return false;
    seen.add(name.toLowerCase());
  }
  return true;
}
const nodeLauncher:AppRuntimeLauncher=options=>{
  if (process.versions.electron) throw new Error("Electron must configure an app runtime utility-process launcher.");
  const child=spawn(process.execPath,["--disable-warning=ExperimentalWarning","--max-old-space-size=96",options.entryPath],{
    cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true,
  });
  child.on("message",options.onMessage);child.on("error",options.onError);child.on("close",options.onExit);
  return {postMessage(message){child.send(message as object,error=>{if(error) options.onError(error);});},kill(){child.kill("SIGKILL");}};
};

export async function openPersistentAppBackend(input:PersistentOpenInput, options:PersistentRuntimeOptions={}) {
  const config=openRequest(input);
  const entryPath=trustedPath(options.entryPath ?? fileURLToPath(import.meta.resolve("@dohc/app-backend-runtime/persistent-child")));
  const queueDeadlineMs=input.queueDeadlineMs ?? WORKER_WAIT_MS;
  if (!Number.isSafeInteger(queueDeadlineMs) || queueDeadlineMs<1 || queueDeadlineMs>60_000) reject("invalid_input","Invalid worker queue deadline.");
  input.signal?.throwIfAborted();
  const silenceMs=options.silenceMs ?? WORKER_SILENCE_MS, commandCapMs=options.commandCapMs ?? WORKER_COMMAND_CAP_MS;
  type Entry={id:number;bytes:number;command:PersistentCommand;resolve:(result:PersistentResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;
    cap?:ReturnType<typeof setTimeout>;step?:string;progress:number;silence:number};
  const queue:Entry[]=[];
  let active:Entry | undefined, child:AppRuntimeChild | undefined, stopped:Error | undefined, closing=false, sequence=0;
  let exited=false, ready=false, retainedBytes=0;
  let resolveExit:()=>void;
  const exitPromise=new Promise<void>(resolve=>{resolveExit=resolve;});
  const duration=(ms:number)=>ms<1000 ? `${ms} ms` : ms<60_000 ? `${Math.round(ms/1000)} s` : `${Math.round(ms/60_000)} minutes`;
  function settle(entry:Entry):void {clearTimeout(entry.timer);clearTimeout(entry.cap);}
  function during(entry:Entry|undefined):string {return entry?.step ? ` while ${entry.step}` : "";}
  function watchSilence(entry:Entry, limitMs=silenceMs):void {
    clearTimeout(entry.timer);
    const seen=entry.progress;entry.silence=limitMs;
    entry.timer=setTimeout(()=>{
      // A stalled host fires this before it reads messages that arrived meanwhile.
      // In Node the check phase follows the poll that delivers them; Electron's
      // main process runs its own loop, where this recheck is best effort.
      setImmediate(()=>{
        if(active!==entry || entry.progress!==seen) return;
        fail(new PersistentRuntimeError("worker_stalled",`The dataset worker made no progress for ${duration(entry.silence)}${during(entry)}. Try again.`));
      });
    },limitMs);
  }
  const budgetMarker=()=>join(config.directory,CPU_BUDGET_MARKER);
  // The worker's CPU budget watch leaves this marker as it ends the worker.
  function exceededBudget():string|undefined {
    let marker:string;
    try {marker=readFileSync(budgetMarker(),"utf8");} catch {return undefined;}
    // An antivirus scan can hold the file; the reason is already known.
    try {rmSync(budgetMarker(),{force:true});} catch {/* removed before the next launch */}
    const [kind,budgetMs]=marker.split(" ");
    const used=`more than ${duration(Number(budgetMs))} of CPU time${during(active)}`;
    return kind==="checks" ? `The dataset's checks ran too long: they used ${used}.` : `The app's code ran too long: it used ${used}.`;
  }
  function fail(error:Error):void {
    stopped??=error;
    if(active){settle(active);retainedBytes-=active.bytes;active.reject(stopped);active=undefined;}
    for(const entry of queue.splice(0)){clearTimeout(entry.timer);retainedBytes-=entry.bytes;entry.reject(stopped);}
    child?.kill();
  }
  // A command's deadline starts when the worker takes it, so a slow process start does not count against the open.
  function pump():void {
    if(active || stopped || !child || !ready) return;
    const entry=queue.shift();
    if(!entry) return;
    clearTimeout(entry.timer);active=entry;
    watchSilence(entry);
    entry.cap=setTimeout(()=>fail(new PersistentRuntimeError("worker_deadline",`The dataset worker did not finish in ${duration(commandCapMs)}${during(entry)}. Try again.`)),commandCapMs);
    try {child.postMessage({id:entry.id,command:entry.command});}catch(error){fail(error instanceof Error ? error : new Error(String(error)));}
  }
  function send(command:PersistentCommand):Promise<PersistentResult> {
    if(stopped) return Promise.reject(stopped);
    if(closing && command.kind!=="close") return Promise.reject(new PersistentRuntimeError("worker_closed","The dataset worker is closing."));
    if(queue.length+(active?1:0)>=64) return Promise.reject(new PersistentRuntimeError("queue_full","The dataset worker queue is full."));
    const bytes=command.kind==="apply" ? command.input.changeset.byteLength : command.kind==="applyBatch" ? command.input.reduce((sum,event)=>sum+event.changeset.byteLength+256,0) : Buffer.byteLength(JSON.stringify(command));
    if(retainedBytes+bytes>129*1024*1024) return Promise.reject(new PersistentRuntimeError("queue_full","The dataset worker queue byte limit is full."));
    if(command.kind==="apply") command={...command,input:{...command.input,changeset:Uint8Array.from(command.input.changeset)}};
    if(command.kind==="applyBatch") command={...command,input:command.input.map(event=>({...event,changeset:Uint8Array.from(event.changeset)}))};
    retainedBytes+=bytes;
    // The open is always first, so its wait is the worker's start.
    const waitMs=command.kind==="open" ? WORKER_WAIT_MS : queueDeadlineMs;
    return new Promise((resolve,rejectEntry)=>{
      const entry:Entry={id:++sequence,bytes,command,resolve,reject:rejectEntry,progress:0,silence:silenceMs,timer:setTimeout(()=>{
        const index=queue.indexOf(entry);
        if(index>=0){queue.splice(index,1);retainedBytes-=entry.bytes;rejectEntry(new PersistentRuntimeError("queue_deadline","The operation expired while waiting for the dataset worker."));}
      },waitMs)};
      queue.push(entry);pump();
    });
  }
  rmSync(budgetMarker(),{force:true});
  const cancel=()=>{const reason:unknown=input.signal?.reason;fail(reason instanceof Error ? reason : new PersistentRuntimeError("worker_aborted","The dataset worker was cancelled."));};
  input.signal?.addEventListener("abort",cancel,{once:true});
  try {
    // Utility-process exit can precede release of its Windows cwd handle. Keep that handle outside removable data.
    child=(options.launch ?? nodeLauncher)({entryPath,cwd:dirname(entryPath),env:{},
      onMessage(message){
        if(!ready && (message as {ready?:unknown} | null)?.ready===true) {ready=true;pump();return;}
        const progress=message as PersistentProgress;
        if(active && progress && progress.id===active.id && typeof progress.progress==="string" && progress.progress.length<=128) {
          active.step=progress.progress;active.progress++;
          // Such a step's own CPU budget bounds its work. Waiting on the disk
          // can double its wall time, up to the bound for a quiet check.
          const budget=progress.cpuBudgetMs;
          watchSilence(active,Number.isSafeInteger(budget) && budget!>0 ? Math.max(silenceMs,Math.min(silenceMs+2*budget!,CHECK_SILENCE_CAP_MS,commandCapMs)) : silenceMs);
          return;
        }
        const reply=message as PersistentReply;
        if(!active || !reply || reply.id!==active.id || typeof reply.ok!=="boolean") {fail(new PersistentRuntimeError("worker_protocol","Invalid dataset worker response."));return;}
        const entry=active;active=undefined;settle(entry);retainedBytes-=entry.bytes;
        if(reply.ok) entry.resolve(reply.result);
        else entry.reject(reply.refusal ? new AppBackendRuntimeError(reply.refusal) : new PersistentRuntimeError(reply.code,reply.error));
        pump();
      },onError:fail,onExit(){
        exited=true;resolveExit();
        const budget=exceededBudget();
        if(budget!==undefined) fail(new PersistentRuntimeError("worker_budget",`${budget} Try again.`));
        else if(!closing || active || queue.length) fail(new PersistentRuntimeError("worker_stopped",`The dataset worker stopped${during(active)}. Try again.`));
      },
    });
    if(stopped) child.kill();
    await send({kind:"open",input:config});
  } catch(error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    if(child && !exited) await exitPromise;
    throw error;
  } finally {
    input.signal?.removeEventListener("abort",cancel);
  }

  return {
    async prepare(operation:PersistentPrepareInput):Promise<PreparedOperation> {
      checkCursor(operation.expected);
      if(!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(operation.operation) || !Number.isSafeInteger(operation.nowMs) || operation.nowMs<0 || !/^[A-Za-z0-9._:-]{1,128}$/.test(operation.requestId)) reject("invalid_input","Invalid operation context.");
      const secret=operation.secret ?? randomBytes(32).toString("base64url");
      if(!/^[A-Za-z0-9_-]{43}$/.test(secret)) reject("invalid_input","Invalid operation secret.");
      const files=operation.files ?? [];
      const readOnly=operation.readOnly===true;
      if(!Array.isArray(files) || files.length>APP_BACKEND_OPERATION_FILES || files.some(file=>!file || !/^[A-Za-z0-9._:-]{1,128}$/.test(file.fileId) || typeof file.name!=="string" || Buffer.byteLength(file.name)>512 || typeof file.contentType!=="string" || Buffer.byteLength(file.contentType)>128 || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.byteLength) || file.byteLength<0) || new Set(files.map(file=>file.fileId)).size!==files.length) reject("invalid_input","Invalid operation files.");
      // Serialize before admission: invalid JSON and oversized inputs never consume queue slots.
      const inputJson=boundedText(JSON.stringify(operation.input),config.limits.inputBytes,"Operation input");
      const callerJson=boundedText(JSON.stringify(operation.caller),config.limits.inputBytes,"Caller");
      const result=await send({kind:"prepare",expected:{...operation.expected},guest:{
        tables:config.tables,limits:config.limits,source:boundedText(operation.source,config.limits.sourceBytes,"Operation source"),
        operation:operation.operation,inputJson,callerJson,nowMs:operation.nowMs,requestId:operation.requestId,secret,
        readOnly,files:files.map(file=>({...file})),
      }}) as PreparedOperation;
      try {
        if(!result || typeof result.proposalId!=="string" || !/^[a-f0-9-]{36}$/.test(result.proposalId) || result.readOnly!==readOnly ||
          !(result.changeset instanceof Uint8Array) || result.changeset.byteLength>config.limits.databaseBytes || digest(result.changeset)!==result.changesetSha256 ||
          !Array.isArray(result.attachedFileIds) || result.attachedFileIds.length>32 || new Set(result.attachedFileIds).size!==result.attachedFileIds.length ||
          result.attachedFileIds.some(id=>typeof id!=="string" || !files.some(file=>file.fileId===id)) || !tableColumns(result.columns,config.tables) ||
          (result.readOnly && (result.changeset.byteLength || result.attachedFileIds.length))) throw Error("Invalid prepared operation.");
        boundedText(JSON.stringify(result.result),config.limits.resultBytes,"Operation result");
      } catch {
        const error=new PersistentRuntimeError("worker_protocol","Invalid prepared operation.");fail(error);throw error;
      }
      return result;
    },
    async finalize(operation:FinalizeOperation):Promise<DatasetCursor> {
      checkCursor(operation);checkDigest(operation.previousDigest);checkDigest(operation.changesetSha256);
      return await send({kind:"finalize",input:{proposalId:operation.proposalId,previousDigest:operation.previousDigest,
        revision:operation.revision,digest:operation.digest,changesetSha256:operation.changesetSha256}}) as DatasetCursor;
    },
    async discard(proposalId:string):Promise<void> {await send({kind:"discard",proposalId});},
    async apply(event:CommittedChangeset):Promise<DatasetCursor> {
      checkCursor(event);checkDigest(event.previousDigest);checkDigest(event.changesetSha256);
      if(!(event.changeset instanceof Uint8Array) || event.changeset.byteLength>config.limits.databaseBytes || digest(event.changeset)!==event.changesetSha256) reject("invalid_input","Invalid committed changeset.");
      return await send({kind:"apply",input:{...event}}) as DatasetCursor;
    },
    async applyBatch(events:CommittedChangeset[]):Promise<DatasetCursor> {
      if(!Array.isArray(events)||!events.length||events.length>REPLAY_BATCH_EVENTS)reject("invalid_input","Invalid replay batch size.");
      let bytes=0;
      for(let index=0;index<events.length;index++) {
        const event=events[index];checkCursor(event);checkDigest(event.previousDigest);checkDigest(event.changesetSha256);
        if(!(event.changeset instanceof Uint8Array)||event.changeset.byteLength>config.limits.databaseBytes||(bytes+=event.changeset.byteLength)>REPLAY_BATCH_BYTES||digest(event.changeset)!==event.changesetSha256)reject("invalid_input","Invalid replay batch changeset.");
        if(index&&(event.revision!==events[index-1].revision+1||event.previousDigest!==events[index-1].digest))reject("invalid_input","Replay batch is not contiguous.");
      }
      const input=events.map(event=>({revision:event.revision,digest:event.digest,previousDigest:event.previousDigest,changesetSha256:event.changesetSha256,changeset:event.changeset})),last=input.at(-1)!;
      try {
        const result=await send({kind:"applyBatch",input}) as DatasetCursor;
        if(!result||result.revision!==last.revision||result.digest!==last.digest)throw new PersistentRuntimeError("worker_protocol","Invalid replay batch cursor.");
        return result;
      }catch(error){fail(error instanceof Error?error:new Error(String(error)));throw error;}
    },
    async snapshot(path:string):Promise<{path:string;cursor:DatasetCursor}> {return await send({kind:"snapshot",path:trustedPath(path)}) as {path:string;cursor:DatasetCursor};},
    async migrateCheckpoint(input:MigrateCheckpointInput):Promise<MigratedCheckpoint> {
      return await send({kind:"migrateCheckpoint",input:{path:trustedPath(input.path),tables:approvedTables(input.tables),
        schemaSql:boundedText(input.schemaSql,config.limits.sourceBytes,"Database schema"),
        migrationSql:boundedText(input.migrationSql,config.limits.sourceBytes,"Database migration"),
        ...(input.reportPath ? {reportPath:trustedPath(input.reportPath)} : {})}}) as MigratedCheckpoint;
    },
    async abort(reason="The dataset operation was cancelled."):Promise<void> {
      closing=true;fail(new PersistentRuntimeError("worker_aborted",reason));
      if(!exited) await exitPromise;
    },
    async close():Promise<void> {
      if(!closing){
        closing=true;
        if(!stopped) {try {await send({kind:"close"});child?.kill();}catch(error){fail(error instanceof Error ? error : new Error(String(error)));}}
      }
      if(!exited) await exitPromise;
    },
  };
}
export type PersistentAppBackend=Awaited<ReturnType<typeof openPersistentAppBackend>>;
