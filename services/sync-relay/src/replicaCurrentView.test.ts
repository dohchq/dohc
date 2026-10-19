import {createReplicaSupervisor} from "./replicaSupervisor";
import {tempRoot} from "./testing";
import {registered,cleanupLiveDeliveryFixtures} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {afterEach, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {closeTestStorages, closeTestStorage, reopenTestStorage, inspectDatabase, storagePath, testStorage, testHandler} from "./testing";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";

afterEach(async()=>{vi.useRealTimers();cleanupLiveDeliveryFixtures();await closeTestStorages();});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
it("fix1: a fence-adjusted store forces a full child cut before advancing its header",async()=>{
  const f=registered({deployment:true});let supervisor:ReturnType<typeof createReplicaSupervisor>|undefined;
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const file={versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1};
    let revision=1;
    supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("adjusted-base"),startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async(_s,_known,_p,_c,since)=>{
      if(revision===3)expect(since).toBeUndefined();
      return {workspaceId:"workspace",revision,logCursor:0,journalCursor:0,files:[revision===1?file:{...file,path:file.path.replace(/[^/]+$/,"renamed.md"),restoreGeneration:revision===3?2:1}],texts:revision===1?[{sha256:file.sha256,text:"old"}]:[],refusedFiles:[],delta:revision===2,removed:[],moved:false,nextCursor:null};
    }})});
    await supervisor.activate("workspace");
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    revision=2;await supervisor.activate("workspace");
    expect(f.storage.readReplicaCurrentView("workspace")!.files[0]!.path).toBe(file.path);
    revision=3;await supervisor.activate("workspace");
    expect(f.storage.readReplicaCurrentView("workspace")!.files[0]).toMatchObject({path:file.path.replace(/[^/]+$/,"renamed.md"),restoreGeneration:2});
  } finally {await supervisor?.close();f.close();}
});
it.each([false, true])("round6: omitted current paths win over carried restore rows (reverse=%s)", reverse => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace", replicationEpoch:"e", streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "omitted-collision");
    f.storage.bindReplicaCurrentView(lease);
    const file = {versionId:"main", objectId:"object", path:f.input.evidence.currentPath, contentKind:"text" as const,
      sha256:sha("old"), byteLength:3, lineageClaimId:f.input.evidence.document.lineageClaimId, restoreGeneration:1};
    const initial = {workspaceId:"workspace", omitted:[], revision:1, logCursor:0, journalCursor:0,
      files:[file], texts:[{sha256:sha("old"), text:"old"}]};
    f.storage.storeReplicaCurrentView(lease, initial);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    const moved = {...file, path:file.path.replace(/[^/]+$/, "moved.md")};
    const current = {...file, objectId:"other", path:file.path.replace(/[^/]+$/, "current.md"),
      lineageClaimId:null, restoreGeneration:null, sha256:sha("new")};
    const omitted = [{versionId:"main", objectId:"oversized", path:file.path, sha256:sha("too large"), reason:"text-frame-limit" as const}];
    const files = reverse ? [current, moved] : [moved, current];
    expect.soft(f.storage.currentViewFilesAtFences("workspace", files, initial.files, omitted)).toEqual([current]);
    expect(() => f.storage.storeReplicaCurrentView(lease, {...initial, revision:2, files, omitted,
      texts:[{sha256:sha("new"), text:"new"}]})).not.toThrow();
    const stored = f.storage.readReplicaCurrentView("workspace")!;
    expect(stored.files).toEqual([current]);
    expect(stored.omitted).toEqual(omitted);
    expect(f.storage.readReplicaCurrentViewText("workspace", sha("old"))).toBeNull();
    expect(f.storage.readReplicaCurrentViewText("workspace", sha("new"))).toBe("new");
  } finally {f.close();}
});

