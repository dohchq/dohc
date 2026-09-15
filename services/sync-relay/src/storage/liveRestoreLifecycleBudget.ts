import type {SqliteDb} from "./types";
import {authorityInteger} from "./liveDocumentAuthority";
import {restoreIntegrity} from "./liveRestoreCheckpoint";
import {LIVE_RESTORE_LIFECYCLES,LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";
import {LIVE_JOURNAL_TABLE} from "./schema";

// Charge retained payloads once, including space already promised to later ACKs.
// Length queries stay cheap even when the journal checkpoint is several MiB.
export function requireRestoreLifecycleBudget(db:SqliteDb,namespace:string,operationId:string,workspaceId:string,maxBytes:number):void {
  const row=db.prepare(`SELECT l.max_evidence_bytes,
    length(CAST(o.intent_json AS BLOB))+length(CAST(o.basis_json AS BLOB))+
    COALESCE(length(CAST(o.terminal_json AS BLOB)),0)+COALESCE(length(CAST(o.applied_json AS BLOB)),0)+COALESCE(length(CAST(o.native_receipt_json AS BLOB)),0)+
    COALESCE(length(j.update_bytes),0)+COALESCE(length(j.validation_checkpoint_bytes),0)+COALESCE(j.accepted_metadata_bytes,0)+
    COALESCE(length(CAST(l.admission_json AS BLOB)),0)+COALESCE(length(CAST(l.application_json AS BLOB)),0)+
    COALESCE(length(CAST(l.pending_settlement_json AS BLOB)),0)+COALESCE(length(CAST(l.settlement_json AS BLOB)),0)+
    COALESCE(length(CAST(l.resume_json AS BLOB)),0)+COALESCE(l.receipt_reservation_bytes,0) AS bytes
    FROM ${LIVE_RESTORE_OPERATIONS} o LEFT JOIN ${LIVE_RESTORE_LIFECYCLES} l USING(relay_database_namespace,operation_id)
    LEFT JOIN ${LIVE_JOURNAL_TABLE} j ON j.relay_database_namespace=o.relay_database_namespace AND j.restore_operation_id=o.operation_id
    WHERE o.relay_database_namespace=? AND o.operation_id=? AND o.workspace_id=?`).get(namespace,operationId,workspaceId);
  restoreIntegrity(row);
  const limit=Math.min(authorityInteger(maxBytes,1),row.max_evidence_bytes===null?maxBytes:authorityInteger(row.max_evidence_bytes,1));
  restoreIntegrity(authorityInteger(row.bytes,1)<=limit);
}
