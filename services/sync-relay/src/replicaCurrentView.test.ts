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
  const view = (text="old", path="docs/a.md") => ({workspaceId:"w",revision:1,logCursor:0,journalCursor:0,
    files:[{versionId:"main",objectId:"a",path,contentKind:"text" as const,sha256:sha(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null}],
    texts:[{sha256:sha(text),text}]});
  return {storage,lease,db,view};
}
it("stages privately, flips one complete view, and retains no superseded texts",async()=>{
  const f=await fixture();
  f.storage.storeReplicaCurrentView(f.lease,f.view());
  const before=f.db.prepare("SELECT * FROM sync_relay_replica_cut_files").all();
  const staged=f.storage.stageReplicaCurrentView(f.lease,f.view("new","docs/renamed.md"));
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_files").all()).toEqual(before);
  f.storage.flipReplicaCurrentView(f.lease,staged);
  expect(f.db.prepare("SELECT path,sha256 FROM sync_relay_replica_cut_files").all()).toEqual([{path:"docs/renamed.md",sha256:sha("new")}]);
  expect(f.db.prepare("SELECT sha256,ref_count FROM sync_relay_replica_cut_texts").all()).toEqual([{sha256:sha("new"),ref_count:1}]);
});
it("rejects a stale incarnation and paths outside current selectors",async()=>{
  const f=await fixture();
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,f.view("secret",".env"))).toThrow();
  f.storage.storeReplicaCurrentView(f.lease,f.view());
  f.storage.bindReplicaCurrentView({...f.lease,incarnation:"replacement"});
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,f.view("new"))).toThrow();
});
it("deletes views when the last share ends or the epoch changes",async()=>{
  const f=await fixture();f.storage.storeReplicaCurrentView(f.lease,f.view());
  f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:2});
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cuts").all()).toEqual([]);
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_texts").all()).toEqual([]);
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
it("keeps every file and text from one position across rename, edit, delete, and restore",async()=>{
  const f=await fixture();
  const one=f.view(),two={...f.view("second","docs/b.md").files[0]!,objectId:"b"};
  const initial={...one,files:[...one.files,two],texts:[...one.texts,{sha256:sha("second"),text:"second"}]};
  f.storage.storeReplicaCurrentView(f.lease,initial);
  const read=()=>f.db.prepare(`SELECT f.path,t.bytes FROM sync_relay_replica_cut_files f JOIN sync_relay_replica_cut_texts t USING(workspace_id,sha256) ORDER BY f.path`).all().map(r=>[r.path,Buffer.from(r.bytes as Uint8Array).toString()]);
  for(const next of [f.view("edited","docs/renamed.md"),{...f.view(),files:[],texts:[]},f.view("restored","docs/a.md")]) {
    const old=read(),staged=f.storage.stageReplicaCurrentView(f.lease,next);
    expect(read()).toEqual(old);
    f.storage.flipReplicaCurrentView(f.lease,staged);
    expect(read()).toEqual(next.files.map(row=>[row.path,next.texts.find(t=>t.sha256===row.sha256)!.text]));
  }
});
it("keeps owner responses and all non-view tables byte-identical",async()=>{
  const f=await fixture(), handler=testHandler(f.storage);
  const blob=Buffer.from("owner blob"), blobSha=sha(blob.toString());
  f.storage.putBlob({workspaceId:"w",sha256:blobSha,content:blob,createdAtMs:1});
  const paths=["bootstrap","log?after=0",`blobs/${blobSha}`,`blobs/${sha("current text")}`];
  const responses=async()=>Promise.all(paths.map(async p=>{const r=await handler(new Request(`https://relay.test/sync/w/${p}`,{headers:{authorization:"Bearer user:owner"}}));return {status:r.status,bytes:Buffer.from(await r.arrayBuffer()).toString("hex")};}));
  const tables=f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sync_relay_replica_cut%' ORDER BY name").all().map(r=>String(r.name));
  const digest=()=>JSON.stringify(tables.map(t=>[t,f.db.prepare(`SELECT * FROM "${t}"`).all()]));
  const before=await responses(),saved=digest();
  f.storage.storeReplicaCurrentView(f.lease,f.view("current text"));
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
it("stages text larger than 8 MiB in bounded chunks and shares references",async()=>{
  const f=await fixture(),text="x".repeat(8*1024*1024+17),view=f.view(text);
  view.files.push({...view.files[0]!,objectId:"b",path:"docs/b.md"});
  f.storage.storeReplicaCurrentView(f.lease,view);
  const chunks=f.db.prepare("SELECT length(bytes) AS n,ref_count FROM sync_relay_replica_cut_texts ORDER BY ordinal").all();
  expect(chunks).toEqual([{n:8*1024*1024,ref_count:2},{n:17,ref_count:2}]);
});

it("refuses decreasing generations and a restore not yet applied through the journal",()=>{
  const f=registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease=createReplicaReadPrincipal(f.storage).issue("workspace","one");
    f.storage.bindReplicaCurrentView(lease);
    const view=(generation: number)=>({workspaceId:"workspace",revision:1,logCursor:0,journalCursor:0,
      files:[{versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha("text"),byteLength:4,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:generation}],texts:[{sha256:sha("text"),text:"text"}]});
    f.storage.storeReplicaCurrentView(lease,view(1));
    const staged=f.storage.stageReplicaCurrentView(lease,view(1));
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    expect(()=>f.storage.flipReplicaCurrentView(lease,staged)).toThrow();
    f.storage.storeReplicaCurrentView(lease,view(2));
    expect(()=>f.storage.storeReplicaCurrentView(lease,view(1))).toThrow();
    expect(()=>f.storage.storeReplicaCurrentView(lease,view(3))).toThrow();
  } finally {f.close();}
});
it("persists on quiet, at the edit ceiling, on structural change, and before idle retirement",async()=>{
  const f=await fixture(),root=await tempRoot("view-policy");let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:root,idleMs:60_000,
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...structuredClone(latest),moved:false,nextCursor:null,refusedFiles:[]})})});
  const seq=()=>Number(f.db.prepare("SELECT cut_seq FROM sync_relay_replica_cuts").get()?.cut_seq);
  try {
    await supervisor.activate("w");expect(seq()).toBe(1);
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    latest=f.view("quiet");await supervisor.activate("w");expect(seq()).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);expect(seq()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);expect(seq()).toBe(2);
    for(let i=0;i<30;i++) {latest=f.view(`edit-${i}`);await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);}
    expect(seq()).toBe(3);
    latest=f.view("renamed","docs/new.md");await supervisor.activate("w");expect(seq()).toBe(4);
    latest=f.view("before idle","docs/new.md");await supervisor.activate("w");
    await supervisor.evict("w");expect(seq()).toBe(5);
    await supervisor.close();
    const restarted=createReplicaSupervisor({storage:f.storage,storeRoot:root,startChild:async()=>{throw Error("no activation expected");}});
    await restarted.close();expect(seq()).toBe(5);
  }finally{vi.useRealTimers();await supervisor.close();}
});

