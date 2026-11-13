import {createReplicaSupervisor} from "./replicaSupervisor";
import {tempRoot} from "./testing";
import {registered,cleanupLiveDeliveryFixtures} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {afterEach, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {closeTestStorages, closeTestStorage, reopenTestStorage, inspectDatabase, storagePath, testStorage, testHandler} from "./testing";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";

afterEach(async()=>{vi.useRealTimers();cleanupLiveDeliveryFixtures();await closeTestStorages();});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const storage = await testStorage();
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
    grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  const lease = createReplicaReadPrincipal(storage).issue("w","incarnation");
  storage.bindReplicaCurrentView(lease);
  const db = inspectDatabase(storagePath(storage));
  const view = (text="old", path="docs/a.md") => ({workspaceId:"w",omitted:[],revision:1,logCursor:0,journalCursor:0,
    files:[{versionId:"main",objectId:"a",path,contentKind:"text" as const,sha256:sha(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null}],
    texts:[{sha256:sha(text),text}]});
  return {storage,lease,db,view};
}

it("rejects a stale incarnation and paths outside current selectors",async()=>{
  const f=await fixture();
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,f.view("secret",".env"))).toThrow();
  f.storage.storeReplicaCurrentView(f.lease,f.view());
  f.storage.bindReplicaCurrentView({...f.lease,incarnation:"replacement"});
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,f.view("new"))).toThrow();
});

it("refuses lower cursors, duplicate paths, missing bytes, and superseded standing at flip",async()=>{
  const f=await fixture();
  f.storage.appendLogBatch({workspaceId:"w",originId:"o",ops:[{originSeq:0,opKind:"workspace.init",payloadJson:"{}",recordedAtMs:1},{originSeq:1,opKind:"moment.append",payloadJson:"{}",recordedAtMs:2}]});
  const first={...f.view(),logCursor:2};f.storage.storeReplicaCurrentView(f.lease,first);
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,{...f.view("new"),logCursor:1})).toThrow();
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,{...first,files:[...first.files,{...first.files[0]!,objectId:"duplicate"}]})).toThrow();
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,{...f.view("missing"),logCursor:2,texts:[]})).toThrow();
  const staged=f.storage.stageReplicaCurrentView(f.lease,{...f.view("new"),logCursor:2});
  f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:2});
  expect(()=>f.storage.flipReplicaCurrentView(f.lease,staged)).toThrow();
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_texts").all()).toEqual([]);
});

it("keeps owner responses and all non-replica tables byte-identical with cuts and pins",async()=>{
  const f=await fixture(), handler=testHandler(f.storage);
  const blob=Buffer.from("owner blob"), blobSha=sha(blob.toString());
  f.storage.putBlob({workspaceId:"w",sha256:blobSha,content:blob,createdAtMs:1});
  const paths=["bootstrap","log?after=0",`blobs/${blobSha}`,`blobs/${sha("current text")}`];
  const responses=async()=>Promise.all(paths.map(async p=>{const r=await handler(new Request(`https://relay.test/sync/w/${p}`,{headers:{authorization:"Bearer user:owner"}}));return {status:r.status,bytes:Buffer.from(await r.arrayBuffer()).toString("hex")};}));
  const tables=f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sync_relay_replica_cut%' AND name NOT LIKE 'sync_relay_history_%' ORDER BY name").all().map(r=>String(r.name));
  const digest=()=>JSON.stringify(tables.map(t=>[t,f.db.prepare(`SELECT * FROM "${t}"`).all()]));
  const before=await responses(),saved=digest();
  f.storage.storeReplicaCurrentView(f.lease,f.view("current text"));
  f.storage.storeReplicaCurrentView(f.lease,f.view("renamed text","docs/renamed.md"));
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_history_pins").get()!.n).toBe(1);
  expect(await responses()).toEqual(before);expect((await responses())[3]!.status).toBe(404);
  expect(digest()).toBe(saved);expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_log").get()!.n).toBe(0);
});
it("survives a storage restart and disappears on identity rotation",async()=>{
  const f=await fixture();f.storage.storeReplicaCurrentView(f.lease,f.view());
  const path=storagePath(f.storage);closeTestStorage(f.storage);const reopened=reopenTestStorage(path);
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_files").get()!.n).toBe(1);
  expect(reopened.rotateWorkspaceIdentity({workspaceId:"w",ownerUserId:"owner",replicationEpoch:"epoch2",streamIdentity:"stream2",rotatedAtMs:3})).toBe("rotated");
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cuts").all()).toEqual([]);
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_texts").all()).toEqual([]);
});

it("refuses decreasing generations and a restore not yet applied through the journal",()=>{
  const f=registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease=createReplicaReadPrincipal(f.storage).issue("workspace","one");
    f.storage.bindReplicaCurrentView(lease);
    const view=(generation: number)=>({workspaceId:"workspace",omitted:[],revision:1,logCursor:0,journalCursor:0,
      files:[{versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha("text"),byteLength:4,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:generation}],texts:[{sha256:sha("text"),text:"text"}]});
    f.storage.storeReplicaCurrentView(lease,view(1));
    const staged=f.storage.stageReplicaCurrentView(lease,view(1));
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    f.storage.flipReplicaCurrentView(lease,staged);
    f.storage.storeReplicaCurrentView(lease,view(2));
    expect(()=>f.storage.storeReplicaCurrentView(lease,view(1))).toThrow();
    expect(()=>f.storage.storeReplicaCurrentView(lease,view(3))).toThrow();
  } finally {f.close();}
});

