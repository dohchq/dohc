import {afterEach,expect,it,vi} from "vitest";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {closeTestStorages,seedLinkGrant,sha256,tempRoot,testStorage,inspectDatabase,storagePath} from "./testing";
import type {ReplicaCurrentViewPage} from "@dohc/workspace-engine-client/daemon";
import {ReplicaCurrentViewRefused,forgetReplicaCurrentViewStoredCache} from "./storage/replicaCurrentViews";
import type {StorageContext} from "./storage/context";
import {ReplicaManifest} from "./replicaManifest";
import * as shareSelector from "@dohc/security-contract/share-selector";

afterEach(async()=>{vi.useRealTimers();await closeTestStorages();});
it("R4 review: publish notifies once; unchanged persists and History samples stay quiet",async()=>{
  const f=await fixture(3),notified=vi.fn();f.supervisor.subscribeReadChanges(notified);
  seedLinkGrant(f.storage,{shareId:"s",grantId:"link",secretHash:"hash"});
  const input={grantId:"link",generation:1};
  const service=f.storage.createReplicaLinkReadService(f.supervisor,{holdReader(){}},{wakeLog(){}},()=>({lastSettledKnown:false,lastSettledAtMs:null}));
  const cursor=service.inventory(input,()=>input).nextCursor;
  vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]});
  try {
    f.update({});await f.supervisor.activate("w");expect(notified).not.toHaveBeenCalled();
    expect(service.feed(input,()=>input,cursor,500)).toMatchObject({ops:[],nextCursor:cursor});
    f.update({files:[{...f.files[0]!,sha256:sha256("edit"),byteLength:4}],texts:[{sha256:sha256("edit"),text:"edit"}]});
    await f.supervisor.activate("w");expect(notified).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);expect(notified).toHaveBeenCalledTimes(1);
    vi.spyOn(f.storage,"nextReplicaHistoryPinAt").mockReturnValueOnce(Date.now()+100).mockReturnValue(null);
    const history=vi.spyOn(f.storage,"sampleReplicaHistory");
    f.update({files:[{...f.files[1]!,path:"docs/renamed.md"}]});await f.supervisor.activate("w");
    expect(notified).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);expect(history).toHaveBeenCalled();expect(notified).toHaveBeenCalledTimes(2);
  }finally{service.close();await f.supervisor.close();vi.restoreAllMocks();}
});

it("R4 review: a replacement manifest resets removals absent from the stored base",async()=>{
  const f=await fixture(3),notified=vi.fn(),store=f.storage.storeReplicaCurrentView.bind(f.storage);f.supervisor.subscribeReadChanges(notified);
  try {
    vi.spyOn(f.storage,"storeReplicaCurrentView").mockImplementationOnce((lease,view,observations)=>store(lease,{...view,files:view.files.filter(row=>row.objectId!=="new")},observations));
    f.update({files:[{...f.files[0]!,objectId:"new",path:"docs/new.md"}]});await f.supervisor.activate("w");
    expect(f.supervisor.currentReadView("w")!.view.files).toHaveLength(4);
    notified.mockClear();f.update({delta:false,files:f.files});await f.supervisor.activate("w");
    expect(notified).toHaveBeenCalledOnce();expect(notified.mock.calls[0]![2]).toEqual([]);expect(notified.mock.calls[0]![3]).toBe(true);
  }finally{await f.supervisor.close();vi.restoreAllMocks();}
});

