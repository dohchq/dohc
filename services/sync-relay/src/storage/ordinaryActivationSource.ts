import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {NativeOwnerActivationSource} from "@dohc/workspace-engine-client/daemon";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {LiveDocumentBaselineRegistrationInput} from "./types";
import type {StorageContext} from "./context";
import {MAX_OLD_SUFFIX_ENTRIES} from "../../../../packages/ydoc-projection/src/orderedLiveUpdateCut";
import {ORDINARY_ACTIVATION_BASES} from "./ordinaryActivationBasis";
import {SETTLEMENT_BINDINGS,SETTLEMENT_CUTS} from "./hostedSettlementSchema";
import {isNativeSettlementRecord,settlementRecordDigest} from "./hostedSettlement";
import {NATIVE_MOMENT_FIELDS} from "./serviceActivationPublication";
import {REFUSED_OP_KIND} from "./relayAdmission";
import {stableJsonStringify} from "../canonicalJson";
import {OTHER_LINEAGE_UPDATE} from "./otherLineageUpdate";
import type {OrdinaryActivationBaseline,OrdinaryActivationHistory,OrdinaryActivationProof,Projection} from "./ordinaryActivationValidation";

export class ServiceActivationStaleCut extends Error {
  constructor(){super("Ordinary replication advanced before service activation.");}
}
/** Live validation had no slot free for the capture. A later pass captures it again. */
export class ServiceActivationBusy extends Error {
  constructor(){super("Live validation is busy.");}
}
/** Validating the capture ran its validation process out of memory, as the same capture would again. */
export class ServiceActivationTooLarge extends Error {
  constructor(){super("Native activation is too large to validate.");}
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
/** The history prefix a write at this relay position follows. */
const prefixAt=(rows:OrdinaryActivationHistory["rows"],relaySeq:number)=>rows.filter(row=>row.relay_seq<relaySeq).length-1;
type HistoryInput={source:NativeOwnerActivationSource;document:LiveDocumentKey;baselineBytes:Uint8Array;fullState:Uint8Array;bounds:OrdinaryActivationBounds};
/** Reads and checks the history a capture must rebuild and its source's proof, charging both to the drain budget. Validation runs on what it returns. */
export function readOrdinaryActivationHistory(storage:StorageContext,input:HistoryInput):OrdinaryActivationHistory{
  const {source,document,baselineBytes,fullState,bounds}=input;
  for(const value of Object.values(bounds))requireValue(integer(value)&&value>0,"Invalid ordinary activation read budget.");
  requireValue(baselineBytes.length+fullState.length+Buffer.byteLength(JSON.stringify(source))<=bounds.maxCaptureBytes,"Ordinary activation capture exceeds its configured byte budget.");
  currentCut(storage,source);
  const entryLimit=Math.min(bounds.maxEntriesPerDrain,MAX_OLD_SUFFIX_ENTRIES+2);
  // Another lineage's rows are neither read nor charged. The captured full state must still equal the rebuilt history.
  const selected=`FROM sync_relay_log INDEXED BY idx_sync_relay_log_document_page WHERE workspace_id=? AND relay_seq>=? AND relay_seq<=?
      AND json_extract(payload_json,'$.versionId')=? AND json_extract(payload_json,'$.objectId')=?
      AND COALESCE(json_extract(settlement_admission_json,'$.status'),'')<>'refused'
      AND NOT (${OTHER_LINEAGE_UPDATE})
    ORDER BY relay_seq LIMIT ?`;
  const params=[document.workspaceId,source.baseRelaySeq,source.committedCursor,document.mainVersionId,document.objectId,document.lineageClaimId,entryLimit+1];
  const size=storage.db.prepare(`SELECT count(*) AS entries,COALESCE(sum(bytes),0) AS bytes FROM
    (SELECT length(CAST(payload_json AS BLOB))+length(CAST(json_array(relay_seq,origin_id,origin_seq,op_kind) AS BLOB)) AS bytes ${selected})`).get(...params);
  requireValue(size&&integer(size.entries)&&size.entries>0&&size.entries<=entryLimit,"Ordinary activation history exceeds its configured entry budget.");
  requireValue(integer(size.bytes)&&size.bytes<=bounds.maxBytesPerDrain-baselineBytes.length,"Ordinary activation metadata exceeds its configured byte budget.");
  const metadata=storage.db.prepare(`SELECT relay_seq,origin_id,origin_seq,op_kind,relay_admission,length(CAST(payload_json AS BLOB)) AS payload_bytes ${selected}`).all(...params);
  let charged=baselineBytes.length;
  const charge=(bytes:number)=>{requireValue(integer(bytes)&&charged<=bounds.maxBytesPerDrain-bytes,"Ordinary activation history exceeds its configured byte budget.");charged+=bytes;};
  for(const row of metadata){requireValue(integer(row.payload_bytes),"Ordinary activation metadata is damaged.");charge(Number(row.payload_bytes)+Buffer.byteLength(JSON.stringify([row.relay_seq,row.origin_id,row.origin_seq,row.op_kind])));}
  const rows=metadata.flatMap(row=>{
    requireValue(integer(row.relay_seq)&&integer(row.origin_seq)&&typeof row.origin_id==="string"&&row.origin_id.length>0,"Ordinary activation coordinate is damaged.");
    const stored=storage.db.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND relay_seq=?").get(document.workspaceId,row.relay_seq);
    requireValue(stored&&typeof stored.payload_json==="string","Ordinary activation history is unavailable.");
    const payload=JSON.parse(stored.payload_json) as Record<string,unknown>;
    if(row.op_kind==="moment.append"){
      requireValue(payload.versionId===document.mainVersionId&&payload.objectId===document.objectId&&
        payload.path===source.currentPath&&payload.operation==="write"&&payload.payloadAfterPath===source.currentPath&&
        payload.payloadAfterContentKind==="text"&&typeof payload.momentId==="string"&&payload.momentId.length>0&&
        typeof payload.payloadAfterBlobSha256==="string"&&/^[0-9a-f]{64}$/.test(payload.payloadAfterBlobSha256)&&
        integer(payload.payloadAfterByteLength)&&payload.payloadAfterByteLength<=2_097_152,
        "Ordinary activation history replaced the live document.");
      return [];
    }
    requireValue(row.op_kind==="ydoc.update","Ordinary activation history replaced the live document.");
    requireValue(payload.versionId===document.mainVersionId&&payload.objectId===document.objectId&&payload.path===source.currentPath&&
      payload.contentKind==="richdoc"&&payload.lineageClaimId===document.lineageClaimId&&typeof payload.isBaseState==="boolean"&&
      typeof payload.updateBlobSha256==="string"&&/^[0-9a-f]{64}$/.test(payload.updateBlobSha256),"Ordinary activation history differs from the captured lineage.");
    const blob=storage.db.prepare("SELECT byte_length,length(content) AS actual_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(document.workspaceId,payload.updateBlobSha256);
    requireValue(blob&&integer(blob.byte_length)&&blob.byte_length===blob.actual_length,"Ordinary activation bytes are unavailable.");
    charge(Number(blob.byte_length));
    return [{relay_seq:row.relay_seq,origin_id:row.origin_id,origin_seq:row.origin_seq,ordinary:row.relay_admission===null,payload,byteLength:Number(blob.byte_length)}];
  });
  requireValue(rows.length>0,"Ordinary activation base history is unavailable.");
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
  const history=rows.map(({relay_seq,origin_id,origin_seq,ordinary})=>({relay_seq,origin_id,origin_seq,ordinary}));
  const found=storage.db.prepare(`SELECT relay_seq,moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments
    WHERE workspace_id=? AND object_id=? AND version_id=? AND relay_seq<=? ORDER BY relay_seq DESC LIMIT 1`).get(document.workspaceId,document.objectId,document.mainVersionId,source.committedCursor);
  const moment=found?{...found}:null;
  const echoes=moment?.path===source.currentPath&&moment.content_kind==="text"&&moment.blob_sha256===source.sourceDigest&&moment.byte_length===source.sourceByteLength;
  let from:number|null=null,artifact:number|null=null,settled:OrdinaryActivationHistory["settled"]=null;
  if(!(moment?.moment_id===source.sourceMomentId&&moment.version_id===document.mainVersionId&&echoes)){
    // A receiver-generated source names an ordinarily admitted Y.Doc row; a departed row counts as history, never as a source.
    // Otherwise the source is a settlement moment the relay proved, after the history before it.
    const index=rows.findIndex(row=>source.sourceMomentId===`moment-ydoc-apply-${hash([document.workspaceId,document.mainVersionId,document.objectId,source.currentPath,row.origin_id,row.origin_seq].join("\0"))}`);
    if(index>=0)requireValue(rows[index]!.ordinary,"Native activation source moment is not an ordinary history coordinate.");
    let anchor:number;
    if(index>=0)anchor=rows[index]!.relay_seq;
    else{const proved=provedSettlementSource(storage,{source,document,charge});anchor=proved.relaySeq;settled={state:proved.state,stateSha256:proved.stateSha256};}
    from=index>=0?index:history.filter(row=>row.relay_seq<anchor).length-1;
    if(moment&&Number(moment.relay_seq)>anchor&&!echoes)artifact=Number(moment.relay_seq);
  }
  // Behind a later artifact, validation keeps the projection each of this document's writes followed, to tell folded echoes.
  const wanted=artifact===null?[]:[...new Set(metadata.filter(row=>row.op_kind==="moment.append"&&Number(row.relay_seq)<artifact)
    .map(row=>prefixAt(history,Number(row.relay_seq))).filter(index=>index>=1&&index<updates.length-1))].sort((a,b)=>a-b);
  return {rows:history,updates,moment,from,artifact,wanted,settled,charged};
}
/**
 * Accepts a capture whose validation passed on `history`, in the transaction that registers it. A write
 * since that read refuses it as stale, so the transaction never registers evidence for another history.
 * A later divergent file moment is proved a stale artifact here, against the projections validation kept.
 */
export function verifyOrdinaryActivationCut(storage:StorageContext,input:HistoryInput&{baseline:OrdinaryActivationBaseline;history:OrdinaryActivationHistory;proof?:OrdinaryActivationProof}):VerifiedOrdinaryActivationCut{
  const {source,document,baseline,history,proof,bounds}=input;
  // Validation accepted the history it read, so refusing the history read again means it changed since.
  let current:OrdinaryActivationHistory;
  try{current=readOrdinaryActivationHistory(storage,input);}
  catch(error){if(error instanceof Error&&error.constructor===Error&&!("code" in error))throw new ServiceActivationStaleCut();throw error;}
  if(!isDeepStrictEqual(current,history))throw new ServiceActivationStaleCut();
  if(history.artifact!==null){
    requireValue(proof,"Ordinary activation found a later ordinary file moment with a divergent projection.");
    let charged=proof.charged;
    const charge=(bytes:number)=>{requireValue(integer(bytes)&&charged<=bounds.maxBytesPerDrain-bytes,"Ordinary activation history exceeds its configured byte budget.");charged+=bytes;};
    const kept=new Map(proof.projections.map(({index,...projection})=>[index,projection]));
    const last=history.updates.length-1,sourceProjection={projectedMarkdownSha256:source.sourceDigest,projectedMarkdownByteLength:source.sourceByteLength};
    // Validation proved the complete history projects the source.
    const projectionAt=(relaySeq:number)=>{const index=prefixAt(history.rows,relaySeq);return index===0?baseline:index===last?sourceProjection:kept.get(index);};
    requireValue(sameLineageArtifact(storage,{source,document,charge,projectionAt,proved:new Map()},history.artifact),
      "Ordinary activation found a later ordinary file moment with a divergent projection.");
  }
  const evidence={version:1 as const,document:structuredClone(document),currentPath:source.currentPath,
    checkpoint:{updateDigest:baseline.checkpoint.updateDigest,ranges:baseline.checkpoint.ranges.map(row=>({...row}))},
    projectedMarkdownSha256:baseline.projectedMarkdownSha256,projectedMarkdownByteLength:baseline.projectedMarkdownByteLength};
  const cut=Object.freeze({verified:true as const});cuts.set(cut,{storage,source:structuredClone(source),baseline:evidence});return cut;
}
/**
 * A source naming a settlement moment, such as the retiring host's departed
 * one: the binding the relay committed when it verified that publication, and
 * its exact log row, prove the record, the interval's terminal cut and the
 * state the moment wrote. Returns the moment's relay sequence and the settled
 * state's bytes, which validation checks project the source.
 */
function provedSettlementSource(storage:StorageContext,input:{source:NativeOwnerActivationSource;document:LiveDocumentKey;charge:(bytes:number)=>void}):
  {relaySeq:number;state:Uint8Array;stateSha256:string}{
  const {source,document}=input;
  const settled=storage.db.prepare(`SELECT b.*,l.relay_seq,l.op_kind,l.payload_json,l.settlement_admission_json FROM ${SETTLEMENT_BINDINGS} b
    JOIN sync_relay_log l ON l.workspace_id=b.workspace_id AND l.origin_id=b.origin_id AND l.origin_seq=b.origin_seq
    WHERE b.workspace_id=? AND b.moment_id=?`).get(document.workspaceId,source.sourceMomentId);
  requireValue(settled,"Native activation source moment is neither ordinary history nor a proved settlement.");
  const proved=(value:unknown)=>requireValue(value,"Native activation source settlement is not proved.");
  proved(settled.op_kind==="moment.append"&&integer(settled.relay_seq)&&settled.relay_seq>source.baseRelaySeq&&settled.relay_seq<=source.committedCursor&&
    settled.main_version_id===document.mainVersionId&&settled.object_id===document.objectId&&settled.lineage_claim_id===document.lineageClaimId&&
    settled.namespace===source.relayDatabaseNamespace&&settled.markdown_sha256===source.sourceDigest);
  const write=JSON.parse(String(settled.payload_json)) as Record<string,unknown>;
  const admission=JSON.parse(String(settled.settlement_admission_json)) as {status?:unknown;settlementId?:unknown}|null;
  const reference=write.settlementReference as Record<string,unknown>|null|undefined;
  proved(reference&&typeof reference==="object"&&Object.keys(reference).length===3&&reference.formatVersion===1&&isNativeSettlementRecord(reference.record));
  const record=reference!.record as Record<string,unknown>,binding=record.binding as Record<string,unknown>;
  proved(reference!.recordDigest===settled.record_digest&&settlementRecordDigest(record)===settled.record_digest&&
    admission?.status==="accepted"&&admission.settlementId===settled.settlement_id&&record.settlementId===settled.settlement_id&&
    record.momentId===settled.moment_id&&write.momentId===settled.moment_id&&record.relayDatabaseNamespace===settled.namespace&&
    stableJsonStringify(binding)===settled.binding_json&&binding.restoreFenceGeneration===settled.restore_fence&&
    binding.workspaceId===document.workspaceId&&binding.mainVersionId===document.mainVersionId&&binding.objectId===document.objectId&&
    binding.lineageClaimId===document.lineageClaimId&&binding.currentPath===source.currentPath&&
    record.previousCursor===settled.previous_cursor&&record.terminalCursor===settled.terminal_cursor&&record.markdownDigest===settled.markdown_sha256);
  // The write the moment made: the source text at the bound path.
  proved(write.versionId===document.mainVersionId&&write.objectId===document.objectId&&write.operation==="write"&&write.path===source.currentPath&&
    write.payloadAfterPath===source.currentPath&&write.payloadAfterContentKind==="text"&&write.payloadAfterBlobSha256===source.sourceDigest&&
    write.payloadAfterByteLength===source.sourceByteLength);
  // The terminal's cut and accepted binding.
  const cut=storage.db.prepare(`SELECT c.state_sha256,c.markdown_sha256,c.markdown_byte_length,j.relay_database_namespace,j.current_path,j.selector_paths_json,
      j.restore_fence_generation FROM ${SETTLEMENT_CUTS} c JOIN sync_relay_live_update_journal j USING(journal_cursor)
    WHERE c.journal_cursor=? AND j.workspace_id=? AND j.main_version_id=? AND j.object_id=? AND j.lineage_claim_id=?`)
    .get(settled.terminal_cursor,document.workspaceId,document.mainVersionId,document.objectId,document.lineageClaimId);
  proved(cut&&cut.state_sha256===settled.state_sha256&&cut.markdown_sha256===settled.markdown_sha256&&cut.markdown_byte_length===source.sourceByteLength&&
    cut.relay_database_namespace===settled.namespace&&stableJsonStringify({...binding,currentPath:cut.current_path,
      selectorPaths:JSON.parse(String(cut.selector_paths_json)),restoreFenceGeneration:cut.restore_fence_generation})===settled.binding_json);
  // The state it settled, from retained bytes.
  const state=String(record.acceptedStateBlobSha256);
  const header=storage.db.prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(document.workspaceId,state);
  proved(header&&integer(header.byte_length)&&header.byte_length<=20_971_520);
  input.charge(Number(header!.byte_length));
  const bytes=storage.getBlob(document.workspaceId,state);
  proved(bytes&&bytes.length===header!.byte_length&&hash(bytes)===state);
  return {relaySeq:Number(settled.relay_seq),state:new Uint8Array(bytes!),stateSha256:String(settled.state_sha256)};
}
interface ArtifactProof {
  source:NativeOwnerActivationSource;document:LiveDocumentKey;charge:(bytes:number)=>void;
  /** The captured lineage's projection after the history before this relay position. */
  projectionAt:(relaySeq:number)=>Projection|undefined;
  proved:Map<number,boolean>;
}
const examined=(row:Record<string,unknown>)=>{
  requireValue(integer(row.payload_bytes),"Ordinary activation metadata is damaged.");
  return Number(row.payload_bytes)+Buffer.byteLength(JSON.stringify([row.relay_seq,row.origin_id,row.origin_seq,row.op_kind]));
};
/**
 * Whether a later divergent file moment is a stale artifact of this lineage: a
 * native-shaped text write at the bound path whose ID has a native settlement
 * name, whose origin's nearest preceding Y.Doc row of this document, chosen
 * before any filter, is ordinarily admitted history of the captured lineage,
 * and which nothing replaced from that row through the cut. The history check
 * already refused this document's moves, deletes, unclaimed rows and other
 * bases across the cut; a losing lineage's rows break nothing.
 */
function sameLineageArtifact(storage:StorageContext,proof:ArtifactProof,relaySeq:number):boolean{
  let proved=proof.proved.get(relaySeq);
  if(proved===undefined){proved=artifactStands(storage,proof,relaySeq);proof.proved.set(relaySeq,proved);}
  return proved;
}
function artifactStands(storage:StorageContext,proof:ArtifactProof,relaySeq:number):boolean{
  const {source,document,charge}=proof;
  const artifact=storage.db.prepare("SELECT origin_id,origin_seq,op_kind,payload_json FROM sync_relay_log WHERE workspace_id=? AND relay_seq=?").get(document.workspaceId,relaySeq);
  if(artifact?.op_kind!=="moment.append")return false;
  const write=JSON.parse(String(artifact.payload_json)) as Record<string,unknown>;
  if(typeof write.momentId!=="string"||!/^moment-ydoc-(apply-)?[0-9a-f]{64}$/.test(write.momentId)||!NATIVE_MOMENT_FIELDS.every(field=>Object.hasOwn(write,field))||
    write.versionId!==document.mainVersionId||write.objectId!==document.objectId||write.operation!=="write"||write.path!==source.currentPath||
    write.payloadAfterPath!==source.currentPath||write.payloadAfterContentKind!=="text"||(write.beforeObjectId!=null&&write.beforeObjectId!==document.objectId))return false;
  // Back from the artifact over this document's rows, each charged to the proof budget. Within one origin, relay order is origin order.
  const before=storage.db.prepare(`SELECT relay_seq,origin_id,origin_seq,op_kind,length(CAST(payload_json AS BLOB)) AS payload_bytes
    FROM sync_relay_log INDEXED BY idx_sync_relay_log_document_page
    WHERE workspace_id=? AND json_extract(payload_json,'$.versionId')=? AND json_extract(payload_json,'$.objectId')=? AND relay_seq>=? AND relay_seq<?
    ORDER BY relay_seq DESC`);
  let nearestSeq:number|undefined;
  for(const row of before.iterate(document.workspaceId,document.mainVersionId,document.objectId,source.baseRelaySeq,relaySeq)){
    charge(examined(row));
    if(row.origin_id===artifact.origin_id&&row.op_kind==="ydoc.update"){nearestSeq=Number(row.relay_seq);break;}
  }
  if(nearestSeq===undefined)return false;
  const nearest=storage.db.prepare("SELECT relay_admission,payload_json FROM sync_relay_log WHERE workspace_id=? AND relay_seq=?").get(document.workspaceId,nearestSeq);
  if(!nearest||nearest.relay_admission!==null)return false;
  const update=JSON.parse(String(nearest.payload_json)) as Record<string,unknown>;
  if(update.path!==source.currentPath||update.contentKind!=="richdoc"||update.lineageClaimId!==document.lineageClaimId||
    typeof update.isBaseState!=="boolean"||(update.isBaseState&&update.updateBlobSha256!==document.lineageClaimId))return false;
  // In relay order from that row through the cut, each row examined charged to the proof budget, a replacement breaks the lineage:
  // a refused Y.Doc row of the artifact's origin before it, which keeps no object and so may be this document's nearer row;
  // another write of this document before the artifact (2), unless it folds as an echo of the lineage's projection at that point
  // or is itself a stale artifact of this lineage; or another object at the bound path, or one whose before-image names this
  // document, even if it left again. A write restoring earlier bytes is no echo.
  const scan=storage.db.prepare(`SELECT relay_seq,origin_id,origin_seq,op_kind,length(CAST(payload_json AS BLOB)) AS payload_bytes,
      json_extract(payload_json,'$.payloadAfterBlobSha256') AS after_sha256,json_extract(payload_json,'$.payloadAfterByteLength') AS after_byte_length,
      CASE WHEN op_kind=? THEN origin_id=? AND relay_seq<? AND json_extract(payload_json,'$.opKind')='ydoc.update'
        WHEN COALESCE(json_extract(settlement_admission_json,'$.status'),'')='refused' OR json_extract(payload_json,'$.versionId') IS NOT ? THEN 0
        WHEN json_extract(payload_json,'$.objectId') IS ? THEN CASE WHEN op_kind='moment.append' AND relay_seq>? AND relay_seq<? THEN 2 ELSE 0 END
        ELSE ? IN (json_extract(payload_json,'$.path'),json_extract(payload_json,'$.payloadAfterPath'),json_extract(payload_json,'$.payloadBeforePath'),
          json_extract(payload_json,'$.beforePath')) OR json_extract(payload_json,'$.beforeObjectId')=? END AS replaced
    FROM sync_relay_log INDEXED BY idx_sync_relay_log_page WHERE workspace_id=? AND relay_seq>=? AND relay_seq<=? ORDER BY relay_seq`);
  for(const row of scan.iterate(REFUSED_OP_KIND,artifact.origin_id,relaySeq,document.mainVersionId,document.objectId,nearestSeq,relaySeq,
    source.currentPath,document.objectId,document.workspaceId,nearestSeq,source.committedCursor)){
    charge(examined(row));
    if(row.replaced===1)return false;
    if(row.replaced===2){
      const at=proof.projectionAt(Number(row.relay_seq));
      const echo=!!at&&row.after_sha256===at.projectedMarkdownSha256&&row.after_byte_length===at.projectedMarkdownByteLength;
      if(!echo&&!sameLineageArtifact(storage,proof,Number(row.relay_seq)))return false;
    }
  }
  return true;
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
