import {afterEach, expect, it, vi} from "vitest";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {markdownToYDoc, yDocToArtifactMarkdown} from "@dohc/ydoc-projection";
import {writeFileSync} from "node:fs";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {initializeReplicaCurrentViewSchema} from "./storage/replicaCurrentViewSchema";
import type {SqliteDb} from "./storage/types";
import type {StorageContext} from "./storage/context";
import {closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, seedLinkGrant, sha256, storagePath, tempRoot, testStorage} from "./testing";

afterEach(async () => {vi.useRealTimers(); await closeTestStorages();});

it.each(["log","journal"])("relabelled structural pins advance the %s author window",async stream=>{
  const f=await fixture();f.save();f.at(130_000);f.save();
  const first=replacementEvidence(f.db,stream);
  const table=stream==="log"?"sync_relay_log":"sync_relay_live_update_journal";
  const column=stream==="log"?"admitted_author_snapshot_json":"author_snapshot_json";
  f.db.prepare(`UPDATE ${table} SET ${column}=?`).run('[{"kind":"human","humanId":"old","humanName":"Old"}]');
  f.save(f.view());
  replacementEvidence(f.db,stream);
  f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${stream==="log"?"relay_seq":"journal_cursor"}>?`)
    .run('[{"kind":"human","humanId":"new","humanName":"New"}]',first);
  f.at(140_000);f.save(f.view("next",{path:"docs/b.md"}));
  f.at(170_000);f.save();
  expect(JSON.parse(String(f.pins().find(p=>p.sha256===sha256("next"))!.authors_json)))
    .toEqual([{kind:"human",humanId:"new",humanName:"New"}]);
});

function projectedEvidence(f: Awaited<ReturnType<typeof fixture>>,stream:string,text:string) {
  const position=replacementEvidence(f.db,stream);
  if(stream==="log") f.db.prepare("UPDATE sync_relay_log SET payload_json=? WHERE relay_seq=?").run(JSON.stringify({
    versionId:"main",objectId:"object",momentId:`moment-${position}`,recordedAtMs:1,operation:"write",path:"docs/a.md",payloadAfterPath:"docs/a.md",
    payloadAfterBlobSha256:sha256(text),payloadAfterContentKind:"text",payloadAfterByteLength:Buffer.byteLength(text)}),position);
  else f.db.prepare("INSERT INTO sync_relay_live_settlement_cuts VALUES (?,?,?,?,?)")
    .run(position,sha256("state"),sha256(text),1,Buffer.byteLength(text));
  return position;
}

it.each([["log","return"],["journal","return"],["log","no-op"],["journal","no-op"]])
  ("uses the last state lifetime after a %s %s",async(stream,kind)=>{
    const f=await fixture(false),patch=stream==="journal"?{lineageClaimId:sha256("lineage"),restoreGeneration:1}:{};
    f.save(f.view("baseline",patch));f.save(f.view("initial",patch));f.at(130_000);f.save();const id=String(f.pins()[0]!.pin_id);
    projectedEvidence(f,stream,kind==="return"?"intermediate":"initial");f.grant("between");
    if(kind==="return")projectedEvidence(f,stream,"initial");
    const replaced=projectedEvidence(f,stream,"final");f.at(140_000);f.save(f.view("final",patch));
    expect(f.read(id,{grantId:"between"})).toMatchObject({text:"initial"});
    expect(f.pins()[0]).toMatchObject(stream==="log"?{replaced_log_position:replaced}:{replaced_journal_position:replaced});
  });

it.each(["current_path","lineage_claim_id","restore_fence_generation"])
  ("a matching journal projection cannot erase a different %s replacement",async column=>{
    const f=await fixture(false),patch={lineageClaimId:sha256("lineage"),restoreGeneration:1};
    f.save(f.view("baseline",patch));f.save(f.view("initial",patch));f.at(130_000);f.save();
    const id=String(f.pins()[0]!.pin_id),position=projectedEvidence(f,"journal","initial");
    f.db.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE journal_cursor=?`)
      .run(column==="current_path"?"docs/else.md":column==="lineage_claim_id"?sha256("other-lineage"):2,position);
    f.grant("late");projectedEvidence(f,"journal","final");f.at(140_000);f.save(f.view("final",patch));
    expect(f.read(id,{grantId:"late"})).toMatchObject({status:"ready"});
  });

it.each(["log","journal"])("History-only sampling keeps the carried state's %s entry after restart",async stream=>{
  const f=await fixture(false),lineage=sha256("lineage"),patch={lineageClaimId:lineage,restoreGeneration:1};
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(f.view("public",patch));
  const entered=replacementEvidence(f.db,stream);f.at(101_000);f.save(f.view("private paragraph",patch));
  const deleted=replacementEvidence(f.db,stream);f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
  f.at(102_000);f.save(f.view("public",patch));f.grant("late");f.restart();
  const header=f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get();
  f.at(131_000);f.storage.sampleReplicaHistory(f.lease);
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get()).toEqual(header);
  expect(f.db.prepare("SELECT state_log_cursor,state_journal_cursor FROM sync_relay_history_clocks").get())
    .toEqual({state_log_cursor:stream==="log"?entered:0,state_journal_cursor:stream==="journal"?entered:0});
  const pin=f.pins()[0]!;expect(pin.reason).toBe("quiet");f.restart();
  replacementEvidence(f.db,stream);f.at(132_000);f.save(f.view("public",{...patch,restoreGeneration:2}));
  expect(f.read(String(pin.pin_id),{grantId:"late"})).toMatchObject({status:"ready"});
  expect(f.read(String(pin.pin_id))).toMatchObject({text:"private paragraph"});
  expect(f.pins().find(p=>p.pin_id===pin.pin_id)).toMatchObject(stream==="log"?
    {replaced_log_position:deleted}:{replaced_journal_position:deleted});
});

it.each(["return","no-op"])("ordinary Y.Doc %s evidence keeps the conservative replacement boundary",async kind=>{
  const f=await fixture(false),doc=markdownToYDoc("initial");
  const append=(base=false)=>{
    const bytes=Buffer.from(Y.encodeStateAsUpdate(doc)),digest=sha256(bytes);
    f.db.prepare("INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('w',?,?,?)").run(digest,bytes.length,bytes);
    const seq=replacementEvidence(f.db,"log");
    f.db.prepare("UPDATE sync_relay_log SET op_kind='ydoc.update',payload_json=? WHERE relay_seq=?")
      .run(JSON.stringify({versionId:"main",objectId:"object",path:"docs/a.md",contentKind:"richdoc",
        lineageClaimId:lineage,isBaseState:base,updateBlobSha256:digest}),seq);
    return seq;
  };
  const lineage=sha256(Buffer.from(Y.encodeStateAsUpdate(doc))),patch={lineageClaimId:lineage,restoreGeneration:1};
  try {
    append(true);f.save(f.view("baseline",patch));f.save(f.view("initial",patch));f.at(130_000);f.save();
    const id=String(f.pins()[0]!.pin_id);
    if(kind==="return")doc.getMap("frontmatter").set("title","intermediate");
    const replaced=append();f.grant("between");
    if(kind==="return"){doc.getMap("frontmatter").delete("title");append();}
    doc.getMap("frontmatter").set("title","final");append();
    f.at(140_000);f.save(f.view(yDocToArtifactMarkdown(doc),patch));
    expect(f.read(id,{grantId:"between"})).toMatchObject({status:"ready"});
    expect(f.pins()[0]).toMatchObject({replaced_log_position:replaced});
  } finally {doc.destroy();}
});

it.each(["log","journal"])("a missing clock preserves a carried state's %s structural pin for editors",async stream=>{
  const f=await fixture(false),lineage=sha256("lineage"),patch={lineageClaimId:lineage,restoreGeneration:1};
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(f.view("public",patch));replacementEvidence(f.db,stream);f.at(101_000);f.save(f.view("private paragraph",patch));
  replacementEvidence(f.db,stream);f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
  f.at(102_000);f.save(f.view("public",patch));
  // A pre-migration cut can have advanced past its carried state's deletion without a clock.
  f.db.exec("DELETE FROM sync_relay_history_clocks");f.grant("late");
  replacementEvidence(f.db,stream);f.at(103_000);f.save(f.view("public",{...patch,restoreGeneration:2}));
  const pin=f.pins().find(p=>p.sha256===sha256("private paragraph"))!;
  expect(f.read(String(pin.pin_id),{grantId:"late"})).toMatchObject({status:"ready"});
  expect(f.read(String(pin.pin_id))).toMatchObject({text:"private paragraph"});
});

it("a persist error clears the pending view before reporting a failed restore flip",async()=>{
  const f=await fixture(false),lineage=sha256("lineage"),patch={lineageClaimId:lineage,restoreGeneration:1};
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(f.view("public",patch));replacementEvidence(f.db,"log");f.at(101_000);f.save(f.view("private paragraph",patch));
  f.at(131_000);f.storage.sampleReplicaHistory(f.lease);const pin=String(f.pins()[0]!.pin_id);
  replacementEvidence(f.db,"log");f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
  f.at(132_000);f.save(f.view("public",patch));f.grant("late");
  replacementEvidence(f.db,"log");const incoming=f.view("public",{...patch,restoreGeneration:2});
  const failure=new Error("injected flip failure"),observed:Array<{error:unknown;read:unknown;view:unknown}>=[];
  vi.spyOn(f.storage,"flipReplicaCurrentView").mockImplementation(()=>{throw failure;});
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-persist-failure"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...incoming,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})}),
    onError:(_workspace,error)=>observed.push({error,view:supervisor.currentReadView("w")?.view,
      read:f.storage.readReplicaHistoryPin({...f.input,grantId:"late",pinId:pin},supervisor)})});
  try {
    await expect(supervisor.activate("w")).rejects.toThrow(failure);
    expect(observed[0]?.error).toBe(failure);
    expect(observed[0]?.read).toEqual({status:"not-found"});
    expect(observed[0]?.view).toMatchObject({logCursor:2,files:[{sha256:sha256("private paragraph"),restoreGeneration:1}]});
    expect(f.db.prepare("SELECT superseded_at_ms FROM sync_relay_history_pins WHERE pin_id=?").get(pin))
      .toEqual({superseded_at_ms:null});
  } finally {await supervisor.close();vi.restoreAllMocks();}
});

