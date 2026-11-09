import {expect} from "vitest";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {requireEngineBinaryOrSkip} from "../../../../apps/desktop/src/testing/engineBinary";
import {registered, hash} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {yDocToMarkdown} from "../../../../packages/ydoc-projection/src/import-export";
import {createReplicaReadPrincipal} from "../replicaReadPrincipal";
import {createReplicaEngineStarter} from "../replicaEngine";
import type {ReplicaChild} from "../replicaSupervisor";

export const binary=requireEngineBinaryOrSkip();

/** A live document with committed journal rows, drained by a replica running the real engine. */
export async function fixture(retired=false, retireAuthority=true,baselineBytes?:Uint8Array,cancelled=false) {
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
    if(cancelled) {
      const committed=f.storage.readCommittedLiveUpdate({host:f.input.host,document:f.input.evidence.document,journalCursor:retiredCursor});
      if(committed.kind!=="committed")throw new Error("Expected committed update.");
      const {binding,receipt:terminal}=committed.admitted.metadata.accepted;
      const row=f.journalRows().journal[0]!,namespace=String(row.relay_database_namespace),operationId="cancel-before-rotation";
      const operation={point:{journalCursor:terminal.journalCursor,receiptDigest:terminal.updateDigest},operationId,
        relayDatabaseNamespace:namespace,oldBinding:binding,hostId:"host",newFence:binding.restoreFenceGeneration+1,
        origin:{kind:"bootstrap",id:"bootstrap"},terminal,appliedSequence:0};
      const stopped={...binding,restoreFenceGeneration:operation.newFence};
      const receipt={fence:{operation,localHeadSequence:0,recordedAtMs:30},binding:stopped,
        endpoint:{terminalReceipt:terminal,eventCount:Number(row.accepted_event_count),historyEvidenceDigest:String(row.accepted_evidence_digest)},recordedAtMs:31};
      retiredCursor++;
      f.write(db=>{
        db.prepare(`INSERT INTO sync_relay_live_restore_operations
          (operation_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,intent_json,basis_json,
           phase,old_fence,revoked_generation,invalidated_at_ms,declined_at_ms,accounted_bytes)
          VALUES (?,?,'workspace','main','object',?,'{}','{}','declined',?,2,20,31,1)`)
          .run(operationId,namespace,binding.lineageClaimId,binding.restoreFenceGeneration);
        db.prepare(`INSERT INTO sync_relay_live_restore_cancellations
          (relay_database_namespace,operation_id,workspace_id,requested_at_ms,outcome,acknowledgment_json,journal_cursor,accounted_bytes)
          VALUES (?,?,'workspace',30,'fence-cancelled',?,?,1)`)
          .run(namespace,operationId,JSON.stringify({status:"fenceCancelled",hostId:"host",generation:operation.newFence,binding:stopped,receipt}),retiredCursor);
      });
    }
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