it("spills a bounded collection by pages, retains the old view until flip, and releases text memory",async()=>{
  const f=await fixture();let calls=0;
  const one=f.view("1234567890"),two=f.view("abcdefghij","docs/b.md");two.files[0]!.objectId="b";
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("spill-view"),maxViewTextBytes:15,
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>{
      calls++;if(calls===1)return {...f.view(),nextCursor:null,delta:false,removed:[],moved:false,refusedFiles:[]};
      if(calls===2)return {...one,nextCursor:{path:"docs/a.md",objectId:"a",versionId:"main"},delta:false,removed:[],moved:false,refusedFiles:[]};
      expect(supervisor.currentView("w")!.readText(sha("old"))).toBe("old");
      return {...two,nextCursor:null,delta:false,removed:[],moved:false,refusedFiles:[]};
    }})});
  try {
    await supervisor.activate("w");
    const stage=f.storage.stageReplicaCurrentView.bind(f.storage);
    vi.spyOn(f.storage,"stageReplicaCurrentView").mockImplementation((...args)=>{const staged=stage(...args);expect(supervisor.currentView("w")!.readText(sha("old"))).toBe("old");return staged;});
    await supervisor.activate("w");const current=supervisor.currentView("w")!;
    expect(current.view.files).toHaveLength(2);expect(current.view.texts).toEqual([]);
    expect(current.readText(sha(one.texts[0]!.text))).toBe(one.texts[0]!.text);expect(current.readText(sha(two.texts[0]!.text))).toBe(two.texts[0]!.text);
    expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_text_refs WHERE ref_count=0").get()!.n).toBe(0);
  }finally{await supervisor.close();}
});

it("round4: ending one of two shares hides its cached text and preserves the surviving cut", async () => {
  const f = await fixture();
  f.storage.createShare({share:{shareId:"other",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["other"],"versionId":null}',createdAtMs:1},
    grant:{grantId:"other-g",shareId:"other",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  const lease = createReplicaReadPrincipal(f.storage).issue("w", "two");
  f.storage.bindReplicaCurrentView(lease);
  const supervisor = createReplicaSupervisor({storage:f.storage, storeRoot:await tempRoot("ended-selector"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...f.view(),delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");
    const cached = supervisor.currentView("w")!;
    f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:2});
    expect(cached.readText(sha("old"))).toBeNull();
    expect(supervisor.currentView("w")?.view.files ?? []).toEqual([]);
    expect(f.db.prepare("SELECT * FROM sync_relay_replica_cuts").all()).toHaveLength(1);
    expect(f.storage.readReplicaCurrentViewText("w",sha("old"))).toBeNull();
  } finally { await supervisor.close(); }
});

it("round4: pending memory reads carry the restoring row and advance another file", async () => {
  const f=registered({deployment:true});let supervisor:ReturnType<typeof createReplicaSupervisor>|undefined;
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const file={versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1};
    const other={...file,objectId:"other",path:file.path.replace(/[^/]+$/,"other.md"),lineageClaimId:null,restoreGeneration:null};
    let latest={workspaceId:"workspace",omitted:[],revision:1,logCursor:0,journalCursor:0,files:[file,other],texts:[{sha256:sha("old"),text:"old"}]};
    supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("memory-fence"),startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
    await supervisor.activate("workspace");
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    latest={...latest,revision:2,files:[{...file,sha256:sha("changed"),byteLength:7},{...other,sha256:sha("new"),byteLength:3}],texts:[{sha256:sha("changed"),text:"changed"},{sha256:sha("new"),text:"new"}]};
    await supervisor.activate("workspace");const current=supervisor.currentView("workspace")!;
    expect(current.view.files.find(f=>f.objectId==="other")!.sha256).toBe(sha("new"));
    expect(current.view.files.find(f=>f.objectId==="object")!.sha256).toBe(sha("old"));
    expect(current.readText(sha("changed"))).toBeNull();expect(current.readText(sha("old"))).toBe("old");
  } finally {await supervisor?.close();f.close();}
});

it("round4: retirement revokes the bearer before waiting for a drain", async () => {
  const f=await fixture();let bearer="",pulls=0,release!:()=>void,entered!:()=>void,relayHandler!: (request: Request) => Promise<Response>;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("retire-bearer"),startChild:async input=>{
    bearer=input.lease.bearer;relayHandler=input.relayHandler;
    return {pull:async()=>{if(++pulls===2){entered();await blocked;}},close:async()=>{},currentView:async()=>({...f.view(),delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})};
  }});
  try {
    await supervisor.activate("w");const draining=supervisor.activate("w");void draining.catch(()=>{});await started;
    const retiring=supervisor.evict("w");
    try {expect((await relayHandler(new Request("https://relay.test/sync/w/bootstrap",{headers:{authorization:`Bearer ${bearer}`}}))).status).toBe(404);}
    finally {release();await retiring;await draining.catch(()=>{});}
  }finally{release();await supervisor.close();}
});