it.each(["op-kind","echo","refused"])("author scan excludes %s rows before charging its cap",async noise=>{
  const f=await fixture();
  f.db.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,
    relay_admission,settlement_admission_json) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
    SELECT 'w','noise',i,?,'{"objectId":"object","versionId":"main"}',1,?,? FROM n`)
    .run(noise==="op-kind"?"live.audit.update":"moment.append",noise==="echo"?"departed":null,
      noise==="refused"?' {"status":"refused"}':null);
  const seq=replacementEvidence(f.db,"log");
  f.db.prepare("UPDATE sync_relay_log SET admitted_author_snapshot_json=? WHERE relay_seq=?")
    .run('[{"kind":"human","humanId":"writer","humanName":"Writer"}]',seq);
  f.save(f.view());f.at(130_000);f.save();
  expect(JSON.parse(String(f.pins()[0]!.authors_json))).toEqual([{kind:"human",humanId:"writer",humanName:"Writer"}]);
});

it.each(["replication_epoch","stream_identity"])("current reads fail closed on a mismatched floor %s",async column=>{
  const f=await fixture();f.save();const source={currentReadView:()=>({view:f.latest})};
  f.db.exec(`UPDATE sync_relay_history_grant_floors SET ${column}='previous' WHERE grant_id='g'`);
  for(const current of [undefined,source]) {
    expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},current)).toEqual({status:"updating"});
    expect(f.storage.listReplicaCurrentViewFiles(f.input,current)).toEqual({status:"updating"});
    expect(f.storage.listReplicaHistoryPins(f.input,current)).toEqual({status:"updating"});
  }
});

it("position-only views let a floor-ahead grant finish updating",async()=>{
  const f=await fixture();f.save();replacementEvidence(f.db,"log");f.grant("late");
  expect(f.list({grantId:"late"})).toEqual({status:"updating"});
  expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:"late",path:"docs/a.md"})).toEqual({status:"updating"});
  const store=vi.spyOn(f.storage,"storeReplicaCurrentView");
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-positions"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...f.view(),delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");
    expect(f.list({grantId:"late"})).toMatchObject({status:"ready"});
    expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:"late",path:"docs/a.md"})).toMatchObject({status:"ready",text:"initial"});
    expect(store).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT log_cursor FROM sync_relay_replica_cuts").get()).toEqual({log_cursor:1});
  } finally {await supervisor.close();vi.restoreAllMocks();}
});

it.each(["stale-header","log-regression","journal-regression","log-ahead","journal-ahead","workspace","omissions","epoch","stream"])
  ("header-only advancement refuses %s without changing the cut",async change=>{
    const f=await fixture();replacementEvidence(f.db,"log");replacementEvidence(f.db,"journal");f.save(f.view());
    const previous={...f.storage.readReplicaCurrentView("w")!},next=f.view();
    if(change==="stale-header")previous.revision++;
    if(change==="log-regression")next.logCursor=0;
    if(change==="journal-regression")next.journalCursor=0;
    if(change==="log-ahead")next.logCursor++;
    if(change==="journal-ahead")next.journalCursor++;
    if(change==="workspace")next.workspaceId="other";
    if(change==="omissions")next.omitted=[{versionId:"main",objectId:"omitted",path:"docs/o.md",sha256:sha256("x"),reason:"text-frame-limit"}];
    if(change==="epoch" || change==="stream")f.db.exec(`UPDATE sync_relay_workspaces SET ${change==="epoch"?"replication_epoch":"stream_identity"}='next'`);
    const before=f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get();
    expect(()=>f.storage.advanceReplicaCurrentView(f.lease,next,previous)).toThrow();
    expect(f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get()).toEqual(before);
  });

it("header-only advancement samples due pins at the new positions",async()=>{
  const f=await fixture();f.save();const previous=f.storage.readReplicaCurrentView("w")!;
  replacementEvidence(f.db,"log");replacementEvidence(f.db,"journal");f.at(130_000);
  f.storage.advanceReplicaCurrentView(f.lease,f.view(),previous);
  expect(f.pins()).toMatchObject([{reason:"quiet",log_cursor:1,journal_cursor:1}]);
  expect(f.db.prepare("SELECT pin_log_cursor,pin_journal_cursor FROM sync_relay_history_clocks").get())
    .toEqual({pin_log_cursor:1,pin_journal_cursor:1});
});

it("a pending file edit survives cursor-only views and retirement uses one flip",async()=>{
  const f=await fixture();f.save();let latest=f.latest;
  const advance=vi.spyOn(f.storage,"advanceReplicaCurrentView"),store=vi.spyOn(f.storage,"storeReplicaCurrentView"),sample=vi.spyOn(f.storage,"sampleReplicaHistory");
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-header-pending"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");latest=f.view("changed");await supervisor.activate("w");
    replacementEvidence(f.db,"log");latest=f.view("changed");await supervisor.activate("w");
    await supervisor.evict("w");
    expect(f.storage.readReplicaCurrentView("w")).toMatchObject({logCursor:1,files:[{sha256:sha256("changed")}]});
    expect(advance).not.toHaveBeenCalled();expect(store).toHaveBeenCalledTimes(1);expect(sample).not.toHaveBeenCalled();
  }finally{await supervisor.close();vi.restoreAllMocks();}
});

it.each(["log","journal"])("current view floor refuses stale stored and live text after a %s replacement",async stream=>{
  const f=await fixture();f.save(f.view("secret"));const stale=f.latest;
  replacementEvidence(f.db,stream);f.grant("late");
  const input={...f.input,grantId:"late"};
  for(const source of [undefined,{currentReadView:()=>({view:stale})}]) {
    expect(f.storage.listReplicaCurrentViewFiles(input,source)).toEqual({status:"updating"});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:"docs/a.md"},source)).toEqual({status:"updating"});
  }
  f.save(f.view("public"));expect(f.storage.readReplicaCurrentViewFile({...input,path:"docs/a.md"})).toMatchObject({text:"public"});
});

it("Undo raises the restored grant floor past private edits made during removal",async()=>{
  const f=await fixture();f.save();
  const removal=f.storage.removeShareAccess({shareId:"g",grantId:"g",actorUserId:"owner",nowMs:100_000});
  if(!removal.ok || !removal.undo)throw Error("removal failed");
  f.save(f.view("public"));replacementEvidence(f.db,"log");f.at(101_000);f.save(f.view("private paragraph"));
  f.at(131_000);f.save();const id=String(f.pins().find(p=>p.sha256===sha256("private paragraph"))!.pin_id);
  replacementEvidence(f.db,"log");f.at(132_000);f.save(f.view("public"));
  f.storage.undoShareRemoval({shareId:"g",actorUserId:"owner",undoId:removal.undo.undoId,nowMs:133_000});
  f.save();
  expect(f.read(id,{generation:3})).toMatchObject({status:"ready"});
  expect(f.read(id,{grantId:"wide"})).toMatchObject({text:"private paragraph"});
});

const work = vi.hoisted(()=>({sampling:false,active:false,ms:0,rows:{files:0,clocks:0,pins:0},queries:[] as Array<{sql:string;rows:number;args:unknown[]}>}));
vi.mock("./storage/replicaHistoryPins",async original=>{
  const real=await original<typeof import("./storage/replicaHistoryPins")>();
  return {...real,pinReplicaHistory:(...args:Parameters<typeof real.pinReplicaHistory>)=>{
    const start=performance.now();work.sampling=true;
    try{return real.pinReplicaHistory(...args);}finally{work.sampling=false;if(work.active)work.ms+=performance.now()-start;}
  }};
});

it("measures a 1 MB replacement flip with a superseded pin per update",async()=>{
  const f=await fixture(false),initial="x".repeat(1_000_000),doc=markdownToYDoc(initial);
  const baseline=Buffer.from(Y.encodeStateAsUpdate(doc)),lineage=sha256(baseline),patch={lineageClaimId:lineage,restoreGeneration:1};
  const append=(bytes:Buffer,base=false)=>{
    const digest=sha256(bytes);
    f.db.prepare("INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('w',?,?,?)").run(digest,bytes.length,bytes);
    const seq=replacementEvidence(f.db,"log");
    f.db.prepare("UPDATE sync_relay_log SET op_kind='ydoc.update',payload_json=? WHERE relay_seq=?")
      .run(JSON.stringify({versionId:"main",objectId:"object",path:"docs/a.md",contentKind:"richdoc",lineageClaimId:lineage,
        isBaseState:base,updateBlobSha256:digest}),seq);
    return seq;
  };
  const samples:Array<{flipMs:number;samplingMs:number;blobReads:number;blobBytes:number;replacement:number;pinId:string}>=[];
  let blobReads=0,blobBytes=0;
  const getBlob=f.storage.getBlob.bind(f.storage);
  vi.spyOn(f.storage,"getBlob").mockImplementation((...args)=>{
    const blob=getBlob(...args);if(work.active && work.sampling){blobReads++;blobBytes+=blob?.length ?? 0;}return blob;
  });
  try {
    append(baseline,true);f.save(f.view("baseline",patch));f.save(f.view(initial,patch));f.at(130_000);f.storage.sampleReplicaHistory(f.lease);
    for(let i=0;i<5;i++){
      const previous=f.pins().find(p=>p.superseded_at_ms===null)!;
      const vector=Y.encodeStateVector(doc);doc.getMap("frontmatter").set("revision",i);
      const replacement=append(Buffer.from(Y.encodeStateAsUpdate(doc,vector)));
      const text=yDocToArtifactMarkdown(doc);f.at(140_000+i*40_000);
      const staged=f.storage.stageReplicaCurrentView(f.lease,f.view(text,patch));
      work.ms=0;blobReads=blobBytes=0;work.active=true;
      const start=performance.now();f.storage.flipReplicaCurrentView(f.lease,staged);const flipMs=performance.now()-start;work.active=false;
      samples.push({flipMs,samplingMs:work.ms,blobReads,blobBytes,replacement,pinId:String(previous.pin_id)});
      expect(f.pins().find(p=>p.pin_id===previous.pin_id)).toMatchObject({superseded_at_ms:140_000+i*40_000,replaced_log_position:replacement});
      f.at(170_000+i*40_000);f.storage.sampleReplicaHistory(f.lease);
    }
    if(process.env.DOHC_REPLACEMENT_OUT)writeFileSync(process.env.DOHC_REPLACEMENT_OUT,JSON.stringify({bodyBytes:Buffer.byteLength(initial),updates:samples.length,samples},null,2)+"\n");
    expect(f.pins().filter(p=>p.superseded_at_ms!==null)).toHaveLength(5);
  } finally {work.active=false;doc.destroy();vi.restoreAllMocks();}
},120_000);

it("incremental sampling visits only one changed object among 20,000 files",async()=>{
  const prepare=DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype,"prepare").mockImplementation(function(this:DatabaseSync,sql){
    const prepared=prepare.call(this,sql);
    return new Proxy(prepared,{get(target,key){
      const method=Reflect.get(target,key,target);
      if(typeof method!=="function")return method;
      return (...args:unknown[])=>{
        const result=method.apply(target,args);
        if(work.active && work.sampling && (key==="all" || key==="get")){
          const table=/FROM sync_relay_(replica_cut_files|history_clocks|history_pins)\b/.exec(sql)?.[1];
          const count=key==="all" ? result.length : result ? 1 : 0;
          if(table){
            work.rows[table==="replica_cut_files"?"files":table==="history_clocks"?"clocks":"pins"]+=count;
            work.queries.push({sql,rows:count,args});
          }
        }
        return result;
      };
    }});
  });
  try{
    const f=await fixture(false),files=Array.from({length:20_000},(_,i)=>f.file("initial",{objectId:`object-${i}`,path:`docs/${i}.md`}));
    f.save({...f.view(),files});
    // Keep 1,000 current pins so a workspace-wide unsuperseded-pin scan is visible.
    f.db.exec(`INSERT INTO sync_relay_history_pins SELECT object_id,workspace_id,version_id,object_id,path,content_kind,
      sha256,byte_length,lineage_claim_id,restore_generation,'quiet',100000,NULL,0,0,'[]',NULL,NULL
      FROM sync_relay_replica_cut_files WHERE workspace_id='w' ORDER BY object_id LIMIT 1000;
      UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count+1000 WHERE workspace_id='w'`);
    f.restart();
    const next={...f.view("changed"),files:files.map((file,i)=>i?file:f.file("changed",{objectId:"object-0",path:"docs/0.md"}))};
    const staged=f.storage.stageReplicaCurrentView(f.lease,next);
    work.rows={files:0,clocks:0,pins:0};work.ms=0;work.queries=[];work.active=true;
    const start=performance.now();f.storage.flipReplicaCurrentView(f.lease,staged);const flipMs=performance.now()-start;work.active=false;
    const queries=work.queries.map(({sql,rows,args})=>({sql,rows,plan:f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)}));
    const result={files:files.length,population:{clocks:20_000,currentPins:1000},rows:work.rows,samplingMs:work.ms,flipMs,otherFlipMs:flipMs-work.ms,queries};
    if(process.env.DOHC_INCREMENTAL_OUT)writeFileSync(process.env.DOHC_INCREMENTAL_OUT,JSON.stringify(result,null,2)+"\n");
    expect(work.rows.clocks).toBeLessThanOrEqual(1);
    expect(work.rows.pins).toBeLessThanOrEqual(1);
    expect(work.rows.files).toBeLessThanOrEqual(1);
    expect(JSON.stringify(queries)).toContain("replica_history_due");
    expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_history_clocks WHERE dirty_since_ms IS NOT NULL").get()).toMatchObject({n:1});
    expect(f.db.prepare("SELECT superseded_at_ms FROM sync_relay_history_pins WHERE object_id='object-0'").get()).toMatchObject({superseded_at_ms:100_000});
    f.restart();expect(f.storage.nextReplicaHistoryPinAt("w")).toBe(130_000);
    f.at(130_000);f.save(next);
    expect(f.pins().find(p=>p.sha256===sha256("changed"))).toMatchObject({reason:"quiet",superseded_at_ms:null});
  }finally{work.active=false;vi.restoreAllMocks();}
},120_000);

it("cursor-only views at 20,000 files read and rewrite no file rows",async()=>{
  let active=false,reads=0,writes=0,txMs=0,transactions=0;
  const prepare=DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype,"prepare").mockImplementation(function(this:DatabaseSync,sql){
    const prepared=prepare.call(this,sql);
    return new Proxy(prepared,{get(target,key){
      const method=Reflect.get(target,key,target);if(typeof method!=="function")return method;
      return (...args:unknown[])=>{
        const result=method.apply(target,args);
        if(active && /\bFROM sync_relay_replica_cut_files\b/.test(sql) && (key==="all" || key==="get"))
          reads+=key==="all"?result.reduce((n:number,row:Record<string,unknown>)=>n+Number(row.n??1),0):result?1:0;
        if(active && /^(INSERT INTO|DELETE FROM|UPDATE) sync_relay_replica_cut_files\b/.test(sql) && key==="run")writes+=Number(result.changes);
        return result;
      };
    }});
  });
  const f=await fixture(false),files=Array.from({length:20_000},(_,i)=>f.file("initial",{objectId:`object-${i}`,path:`docs/${i}.md`}));
  f.save({...f.view(),files});
  let incoming=f.latest;
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-header-only"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...incoming,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  const context=f.storage as StorageContext,tx=context.replicaViewTx.bind(context);
  vi.spyOn(context,"replicaViewTx").mockImplementation(run=>{
    const start=performance.now();try{return tx(run);}finally{if(active){transactions++;txMs+=performance.now()-start;}}
  });
  try {
    await supervisor.activate("w");
    const before=f.db.prepare("SELECT cut_seq FROM sync_relay_replica_cuts").get()!;
    replacementEvidence(f.db,"log");incoming={...f.view(),files,texts:[]};
    // The fixture admits evidence through a second connection. Warm its data_version before measuring.
    const cached=f.storage.readReplicaCurrentView("w")!;
    active=true;await supervisor.activate("w");await vi.advanceTimersByTimeAsync(2000);
    const saved=f.storage.readReplicaCurrentView("w")!;active=false;
    const result={files:files.length,fileRowsRead:reads,fileRowsWritten:writes,transactions,transactionMs:txMs};
    if(process.env.DOHC_HEADER_OUT)writeFileSync(process.env.DOHC_HEADER_OUT,JSON.stringify(result,null,2)+"\n");
    expect(saved).toMatchObject({logCursor:1,revision:incoming.revision});
    expect(f.db.prepare("SELECT cut_seq FROM sync_relay_replica_cuts").get()).toEqual({cut_seq:Number(before.cut_seq)+1});
    expect(reads).toBe(0);expect(writes).toBe(0);expect(transactions).toBe(1);
    expect(saved.files).toBe(cached.files);
  }finally{active=false;await supervisor.close();vi.restoreAllMocks();}
},120_000);

it.each(["last-share","epoch","stream"])("retirement after %s ends standing reports no error",async change=>{
  const f=await fixture();f.save();const onError=vi.fn();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-retired-standing"),onError,
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...f.latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");f.at(130_000);
    if(change==="last-share")f.db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=130000");
    else f.db.exec(`UPDATE sync_relay_workspaces SET ${change==="epoch"?"replication_epoch":"stream_identity"}='next'`);
    await supervisor.evict("w");expect(onError).not.toHaveBeenCalled();
  }finally{await supervisor.close();}
});

it("upgrade removes orphan current pins but retains omitted and superseded pins",async()=>{
  const f=await fixture();f.save();f.at(130_000);f.save();
  const original=String(f.pins()[0]!.pin_id);
  f.db.exec(`ALTER TABLE sync_relay_replica_cuts ADD COLUMN omitted_json TEXT NOT NULL DEFAULT '[]';
    DROP TABLE sync_relay_replica_cut_omitted; DELETE FROM sync_relay_migrations WHERE migration_id='replica-current-incremental-v1';
    DROP TRIGGER replica_history_usage_insert; DROP TRIGGER replica_history_usage_delete;
    DROP TRIGGER replica_history_usage_update; DROP TRIGGER replica_history_identity_floor;
    DROP TABLE sync_relay_history_pin_usage; DROP INDEX replica_history_due;
    DROP INDEX IF EXISTS replica_history_log_clock; DROP INDEX IF EXISTS replica_history_journal_clock;
    DROP INDEX replica_history_current_pin;
    DELETE FROM sync_relay_migrations WHERE migration_id='replica-history-incremental-v1';
    DROP TRIGGER replica_current_view_grant_update;
    CREATE TRIGGER replica_current_view_grant_update AFTER UPDATE ON sync_relay_share_grants BEGIN
      DELETE FROM sync_relay_replica_cuts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id);
    END;
    INSERT INTO sync_relay_history_pins SELECT 'omitted',workspace_id,version_id,'omitted',path,content_kind,sha256,byte_length,
      lineage_claim_id,restore_generation,reason,pinned_at_ms,NULL,log_cursor,journal_cursor,authors_json,NULL,NULL FROM sync_relay_history_pins;
    INSERT INTO sync_relay_history_pins SELECT 'superseded',workspace_id,version_id,'past',path,content_kind,sha256,byte_length,
      lineage_claim_id,restore_generation,reason,pinned_at_ms,130000,log_cursor,journal_cursor,authors_json,NULL,NULL FROM sync_relay_history_pins WHERE pin_id='${original}';
    UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count+2;
    UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=130000 WHERE grant_id='g';
    INSERT INTO sync_relay_replica_cuts VALUES ('w','e','s','old',1,1,0,0,
      '[{"versionId":"main","objectId":"omitted","path":"docs/omitted.md","sha256":"${sha256("initial")}","reason":"text-frame-limit"}]')`);
  f.restart();
  expect(f.pins().map(p=>p.pin_id).sort()).toEqual(["omitted","superseded"]);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs").get()).toEqual({ref_count:2});
  f.save(f.view());f.at(160_000);f.storage.sampleReplicaHistory(f.lease);
  expect(f.pins().filter(p=>p.object_id==="object" && p.superseded_at_ms===null)).toHaveLength(1);
  replacementEvidence(f.db,"log");f.grant("late");f.save(f.view("final"));
  const pin=f.pins().find(p=>p.object_id==="object")!;
  expect(f.read(String(pin.pin_id),{grantId:"late"})).toMatchObject({status:"ready"});
  f.restart();expect(f.pins().some(p=>p.pin_id===original)).toBe(false);
});

it.each(["g","wide"])("surviving share retains current text and pins after %s ends",async ending=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const pin=String(f.pins()[0]!.pin_id);
  const survivor=ending==="g"?"wide":"g";
  f.storage.revokeShareGrant({shareId:ending,grantId:ending,revokedAtMs:140_000});
  expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:survivor,path:"docs/a.md"})).toMatchObject({status:"ready",text:"initial"});
  expect(f.read(pin,{grantId:survivor})).toMatchObject({status:"ready",text:"initial"});
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(sha256("initial"))).toMatchObject({ref_count:2});
  f.restart();expect(f.read(pin,{grantId:survivor})).toMatchObject({text:"initial"});
  f.storage.revokeShareGrant({shareId:survivor,grantId:survivor,revokedAtMs:150_000});
  for(const table of ["replica_cuts","history_pins","history_clocks","replica_cut_texts","replica_cut_text_refs"])
    expect(f.db.prepare(`SELECT count(*) AS n FROM sync_relay_${table}`).get()).toMatchObject({n:0});
});

it.each(["grant-delete","share-delete","share-owner","share-move","selector"])("surviving share keeps the cut on %s",async change=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const pin=String(f.pins()[0]!.pin_id);
  if(change==="grant-delete")f.db.exec("DELETE FROM sync_relay_share_grants WHERE share_id='g'");
  else if(change==="share-delete")f.db.exec("DELETE FROM sync_relay_shares WHERE share_id='g'");
  else if(change==="share-owner")f.db.exec("UPDATE sync_relay_shares SET granter_user_id='other' WHERE share_id='g'");
  else if(change==="selector")f.db.exec(`UPDATE sync_relay_shares SET selector_json='{"paths":["elsewhere"],"versionId":null}' WHERE share_id='g'`);
  else {
    f.storage.claimWorkspace({workspaceId:"other",ownerUserId:"owner",createdAtMs:1});
    f.db.exec("UPDATE sync_relay_shares SET workspace_id='other' WHERE share_id='g'");
  }
  expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:"wide",path:"docs/a.md"})).toMatchObject({status:"ready",text:"initial"});
  expect(f.read(pin,{grantId:"wide"})).toMatchObject({status:"ready",text:"initial"});
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(sha256("initial"))).toMatchObject({ref_count:2});
});


it.each(["epoch","stream","null-epoch"])("current grant floors restart at the %s identity transition",async change=>{
  const f=await fixture(); f.save(); f.at(130_000); f.save();
  const old=String(f.pins()[0]!.pin_id);
  replacementEvidence(f.db,"log"); replacementEvidence(f.db,"journal");
  if(change==="null-epoch") {
    f.db.exec("UPDATE sync_relay_workspaces SET replication_epoch=NULL WHERE workspace_id='w'");
    f.grant("waiting");
  }
  f.db.exec(`UPDATE sync_relay_workspaces SET ${change==="stream"?"stream_identity":"replication_epoch"}='new' WHERE workspace_id='w'`);
  for(const id of change==="null-epoch"?["g","wide","waiting"]:["g","wide"])
    expect(f.db.prepare("SELECT * FROM sync_relay_history_grant_floors WHERE grant_id=?").get(id)).toMatchObject({
      replication_epoch:change==="stream"?"e":"new",stream_identity:change==="stream"?"new":"s",log_floor:1,journal_floor:1});
  f.restart(); f.at(140_000); f.save(f.view("baseline")); f.save(f.view("public")); f.at(170_000); f.save();
  const pin=String(f.pins()[0]!.pin_id);
  for(const id of change==="null-epoch"?["g","wide","waiting"]:["g","wide"]){
    expect(f.read(old,{grantId:id})).toEqual({status:"not-found"});
    expect(f.read(pin,{grantId:id})).toMatchObject({text:"public"});
  }
  // Edit grants can read retained History once the current view reaches their floor.
  replacementEvidence(f.db,"log"); f.grant("late"); f.save(f.view("later"));
  expect(f.read(pin,{grantId:"late"})).toMatchObject({status:"ready"});
});

it("deletes a departed object's clock instead of retaining a clean tombstone",async()=>{
  const f=await fixture(); f.save(); f.save({...f.view(),files:[],texts:[]});
  expect(f.db.prepare("SELECT * FROM sync_relay_history_clocks").all()).toEqual([]);
});

it("a restarted supervisor arms and samples History without flipping an unchanged cut",async()=>{
  const f=await fixture(); f.save(); f.restart();
  const flip=vi.spyOn(f.storage,"flipReplicaCurrentView"),store=vi.spyOn(f.storage,"storeReplicaCurrentView");
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-only"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...f.latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  const header=()=>f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get();
  const before=header();
  try {
    await supervisor.activate("w"); expect(store).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.pins()).toMatchObject([{reason:"quiet"}]);
    expect(flip).not.toHaveBeenCalled(); expect(header()).toEqual(before);
  } finally {await supervisor.close();}
});

it("retirement samples an already due pin before releasing the lease",async()=>{
  const f=await fixture(); f.save();
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-retire"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...f.latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  await supervisor.activate("w"); f.at(130_000); await supervisor.evict("w");
  expect(f.pins()).toMatchObject([{reason:"quiet"}]); await supervisor.close();
});

it("upgrades existing pins, clocks and stale floors once without resetting matching floors",async()=>{
  const f=await fixture(); f.save(); f.at(130_000); f.save();
  const pin=String(f.pins()[0]!.pin_id);
  replacementEvidence(f.db,"log"); f.at(140_000); f.save(f.view("next"));
  // Recreate the previous migration's grant trigger and remove only this migration's schema.
  f.db.exec(`ALTER TABLE sync_relay_replica_cuts ADD COLUMN omitted_json TEXT NOT NULL DEFAULT '[]';
    DROP TABLE sync_relay_replica_cut_omitted; DELETE FROM sync_relay_migrations WHERE migration_id='replica-current-incremental-v1';
    DROP TRIGGER replica_current_view_grant_update;
    CREATE TRIGGER replica_current_view_grant_update AFTER UPDATE ON sync_relay_share_grants BEGIN
      DELETE FROM sync_relay_replica_cuts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id);
    END;
    DROP TRIGGER replica_history_usage_insert; DROP TRIGGER replica_history_usage_delete;
    DROP TRIGGER replica_history_usage_update; DROP TRIGGER replica_history_identity_floor;
    DROP TABLE sync_relay_history_pin_usage;
    DROP INDEX replica_history_due;
    DROP INDEX replica_history_current_pin;
    UPDATE sync_relay_history_grant_floors SET replication_epoch='previous' WHERE grant_id='g';
    DELETE FROM sync_relay_migrations WHERE migration_id='replica-history-incremental-v1'`);
  f.restart();
  expect(f.db.prepare("SELECT * FROM sync_relay_history_pin_usage").get()).toMatchObject({pin_count:1});
  expect(f.db.prepare("SELECT log_floor FROM sync_relay_history_grant_floors WHERE grant_id='g'").get()).toEqual({log_floor:1});
  expect(f.db.prepare("SELECT log_floor FROM sync_relay_history_grant_floors WHERE grant_id='wide'").get()).toEqual({log_floor:0});
  expect(f.read(pin)).toMatchObject({status:"ready"});
  expect(f.read(pin,{grantId:"wide"})).toMatchObject({text:"initial"});
  f.storage.revokeShareGrant({shareId:"g",grantId:"g",revokedAtMs:140_000});
  expect(f.read(pin,{grantId:"wide"})).toMatchObject({text:"initial"});
  expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:"wide",path:"docs/a.md"})).toMatchObject({text:"next"});
  f.restart(); expect(f.storage.nextReplicaHistoryPinAt("w")).toBe(170_000);
  f.at(170_000); f.storage.sampleReplicaHistory(f.lease);
  expect(f.pins().find(p=>p.sha256===sha256("next"))).toMatchObject({reason:"quiet"});
});

it("supersedes a pin and deletes its clock when an omitted object disappears",async()=>{
  const f=await fixture(); f.save(); f.at(130_000); f.save(); const pin=String(f.pins()[0]!.pin_id);
  f.at(140_000); f.save({...f.view(),files:[],texts:[],omitted:[{versionId:"main",objectId:"object",path:"docs/a.md",sha256:sha256("initial"),reason:"text-frame-limit"}]});
  expect(f.pins()[0]!.superseded_at_ms).toBeNull();
  replacementEvidence(f.db,"log"); f.at(150_000); f.save({...f.view(),files:[],texts:[]});
  expect(f.pins()[0]!.superseded_at_ms).toBe(150_000);
  expect(f.db.prepare("SELECT * FROM sync_relay_history_clocks").all()).toEqual([]);
  f.grant("late"); f.at(160_000); f.save(f.view());
  expect(f.read(pin,{grantId:"late"})).toMatchObject({status:"ready"});
});

function replacementEvidence(db: ReturnType<typeof inspectDatabase>, stream: string, object = "object") {
  if (stream === "log") return Number(db.prepare(`INSERT INTO sync_relay_log
    (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    VALUES ('w','replacement',coalesce((SELECT max(origin_seq)+1 FROM sync_relay_log WHERE origin_id='replacement'),0),
      'moment.append',?,1) RETURNING relay_seq`).get(JSON.stringify({versionId:"main",objectId:object,operation:"write",path:"docs/a.md"}))!.relay_seq);
  return Number(db.prepare(`INSERT INTO sync_relay_live_update_journal
    (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
    restore_fence_generation,principal_kind,principal_id,accepting_host_epoch,received_at_ms,update_bytes,
    relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,canonical_version,first_seen_deletes_json)
    VALUES (?,?, 'w','main',?,?,'docs/a.md','["docs"]',1,'owner','owner',1,1,x'01','ns',1,?,1,2,'[{"clientId":1,"startClock":0,"endClock":1}]')
    RETURNING journal_cursor`).get(`delivery-${object}-${db.prepare("SELECT count(*) AS n FROM sync_relay_live_update_journal").get()!.n}`,sha256("update"),object,sha256("lineage"),sha256("evidence"))!.journal_cursor);
}

it.each([
  ["log","restore"],["journal","restore"],["log","quiet"],["journal","quiet"],
])("keeps carried-state replacement evidence for a %s %s pin through a pending restore",async(stream,sampling)=>{
  const f=await fixture(false),lineage=sha256("lineage"),patch={lineageClaimId:lineage,restoreGeneration:1};
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(f.view("public",patch));
  const entered=replacementEvidence(f.db,stream);f.at(101_000);f.save(f.view("private paragraph",patch));
  expect(f.pins()).toHaveLength(0);
  f.grant("before-delete");
  const deleted=replacementEvidence(f.db,stream);f.at(102_000);
  const table=stream==="log"?"sync_relay_log":"sync_relay_live_update_journal",cursor=stream==="log"?"relay_seq":"journal_cursor";
  const authorColumn=stream==="log"?"admitted_author_snapshot_json":"author_snapshot_json";
  const writer={kind:"human",humanId:"writer",humanName:"Writer"},deleter={kind:"human",humanId:"deleter",humanName:"Deleter"};
  for(const [position,author] of [[entered,writer],[deleted,deleter]] as const)
    f.db.prepare(`UPDATE ${table} SET ${authorColumn}=? WHERE ${cursor}=?`).run(JSON.stringify([author]),position);
  f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
  f.save(f.view("public",patch));
  expect(f.storage.readReplicaCurrentView("w")!.files[0]!.sha256).toBe(sha256("private paragraph"));
  expect(f.storage.readReplicaCurrentView("w")).toMatchObject({logCursor:stream==="log"?deleted:0,journalCursor:stream==="journal"?deleted:0});
  f.grant("late");let quietId:unknown;
  if(sampling==="quiet"){
    f.at(131_000);f.save();quietId=f.pins()[0]!.pin_id;expect(f.pins()[0]).toMatchObject({reason:"quiet"});
    f.restart();
  }
  replacementEvidence(f.db,stream);f.at(sampling==="quiet"?132_000:103_000);
  f.save(f.view("public",{...patch,restoreGeneration:2}));
  const pin=f.pins().find(p=>p.sha256===sha256("private paragraph"))!;
  expect(f.read(String(pin.pin_id),{grantId:"late"})).toMatchObject({status:"ready"});
  expect(f.read(String(pin.pin_id))).toMatchObject({text:"private paragraph"});
  expect(f.read(String(pin.pin_id),{grantId:"before-delete"})).toMatchObject({text:"private paragraph"});
  expect(JSON.parse(String(pin.authors_json))).toEqual(expect.arrayContaining([writer,deleter]));
  expect(pin).toMatchObject({reason:"restore",log_cursor:stream==="log"?deleted:0,journal_cursor:stream==="journal"?deleted:0,
    replaced_log_position:stream==="log"?deleted:null,replaced_journal_position:stream==="journal"?deleted:null});
  if(sampling==="quiet")expect(pin.pin_id).toBe(quietId);
  // A newly observed state's entry excludes its own entering row from replacement evidence.
  expect(entered).toBeLessThan(deleted);
});

it("does not carry snapshot.previous below the grant floor through a restore fence",async()=>{
  const f=await fixture(false),lineage=sha256("lineage");
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',2,1,1,'${lineage}',0,'${lineage}',x'01')`);
  const previous=f.view("private paragraph",{lineageClaimId:lineage,restoreGeneration:2});f.save(previous);
  replacementEvidence(f.db,"log");f.grant("late");
  const view=f.view("public",{lineageClaimId:lineage,restoreGeneration:1}),input={...f.input,grantId:"late",path:"docs/a.md"};
  expect(f.storage.readReplicaCurrentViewFile(input,{currentReadView:()=>({view,previous})})).toEqual({status:"updating"});
  expect(f.storage.listReplicaCurrentViewFiles(input,{currentReadView:()=>({view,previous})}))
    .toMatchObject({files:[{path:"docs/a.md",status:"updating"}]});
  expect(f.storage.readReplicaCurrentViewFile(input,{currentReadView:()=>({view,previous:{...previous,logCursor:view.logCursor}})}))
    .toMatchObject({text:"private paragraph"});
});

