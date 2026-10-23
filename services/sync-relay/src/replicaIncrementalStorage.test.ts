import {afterEach, expect, it, vi} from "vitest";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {closeTestStorage, closeTestStorages, reopenTestStorage, sha256, storagePath, testStorage} from "./testing";
import type {StorageContext} from "./storage/context";
import {replicaHistoryReplacement} from "./storage/replicaHistoryPositions";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {tempRoot} from "./testing";
import {initializeReplicaHistoryWorkSchema} from "./storage/replicaHistoryWorkSchema";
import {ReplicaCurrentViewRefused} from "./storage/replicaCurrentViews";
import {registered,cleanupLiveDeliveryFixtures} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";

afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();cleanupLiveDeliveryFixtures();await closeTestStorages();});
async function fixture(count=4,distinct=false) {
  let storage=await testStorage();
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
    grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  const lease=createReplicaReadPrincipal(storage).issue("w","test");storage.bindReplicaCurrentView(lease);
  const texts=Array.from({length:distinct?count:1},(_,i)=>{const text=distinct?`document-${i}`:"shared";return {sha256:sha256(text),text};});
  const files=Array.from({length:count},(_,i)=>({versionId:"main",objectId:`o${i}`,path:`docs/${String(i).padStart(6,"0")}.md`,
    contentKind:"text" as const,sha256:texts[distinct?i:0]!.sha256,byteLength:Buffer.byteLength(texts[distinct?i:0]!.text),lineageClaimId:null,restoreGeneration:null}));
  const view={workspaceId:"w",revision:1,logCursor:0,journalCursor:0,files,omitted:[],texts};
  storage.storeReplicaCurrentView(lease,view);
  const input={grantId:"g",generation:1,principal:{kind:"user" as const,userId:"reader"}};
  return {get storage(){return storage;},lease,view,input,restart(){const path=storagePath(storage);closeTestStorage(storage);storage=reopenTestStorage(path);},
    get db(){return (storage as StorageContext).db;}};
}
it("R2: a refused History timer save reports once and does not sample or rearm",async()=>{
  const f=await fixture(1),errors:unknown[]=[];
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
  const due=vi.spyOn(f.storage,"nextReplicaHistoryPinAt").mockImplementation(()=>Date.now()+1000);
  const sample=vi.spyOn(f.storage,"sampleReplicaHistory").mockImplementation(()=>{throw new ReplicaCurrentViewRefused();});
  let view=f.view;
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("refused-history"),diskCheckMs:600_000,
    onError:(_,error)=>errors.push(error),startChild:async()=>({pull:async()=>{},close:async()=>{},
      currentView:async()=>({...view,delta:false,removed:[],refusedFiles:[],moved:false,nextCursor:null})})});
  try {
    await supervisor.activate("w");
    const text="changed";
    view={...view,revision:2,files:[{...view.files[0]!,sha256:sha256(text),byteLength:text.length}],texts:[{sha256:sha256(text),text}]};
    await supervisor.activate("w");
    const save=vi.spyOn(f.storage,"storeReplicaCurrentView").mockImplementation(()=>{throw new ReplicaCurrentViewRefused();});
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledOnce();expect(errors).toHaveLength(1);
    expect(sample).not.toHaveBeenCalled();expect(due).toHaveBeenCalledOnce();
    save.mockRestore();sample.mockRestore();
  } finally {await supervisor.close();}
});
it("R2: a rename at 20,000 files writes only that file and its History reference",async()=>{
  const f=await fixture(20_000,true);
  const prototype=Object.getPrototypeOf(f.db.prepare("SELECT 1"));let selected=0;
  for(const method of ["get","all"] as const) {
    const original=prototype[method];
    vi.spyOn(prototype,method).mockImplementation(function(this:{sourceSQL:string},...args:unknown[]) {
      const result=Reflect.apply(original,this,args);
      if(this.sourceSQL.includes("sync_relay_replica_cut_files") || this.sourceSQL.includes("sync_relay_replica_cut_texts"))
        selected+=Array.isArray(result)?result.length:result?1:0;
      return result;
    });
  }
  f.db.exec(`CREATE TABLE touched(kind TEXT);
    CREATE TRIGGER count_file_insert AFTER INSERT ON sync_relay_replica_cut_files BEGIN INSERT INTO touched VALUES('insert'); END;
    CREATE TRIGGER count_file_update AFTER UPDATE ON sync_relay_replica_cut_files BEGIN INSERT INTO touched VALUES('update'); END;
    CREATE TRIGGER count_file_delete AFTER DELETE ON sync_relay_replica_cut_files BEGIN INSERT INTO touched VALUES('delete'); END;
    CREATE TRIGGER count_ref_update AFTER UPDATE ON sync_relay_replica_cut_text_refs BEGIN INSERT INTO touched VALUES('ref'); END;`);
  f.storage.storeReplicaCurrentView(f.lease,{...f.view,revision:2,texts:[],files:[{...f.view.files[0]!,path:"docs/renamed.md"},...f.view.files.slice(1)]});
  const rows=f.db.prepare("SELECT kind,count(*) AS n FROM touched GROUP BY kind").all();
  expect.soft(rows.filter(r=>r.kind!=="ref").reduce((n,r)=>n+Number(r.n),0)).toBeLessThanOrEqual(2);
  expect.soft(rows.find(r=>r.kind==="ref")?.n).toBe(1);
  expect.soft(selected).toBeLessThanOrEqual(4);
  expect(f.db.prepare("SELECT sum(ref_count) AS n FROM sync_relay_replica_cut_text_refs").get()!.n).toBe(20_001);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(f.view.files[0]!.sha256)!.ref_count).toBe(2);
},30_000);
it("R2: a first open after restart never enumerates the stored manifest",async()=>{
  const f=await fixture(100);f.restart();
  const full=vi.spyOn(f.storage,"readReplicaCurrentView");
  const prepare=f.db.prepare.bind(f.db);let enumerated=0;
  vi.spyOn(f.db,"prepare").mockImplementation(sql=>{
    const query=prepare(sql);
    if(!sql.includes("sync_relay_replica_cut_files"))return query;
    const all=query.all.bind(query);query.all=(...args)=>{const rows=all(...args);enumerated+=rows.length;return rows;};return query;
  });
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:f.view.files[0]!.path})).toMatchObject({status:"ready",text:"shared"});
  expect(full).not.toHaveBeenCalled();expect(enumerated).toBeLessThanOrEqual(1);
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("cold-source"),startChild:async()=>{throw Error("unexpected child");}});
  try {expect(f.storage.readReplicaCurrentViewFile({...f.input,path:f.view.files[0]!.path},supervisor)).toMatchObject({status:"ready",text:"shared"});expect(full).not.toHaveBeenCalled();}
  finally {await supervisor.close();}
});
it("R2: path swaps publish together and a failed row write rolls back the header and History",async()=>{
  const f=await fixture(),before=f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get();
  const files=f.view.files.map((file,i)=>({...file,path:f.view.files[i===0?1:i===1?0:i]!.path}));
  const stage=f.storage.stageReplicaCurrentView(f.lease,{...f.view,revision:2,files,texts:[]});
  f.db.exec("CREATE TRIGGER refuse_replacement BEFORE INSERT ON sync_relay_replica_cut_files WHEN NEW.object_id='o1' BEGIN SELECT RAISE(ABORT,'row refused'); END");
  expect(()=>f.storage.flipReplicaCurrentView(f.lease,stage)).toThrow("row refused");
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get()).toEqual(before);
  expect(f.storage.readReplicaCurrentView("w")!.files).toEqual(f.view.files);
  expect(f.db.prepare("SELECT * FROM sync_relay_history_pins").all()).toEqual([]);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs").get()!.ref_count).toBe(4);
  f.db.exec("DROP TRIGGER refuse_replacement");
  f.storage.storeReplicaCurrentView(f.lease,{...f.view,revision:2,files,texts:[]});
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:files[0]!.path})).toMatchObject({text:"shared"});
  expect(f.storage.readReplicaCurrentView("w")!.files.find(f=>f.objectId==="o0")!.path).toBe(f.view.files[1]!.path);
});
it.each(["epoch","incarnation","selector"])("R2: a staged flip rechecks a racing %s",async race=>{
  const f=await fixture(),stage=f.storage.stageReplicaCurrentView(f.lease,{...f.view,revision:2,files:[{...f.view.files[0]!,path:"docs/renamed.md"},...f.view.files.slice(1)]});
  if(race==="epoch")f.db.exec("UPDATE sync_relay_workspaces SET replication_epoch='next' WHERE workspace_id='w'");
  if(race==="incarnation")f.storage.bindReplicaCurrentView({...f.lease,incarnation:"new"});
  if(race==="selector")f.db.prepare("UPDATE sync_relay_shares SET selector_json=?").run('{"paths":["other"],"versionId":null}');
  expect(()=>f.storage.flipReplicaCurrentView(f.lease,stage)).toThrow();
  expect(f.db.prepare("SELECT revision FROM sync_relay_replica_cuts").get()?.revision ?? 0).not.toBe(2);
});
it("R2: removing one current and one pinned reference preserves shared text",async()=>{
  const f=await fixture(2);
  f.storage.storeReplicaCurrentView(f.lease,{...f.view,revision:2,files:[f.view.files[1]!],texts:[]});
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs").get()!.ref_count).toBe(2);
  f.db.exec("DELETE FROM sync_relay_history_pins");
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs").get()!.ref_count).toBe(1);
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:f.view.files[1]!.path})).toMatchObject({text:"shared"});
});
it("R2: a restore generation raised after staging carries the old row while another row advances",()=>{
  const f=registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease=createReplicaReadPrincipal(f.storage).issue("workspace","restore");f.storage.bindReplicaCurrentView(lease);
    const file={versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,
      sha256:sha256("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1};
    const view={workspaceId:"workspace",omitted:[],revision:1,logCursor:0,journalCursor:0,files:[file],texts:[{sha256:file.sha256,text:"old"}]};
    f.storage.storeReplicaCurrentView(lease,view);
    const other={...file,objectId:"other",path:"docs/other.md",sha256:sha256("new"),lineageClaimId:null,restoreGeneration:null};
    const staged=f.storage.stageReplicaCurrentView(lease,{...view,revision:2,files:[{...file,sha256:sha256("changed"),byteLength:7},other],
      texts:[{sha256:sha256("changed"),text:"changed"},{sha256:other.sha256,text:"new"}]});
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    f.storage.flipReplicaCurrentView(lease,staged);
    const saved=f.storage.readReplicaCurrentView("workspace")!;
    expect(saved.files).toHaveLength(2);
    expect(saved.files.find(f=>f.objectId===file.objectId)).toEqual(file);
    expect(saved.files.find(f=>f.objectId===other.objectId)).toEqual(other);
    expect(f.storage.readReplicaCurrentViewText("workspace",sha256("changed"))).toBeNull();
    f.write(db=>expect(db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs ORDER BY sha256").all()).toEqual([{ref_count:1},{ref_count:1}]));
  } finally {f.close();}
});
it("R2: Y.Doc replacements are not filtered through a null moment payload alias",async()=>{
  const f=await fixture();
  f.db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES('w','owner',1,'ydoc.update',?,1,1)")
    .run(JSON.stringify({versionId:"main",objectId:"o0"}));
  expect(replicaHistoryReplacement(f.storage as StorageContext,"w","main","o0",0,1,0,0,f.view.files[0]!)).toEqual([1,null]);
});
it("R2: the work migration preserves a standing orphan pin and cleans unreferenced text immediately",async()=>{
  const f=await fixture(1);
  f.storage.storeReplicaCurrentView(f.lease,{...f.view,revision:2,files:[{...f.view.files[0]!,path:"docs/renamed.md"}],texts:[]});
  f.db.exec(`UPDATE sync_relay_history_pins SET superseded_at_ms=NULL,replaced_log_position=NULL,replaced_journal_position=NULL;
    DELETE FROM sync_relay_replica_cuts;`);
  const text="unused";
  f.storage.stageReplicaCurrentView(f.lease,{...f.view,files:[{...f.view.files[0]!,sha256:sha256(text),byteLength:text.length}],texts:[{sha256:sha256(text),text}]});
  f.db.exec(`DROP TRIGGER replica_history_usage_insert; DROP TRIGGER replica_history_usage_delete; DROP TRIGGER replica_history_usage_update;
    DROP TRIGGER replica_history_identity_floor; DROP TABLE sync_relay_history_pin_usage;
    ALTER TABLE sync_relay_replica_cuts ADD COLUMN omitted_json TEXT NOT NULL DEFAULT '[]';
    DROP INDEX replica_history_due; DROP INDEX replica_history_current_pin;
    DELETE FROM sync_relay_migrations WHERE migration_id='replica-history-incremental-v1';`);
  initializeReplicaHistoryWorkSchema(f.db);
  expect(f.db.prepare("SELECT superseded_at_ms,replaced_log_position,replaced_journal_position FROM sync_relay_history_pins").all())
    .toEqual([{superseded_at_ms:expect.any(Number),replaced_log_position:null,replaced_journal_position:null}]);
  expect(f.db.prepare("SELECT sha256,ref_count FROM sync_relay_replica_cut_text_refs").all()).toEqual([{sha256:sha256("shared"),ref_count:1}]);
  expect(f.db.prepare("SELECT sha256 FROM sync_relay_replica_cut_texts").all()).toEqual([{sha256:sha256("shared")}]);
});
