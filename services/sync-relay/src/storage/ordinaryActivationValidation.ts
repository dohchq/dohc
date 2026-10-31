import type {NativeOwnerActivationSource} from "@dohc/workspace-engine-client/daemon";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {LiveMarkdownRegistrationEvidence} from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import {createLiveMarkdownHistoryValidator,createLiveMarkdownRegistrationValidator} from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import type {OrderedLiveUpdateCutPolicy} from "../../../../packages/ydoc-projection/src/orderedLiveUpdateCut";

// A live validation process loads this module, so it imports nothing that reads storage.
const integer=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
function requireValue(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
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
  {kind:"capacity-refused"}|{kind:"retry";reason:"admission-unavailable"};
export type OrdinaryActivationValidator=(work:OrdinaryActivationWork,signal?:AbortSignal)=>Promise<OrdinaryActivationValidation>;
/**
 * Validates a capture against the history `readOrdinaryActivationHistory` read for it. Runs in a
 * validation process; it reads no storage. Each refusal message is the one activation reports.
 */
export function validateOrdinaryActivation(work:OrdinaryActivationWork,policy:OrderedLiveUpdateCutPolicy):Exclude<OrdinaryActivationValidation,{kind:"capacity-refused"|"retry"}>{
  const {document,currentPath,baselineBytes}=work,validateRegistration=createLiveMarkdownRegistrationValidator(policy);
  const base=validateRegistration({document,currentPath,checkpoint:baselineBytes});
  if(base.kind!=="accepted")return {kind:"refused",message:"Native activation does not match the ordinary source."};
  const baseline={checkpoint:{updateDigest:base.evidence.checkpoint.updateDigest,ranges:base.evidence.checkpoint.ranges},
    projectedMarkdownSha256:base.evidence.projectedMarkdownSha256,projectedMarkdownByteLength:base.evidence.projectedMarkdownByteLength};
  if(!work.cut)return {kind:"accepted",baseline};
  try{return {kind:"accepted",baseline,proof:checkOrdinaryActivationHistory(work,work.cut,baseline,validateRegistration,createLiveMarkdownHistoryValidator(policy))};}
  catch(error){return {kind:"refused",message:error instanceof Error?error.message:String(error)};}
}
function checkOrdinaryActivationHistory(work:OrdinaryActivationWork,cut:NonNullable<OrdinaryActivationWork["cut"]>,baseline:OrdinaryActivationBaseline,
  validateRegistration:ReturnType<typeof createLiveMarkdownRegistrationValidator>,validateHistory:ReturnType<typeof createLiveMarkdownHistoryValidator>):OrdinaryActivationProof{
  const {document,baselineBytes}=work,{source,fullState,history:{updates,from,wanted,settled},maxBytesPerDrain}=cut;
  let charged=cut.history.charged;
  const charge=(bytes:number)=>{requireValue(integer(bytes)&&charged<=maxBytesPerDrain-bytes,"Ordinary activation history exceeds its configured byte budget.");charged+=bytes;};
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
  charge(baselineBytes.length+(updates.length===1?2:updates.slice(1).reduce((sum,bytes)=>sum+bytes.length,0)));
  const start=from===null?updates.length:Math.max(from,1);
  const keep=new Set(wanted),lower=Math.min(start,...wanted),projections:(Projection&{index:number})[]=[];
  let projected=from!==0||projects(baseline),next=lower;
  const result=validateHistory({document,currentPath:source.currentPath,checkpoint:baselineBytes,suffix:updates.slice(1,Math.max(updates.length-1,1)),
    candidate:updates.length===1?new Uint8Array([0,0]):updates[updates.length-1]!},
  {from:lower,visit:(evidence,index)=>{
    projected&&=index===next++&&(index<start||projects(evidence));
    if(keep.has(index))projections.push({index,projectedMarkdownSha256:evidence.projectedMarkdownSha256,projectedMarkdownByteLength:evidence.projectedMarkdownByteLength});
  }});
  requireValue(result.kind==="accepted"||result.reason!=="capacity-refused","Ordinary activation history exceeds its configured validation budget.");
  requireValue(result.kind==="accepted","Ordinary activation history is not a valid live document.");
  const captured=full.evidence,ordinary=result.evidence;
  requireValue(captured.stateUpdateSha256===ordinary.stateUpdateSha256&&captured.stateUpdateByteLength===ordinary.stateUpdateByteLength&&
    Buffer.compare(Buffer.from(captured.stateUpdate),Buffer.from(ordinary.stateUpdate))===0&&projects(ordinary),
    "Native activation differs from the complete ordinary CRDT history.");
  requireValue(projected&&next===Math.max(updates.length-1,lower),"Native activation source moment does not project the captured source.");
  return {charged,projections};
}