it.each(["log","journal"])("current readiness floor delays full History until the %s replacement is collected", async stream => {
  const f=await fixture();f.save(f.view("draft"));f.at(101_000);f.save(f.view("secret"));f.at(131_000);f.save();
  const id=String(f.pins().find(p=>p.sha256===sha256("secret"))!.pin_id);
  const position=replacementEvidence(f.db,stream);
  f.at(140_000);f.grant("late",["docs"],140_000);
  const publicView={...f.view("public"),logCursor:stream==="log"?position:0,journalCursor:stream==="journal"?position:0};
  expect(f.read(id,{grantId:"late"})).toEqual({status:"updating"});
  expect(f.storage.readReplicaHistoryPin({...f.input,grantId:"late",pinId:id},
    {currentReadView:()=>({view:publicView})})).toEqual({status:"updating"});
  f.at(200_000);f.save(publicView);
  expect(f.read(id,{grantId:"late"})).toMatchObject({status:"ready"});
  expect(f.read(id)).toMatchObject({status:"ready",text:"secret"});
});

it.each(["log","journal"])("position floor preserves a state current at access before a later %s replacement", async stream => {
  const f=await fixture();f.save(f.view("draft"));f.at(101_000);f.save(f.view("secret"));f.at(131_000);f.save();
  const id=String(f.pins().find(p=>p.sha256===sha256("secret"))!.pin_id);
  f.grant("early",["docs"],999_999);expect(f.read(id,{grantId:"early"})).toMatchObject({text:"secret"});
  const position=replacementEvidence(f.db,stream);
  f.at(200_000);f.save({...f.view("public"),logCursor:stream==="log"?position:0,journalCursor:stream==="journal"?position:0});
  expect(f.read(id,{grantId:"early"})).toMatchObject({status:"ready",text:"secret"});
});

