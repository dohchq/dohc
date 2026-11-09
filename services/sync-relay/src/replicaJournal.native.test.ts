import {afterEach, expect, it} from "vitest";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {cleanupLiveDeliveryFixtures, hash} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {yDocToMarkdown,markdownToYDoc} from "../../../packages/ydoc-projection/src/import-export";
import {createReplicaEngineStarter} from "./replicaEngine";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {DiscussionActivityHub} from "./discussionActivity";
import {ReplicaWatches} from "./replicaWatches";
import {hashLinkBearer} from "./linkSecurity";
import {LINK_KEY,seedLinkGrant,seedLinkSession,testHandler,linkRequest,json,type HandlerOverrides} from "./testing";
import {binary, fixture} from "./testing/replicaJournalNative";

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

it.skipIf(binary.missing || process.platform !== "linux")("drains pre-epoch retired journal rows without fetching their missing baseline",async()=>{
  const f=await fixture(true);try {
    await f.child.pull();
    f.read(db=>{
      expect(db.prepare("SELECT count(*) AS n FROM ydoc_docs").get()?.n).toBe(0);
      expect(db.prepare("SELECT log_cursor,journal_cursor FROM replica_frontiers").get()).toEqual({log_cursor:0,journal_cursor:f.retiredCursor});
    });
  }finally{await f.close();}
},120_000);

it.skipIf(binary.missing || process.platform !== "linux")("drains pre-epoch retired cancellations with null authority and no baseline",async()=>{
  const f=await fixture(true,true,undefined,true);try {
    const page=await f.f.storage.readReplicaLiveJournal({workspaceId:"workspace",after:0,limit:500});
    expect(page.rows.at(-1)).toMatchObject({journalCursor:f.retiredCursor,authority:null,cancellation:expect.any(Object)});
    await f.child.pull();
    f.read(db=>{
      expect(db.prepare("SELECT count(*) AS n FROM ydoc_docs").get()?.n).toBe(0);
      expect(db.prepare("SELECT log_cursor,journal_cursor FROM replica_frontiers").get()).toEqual({log_cursor:0,journal_cursor:f.retiredCursor});
    });
  }finally{await f.close();}
},120_000);

it.skipIf(binary.missing || process.platform !== "linux")("drains pre-floor journal rows whose stale authority is still current",async()=>{
  const f=await fixture(true,false);try {
    const first=(await f.f.storage.readReplicaLiveJournal({workspaceId:"workspace",after:0,limit:500})).rows[0]!;
    expect("cancellation" in first?null:first.authority).not.toBeNull();
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
