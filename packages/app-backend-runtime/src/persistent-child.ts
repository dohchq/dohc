import { constants as fsConstants, copyFileSync, lstatSync, openSync, closeSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { authorize, evaluate } from "./guest.js";
import { AppBackendRuntimeError } from "./protocol.js";
import { checkCursor, checkDigest, digest, openRequest, PersistentRuntimeError, reject, trustedPath } from "./persistent-protocol.js";
import type { DatasetCursor, OpenRequest, PersistentCommand, PersistentReply, PersistentResult } from "./persistent-protocol.js";

let db:DatabaseSync | undefined;
let config:OpenRequest;
let cursor:DatasetCursor;
let pending:{id:string;changesetSha256:string} | undefined;
let transaction=false;
let busy=false;
const marker="dohc_applied";
const markerSchema=`CREATE TABLE ${marker}(id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL)`;
const databaseOptions={allowExtension:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false};
const userSchema="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name != 'dohc_applied' ORDER BY type,name";

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
  if (db) { db.setAuthorizer(null); if (transaction) db.exec("ROLLBACK"); }
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

function initialize(input:OpenRequest):DatasetCursor {
  if (db) reject("invalid_state","The worker is already open.");
  config=openRequest({...input,databaseBytes:input.limits.databaseBytes,limits:Object.fromEntries(Object.entries(input.limits).filter(([key])=>key!=="databaseBytes"))});
  noLinks(config.directory);
  if (!statSync(config.directory).isDirectory()) reject("invalid_input","Dataset directory is unavailable.");
  const path=join(config.directory,"app.sqlite");
  if (config.checkpointPath) {
    noLinks(config.checkpointPath);
    const info=statSync(config.checkpointPath);
    if (!info.isFile() || info.size<100 || info.size>config.limits.databaseBytes) reject("invalid_checkpoint","Invalid dataset checkpoint.");
    copyFileSync(config.checkpointPath,path,fsConstants.COPYFILE_EXCL);
  } else { closeSync(openSync(path,"wx",0o600)); }
  db=new DatabaseSync(path,databaseOptions);
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=67108864; PRAGMA busy_timeout=0;");
  const pageSize=Number(db.prepare("PRAGMA page_size").get()!.page_size);
  db.exec(`PRAGMA max_page_count=${Math.floor(config.limits.databaseBytes/pageSize)}`);
  const expected=new DatabaseSync(":memory:",databaseOptions);
  try {
    expected.exec(`PRAGMA trusted_schema=OFF; PRAGMA max_page_count=${Math.floor(config.limits.databaseBytes/4096)}`);
    authorize(expected,{tables:config.tables},{initializing:true});
    expected.exec(config.schemaSql);expected.setAuthorizer(null);
    const schema=expected.prepare(userSchema).all();
    if (schema.filter(row=>row.type==="table").length!==config.tables.length || schema.some(row=>!["table","index","trigger"].includes(String(row.type)))) reject("invalid_schema","Invalid dataset schema.");
    for (const table of config.tables) {
      const primary=expected.prepare(`PRAGMA table_info("${table}")`).all().filter(column=>Number(column.pk)>0);
      const rowid=primary.length===1 && String(primary[0].type).toUpperCase()==="INTEGER" && !expected.prepare(`PRAGMA index_list("${table}")`).all().some(index=>index.origin==="pk");
      if (!primary.length || (!rowid && primary.some(column=>Number(column.notnull)!==1))) reject("invalid_schema","Dataset tables require non-null primary keys.");
    }
    if (!config.checkpointPath) {
      authorize(db,{tables:config.tables},{initializing:true});
      db.exec(config.schemaSql);db.setAuthorizer(null);
    }
    if (JSON.stringify(db.prepare(userSchema).all())!==JSON.stringify(schema)) reject("invalid_checkpoint","Checkpoint schema does not match the approved dataset.");
  } finally { expected.close(); }
  if (db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check!=="ok" || !db.prepare("PRAGMA foreign_key_check").iterate().next().done) reject("invalid_checkpoint","Checkpoint integrity check failed.");
  const existing=db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(marker);
  if (existing) {
    if (existing.sql!==markerSchema) reject("invalid_checkpoint","Invalid checkpoint cursor schema.");
    const rows=db.prepare(`SELECT scope,revision,digest FROM ${marker}`).all();
    if (rows.length!==1 || rows[0].scope!==JSON.stringify(config.scope) || rows[0].revision!==config.cursor.revision || rows[0].digest!==config.cursor.digest) reject("invalid_checkpoint","Checkpoint cursor does not match the host manifest.");
  } else {
    db.exec(markerSchema);
    db.prepare(`INSERT INTO ${marker} VALUES(1,?,?,?)`).run(JSON.stringify(config.scope),config.cursor.revision,config.cursor.digest);
  }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  cursor={...config.cursor};
  return cursor;
}

async function handle(command:PersistentCommand):Promise<PersistentResult> {
  if (command.kind==="open") return initialize(command.input);
  if (!db) reject("invalid_state","The worker is not open.");
  if (command.kind==="close") { rollback();db.close();db=undefined;return null; }
  if (command.kind==="discard") {
    if (!pending || pending.id!==command.proposalId) reject("invalid_state","Unknown prepared operation.");
    rollback();return null;
  }
  if (command.kind==="finalize") {
    if (!pending || pending.id!==command.input.proposalId) reject("invalid_state","Unknown prepared operation.");
    nextCursor(command.input);
    if (command.input.changesetSha256!==pending.changesetSha256) reject("invalid_input","The committed changeset differs from the prepared operation.");
    writeMarker(command.input);db.exec("COMMIT");transaction=false;pending=undefined;
    cursor={revision:command.input.revision,digest:command.input.digest};return cursor;
  }
  requireIdle();
  if (command.kind==="prepare") {
    expectCursor(command.expected);
    db.exec(command.guest.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");transaction=true;
    const session=db.createSession();
    let resultJson:string, attachedFileIds:string[], changeset:Uint8Array;
    try {
      ({resultJson,attachedFileIds}=await evaluate(db,{...command.guest,tables:config.tables,limits:config.limits},{persistentConnection:true}));
      db.setAuthorizer(null);changeset=session.changeset();
    } finally { session.close(); }
    if (changeset.byteLength>config.limits.databaseBytes) reject("resource_limit","The changeset exceeds the dataset storage reservation.");
    const changesetSha256=digest(changeset), proposalId=randomUUID();
    if (command.guest.readOnly) {
      if (changeset.byteLength || attachedFileIds.length) reject("invalid_state","A read operation changed the dataset.");
      rollback();
    } else pending={id:proposalId,changesetSha256};
    return {proposalId,readOnly:command.guest.readOnly,result:JSON.parse(resultJson),changeset,changesetSha256,attachedFileIds};
  }
  if (command.kind==="apply") {
    nextCursor(command.input);
    const {changeset,changesetSha256}=command.input;
    if (!(changeset instanceof Uint8Array) || changeset.byteLength>config.limits.databaseBytes || digest(changeset)!==changesetSha256) reject("invalid_input","Invalid committed changeset.");
    const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    // The changeset already contains trigger and foreign-key actions from the writer.
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec("BEGIN IMMEDIATE");transaction=true;
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"','""')}"`);
      let forbidden=false;
      const applied=changeset.byteLength===0 || db.applyChangeset(changeset,{
        filter:table=>{ const allowed=config.tables.includes(table); if (!allowed) forbidden=true;return allowed; },
        onConflict:()=>constants.SQLITE_CHANGESET_ABORT,
      });
      if (!applied || forbidden || !db.prepare("PRAGMA foreign_key_check").iterate().next().done) reject("invalid_changeset","The committed changeset cannot be applied to this dataset.");
      for (const trigger of triggers) db.exec(String(trigger.sql));
      writeMarker(command.input);db.exec("COMMIT");transaction=false;
      cursor={revision:command.input.revision,digest:command.input.digest};return cursor;
    } catch (error) { rollback();throw error; }
    finally { db.exec("PRAGMA foreign_keys=ON"); }
  }
  noLinks(command.path,true);
  // SQLite refuses a nonempty destination; reserve exclusively so no existing file is touched.
  closeSync(openSync(command.path,"wx",0o600));
  db.prepare("VACUUM INTO ?").run(command.path);
  return {path:command.path,cursor:{...cursor}};
}

const parentPort=(process as unknown as {parentPort?:{on(event:"message",callback:(event:{data:{id:number;command:PersistentCommand}})=>void):void;postMessage(message:PersistentReply):void}}).parentPort;
const send=(reply:PersistentReply)=>parentPort ? parentPort.postMessage(reply) : process.send!(reply);
async function receive(message:{id:number;command:PersistentCommand}):Promise<void> {
  if (busy) { send({id:message.id,ok:false,code:"busy",error:"The worker is busy."});return; }
  busy=true;
  try {
    const result=await handle(message.command);
    send({id:message.id,ok:true,result});
  } catch (error) {
    // An invalid command must not silently discard an already prepared operation.
    if (transaction && !pending) rollback();
    send({id:message.id,ok:false,error:error instanceof Error ? error.message.slice(0,1024) : "Dataset operation failed.",
      code:error instanceof PersistentRuntimeError ? error.code : "operation_failed",
      ...(error instanceof AppBackendRuntimeError ? {refusal:error.refusal} : {})});
  } finally { busy=false; }
}
if (parentPort) parentPort.on("message",({data})=>void receive(data));
else { process.on("message",message=>void receive(message as {id:number;command:PersistentCommand}));process.on("disconnect",()=>{try {rollback();db?.close();} finally {process.exit(0);} }); }