it("edit access includes retained pins with unresolved replacing evidence", async()=>{
  const f=await fixture();f.save(f.view("draft"));f.at(101_000);f.save(f.view("secret"));f.at(131_000);f.save();
  const id=String(f.pins().find(p=>p.sha256===sha256("secret"))!.pin_id);
  f.save(f.view("public"));expect(f.read(id)).toMatchObject({status:"ready"});
});

it.each(["same-stream","both-streams"])("position floor uses the earliest replacement in each %s interval",async kind=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const id=String(f.pins()[0]!.pin_id);
  const first=replacementEvidence(f.db,"log");f.grant("between");
  if(kind==="both-streams")replacementEvidence(f.db,"journal");
  else replacementEvidence(f.db,"log");
  f.save(f.view("public"));expect(f.read(id)).toMatchObject({text:"initial"});
  expect(f.read(id,{grantId:"between"})).toMatchObject({status:"ready"});
  expect(f.pins()[0]).toMatchObject({replaced_log_position:first,replaced_journal_position:kind==="both-streams"?1:null});
});

it("captures link and redeemed dependent floors in their grant transactions and rolls them back",async()=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const id=String(f.pins()[0]!.pin_id);
  const log=replacementEvidence(f.db,"log"),journal=replacementEvidence(f.db,"journal","other-object");
  seedLinkGrant(f.storage,{shareId:"g",grantId:"link-floor",secretHash:"hash"});
  expect(f.storage.mintLinkHandoffCode({code:{codeId:"code",codeHash:"code-hash",grantId:"link-floor",generation:1,
    mintedAtMs:10,expiresAtMs:100},guard:()=>true})).toBe(true);
  expect(f.storage.redeemLinkHandoffCode({codeHash:"code-hash",principalUserId:"reader",redeemedAtMs:20,
    mintGrantId:()=>"dependent-floor",guard:()=>true})).toMatchObject({ok:true});
  for(const id of ["link-floor","dependent-floor"])
    expect(f.db.prepare("SELECT * FROM sync_relay_history_grant_floors WHERE grant_id=?").get(id))
      .toMatchObject({workspace_id:"w",replication_epoch:"e",stream_identity:"s",log_floor:log,journal_floor:journal});
  f.save(f.view("public"));
  expect(f.read(id,{grantId:"link-floor",principal:{kind:"link",requireSession(){return {grantId:"link-floor",generation:1};}}})).toEqual({status:"denied"});
  expect(f.read(id,{grantId:"dependent-floor"})).toEqual({status:"denied"});
  expect(f.read(id)).toMatchObject({text:"initial"});
  f.db.exec(`CREATE TRIGGER reject_credential BEFORE INSERT ON sync_relay_link_credentials BEGIN SELECT RAISE(ABORT,'refuse'); END`);
  expect(()=>f.storage.createLinkGrant({grant:{...f.storage.getShareGrant("link-floor")!,grantId:"rolled-back"},
    credential:{credentialId:"reject",grantId:"rolled-back",secretHash:"reject",generation:1,mintedAtMs:10,retiredAtMs:null}})).toThrow("refuse");
  expect(f.db.prepare("SELECT * FROM sync_relay_history_grant_floors WHERE grant_id='rolled-back'").get()).toBeUndefined();
});