it("refuses a staged view from a retired incarnation without discarding its stored view",async()=>{
  const f=await fixture();f.storage.storeReplicaCurrentView(f.lease,f.view());
  const staged=f.storage.stageReplicaCurrentView(f.lease,f.view("new"));f.storage.releaseReplicaCurrentView(f.lease);
  expect(()=>f.storage.flipReplicaCurrentView(f.lease,staged)).toThrow();
  expect(f.db.prepare("SELECT sha256 FROM sync_relay_replica_cut_files").get()!.sha256).toBe(sha("old"));
});
it("collects pages in memory, restarts moved collections, and flips only the complete manifest",async()=>{
  const f=await fixture(),first=f.view("abandoned"),final=f.view("current");let calls=0,pulls=0;
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("view-pages"),startChild:async()=>({
    pull:async()=>{pulls++;},close:async()=>{},currentView:async(_selectors,_known,position,cursor)=>{
      calls++;expect(pulls).toBe(1);expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cuts").get()!.n).toBe(0);
      expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_texts").get()!.n).toBe(0);
      if(calls===1) {expect(position).toBeUndefined();return {...first,moved:false,refusedFiles:[],nextCursor:{path:"docs/a.md",objectId:"a",versionId:"main"}};}
      if(calls===2) {expect(position?.revision).toBe(first.revision);expect(cursor?.path).toBe("docs/a.md");return {...first,files:[],texts:[],moved:true,refusedFiles:[],nextCursor:null};}
      expect(position).toBeUndefined();return {...final,moved:false,refusedFiles:[],nextCursor:null};
    }
  })});
  try {await supervisor.activate("w");expect(calls).toBe(3);expect(f.db.prepare("SELECT sha256 FROM sync_relay_replica_cut_files").get()!.sha256).toBe(sha("current"));expect(f.db.prepare("SELECT DISTINCT sha256 FROM sync_relay_replica_cut_texts").all()).toEqual([{sha256:sha("current")}]);}finally{await supervisor.close();}
});

