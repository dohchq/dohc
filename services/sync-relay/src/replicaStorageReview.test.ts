import {afterEach,expect,it,vi} from "vitest";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {closeTestStorages,testStorage,sha256,storagePath,closeTestStorage,reopenTestStorage} from "./testing";
import type {StorageContext} from "./storage/context";
import {fenceAccount,initializeAccountDeletion} from "./storage/accountDeletion";

afterEach(async()=>{vi.restoreAllMocks();await closeTestStorages();});
async function fixture() {
  let storage=await testStorage() as StorageContext;
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
  const share=(id:string,paths:string[],reader=id)=>storage.createShare({
    share:{shareId:id,workspaceId:"w",granterUserId:"owner",selectorJson:JSON.stringify({paths,versionId:null}),createdAtMs:1},
    grant:{grantId:id,shareId:id,principalKind:"user",principalUserId:reader,principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  share("docs",["docs"]);share("other",["other"]);
  const lease=createReplicaReadPrincipal(storage).issue("w","storage-review");storage.bindReplicaCurrentView(lease);
  const files=["docs/a.md","other/a.md"].map((path,i)=>({versionId:"main",objectId:`o${i}`,path,contentKind:"text" as const,
    sha256:sha256(path),byteLength:path.length,lineageClaimId:null,restoreGeneration:null}));
  const view={workspaceId:"w",revision:1,logCursor:0,journalCursor:0,files,omitted:[],texts:files.map(f=>({sha256:f.sha256,text:f.path}))};
  storage.storeReplicaCurrentView(lease,view);
  const renamed={...view,revision:2,texts:[],files:files.map(f=>({...f,path:f.path.replace("a.md","b.md")}))};
  storage.storeReplicaCurrentView(lease,renamed);
  return {get storage(){return storage;},lease,renamed,
    restart(){const path=storagePath(storage);closeTestStorage(storage);storage=reopenTestStorage(path) as StorageContext;}};
}
it("R2 review: omissions have one constrained format and advance compares sets",async()=>{
  const f=await fixture(),omitted=["x","y"].map(objectId=>({versionId:"main",objectId,path:`docs/${objectId}`,sha256:sha256(objectId),reason:"text-frame-limit" as const}));
  const view={...f.renamed,revision:3,omitted};f.storage.storeReplicaCurrentView(f.lease,view);
  expect.soft(f.storage.db.prepare("PRAGMA table_info(sync_relay_replica_cuts)").all().map(c=>c.name)).not.toContain("omitted_json");
  expect.soft(()=>f.storage.advanceReplicaCurrentView(f.lease,{...view,revision:4,omitted:[...omitted].reverse()},view)).not.toThrow();
  expect.soft(()=>f.storage.db.exec("UPDATE sync_relay_replica_cut_omitted SET sha256='bad'")).toThrow();
  expect(()=>f.storage.db.exec("UPDATE sync_relay_replica_cut_omitted SET reason='bad'")).toThrow();
});
it("R2 review: invalid stored rows return updating for opens and complete lists",async()=>{
  const f=await fixture();f.restart();
  f.storage.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE sync_relay_replica_cut_files SET byte_length=-1; PRAGMA ignore_check_constraints=OFF;");
  const input={grantId:"docs",generation:1,principal:{kind:"user" as const,userId:"docs"}};
  expect.soft(()=>f.storage.readReplicaCurrentViewFile({...input,path:"docs/b.md"})).not.toThrow();
  expect(f.storage.listReplicaCurrentViewFiles(input)).toEqual({status:"updating"});
  expect(f.storage.readReplicaCurrentViewFile({...input,path:"docs/b.md"})).toEqual({status:"updating"});
});
it.each(["share","grant","owner"])("R2: terminal %s cleanup removes doomed pins before recount, and rolls back together",async operation=>{
  const f=await fixture(),key="terminal-cleanup-deletion-key-32-bytes";
  initializeAccountDeletion(f.storage,key);
  if(operation!=="owner")f.storage.revokeShare("other",Date.now());
  const tables=["sync_relay_replica_cuts","sync_relay_replica_cut_files",
    "sync_relay_history_pins","sync_relay_history_clocks","sync_relay_history_pin_usage",
    "sync_relay_replica_cut_text_refs","sync_relay_replica_cut_texts"];
  const snapshot=()=>tables.map(table=>f.storage.db.prepare(`SELECT * FROM ${table}`).all());
  const before=snapshot();expect(before[2]!.length).toBeGreaterThan(0);
  const end=()=>operation==="owner" ? fenceAccount(f.storage,key,"owner","owner@test") : operation==="share" ?
    f.storage.revokeShare("docs",Date.now()) : f.storage.revokeShareGrant({shareId:"docs",grantId:"docs",revokedAtMs:Date.now()});
  f.storage.db.exec(`CREATE TRIGGER refuse_terminal BEFORE DELETE ON sync_relay_replica_cuts BEGIN SELECT RAISE(ABORT,'terminal refused'); END;`);
  expect(end).toThrow("terminal refused");expect(snapshot()).toEqual(before);
  f.storage.db.exec(`DROP TRIGGER refuse_terminal; CREATE TABLE terminal_recount(pins INTEGER);
    CREATE TRIGGER observe_terminal BEFORE DELETE ON sync_relay_replica_cuts BEGIN
      INSERT INTO terminal_recount SELECT count(*) FROM sync_relay_history_pins WHERE workspace_id=OLD.workspace_id;
    END;`);
  end();
  expect.soft(f.storage.db.prepare("SELECT pins FROM terminal_recount").all()).toEqual([{pins:0}]);
  expect(snapshot()).toEqual(tables.map(()=>[]));
});
