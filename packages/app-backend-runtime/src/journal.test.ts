import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it} from "vitest";
import { createDatasetJournal, type CommitOperationInput, type DatasetCursor, type DatasetScope, type JournalOptions, type TransitionCheckpointInput } from "./journal.ts";

import { readDatasetHistory } from "./dataset-history.ts";
import type { DatasetRevision } from "@dohc/security-contract/dataset";

const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();});
const schemaSql="CREATE TABLE stock(id TEXT PRIMARY KEY NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0)); INSERT INTO stock VALUES('item',3); CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL,quantity INTEGER NOT NULL);";
function fixture(limits:Partial<JournalOptions>={}, approvalAgent?: import("@dohc/security-contract/approval-provenance").ApprovalAgent) {
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
  const initialization={...(approvalAgent ? {approvalAgent} : {}),scope,hostEpoch:"host-1",approvedRevisionHash:digest("approved"),source:"globalThis.operations = {};",schemaSql,definitionJson:'{"version":1}',checkpoint,authorize};
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

function materializationStage(f:ReturnType<typeof fixture>,bytes:Uint8Array=f.initialization.checkpoint,accounted=true) {
  const stage=f.journal.stageCheckpoint({scope:f.scope,expectedBytes:bytes.byteLength,sha256:digest(bytes),authorize:f.authorize,
    ...(accounted?{account:({bytes}:{bytes:number})=>{f.db.prepare("UPDATE accounting SET bytes=bytes+?").run(bytes);}}:{})});
  for(let offset=0,index=0;offset<bytes.byteLength;offset+=stage.chunkSize,index++)
    f.journal.appendCheckpointChunk({stage,index,bytes:bytes.subarray(offset,offset+stage.chunkSize),authorize:f.authorize});
  return f.journal.sealCheckpoint({stage,authorize:f.authorize});
}
function cacheAccount(f:ReturnType<typeof fixture>) {
  return ({bytes,stagedCreditBytes,releasedBytes}:{bytes:number;stagedCreditBytes:number;releasedBytes:number})=>{
    f.db.prepare("UPDATE accounting SET bytes=bytes+?").run(bytes-stagedCreditBytes-releasedBytes);
  };
}
it("keeps materialization caches outside authoritative history and retry lineage across restart",()=>{
  const f=fixture(),write=f.journal.commitOperation(f.prepare());if(write.kind!=="committed")throw Error();
  const expected=write.event.cursor;
  const before=f.journal.exportPage({scope:f.scope,through:expected,afterRevision:-1,authorize:f.authorize});
  const restored=f.materialize();restored.close();
  const bytes=readFileSync(join(f.directory,"restored.sqlite")),checkpoint=materializationStage(f,bytes);
  const cache=f.journal.cacheMaterialization({expected,checkpoint,authorize:f.authorize,account:cacheAccount(f)});
  f.reopen();
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toEqual(cache);
  expect(f.journal.materializationBlob({scope:f.scope,cache,offset:0,authorize:f.authorize})).toEqual(new Uint8Array(bytes));
  expect(f.journal.head(f.scope,f.authorize).cursor).toEqual(expected);
  expect(f.journal.checkpoint({scope:f.scope,authorize:f.authorize}).cursor).toEqual(f.initial);
  expect(f.journal.exportPage({scope:f.scope,through:expected,afterRevision:-1,authorize:f.authorize})).toEqual(before);
  expect(f.journal.commitOperation(f.prepare()).kind).toBe("replayed");
  const next=f.journal.commitOperation(f.prepare(expected,"order-2"));expect(next.kind).toBe("committed");
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toEqual(cache);
  expect(f.journal.events({scope:f.scope,after:cache.cursor,authorize:f.authorize}).events).toHaveLength(1);
});
it.each(["before","after"] as const)("keeps cache install and accounting atomic across a fault %s commit",fault=>{
  const f=fixture(),checkpoint=materializationStage(f),reserved=f.db.prepare("SELECT bytes FROM accounting").get()!.bytes;
  f.fault(fault);
  expect(()=>f.journal.cacheMaterialization({expected:f.initial,checkpoint,authorize:f.authorize,account:cacheAccount(f)})).toThrow();
  f.reopen();
  const cache=f.journal.materialization({scope:f.scope,authorize:f.authorize});
  expect(cache===null).toBe(fault==="before");
  expect(f.journal.head(f.scope,f.authorize).cursor).toEqual(f.initial);
  if(fault==="before") {
    expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(reserved);
    f.journal.cacheMaterialization({expected:f.initial,checkpoint,authorize:f.authorize,account:cacheAccount(f)});
  } else expect(()=>f.journal.cacheMaterialization({expected:f.initial,checkpoint,authorize:f.authorize,account:cacheAccount(f)})).toThrow("already saved");
});
it.each(["missing blob","chunk"])("falls back from a damaged cache %s without changing the journal",damage=>{
  const f=fixture(),cache=f.journal.cacheMaterialization({expected:f.initial,checkpoint:materializationStage(f),authorize:f.authorize,account:cacheAccount(f)});
  if(damage==="cursor")f.db.prepare("UPDATE dohc_dataset_materializations SET cursor_json=?").run("invalid json");
  if(damage==="epoch")f.db.prepare("UPDATE dohc_dataset_materializations SET cursor_json=?").run(JSON.stringify({...cache.cursor,hostEpoch:"old-host"}));
  if(damage==="digest")f.db.prepare("UPDATE dohc_dataset_materializations SET cursor_json=?").run(JSON.stringify({...cache.cursor,digest:digest("wrong")}));
  if(damage==="missing blob"){
    f.db.prepare("DELETE FROM dohc_dataset_checkpoint_chunks WHERE stage_id=?").run(cache.checkpointId);
    f.db.prepare("DELETE FROM dohc_dataset_checkpoints WHERE stage_id=?").run(cache.checkpointId);
  }
  if(damage==="chunk")f.db.prepare("UPDATE dohc_dataset_checkpoint_chunks SET bytes=? WHERE stage_id=? AND chunk_index=0").run(new Uint8Array([1]),cache.checkpointId);
  if(damage!=="chunk")expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  expect(f.journal.materializationBlob({scope:f.scope,cache,offset:0,authorize:f.authorize})).toBeNull();
  expect(f.journal.checkpoint({scope:f.scope,authorize:f.authorize}).cursor).toEqual(f.initial);
  expect(f.journal.head(f.scope,f.authorize).cursor).toEqual(f.initial);
});
it.each(["transition"])("invalidates and refunds the cache on a checkpoint %s",kind=>{
  const f=fixture(),account=cacheAccount(f),cache=f.journal.cacheMaterialization({expected:f.initial,checkpoint:materializationStage(f),authorize:f.authorize,account});
  const cacheCost=Number(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes);
  const baseline=fixture();let baselineBytes=0;
  if(kind==="claim")baseline.journal.fence({expected:baseline.initial,authorize:baseline.authorize});
  const baselineInput={...baseline.initialization,expected:baseline.initial,hostEpoch:"new-host",account:({bytes}:{bytes:number})=>{baselineBytes=bytes;}};
  if(kind==="claim")baseline.journal.claimInactiveCheckpoint(baselineInput);else baseline.journal.transitionCheckpoint(baselineInput);
  if(kind==="claim")f.journal.fence({expected:f.initial,authorize:f.authorize});
  let allocationBytes=0;
  const input={...f.initialization,expected:f.initial,hostEpoch:"new-host",account:({bytes,stagedCreditBytes}:{bytes:number;stagedCreditBytes:number})=>{
    allocationBytes=bytes;f.db.prepare("UPDATE accounting SET bytes=bytes+?").run(bytes-stagedCreditBytes);
  }};
  const next=kind==="claim"?f.journal.claimInactiveCheckpoint(input):f.journal.transitionCheckpoint(input);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  expect(f.db.prepare("SELECT 1 FROM dohc_dataset_checkpoints WHERE stage_id=?").get(cache.checkpointId)).toBeUndefined();
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(cacheCost+allocationBytes);
  expect(allocationBytes).toBe(baselineBytes-cacheCost);
  expect(f.journal.checkpoint({scope:f.scope,revision:0,authorize:f.authorize}).cursor).toEqual(f.initial);
  expect(f.journal.head(f.scope,f.authorize).cursor).toEqual(next);
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
it("does not return receipts, history, header or checkpoint after withdrawal",()=>{
  const f=fixture();const input=f.prepare();f.journal.commitOperation(input);f.revoke();
  for(const read of [()=>f.journal.receipt({...input,scope:f.scope}),()=>f.journal.events({scope:f.scope,after:f.initial,authorize:f.authorize}),()=>f.journal.head(f.scope,f.authorize),()=>f.journal.checkpoint({scope:f.scope,authorize:f.authorize}),()=>f.journal.commitOperation(input)])expect(read).toThrow("denied");
});
it("isolates matching dataset and retry names across workspaces",()=>{
  const f=fixture();const other={workspaceId:"other-workspace",datasetId:f.scope.datasetId};
  const initial=f.journal.initialize({...f.initialization,scope:other});f.journal.commitOperation(f.prepare());f.journal.commitOperation(f.prepare(initial));
  expect(f.journal.events({scope:other,after:initial,authorize:f.authorize}).events[0].cursor.workspaceId).toBe(other.workspaceId);
  expect(()=>f.journal.events({scope:other,after:f.initial,authorize:f.authorize})).toThrow("The Collection changed. Try again.");
});
it("permanently deletes journal history and every checkpoint while preserving other scopes",()=>{
  const f=fixture();f.db.exec("PRAGMA foreign_keys=ON");
  const otherScope={...f.scope,workspaceId:"another-workspace"};
  const other=f.journal.initialize({...f.initialization,scope:otherScope});
  const committed=f.journal.commitOperation(f.prepare());if(committed.kind!=="committed")throw Error();
  const expected=f.journal.transitionCheckpoint({...f.initialization,expected:committed.event.cursor});
  const staged=f.journal.stageCheckpoint({scope:f.scope,expectedBytes:3,sha256:digest(new Uint8Array([1,2,3])),authorize:f.authorize});
  f.journal.appendCheckpointChunk({stage:staged,index:0,bytes:new Uint8Array([1,2,3]),authorize:f.authorize});
  f.journal.destroy({expected,authorize:f.authorize,cleanup(){
    expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events WHERE workspace_id=?").get(f.scope.workspaceId)!.n).toBe(1);
    expect(f.db.prepare("SELECT active FROM dohc_dataset_journals WHERE workspace_id=?").get(f.scope.workspaceId)!.active).toBe(0);
    f.db.exec("UPDATE accounting SET bytes=123; DELETE FROM uploads");
  }});
  f.reopen();
  for(const table of ["dohc_dataset_journals","dohc_dataset_events","dohc_dataset_receipts","dohc_dataset_checkpoint_history","dohc_dataset_checkpoints"])
    expect(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=? AND dataset_id=?`).get(f.scope.workspaceId,f.scope.datasetId)!.n).toBe(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_checkpoint_chunks WHERE stage_id NOT IN (SELECT stage_id FROM dohc_dataset_checkpoints)").get()!.n).toBe(0);
  expect(f.db.prepare("SELECT * FROM dohc_dataset_deletions").all()).toEqual([{
    workspace_id:expected.workspaceId,dataset_id:expected.datasetId,host_epoch:expected.hostEpoch,
    approved_revision_hash:expected.approvedRevisionHash,revision:expected.revision,digest:expected.digest,deleted_at_ms:123,
  }]);
  expect(f.journal.head(otherScope,f.authorize).cursor).toEqual(other);
  expect(f.journal.checkpoint({scope:otherScope,authorize:f.authorize}).bytes).toEqual(new Uint8Array(f.initialization.checkpoint));
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(123);
});
it("blocks old operations, stages, initialization and authority claims after deletion and restart",()=>{
  const f=fixture(),operation=f.prepare();
  f.journal.commitOperation(operation);
  const expected=f.journal.head(f.scope,f.authorize).cursor;
  f.journal.destroy({expected,authorize:f.authorize});f.reopen();
  const transition={...f.initialization,expected,hostEpoch:"new-host"};
  for(const revive of [
    ()=>f.journal.assertNotDeleted(f.scope,f.authorize),
    ()=>f.journal.initialize(f.initialization),
    ()=>f.journal.commitOperation(operation),
    ()=>f.journal.receipt({...operation,scope:f.scope}),
    ()=>f.journal.stageCheckpoint({scope:f.scope,expectedBytes:0,sha256:digest(new Uint8Array()),authorize:f.authorize}),
    ()=>f.journal.transitionCheckpoint(transition),
    ()=>f.journal.claimInactiveCheckpoint(transition),
    ()=>f.journal.destroy({expected,authorize:f.authorize}),
  ])expect(revive).toThrow("permanently deleted");
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_checkpoints").get()!.n).toBe(0);
});
it.each(["changeset","receipt","gap","checkpoint"])("detects persisted %s damage",kind=>{
  const f=fixture();let head=f.initial;
  for(let n=0;n<3;n++){const result=f.journal.commitOperation(f.prepare(head,`order-${n}`));if(result.kind==="committed")head=result.event.cursor;}
  if(kind==="result")f.db.exec("UPDATE dohc_dataset_events SET result_json='null' WHERE revision=1");
  if(kind==="changeset")f.db.exec("UPDATE dohc_dataset_events SET changeset=x'00' WHERE revision=1");
  if(kind==="receipt")f.db.exec("UPDATE dohc_dataset_receipts SET result_json='null' WHERE revision=1");
  if(kind==="gap")f.db.exec("DELETE FROM dohc_dataset_events WHERE revision=2");
  if(kind==="tail")f.db.exec("DELETE FROM dohc_dataset_events WHERE revision=3");
  if(kind==="checkpoint")f.db.exec("UPDATE dohc_dataset_checkpoint_chunks SET bytes=x'00'");
  if(kind==="definition")f.db.exec("UPDATE dohc_dataset_journals SET definition_json='{}'");
  const action=kind==="receipt"?()=>f.journal.receipt({...f.prepare(f.initial,"order-0"),scope:f.scope}):["checkpoint","definition"].includes(kind)?()=>f.journal.checkpoint({scope:f.scope,authorize:f.authorize}):()=>f.journal.events({scope:f.scope,after:f.initial,authorize:f.authorize});
  expect(action).toThrow(/damaged|does not match|missing|gap/);
});
it("rejects asynchronous callbacks and rolls back thenable accounting",()=>{
  const f=fixture();expect(()=>f.journal.head(f.scope,async()=>{throw Error("must not run");})).toThrow("synchronous");
  const input=f.prepare();input.accountAndAttach=()=>{f.db.exec("UPDATE accounting SET bytes=999");return {then(){}};};
  expect(()=>f.journal.commitOperation(input)).toThrow("synchronous");expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(0);
  let ran=false;input.accountAndAttach=async()=>{ran=true;};expect(()=>f.journal.commitOperation(input)).toThrow("synchronous");expect(ran).toBe(false);
});

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
  expect(()=>f.journal.commitOperation({...f.prepare(next),payloadSha256:digest("changed")})).toThrow("already used for different values");
  const rows=f.db.prepare("SELECT revision,checkpoint_id FROM dohc_dataset_checkpoint_history").all();expect(rows).toHaveLength(1);expect(rows[0].revision).toBe(0);
  expect(f.journal.checkpoint({scope:f.scope,revision:0,authorize:f.authorize}).bytes).toEqual(new Uint8Array(f.initialization.checkpoint));
  expect(f.journal.checkpoint({scope:f.scope,revision:0,authorize:f.authorize}).cursor).toEqual(f.initial);
  expect(()=>f.journal.checkpoint({scope:f.scope,revision:1,authorize:f.authorize})).toThrow("no saved records for that point");
  expect(()=>f.journal.checkpoint({scope:f.scope,revision:999,authorize:f.authorize})).toThrow("no saved records for that point");
  const before=accounted;expect(f.journal.transitionCheckpoint(input)).toEqual(next);expect(accounted).toBe(before);
  expect(()=>f.journal.events({scope:f.scope,after:saved.event.cursor,authorize:f.authorize})).toThrow("The Collection's tables changed. Download it again.");
  expect(f.journal.events({scope:f.scope,after:next,authorize:f.authorize}).events).toEqual([]);
});

it("rolls back a failed claim and recovers lost claim acknowledgment without repeat accounting",()=>{
  const f=fixture(),input={...f.initialization,expected:f.initial,hostEpoch:"host-2",account(allocation:{bytes:number}){f.db.prepare("UPDATE accounting SET bytes=bytes+?").run(allocation.bytes);}};
  f.journal.fence({expected:f.initial,authorize:f.authorize});
  f.fault("before");expect(()=>f.journal.claimInactiveCheckpoint(input)).toThrow("power loss");
  expect(f.journal.head(f.scope,f.authorize).active).toBe(false);expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(0);
  f.fault("after");expect(()=>f.journal.claimInactiveCheckpoint(input)).toThrow("acknowledgment lost");
  const charged=f.db.prepare("SELECT bytes FROM accounting").get()!.bytes;f.reopen();
  expect(f.journal.claimInactiveCheckpoint(input)).toEqual(f.journal.head(f.scope,f.authorize).cursor);
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(charged);
});

it("refuses checkpoint transition after a competing write or withdrawal",()=>{
  const f=fixture(),input=migration(f,f.initial);f.journal.commitOperation(f.prepare());expect(()=>f.journal.transitionCheckpoint(input)).toThrow("The Collection changed. Try again.");
  f.revoke();expect(()=>f.journal.transitionCheckpoint(input)).toThrow("denied");
});

it("exports pinned immutable history while later writes and schema transitions continue",()=>{
  const f=fixture(); const first=f.journal.commitOperation(f.prepare());if(first.kind!=="committed")throw Error();
  const captured=f.journal.captureExport({scope:f.scope,authorize:f.authorize,capture:()=>({label:"approved original"})});
  expect(captured.cursor).toEqual(first.event.cursor);expect(captured.checkpoint.cursor).toEqual(f.initial);
  f.journal.transitionCheckpoint(migration(f,first.event.cursor));
  const records=f.journal.exportPage({scope:f.scope,through:captured.cursor,afterRevision:-1,authorize:f.authorize});
  expect(records.map(record=>[record.kind,record.cursor.revision])).toEqual([["checkpoint",0],["event",1]]);
  const checkpoint=f.journal.exportBlob({scope:f.scope,record:records[0],offset:0,authorize:f.authorize});
  expect(checkpoint).toEqual(new Uint8Array(f.initialization.checkpoint));
  expect(f.journal.exportBlob({scope:f.scope,record:records[1],offset:0,authorize:f.authorize})).toEqual(first.event.changeset);
  expect(records[1]).toMatchObject({resultJson:first.event.resultJson,idempotencyKey:first.event.idempotencyKey});
  f.revoke();expect(()=>f.journal.exportBlob({scope:f.scope,record:records[0],offset:0,authorize:f.authorize})).toThrow("denied");
});

function schemaHistory(f: ReturnType<typeof fixture>) {
  f.db.exec("CREATE TABLE IF NOT EXISTS dohc_dataset_automation_revisions(workspace_id,dataset_id,revision,automation_id,depth)");
  return readDatasetHistory(f.db,f.scope,{definition:{operations:[]}} as unknown as DatasetRevision,Number.MAX_SAFE_INTEGER,50).entries;
}
it("opens an older journal without changing its hashes or inventing checkpoint dates",()=>{
  const f=fixture(),input=migration(f,f.initial),old=f.journal.transitionCheckpoint(input);
  const legacy=f.journal.exportPage({scope:f.scope,through:old,afterRevision:-1,authorize:f.authorize}).map(record=>{
    if(record.kind!=="checkpoint")return record;
    const {recordedAtMs:_,...rest}=record;return rest;
  });
  f.db.exec("DROP TABLE IF EXISTS dohc_dataset_checkpoint_times");
  const saved=f.db.prepare("SELECT * FROM dohc_dataset_journals").all();
  f.reopen();
  expect(f.db.prepare("SELECT * FROM dohc_dataset_journals").all()).toEqual(saved);
  expect(f.journal.head(f.scope,f.authorize).cursor).toEqual(old);
  expect(schemaHistory(f)).toMatchObject([{revision:old.revision,recordedAtMs:null}]);
  expect(f.journal.exportPage({scope:f.scope,through:old,afterRevision:-1,authorize:f.authorize})).toEqual(legacy);
  const next=f.journal.transitionCheckpoint({...input,expected:old,approvedRevisionHash:digest("approved-v3"),source:"globalThis.operations={version:3};"});
  expect(schemaHistory(f)).toMatchObject([{revision:next.revision,recordedAtMs:123},{revision:old.revision,recordedAtMs:null}]);
  expect(f.db.prepare("SELECT revision FROM dohc_dataset_checkpoint_times").all()).toEqual([{revision:next.revision}]);
});