it.each([false, true])("round6: stale manifest paths do not block carried restore rows (reverse=%s)", reverse => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace", replicationEpoch:"e", streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "stale-paths");
    f.storage.bindReplicaCurrentView(lease);
    const a = {versionId:"main", objectId:"object", path:f.input.evidence.currentPath, contentKind:"text" as const,
      sha256:sha("old"), byteLength:3, lineageClaimId:f.input.evidence.document.lineageClaimId, restoreGeneration:1};
    const d = {...a, objectId:"second", path:a.path.replace(/[^/]+$/, "second.md"), sha256:sha("two")};
    f.write(db => {
      const row = db.prepare("SELECT * FROM sync_relay_live_documents").get()!;
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO sync_relay_live_documents (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .run(...columns.map(column => column === "object_id" ? d.objectId : column === "current_path" ? d.path : row[column]));
    });
    const initial = {workspaceId:"workspace", omitted:[], revision:1, logCursor:0, journalCursor:0,
      files:[a, d], texts:[{sha256:a.sha256, text:"old"}, {sha256:d.sha256, text:"two"}]};
    f.storage.storeReplicaCurrentView(lease, initial);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    const movedA = {...a, path:a.path.replace(/[^/]+$/, "moved.md")};
    const movedD = {...d, path:a.path};
    const files = reverse ? [movedD, movedA] : [movedA, movedD];
    const expected = reverse ? [d, a] : [a, d];
    expect.soft(f.storage.currentViewFilesAtFences("workspace", files, initial.files, [])).toEqual(expected);
    f.storage.storeReplicaCurrentView(lease, {...initial, revision:2, files, texts:[]});
    expect(f.storage.readReplicaCurrentView("workspace")!.files).toEqual([a, d].sort((x,y) => x.path.localeCompare(y.path)));
    expect(f.storage.readReplicaCurrentViewText("workspace", a.sha256)).toBe("old");
    expect(f.storage.readReplicaCurrentViewText("workspace", d.sha256)).toBe("two");
  } finally {f.close();}
});

it("round5: repeated page text retains its first chunk split", async () => {
  const f = await fixture();
  const shared = f.view("shared text that spans the remaining batch space");
  f.storage.stageReplicaCurrentView(f.lease, shared);
  const prefix = f.view("x".repeat(8 * 1024 * 1024 - 10), "docs/prefix.md");
  prefix.files[0]!.objectId = "prefix";
  const repeated = {...shared.files[0]!, objectId:"repeated", path:"docs/repeated.md"};
  const second = {...prefix, files:[...prefix.files, repeated], texts:[...prefix.texts, ...shared.texts]};
  f.storage.stageReplicaCurrentView(f.lease, second);
  const complete = {...shared, files:[...shared.files, ...second.files], texts:[]};
  const staged = f.storage.stageReplicaCurrentView(f.lease, complete);
  expect(() => f.storage.flipReplicaCurrentView(f.lease, staged)).not.toThrow();
  expect(f.storage.readReplicaCurrentViewText("w", shared.files[0]!.sha256)).toBe(shared.texts[0]!.text);
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_texts WHERE sha256=?").get(shared.files[0]!.sha256)!.n).toBe(1);
});

it.each([false, true])("round5: current paths win over carried restore rows (reverse=%s)", reverse => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace", replicationEpoch:"e", streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "path-collision");
    f.storage.bindReplicaCurrentView(lease);
    const file = {versionId:"main", objectId:"object", path:f.input.evidence.currentPath, contentKind:"text" as const,
      sha256:sha("old"), byteLength:3, lineageClaimId:f.input.evidence.document.lineageClaimId, restoreGeneration:1};
    const initial = {workspaceId:"workspace", omitted:[], revision:1, logCursor:0, journalCursor:0,
      files:[file], texts:[{sha256:sha("old"), text:"old"}]};
    f.storage.storeReplicaCurrentView(lease, initial);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    const moved = {...file, path:file.path.replace(/[^/]+$/, "moved.md")};
    const current = {...file, objectId:"other", lineageClaimId:null, restoreGeneration:null, sha256:sha("new")};
    const files = reverse ? [current, moved] : [moved, current];
    expect.soft(f.storage.currentViewFilesAtFences("workspace", files, initial.files, [])).toEqual([current]);
    expect(() => f.storage.storeReplicaCurrentView(lease, {...initial, revision:2, files,
      texts:[{sha256:sha("new"), text:"new"}]})).not.toThrow();
    expect(f.storage.readReplicaCurrentView("workspace")!.files).toEqual([current]);
    expect(f.storage.readReplicaCurrentViewText("workspace", sha("old"))).toBeNull();
    expect(f.storage.readReplicaCurrentViewText("workspace", sha("new"))).toBe("new");
  } finally {f.close();}
});

