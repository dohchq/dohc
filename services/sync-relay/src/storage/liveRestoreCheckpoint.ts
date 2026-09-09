import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {parseAdmittedLiveUpdateMetadata,parseLiveUpdateDigest,parseLiveUpdateIdentifier,type AdmittedLiveUpdateMetadata} from "@dohc/live-session-contract/live-update-admission";
import {parseNativeRestoreFenceReceipt} from "../liveRestoreFence";
import {configRecord} from "../deviceLiveHostConfig";
import type {RestoreLifecycle} from "../liveRestoreLifecycle";
import {authorityInteger} from "./liveDocumentAuthority";
import {LIVE_RESTORE_LIFECYCLES,LIVE_RESTORE_OPERATIONS,LIVE_RESTORE_PROPOSALS} from "./liveRestoreOperationSchema";
import type {SqliteDb} from "./types";

export type RestoreSourceRange = {sourceOrdinal:number;clientId:number;startClock:number;endClock:number;sourceDigest:string};
export type RestoreAdmission = Pick<RestoreLifecycle,"proposalDigest"|"candidateDigest"|"preparation"|"nativeSourceManifestDigest"|"admitted"> & {
  checkpointDigest:string;sourceRanges:readonly RestoreSourceRange[];recordedAtMs:number;
};
export const restoreDigest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function restoreIntegrity(condition:unknown):asserts condition {
  if (!condition) throw new Error("Retained restore evidence is damaged.");
}
export function parseRestoreAdmission(value:unknown):RestoreAdmission {
  const r=configRecord(value,["proposalDigest","candidateDigest","preparation","nativeSourceManifestDigest","admitted","checkpointDigest","sourceRanges","recordedAtMs"]);
  const p=configRecord(r.preparation,["fence","point"]),point=configRecord(p.point,["journalCursor","receiptDigest","markdownDigest","projectionDigest"]);
  restoreIntegrity(Array.isArray(r.sourceRanges));
  const sourceRanges=r.sourceRanges.map(value=>{
    const s=configRecord(value,["sourceOrdinal","clientId","startClock","endClock","sourceDigest"]);
    const startClock=authorityInteger(s.startClock),endClock=authorityInteger(s.endClock,1);
    restoreIntegrity(endClock>startClock);
    return {sourceOrdinal:authorityInteger(s.sourceOrdinal),clientId:authorityInteger(s.clientId),startClock,endClock,sourceDigest:parseLiveUpdateDigest(s.sourceDigest)};
  });
  return {proposalDigest:parseLiveUpdateDigest(r.proposalDigest),candidateDigest:parseLiveUpdateDigest(r.candidateDigest),
    preparation:{fence:parseNativeRestoreFenceReceipt(p.fence),point:{journalCursor:authorityInteger(point.journalCursor),
      receiptDigest:parseLiveUpdateDigest(point.receiptDigest),markdownDigest:parseLiveUpdateDigest(point.markdownDigest),projectionDigest:parseLiveUpdateDigest(point.projectionDigest)}},
    nativeSourceManifestDigest:parseLiveUpdateDigest(r.nativeSourceManifestDigest),admitted:parseAdmittedLiveUpdateMetadata(r.admitted),
    checkpointDigest:parseLiveUpdateDigest(r.checkpointDigest),sourceRanges,recordedAtMs:authorityInteger(r.recordedAtMs)};
}
export function readRestoreAdmission(db:SqliteDb,namespace:string,operationId:string,maxBytes=Number.MAX_SAFE_INTEGER,chargeBytes?:(value:number)=>void):RestoreAdmission {
  const header=db.prepare(`SELECT l.max_evidence_bytes,length(CAST(l.admission_json AS BLOB))+length(CAST(o.intent_json AS BLOB))+length(CAST(o.basis_json AS BLOB))+length(CAST(o.native_receipt_json AS BLOB)) AS bytes FROM ${LIVE_RESTORE_LIFECYCLES} l JOIN ${LIVE_RESTORE_OPERATIONS} o USING(relay_database_namespace,operation_id)
    WHERE l.relay_database_namespace=? AND l.operation_id=?`).get(namespace,operationId);
  restoreIntegrity(header && authorityInteger(header.bytes,1)<=Math.min(maxBytes,authorityInteger(header.max_evidence_bytes,1)));
  chargeBytes?.(authorityInteger(header.bytes,1));
  const raw=db.prepare(`SELECT l.admission_json,l.admission_sha256,o.workspace_id,o.main_version_id,o.object_id,o.lineage_claim_id,
    o.intent_json,o.basis_json,o.native_receipt_json,o.new_fence,o.phase,p.proposal_sha256,p.candidate_sha256
    FROM ${LIVE_RESTORE_LIFECYCLES} l JOIN ${LIVE_RESTORE_OPERATIONS} o USING(relay_database_namespace,operation_id)
    JOIN ${LIVE_RESTORE_PROPOSALS} p USING(relay_database_namespace,operation_id)
    WHERE l.relay_database_namespace=? AND l.operation_id=?`).get(namespace,operationId);
  restoreIntegrity(raw && typeof raw.admission_json==="string" && Buffer.byteLength(raw.admission_json)+Buffer.byteLength(String(raw.intent_json))+Buffer.byteLength(String(raw.basis_json))+Buffer.byteLength(String(raw.native_receipt_json))===header.bytes);
  restoreIntegrity(["relay-admitted","native-applied","settled","resumed"].includes(String(raw.phase)));
  const parsed=JSON.parse(raw.admission_json);restoreIntegrity(restoreDigest(parsed)===raw.admission_sha256);
  const admission=parseRestoreAdmission(parsed),{operation}=admission.preparation.fence,binding=admission.admitted.accepted.binding;
  const intended={...operation.oldBinding,restoreFenceGeneration:operation.newFence};
  restoreIntegrity(operation.relayDatabaseNamespace===namespace && operation.operationId===operationId &&
    binding.workspaceId===raw.workspace_id && binding.mainVersionId===raw.main_version_id && binding.objectId===raw.object_id && binding.lineageClaimId===raw.lineage_claim_id &&
    isDeepStrictEqual(binding,intended) && raw.new_fence===operation.newFence &&
    isDeepStrictEqual(JSON.parse(String(raw.native_receipt_json)),admission.preparation.fence) &&
    admission.proposalDigest===raw.proposal_sha256 && admission.candidateDigest===raw.candidate_sha256 &&
    admission.admitted.accepted.receipt.updateDigest===admission.candidateDigest && admission.admitted.accepted.authority.principalKind==="owner");
  const intent=JSON.parse(String(raw.intent_json)),basis=JSON.parse(String(raw.basis_json));
  restoreIntegrity(admission.admitted.accepted.authority.principalId===intent.ownerUserId && basis.namespace===namespace &&
    basis.hostId===operation.hostId && intent.operationId===operationId &&
    admission.preparation.point.journalCursor===intent.restorePointCursor && admission.preparation.point.receiptDigest===intent.restorePointReceiptDigest);
  return admission;
}
export function verifyRestoreCheckpoint(db:SqliteDb,row:{admitted:{metadata:AdmittedLiveUpdateMetadata};checkpoint:{digest:string}|null;
  restoreOperationId:string|null;history:{namespace:string}},maxBytes=Number.MAX_SAFE_INTEGER,chargeBytes?:(value:number)=>void):RestoreAdmission|null {
  if (row.restoreOperationId===null) return null;
  const admission=readRestoreAdmission(db,row.history.namespace,parseLiveUpdateIdentifier(row.restoreOperationId),maxBytes,chargeBytes);
  restoreIntegrity(row.checkpoint && row.checkpoint.digest===admission.checkpointDigest && isDeepStrictEqual(row.admitted.metadata,admission.admitted));
  return admission;
}
