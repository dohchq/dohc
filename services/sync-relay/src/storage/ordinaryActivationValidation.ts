import {createHash} from "node:crypto";
import type {NativeOwnerActivationSource} from "@dohc/workspace-engine-client/daemon";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {LiveMarkdownRegistrationEvidence} from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import {createLiveMarkdownHistoryValidator,createLiveMarkdownRegistrationValidator} from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import type {OrderedLiveUpdateCutPolicy} from "../../../../packages/ydoc-projection/src/orderedLiveUpdateCut";

// A live validation process loads this module, so it imports nothing that reads storage.
const integer=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
function requireValue(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
/** A capture's history is past a read or work budget. The same history refuses the same way, so activation waits for it to change. */
export class ServiceActivationHistoryOverBudget extends Error {}
export function requireWithinBudget(value:unknown,message:string):asserts value{if(!value)throw new ServiceActivationHistoryOverBudget(message);}
export type Projection={projectedMarkdownSha256:string;projectedMarkdownByteLength:number};
/** The relay history a capture must rebuild, and the source facts it must prove, as one read of its cut found them. */
export interface OrdinaryActivationHistory {
  readonly rows:readonly {relay_seq:number;origin_id:string;origin_seq:number;ordinary:boolean}[];
  readonly updates:readonly Uint8Array[];
  readonly moment:Readonly<Record<string,unknown>>|null;
  /** The first history prefix that must project the source, or null when the latest file moment is the source. */
  readonly from:number|null;
  /** A later divergent file moment that must be a stale artifact of this lineage, or null. */
  readonly artifact:number|null;
  /** The prefixes whose projections the artifact proof compares with this document's writes. */
  readonly wanted:readonly number[];
  /** The state a proved settlement source settled, which must project the source. */
  readonly settled:{readonly state:Uint8Array;readonly stateSha256:string}|null;
  readonly charged:number;
  /**
   * The lineage's checkpoint the history continues from, or null when it starts at the base. `updates[0]` is then the
   * checkpoint's state, `rows[0]` stands for the rows it folded, and its file moments keep the projections they followed.
   */
  readonly checkpoint:{readonly throughRelaySeq:number;readonly stateSha256:string;readonly projection:Projection;
    readonly moments:readonly (Projection&{readonly relaySeq:number})[]}|null;
}
/** A capture's validation. One the relay already retains checks only its baseline. */
export interface OrdinaryActivationWork {
  readonly document:LiveDocumentKey;readonly currentPath:string;readonly baselineBytes:Uint8Array;
  readonly cut?:{readonly source:NativeOwnerActivationSource;readonly fullState:Uint8Array;readonly history:OrdinaryActivationHistory;readonly maxBytesPerDrain:number};
}
export type OrdinaryActivationBaseline=Pick<LiveMarkdownRegistrationEvidence,"projectedMarkdownSha256"|"projectedMarkdownByteLength">&
  {readonly checkpoint:Pick<LiveMarkdownRegistrationEvidence["checkpoint"],"updateDigest"|"ranges">};
/** What validating a cut leaves for the writer transaction: the bytes it charged and the projections of the wanted prefixes. */
export interface OrdinaryActivationProof {readonly charged:number;readonly projections:readonly (Projection&{readonly index:number})[]}
export type OrdinaryActivationValidation={kind:"accepted";baseline:OrdinaryActivationBaseline;proof?:OrdinaryActivationProof}|{kind:"refused";message:string}|
  {kind:"over-budget";message:string}|{kind:"capacity-refused"}|{kind:"retry";reason:"admission-unavailable"};
/**
 * `hasCapacity` says whether a validation slot is free now, so a pass captures nothing while the pool is busy.
 * `waitForCapacity` settles once one may be free, which another operation can still take first.
 * `policySha256` names the policy it validates and folds with; activation continues only checkpoints folded under it,
 * and without it reads every capture's history from the base.
 */
export type OrdinaryActivationValidator=((work:OrdinaryActivationWork|OrdinaryFoldWork,signal?:AbortSignal)=>Promise<OrdinaryActivationValidation|OrdinaryFoldResult>)&
  {readonly hasCapacity?:()=>boolean;readonly waitForCapacity?:(signal?:AbortSignal)=>Promise<void>;readonly policySha256?:string};
/**
 * One page of a lineage's ordinary history to fold into its checkpoint: the state the page starts from and the Y.Doc
 * rows after it, in relay order. `keepFrom` is the first history prefix whose projection the page keeps; 0 is `start`.
 */
export interface OrdinaryFoldWork {
  readonly document:LiveDocumentKey;readonly currentPath:string;
  readonly page:{readonly start:Uint8Array;readonly fromBase:boolean;readonly updates:readonly Uint8Array[];readonly keepFrom:number};
}
/** A folded page: the full state after it, its projection, the base's when the page started there, and the prefixes it kept. */
export type OrdinaryFoldResult={kind:"folded";state:Uint8Array;stateSha256:string;projection:Projection;base:Projection|null;
  prefixes:(Projection&{index:number})[]}|{kind:"refused";message:string}|{kind:"over-budget";message:string};
/**
 * Validates a capture against the history `readOrdinaryActivationHistory` read for it, or folds one page of a lineage's
 * history. Runs in a validation process; it reads no storage. Each refusal message is the one activation reports.
 */
export function validateOrdinaryActivation(work:OrdinaryFoldWork,policy:OrderedLiveUpdateCutPolicy):OrdinaryFoldResult;
export function validateOrdinaryActivation(work:OrdinaryActivationWork,policy:OrderedLiveUpdateCutPolicy):Exclude<OrdinaryActivationValidation,{kind:"capacity-refused"|"retry"}>;
export function validateOrdinaryActivation(work:OrdinaryActivationWork|OrdinaryFoldWork,policy:OrderedLiveUpdateCutPolicy):Exclude<OrdinaryActivationValidation,{kind:"capacity-refused"|"retry"}>|OrdinaryFoldResult;
export function validateOrdinaryActivation(work:OrdinaryActivationWork|OrdinaryFoldWork,policy:OrderedLiveUpdateCutPolicy):Exclude<OrdinaryActivationValidation,{kind:"capacity-refused"|"retry"}>|OrdinaryFoldResult{
  if("page" in work)return foldOrdinaryHistoryPage(work,policy);
  const {document,currentPath,baselineBytes}=work,validateRegistration=createLiveMarkdownRegistrationValidator(policy);
  const base=validateRegistration({document,currentPath,checkpoint:baselineBytes});
  if(base.kind!=="accepted")return {kind:"refused",message:"Native activation does not match the ordinary source."};
  const baseline={checkpoint:{updateDigest:base.evidence.checkpoint.updateDigest,ranges:base.evidence.checkpoint.ranges},
    projectedMarkdownSha256:base.evidence.projectedMarkdownSha256,projectedMarkdownByteLength:base.evidence.projectedMarkdownByteLength};
  if(!work.cut)return {kind:"accepted",baseline};
  try{return {kind:"accepted",baseline,proof:checkOrdinaryActivationHistory(work,work.cut,baseline,validateRegistration,createLiveMarkdownHistoryValidator(policy))};}
  catch(error){
    if(error instanceof ServiceActivationHistoryOverBudget)return {kind:"over-budget",message:error.message};
    return {kind:"refused",message:error instanceof Error?error.message:String(error)};
  }
}
function checkOrdinaryActivationHistory(work:OrdinaryActivationWork,cut:NonNullable<OrdinaryActivationWork["cut"]>,baseline:OrdinaryActivationBaseline,
  validateRegistration:ReturnType<typeof createLiveMarkdownRegistrationValidator>,validateHistory:ReturnType<typeof createLiveMarkdownHistoryValidator>):OrdinaryActivationProof{
  const {document}=work,{source,fullState,history:{updates,from,wanted,settled},maxBytesPerDrain}=cut;
  let charged=cut.history.charged;
  const charge=(bytes:number)=>{requireWithinBudget(integer(bytes)&&charged<=maxBytesPerDrain-bytes,"Ordinary activation history exceeds its configured byte budget.");charged+=bytes;};
  const projects=(evidence:Projection)=>evidence.projectedMarkdownSha256===source.sourceDigest&&evidence.projectedMarkdownByteLength===source.sourceByteLength;
  charge(fullState.length);
  const full=validateRegistration({document,currentPath:source.currentPath,checkpoint:fullState});
  requireValue(full.kind==="accepted","Native activation is not a complete standalone CRDT state.");
  if(settled){
    // The state the source settlement settled, from bytes the read charged.
    const state=validateRegistration({document,currentPath:source.currentPath,checkpoint:settled.state});
    requireValue(state.kind==="accepted"&&state.evidence.stateUpdateSha256===settled.stateSha256&&projects(state.evidence),"Native activation source settlement is not proved.");
  }
  // One pass validates the history and, from the source's prefix on, checks that every prefix keeps its projection,
  // so a change and its reversal can't stand behind an earlier source. The baseline alone was validated as a registration.
  charge(updates[0]!.length+(updates.length===1?2:updates.slice(1).reduce((sum,bytes)=>sum+bytes.length,0)));
  // The first prefix is the base, or the checkpoint the relay's own validation folded and projected.
  const start=from===null?updates.length:Math.max(from,1);
  const keep=new Set(wanted),lower=Math.min(start,...wanted),projections:(Projection&{index:number})[]=[];
  let projected=from!==0||projects(cut.history.checkpoint?cut.history.checkpoint.projection:baseline),next=lower;
  const result=validateHistory({document,currentPath:source.currentPath,checkpoint:updates[0]!,suffix:updates.slice(1,Math.max(updates.length-1,1)),
    candidate:updates.length===1?new Uint8Array([0,0]):updates[updates.length-1]!},
  {from:lower,visit:(evidence,index)=>{
    projected&&=index===next++&&(index<start||projects(evidence));
    if(keep.has(index))projections.push({index,projectedMarkdownSha256:evidence.projectedMarkdownSha256,projectedMarkdownByteLength:evidence.projectedMarkdownByteLength});
  }});
  requireWithinBudget(result.kind==="accepted"||result.reason!=="capacity-refused","Ordinary activation history exceeds its configured validation budget.");
  requireValue(result.kind==="accepted","Ordinary activation history is not a valid live document.");
  const captured=full.evidence,ordinary=result.evidence;
  requireValue(captured.stateUpdateSha256===ordinary.stateUpdateSha256&&captured.stateUpdateByteLength===ordinary.stateUpdateByteLength&&
    Buffer.compare(Buffer.from(captured.stateUpdate),Buffer.from(ordinary.stateUpdate))===0&&projects(ordinary),
    "Native activation differs from the complete ordinary CRDT history.");
  requireValue(projected&&next===Math.max(updates.length-1,lower),"Native activation source moment does not project the captured source.");
  return {charged,projections};
}

const projectionOf=(evidence:Projection):Projection=>({projectedMarkdownSha256:evidence.projectedMarkdownSha256,projectedMarkdownByteLength:evidence.projectedMarkdownByteLength});
/**
 * Folds one page with the same validator activation runs on a whole history. Its state is the next page's start, so
 * a history of any length is validated in pages no larger than one activation reads.
 */
function foldOrdinaryHistoryPage(work:OrdinaryFoldWork,policy:OrderedLiveUpdateCutPolicy):OrdinaryFoldResult{
  const {document,currentPath,page:{start,fromBase,updates,keepFrom}}=work;
  let base:Projection|null=null;
  if(fromBase){
    const accepted=createLiveMarkdownRegistrationValidator(policy)({document,currentPath,checkpoint:start});
    if(accepted.kind!=="accepted")return {kind:"refused",message:"Native activation does not match the ordinary source."};
    base=projectionOf(accepted.evidence);
  }
  if(updates.length===0){
    if(!base)return {kind:"refused",message:"Ordinary activation history is unavailable."};
    return {kind:"folded",state:start,stateSha256:createHash("sha256").update(start).digest("hex"),projection:base,base,prefixes:[]};
  }
  const prefixes:(Projection&{index:number})[]=[];
  const result=createLiveMarkdownHistoryValidator(policy)({document,currentPath,checkpoint:start,suffix:updates.slice(0,-1),candidate:updates[updates.length-1]!},
    {from:keepFrom,visit:(evidence,index)=>{prefixes.push({index,...projectionOf(evidence)});}});
  if(result.kind!=="accepted"&&result.reason==="capacity-refused")return {kind:"over-budget",message:"Ordinary activation history exceeds its configured validation budget."};
  if(result.kind!=="accepted")return {kind:"refused",message:"Ordinary activation history is not a valid live document."};
  return {kind:"folded",state:result.evidence.stateUpdate,stateSha256:result.evidence.stateUpdateSha256,projection:projectionOf(result.evidence),base,prefixes};
}
