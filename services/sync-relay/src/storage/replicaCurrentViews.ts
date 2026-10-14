import {createHash} from "node:crypto";
import type {ReplicaCurrentView, ReplicaCurrentViewSelector} from "@dohc/workspace-engine-client/daemon";
import {visibleSharePath} from "@dohc/security-contract/share-selector";
import {parseStoredAnyShareSelectorJson} from "../shareFilter";
import type {ReplicaReadLease} from "../replicaReadPrincipal";
import type {StorageContext} from "./context";
import {currentShareGrantSql} from "./currentShareGrant";
import {readReplicaStanding} from "./replicaReads";

const STAGE_BYTES=8*1024*1024;
const incarnations=new WeakMap<StorageContext,Map<string,ReplicaReadLease>>();
export interface StagedCurrentView {readonly staged: true}
const stagedViews=new WeakMap<StagedCurrentView,{storage: StorageContext;lease: ReplicaReadLease;view: ReplicaCurrentView}>();
export class ReplicaCurrentViewRefused extends Error { constructor() {super("Replica current view is stale or invalid.");} }
function fail(): never {throw new ReplicaCurrentViewRefused();}
function current(storage: StorageContext, lease: ReplicaReadLease) {
  const standing=readReplicaStanding(storage,lease.workspaceId,lease.shareGrantBindings);
  if (!standing || standing.ownerUserId!==lease.ownerUserId || standing.replicationEpoch!==lease.replicationEpoch ||
      standing.streamIdentity!==lease.streamIdentity || incarnations.get(storage)?.get(lease.workspaceId)?.incarnation!==lease.incarnation) fail();
  return standing;
}
export function bindReplicaCurrentView(storage: StorageContext,lease: ReplicaReadLease) {
  const standing=readReplicaStanding(storage,lease.workspaceId,lease.shareGrantBindings);
  if(!standing || standing.replicationEpoch!==lease.replicationEpoch || standing.streamIdentity!==lease.streamIdentity || standing.ownerUserId!==lease.ownerUserId) fail();
  let bindings=incarnations.get(storage);if(!bindings)incarnations.set(storage,bindings=new Map());
  bindings.set(lease.workspaceId,lease);
}
export function releaseReplicaCurrentView(storage: StorageContext,lease: ReplicaReadLease) {
  const bindings=incarnations.get(storage);
  if(bindings?.get(lease.workspaceId)?.incarnation===lease.incarnation)bindings.delete(lease.workspaceId);
}
export function replicaCurrentViewSelectors(storage: StorageContext,workspace: string): ReplicaCurrentViewSelector[] {
  return storage.db.prepare(`SELECT DISTINCT s.selector_json FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE s.workspace_id=? AND ${currentShareGrantSql("g","s")}`).all(workspace).flatMap(row=>{
    const selector=parseStoredAnyShareSelectorJson(String(row.selector_json));
    if(!selector || "kind" in selector && selector.kind==="chat")return [];
    return [{versionId:selector.versionId??"main",paths:selector.paths}];
  });
}
export function validateReplicaCurrentView(storage: StorageContext,lease: ReplicaReadLease,view: ReplicaCurrentView) {
  const standing=current(storage,lease);
  if(view.workspaceId!==lease.workspaceId || [view.revision,view.logCursor,view.journalCursor].some(v=>!Number.isSafeInteger(v)||v<0) ||
    view.logCursor>standing.logSeq || view.journalCursor>standing.journalCursor)fail();
  const saved=storage.db.prepare("SELECT * FROM sync_relay_replica_cuts WHERE workspace_id=?").get(lease.workspaceId);
  if(saved && (view.logCursor<Number(saved.log_cursor)||view.journalCursor<Number(saved.journal_cursor)))fail();
  const selectors=replicaCurrentViewSelectors(storage,lease.workspaceId), paths=new Set<string>(), objects=new Set<string>();
  const previous=new Map(storage.db.prepare("SELECT version_id,object_id,restore_generation FROM sync_relay_replica_cut_files WHERE workspace_id=?").all(lease.workspaceId)
    .map(r=>[JSON.stringify([r.version_id,r.object_id]),r.restore_generation]));
  for(const file of view.files) {
    const object=JSON.stringify([file.versionId,file.objectId]), path=JSON.stringify([file.versionId,file.path]);
    if(objects.has(object)||paths.has(path)||!file.objectId||!selectors.some(s=>s.versionId===file.versionId &&
      visibleSharePath({versionId:s.versionId,paths:s.paths},file.path)===file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.byteLength)||file.byteLength<0||!["text","binary"].includes(file.contentKind))fail();
    objects.add(object);paths.add(path);
    if((file.lineageClaimId===null)!==(file.restoreGeneration===null))fail();
    const old=previous.get(object);
    if(old!==null && old!==undefined && (file.restoreGeneration===null||file.restoreGeneration<Number(old)))fail();
    if(file.lineageClaimId!==null) {
      if(!/^[a-f0-9]{64}$/.test(file.lineageClaimId)||!Number.isSafeInteger(file.restoreGeneration)||file.restoreGeneration!<0)fail();
      const fence=storage.db.prepare("SELECT restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current'")
        .get(lease.workspaceId,file.versionId,file.objectId,file.lineageClaimId);
      // A restore echo can precede its journal position. Persist only when the applied generation reaches the current fence.
      if(fence && file.restoreGeneration!==Number(fence.restore_fence_generation))fail();
      if(!fence && file.restoreGeneration!==1)fail();
    }
  }
}
export function stageReplicaCurrentView(storage: StorageContext,lease: ReplicaReadLease,view: ReplicaCurrentView): StagedCurrentView {
  validateReplicaCurrentView(storage,lease,view);
  const copy=structuredClone(view);
  const requested=new Map(copy.files.filter(f=>f.contentKind==="text").map(f=>[f.sha256,f.byteLength]));
  for(const text of copy.texts) {
    const bytes=Buffer.from(text.text), digest=createHash("sha256").update(bytes).digest("hex");
    if(digest!==text.sha256||requested.get(digest)!==bytes.length)fail();
    for(let offset=0,ordinal=0;offset<bytes.length||ordinal===0;offset+=STAGE_BYTES,ordinal++) {
      const chunk=bytes.subarray(offset,offset+STAGE_BYTES);
      storage.replicaViewTx(()=>{current(storage,lease);storage.db.prepare("INSERT INTO sync_relay_replica_cut_texts VALUES (?,?,?,?,0) ON CONFLICT(workspace_id,sha256,ordinal) DO NOTHING").run(lease.workspaceId,digest,ordinal,chunk);});
    }
  }
  const staged={staged:true as const};stagedViews.set(staged,{storage,lease,view:copy});return staged;
}
export function flipReplicaCurrentView(storage: StorageContext,lease: ReplicaReadLease,staged: StagedCurrentView) {
  const state=stagedViews.get(staged);if(!state||state.storage!==storage||state.lease!==lease)fail();
  stagedViews.delete(staged);
  try { storage.replicaViewTx(()=>{
    const view=state.view;validateReplicaCurrentView(storage,lease,view);
    for(const file of view.files.filter(f=>f.contentKind==="text")) {
      const chunks=storage.db.prepare("SELECT ordinal,bytes FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND sha256=? ORDER BY ordinal").all(lease.workspaceId,file.sha256);
      if(!chunks.length || chunks.some((c,i)=>c.ordinal!==i))fail();
      const bytes=Buffer.concat(chunks.map(c=>Buffer.from(c.bytes as Uint8Array)));
      if(bytes.length!==file.byteLength||createHash("sha256").update(bytes).digest("hex")!==file.sha256)fail();
    }
    storage.db.prepare(`INSERT INTO sync_relay_replica_cuts VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
      replication_epoch=excluded.replication_epoch,stream_identity=excluded.stream_identity,incarnation=excluded.incarnation,
      cut_seq=sync_relay_replica_cuts.cut_seq+1,revision=excluded.revision,log_cursor=excluded.log_cursor,journal_cursor=excluded.journal_cursor`)
      .run(lease.workspaceId,lease.replicationEpoch,lease.streamIdentity,lease.incarnation,view.revision,view.logCursor,view.journalCursor);
    storage.db.prepare("DELETE FROM sync_relay_replica_cut_files WHERE workspace_id=?").run(lease.workspaceId);
    const insert=storage.db.prepare("INSERT INTO sync_relay_replica_cut_files VALUES (?,?,?,?,?,?,?,?,?)");
    for(const f of view.files)insert.run(lease.workspaceId,f.versionId,f.objectId,f.path,f.contentKind,f.sha256,f.byteLength,f.lineageClaimId,f.restoreGeneration);
    storage.db.prepare(`UPDATE sync_relay_replica_cut_texts SET ref_count=(SELECT count(*) FROM sync_relay_replica_cut_files f WHERE f.workspace_id=sync_relay_replica_cut_texts.workspace_id AND f.sha256=sync_relay_replica_cut_texts.sha256 AND f.content_kind='text') WHERE workspace_id=?`).run(lease.workspaceId);
    storage.db.prepare("DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND ref_count=0").run(lease.workspaceId);
  }); } catch(error) {
    storage.replicaViewTx(()=>storage.db.prepare("DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND ref_count=0").run(lease.workspaceId));throw error;
  }
}
export function readReplicaCurrentView(storage: StorageContext,workspace: string): ReplicaCurrentView | null {
  const standing=readReplicaStanding(storage,workspace);
  const header=storage.db.prepare("SELECT * FROM sync_relay_replica_cuts WHERE workspace_id=?").get(workspace);
  if(!standing || !header || header.replication_epoch!==standing.replicationEpoch || header.stream_identity!==standing.streamIdentity)return null;
  const files=storage.db.prepare("SELECT * FROM sync_relay_replica_cut_files WHERE workspace_id=? ORDER BY path,object_id,version_id").all(workspace).map(row=>({
    versionId:String(row.version_id),objectId:String(row.object_id),path:String(row.path),contentKind:row.content_kind as "text"|"binary",sha256:String(row.sha256),byteLength:Number(row.byte_length),
    lineageClaimId:row.lineage_claim_id===null?null:String(row.lineage_claim_id),restoreGeneration:row.restore_generation===null?null:Number(row.restore_generation)}));
  return {workspaceId:workspace,revision:Number(header.revision),logCursor:Number(header.log_cursor),journalCursor:Number(header.journal_cursor),files,texts:[]};
}
export function readReplicaCurrentViewText(storage: StorageContext,workspace: string,sha: string): string | null {
  if(!readReplicaStanding(storage,workspace))return null;
  const rows=storage.db.prepare("SELECT bytes FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND sha256=? AND ref_count>0 ORDER BY ordinal").all(workspace,sha);
  return rows.length?Buffer.concat(rows.map(row=>Buffer.from(row.bytes as Uint8Array))).toString("utf8"):null;
}