it("first sight is clean and a 2,000-file workspace retains superseded History after edits", async()=>{
  const f=await fixture(false),text="initial",files=Array.from({length:2000},(_,i)=>f.file(text,{objectId:`object-${i}`,path:`docs/${i}.md`}));
  let view={...f.view(),files};f.save(view);f.at(130_000);f.save();expect(f.pins()).toHaveLength(0);
  for(let edit=1;edit<=3;edit++){
    replacementEvidence(f.db,"log","object-0");
    f.at(140_000+edit*60_000);view={...view,revision:view.revision+1,files:view.files.map((file,i)=>i?file:f.file(`edit-${edit}`,{objectId:"object-0",path:"docs/0.md"})),
      logCursor:f.storage.readReplicaStanding("w")!.logSeq,texts:[{sha256:sha256(`edit-${edit}`),text:`edit-${edit}`} ]};
    f.save(view);f.at(170_000+edit*60_000);f.save();
  }
  expect(f.pins().filter(p=>p.superseded_at_ms!==null).length).toBeGreaterThan(0);
  expect(f.pins().length).toBeLessThanOrEqual(1024);
  for(const pin of f.pins())expect(f.read(String(pin.pin_id))).toMatchObject({status:"ready"});
});

it("keeps superseded History with more than 1,024 edited current states",async()=>{
  const f=await fixture(false),files=Array.from({length:1100},(_,i)=>f.file("baseline",{objectId:`object-${i}`,path:`docs/${i}.md`}));
  f.save({...f.view("baseline"),files});
  f.save({...f.view(),files:files.map(file=>({...file,sha256:sha256("initial"),byteLength:7}))});
  f.at(130_000);f.save();expect(f.pins()).toHaveLength(1100);
  replacementEvidence(f.db,"log","object-0");
  f.at(140_000);f.save({...f.latest,revision:f.latest.revision+1,logCursor:f.storage.readReplicaStanding("w")!.logSeq,
    files:f.latest.files.map((file,i)=>i?file:{...file,sha256:sha256("next"),byteLength:4}),texts:[{sha256:sha256("next"),text:"next"}]});
  f.at(170_000);f.save();
  const old=f.pins().find(p=>p.object_id==="object-0" && p.superseded_at_ms!==null)!;
  expect(old).toBeDefined();expect(f.read(String(old.pin_id))).toMatchObject({text:"initial"});
});

it("pins a created state relative to an established cut",async()=>{
  const f=await fixture();const created=f.file("created",{objectId:"new",path:"docs/new.md"});
  f.save({...f.view(),files:[f.file(),created],texts:[{sha256:sha256("initial"),text:"initial"},{sha256:sha256("created"),text:"created"}]});
  f.at(130_000);f.save();expect(f.pins().find(p=>p.object_id==="new")).toMatchObject({reason:"quiet",sha256:sha256("created")});
});

it.each(["rename","delete","lineage","restore"])("relabels an exact quiet predecessor for %s without another text reference",async reason=>{
  const f=await fixture(),lineage=sha256("lineage");
  const patch=reason==="restore"?{lineageClaimId:lineage,restoreGeneration:1}:{};
  f.save(f.view("initial",patch));f.at(130_000);f.save();
  const predecessor=f.pins().find(p=>p.superseded_at_ms===null)!;
  f.at(140_000);replacementEvidence(f.db,"log");
  if(reason==="restore")f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',2,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(reason==="delete"?{...f.view(),files:[],texts:[]}:f.view("initial",reason==="rename"?{path:"docs/b.md"}:
    {lineageClaimId:lineage,restoreGeneration:reason==="restore"?2:1}));
  expect(f.pins().filter(p=>p.sha256===sha256("initial") && p.path===predecessor.path && p.lineage_claim_id===predecessor.lineage_claim_id))
    .toEqual([expect.objectContaining({pin_id:predecessor.pin_id,reason})]);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(sha256("initial")))
    .toMatchObject({ref_count:reason==="delete"?1:2});
});

it("starts new clocks at the baseline cut's author cursors",async()=>{
  const f=await fixture(false);replacementEvidence(f.db,"log");replacementEvidence(f.db,"journal");
  f.db.exec(`UPDATE sync_relay_log SET admitted_author_snapshot_json='[{"kind":"human","humanId":"old","humanName":"Old"}]';
    UPDATE sync_relay_live_update_journal SET author_snapshot_json='[{"kind":"human","humanId":"old","humanName":"Old"}]'`);
  f.save(f.view("baseline"));f.save(f.view());f.at(130_000);f.save();
  expect(JSON.stringify(f.pins()[0]!.authors_json)).not.toContain("Old");
  expect(f.db.prepare("SELECT pin_log_cursor,pin_journal_cursor FROM sync_relay_history_clocks").get()).toEqual({pin_log_cursor:1,pin_journal_cursor:1});
});

it.each(["log","journal"])("spends the author cap only on the pin's file in %s",async stream=>{
  const f=await fixture();
  replacementEvidence(f.db,stream);
  const table=stream==="log"?"sync_relay_log":"sync_relay_live_update_journal";
  const authors=stream==="log"?"admitted_author_snapshot_json":"author_snapshot_json";
  f.db.exec(`UPDATE ${table} SET ${authors}='[{"kind":"human","humanId":"author","humanName":"Author"}]'`);
  // Unrelated rows precede the target in the scan's position order.
  if(stream==="log")f.db.exec(`UPDATE sync_relay_log SET relay_seq=10002;
    INSERT INTO sync_relay_log (relay_seq,workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
    SELECT i,'w','noise',i,'moment.append','{"objectId":"other","versionId":"main"}',1 FROM n`);
  else f.db.exec(`UPDATE sync_relay_live_update_journal SET object_id='other';`);
  if(stream==="journal"){
    // Use the journal fixture repeatedly inside one transaction to exceed the workspace cap.
    f.db.exec("BEGIN");for(let i=0;i<10001;i++)replacementEvidence(f.db,"journal","other");f.db.exec("COMMIT");
    replacementEvidence(f.db,"journal");f.db.exec(`UPDATE sync_relay_live_update_journal SET ${authors}='[{"kind":"human","humanId":"author","humanName":"Author"}]' WHERE object_id='object'`);
  }
  f.save(f.view());f.at(130_000);f.save();
  expect(JSON.parse(String(f.pins()[0]!.authors_json))).toEqual([{kind:"human",humanId:"author",humanName:"Author"}]);
});