it.each(["dm", "agent", null, undefined] as const)("round5: a group on a blocked channel kind collects nothing (%s)", async kind => {
  const f = await fixture();
  f.db.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({kind:"group", channelWireId:"channel", paths:["docs"], versionId:null}));
  vi.spyOn(f.storage, "findChannelCreateKind").mockReturnValue(kind);
  expect(f.storage.replicaCurrentViewSelectors("w")).toEqual([]);
  expect(() => f.storage.storeReplicaCurrentView(f.lease, f.view())).toThrow();
});

it("round5: an ordinary group channel still collects its folder", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({kind:"group", channelWireId:"channel", paths:["docs"], versionId:null}));
  vi.spyOn(f.storage, "findChannelCreateKind").mockReturnValue("channel");
  expect(f.storage.replicaCurrentViewSelectors("w")).toEqual([{paths:["docs"], versionId:null}]);
  expect(() => f.storage.storeReplicaCurrentView(f.lease, f.view())).not.toThrow();
});

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
it("staging looks up incoming texts without enumerating retained pin bodies",async()=>{
  const f=await fixture();
  const context=f.storage as unknown as import("./storage/context").StorageContext;
  const prepare=context.db.prepare.bind(context.db);
  let returnedTexts=0;
  vi.spyOn(context.db,"prepare").mockImplementation(query=>{
    const statement=prepare(query);
    if(!/^SELECT .*FROM sync_relay_replica_cut_texts /s.test(query))return statement;
    return new Proxy(statement,{get(target,key){
      const value=Reflect.get(target,key,target);
      if(typeof value!=="function")return value;
      return (...args:unknown[])=>{
        const result=value.apply(target,args);
        returnedTexts+=Array.isArray(result)?result.length:result?1:0;
        return result;
      };
    }});
  });
  for(let index=0;index<40;index++)f.storage.storeReplicaCurrentView(f.lease,f.view(`body ${index}`,`docs/${index}.md`));
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_history_pins").get()!.n).toBe(39);
  returnedTexts=0;
  const view=f.view("a new body");
  const staged=f.storage.stageReplicaCurrentView(f.lease,view);
  expect(returnedTexts).toBeLessThanOrEqual(view.texts.length);
  f.storage.flipReplicaCurrentView(f.lease,staged);
  expect(f.storage.readReplicaCurrentViewText("w",sha("body 0"))).toBeNull();
  expect(f.storage.readReplicaCurrentViewText("w",sha("a new body"))).toBe("a new body");
});
it("stages privately, flips one complete view, and retains the pre-rename pin",async()=>{
  const f=await fixture();
  f.storage.storeReplicaCurrentView(f.lease,f.view());
  const before=f.db.prepare("SELECT * FROM sync_relay_replica_cut_files").all();
  const staged=f.storage.stageReplicaCurrentView(f.lease,f.view("new","docs/renamed.md"));
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_files").all()).toEqual(before);
  f.storage.flipReplicaCurrentView(f.lease,staged);
  expect(f.db.prepare("SELECT path,sha256 FROM sync_relay_replica_cut_files").all()).toEqual([{path:"docs/renamed.md",sha256:sha("new")}]);
  expect(f.db.prepare("SELECT sha256,ref_count FROM sync_relay_replica_cut_text_refs ORDER BY sha256").all()).toEqual(
    [sha("new"),sha("old")].sort().map(sha256=>({sha256,ref_count:1})));
  expect(f.db.prepare("SELECT reason,sha256 FROM sync_relay_history_pins").all()).toEqual([{reason:"rename",sha256:sha("old")}]);
});
it("rejects a stale incarnation and paths outside current selectors",async()=>{
  const f=await fixture();
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,f.view("secret",".env"))).toThrow();
  f.storage.storeReplicaCurrentView(f.lease,f.view());
  f.storage.bindReplicaCurrentView({...f.lease,incarnation:"replacement"});
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,f.view("new"))).toThrow();
});
it("header-only fallback keeps full-store text length validation",async()=>{
  const f=await fixture(),view=f.view();f.storage.storeReplicaCurrentView(f.lease,view);
  const wrong={...view,files:view.files.map(file=>({...file,byteLength:file.byteLength+1}))};
  expect(()=>f.storage.storeReplicaCurrentView(f.lease,wrong)).toThrow();
  expect(f.storage.readReplicaCurrentView("w")!.files).toEqual(view.files);
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
it("stages text larger than 8 MiB in bounded chunks and shares references",async()=>{
  const f=await fixture(),text="x".repeat(8*1024*1024+17),view=f.view(text);
  view.files.push({...view.files[0]!,objectId:"b",path:"docs/b.md"});
  f.storage.storeReplicaCurrentView(f.lease,view);
  const chunks=f.db.prepare("SELECT length(bytes) AS n,ref_count FROM sync_relay_replica_cut_texts JOIN sync_relay_replica_cut_text_refs USING(workspace_id,sha256) ORDER BY ordinal").all();
  expect(chunks).toEqual([{n:8*1024*1024,ref_count:2},{n:17,ref_count:2}]);
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
it("persists on quiet, at the edit ceiling, on structural change, and before idle retirement",async()=>{
  const f=await fixture(),root=await tempRoot("view-policy");let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:root,idleMs:60_000,
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...structuredClone(latest),delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
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
      if(calls===1) {expect(position).toBeUndefined();return {...first,delta:false,removed:[],moved:false,refusedFiles:[],nextCursor:{path:"docs/a.md",objectId:"a",versionId:"main"}};}
      if(calls===2) {expect(position?.revision).toBe(first.revision);expect(cursor?.path).toBe("docs/a.md");return {...first,files:[],texts:[],delta:false,removed:[],moved:true,refusedFiles:[],nextCursor:null};}
      expect(position).toBeUndefined();return {...final,delta:false,removed:[],moved:false,refusedFiles:[],nextCursor:null};
    }
  })});
  try {await supervisor.activate("w");expect(calls).toBe(3);expect(f.db.prepare("SELECT sha256 FROM sync_relay_replica_cut_files").get()!.sha256).toBe(sha("current"));expect(f.db.prepare("SELECT DISTINCT sha256 FROM sync_relay_replica_cut_texts").all()).toEqual([{sha256:sha("current")}]);}finally{await supervisor.close();}
});

