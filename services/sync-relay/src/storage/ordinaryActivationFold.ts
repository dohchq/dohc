import {createHash} from "node:crypto";
import type {StorageContext} from "./context";
import {OTHER_LINEAGE_UPDATE} from "./otherLineageUpdate";
import {CHECKPOINT_MOMENTS,CHECKPOINT_TAIL_ROWS,readOrdinaryCheckpoint,replaceOrdinaryCheckpoint,type OrdinaryCheckpoint,type OrdinaryCheckpointMoment,
  type OrdinaryCheckpointRow,type OrdinaryCheckpointScope} from "./ordinaryActivationCheckpoint";
import type {OrdinaryFoldResult,OrdinaryFoldWork} from "./ordinaryActivationValidation";

/**
 * Folds a lineage's ordinary history into its checkpoint one page at a time. A page holds at most `pageRows` rows of the
 * document and `pageBytes` of updates, so its validation takes about as long however long the history is. The fold
 * checks each row as activation's reader does and stops before any row the reader would refuse, so a checkpoint only
 * ever covers rows activation would have accepted.
 */
export interface OrdinaryFoldBounds {readonly pageRows:number;readonly pageBytes:number}
type PageMoment=Omit<OrdinaryCheckpointMoment,"projectedMarkdownSha256"|"projectedMarkdownByteLength">;
type PageRow=Omit<OrdinaryCheckpointRow,"projection">;
export type OrdinaryFoldPage={
  readonly kind:"page";readonly scope:OrdinaryCheckpointScope;readonly prior:OrdinaryCheckpoint|null;readonly base:PageRow;
  /** Null when the page holds only file moments after a checkpoint, which need no validation. */
  readonly work:OrdinaryFoldWork|null;
  /** The file moments before the page's first Y.Doc row: a page ends before a moment, so each follows the page's start. */
  readonly moments:readonly PageMoment[];readonly rows:readonly PageRow[];
  readonly throughRelaySeq:number;readonly currentPath:string;
  /** Whether the page reached the relay's cursor, so it kept the projections of its last rows. */
  readonly reachedCursor:boolean;
}|{readonly kind:"current"}|{readonly kind:"blocked";readonly relaySeq:number};

const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const integer=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const digest=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{64}$/.test(value);
const bytesOf=(value:unknown)=>value instanceof Uint8Array?new Uint8Array(value):null;

