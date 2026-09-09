import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {NativeOwnerActivationSource} from "@dohc/workspace-engine-client/daemon";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {LiveDocumentBaselineRegistrationInput} from "./types";
import type {StorageContext} from "./context";
import type {LiveMarkdownRegistrationEvidence,createLiveMarkdownJournalValidator,createLiveMarkdownRegistrationValidator} from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import {MAX_OLD_SUFFIX_ENTRIES} from "../../../../packages/ydoc-projection/src/orderedLiveUpdateCut";
import {ORDINARY_ACTIVATION_BASES} from "./ordinaryActivationBasis";

export class ServiceActivationStaleCut extends Error {
  constructor(){super("Ordinary replication advanced before service activation.");}
}
export interface OrdinaryActivationBounds {maxCaptureBytes:number;maxEntriesPerDrain:number;maxBytesPerDrain:number}
export interface VerifiedOrdinaryActivationCut {readonly verified:true}
const cuts=new WeakMap<VerifiedOrdinaryActivationCut,{storage:StorageContext;source:NativeOwnerActivationSource;baseline:LiveDocumentBaselineRegistrationInput["evidence"]}>();
const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const integer=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
function requireValue(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function currentCut(storage:StorageContext,source:NativeOwnerActivationSource){
  const current=storage.db.prepare("SELECT replication_epoch,stream_identity FROM sync_relay_workspaces WHERE workspace_id=?").get(source.workspaceId);
  const high=storage.db.prepare("SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?").get(source.workspaceId);
  if(current?.replication_epoch!==source.replicationEpoch||current.stream_identity!==source.streamIdentity||high?.cursor!==source.committedCursor||
    source.baseRelaySeq>source.committedCursor||source.baseRelaySeq<=storage.getEpochLogFloor(source.workspaceId))throw new ServiceActivationStaleCut();
}
export function verifyOrdinaryActivationCut(storage:StorageContext,input:{source:NativeOwnerActivationSource;document:LiveDocumentKey;
  baselineBytes:Uint8Array;fullState:Uint8Array;baseline:LiveMarkdownRegistrationEvidence;
  validateJournal:ReturnType<typeof createLiveMarkdownJournalValidator>;validateRegistration:ReturnType<typeof createLiveMarkdownRegistrationValidator>;
  bounds:OrdinaryActivationBounds}):VerifiedOrdinaryActivationCut{
  const {source,document,baselineBytes,fullState,baseline,validateJournal,validateRegistration,bounds}=input;
  for(const value of Object.values(bounds))requireValue(integer(value)&&value>0,"Invalid ordinary activation read budget.");
  requireValue(baselineBytes.length+fullState.length+Buffer.byteLength(JSON.stringify(source))<=bounds.maxCaptureBytes,"Ordinary activation capture exceeds its configured byte budget.");
  currentCut(storage,source);
  const entryLimit=Math.min(bounds.maxEntriesPerDrain,MAX_OLD_SUFFIX_ENTRIES+2);
  const selected=`FROM sync_relay_log WHERE workspace_id=? AND relay_seq>=? AND relay_seq<=?
      AND json_extract(payload_json,'$.versionId')=? AND json_extract(payload_json,'$.objectId')=?
    ORDER BY relay_seq LIMIT ?`;
  const params=[document.workspaceId,source.baseRelaySeq,source.committedCursor,document.mainVersionId,document.objectId,entryLimit+1];
  const size=storage.db.prepare(`SELECT count(*) AS entries,COALESCE(sum(bytes),0) AS bytes FROM
    (SELECT length(CAST(payload_json AS BLOB))+length(CAST(json_array(relay_seq,origin_id,origin_seq,op_kind) AS BLOB)) AS bytes ${selected})`).get(...params);
  requireValue(size&&integer(size.entries)&&size.entries>0&&size.entries<=entryLimit,"Ordinary activation history exceeds its configured entry budget.");
  requireValue(integer(size.bytes)&&size.bytes<=bounds.maxBytesPerDrain-baselineBytes.length,"Ordinary activation metadata exceeds its configured byte budget.");
  const metadata=storage.db.prepare(`SELECT relay_seq,origin_id,origin_seq,op_kind,length(CAST(payload_json AS BLOB)) AS payload_bytes ${selected}`).all(...params);
  let charged=baselineBytes.length;
  const charge=(bytes:number)=>{requireValue(integer(bytes)&&charged<=bounds.maxBytesPerDrain-bytes,"Ordinary activation history exceeds its configured byte budget.");charged+=bytes;};
  for(const row of metadata){requireValue(integer(row.payload_bytes),"Ordinary activation metadata is damaged.");charge(Number(row.payload_bytes)+Buffer.byteLength(JSON.stringify([row.relay_seq,row.origin_id,row.origin_seq,row.op_kind])));}
  const rows=metadata.map(row=>{
    requireValue(integer(row.relay_seq)&&integer(row.origin_seq)&&typeof row.origin_id==="string"&&row.origin_id.length>0,"Ordinary activation coordinate is damaged.");
    requireValue(row.op_kind==="ydoc.update","Ordinary activation history replaced the live document.");
    const stored=storage.db.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND relay_seq=?").get(document.workspaceId,row.relay_seq);
    requireValue(stored&&typeof stored.payload_json==="string","Ordinary activation history is unavailable.");
    const payload=JSON.parse(stored.payload_json) as Record<string,unknown>;
    requireValue(payload.versionId===document.mainVersionId&&payload.objectId===document.objectId&&payload.path===source.currentPath&&
      payload.contentKind==="richdoc"&&payload.lineageClaimId===document.lineageClaimId&&typeof payload.isBaseState==="boolean"&&
      typeof payload.updateBlobSha256==="string"&&/^[0-9a-f]{64}$/.test(payload.updateBlobSha256),"Ordinary activation history differs from the captured lineage.");
    const blob=storage.db.prepare("SELECT byte_length,length(content) AS actual_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(document.workspaceId,payload.updateBlobSha256);
    requireValue(blob&&integer(blob.byte_length)&&blob.byte_length===blob.actual_length,"Ordinary activation bytes are unavailable.");
    charge(Number(blob.byte_length));
    return {relay_seq:row.relay_seq,origin_id:row.origin_id,origin_seq:row.origin_seq,payload,byteLength:Number(blob.byte_length)};
  });
  const first=rows[0]!;
  requireValue(first.relay_seq===source.baseRelaySeq&&first.origin_id===source.baseOriginId&&first.origin_seq===source.baseOriginSeq&&
    first.payload.isBaseState===true&&first.payload.updateBlobSha256===document.lineageClaimId,"Native activation base coordinate differs from ordinary history.");
  for(const row of rows)requireValue(!row.payload.isBaseState||row.payload.updateBlobSha256===document.lineageClaimId,"Ordinary activation has a different baseline.");
  const updates=rows.map(row=>{
    const bytes=storage.getBlob(document.workspaceId,String(row.payload.updateBlobSha256));
    requireValue(bytes&&bytes.length===row.byteLength&&hash(bytes)===row.payload.updateBlobSha256,"Ordinary activation bytes differ from their digest.");
    return new Uint8Array(bytes);
  });
  requireValue(Buffer.compare(Buffer.from(updates[0]!),Buffer.from(baselineBytes))===0,"Ordinary activation base bytes differ.");
  const normalize=(suffix:readonly Uint8Array[],candidate:Uint8Array)=>{
    charge(baselineBytes.length+candidate.length+suffix.reduce((sum,bytes)=>sum+bytes.length,0));
    const result=validateJournal({document,currentPath:source.currentPath,checkpoint:baselineBytes,suffix,candidate});
    requireValue(result.kind==="accepted","Ordinary activation history is not a valid live document.");return result.evidence;
  };
  charge(fullState.length);
  const full=validateRegistration({document,currentPath:source.currentPath,checkpoint:fullState});
  requireValue(full.kind==="accepted","Native activation is not a complete standalone CRDT state.");
  const captured=full.evidence,ordinary=normalize(updates.slice(1,-1),updates.length===1?new Uint8Array([0,0]):updates.at(-1)!);
  requireValue(captured.stateUpdateSha256===ordinary.stateUpdateSha256&&captured.stateUpdateByteLength===ordinary.stateUpdateByteLength&&
    Buffer.compare(Buffer.from(captured.stateUpdate),Buffer.from(ordinary.stateUpdate))===0&&
    ordinary.projectedMarkdownSha256===source.sourceDigest&&ordinary.projectedMarkdownByteLength===source.sourceByteLength,
    "Native activation differs from the complete ordinary CRDT history.");
  const moment=storage.db.prepare(`SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments
    WHERE workspace_id=? AND object_id=? AND relay_seq<? ORDER BY relay_seq DESC LIMIT 1`).get(document.workspaceId,document.objectId,source.baseRelaySeq);
  let momentMatches=moment?.moment_id===source.sourceMomentId&&moment.version_id===document.mainVersionId&&moment.path===source.currentPath&&
    moment.content_kind==="text"&&moment.blob_sha256===source.sourceDigest&&moment.byte_length===source.sourceByteLength;
  if(!momentMatches){
    const index=rows.findIndex(row=>source.sourceMomentId===`moment-ydoc-apply-${hash([document.workspaceId,document.mainVersionId,document.objectId,source.currentPath,row.origin_id,row.origin_seq].join("\0"))}`);
    requireValue(index>=0,"Native activation source moment is not an ordinary history coordinate.");
    const prefix=index===0?baseline:normalize(updates.slice(1,index),updates[index]!);
    momentMatches=prefix.projectedMarkdownSha256===source.sourceDigest&&prefix.projectedMarkdownByteLength===source.sourceByteLength;
  }
  requireValue(momentMatches,"Native activation source moment does not project the captured source.");
  const evidence={version:1 as const,document:structuredClone(document),currentPath:source.currentPath,
    checkpoint:{updateDigest:baseline.checkpoint.updateDigest,ranges:baseline.checkpoint.ranges.map(row=>({...row}))},
    projectedMarkdownSha256:baseline.projectedMarkdownSha256,projectedMarkdownByteLength:baseline.projectedMarkdownByteLength};
  const cut=Object.freeze({verified:true as const});cuts.set(cut,{storage,source:structuredClone(source),baseline:evidence});return cut;
}
export function ordinaryActivationBaseline(storage:StorageContext,input:LiveDocumentBaselineRegistrationInput,cut:VerifiedOrdinaryActivationCut){
  const held=cuts.get(cut);requireValue(held&&held.storage===storage,"Ordinary activation source was not verified.");
  currentCut(storage,held.source);
  requireValue(isDeepStrictEqual(input.evidence,held.baseline)&&hash(input.baselineBytes)===held.source.lineageClaimId,
    "Ordinary activation baseline differs from its verified source.");
  return {relay_seq:held.source.baseRelaySeq,blob_sha256:held.baseline.projectedMarkdownSha256,byte_length:held.baseline.projectedMarkdownByteLength};
}
function basisValues(storage:StorageContext,input:LiveDocumentBaselineRegistrationInput,cut:VerifiedOrdinaryActivationCut){
  ordinaryActivationBaseline(storage,input,cut);
  const {source,baseline}=cuts.get(cut)!;
  return [source.workspaceId,source.mainVersionId,source.objectId,source.lineageClaimId,source.baseRelaySeq,source.baseOriginId,source.baseOriginSeq,
    source.replicationEpoch,source.streamIdentity,source.currentPath,baseline.projectedMarkdownSha256,baseline.projectedMarkdownByteLength];
}
export function ordinaryActivationBasisCharge(storage:StorageContext,input:LiveDocumentBaselineRegistrationInput,cut:VerifiedOrdinaryActivationCut){
  return Buffer.byteLength(JSON.stringify(basisValues(storage,input,cut)));
}
export function persistOrdinaryActivationBasis(storage:StorageContext,input:LiveDocumentBaselineRegistrationInput,cut:VerifiedOrdinaryActivationCut){
  const values=basisValues(storage,input,cut),charge=Buffer.byteLength(JSON.stringify(values));
  storage.db.prepare(`INSERT INTO ${ORDINARY_ACTIVATION_BASES} (workspace_id,main_version_id,object_id,lineage_claim_id,base_relay_seq,base_origin_id,base_origin_seq,
    replication_epoch,stream_identity,current_path,projected_sha256,projected_byte_length,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values,charge);
}
