import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDatasetJournal, type CommitOperationInput, type DatasetCursor, type DatasetScope, type JournalOptions, type TransitionCheckpointInput } from "./journal.ts";

const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
// These probes use FULL durability on real files, including close/reopen recovery.
vi.setConfig({testTimeout:20000});
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();});
const schemaSql="CREATE TABLE stock(id TEXT PRIMARY KEY NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0)); INSERT INTO stock VALUES('item',3); CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL,quantity INTEGER NOT NULL);";
function fixture(limits:Partial<JournalOptions>={}) {
  const directory=mkdtempSync(join(tmpdir(),"dohc-journal-"));
  const opened=new Set<DatabaseSync>();
  const open=(name:string)=>{const db=new DatabaseSync(join(directory,name));db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");opened.add(db);return db;};
  cleanups.push(()=>{for(const db of opened){try{db.close();}catch{}}rmSync(directory,{recursive:true,force:true});});
  const seed=new DatabaseSync(join(directory,"seed.sqlite"));seed.exec(schemaSql);seed.close();
  const checkpoint=readFileSync(join(directory,"seed.sqlite"));
  let db=open("journal.sqlite"),fault:"before"|"after"|undefined;
  db.exec("CREATE TABLE grants(allowed INTEGER NOT NULL); INSERT INTO grants VALUES(1); CREATE TABLE accounting(bytes INTEGER NOT NULL); INSERT INTO accounting VALUES(0); CREATE TABLE uploads(id TEXT PRIMARY KEY,attached INTEGER NOT NULL); INSERT INTO uploads VALUES('receipt_file_0001',0);");
  function transaction<T>(run:()=>T):T {
    db.exec("BEGIN IMMEDIATE");let committed=false;
    try {const result=run();if(fault==="before"){fault=undefined;throw Error("power loss before commit");}db.exec("COMMIT");committed=true;if(fault==="after"){fault=undefined;throw Error("acknowledgment lost");}return result;}
    catch(error){if(!committed)db.exec("ROLLBACK");throw error;}
  }
  const authorize=()=>{if(db.prepare("SELECT allowed FROM grants").get()!.allowed!==1)throw Error("denied");};
  let journal=createDatasetJournal({db,transaction,nowMs:()=>123,...limits});
  const scope:DatasetScope={workspaceId:"workspace",datasetId:"inventory"};
  const initialization={scope,hostEpoch:"host-1",approvedRevisionHash:digest("approved"),source:"globalThis.operations = {};",schemaSql,definitionJson:'{"version":1}',checkpoint,authorize};
  const initial=journal.initialize(initialization);
  function prepare(expected:DatasetCursor=initial,key="order-1"):CommitOperationInput {
    const data=new DatabaseSync(":memory:");data.exec(schemaSql);
    const session=data.createSession();
    data.exec("BEGIN IMMEDIATE");data.prepare("UPDATE stock SET remaining=remaining-1 WHERE id='item'").run();data.prepare("INSERT INTO orders VALUES(?,1)").run(key);
    const changeset=session.changeset();session.close();data.exec("ROLLBACK");data.close();
    return {expected,proposalId:`proposal-${key}`,operation:"reserve",callerKey:"verified-owner",idempotencyKey:key,payloadSha256:digest(key),resultJson:JSON.stringify({id:key}),changeset,changesetSha256:digest(changeset),attachedFileIds:[],authorize};
  }
  return {directory,scope,initial,initialization,prepare,authorize,transaction,get db(){return db;},get journal(){return journal;},
    fault(value:"before"|"after"){fault=value;},revoke(){db.exec("UPDATE grants SET allowed=0");},
    reopen(){db.close();opened.delete(db);db=open("journal.sqlite");journal=createDatasetJournal({db,transaction,nowMs:()=>123,...limits});},
    materialize(){const exported=journal.checkpoint({scope,authorize});writeFileSync(join(directory,"restored.sqlite"),exported.bytes);const restored=open("restored.sqlite");for(const event of journal.events({scope,after:exported.cursor,authorize}).events){expect(restored.applyChangeset(event.changeset)).toBe(true);}return restored;}};
}

it("recovers real multi-table SQLite changes without running operation code",()=>{
  const f=fixture();const result=f.journal.commitOperation(f.prepare());expect(result.kind).toBe("committed");
  f.reopen();const db=f.materialize();expect(db.prepare("SELECT remaining FROM stock").get()!.remaining).toBe(2);expect(db.prepare("SELECT * FROM orders").all()).toEqual([{id:"order-1",quantity:1}]);
  expect(f.journal.checkpoint({scope:f.scope,authorize:f.authorize}).cursor).toEqual(f.initial);
  expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(1);
});
it("replays multi-table changes with deferred foreign keys",()=>{
  const f=fixture();const source=new DatabaseSync(":memory:"),restored=new DatabaseSync(":memory:");
  try {
    const schema="PRAGMA foreign_keys=ON; CREATE TABLE parents(id TEXT PRIMARY KEY NOT NULL); CREATE TABLE children(id TEXT PRIMARY KEY NOT NULL,parent TEXT REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);";
    source.exec(schema);restored.exec(schema);const session=source.createSession();source.exec("BEGIN; INSERT INTO children VALUES('child','parent'); INSERT INTO parents VALUES('parent'); COMMIT;");
    const changeset=session.changeset();session.close();const event=f.journal.commitOperation({...f.prepare(),changeset,changesetSha256:digest(changeset)});
    if(event.kind!=="committed")throw Error();expect(restored.applyChangeset(event.event.changeset)).toBe(true);
    expect(restored.prepare("SELECT * FROM children").all()).toEqual([{id:"child",parent:"parent"}]);expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {source.close();restored.close();}
});
it("commits quota, file association, receipt and journal together",()=>{
  const f=fixture();const input=f.prepare();input.attachedFileIds=["receipt_file_0001"];
  input.accountAndAttach=allocation=>{f.db.prepare("UPDATE accounting SET bytes=bytes+?").run(allocation.bytes);f.db.exec("UPDATE uploads SET attached=1");};
  f.journal.commitOperation(input);
  expect(Number(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes)).toBeGreaterThan(input.changeset.length);
  expect(f.db.prepare("SELECT attached FROM uploads").get()!.attached).toBe(1);
  expect(f.journal.receipt({...input,scope:f.scope})!.revision).toBe(1);
});
it("rolls back accounting and attachments on quota refusal",()=>{
  const f=fixture();const input=f.prepare();input.accountAndAttach=()=>{f.db.exec("UPDATE accounting SET bytes=999; UPDATE uploads SET attached=1");throw Error("quota");};
  expect(()=>f.journal.commitOperation(input)).toThrow("quota");expect(f.journal.head(f.scope,f.authorize).cursor).toEqual(f.initial);
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(0);expect(f.db.prepare("SELECT attached FROM uploads").get()!.attached).toBe(0);
  expect(f.journal.receipt({...input,scope:f.scope})).toBeNull();
});
it.each(["before","after"] as const)("resolves a fault %s authoritative commit from persisted state",fault=>{
  const f=fixture();f.fault(fault);expect(()=>f.journal.commitOperation(f.prepare())).toThrow(fault==="before"?"power loss":"acknowledgment");f.reopen();
  const replay=f.journal.commitOperation(f.prepare());expect(replay.kind).toBe(fault==="before"?"committed":"replayed");
  expect(f.materialize().prepare("SELECT count(*) AS n FROM orders").get()!.n).toBe(1);
});
it("rechecks revocation inside the actual host transaction after preparation",()=>{
  const f=fixture();const prepared=f.prepare();f.revoke();expect(()=>f.journal.commitOperation(prepared)).toThrow("denied");
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(0);
});
it("does not return receipts, history, header or checkpoint after withdrawal",()=>{
  const f=fixture();const input=f.prepare();f.journal.commitOperation(input);f.revoke();
  for(const read of [()=>f.journal.receipt({...input,scope:f.scope}),()=>f.journal.events({scope:f.scope,after:f.initial,authorize:f.authorize}),()=>f.journal.head(f.scope,f.authorize),()=>f.journal.checkpoint({scope:f.scope,authorize:f.authorize}),()=>f.journal.commitOperation(input)])expect(read).toThrow("denied");
});
it("rechecks authority after accounting callbacks and rolls their changes back",()=>{
  const f=fixture();const input=f.prepare();input.accountAndAttach=()=>f.revoke();expect(()=>f.journal.commitOperation(input)).toThrow("denied");
  expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(0);
});
it("preserves retry identity after restart and rejects changed payloads",()=>{
  const f=fixture();const first=f.journal.commitOperation(f.prepare());f.reopen();
  expect(f.journal.commitOperation(f.prepare())).toEqual({kind:"replayed",receipt:first.receipt});
  expect(()=>f.journal.commitOperation({...f.prepare(),payloadSha256:digest("changed")})).toThrow("another payload");
});
it("rejects stale competing writes without inserting a second receipt",()=>{
  const f=fixture();f.journal.commitOperation(f.prepare());expect(()=>f.journal.commitOperation(f.prepare(f.initial,"order-2"))).toThrow("cursor changed");
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_receipts").get()!.n).toBe(1);
});
it("isolates matching dataset and retry names across workspaces",()=>{
  const f=fixture();const other={workspaceId:"other-workspace",datasetId:f.scope.datasetId};
  const initial=f.journal.initialize({...f.initialization,scope:other});f.journal.commitOperation(f.prepare());f.journal.commitOperation(f.prepare(initial));
  expect(f.journal.events({scope:other,after:initial,authorize:f.authorize}).events[0].cursor.workspaceId).toBe(other.workspaceId);
  expect(()=>f.journal.events({scope:other,after:f.initial,authorize:f.authorize})).toThrow("scope");
});
it("fences the old host durably without deleting recovery data",()=>{
  const f=fixture();const result=f.journal.commitOperation(f.prepare());if(result.kind!=="committed")throw Error();
  f.journal.fence({expected:result.event.cursor,authorize:f.authorize});f.reopen();expect(f.journal.head(f.scope,f.authorize).active).toBe(false);
  expect(()=>f.journal.commitOperation(f.prepare())).toThrow("fenced");expect(()=>f.journal.receipt({...f.prepare(),scope:f.scope})).toThrow("fenced");
  expect(()=>f.journal.initialize(f.initialization)).toThrow("fenced");expect(f.journal.events({scope:f.scope,after:f.initial,authorize:f.authorize}).events).toHaveLength(1);
});
it("rejects stale transfer fences",()=>{
  const f=fixture();f.journal.commitOperation(f.prepare());expect(()=>f.journal.fence({expected:f.initial,authorize:f.authorize})).toThrow("cursor changed");expect(f.journal.head(f.scope,f.authorize).active).toBe(true);
});
it.each(["result","changeset","receipt","gap","tail","checkpoint","definition"])("detects persisted %s damage",kind=>{
  const f=fixture();let head=f.initial;
  for(let n=0;n<3;n++){const result=f.journal.commitOperation(f.prepare(head,`order-${n}`));if(result.kind==="committed")head=result.event.cursor;}
  if(kind==="result")f.db.exec("UPDATE dohc_dataset_events SET result_json='null' WHERE revision=1");
  if(kind==="changeset")f.db.exec("UPDATE dohc_dataset_events SET changeset=x'00' WHERE revision=1");
  if(kind==="receipt")f.db.exec("UPDATE dohc_dataset_receipts SET result_json='null' WHERE revision=1");
  if(kind==="gap")f.db.exec("DELETE FROM dohc_dataset_events WHERE revision=2");
  if(kind==="tail")f.db.exec("DELETE FROM dohc_dataset_events WHERE revision=3");
  if(kind==="checkpoint")f.db.exec("UPDATE dohc_dataset_journals SET checkpoint=x'00'");
  if(kind==="definition")f.db.exec("UPDATE dohc_dataset_journals SET definition_json='{}'");
  const action=kind==="receipt"?()=>f.journal.receipt({...f.prepare(f.initial,"order-0"),scope:f.scope}):["checkpoint","definition"].includes(kind)?()=>f.journal.checkpoint({scope:f.scope,authorize:f.authorize}):()=>f.journal.events({scope:f.scope,after:f.initial,authorize:f.authorize});
  expect(action).toThrow(/damaged|mismatch|missing|broken|integrity|differs/);
});
it("bounds journal pages by bytes and rejects invented cursors",()=>{
  const f=fixture();let head=f.initial;
  for(let n=0;n<3;n++){const result=f.journal.commitOperation(f.prepare(head,`order-${n}`));if(result.kind==="committed")head=result.event.cursor;}
  const one=Number(f.db.prepare("SELECT storage_bytes FROM dohc_dataset_events WHERE revision=1").get()!.storage_bytes);
  const page=f.journal.events({scope:f.scope,after:f.initial,authorize:f.authorize,byteLimit:one});expect(page.events).toHaveLength(1);
  expect(f.journal.events({scope:f.scope,after:page.events[0].cursor,authorize:f.authorize}).events).toHaveLength(2);
  expect(()=>f.journal.events({scope:f.scope,after:f.initial,authorize:f.authorize,byteLimit:1})).toThrow("byte limit");
  expect(()=>f.journal.events({scope:f.scope,after:{...f.initial,digest:digest("fake")},authorize:f.authorize})).toThrow("cursor changed");
});
it("copies operation bytes and identities before authorization callbacks",()=>{
  const f=fixture();const input=f.prepare();const original=new Uint8Array(input.changeset);const originalResult=input.resultJson;
  input.expected={...input.expected};input.authorize=()=>{f.authorize();input.changeset.fill(0);input.expected.datasetId="changed";input.resultJson="null";input.attachedFileIds=["receipt_file_0001"];};
  const result=f.journal.commitOperation(input);expect(result.kind).toBe("committed");if(result.kind!=="committed")throw Error();
  expect(result.event.changeset).toEqual(original);expect(result.event.resultJson).toBe(originalResult);expect(result.event.attachedFileIds).toEqual([]);expect(result.event.cursor.datasetId).toBe(f.scope.datasetId);
});
it("rejects asynchronous callbacks and rolls back thenable accounting",()=>{
  const f=fixture();expect(()=>f.journal.head(f.scope,async()=>{throw Error("must not run");})).toThrow("synchronous");
  const input=f.prepare();input.accountAndAttach=()=>{f.db.exec("UPDATE accounting SET bytes=999");return {then(){}};};
  expect(()=>f.journal.commitOperation(input)).toThrow("synchronous");expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(0);
  let ran=false;input.accountAndAttach=async()=>{ran=true;};expect(()=>f.journal.commitOperation(input)).toThrow("synchronous");expect(ran).toBe(false);
});
it("checks the commit head again after callbacks",()=>{
  const f=fixture();const input=f.prepare();input.accountAndAttach=()=>f.db.exec("UPDATE dohc_dataset_journals SET active=0");
  expect(()=>f.journal.commitOperation(input)).toThrow("cursor changed during commit");expect(f.journal.head(f.scope,f.authorize).active).toBe(true);
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(0);
});
it("accounts initialization once and refuses conflicting initialization",()=>{
  const f=fixture();let allocated=0;const scope={workspaceId:"workspace",datasetId:"second"};
  const initialize={...f.initialization,scope,capacityBytes:65536,account:(value:{bytes:number})=>{allocated+=value.bytes;}};
  f.journal.initialize(initialize);const first=allocated;f.journal.initialize(initialize);expect(allocated).toBe(first);expect(first).toBeGreaterThan(65536+f.initialization.checkpoint.length);
  expect(()=>f.journal.initialize({...initialize,source:"changed"})).toThrow("differs");
});
it("does not accept attachment references without host validation",()=>{
  const f=fixture();expect(()=>f.journal.commitOperation({...f.prepare(),attachedFileIds:["receipt_file_0001"]})).toThrow("host validation");
}, 20000);

function migration(f: ReturnType<typeof fixture>, expected:DatasetCursor):TransitionCheckpointInput {
  const db=f.materialize();
  db.exec("ALTER TABLE orders ADD COLUMN note TEXT NOT NULL DEFAULT ''; UPDATE orders SET note='migrated-once';");db.close();
  return {expected,hostEpoch:expected.hostEpoch,approvedRevisionHash:digest("approved-v2"),source:"globalThis.operations={version:2};",
    schemaSql:schemaSql.replace("quantity INTEGER NOT NULL)","quantity INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '')"),definitionJson:'{"version":2}',
    checkpoint:readFileSync(join(f.directory,"restored.sqlite")),authorize:f.authorize};
}
it("atomically activates a migrated checkpoint and preserves prior retries and recovery history",()=>{
  const f=fixture();const saved=f.journal.commitOperation(f.prepare());if(saved.kind!=="committed")throw Error();
  const input=migration(f,saved.event.cursor);let accounted=0;
  input.account=allocation=>{accounted+=allocation.bytes;expect(allocation.capacityDeltaBytes).toBe(0);f.db.prepare("UPDATE accounting SET bytes=bytes+?").run(allocation.bytes);};
  const next=f.journal.transitionCheckpoint(input);expect(next.revision).toBe(2);expect(next.approvedRevisionHash).toBe(input.approvedRevisionHash);expect(next.digest).not.toBe(saved.event.cursor.digest);
  f.reopen();expect(f.journal.checkpoint({scope:f.scope,authorize:f.authorize}).cursor).toEqual(next);
  expect(f.journal.head(f.scope,f.authorize).definitionJson).toBe(input.definitionJson);
  expect(f.journal.receipt({...f.prepare(),scope:f.scope})).toEqual(saved.receipt);
  expect(f.journal.commitOperation({...f.prepare(next),changeset:new Uint8Array(),changesetSha256:digest(new Uint8Array())})).toEqual({kind:"replayed",receipt:saved.receipt});
  expect(()=>f.journal.commitOperation({...f.prepare(next),payloadSha256:digest("changed")})).toThrow("another payload");
  const rows=f.db.prepare("SELECT revision,checkpoint FROM dohc_dataset_checkpoint_history").all();expect(rows).toHaveLength(1);expect(rows[0].revision).toBe(0);expect(rows[0].checkpoint).toEqual(new Uint8Array(f.initialization.checkpoint));
  expect(f.journal.checkpoint({scope:f.scope,revision:0,authorize:f.authorize}).cursor).toEqual(f.initial);
  expect(()=>f.journal.checkpoint({scope:f.scope,revision:1,authorize:f.authorize})).toThrow("not available");
  expect(()=>f.journal.checkpoint({scope:f.scope,revision:999,authorize:f.authorize})).toThrow("not available");
  const before=accounted;expect(f.journal.transitionCheckpoint(input)).toEqual(next);expect(accounted).toBe(before);
  expect(()=>f.journal.events({scope:f.scope,after:saved.event.cursor,authorize:f.authorize})).toThrow("Recover from its current checkpoint");
  expect(f.journal.events({scope:f.scope,after:next,authorize:f.authorize}).events).toEqual([]);
});
it("recovers the new schema without running the migration again",()=>{
  const f=fixture();const saved=f.journal.commitOperation(f.prepare());if(saved.kind!=="committed")throw Error();
  const input=migration(f,saved.event.cursor),next=f.journal.transitionCheckpoint(input);f.reopen();
  const checkpoint=f.journal.checkpoint({scope:f.scope,authorize:f.authorize});const path=join(f.directory,"after-migration.sqlite");writeFileSync(path,checkpoint.bytes);const db=new DatabaseSync(path);
  try {
    expect(db.prepare("SELECT * FROM orders").all()).toEqual([{id:"order-1",quantity:1,note:"migrated-once"}]);
    const session=db.createSession();db.exec("BEGIN; UPDATE orders SET note='after-migration';");const changeset=session.changeset();session.close();db.exec("ROLLBACK");
    const committed=f.journal.commitOperation({...f.prepare(next,"edit-order"),changeset,changesetSha256:digest(changeset)});if(committed.kind!=="committed")throw Error();
    const page=f.journal.events({scope:f.scope,after:next,authorize:f.authorize});expect(page.events).toHaveLength(1);expect(page.events[0].cursor.revision).toBe(3);
    expect(db.applyChangeset(page.events[0].changeset)).toBe(true);expect(db.prepare("SELECT note FROM orders").get()!.note).toBe("after-migration");
  } finally {db.close();}
});
it.each(["before","after"] as const)("resolves checkpoint transition fault %s commit",fault=>{
  const f=fixture();const input=migration(f,f.initial);f.fault(fault);expect(()=>f.journal.transitionCheckpoint(input)).toThrow(fault==="before"?"power loss":"acknowledgment");
  f.reopen();expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(fault==="before"?0:1);
  const next=f.journal.transitionCheckpoint(input);expect(next.revision).toBe(1);expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_checkpoint_history").get()!.n).toBe(1);
});
it("failed migration approval leaves old source, cursor, data and catalog untouched",()=>{
  const f=fixture();const input=migration(f,f.initial),before=f.journal.checkpoint({scope:f.scope,authorize:f.authorize});
  input.account=()=>{f.db.exec("UPDATE accounting SET bytes=123");throw Error("approval changed");};
  expect(()=>f.journal.transitionCheckpoint(input)).toThrow("approval changed");f.reopen();
  expect(f.journal.checkpoint({scope:f.scope,authorize:f.authorize})).toEqual(before);expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_checkpoint_history").get()!.n).toBe(0);
});
it("refuses checkpoint transition after a competing write or withdrawal",()=>{
  const f=fixture(),input=migration(f,f.initial);f.journal.commitOperation(f.prepare());expect(()=>f.journal.transitionCheckpoint(input)).toThrow("cursor changed");
  f.revoke();expect(()=>f.journal.transitionCheckpoint(input)).toThrow("denied");
});
it("never releases capacity or changes approved artifacts under the same hash",()=>{
  const f=fixture(),input=migration(f,f.initial);
  expect(()=>f.journal.transitionCheckpoint({...input,capacityBytes:4096})).toThrow("cannot release");
  expect(()=>f.journal.transitionCheckpoint({...input,approvedRevisionHash:f.initial.approvedRevisionHash})).toThrow("new approved revision");
});
it("retains every older checkpoint over multiple approved transitions",()=>{
  const f=fixture(),first=migration(f,f.initial);const second=f.journal.transitionCheckpoint(first);
  const third=f.journal.transitionCheckpoint({...first,expected:second,hostEpoch:"host-2",approvedRevisionHash:digest("approved-v3"),source:"globalThis.operations={version:3};",definitionJson:'{"version":3}'});
  expect(third.revision).toBe(2);expect(f.db.prepare("SELECT revision FROM dohc_dataset_checkpoint_history ORDER BY revision").all()).toEqual([{revision:0},{revision:1}]);
  f.reopen();expect(f.journal.checkpoint({scope:f.scope,authorize:f.authorize}).cursor).toEqual(third);
  expect(()=>f.journal.commitOperation(f.prepare(second))).toThrow("approval or host changed");
  expect(f.journal.checkpoint({scope:f.scope,revision:1,authorize:f.authorize}).cursor).toEqual(second);
  f.db.exec("UPDATE dohc_dataset_checkpoint_history SET definition_json='{}' WHERE revision=0");
  expect(()=>f.journal.checkpoint({scope:f.scope,revision:0,authorize:f.authorize})).toThrow("history is damaged");
});
