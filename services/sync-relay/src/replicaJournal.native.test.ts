import {afterEach, expect, it} from "vitest";
import {once} from "node:events";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {requireEngineBinaryOrSkip} from "../../../apps/desktop/src/testing/engineBinary";
import {registered, cleanupLiveDeliveryFixtures, hash} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {yDocToMarkdown} from "../../../packages/ydoc-projection/src/import-export";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaEngineStarter} from "./replicaEngine";
import type {ReplicaChild} from "./replicaSupervisor";

const binary=requireEngineBinaryOrSkip();
afterEach(cleanupLiveDeliveryFixtures);
async function fixture(retired=false, retireAuthority=true) {
  const f=registered({deployment:true});
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
  const server=createServer(async(incoming,outgoing)=>{
    try {
      const response=journalPaused && incoming.url?.startsWith("/sync/workspace/live-journal?")
        ? new Response(JSON.stringify({rows:[],nextCursor:0,hasMore:false}),{headers:{"content-type":"application/json"}})
        : await principal.handle(new Request(`http://127.0.0.1${incoming.url}`,{method:incoming.method,headers:incoming.headers as Record<string,string>}));
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){outgoing.writeHead(500);outgoing.end(String(error));}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw Error("Relay port");
  const startChild=()=>createReplicaEngineStarter({engineExecutable:binary.require(),baseUrl:`http://127.0.0.1:${address.port}`,allowUnisolatedDevelopment:true,
      allowInsecureLoopbackForTests:true})({storeDir:root,lease});
  let child: ReplicaChild;
  try { child=await startChild();
  } catch(error) {
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));f.close();await rm(root,{recursive:true,force:true});
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
  return {f,lease,commit,get child(){return child;},read,project,retiredCursor,async resetToBaseline(){
    await child.close();await rm(join(root,".dohc"),{recursive:true,force:true});
    child=await startChild();journalPaused=true;
    try {await child.pull();}finally{journalPaused=false;}
  },async close(){await child.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));f.close();await rm(root,{recursive:true,force:true});}};
}

it.skipIf(binary.missing)("drains pre-epoch retired journal rows without fetching their missing baseline",async()=>{
  const f=await fixture(true);try {
    await f.child.pull();
    f.read(db=>{
      expect(db.prepare("SELECT count(*) AS n FROM ydoc_docs").get()?.n).toBe(0);
      expect(db.prepare("SELECT log_cursor,journal_cursor FROM replica_frontiers").get()).toEqual({log_cursor:0,journal_cursor:f.retiredCursor});
    });
  }finally{await f.close();}
},120_000);

it.skipIf(binary.missing)("drains pre-floor journal rows whose stale authority is still current",async()=>{
  const f=await fixture(true,false);try {
    expect((await f.f.storage.readReplicaLiveJournal({workspaceId:"workspace",after:0,limit:500})).rows[0]!.authority).not.toBeNull();
    await f.child.pull();
    f.read(db=>{
      expect(db.prepare("SELECT count(*) AS n FROM ydoc_docs").get()?.n).toBe(0);
      expect(db.prepare("SELECT journal_cursor FROM replica_frontiers").get()?.journal_cursor).toBe(f.retiredCursor);
    });
  }finally{await f.close();}
},120_000);

it.skipIf(binary.missing)("drains canonical journal pages into native heads without projecting or originating",async()=>{
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

it.skipIf(binary.missing || process.env.DOHC_REPLICA_MEASURE!=="1")("measures release driver time from one and 500 commits through an on-demand projection",async()=>{
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