it("R4 review: feed waits after a persist refusal until another publish",async()=>{
  const f=await fixture(3);
  seedLinkGrant(f.storage,{shareId:"s",grantId:"link",secretHash:"hash"});
  const input={grantId:"link",generation:1};
  const service=f.storage.createReplicaLinkReadService(f.supervisor,{holdReader(){}},{wakeLog(){}},()=>({lastSettledKnown:false,lastSettledAtMs:null}));
  vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]});
  try {
    service.inventory(input,()=>input);
    f.update({files:[{...f.files[0]!,sha256:sha256("edit"),byteLength:4}],texts:[{sha256:sha256("edit"),text:"edit"}]});await f.supervisor.activate("w");
    const cursor=service.inventory(input,()=>input).nextCursor;
    vi.spyOn(f.storage,"storeReplicaCurrentView").mockImplementationOnce(()=>{throw new ReplicaCurrentViewRefused();});
    await vi.advanceTimersByTimeAsync(2000);
    for(let i=0;i<3;i++)expect(service.feed(input,()=>input,cursor,500)).toMatchObject({ops:[],nextCursor:cursor,hasMore:false});
    f.update({delta:false,files:[]});await f.supervisor.activate("w");
    expect(service.feed(input,()=>input,cursor,500).ops).toContainEqual(expect.objectContaining({opKind:"files.reset"}));
  }finally{service.close();await f.supervisor.close();vi.restoreAllMocks();}
});
it("prepares each replacement path once across collection and the first list",async()=>{
  const f=await fixture(100);
  try {
    expect(f.storage.listReplicaCurrentViewFiles(f.input,f.supervisor).status).toBe("ready");
    const prepare=vi.spyOn(shareSelector,"prepareSharePath");
    const files=f.files.map(file=>({...file,path:file.path.replace("docs/","docs/replaced/")}));
    const omitted={versionId:"main",objectId:"omitted",path:"docs/replaced/large.md",sha256:sha256("large"),reason:"text-frame-limit" as const};
    const paths=new Set([...files.map(file=>file.path),omitted.path]);
    const preparations=()=>prepare.mock.calls.filter(([path])=>paths.has(path)).length;
    f.update({delta:false,files,refusedFiles:[omitted]});
    await f.supervisor.activate("w");
    expect(preparations()).toBe(101);
    const source={currentReadView:()=>({view:f.supervisor.currentReadView("w")!.view})};
    expect(f.storage.listReplicaCurrentViewFiles(f.input,source)).toMatchObject({status:"ready",files:expect.arrayContaining([expect.objectContaining({path:files[0]!.path}),expect.objectContaining({path:omitted.path,status:"updating"})])});
    expect(preparations()).toBe(101);
  } finally {vi.restoreAllMocks();await f.supervisor.close();}
});
it("clears History observations after a successful fence-adjusted save",async()=>{
  const f=await fixture(2),original=f.storage.storeReplicaCurrentView.bind(f.storage);
  try {
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(1000);
    const save=vi.spyOn(f.storage,"storeReplicaCurrentView").mockImplementationOnce((lease,view,observations)=>original(lease,{...view,files:view.files.slice(1)},observations));
    const first={...f.files[0]!,path:"docs/first.md"};
    f.update({files:[first]});await f.supervisor.activate("w");
    expect(save).toHaveBeenCalledTimes(1);
    vi.setSystemTime(2000);
    f.update({delta:false,files:[{...first,path:"docs/second.md"},f.files[1]!]});await f.supervisor.activate("w");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![2]).toEqual(expect.arrayContaining([expect.objectContaining({objectId:first.objectId,firstChangedAtMs:2000,changedAtMs:2000})]));
  } finally {vi.restoreAllMocks();await f.supervisor.close();}
});
it("does not reload the stored manifest after a lazy restart header advance",async()=>{
  const f=await fixture(3);
  try {
    await f.supervisor.evict("w");
    const read=vi.spyOn(f.storage,"readReplicaCurrentView"),advance=f.storage.advanceReplicaCurrentView.bind(f.storage);
    const save=vi.spyOn(f.storage,"advanceReplicaCurrentView").mockImplementation((...args)=>{const saved=advance(...args);read.mockClear();return saved;});
    f.override(async()=>({workspaceId:"w",revision:2,logCursor:0,journalCursor:0,files:f.files,texts:[],refusedFiles:[],delta:false,removed:[],moved:false,nextCursor:null}));
    await f.supervisor.activate("w");
    expect(save).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {await f.supervisor.close();}
});
it("advances the restart header after the stored cache changes identity",async()=>{
  const f=await fixture(3),db=inspectDatabase(storagePath(f.storage));
  try {
    await f.supervisor.evict("w");
    db.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES('w','device',1,'workspace.init','{}',1,1)");
    f.storage.createShare({share:{shareId:"new",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:2},grant:{grantId:"new",shareId:"new",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:2,revokedAtMs:null,parentGrantId:null}});
    const advance=vi.spyOn(f.storage,"advanceReplicaCurrentView");
    f.override(async()=>{
      const before=f.storage.readReplicaCurrentView("w")!;
      forgetReplicaCurrentViewStoredCache(f.storage as unknown as StorageContext,"w");
      expect(f.storage.readReplicaCurrentView("w")).not.toBe(before);
      return {workspaceId:"w",revision:2,logCursor:1,journalCursor:0,files:f.files,texts:[],refusedFiles:[],delta:false,removed:[],moved:false,nextCursor:null};
    });
    await f.supervisor.activate("w");
    expect(advance).toHaveBeenCalledTimes(1);
    expect(f.storage.readReplicaCurrentView("w")).toMatchObject({revision:2,logCursor:1});
    const input={...f.input,grantId:"new"};
    expect(f.storage.listReplicaHistoryPins(input,f.supervisor)).toMatchObject({status:"denied"});
    await f.supervisor.evict("w");
    forgetReplicaCurrentViewStoredCache(f.storage as unknown as StorageContext,"w");
    expect(f.storage.listReplicaHistoryPins(input)).toMatchObject({status:"denied"});
    expect(f.errors).toEqual([]);
  } finally {await f.supervisor.close();}
});
it("leaves a large replacement index lazy even when the predecessor was indexed",async()=>{
  const f=await fixture(100);
  try {
    expect(f.storage.listReplicaCurrentViewFiles(f.input,f.supervisor).status).toBe("ready");
    f.update({delta:false,files:f.files.map(file=>({...file,path:file.path.replace("docs/","docs/replaced/")}))});
    await f.supervisor.activate("w");
    const view=f.supervisor.currentReadView("w")!.view,files=view.files;
    let enumerations=0;
    Object.defineProperty(view,"files",{get(){enumerations++;return files;},configurable:true});
    expect(f.storage.listReplicaCurrentViewFiles(f.input,f.supervisor)).toMatchObject({status:"ready",files:expect.arrayContaining([expect.objectContaining({path:"docs/replaced/000000.md"})])});
    expect(enumerations).toBeGreaterThan(0);
    const replacements=files.slice(0,30).map(file=>({...file,objectId:`new-${file.objectId}`,path:file.path.replace("replaced/","new/")}));
    f.update({delta:false,files:[...files.slice(30),...replacements]});
    await f.supervisor.activate("w");
    const mixed=f.supervisor.currentReadView("w")!.view,mixedFiles=mixed.files;
    let mixedEnumerations=0;
    Object.defineProperty(mixed,"files",{get(){mixedEnumerations++;return mixedFiles;},configurable:true});
    expect(f.storage.listReplicaCurrentViewFiles(f.input,f.supervisor)).toMatchObject({status:"ready",files:expect.arrayContaining([expect.objectContaining({path:replacements[0]!.path})])});
    expect(mixedEnumerations).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);
  } finally {await f.supervisor.close();}
});
it("keeps restart indexing lazy, then updates the index after its first read",async()=>{
  const f=await fixture(3);
  try {
    await f.supervisor.evict("w");forgetReplicaCurrentViewStoredCache(f.storage as unknown as StorageContext,"w");await f.supervisor.activate("w");
    const view=f.supervisor.currentReadView("w")!.view,files=view.files;
    let enumerations=0;
    Object.defineProperty(view,"files",{get(){enumerations++;return files;},configurable:true});
    expect(f.storage.readReplicaCurrentViewFile({...f.input,path:f.files[0]!.path},f.supervisor)).toMatchObject({status:"ready",text:""});
    expect(enumerations).toBeGreaterThan(0);
    const warmEnumerations=enumerations;
    const renamed={...f.files[0]!,path:"docs/renamed.md"};f.update({files:[renamed]});await f.supervisor.activate("w");
    const next=f.supervisor.currentReadView("w")!.view;
    const descriptor=Object.getOwnPropertyDescriptor(next,"files")!;
    Object.defineProperty(next,"files",{get(){throw Error("enumerated renamed restart view");},configurable:true});
    try {
      expect(f.storage.readReplicaCurrentViewFile({...f.input,path:renamed.path},f.supervisor)).toMatchObject({status:"ready",text:""});
      expect(f.storage.listReplicaCurrentViewFiles(f.input,f.supervisor)).toMatchObject({status:"ready",files:expect.arrayContaining([expect.objectContaining({path:renamed.path})])});
      expect(enumerations).toBe(warmEnumerations);
    } finally {Object.defineProperty(next,"files",descriptor);}
  } finally {await f.supervisor.close();}
});
it("validates changed rows before publishing a deferred view",()=>{
  const file={versionId:"main",objectId:"o",path:"docs/a.md",contentKind:"text" as const,sha256:sha256(""),byteLength:0,lineageClaimId:null,restoreGeneration:null};
  const stored={workspaceId:"w",revision:1,logCursor:0,journalCursor:0,files:[file],texts:[],omitted:[]};
  const manifest=ReplicaManifest.fromStored(stored);
  const invalid={...stored,revision:2,files:[{...file,path:"../secret.md"}]};
  expect(()=>manifest.apply(invalid,false,[])).toThrow("Invalid replica read index");
  const next=manifest.apply({...stored,revision:2},false,[]).next;
  expect(()=>next.apply(invalid,true,[])).toThrow("Invalid replica read index");
});
it("fix1: removing an omission does not observe an old unavailable History row",()=>{
  const omitted={versionId:"main",objectId:"large",path:"docs/large.md",sha256:sha256("large"),reason:"text-frame-limit" as const};
  const page={workspaceId:"w",revision:1,logCursor:0,journalCursor:0,files:[],texts:[],omitted:[omitted]};
  const manifest=new ReplicaManifest().apply(page,false,[]).next;
  expect(manifest.apply({...page,revision:2,omitted:[]},true,[omitted]).observations).toEqual([]);
});
it("fix1: a refused deletion forces a full retry and preserves its History observation",async()=>{
  const f=await fixture(2);
  const save=vi.spyOn(f.storage,"storeReplicaCurrentView"),advance=vi.spyOn(f.storage,"advanceReplicaCurrentView");
  const db=inspectDatabase(storagePath(f.storage));
  try {
    db.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES('w','device',1,'workspace.init','{}',1,1)");
    save.mockImplementationOnce(()=>{throw new ReplicaCurrentViewRefused();});
    f.update({removed:[f.files[0]!],logCursor:1});await f.supervisor.activate("w");
    forgetReplicaCurrentViewStoredCache(f.storage as unknown as StorageContext,"w");
    expect(f.storage.readReplicaCurrentView("w")!.files).toHaveLength(2);
    expect(f.storage.readReplicaCurrentView("w")!.logCursor).toBe(0);
    f.storage.createShare({share:{shareId:"new",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:2},grant:{grantId:"new",shareId:"new",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:2,revokedAtMs:null,parentGrantId:null}});
    db.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES('w','device',2,'workspace.init','{}',2,2)");
    f.override(async(_known,since)=>({workspaceId:"w",revision:3,logCursor:2,journalCursor:0,files:since?[]:[f.files[1]!],texts:[],refusedFiles:[],delta:!!since,removed:[],moved:false,nextCursor:null}));
    await f.supervisor.activate("w");
    expect(advance).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![2]).toEqual(expect.arrayContaining([expect.objectContaining({objectId:f.files[0]!.objectId})]));
    forgetReplicaCurrentViewStoredCache(f.storage as unknown as StorageContext,"w");
    expect(f.storage.readReplicaCurrentView("w")!.files.map(f=>f.objectId)).toEqual([f.files[1]!.objectId]);
    expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:"new",path:f.files[0]!.path})).toEqual({status:"not-found"});
  } finally {await f.supervisor.close();}
});
it("fix1: a refused spilled selector widening retries the widened full manifest",async()=>{
  const f=await fixture(2,false,8),text="large new selected text",other={...f.files[0]!,objectId:"other",path:"other/new.md",sha256:sha256(text),byteLength:text.length};
  const original=f.storage.storeReplicaCurrentView.bind(f.storage);
  try {
    f.storage.createShare({share:{shareId:"other",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["other"],"versionId":null}',createdAtMs:1},grant:{grantId:"other",shareId:"other",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    f.override(async(known,since)=>({workspaceId:"w",revision:1,logCursor:0,journalCursor:0,files:since?[]:[...f.files,other],texts:since||known.includes(other.sha256)?[]:[{sha256:other.sha256,text}],refusedFiles:[],delta:!!since,removed:[],moved:false,nextCursor:null}));
    const save=vi.spyOn(f.storage,"storeReplicaCurrentView").mockImplementationOnce(()=>{throw new ReplicaCurrentViewRefused();}).mockImplementation(original);
    await f.supervisor.activate("w");await f.supervisor.activate("w");
    expect(f.storage.readReplicaCurrentView("w")!.files.map(f=>f.path)).toContain(other.path);
    expect(save).toHaveBeenCalledTimes(2);
  } finally {await f.supervisor.close();}
});
it("fix1: a full fallback advertises held text and counts each held byte once",async()=>{
  const f=await fixture(2,false,32),text="held text content here",file={...f.files[0]!,sha256:sha256(text),byteLength:text.length};
  try {
    f.update({files:[file],texts:[{sha256:file.sha256,text}]});await f.supervisor.activate("w");
    const stage=vi.spyOn(f.storage,"stageReplicaCurrentView");
    f.override(async known=>{
      expect(known).toContain(file.sha256);
      return {workspaceId:"w",revision:3,logCursor:0,journalCursor:0,files:[file,f.files[1]!],texts:known.includes(file.sha256)?[]:[{sha256:file.sha256,text}],refusedFiles:[],delta:false,removed:[],moved:false,nextCursor:null};
    });
    await f.supervisor.activate("w");expect(stage).not.toHaveBeenCalled();
  } finally {await f.supervisor.close();}
});
async function fixture(count=20_000,extra=false,maxViewTextBytes=64*1024*1024) {
  const storage=await testStorage();storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
    grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  if(extra)storage.createShare({share:{shareId:"other",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["other"],"versionId":null}',createdAtMs:1},grant:{grantId:"other",shareId:"other",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  const files=Array.from({length:count},(_,i)=>({versionId:"main",objectId:`o${i}`,path:`docs/${String(i).padStart(6,"0")}.md`,contentKind:"text" as const,sha256:sha256(""),byteLength:0,lineageClaimId:null,restoreGeneration:null}));
  let page:ReplicaCurrentViewPage={workspaceId:"w",revision:1,logCursor:0,journalCursor:0,files,texts:[{sha256:sha256(""),text:""}],refusedFiles:[],delta:false,removed:[],moved:false,nextCursor:null};
  const errors:unknown[]=[];
  let read=async(_known:string[],_since?:{revision:number;logCursor:number;journalCursor:number})=>structuredClone(page);
  const supervisor=createReplicaSupervisor({storage,storeRoot:await tempRoot("r1"),maxViewTextBytes,onError:(_w,e)=>errors.push(e),startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:(_s,known,_p,_c,since)=>read(known,since)})});
  const input={grantId:"g",generation:1,principal:{kind:"user" as const,userId:"reader"}};
  await supervisor.activate("w");
  const update=(changes:Partial<ReplicaCurrentViewPage>)=>{page={...page,revision:page.revision+1,delta:true,files:[],texts:[],removed:[],...changes};};
  return {storage,supervisor,files,input,errors,update,override:(fn:typeof read)=>{read=fn;}};
}
it("R1: a one-entry edit retains the other 19,999 entries without enumerating a complete manifest",async()=>{
  const f=await fixture();
  try {
    const old=f.supervisor.currentReadView("w")!.view;
    Object.defineProperty(old,"files",{get(){throw Error("enumerated old manifest");},configurable:true});
    f.update({files:[{...f.files[0]!,sha256:sha256("edit"),byteLength:4}],texts:[{sha256:sha256("edit"),text:"edit"}]});
    await f.supervisor.activate("w");
    const current=f.supervisor.currentReadView("w")!.view;
    expect(current.files).toHaveLength(20_000);
    expect(f.storage.readReplicaCurrentViewFile({...f.input,path:f.files[0]!.path},f.supervisor)).toMatchObject({status:"ready",text:"edit"});
    expect(f.errors).toEqual([]);
  } finally {await f.supervisor.close();}
},60_000);
it("R1: first open and first list after an atomic path swap use the published index and retain the prior view",async()=>{
  const f=await fixture(100);
  try {
    expect(f.storage.listReplicaCurrentViewFiles(f.input,f.supervisor).status).toBe("ready");
    const prior=f.supervisor.currentReadView("w")!;
    const a=f.files[0]!,b=f.files[1]!;
    f.update({files:[{...a,path:b.path},{...b,path:a.path}]});await f.supervisor.activate("w");
    const view=f.supervisor.currentReadView("w")!.view;
    const descriptor=Object.getOwnPropertyDescriptor(view,"files")!;
    Object.defineProperty(view,"files",{get(){throw Error("enumerated renamed manifest");},configurable:true});
    try {
      expect(f.storage.readReplicaCurrentViewFile({...f.input,path:b.path},f.supervisor)).toMatchObject({status:"ready",text:""});
      const listed=f.storage.listReplicaCurrentViewFiles(f.input,f.supervisor);
      expect(listed.status).toBe("ready");if(listed.status==="ready"){expect(listed.files).toHaveLength(100);expect(new Set(listed.files.map(f=>f.path)).size).toBe(100);}
      const old=f.storage.listReplicaCurrentViewFiles(f.input,{currentReadView:()=>prior});
      expect(old.status).toBe("ready");
    } finally {Object.defineProperty(view,"files",descriptor);}
    expect(f.errors).toEqual([]);
  } finally {await f.supervisor.close();}
});
it("R1: a duplicate-path delta fails atomically",async()=>{
  const f=await fixture(3);const prior=f.supervisor.currentReadView("w")!;
  f.update({files:[{...f.files[0]!,path:f.files[1]!.path}]});
  await expect(f.supervisor.activate("w")).rejects.toThrow("Duplicate replica path");
  expect(prior.view.files.map(f=>f.path)).toEqual(f.files.map(f=>f.path));await f.supervisor.close();
});
it("R1: a selector ending mid-page recollects new grants within the same drain",async()=>{
  const f=await fixture(2,true);let calls=0;
  const other={...f.files[0]!,objectId:"new",path:"new/new.md"};
  f.override(async()=>{
    calls++;const page={workspaceId:"w",revision:2,logCursor:0,journalCursor:0,files:[f.files[0]!],texts:[],refusedFiles:[],delta:false,removed:[],moved:false,nextCursor:null} satisfies ReplicaCurrentViewPage;
    if(calls===1)return {...page,nextCursor:{versionId:"main",objectId:"o0",path:f.files[0]!.path}};
    if(calls===2) {
      f.storage.createShare({share:{shareId:"new",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["new"],"versionId":null}',createdAtMs:1},grant:{grantId:"new",shareId:"new",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
      f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:2});return {...page,files:[other]};
    }
    return {...page,files:[other],texts:[{sha256:sha256(""),text:""}]};
  });
  try {await f.supervisor.activate("w");expect(calls).toBe(3);expect(f.supervisor.currentView("w")!.view.files.map(f=>f.path)).toEqual(["new/new.md"]);expect(f.errors).toEqual([]);}
  finally {await f.supervisor.close();}
});
it.each(["sha","path","kind","lineage","generation","add","remove"])("R1: classifies %s changes for persistence",async change=>{
  const f=await fixture(3),save=vi.spyOn(f.storage,"storeReplicaCurrentView");
  const old=f.files[0]!,next={...old};
  if(change==="sha")Object.assign(next,{sha256:sha256("a"),byteLength:1});
  if(change==="path")next.path="docs/renamed.md";
  if(change==="kind")Object.assign(next,{contentKind:"binary"});
  if(change==="lineage")Object.assign(next,{lineageClaimId:sha256("lineage"),restoreGeneration:1});
  if(change==="generation")Object.assign(next,{lineageClaimId:sha256("lineage"),restoreGeneration:2});
  if(change==="add")next.objectId="new",next.path="docs/new.md";
  f.update({files:change==="remove"?[]:[next],removed:change==="remove"?[old]:[],texts:change==="sha"?[{sha256:sha256("a"),text:"a"}]:[]});
  try {await f.supervisor.activate("w");expect(save.mock.calls.length).toBe(change==="sha"?0:1);}
  finally {await f.supervisor.close();}
});
it("R1: the first spill filters a predecessor hidden while collecting the next view",async()=>{
  const f=await fixture(2,true,32);
  try {
    f.update({files:[{...f.files[0]!,sha256:sha256("pending"),byteLength:7}],texts:[{sha256:sha256("pending"),text:"pending"}]});
    await f.supervisor.activate("w");
    const text="large replacement text".repeat(3),other={...f.files[0]!,objectId:"other",path:"other/a.md",sha256:sha256(text),byteLength:text.length};
    const save=vi.spyOn(f.storage,"storeReplicaCurrentView");
    f.override(async()=>{
      f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:2});
      return {workspaceId:"w",revision:3,logCursor:0,journalCursor:0,files:[other],texts:[{sha256:sha256(text),text}],refusedFiles:[],delta:false,removed:[],moved:false,nextCursor:null};
    });
    await f.supervisor.activate("w");
    expect(save.mock.calls[0]![1].files).toEqual([]);
    expect(f.storage.readReplicaCurrentView("w")!.files.map(f=>f.path)).toEqual([other.path]);
    expect(f.errors).toEqual([]);
  } finally {await f.supervisor.close();}
});
it("R1: a structural save invalidates stored-text hints before a removed SHA returns",async()=>{
  const f=await fixture(2,false,8),text="large text content",file={...f.files[0]!,sha256:sha256(text),byteLength:text.length};
  try {
    f.update({files:[file],texts:[{sha256:file.sha256,text}]});await f.supervisor.activate("w");
    f.update({removed:[file]});await f.supervisor.activate("w");
    vi.spyOn(f.storage,"readReplicaCurrentViewText").mockReturnValue(null);
    f.override(async known=>{
      expect(known).not.toContain(file.sha256);
      return {workspaceId:"w",revision:4,logCursor:0,journalCursor:0,files:[file],texts:[{sha256:file.sha256,text}],refusedFiles:[],delta:true,removed:[],moved:false,nextCursor:null};
    });
    await f.supervisor.activate("w");expect(f.errors).toEqual([]);
  } finally {await f.supervisor.close();}
});