/** Reads the next page to fold after the lineage's checkpoint, or after its base when it has none, in one query. */
export function readOrdinaryFoldPage(storage:StorageContext,scope:OrdinaryCheckpointScope,bounds:OrdinaryFoldBounds):OrdinaryFoldPage{
  const {document}=scope;
  for(const value of Object.values(bounds))if(!integer(value)||value<1)throw new Error("Invalid ordinary fold bounds.");
  const baseRow=storage.db.prepare(`SELECT l.relay_seq,l.origin_id,l.origin_seq,l.op_kind,l.relay_admission,l.payload_json,b.content
    FROM sync_relay_log l LEFT JOIN sync_relay_blobs b ON b.workspace_id=l.workspace_id AND b.sha256=json_extract(l.payload_json,'$.updateBlobSha256')
    WHERE l.workspace_id=? AND l.relay_seq=?`).get(document.workspaceId,scope.base.relaySeq);
  const basePayload=typeof baseRow?.payload_json==="string"?JSON.parse(baseRow.payload_json) as Record<string,unknown>:null;
  const baseBytes=bytesOf(baseRow?.content);
  if(!baseRow||!basePayload||!baseBytes||baseRow.op_kind!=="ydoc.update"||baseRow.origin_id!==scope.base.originId||baseRow.origin_seq!==scope.base.originSeq||
    basePayload.versionId!==document.mainVersionId||basePayload.objectId!==document.objectId||basePayload.contentKind!=="richdoc"||
    basePayload.lineageClaimId!==document.lineageClaimId||basePayload.isBaseState!==true||basePayload.updateBlobSha256!==document.lineageClaimId||
    typeof basePayload.path!=="string"||hash(baseBytes)!==document.lineageClaimId)return {kind:"blocked",relaySeq:scope.base.relaySeq};
  // Every Y.Doc row and write of an activatable lineage is at its base's path; moves between them must return there.
  const documentPath=String(basePayload.path);
  const base:PageRow={relaySeq:scope.base.relaySeq,originId:scope.base.originId,originSeq:scope.base.originSeq,ordinary:baseRow.relay_admission===null};
  const prior=readOrdinaryCheckpoint(storage,scope);
  const after=prior?prior.throughRelaySeq:scope.base.relaySeq;
  let path=prior?prior.currentPath:documentPath;
  const cursor=Number(storage.db.prepare("SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?").get(document.workspaceId)!.cursor);
  const found=storage.db.prepare(`SELECT l.relay_seq,l.origin_id,l.origin_seq,l.op_kind,l.relay_admission,l.payload_json,b.byte_length,b.content
    FROM sync_relay_log AS l INDEXED BY idx_sync_relay_log_document_page
    LEFT JOIN sync_relay_blobs b ON l.op_kind='ydoc.update' AND b.workspace_id=l.workspace_id AND b.sha256=json_extract(l.payload_json,'$.updateBlobSha256')
    WHERE l.workspace_id=? AND l.relay_seq>? AND l.relay_seq<=? AND json_extract(l.payload_json,'$.versionId')=? AND json_extract(l.payload_json,'$.objectId')=?
      AND COALESCE(json_extract(l.settlement_admission_json,'$.status'),'')<>'refused' AND NOT (${OTHER_LINEAGE_UPDATE})
    ORDER BY l.relay_seq LIMIT ?`).all(document.workspaceId,after,cursor,document.mainVersionId,document.objectId,document.lineageClaimId,bounds.pageRows+1);
  const objectMoment=storage.db.prepare("SELECT 1 FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=? AND version_id=?");
  const moments:PageMoment[]=[],rows:PageRow[]=[],updates:Uint8Array[]=[];
  let through=after,bytes=0,blocked:number|null=null,full=false;
  for(const row of found){
    if(moments.length+rows.length===bounds.pageRows){full=true;break;}
    const relaySeq=Number(row.relay_seq),payload=JSON.parse(String(row.payload_json)) as Record<string,unknown>;
    if(row.op_kind==="moment.append"){
      // The page ends before a moment, so the projection the moment followed is the one the page starts from.
      if(updates.length>0){full=true;break;}
      if(!(payload.payloadAfterContentKind==="text"&&typeof payload.momentId==="string"&&payload.momentId.length>0&&digest(payload.payloadAfterBlobSha256)&&
        integer(payload.payloadAfterByteLength)&&payload.payloadAfterByteLength<=2_097_152)){blocked=relaySeq;break;}
      if(payload.operation==="rename"){
        if(!(typeof payload.payloadAfterPath==="string"&&payload.path===payload.payloadAfterPath&&payload.payloadBeforePath===path&&
          payload.payloadBeforeContentKind==="text"&&payload.payloadBeforeBlobSha256===payload.payloadAfterBlobSha256)){blocked=relaySeq;break;}
        path=String(payload.payloadAfterPath);
        moments.push({relaySeq,operation:"rename",write:null});
      }else{
        if(!(payload.operation==="write"&&payload.path===documentPath&&payload.payloadAfterPath===documentPath&&path===documentPath)){blocked=relaySeq;break;}
        moments.push({relaySeq,operation:"write",write:{blobSha256:String(payload.payloadAfterBlobSha256),byteLength:Number(payload.payloadAfterByteLength),
          objectMoment:!!objectMoment.get(document.workspaceId,document.objectId,relaySeq,document.mainVersionId)}});
      }
      through=relaySeq;continue;
    }
    const content=bytesOf(row.content);
    if(!(row.op_kind==="ydoc.update"&&payload.path===documentPath&&path===documentPath&&payload.contentKind==="richdoc"&&
      payload.lineageClaimId===document.lineageClaimId&&typeof payload.isBaseState==="boolean"&&digest(payload.updateBlobSha256)&&
      (!payload.isBaseState||payload.updateBlobSha256===document.lineageClaimId)&&content&&integer(row.origin_seq)&&typeof row.origin_id==="string"&&
      row.origin_id.length>0&&row.byte_length===content.length&&hash(content)===payload.updateBlobSha256)){blocked=relaySeq;break;}
    if(updates.length>0&&bytes+content.length>bounds.pageBytes){full=true;break;}
    updates.push(content);bytes+=content.length;through=relaySeq;
    rows.push({relaySeq,originId:String(row.origin_id),originSeq:Number(row.origin_seq),ordinary:row.relay_admission===null});
  }
  if(through===after)return blocked!==null?{kind:"blocked",relaySeq:blocked}:prior?{kind:"current"}:
    // A lineage with nothing after its base still folds once, so its checkpoint holds the base's projection.
    {kind:"page",scope,prior,base,moments,rows,throughRelaySeq:after,currentPath:path,reachedCursor:true,
      work:{document,currentPath:documentPath,page:{start:baseBytes,fromBase:true,updates:[],keepFrom:0}}};
  const reachedCursor=blocked===null&&!full;
  // A source the engine names is the last ordinary row it applied, so only a page that reached the cursor keeps its last rows' projections.
  const keepFrom=reachedCursor?Math.max(1,updates.length-CHECKPOINT_TAIL_ROWS+1):updates.length;
  const work=prior&&updates.length===0?null:{document,currentPath:documentPath,
    page:{start:prior?prior.state:baseBytes,fromBase:!prior,updates,keepFrom}};
  return {kind:"page",scope,prior,base,work,moments,rows,throughRelaySeq:through,currentPath:path,reachedCursor};
}