it("writes only at persistence points and exposes the newer in-memory view",async()=>{
  const f=await fixture();let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("memory-view"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
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

it("does not delay quiet persistence when only the applied position changes",async()=>{
  const f=await fixture();let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("position-quiet"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    latest={...f.view("edited"),revision:2};await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);
    latest={...latest,revision:3};await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);
    expect(f.db.prepare("SELECT revision FROM sync_relay_replica_cuts").get()!.revision).toBe(3);
  }finally{await supervisor.close();}
});

it("round4: an empty null-version selector collects and grants nothing", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE sync_relay_shares SET selector_json=?").run('{"paths":[],"versionId":null}');
  expect(f.storage.replicaCurrentViewSelectors("w")).toEqual([]);
  expect(() => f.storage.storeReplicaCurrentView(f.lease, f.view())).toThrow();
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

it("round4: a spill flushes older pending text before staging across timer awaits", async () => {
  const f = await fixture(); let calls = 0;
  const errors:unknown[] = [];
  const supervisor = createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("spill-timer"),maxViewTextBytes:15,onError:(_w,e)=>errors.push(e),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>{
      calls++;
      if(calls<=2)return {...f.view(calls===1?"old":"pending"),delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]};
      if(calls===3)return {...f.view("1234567890"),delta:false,removed:[],moved:false,nextCursor:{path:"docs/a.md",objectId:"a",versionId:"main"},refusedFiles:[]};
      await vi.advanceTimersByTimeAsync(2000);
      const page=f.view("abcdefghij","docs/b.md");page.files[0]!.objectId="b";
      return {...page,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]};
    }})});
  try {
    await supervisor.activate("w");vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    await supervisor.activate("w");await supervisor.activate("w");
    expect(f.storage.readReplicaCurrentView("w")!.files).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally { await supervisor.close(); }
});

