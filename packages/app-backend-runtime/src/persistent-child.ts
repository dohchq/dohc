import { constants as fsConstants, copyFileSync, lstatSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { datasetNumberText, losslessDatasetNumber } from "@dohc/security-contract/dataset-conversion";
import { authorize, evaluate } from "./guest.js";
import { AppBackendRuntimeError } from "./protocol.js";
import { checkCursor, checkDigest, digest, openRequest, PersistentRuntimeError, reject, trustedPath, REPLAY_BATCH_BYTES, REPLAY_BATCH_EVENTS } from "./persistent-protocol.js";
import { assertReplayableSchema, authorizeMigration, verifyDatasetSchema } from "./migration.js";
import { replayThroughShadow } from "./replay.js";
import { createMigrationPreviewReport } from "./migration-preview-report.js";
import { acquireWorkerLease } from "./worker-ownership.js";
import { Worker } from "node:worker_threads";
import { CPU_BUDGET_MARKER, databaseBytes } from "./persistent-protocol.js";
import type { CpuBudgets, DatasetCursor, OpenRequest, PersistentCommand, PersistentProgress, PersistentReply, PersistentResult } from "./persistent-protocol.js";

let db:DatabaseSync | undefined;
let config:OpenRequest;
let cursor:DatasetCursor;
let pending:{id:string;changesetSha256:string} | undefined;
let transaction=false;
let busy=false;
let lease:{close():void}|undefined;
const marker="dohc_applied";
const markerSchema=`CREATE TABLE ${marker}(id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL)`;
const databaseOptions={allowExtension:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false};
// Exported by Node's SQLite binding but missing from the installed Node type declarations.
const changesetConstraint=(constants as typeof constants & {SQLITE_CHANGESET_CONSTRAINT:number}).SQLITE_CHANGESET_CONSTRAINT;

function noLinks(path:string, mayNotExist=false):void {
  trustedPath(path);
  let current=resolve(path);
  if (mayNotExist) current=dirname(current);
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) reject("invalid_input","Dataset paths cannot contain symbolic links.");
    const parent=dirname(current);
    if (parent===current) break;
    current=parent;
  }
}
function rollback():void {
  if (db) { db.setAuthorizer(null); if (db.isTransaction) db.exec("ROLLBACK"); }
  transaction=false; pending=undefined;
}
function requireIdle():void { if (pending) reject("pending_operation","Finalize or discard the prepared operation first."); }
function expectCursor(expected:DatasetCursor):void {
  checkCursor(expected);
  if (expected.revision!==cursor.revision || expected.digest!==cursor.digest) reject("stale_revision","The dataset revision changed.");
}
function nextCursor(next:DatasetCursor & {previousDigest:string}):void {
  checkCursor(next);checkDigest(next.previousDigest);
  if (next.revision!==cursor.revision+1 || next.previousDigest!==cursor.digest) reject("stale_revision","The journal event does not continue this dataset.");
}
function writeMarker(next:DatasetCursor):void {
  db!.prepare(`UPDATE ${marker} SET revision=?,digest=? WHERE id=1`).run(next.revision,next.digest);
}

