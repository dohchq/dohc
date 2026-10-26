import {afterEach, expect, it} from "vitest";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {requireEngineBinaryOrSkip} from "../../../apps/desktop/src/testing/engineBinary";
import {registered, cleanupLiveDeliveryFixtures, hash} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {yDocToMarkdown,markdownToYDoc} from "../../../packages/ydoc-projection/src/import-export";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaEngineStarter} from "./replicaEngine";
import {createReplicaSupervisor,type ReplicaChild} from "./replicaSupervisor";
import {DiscussionActivityHub} from "./discussionActivity";
import {ReplicaWatches} from "./replicaWatches";
import {hashLinkBearer} from "./linkSecurity";
import {LINK_KEY,seedLinkGrant,seedLinkSession,testHandler,linkRequest,json,type HandlerOverrides} from "./testing";

const binary=requireEngineBinaryOrSkip();
afterEach(cleanupLiveDeliveryFixtures);
it.skipIf(binary.missing || process.platform !== "linux")("R4: a real journal-only revision wakes a link reader through the supervisor",async()=>{
  const f=await fixture();await f.child.close();
  const cuts:Array<{delta:boolean;files:number}>=[],errors:unknown[]=[];
  const start=createReplicaEngineStarter({engineExecutable:binary.require(),allowDevelopment:true});
  const supervisor=createReplicaSupervisor({storage:f.f.storage,storeRoot:join(f.root,"supervised"),onError:(_w,e)=>errors.push(e),startChild:async input=>{
    const child=await start(input);let seeded=false;
    return {...child,pull:async()=>{
      await child.pull();
      if(!seeded) {
        // This journal-only fixture needs an ordinary head for current-view collection.
        const text=yDocToMarkdown(f.f.doc),sha=hash(Buffer.from(text)),db=new DatabaseSync(join(input.storeDir,".dohc/engine/engine.db"));
        try {db.exec("BEGIN");db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?,?)").run(sha,Buffer.byteLength(text),text);db.prepare("INSERT OR IGNORE INTO path_aliases VALUES('workspace','main',?,'object')").run(f.f.input.evidence.currentPath);db.prepare("INSERT OR REPLACE INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('workspace','main','object',?,?,0,'baseline','test')").run(f.f.input.evidence.currentPath,sha);db.exec("COMMIT");}finally{db.close();}
        seeded=true;
      }
    },currentView:async(...args)=>{const page=await child.currentView(...args);cuts.push({delta:page.delta,files:page.files.length});return page;}};
  }});
  const activity=new DiscussionActivityHub(),watches=new ReplicaWatches(activity),token="c".repeat(43);
  seedLinkGrant(f.f.storage,{shareId:"share",grantId:"r4-link",secretHash:hashLinkBearer("s".repeat(43),LINK_KEY)});
  seedLinkSession(f.f.storage,{grantId:"r4-link",capabilityHash:hashLinkBearer(token,LINK_KEY)});
  const handler=testHandler(f.f.storage,{discussionActivity:activity,replicaWatches:watches,
    developmentReplicaReads:supervisor} as HandlerOverrides);
  const send=(path:string)=>handler(linkRequest(token,path));
  try {
    await supervisor.activate("workspace");expect(cuts).toEqual([{delta:false,files:1}]);
    const current=await json(await send("/sync/link/current"));
    expect(current.files).toHaveLength(1);
    const abort=new AbortController();
    const held=handler(linkRequest(token,`/sync/link/log?current=true&since=${current.nextCursor}&hold=30000`,{signal:abort.signal}));
    await expect.poll(()=>activity.stats().waiters).toBe(1);
    const cursor=f.commit("second-revision");await supervisor.activate("workspace");
    const changed=await json(await held),sha=hash(Buffer.from(yDocToMarkdown(f.f.doc)));
    expect(changed.ops).toContainEqual(expect.objectContaining({opKind:"file.current",payload:expect.objectContaining({file:expect.objectContaining({blobSha256:sha})})}));
    expect(await (await send(`/sync/link/blobs/${sha}`)).text()).toBe(yDocToMarkdown(f.f.doc));
    expect(watches.watched("workspace")).toBe(true);
    expect(cuts.slice(1)).toContainEqual({delta:true,files:1});
    expect(supervisor.currentReadView("workspace")!.view.journalCursor).toBe(cursor);
    expect(supervisor.currentView("workspace")!.view.files).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {watches.dispose();await supervisor.close();await f.close();}
},120_000);
async function fixture(retired=false, retireAuthority=true,baselineBytes?:Uint8Array) {
  const f=registered({deployment:true,baselineBytes});
  f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"epoch",streamIdentity:"stream"});
  const root=await mkdtemp(join(tmpdir(),"replica5b-native-"));
  const append={workspaceId:"workspace",originId:"device",ops:[{originSeq:0,opKind:"workspace.init",recordedAtMs:1,payloadJson:"{}"},
    {originSeq:1,opKind:"ydoc.update",recordedAtMs:2,payloadJson:JSON.stringify({versionId:"main",objectId:"object",path:f.input.evidence.currentPath,
      contentKind:"richdoc",updateBlobSha256:f.input.evidence.document.lineageClaimId,lineageClaimId:f.input.evidence.document.lineageClaimId,isBaseState:true})}]};
  f.storage.putBlob({workspaceId:"workspace",sha256:hash(f.input.baselineBytes),content:f.input.baselineBytes,createdAtMs:1});
  await f.storage.prepareLogAppend(append);f.storage.appendLogBatch(append);
  const commit=(id:string) => {
    const result=f.storage.commitLiveUpdateJournal(f.capture(f.update("counter",id),id));
    if(result.result.kind!=="accepted") throw new Error("Expected committed journal row.");return result.result.receipt.journalCursor;
  };
  let retiredCursor=0;
  if(retired) {
    retiredCursor=commit("before-rotation");
    if(retireAuthority)f.write(db=>db.exec("UPDATE sync_relay_live_documents SET lineage_state='retired',admission_state='closed',retired_at_ms=40"));
    expect(f.storage.rotateWorkspaceIdentity({workspaceId:"workspace",ownerUserId:"owner",replicationEpoch:"epoch-2",streamIdentity:"stream-2",rotatedAtMs:50})).toBe("rotated");
    f.write(db=>{expect(db.prepare("SELECT epoch_log_floor FROM sync_relay_workspaces").get()?.epoch_log_floor).toBe(2);});
  }
  const principal=createReplicaReadPrincipal(f.storage);
  // The lease is deliberately issued after rotation, so no old ordinary baseline reaches the child.
  const lease=principal.issue("workspace","native");
  let journalPaused=false;
  const relayHandler = async (request: Request) =>
      journalPaused && new URL(request.url).pathname === "/sync/workspace/live-journal"
        ? new Response(JSON.stringify({rows:[],nextCursor:0,hasMore:false}),{headers:{"content-type":"application/json"}})
        : await principal.handle(request);
  const startChild=()=>createReplicaEngineStarter({engineExecutable:binary.require(),allowDevelopment:true})({storeDir:root,lease,relayHandler});
  let child: ReplicaChild;
  try { child=await startChild();
  } catch(error) {
    f.close();await rm(root,{recursive:true,force:true});
    throw error;
  }
  const read=<T>(fn:(db:DatabaseSync)=>T)=>{const db=new DatabaseSync(join(root,".dohc/engine/engine.db"),{readOnly:true});try{return fn(db);}finally{db.close();}};
  const project=()=>read(db=>{
    const doc=new Y.Doc();try {
      const snapshot=db.prepare("SELECT s.up_to_seq,b.bytes FROM ydoc_snapshots s JOIN binary_blobs b ON b.sha256=s.snapshot_blob_sha256 ORDER BY s.up_to_seq DESC LIMIT 1").get();
      if(snapshot)Y.applyUpdate(doc,snapshot.bytes as Uint8Array);
      for(const row of db.prepare("SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.seq>? ORDER BY u.seq").all(Number(snapshot?.up_to_seq??0)))Y.applyUpdate(doc,row.bytes as Uint8Array);
      expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(f.doc));expect(yDocToMarkdown(doc)).toBe(yDocToMarkdown(f.doc));
    }finally{doc.destroy();}
  });
  return {f,root,lease,commit,get child(){return child;},read,project,retiredCursor,async resetToBaseline(){
    await child.close();await rm(join(root,".dohc"),{recursive:true,force:true});
    child=await startChild();journalPaused=true;
    try {await child.pull();}finally{journalPaused=false;}
  },async close(){await child.close();f.close();await rm(root,{recursive:true,force:true});}};
}