it("round4: restore fences carry one old row while unrelated files advance", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease=createReplicaReadPrincipal(f.storage).issue("workspace","carry");f.storage.bindReplicaCurrentView(lease);
    const file={versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1};
    const view={workspaceId:"workspace",omitted:[],revision:1,logCursor:0,journalCursor:0,files:[file],texts:[{sha256:sha("old"),text:"old"}]};
    f.storage.storeReplicaCurrentView(lease,view);
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    const extra={...file,objectId:"other",path:file.path.replace(/[^/]+$/, "other.md"),lineageClaimId:null,restoreGeneration:null,sha256:sha("new"),byteLength:3};
    f.storage.storeReplicaCurrentView(lease,{...view,files:[{...file,sha256:sha("changed"),byteLength:7},extra],texts:[{sha256:sha("changed"),text:"changed"},{sha256:sha("new"),text:"new"}]});
    expect(f.storage.readReplicaCurrentView("workspace")!.files.map(row=>row.sha256).sort()).toEqual([sha("old"),sha("new")].sort());
  } finally { f.close(); }
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

it("round4: a replacement lineage starts at its own generation", () => {
  const f=registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease=createReplicaReadPrincipal(f.storage).issue("workspace","lineage");f.storage.bindReplicaCurrentView(lease);
    const file={versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha("text"),byteLength:4,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:2};
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    const view={workspaceId:"workspace",omitted:[],revision:1,logCursor:0,journalCursor:0,files:[file],texts:[{sha256:sha("text"),text:"text"}]};
    f.storage.storeReplicaCurrentView(lease,view);
    f.storage.storeReplicaCurrentView(lease,{...view,files:[{...file,lineageClaimId:sha("replacement"),restoreGeneration:1}]});
    expect(f.storage.readReplicaCurrentView("workspace")!.files[0]!.restoreGeneration).toBe(1);
  } finally { f.close(); }
});

it("round4: grant generation changes preserve pending text on retirement", async () => {
  const f=await fixture();let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("grant-flush"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");latest=f.view("pending");await supervisor.activate("w");
    f.db.exec("UPDATE sync_relay_share_grants SET generation=generation+1");
    await supervisor.evict("w");
    expect(f.storage.readReplicaCurrentViewText("w",sha("pending"))).toBe("pending");
  } finally { await supervisor.close(); }
});

it("round4: a refused stage cleans earlier unreferenced chunks", async () => {
  const f=await fixture();f.storage.storeReplicaCurrentView(f.lease,f.view());
  f.storage.stageReplicaCurrentView(f.lease,f.view("first page"));
  expect(()=>f.storage.stageReplicaCurrentView(f.lease,{...f.view("second page"),texts:[{sha256:sha("second page"),text:"bad"}]})).toThrow();
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_text_refs WHERE ref_count=0").all()).toEqual([]);
});

