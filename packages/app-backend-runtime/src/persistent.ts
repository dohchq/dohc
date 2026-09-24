import { spawn } from "node:child_process";
import { APP_BACKEND_OPERATION_FILES } from "@dohc/security-contract/app-backend";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { AppBackendRuntimeError, approvedTables, boundedText, DEFAULT_LIMITS } from "./protocol.js";
import type { AppRuntimeChild, AppRuntimeLauncher } from "./protocol.js";
import { checkCursor, checkDigest, digest, openRequest, PersistentRuntimeError, reject, trustedPath, REPLAY_BATCH_BYTES, REPLAY_BATCH_EVENTS } from "./persistent-protocol.js";
import type { CommittedChangeset, DatasetCursor, FinalizeOperation, MigrateCheckpointInput, MigratedCheckpoint, PersistentCommand, PersistentOpenInput, PersistentPrepareInput, PersistentProgress, PersistentReply, PersistentResult, PreparedOperation } from "./persistent-protocol.js";
export type { CommittedChangeset, DatasetCursor, DatasetScope, FinalizeOperation, MigrateCheckpointInput, PersistentOpenInput, PersistentPrepareInput, PreparedOperation } from "./persistent-protocol.js";
export type { WorkerOwnership } from "./worker-ownership.js";
export { PersistentRuntimeError } from "./persistent-protocol.js";

// Work that is slow because of I/O fails only when it stops making progress. The
// worker reports each step as it starts; a step may block on one fsync, which
// took up to 8.4 s on a slow Windows disk, so 30 s of silence means it stopped.
// The cap per command is far beyond healthy work and catches a worker that
// keeps reporting without finishing.
//
// Commands that run app code keep the configured deadline: prepare runs the
// operation, migrateCheckpoint the migration, and open the app's schema.
// node:sqlite cannot interrupt a running statement, so until app SQL has a
// budget measured in work, wall time is the only bound on a runaway query.
const APP_CODE_COMMANDS:ReadonlySet<PersistentCommand["kind"]>=new Set(["open","prepare","migrateCheckpoint"]);
export const WORKER_SILENCE_MS=30_000;
export const WORKER_COMMAND_CAP_MS=600_000;
export interface PersistentRuntimeOptions { launch?:AppRuntimeLauncher; entryPath?:string; silenceMs?:number; commandCapMs?:number }
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
  const queueDeadlineMs=input.queueDeadlineMs ?? 30_000;
  if (!Number.isSafeInteger(queueDeadlineMs) || queueDeadlineMs<1 || queueDeadlineMs>60_000) reject("invalid_input","Invalid worker queue deadline.");
  const silenceMs=options.silenceMs ?? WORKER_SILENCE_MS, commandCapMs=options.commandCapMs ?? WORKER_COMMAND_CAP_MS;
  type Entry={id:number;bytes:number;command:PersistentCommand;resolve:(result:PersistentResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;
    cap?:ReturnType<typeof setTimeout>;step?:string;progress:number};
  const queue:Entry[]=[];
  let active:Entry | undefined, child:AppRuntimeChild | undefined, stopped:Error | undefined, closing=false, sequence=0;
  let exited=false, retainedBytes=0;
  let resolveExit:()=>void;
  const exitPromise=new Promise<void>(resolve=>{resolveExit=resolve;});
  const duration=(ms:number)=>ms<1000 ? `${ms} ms` : ms<60_000 ? `${Math.round(ms/1000)} s` : `${Math.round(ms/60_000)} minutes`;
  function settle(entry:Entry):void {clearTimeout(entry.timer);clearTimeout(entry.cap);}
  function during(entry:Entry|undefined):string {return entry?.step ? ` while ${entry.step}` : "";}
  function watchSilence(entry:Entry):void {
    clearTimeout(entry.timer);
    const seen=entry.progress;
    entry.timer=setTimeout(()=>{
      // A stalled host fires this before it reads messages that arrived meanwhile.
      setImmediate(()=>{
        if(active!==entry || entry.progress!==seen) return;
        fail(new PersistentRuntimeError("worker_stalled",`The dataset worker made no progress for ${duration(silenceMs)}${during(entry)}. Reopen it from the journal.`));
      });
    },silenceMs);
  }
  function fail(error:Error):void {
    stopped??=error;
    if(active){settle(active);retainedBytes-=active.bytes;active.reject(stopped);active=undefined;}
    for(const entry of queue.splice(0)){clearTimeout(entry.timer);retainedBytes-=entry.bytes;entry.reject(stopped);}
    child?.kill();
  }
  function pump():void {
    if(active || stopped || !child) return;
    const entry=queue.shift();
    if(!entry) return;
    clearTimeout(entry.timer);active=entry;
    if(APP_CODE_COMMANDS.has(entry.command.kind)) {
      const deadlineMs=entry.command.kind==="open" ? DEFAULT_LIMITS.deadlineMs : config.limits.deadlineMs;
      entry.timer=setTimeout(()=>fail(new PersistentRuntimeError("worker_deadline",`The dataset worker exceeded its deadline${during(entry)}. Reopen it from the journal.`)),deadlineMs);
    } else {
      watchSilence(entry);
      entry.cap=setTimeout(()=>fail(new PersistentRuntimeError("worker_deadline",`The dataset worker did not finish in ${duration(commandCapMs)}${during(entry)}. Reopen it from the journal.`)),commandCapMs);
    }
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
    return new Promise((resolve,rejectEntry)=>{
      const entry:Entry={id:++sequence,bytes,command,resolve,reject:rejectEntry,progress:0,timer:setTimeout(()=>{
        const index=queue.indexOf(entry);
        if(index>=0){queue.splice(index,1);retainedBytes-=entry.bytes;rejectEntry(new PersistentRuntimeError("queue_deadline","The operation expired while waiting for the dataset worker."));}
      },queueDeadlineMs)};
      queue.push(entry);pump();
    });
  }
  try {
    // Utility-process exit can precede release of its Windows cwd handle. Keep that handle outside removable data.
    child=(options.launch ?? nodeLauncher)({entryPath,cwd:dirname(entryPath),env:{},
      onMessage(message){
        const progress=message as PersistentProgress;
        if(active && progress && progress.id===active.id && typeof progress.progress==="string" && progress.progress.length<=128) {
          active.step=progress.progress;active.progress++;
          if(!APP_CODE_COMMANDS.has(active.command.kind)) watchSilence(active);
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
        if(!closing || active || queue.length) fail(new PersistentRuntimeError("worker_stopped",`The dataset worker stopped${during(active)}. Reopen it from the journal.`));
      },
    });
    if(stopped) child.kill();
    await send({kind:"open",input:config});
  } catch(error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    if(child && !exited) await exitPromise;
    throw error;
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
          result.attachedFileIds.some(id=>typeof id!=="string" || !files.some(file=>file.fileId===id)) ||
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
