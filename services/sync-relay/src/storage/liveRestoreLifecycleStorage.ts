import {isDeepStrictEqual} from "node:util";
import {parseLiveObjectBinding,type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseNativeRestoreApplicationReceipt,parseNativeRestoreSettlementReceipt,parseNativeRestoreResumeReceipt,type RestoreLifecycle} from "../liveRestoreLifecycle";
import {readRestoreAdmission,restoreIntegrity as require,type RestoreAdmission} from "./liveRestoreCheckpoint";
import {LIVE_RESTORE_LIFECYCLES as table,LIVE_RESTORE_OPERATIONS as operations} from "./liveRestoreOperationSchema";
import {authorityInteger} from "./liveDocumentAuthority";
import {LIVE_RESTORE_CANCELLATIONS} from "./liveRestoreCancellationSchema";
import {parseNativeRestoreCancellationAnswer} from "../liveRestoreFence";
import type {SqliteDb} from "./types";

export function validateRestoreLifecycle(admission: RestoreAdmission, value: RestoreLifecycle): void {
  const {application,settlement,resume}=value, operation=admission.preparation.fence.operation;
  require((value.phase!=="relay-admitted")===(application!==null));
  require((["settled","resumed"].includes(value.phase))===(settlement!==null && settlement.materialized));
  require((value.phase==="resumed")===(resume!==null));
  if (application) require(isDeepStrictEqual(application.fence,admission.preparation.fence) &&
    isDeepStrictEqual(application.admitted,admission.admitted) && application.candidateDigest===admission.candidateDigest &&
    application.nativeSourceManifestDigest===admission.nativeSourceManifestDigest && application.hostCoordinate.hostId===operation.hostId &&
    application.localHeadSequence===admission.preparation.fence.localHeadSequence+1);
  if (settlement) require(application && settlement.terminalCursor===admission.admitted.accepted.receipt.journalCursor &&
    settlement.previousCursor<settlement.terminalCursor && settlement.previousCursor<=(operation.terminal?.journalCursor??0) &&
    settlement.localYDocSequence===application.localHeadSequence && settlement.markdownDigest===admission.preparation.point.markdownDigest);
  if (resume) require(application && settlement?.materialized && resume.relayDatabaseNamespace===operation.relayDatabaseNamespace &&
    resume.operationId===operation.operationId && isDeepStrictEqual(resume.binding,admission.admitted.accepted.binding) &&
    isDeepStrictEqual(resume.applicationReceipt,admission.admitted.accepted.receipt) && resume.settlementId===settlement.settlementId &&
    resume.momentId===settlement.momentId && resume.markdownDigest===settlement.markdownDigest && resume.localHeadSequence===application.localHeadSequence);
}
export function retainedRestoreLifecycle(db: SqliteDb, namespace: string, operationId: string,maxBytes=Number.MAX_SAFE_INTEGER):
  {admission:RestoreAdmission;lifecycle:RestoreLifecycle;row:Record<string,unknown>}|null {
  const header=db.prepare(`SELECT max_evidence_bytes,COALESCE(length(CAST(application_json AS BLOB)),0)+
    COALESCE(length(CAST(pending_settlement_json AS BLOB)),0)+COALESCE(length(CAST(settlement_json AS BLOB)),0)+
    COALESCE(length(CAST(resume_json AS BLOB)),0) AS bytes FROM ${table} WHERE relay_database_namespace=? AND operation_id=?`).get(namespace,operationId);
  if (!header) return null;
  const bytes=authorityInteger(header.bytes),limit=Math.min(maxBytes,authorityInteger(header.max_evidence_bytes,1));
  require(bytes<=limit);
  const admission=readRestoreAdmission(db,namespace,operationId,limit-bytes);
  const row=db.prepare(`SELECT l.*,o.phase FROM ${table} l JOIN ${operations} o USING(relay_database_namespace,operation_id)
    WHERE l.relay_database_namespace=? AND l.operation_id=?`).get(namespace,operationId)!;
  require(bytes===[row.application_json,row.pending_settlement_json,row.settlement_json,row.resume_json]
    .reduce<number>((n,v)=>n+(v===null?0:Buffer.byteLength(String(v))),0));
  const {proposalDigest,candidateDigest,preparation,nativeSourceManifestDigest,admitted}=admission;
  const lifecycle:RestoreLifecycle={phase:row.phase as RestoreLifecycle["phase"],proposalDigest,candidateDigest,preparation,nativeSourceManifestDigest,admitted,
    application:row.application_json===null?null:parseNativeRestoreApplicationReceipt(JSON.parse(String(row.application_json))),
    settlement:row.settlement_json===null?(row.pending_settlement_json===null?null:parseNativeRestoreSettlementReceipt(JSON.parse(String(row.pending_settlement_json)))):
      parseNativeRestoreSettlementReceipt(JSON.parse(String(row.settlement_json))),
    resume:row.resume_json===null?null:parseNativeRestoreResumeReceipt(JSON.parse(String(row.resume_json)))};
  validateRestoreLifecycle(admission,lifecycle);
  require(row.pending_settlement_json===null || row.settlement_json===null);
  const base=Buffer.byteLength(JSON.stringify([row.relay_database_namespace,row.operation_id,row.workspace_id,row.max_evidence_bytes,row.admission_json,row.admission_sha256]));
  require(authorityInteger(row.accounted_bytes,1)===base+bytes+authorityInteger(row.receipt_reservation_bytes));
  return {admission,lifecycle,row};
}