// App code runs on this thread and can block it inside SQLite, where no timer
// on this thread runs. A second thread watches the process's CPU time while a
// budgeted step runs. Past the budget it leaves a marker for the host and ends
// the worker, because node:sqlite cannot interrupt a statement. Waiting on the
// disk uses no CPU, so a slow disk never counts against a budget.
//
// The app's code (its schema text and SQL, an operation, a migration, and the
// replay of one journal event, which runs the app's indexes and generated
// columns) shares cpuBudgetMs across one command or one replayed event. A
// dataset check (a host step over every row, whose cost per row the app's
// schema sets) gets its own budget, scaled by the data it reads.
//
// Shared with the watch thread: generation, armed (0 or 1), the budget's kind,
// the process CPU time at which the step's charge would be zero, and the
// budget, in microseconds. The watch reads the generation first and again
// before it ends the worker, so a step that ended or started while it measured
// is never charged.
const budgetState=new BigInt64Array(new SharedArrayBuffer(5*8));
const [GENERATION,ARMED,KIND,ORIGIN,BUDGET]=[0,1,2,3,4];
const [APP_CODE,DATASET_CHECK]=[1n,2n];
const budgetWatchSource=`
const {workerData}=require("node:worker_threads");
const {writeFileSync}=require("node:fs");
const state=new BigInt64Array(workerData.state);
setInterval(()=>{
  const generation=Atomics.load(state,${GENERATION});
  if(Atomics.load(state,${ARMED})!==1n) return;
  const used=process.cpuUsage();
  if(BigInt(used.user+used.system)-Atomics.load(state,${ORIGIN})<=Atomics.load(state,${BUDGET})) return;
  const kind=Atomics.load(state,${KIND})===${APP_CODE}n ? "app" : "checks";
  const budgetMs=Number(Atomics.load(state,${BUDGET})/1000n);
  if(Atomics.load(state,${ARMED})!==1n || Atomics.load(state,${GENERATION})!==generation) return;
  try {writeFileSync(workerData.marker,kind+" "+budgetMs);} finally {process.kill(process.pid,"SIGKILL");}
},50);`;
let budgetWatch:Worker|undefined;
let exiting=false;
process.on("exit",()=>{exiting=true;});
const cpuMicros=()=>{const used=process.cpuUsage();return BigInt(used.user+used.system);};
function startBudgetWatch():void {
  if(budgetWatch) return;
  budgetWatch=new Worker(budgetWatchSource,{eval:true,workerData:{state:budgetState.buffer,marker:join(config.directory,CPU_BUDGET_MARKER)}});
  budgetWatch.unref();
  // Without the watch, app code would run unbounded. End the worker instead.
  const lost=()=>{if(!exiting) process.exit(70);};
  budgetWatch.on("error",lost);
  budgetWatch.on("exit",lost);
}
// CPU time the app's code used in this command or replayed event, in microseconds.
let appCharged=0n;
function budgeted<T>(kind:bigint, budget:bigint, run:()=>T):T {
  startBudgetWatch();
  // A dataset check may report nothing until it ends, so every report during it names its budget.
  if(kind===DATASET_CHECK) {checkBudgetMs=Number(budget/1000n);progress(step);}
  const start=cpuMicros();
  Atomics.add(budgetState,GENERATION,1n);
  Atomics.store(budgetState,KIND,kind);
  Atomics.store(budgetState,ORIGIN,start-(kind===APP_CODE ? appCharged : 0n));
  Atomics.store(budgetState,BUDGET,budget);
  Atomics.store(budgetState,ARMED,1n);
  const disarm=()=>{
    Atomics.store(budgetState,ARMED,0n);
    Atomics.add(budgetState,GENERATION,1n);
    if(kind===APP_CODE) appCharged+=cpuMicros()-start;
    else {checkBudgetMs=undefined;progress(step);}
  };
  let result:T;
  try {result=run();} catch(error) {disarm();throw error;}
  if(result instanceof Promise) return result.finally(disarm) as T;
  disarm();
  return result;
}
const budgets:CpuBudgets={
  appCode:run=>budgeted(APP_CODE,BigInt(config.limits.cpuBudgetMs)*1000n,run),
  datasetCheck:(bytes,run)=>budgeted(DATASET_CHECK,BigInt(config.limits.datasetCheckCpuMs+Math.ceil(config.limits.datasetCheckCpuMsPerMiB*bytes/2**20))*1000n,run),
};
const {appCode,datasetCheck}=budgets;
const foreignKeysHold=(database:DatabaseSync)=>datasetCheck(databaseBytes(database),()=>database.prepare("PRAGMA foreign_key_check").iterate().next().done===true);

