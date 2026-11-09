import type {NativeOwnerActivationSource} from "@dohc/workspace-engine-client/daemon";

// The live validation worker reads these; keep this module free of storage imports.
const emptyCandidate=()=>new Uint8Array([0,0]);
const WIDEST_INTEGER=Number.MAX_SAFE_INTEGER,WIDEST_DIGEST="f".repeat(64);
export const activationDescriptorBytes=(source:NativeOwnerActivationSource)=>Buffer.byteLength(JSON.stringify(source));
export const activationCaptureBytes=(baselineBytes:number,fullStateBytes:number,descriptorBytes:number)=>baselineBytes+fullStateBytes+descriptorBytes;
/** What reading one history row's metadata charges. */
export const ordinaryActivationEntryBytes=(row:Readonly<Record<string,unknown>>,payloadBytes:number)=>
  payloadBytes+Buffer.byteLength(JSON.stringify([row.relay_seq,row.origin_id,row.origin_seq,row.op_kind]));
const sum=(values:readonly number[])=>values.reduce((total,value)=>total+value,0);
/** What replaying the baseline and the updates after it charges; a base alone replays an empty candidate. */
const replayBytes=(baselineBytes:number,updateBytes:readonly number[])=>baselineBytes+(updateBytes.length?sum(updateBytes):emptyCandidate().length);
/** What verifying a history charges: the baseline, each row's metadata and update, the full state, and the replay of every update after the base. */
export const ordinaryActivationReadBytes=(history:{baselineBytes:number;entryBytes:readonly number[];updateBytes:readonly number[];fullStateBytes:number})=>
  history.baselineBytes+sum(history.entryBytes)+sum(history.updateBytes)+history.fullStateBytes+replayBytes(history.baselineBytes,history.updateBytes.slice(1));
export type KnownActivationSource=Pick<NativeOwnerActivationSource,"relayDatabaseNamespace"|"workspaceId"|"objectId"|"currentPath"|
  "replicationEpoch"|"streamIdentity"|"baseOriginId"|"sourceMomentId"|"sourceDigest"|"sourceByteLength">;
/** The largest descriptor native can capture for these values: a successor's, which names its predecessor, with the rest in their widest form. */
export function activationReserveSource(known:KnownActivationSource):NativeOwnerActivationSource{
  return {version:1,readerSource:true,relayDatabaseNamespace:known.relayDatabaseNamespace,workspaceId:known.workspaceId,mainVersionId:"main",
    objectId:known.objectId,lineageClaimId:WIDEST_DIGEST,currentPath:known.currentPath,replicationEpoch:known.replicationEpoch,
    streamIdentity:known.streamIdentity,committedCursor:WIDEST_INTEGER,baseOriginId:known.baseOriginId,baseOriginSeq:WIDEST_INTEGER,
    baseRelaySeq:WIDEST_INTEGER,sourceMomentId:known.sourceMomentId,sourceDigest:known.sourceDigest,sourceByteLength:known.sourceByteLength,
    nativeHeadSequence:WIDEST_INTEGER,fullStateDigest:WIDEST_DIGEST,fullStateByteLength:WIDEST_INTEGER,
    predecessorActivationId:`ordinary-activation-${WIDEST_DIGEST}`};
}
export const activationDescriptorReserve=(known:KnownActivationSource)=>activationDescriptorBytes(activationReserveSource(known));