it("writes only at persistence points and exposes the newer in-memory view",async()=>{
  const f=await fixture();let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("memory-view"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");const stage=vi.spyOn(f.storage,"stageReplicaCurrentView");
    const before=JSON.stringify(f.db.prepare("SELECT * FROM sync_relay_replica_cut_texts").all());
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    latest={...f.view("pending"),revision:2};await supervisor.activate("w");
    expect(stage).not.toHaveBeenCalled();expect(JSON.stringify(f.db.prepare("SELECT * FROM sync_relay_replica_cut_texts").all())).toBe(before);
    const memory=supervisor.currentView("w")!;expect(memory.view.revision).toBe(2);expect(memory.readText(sha("pending"))).toBe("pending");expect(memory.readText(sha("old"))).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);expect(stage).toHaveBeenCalledTimes(1);
    await supervisor.evict("w");const stored=supervisor.currentView("w")!;expect(stored.view.revision).toBe(2);expect(stored.readText(sha("pending"))).toBe("pending");
    f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:2});expect(supervisor.currentView("w")).toBeNull();expect(memory.readText(sha("pending"))).toBeNull();
  }finally{await supervisor.close();}
});

it("spills a bounded collection by pages, retains the old view until flip, and releases text memory",async()=>{
  const f=await fixture();let calls=0;
  const one=f.view("1234567890"),two=f.view("abcdefghij","docs/b.md");two.files[0]!.objectId="b";
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("spill-view"),maxViewTextBytes:15,
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>{
      calls++;if(calls===1)return {...f.view(),nextCursor:null,moved:false,refusedFiles:[]};
      if(calls===2)return {...one,nextCursor:{path:"docs/a.md",objectId:"a",versionId:"main"},moved:false,refusedFiles:[]};
      expect(supervisor.currentView("w")!.readText(sha("old"))).toBe("old");
      return {...two,nextCursor:null,moved:false,refusedFiles:[]};
    }})});
  try {
    await supervisor.activate("w");
    const stage=f.storage.stageReplicaCurrentView.bind(f.storage);
    vi.spyOn(f.storage,"stageReplicaCurrentView").mockImplementation((...args)=>{const staged=stage(...args);expect(supervisor.currentView("w")!.readText(sha("old"))).toBe("old");return staged;});
    await supervisor.activate("w");const current=supervisor.currentView("w")!;
    expect(current.view.files).toHaveLength(2);expect(current.view.texts).toEqual([]);
    expect(current.readText(sha(one.texts[0]!.text))).toBe(one.texts[0]!.text);expect(current.readText(sha(two.texts[0]!.text))).toBe(two.texts[0]!.text);
    expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_texts WHERE ref_count=0").get()!.n).toBe(0);
  }finally{await supervisor.close();}
});

it("does not delay quiet persistence when only the applied position changes",async()=>{
  const f=await fixture();let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("position-quiet"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    latest={...f.view("edited"),revision:2};await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);
    latest={...latest,revision:3};await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);
    expect(f.db.prepare("SELECT revision FROM sync_relay_replica_cuts").get()!.revision).toBe(3);
  }finally{await supervisor.close();}
});