async function fixture(seedBaseline = true) {
  vi.useFakeTimers({toFake:["Date", "setTimeout", "clearTimeout"]}); vi.setSystemTime(100_000);
  let storage = await testStorage();
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
  const grant = (id: string, paths = ["docs"], createdAtMs = 1) => storage.createShare({
    share:{shareId:id,workspaceId:"w",granterUserId:"owner",selectorJson:JSON.stringify({paths,versionId:null}),createdAtMs},
    grant:{grantId:id,shareId:id,principalKind:"user",principalUserId:"reader",principalEmail:null,access:"edit",generation:1,status:"active",createdAtMs,revokedAtMs:null,parentGrantId:null}});
  grant("wide", ["docs","private"]); grant("g");
  let lease = createReplicaReadPrincipal(storage).issue("w", "test"); storage.bindReplicaCurrentView(lease);
  const db = inspectDatabase(storagePath(storage)); let revision = 0;
  const file = (text = "initial", patch = {}) => ({versionId:"main",objectId:"object",path:"docs/a.md",contentKind:"text" as const,
    sha256:sha256(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null,...patch});
  const view = (text = "initial", patch = {}): ReplicaCurrentView => ({workspaceId:"w",revision:++revision,
    logCursor:storage.readReplicaStanding("w")!.logSeq,journalCursor:storage.readReplicaStanding("w")!.journalCursor,
    files:[file(text,patch)],texts:[{sha256:sha256(text),text}],omitted:[]});
  // Most policy tests start with an edit of an established clean baseline.
  if (seedBaseline) storage.storeReplicaCurrentView(lease,view("baseline"));
  let latest = view();
  const save = (v = latest) => {latest = v; storage.storeReplicaCurrentView(lease,v);};
  const pins = () => db.prepare("SELECT * FROM sync_relay_history_pins ORDER BY pinned_at_ms,pin_id").all();
  const input = {grantId:"g",generation:1,principal:{kind:"user" as const,userId:"reader"}};
  const list = (extra = {}) => storage.listReplicaHistoryPins({...input,...extra});
  const read = (pinId: string, extra = {}) => storage.readReplicaHistoryPin({...input,pinId,...extra});
  const at = (ms: number) => vi.setSystemTime(ms);
  const restart = () => {
    const path = storagePath(storage); closeTestStorage(storage); storage = reopenTestStorage(path);
    lease = createReplicaReadPrincipal(storage).issue("w", "restart"); storage.bindReplicaCurrentView(lease);
  };
  return {get storage(){return storage;},get lease(){return lease;},db,grant,file,view,save,pins,list,read,input,at,restart,get latest(){return latest;}};
}

it.each(["view","comment"])("R4: %s denies named and link pin lists and known pins after downgrade",async access=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const pinId=String(f.pins()[0]!.pin_id);
  f.db.prepare("UPDATE sync_relay_share_grants SET access=? WHERE grant_id='g'").run(access);
  expect(f.list()).toEqual({status:"denied"});expect(f.read(pinId)).toEqual({status:"denied"});
  seedLinkGrant(f.storage,{shareId:"g",grantId:"r4-link",secretHash:sha256("r4-link"),access:access as "view"|"comment"});
  const input={grantId:"r4-link",generation:1,principal:{kind:"link" as const,requireSession(){return {grantId:"r4-link",generation:1};}}};
  expect(f.storage.listReplicaHistoryPins(input)).toEqual({status:"denied"});
  expect(f.storage.readReplicaHistoryPin({...input,pinId})).toEqual({status:"denied"});
});

it("R4: edit History includes retained in-scope pins superseded before the grant",async()=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const pinId=String(f.pins()[0]!.pin_id);
  replacementEvidence(f.db,"log");f.at(140_000);f.save(f.view("later"));f.grant("r4-late");f.save(f.view("later"));
  expect(f.read(pinId,{grantId:"r4-late"})).toMatchObject({status:"ready",text:"initial"});
  expect(f.list({grantId:"r4-late"})).toMatchObject({status:"ready",pins:[expect.objectContaining({pinId})]});
});

it("pins after 30 seconds quiet, never turns every cut into History", async () => {
  const f = await fixture(); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(129_999); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(130_000); f.save(); expect(f.pins()).toMatchObject([{reason:"quiet",superseded_at_ms:null}]);
  f.at(160_000); f.save(); expect(f.pins()).toHaveLength(1);
});

it("pins at the five minute ceiling during edits and spaces non-structural pins", async () => {
  const f = await fixture(); f.save();
  for (let i = 1; i <= 15; i++) {f.at(100_000+i*20_000); f.save(f.view(String(i)));}
  expect(f.pins()).toMatchObject([{reason:"ceiling",pinned_at_ms:400_000}]);
  f.at(400_001); f.save(f.view("later")); f.at(430_000); f.save(); expect(f.pins()).toHaveLength(1);
  f.at(430_001); f.save(); expect(f.pins()).toHaveLength(2);
  expect(Number(f.pins()[1]!.pinned_at_ms)-Number(f.pins()[0]!.pinned_at_ms)).toBeGreaterThanOrEqual(30_000);
});