it("round4: persist refusals reach onError", async () => {
  const f=await fixture();const errors:unknown[]=[];let latest=f.view();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("reported-refusal"),onError:(_w,e)=>errors.push(e),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    latest=f.view("pending");await supervisor.activate("w");
    // A new incarnation supersedes the supervisor before its quiet flush.
    f.storage.bindReplicaCurrentView({...f.lease,incarnation:"replacement"});
    await vi.advanceTimersByTimeAsync(2000);expect(errors).toHaveLength(1);
  } finally {await supervisor.close();}
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

it("round4: stores omissions and reports each object and digest once", async () => {
  const f=await fixture(),errors:unknown[]=[];
  const omitted={path:"docs/large.md",objectId:"large",versionId:"main",sha256:sha("large"),reason:"text-frame-limit" as const};
  f.storage.createShare({share:{shareId:"draft",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":"draft"}',createdAtMs:1},
    grant:{grantId:"draft-g",shareId:"draft",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  const omissions=[omitted,{...omitted,versionId:"draft"}];
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("omitted-view"),onError:(_w,e)=>errors.push(e),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...f.view(),delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:omissions})})});
  try {
    await supervisor.activate("w");await supervisor.activate("w");
    expect(supervisor.currentView("w")!.view.omitted).toEqual(omissions);
    await supervisor.evict("w");expect(f.storage.readReplicaCurrentView("w")!.omitted).toEqual(omissions);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain(omitted.objectId);
    expect(String(errors[0])).toContain(omitted.sha256);
  } finally { await supervisor.close(); }
});

it("round4: stages new digests in one bounded transaction and skips stored digests", async () => {
  const f=await fixture(),texts=["a","b","c"].map(text=>({sha256:sha(text),text}));
  const view={...f.view(),files:texts.map((text,i)=>({...f.view(text.text).files[0]!,objectId:`o${i}`,path:`docs/${i}.md`})),texts};
  const tx=vi.spyOn(f.storage as any,"replicaViewTx");
  f.storage.storeReplicaCurrentView(f.lease,view);expect(tx).toHaveBeenCalledTimes(2);
  tx.mockClear();f.storage.storeReplicaCurrentView(f.lease,view);expect(tx).toHaveBeenCalledTimes(1);
});

it("round4: spilled workspaces suppress known bytes and regain edit persistence policy", async () => {
  const f=await fixture();let revision=0;const knownRequests:string[][]=[];
  const unchanged="unchanged".repeat(3);
  const page=()=>{const text=revision===0?"0abcdefghij":String(revision),view=f.view(text);return {...view,files:[...view.files,{...f.view(unchanged,"docs/b.md").files[0]!,objectId:"b"}],texts:[...view.texts,{sha256:sha(unchanged),text:unchanged}],delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]};};
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("spill-followup"),maxViewTextBytes:15,
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async(_s,known)=>{knownRequests.push(known);const result=page();return {...result,texts:result.texts.filter(t=>!known.includes(t.sha256))};}})});
  try {
    await supervisor.activate("w");const seq=()=>f.db.prepare("SELECT cut_seq FROM sync_relay_replica_cuts").get()!.cut_seq;
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});revision++;await supervisor.activate("w");
    expect(knownRequests[1]).toContain(sha(unchanged));expect(seq()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);expect(seq()).toBe(2);
    for(let i=0;i<30;i++){revision++;await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);}
    expect(seq()).toBe(3);
  } finally { await supervisor.close(); }
});

it("round4: a discussion revision does not sweep unrelated workspace views", async () => {
  const f=await fixture();f.storage.storeReplicaCurrentView(f.lease,f.view());
  f.storage.claimWorkspace({workspaceId:"orphan",ownerUserId:"owner",createdAtMs:1});
  f.db.exec("INSERT INTO sync_relay_replica_cuts(workspace_id,replication_epoch,stream_identity,incarnation,cut_seq,revision,log_cursor,journal_cursor) SELECT 'orphan',replication_epoch,stream_identity,incarnation,cut_seq,revision,log_cursor,journal_cursor FROM sync_relay_replica_cuts WHERE workspace_id='w'");
  f.db.exec("UPDATE sync_relay_shares SET discussion_revision=discussion_revision+1 WHERE share_id='s'");
  expect(f.db.prepare("SELECT workspace_id FROM sync_relay_replica_cuts WHERE workspace_id='orphan'").get()).toBeDefined();
});