it.skipIf(binary.missing || process.platform !== "linux")("drains pre-epoch retired journal rows without fetching their missing baseline",async()=>{
  const f=await fixture(true);try {
    await f.child.pull();
    f.read(db=>{
      expect(db.prepare("SELECT count(*) AS n FROM ydoc_docs").get()?.n).toBe(0);
      expect(db.prepare("SELECT log_cursor,journal_cursor FROM replica_frontiers").get()).toEqual({log_cursor:0,journal_cursor:f.retiredCursor});
    });
  }finally{await f.close();}
},120_000);

it.skipIf(binary.missing || process.platform !== "linux")("drains pre-floor journal rows whose stale authority is still current",async()=>{
  const f=await fixture(true,false);try {
    expect((await f.f.storage.readReplicaLiveJournal({workspaceId:"workspace",after:0,limit:500})).rows[0]!.authority).not.toBeNull();
    await f.child.pull();
    f.read(db=>{
      expect(db.prepare("SELECT count(*) AS n FROM ydoc_docs").get()?.n).toBe(0);
      expect(db.prepare("SELECT journal_cursor FROM replica_frontiers").get()?.journal_cursor).toBe(f.retiredCursor);
    });
  }finally{await f.close();}
},120_000);

it.skipIf(binary.missing || process.platform !== "linux")("drains canonical journal pages into native heads without projecting or originating",async()=>{
  const f=await fixture();try {
    await f.child.pull();
    const before=f.read(db=>db.prepare("SELECT count(*) AS n FROM snapshots").get()?.n);
    for(let i=0;i<501;i++)f.commit(`live-${i}`);
    await f.child.pull();f.project();
    f.read(db=>{
      expect(db.prepare("SELECT count(*) AS n FROM snapshots").get()?.n).toBe(before);
      expect(db.prepare("SELECT event_count,evidence_digest FROM replica_documents").get()).toEqual({event_count:501,evidence_digest:f.f.journalRows().journal.at(-1)!.accepted_evidence_digest});
      for(const table of ["materialization_jobs","automation_claims","owner_ydoc_outboxes","live_audit_pending_exports"])
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,table).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM replication_log WHERE imported=0").get()?.n).toBe(0);
    });
  }finally{await f.close();}
},120_000);