/** The checkpoint a validated page leaves. */
export function foldedOrdinaryCheckpoint(page:Extract<OrdinaryFoldPage,{kind:"page"}>,result:Extract<OrdinaryFoldResult,{kind:"folded"}>|null):OrdinaryCheckpoint{
  const {prior,rows}=page;
  const start=prior?prior.projection:result?.base;
  if(!start||(!prior&&!result)||(rows.length>0&&!result))throw new Error("Ordinary fold page was not validated.");
  const end=rows.length>0?result!.projection:start;
  const kept=new Map((result?.prefixes??[]).map(({index,...projection})=>[index,projection]));
  // Prefix i is the history through the page's row i-1; the last prefix is the page's end.
  const folded=rows.map((row,index)=>({...row,projection:index===rows.length-1?end:kept.get(index+1)??null}));
  const tail=[...(prior?prior.tail:[{...page.base,projection:start}]),...folded].slice(-CHECKPOINT_TAIL_ROWS);
  let moments=[...(prior?prior.moments:[]),...page.moments.map(moment=>({...moment,...start}))];
  let momentsFromSeq=prior?prior.momentsFromSeq:page.base.relaySeq;
  if(moments.length>CHECKPOINT_MOMENTS){momentsFromSeq=moments[moments.length-CHECKPOINT_MOMENTS-1]!.relaySeq+1;moments=moments.slice(-CHECKPOINT_MOMENTS);}
  const state=rows.length>0||!prior?result!.state:prior.state;
  return {throughRelaySeq:page.throughRelaySeq,foldedEntries:(prior?prior.foldedEntries:1)+rows.length,state,
    stateSha256:rows.length>0||!prior?result!.stateSha256:prior.stateSha256,currentPath:page.currentPath,projection:end,tail,moments,momentsFromSeq};
}

export type OrdinaryFoldValidator=(work:OrdinaryFoldWork,signal?:AbortSignal)=>Promise<OrdinaryFoldResult|{kind:"capacity-refused"}|{kind:"retry";reason:"admission-unavailable"}>;
export type OrdinaryFoldOutcome={kind:"folded";throughRelaySeq:number;reachedCursor:boolean}|{kind:"current"}|{kind:"blocked";relaySeq:number}|
  {kind:"refused";message:string}|{kind:"over-budget";message:string}|{kind:"busy"}|{kind:"lost"};
/**
 * Folds the lineage's next page and saves it in one short transaction. Validation runs off the event loop and outside
 * any transaction. Another fold that saved first, or a relay that no longer holds the rows, leaves this one `lost`.
 */
export async function foldOrdinaryCheckpointPage(storage:StorageContext,input:{scope:OrdinaryCheckpointScope;bounds:OrdinaryFoldBounds;
  validate:OrdinaryFoldValidator;nowMs:()=>number;signal?:AbortSignal}):Promise<OrdinaryFoldOutcome>{
  const page=readOrdinaryFoldPage(storage,input.scope,input.bounds);
  if(page.kind!=="page")return page;
  let result:Extract<OrdinaryFoldResult,{kind:"folded"}>|null=null;
  if(page.work){
    const validated=await input.validate(page.work,input.signal);
    if(validated.kind==="capacity-refused"||validated.kind==="retry")return {kind:"busy"};
    if(validated.kind!=="folded")return validated;
    result=validated;
  }
  const checkpoint=foldedOrdinaryCheckpoint(page,result);
  const saved=storage.tx(()=>replaceOrdinaryCheckpoint(storage,{scope:page.scope,expected:page.prior?page.prior.throughRelaySeq:null,checkpoint,nowMs:input.nowMs()}));
  return saved?{kind:"folded",throughRelaySeq:page.throughRelaySeq,reachedCursor:page.reachedCursor}:{kind:"lost"};
}