function initialize(input:OpenRequest):DatasetCursor {
  if (db) reject("invalid_state","The worker is already open.");
  config=openRequest({...input,databaseBytes:input.limits.databaseBytes,limits:Object.fromEntries(Object.entries(input.limits).filter(([key])=>key!=="databaseBytes"))});
  appCode(()=>assertReplayableSchema(config.schemaSql));
  progress("taking the dataset lease");
  if(config.ownership) lease=acquireWorkerLease(config.directory,config.ownership);
  noLinks(config.directory);
  if (!statSync(config.directory).isDirectory()) reject("invalid_input","Dataset directory is unavailable.");
  const path=join(config.directory,"app.sqlite");
  if (config.checkpointPath) {
    progress("copying the checkpoint");
    noLinks(config.checkpointPath);
    const info=statSync(config.checkpointPath);
    if (!info.isFile() || info.size<100 || info.size>config.limits.databaseBytes) reject("invalid_checkpoint","Invalid dataset checkpoint.");
    copyFileSync(config.checkpointPath,path,fsConstants.COPYFILE_EXCL);
  } else { closeSync(openSync(path,"wx",0o600)); }
  progress("opening the database");
  db=new DatabaseSync(path,databaseOptions);
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=67108864; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const pageSize=Number(db.prepare("PRAGMA page_size").get()!.page_size);
  db.exec(`PRAGMA max_page_count=${Math.floor(config.limits.databaseBytes/pageSize)}`);
  if (!config.checkpointPath) {
    progress("creating the schema");
    authorize(db,{tables:config.tables},{initializing:true});
    appCode(()=>db!.exec(config.schemaSql));db.setAuthorizer(null);
  }
  progress("checking the schema");
  verifyDatasetSchema(db,config.schemaSql,config.tables,config.limits,false,budgets);
  progress("recording the dataset cursor");
  const existing=db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(marker);
  if (existing) {
    if (existing.sql!==markerSchema) reject("invalid_checkpoint","Invalid checkpoint cursor schema.");
    const rows=db.prepare(`SELECT scope,revision,digest FROM ${marker}`).all();
    if (rows.length!==1 || rows[0].scope!==JSON.stringify(config.scope) || rows[0].revision!==config.cursor.revision || rows[0].digest!==config.cursor.digest) reject("invalid_checkpoint","Checkpoint cursor does not match the host manifest.");
  } else {
    if(config.requireCheckpointCursor) reject("invalid_checkpoint","Cached checkpoint has no committed cursor.");
    db.exec(markerSchema);
    db.prepare(`INSERT INTO ${marker} VALUES(1,?,?,?)`).run(JSON.stringify(config.scope),config.cursor.revision,config.cursor.digest);
  }
  cursor={...config.cursor};
  return cursor;
}