it.skipIf(binary.missing || process.platform !== "linux" || process.env.DOHC_REPLICA_MEASURE!=="1")("measures release driver time from one and 500 commits through an on-demand projection",async()=>{
  const results=[];
  for(const size of [1,500]) {
    const samples:number[]=[];
    const f=await fixture();try {
      await f.child.pull();for(let i=0;i<size;i++)f.commit(`measurement-${i}`);
      for(let sample=0;sample<21;sample++) {
        if(sample)await f.resetToBaseline();
        const start=performance.now();await f.child.pull();f.project();samples.push(performance.now()-start);
        if(process.env.DOHC_REPLICA_MEASURE_OUT)await writeFile(`${process.env.DOHC_REPLICA_MEASURE_OUT}.progress`,JSON.stringify({rows:size,samples}));
      }
    }finally{await f.close();}
    samples.sort((a,b)=>a-b);results.push({rows:size,median:samples[10],p95:samples[19],samples});
    if(process.env.DOHC_REPLICA_MEASURE_OUT)await writeFile(process.env.DOHC_REPLICA_MEASURE_OUT,JSON.stringify(results));
    console.log(`DRIVER_MS rows=${size} median=${samples[10]} p95=${samples[19]} samples=21`);
  }
},600_000);

it.skipIf(binary.missing || process.platform !== "linux")("current views preserve nested-list bytes through the accepted journal lane",async()=>{
  const original=markdownToYDoc("- one\n  - child\n    - grandchild\n- two"),baselineBytes=Y.encodeStateAsUpdate(original);original.destroy();
  const f=await fixture(false,true,baselineBytes);try{
    await f.child.pull();const text=yDocToMarkdown(f.f.doc),sha=hash(Buffer.from(text));
    const db=new DatabaseSync(join(f.root,".dohc/engine/engine.db"));try{db.exec("BEGIN");db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?,?)").run(sha,Buffer.byteLength(text),text);db.prepare("INSERT OR IGNORE INTO path_aliases VALUES('workspace','main',?,'object')").run(f.f.input.evidence.currentPath);db.prepare("INSERT OR REPLACE INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('workspace','main','object',?,?,0,'baseline','test')").run(f.f.input.evidence.currentPath,sha);db.exec("COMMIT");}finally{db.close();}
    const initial=await f.child.currentView([{versionId:"main",paths:["docs"]}],[],undefined,undefined,undefined);expect(initial.texts[0]!.text).toBe(text);
    f.commit("nested-edit");await f.child.pull();
    const changed=await f.child.currentView([{versionId:"main",paths:["docs"]}],[],undefined,undefined,undefined);expect(changed.journalCursor).toBe(1);expect(changed.texts[0]!.text).toBe(yDocToMarkdown(f.f.doc));expect(changed.texts[0]!.text).toContain("grandchild");expect(changed.files[0]!.restoreGeneration).toBe(1);
  }finally{await f.close();}
},120_000);