it.each(["rename","delete","restore","lineage"])("pins the previous state before %s", async reason => {
  const f = await fixture(); f.save(); f.at(100_001);
  // Null -> claimed lineage is a lineage change. A generation step uses a relay fence.
  if (reason === "restore") {
    const lineage = sha256("lineage");
    f.db.exec(`INSERT INTO sync_relay_live_documents
      (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
      baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
      VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
    f.save(f.view("before",{lineageClaimId:lineage,restoreGeneration:1}));
    f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
    f.save(f.view("after",{lineageClaimId:lineage,restoreGeneration:2}));
  } else if (reason === "delete") f.save({...f.view(),files:[],texts:[]});
  else f.save(f.view("after",reason === "rename" ? {path:"docs/b.md"} : {lineageClaimId:sha256("lineage"),restoreGeneration:1}));
  const pin = f.pins().find(p => p.reason === reason)!;
  expect(pin).toMatchObject({sha256:sha256(reason === "restore" ? "before" : "initial"),superseded_at_ms:100_001});
});

it("supersedes on the first edit and retains pre-grant History for edit access", async () => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.at(140_000); replacementEvidence(f.db,"log"); f.save({...f.view(),files:[],texts:[]});
  f.grant("new",["docs"],150_000);
  f.at(160_000); f.save(f.view("public"));
  expect(f.read(id,{grantId:"new"})).toMatchObject({status:"ready"});
  expect(f.read(id)).toMatchObject({status:"ready",text:"initial"});
  f.grant("equal",["docs"],140_000); expect(f.read(id,{grantId:"equal"})).toMatchObject({status:"ready"});
});

it("requires both the historical path and the object's current path to be visible", async () => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.at(140_000); replacementEvidence(f.db,"log"); f.save(f.view("private",{path:"private/a.md"}));
  expect(f.read(id)).toEqual({status:"not-found"});
  f.at(150_000); f.save(f.view("returned")); expect(f.read(id)).toMatchObject({text:"initial"});
  const privatePin = f.pins().find(p=>p.path === "private/a.md")!;
  expect(f.read(String(privatePin.pin_id))).toEqual({status:"not-found"});
  f.save({...f.view(),files:[],texts:[]}); expect(f.read(id)).toEqual({status:"not-found"});
});

it("rechecks revocation, generation, principal, narrowing and widening", async () => {
  const f = await fixture(); seedLinkGrant(f.storage,{shareId:"g",grantId:"link",secretHash:"hash",access:"edit"});
  f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  const input = {grantId:"link",principal:{kind:"link" as const,requireSession(){return {grantId:"link",generation:1};}}};
  expect(f.storage.retuneShareGrant({shareId:"g",grantId:"link",access:"view",changedAtMs:140_000,expectedDependentGrantIds:[],guard(){}}).ok).toBe(true);
  expect(f.read(id,input)).toEqual({status:"denied"});
  expect(f.storage.retuneShareGrant({shareId:"g",grantId:"link",access:"edit",changedAtMs:150_000,expectedDependentGrantIds:[],guard(){},
    mintCredential:()=>({credentialId:"widened",secretHash:"new-hash"})}).ok).toBe(true);
  expect(f.read(id,input)).toEqual({status:"denied"}); expect(f.read(id,{...input,generation:2,principal:{kind:"link",requireSession:()=>({grantId:"link",generation:2})}})).toMatchObject({status:"ready"});
  expect(f.read(id,{principal:{kind:"user",userId:"stranger"}})).toEqual({status:"denied"});
  f.storage.revokeShareGrant({shareId:"g",grantId:"link",revokedAtMs:160_000});
  expect(f.list(input)).toEqual({status:"denied"}); expect(f.read(id,input)).toEqual({status:"denied"});
});

it("keeps pins, text references and the policy clock across a relay restart", async () => {
  const f = await fixture(); f.save(); f.at(120_000); f.restart();
  f.at(129_999); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.at(140_000); replacementEvidence(f.db,"log"); f.save(f.view("next")); f.restart(); expect(f.read(id)).toMatchObject({text:"initial"});
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(sha256("initial"))).toMatchObject({ref_count:1});
});

it.each(["epoch","stream","workspace-owner","last-share","share-delete","share-owner"])("deletes pin data on %s", async change => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); expect(f.pins()).toHaveLength(1);
  if (change === "last-share") for (const id of ["g","wide"]) f.storage.revokeShareGrant({shareId:id,grantId:id,revokedAtMs:140_000});
  else if (change === "share-delete") f.db.exec("DELETE FROM sync_relay_shares");
  else if (change === "share-owner") f.db.exec("UPDATE sync_relay_shares SET granter_user_id='other'");
  else if (change === "workspace-owner") f.db.exec("UPDATE sync_relay_workspaces SET owner_user_id='other'");
  else f.db.exec(`UPDATE sync_relay_workspaces SET ${change === "epoch" ? "replication_epoch" : "stream_identity"}='new'`);
  expect(f.pins()).toHaveLength(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_texts").get()).toMatchObject({n:0});
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_text_refs").all()).toEqual([]);
});

it("accountless History projects paths and omits authors, without internal cursors", async () => {
  const f = await fixture(false); f.grant("project",["private/docs"]);
  seedLinkGrant(f.storage,{shareId:"project",grantId:"link",secretHash:"hash",access:"edit"});
  f.save(f.view("baseline",{path:"private/docs/a.md"}));
  f.save(f.view("initial",{path:"private/docs/a.md"})); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.db.prepare("UPDATE sync_relay_history_pins SET authors_json=?").run('[{"kind":"human","humanId":"owner","humanName":"Owner"}]');
  const result = f.read(id,{grantId:"link",principal:{kind:"link",requireSession(){return {grantId:"link",generation:1};}}});
  expect(result).toMatchObject({status:"ready",pin:{path:"docs/a.md",authors:[]},text:"initial"});
  const listed = f.list({grantId:"link",principal:{kind:"link",requireSession(){return {grantId:"link",generation:1};}}});
  expect(listed).toMatchObject({status:"ready",pins:[{path:"docs/a.md",authors:[]}]});
  for (const key of ["logCursor","journalCursor","log_cursor","journal_cursor","cut_seq"]) expect(JSON.stringify([result,listed])).not.toContain(key);
});

it("owners import zero pins and pin storage does not consume the owner's quota", async () => {
  const f = await fixture(); const before = f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:0,limit:100});
  const usage = f.db.prepare("SELECT * FROM sync_relay_workspace_usage").all();
  f.save(); f.at(130_000); f.save(); expect(f.pins()).toHaveLength(1);
  expect(f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:0,limit:100})).toEqual(before);
  expect(f.db.prepare("SELECT * FROM sync_relay_workspace_usage").all()).toEqual(usage);
  expect(f.storage.getBlob("w",sha256("initial"))).toBeNull();
});

it("the supervisor wakes for quiet pins and preserves an unflushed state before a move", async () => {
  const f = await fixture(); let latest = f.view();
  const supervisor = createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w"); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.pins()).toMatchObject([{reason:"quiet"}]);
    latest = f.view("unflushed"); await supervisor.activate("w");
    await vi.advanceTimersByTimeAsync(1_000); latest = f.view("moved",{path:"docs/b.md"}); await supervisor.activate("w");
    expect(f.pins().find(p=>p.reason === "rename")).toMatchObject({sha256:sha256("unflushed")});
  } finally {await supervisor.close();}
});

it("thins within workspace byte and count budgets, preserving current and structural states first", async () => {
  const f = await fixture();
  for (let i = 0; i < 8; i++) {f.at(100_000+i*60_000); f.save(f.view(String(i))); f.at(130_000+i*60_000); f.save();}
  f.at(560_001); f.save(f.view("renamed",{path:"docs/b.md"})); f.at(590_001); f.save();
  const modulePath = "./storage/replicaHistoryPins";
  const {thinReplicaHistoryPins} = await import(/* @vite-ignore */ modulePath);
  thinReplicaHistoryPins(f.storage as never,"w",{maxBytes:10_000,maxCount:3});
  const pins = f.pins(); expect(pins.filter(p=>p.superseded_at_ms!==null).length).toBeLessThanOrEqual(3);
  expect(pins.some(p=>p.reason === "rename")).toBe(true);
  expect(pins.some(p=>p.pinned_at_ms === 130_000)).toBe(true);
  expect(pins.some(p=>p.sha256 === sha256("renamed") && p.superseded_at_ms === null)).toBe(true);
  thinReplicaHistoryPins(f.storage as never,"w",{maxBytes:0,maxCount:0});
  expect(f.pins()).toMatchObject([{sha256:sha256("renamed")}]);
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/b.md"})).toMatchObject({text:"renamed"});
});

it("uses admitted ordinary authors, ignores forged payloads, refused settlements and audit echoes", async () => {
  const f = await fixture(); const human = (name: string) => [{kind:"human",humanId:name,humanName:name}];
  const add = (kind: string, snapshot: unknown, extra = {}, admission: unknown = null) => f.db.prepare(`INSERT INTO sync_relay_log
    (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json,settlement_admission_json)
    VALUES ('w','device',?, ?,?,1,?,?)`).run(++seq,kind,JSON.stringify({objectId:"object",versionId:"main",authors:human("forged"),...extra}),
      snapshot === null ? null : JSON.stringify(snapshot),admission === null ? null : JSON.stringify(admission));
  let seq = 0;
  add("ydoc.update",human("typing")); add("moment.append",human("moment"));
  add("moment.append",human("refused"),{},{status:"refused",settlementId:"x"});
  add("live.audit.update",human("audit")); add("ydoc.update",null);
  add("ydoc.update",human("other"),{objectId:"other"}); add("ydoc.update",human("branch"),{versionId:"branch"});
  f.save({...f.view(),logCursor:seq}); f.at(130_000); f.save();
  const authors = JSON.parse(String(f.pins()[0]!.authors_json));
  expect(authors).toEqual(expect.arrayContaining([...human("typing"),...human("moment"),{kind:"unattributed"}]));
  expect(JSON.stringify(authors)).not.toMatch(/forged|refused|audit|other|branch/);
  f.at(140_000); add("ydoc.update",human("next")); f.save({...f.view("next"),logCursor:seq});
  f.at(170_000); f.save(); expect(JSON.parse(String(f.pins()[1]!.authors_json))).toEqual(human("next"));
});

function lineageAuthors(f: Awaited<ReturnType<typeof fixture>>) {
  const human = (name: string) => ({kind:"human",humanId:name,humanName:name});
  const insert = f.db.prepare(`INSERT INTO sync_relay_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json)
    VALUES ('w','device',(SELECT count(*) FROM sync_relay_log),?,?,1,?)`);
  const add = (kind: string, name: string, payload: Record<string,unknown> = {}) =>
    insert.run(kind,JSON.stringify({versionId:"main",objectId:"object",...payload}),JSON.stringify([human(name)]));
  const authors = (text: string) => JSON.parse(String(f.pins().find(p => p.sha256 === sha256(text))!.authors_json));
  return {human,add,authors};
}

// A second device set up the same document before the two synced. Native ignores its base and deltas.
it("credits only the kept lineage's ordinary Y.Doc rows and keeps unreadable claims", async () => {
  const f = await fixture(false), {human,add,authors} = lineageAuthors(f), kept = sha256("kept"), losing = sha256("losing");
  const patch = {lineageClaimId:kept,restoreGeneration:1};
  f.save(f.view("baseline",patch));
  add("ydoc.update","winner",{lineageClaimId:kept,isBaseState:false});
  add("ydoc.update","losing base",{lineageClaimId:losing,isBaseState:true});
  add("ydoc.update","losing delta",{lineageClaimId:losing,isBaseState:false});
  add("moment.append","writer",{operation:"write"});
  add("ydoc.update","missing");
  add("ydoc.update","malformed",{lineageClaimId:"unknown"});
  add("ydoc.update","uppercase",{lineageClaimId:losing.toUpperCase()});
  add("ydoc.update","embedded NUL",{lineageClaimId:"b".repeat(64)+"\u0000damaged"});
  add("ydoc.update","number",{lineageClaimId:42});
  f.save(f.view("edited",patch)); f.at(130_000); f.save();
  expect(authors("edited")).toEqual(["winner","writer","missing","malformed","uppercase","embedded NUL","number"].map(human));
});

it("credits each state of a lineage change only with its own lineage's rows", async () => {
  const f = await fixture(false), {human,add,authors} = lineageAuthors(f);
  const predecessor = {lineageClaimId:sha256("predecessor"),restoreGeneration:1}, successor = {lineageClaimId:sha256("successor"),restoreGeneration:1};
  f.save(f.view("baseline",predecessor));
  add("ydoc.update","predecessor editor",{lineageClaimId:predecessor.lineageClaimId});
  f.save(f.view("predecessor",predecessor));
  // The successor's first pin starts at the predecessor's last cut, so it spans both lineages.
  // Known gap (#2541): the late predecessor editor's edit may survive into the successor, but relay
  // storage can't yet prove which resolution was installed or which side it kept, so no pin credits it.
  add("ydoc.update","late predecessor editor",{lineageClaimId:predecessor.lineageClaimId});
  add("ydoc.update","successor editor",{lineageClaimId:successor.lineageClaimId});
  add("ydoc.update","stale predecessor editor",{lineageClaimId:predecessor.lineageClaimId});
  f.at(100_001); f.save(f.view("successor",successor)); f.at(140_000); f.save();
  expect(f.pins().find(p => p.sha256 === sha256("predecessor"))).toMatchObject({reason:"lineage",lineage_claim_id:predecessor.lineageClaimId});
  expect(authors("predecessor")).toEqual([human("predecessor editor")]);
  expect(authors("successor")).toEqual([human("successor editor")]);
});

it("credits no named lineage's rows to a state with no lineage", async () => {
  const f = await fixture(false), {human,add,authors} = lineageAuthors(f);
  f.save(f.view("baseline"));
  add("ydoc.update","retired",{lineageClaimId:sha256("retired")});
  add("moment.append","writer",{operation:"write"});
  add("ydoc.update","missing");
  f.save(f.view("edited")); f.at(130_000); f.save();
  expect(authors("edited")).toEqual([human("writer"),human("missing")]);
});

it.each(["firstSeen","deletes","empty","seed"])("journal authors require credited content: %s", async source => {
  const f = await fixture(); const lineage = sha256("journal");
  f.db.prepare(`INSERT INTO sync_relay_live_update_journal
    (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
    restore_fence_generation,principal_kind,principal_id,accepting_host_epoch,received_at_ms,update_bytes,
    relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,canonical_version,author_snapshot_json,
    first_seen_deletes_json,seed_first_seen_json) VALUES ('d',?,'w','main','object',?,'docs/a.md','["docs"]',1,'owner','owner',1,1,?,
    'ns',1,?,1,2,?,?,?)`).run(sha256("update"),lineage,Buffer.from([1]),sha256("evidence"),
      JSON.stringify([{kind:"human",humanId:"journal",humanName:"Journal"}]),
      source === "deletes" ? '[{"clientId":1,"startClock":0,"endClock":1}]' : '[]',
      source === "seed" ? '[{"clientId":1,"startClock":0,"endClock":1}]' : '[]');
  if (source === "firstSeen" || source === "seed") f.db.prepare(`INSERT INTO sync_relay_live_update_struct_provenance
    VALUES ('w','main','object',?,1,0,1,1)`).run(lineage);
  f.save({...f.view(),journalCursor:1}); f.at(130_000); f.save();
  const authors = JSON.parse(String(f.pins()[0]!.authors_json));
  expect(authors).toEqual(source === "firstSeen" || source === "deletes" ? [{kind:"human",humanId:"journal",humanName:"Journal"}] : [{kind:"unattributed"}]);
});

it("caps the evidence scan at 10,000 raw rows and marks the uncovered suffix unattributed", async () => {
  const f = await fixture(); f.db.exec("BEGIN");
  const insert = f.db.prepare(`INSERT INTO sync_relay_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json)
    VALUES ('w','device',?,'ydoc.update','{"objectId":"object","versionId":"main"}',1,?)`);
  for (let i = 1; i <= 10_001; i++) insert.run(i,JSON.stringify([{kind:"human",humanId:i === 10_001 ? "past-cap" : "within",humanName:"Name"}]));
  f.db.exec("COMMIT"); f.save({...f.view(),logCursor:10_001}); f.at(130_000); f.save();
  expect(JSON.parse(String(f.pins()[0]!.authors_json))).toEqual([{kind:"human",humanId:"within",humanName:"Name"},{kind:"unattributed"}]);
});

it("ending one grant keeps other recipients' pins and text references", async () => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.storage.revokeShareGrant({shareId:"g",grantId:"g",revokedAtMs:140_000});
  expect(f.pins()).toHaveLength(1); f.save();
  expect(f.read(id,{grantId:"wide"})).toMatchObject({text:"initial"});
});

it("unions admitted identities, keeps maximum depth and uses shared moment normalization", async () => {
  const f = await fixture(); const human = {kind:"human",humanId:"h",humanName:"Human"};
  const agent = {kind:"agent",agentId:"a",agentName:"Agent",onBehalfOf:"h",depth:1};
  const automation = {kind:"automation",automationId:"collection:Tasks#mark",attribution:{actorKind:"automation",depth:2,onBehalfOf:"h"}};
  const snapshots = [[human,agent,automation],[human,{...agent,depth:3}],
    [{kind:"link",publicPrincipalId:"public-reader",label:"Reader"}],
    [{...agent,agentId:"orphan",onBehalfOf:"nobody"}]];
  const insert = f.db.prepare(`INSERT INTO sync_relay_log
    (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json)
    VALUES ('w','source',?,'moment.append','{"objectId":"object","versionId":"main"}',1,?)`);
  snapshots.forEach((snapshot,i)=>insert.run(i,JSON.stringify(snapshot)));
  f.save({...f.view(),logCursor:snapshots.length}); f.at(130_000); f.save();
  expect(JSON.parse(String(f.pins()[0]!.authors_json))).toEqual([human,{...agent,depth:3},
    {kind:"automation",automationId:automation.automationId,depth:2,onBehalfOf:"h"},
    {kind:"link",publicPrincipalId:"public-reader",label:"Reader"},{kind:"unattributed"}]);
});

it("rolls a pin and its clock back with a refused cut flip", async () => {
  const f = await fixture(); f.save(); f.at(130_000);
  f.db.exec("CREATE TRIGGER reject_flip BEFORE UPDATE ON sync_relay_replica_cuts BEGIN SELECT RAISE(ABORT,'test flip refusal'); END");
  expect(()=>f.save()).toThrow("test flip refusal"); expect(f.pins()).toHaveLength(0);
  f.db.exec("DROP TRIGGER reject_flip"); f.save(); expect(f.pins()).toMatchObject([{reason:"quiet",pinned_at_ms:130_000}]);
});

it("never retains transient edits as History or orphaned text", async () => {
  const f = await fixture(); f.save();
  for (let i=1;i<=20;i++) {f.at(100_000+i*1_000); f.save(f.view(`transient-${i}`));}
  expect(f.pins()).toHaveLength(0); f.at(150_000); f.save();
  expect(f.pins()).toMatchObject([{sha256:sha256("transient-20")}]);
  expect(f.db.prepare("SELECT DISTINCT sha256 FROM sync_relay_replica_cut_texts").all()).toEqual([{sha256:sha256("transient-20")}]);
});

it.each([false,true])("saves only still-shared pending predecessors when restore removes access (survivor=%s)", async survivor => {
  const f=await fixture(false), errors:unknown[]=[];
  const view=(text:string,renamed=false)=>{
    const v=f.view(text);
    if(survivor)v.files.push({...v.files[0]!,objectId:"other",path:`docs/public/${renamed?"renamed":"b"}.md`});
    return v;
  };
  let latest=view("baseline");
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-revoked-predecessor"),onError:(_,e)=>errors.push(e),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");latest=view("pending");await supervisor.activate("w");
    f.db.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({paths:survivor?["docs/public"]:[],versionId:null}));
    latest=view("pending",true);latest.files=latest.files.filter(file=>file.objectId==="other");latest.texts=survivor?latest.texts:[];
    await supervisor.activate("w");
    expect(errors).toEqual([]);
    expect(f.storage.readReplicaCurrentView("w")!.files.map(file=>file.path)).toEqual(survivor?["docs/public/renamed.md"]:[]);
    if(survivor)expect(f.pins().find(pin=>pin.object_id==="other" && pin.reason==="rename")).toMatchObject({sha256:sha256("pending")});
    else expect(f.pins().some(pin=>pin.sha256===sha256("pending"))).toBe(false);
  } finally {await supervisor.close();}
});

it("refreshes a hidden head before the History timer samples it",async()=>{
  const f=await fixture(false),errors:unknown[]=[];
  let latest=f.view("baseline"), pulls=0;
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-hidden-timer"),onError:(_,e)=>errors.push(e),
    startChild:async()=>({pull:async()=>{pulls++;},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");latest=f.view("edited");await supervisor.activate("w");
    await vi.advanceTimersByTimeAsync(2000);
    f.db.prepare("UPDATE sync_relay_shares SET selector_json=?").run('{"paths":[],"versionId":null}');
    latest={...latest,files:[],texts:[]};
    await vi.advanceTimersByTimeAsync(28000);
    await supervisor.settled("w");
    expect(errors).toEqual([]);expect(pulls).toBe(3);
    expect(f.storage.readReplicaCurrentView("w")!.files).toEqual([]);
  } finally {await supervisor.close();}
});

it("pins an unflushed pre-restore head even after the relay raises its generation fence", async () => {
  const f = await fixture(), lineage=sha256("restore-live");
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  let latest=f.view("initial",{lineageClaimId:lineage,restoreGeneration:1});
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-restore"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w"); latest=f.view("unflushed",{lineageClaimId:lineage,restoreGeneration:1}); await supervisor.activate("w");
    f.at(101_000); f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
    latest=f.view("restored",{lineageClaimId:lineage,restoreGeneration:2}); await supervisor.activate("w");
    expect(f.pins().find(p=>p.reason === "restore")).toMatchObject({sha256:sha256("unflushed")});
  } finally {await supervisor.close();}
});

it("applies the production count budget during the flip and keeps text references exact", async () => {
  const f=await fixture(); f.save(); f.at(130_000); f.save(); const pin=f.pins()[0]!, columns=Object.keys(pin);
  f.db.exec("BEGIN");
  const insert=f.db.prepare(`INSERT INTO sync_relay_history_pins (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for (let i=0;i<1024;i++) insert.run(...columns.map(c=>c === 'pin_id' ? `old-${i}` : c === 'superseded_at_ms' ? 120_000 : c === 'pinned_at_ms' ? i : pin[c]));
  f.db.exec("UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count+1024");
  f.db.exec("COMMIT"); f.save();
  expect(f.pins()).toHaveLength(1025);
  expect(f.pins().some(p=>p.pin_id === pin.pin_id)).toBe(true);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs").all()).toEqual([{ref_count:1026}]);
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"})).toMatchObject({text:"initial"});
});

it("reads the pin, grant and current visibility in one snapshot across an external revoke", async () => {
  const f=await fixture(); f.save(); f.at(130_000); f.save(); const id=String(f.pins()[0]!.pin_id),view=f.latest;
  const source={currentReadView:()=>{
    f.db.exec("UPDATE sync_relay_share_grants SET status='revoked',generation=2,revoked_at_ms=140000 WHERE grant_id='g'");
    return {view};
  }};
  expect(f.storage.readReplicaHistoryPin({...f.input,pinId:id},source)).toMatchObject({status:"ready",text:"initial"});
  expect(f.read(id)).toEqual({status:"denied"});
});

it("does not turn an omitted text frame into a delete or reset an unchanged state's quiet clock", async () => {
  const f=await fixture(); f.save();
  f.at(120_000); f.save({...f.view(),files:[],texts:[],omitted:[{versionId:"main",objectId:"object",path:"docs/a.md",sha256:sha256("initial"),reason:"text-frame-limit"}]});
  expect(f.pins()).toHaveLength(0); expect(f.storage.nextReplicaHistoryPinAt("w")).toBeNull();
  f.at(130_000); f.save(f.view()); expect(f.pins()).toMatchObject([{reason:"quiet",pinned_at_ms:130_000}]);
  f.at(140_000); f.save({...f.view(),files:[],texts:[],omitted:[{versionId:"main",objectId:"object",path:"docs/a.md",sha256:sha256("initial"),reason:"text-frame-limit"}]});
  expect(f.pins()).toMatchObject([{reason:"quiet",superseded_at_ms:null}]);
});

it("does not duplicate the current pin or reset its clock after another grant purges the cut", async () => {
  const f=await fixture(); f.save(); f.at(130_000); f.save();
  f.storage.revokeShareGrant({shareId:"g",grantId:"g",revokedAtMs:140_000});
  f.at(160_000); f.save(); expect(f.storage.nextReplicaHistoryPinAt("w")).toBeNull();
  f.at(190_000); f.save(); expect(f.pins()).toHaveLength(1);
});

it("does not rewrite text bytes when references change", async () => {
  const f=await fixture();f.save();
  for(let i=1;i<=6;i++){
    f.at(100_000+i*300_000);f.save(f.view(`pin-${i}`));
    f.at(130_000+i*300_000);f.save();
  }
  f.db.exec(`CREATE TABLE text_writes(sha TEXT);
    CREATE TRIGGER record_text_write AFTER UPDATE ON sync_relay_replica_cut_texts BEGIN INSERT INTO text_writes VALUES(NEW.sha256); END`);
  f.at(2_200_000);f.save(f.view("last"));
  const writes=f.db.prepare("SELECT sha FROM text_writes ORDER BY sha").all();
  expect(writes).toEqual([]);
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_text_refs WHERE ref_count>0").get()).toMatchObject({n:7});
});

it("migrates a stored 6a cut without multiplying references by its text chunks", async () => {
  const f=await fixture(false),sha=sha256("old");
  for(const row of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'replica_%'").all())
    f.db.exec(`DROP TRIGGER "${String(row.name).replaceAll('"','""')}"`);
  f.db.exec(`ALTER TABLE sync_relay_replica_cuts ADD COLUMN omitted_json TEXT NOT NULL DEFAULT '[]';
    DROP TABLE sync_relay_replica_cut_omitted; DELETE FROM sync_relay_migrations WHERE migration_id='replica-current-incremental-v1';
    DROP TABLE sync_relay_history_pins; DROP TABLE sync_relay_history_clocks; DROP TABLE sync_relay_history_grant_floors;
    DROP TABLE sync_relay_history_pin_usage;
    DROP INDEX replica_history_journal_position;
    DROP TABLE sync_relay_replica_cut_texts; DROP TABLE IF EXISTS sync_relay_replica_cut_text_refs;
    DELETE FROM sync_relay_migrations WHERE migration_id IN ('replica-history-pins-v1','replica-history-incremental-v1')`);
  initializeReplicaCurrentViewSchema(f.db as unknown as SqliteDb);
  f.db.exec(`INSERT INTO sync_relay_replica_cuts VALUES ('w','e','s','legacy',1,1,0,0,'[]')`);
  const file=f.db.prepare("INSERT INTO sync_relay_replica_cut_files VALUES ('w','main',?,?,'text',?,3,NULL,NULL)");
  file.run("a","docs/a.md",sha);file.run("b","docs/b.md",sha);
  const text=f.db.prepare("INSERT INTO sync_relay_replica_cut_texts VALUES ('w',?,?,?,2)");
  text.run(sha,0,Buffer.from("o"));text.run(sha,1,Buffer.from("ld"));
  for(let restart=0;restart<2;restart++){
    f.restart();
    expect(f.db.prepare("SELECT sha256,ref_count FROM sync_relay_replica_cut_text_refs").all()).toEqual([{sha256:sha,ref_count:2}]);
    expect(f.db.prepare("PRAGMA table_info(sync_relay_replica_cut_texts)").all().map(r=>r.name)).not.toContain("ref_count");
    expect(f.storage.readReplicaCurrentViewText("w",sha)).toBe("old");
  }
});