async function handle(command:PersistentCommand):Promise<PersistentResult> {
  if (command.kind==="open") return initialize(command.input);
  if (!db) reject("invalid_state","The worker is not open.");
  if (command.kind==="close") { progress("closing the database");rollback();db.close();db=undefined;lease?.close();lease=undefined;return null; }
  if (command.kind==="discard") {
    if (!pending || pending.id!==command.proposalId) reject("invalid_state","Unknown prepared operation.");
    rollback();return null;
  }
  if (command.kind==="finalize") {
    if (!pending || pending.id!==command.input.proposalId) reject("invalid_state","Unknown prepared operation.");
    nextCursor(command.input);
    if (command.input.changesetSha256!==pending.changesetSha256) reject("invalid_input","The committed changeset differs from the prepared operation.");
    progress("committing the operation");
    writeMarker(command.input);db.exec("COMMIT");transaction=false;pending=undefined;
    cursor={revision:command.input.revision,digest:command.input.digest};return cursor;
  }
  requireIdle();
  if(command.kind==="applyBatch") {
    if(!Array.isArray(command.input)||!command.input.length||command.input.length>REPLAY_BATCH_EVENTS)reject("invalid_input","Invalid replay batch size.");
    let bytes=0;
    for(const event of command.input)if(!(event.changeset instanceof Uint8Array)||(bytes+=event.changeset.byteLength)>REPLAY_BATCH_BYTES)reject("invalid_input","Invalid replay batch bytes.");
    // Each event retains the same validation and atomic rows/cursor commit as individual recovery.
    for(const [index,event] of command.input.entries()){progress(`replaying journal event ${index+1} of ${command.input.length}`);await handle({kind:"apply",input:event});}
    // Only the batch's final state is ever served or copied, and a failed batch
    // closes this disposable copy, so one foreign-key check covers every event.
    progress("checking the replayed foreign keys");
    if(!foreignKeysHold(db)) reject("invalid_changeset","The committed changesets violate a foreign-key constraint.");
    return {...cursor};
  }
  if (command.kind==="prepare") {
    progress("running the app operation");
    expectCursor(command.expected);
    db.exec(command.guest.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");transaction=true;
    const session=db.createSession();
    let resultJson:string, attachedFileIds:string[], changeset:Uint8Array;
    try {
      ({resultJson,attachedFileIds}=await appCode(()=>evaluate(db!,{...command.guest,tables:config.tables,limits:config.limits},{persistentConnection:true})));
      db.setAuthorizer(null);changeset=session.changeset();
    } finally { session.close(); }
    if (!db.isTransaction) reject("invalid_changeset","The prepared operation transaction ended.");
    progress("checking the operation's foreign keys");
    if (!foreignKeysHold(db)) reject("invalid_changeset","The prepared operation violates a foreign-key constraint.");
    if (changeset.byteLength>config.limits.databaseBytes) reject("resource_limit","The changeset exceeds the dataset storage reservation.");
    const changesetSha256=digest(changeset), proposalId=randomUUID();
    if (command.guest.readOnly) {
      if (changeset.byteLength || attachedFileIds.length) reject("invalid_state","A read operation changed the dataset.");
      rollback();
    } else pending={id:proposalId,changesetSha256};
    return {proposalId,readOnly:command.guest.readOnly,result:JSON.parse(resultJson),changeset,changesetSha256,attachedFileIds};
  }
  if (command.kind==="apply") {
    if(!batching) progress("replaying the journal event");
    // Each event passed the app's CPU budget when it was prepared, so each gets the whole budget again.
    appCharged=0n;
    nextCursor(command.input);
    const {changeset,changesetSha256}=command.input;
    if (!(changeset instanceof Uint8Array) || changeset.byteLength>config.limits.databaseBytes || digest(changeset)!==changesetSha256) reject("invalid_input","Invalid committed changeset.");
    const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    let constraintConflict=false, forbidden=false;
    // The changeset already contains trigger and foreign-key actions from the writer.
    // Recovery copies durable host events into a disposable worker, never into the authority store.
    db.exec("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
    try {
      db.exec("BEGIN IMMEDIATE");transaction=true;
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"','""')}"`);
      // Applying runs the app's indexes and generated columns.
      const applied=changeset.byteLength===0 || appCode(()=>db!.applyChangeset(changeset,{
        filter:table=>{ const allowed=config.tables.includes(table); if (!allowed) forbidden=true;return allowed; },
        onConflict:kind=>{constraintConflict=kind===changesetConstraint;return constants.SQLITE_CHANGESET_ABORT;},
      }));
      if (!applied || forbidden || (!batching && !foreignKeysHold(db))) reject("invalid_changeset","The committed changeset cannot be applied to this dataset.");
      for (const trigger of triggers) db.exec(String(trigger.sql));
      writeMarker(command.input);db.exec("COMMIT");transaction=false;
      cursor={revision:command.input.revision,digest:command.input.digest};return cursor;
    } catch (error) {
      rollback();
      if(!constraintConflict || forbidden) throw error;
      replayThroughShadow(db,{directory:config.directory,tables:config.tables,changeset,databaseBytes:config.limits.databaseBytes},()=>writeMarker(command.input),{progress,datasetCheck});
      cursor={revision:command.input.revision,digest:command.input.digest};return cursor;
    }
    finally { db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF"); }
  }
  if (command.kind==="migrateCheckpoint") {
    progress("copying the dataset for the migration");
    noLinks(command.input.path,true);
    if(command.input.reportPath) noLinks(command.input.reportPath,true);
    const copyPath=join(config.directory,`migration-${randomUUID()}.sqlite`);
    let copy:DatabaseSync | undefined, outputReserved=false, reportCreated=false, succeeded=false;
    try {
      closeSync(openSync(copyPath,"wx",0o600));
      db.prepare("VACUUM INTO ?").run(copyPath);
      copy=new DatabaseSync(copyPath,databaseOptions);
      // Pure conversion helpers exist only in the disposable migration copy, never in app execution or the saved schema.
      copy.function("dohc_migration_number", {deterministic:true}, value => typeof value === "string" ? losslessDatasetNumber(value) : null);
      copy.function("dohc_migration_number_text", {deterministic:true}, value => typeof value === "number" ? datasetNumberText(value) : null);
      copy.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=OFF;");
      const pageSize=Number(copy.prepare("PRAGMA page_size").get()!.page_size);
      copy.exec(`PRAGMA max_page_count=${Math.floor(config.limits.databaseBytes/pageSize)}`);
      progress("running the migration");
      copy.exec(`BEGIN IMMEDIATE; DROP TABLE ${marker}`);
      authorizeMigration(copy,[...new Set([...config.tables,...command.input.tables])]);
      const migrationCopy=copy;
      appCode(()=>migrationCopy.exec(command.input.migrationSql));copy.setAuthorizer(null);
      if (copy.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(marker)) reject("invalid_checkpoint","Migration introduced internal metadata.");
      progress("checking the migrated schema");
      verifyDatasetSchema(copy,command.input.schemaSql,command.input.tables,config.limits,command.input.schemaSql!==config.schemaSql,budgets);
      progress("saving the migrated copy");
      copy.exec("COMMIT");
      const previewing="writing the migration preview";
      if(command.input.reportPath) progress(previewing);
      // Reading every row computes the app's virtual generated columns.
      const {reportPath}=command.input, before=db, after=copy;
      const report=reportPath ? datasetCheck(databaseBytes(before)+databaseBytes(after),()=>createMigrationPreviewReport({before,after,beforeTables:config.tables,
        afterTables:command.input.tables,path:reportPath,maxBytes:config.limits.databaseBytes,heartbeat:()=>progress(previewing)})) : undefined;
      reportCreated=Boolean(report);
      progress("writing the migrated checkpoint");
      closeSync(openSync(command.input.path,"wx",0o600));outputReserved=true;
      copy.prepare("VACUUM INTO ?").run(command.input.path);
      succeeded=true;
      return {path:command.input.path,cursor:{...cursor},...(report ? {report} : {})};
    } finally {
      if (copy) {copy.setAuthorizer(null);copy.close();}
      for (const path of [copyPath,copyPath+"-journal",...(outputReserved && !succeeded ? [command.input.path] : []),...(!succeeded && reportCreated && command.input.reportPath ? [command.input.reportPath] : [])]) {
        try {unlinkSync(path);} catch (error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
      }
    }
  }
  noLinks(command.path,true);
  // This connection and its IPC lane are idle and exclusive until the copy completes.
  progress("checkpointing the database");
  const checkpoint=db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all()[0]!;
  if(checkpoint.busy!==0||checkpoint.log!==0||checkpoint.checkpointed!==0)reject("invalid_checkpoint","The worker WAL could not be fully checkpointed.");
  progress("copying the snapshot");
  copyFileSync(join(config.directory,"app.sqlite"),command.path,fsConstants.COPYFILE_EXCL);
  return {path:command.path,cursor:{...cursor}};
}

const parentPort=(process as unknown as {parentPort?:{on(event:"message",callback:(event:{data:{id:number;command:PersistentCommand}})=>void):void;postMessage(message:PersistentReply):void}}).parentPort;
const send=(reply:PersistentReply|PersistentProgress)=>parentPort ? (parentPort.postMessage as (message:PersistentReply|PersistentProgress)=>void)(reply) : process.send!(reply);
let activeId:number|undefined;
let batching=false;
let step="";
// The CPU budget of the dataset check running now. The host lets its step stay quiet long enough to use it.
let checkBudgetMs:number|undefined;
// Reports the step this command starts, so the host can tell slow work from a stopped worker.
function progress(next:string):void {
  step=next;
  if(activeId!==undefined) send({id:activeId,progress:next,...(checkBudgetMs===undefined ? {} : {cpuBudgetMs:checkBudgetMs})});
}
async function receive(message:{id:number;command:PersistentCommand}):Promise<void> {
  if (busy) { send({id:message.id,ok:false,code:"busy",error:"The worker is busy."});return; }
  busy=true;activeId=message.id;batching=message.command.kind==="applyBatch";
  // Each command gets the whole budget. Every step disarmed itself before
  // this command replies, so the watch cannot end the worker after the reply.
  appCharged=0n;
  try {
    const result=await handle(message.command);
    send({id:message.id,ok:true,result});
  } catch (error) {
    // An invalid command must not silently discard an already prepared operation.
    if (transaction && !pending) rollback();
    if(message.command.kind==="open"||message.command.kind==="applyBatch") {db?.setAuthorizer(null);db?.close();db=undefined;lease?.close();lease=undefined;}
    send({id:message.id,ok:false,error:error instanceof Error ? error.message.slice(0,1024) : "Dataset operation failed.",
      code:error instanceof PersistentRuntimeError ? error.code : "operation_failed",
      ...(error instanceof AppBackendRuntimeError ? {refusal:error.refusal} : {})});
  } finally { busy=false;activeId=undefined;batching=false; }
}
if (parentPort) parentPort.on("message",({data})=>void receive(data));
else { process.on("message",message=>void receive(message as {id:number;command:PersistentCommand}));process.on("disconnect",()=>{try {rollback();db?.close();lease?.close();} finally {process.exit(0);} }); }