/**
 * The binding a finished restore left at its new fence: its resume's, or the
 * one its host stopped at when the owner declined it after the fence. Null
 * for any other phase.
 */
export function finishedRestoreBinding(db:SqliteDb,namespace:string,operationId:string,phase:unknown):LiveObjectBinding|null {
  if (phase==="resumed") return retainedRestoreLifecycle(db,namespace,operationId)?.lifecycle.resume?.binding ?? null;
  if (phase!=="declined") return null;
  const row=db.prepare(`SELECT acknowledgment_json FROM ${LIVE_RESTORE_CANCELLATIONS} WHERE relay_database_namespace=? AND operation_id=? AND outcome='fence-cancelled'`)
    .get(namespace,operationId);
  if (!row) return null;
  const answer=parseNativeRestoreCancellationAnswer(JSON.parse(String(row.acknowledgment_json)));
  require(answer.status==="fenceCancelled");
  return answer.binding;
}

/**
 * The binding the history before `binding` was accepted at, or null when it
 * can't be. Restores declined after their fence moved the generation with no
 * accepted event, so each one ending at `binding` steps back to its old
 * binding, and its cutover must be `previous`, the event before.
 */
export function acrossDeclinedRestores(db:SqliteDb,namespace:string,binding:LiveObjectBinding,previous:number):LiveObjectBinding|null {
  let expected=binding;
  for (let declined=restoreDeclinedAt(db,namespace,expected); declined; declined=restoreDeclinedAt(db,namespace,expected)) {
    if (declined.cutover!==previous) return null;
    expected=declined.oldBinding;
  }
  return expected;
}
function restoreDeclinedAt(db:SqliteDb,namespace:string,binding:LiveObjectBinding):{oldBinding:LiveObjectBinding;cutover:number}|null {
  const row=db.prepare(`SELECT o.cutover_cursor,c.acknowledgment_json FROM ${operations} o JOIN ${LIVE_RESTORE_CANCELLATIONS} c USING(relay_database_namespace,operation_id)
    WHERE o.relay_database_namespace=? AND o.workspace_id=? AND o.main_version_id=? AND o.object_id=? AND o.lineage_claim_id=? AND o.new_fence=? AND o.phase='declined' AND c.outcome='fence-cancelled'`)
    .get(namespace,binding.workspaceId,binding.mainVersionId,binding.objectId,binding.lineageClaimId,binding.restoreFenceGeneration);
  if (!row) return null;
  const answer=parseNativeRestoreCancellationAnswer(JSON.parse(String(row.acknowledgment_json)));
  require(answer.status==="fenceCancelled");
  if (!isDeepStrictEqual(answer.binding,binding)) return null;
  const {oldBinding}=answer.receipt.fence.operation;
  require(oldBinding.restoreFenceGeneration===binding.restoreFenceGeneration-1);
  return {oldBinding,cutover:authorityInteger(row.cutover_cursor)};
}

export function requireFinishedRestoreBinding(db:SqliteDb,namespace:string,original:LiveObjectBinding,current:LiveObjectBinding):void {
  require(isDeepStrictEqual({...original,restoreFenceGeneration:current.restoreFenceGeneration},current));
  if (original.restoreFenceGeneration===current.restoreFenceGeneration) return;
  require(original.restoreFenceGeneration<current.restoreFenceGeneration);
  const row=db.prepare(`SELECT operation_id,phase FROM ${operations} WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND new_fence=?`)
    .get(namespace,current.workspaceId,current.mainVersionId,current.objectId,current.restoreFenceGeneration);
  require(row);
  require(isDeepStrictEqual(finishedRestoreBinding(db,namespace,String(row.operation_id),row.phase),current));
  parseLiveObjectBinding(original);
}
