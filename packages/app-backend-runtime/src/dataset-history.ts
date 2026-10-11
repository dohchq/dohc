import { parseApprovalAgent } from "@dohc/security-contract/approval-provenance";
import { parseDatasetRevision, type DatasetRevision } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetScope, JournalDb } from "./journal.js";
import { datasetHistoryUndo } from "./dataset-history-undo.js";

/** Called inside an owner-authorized transaction. No input payloads or grants leave this boundary. */
export function readDatasetHistory(db: JournalDb, scope: DatasetScope, approved: DatasetRevision, before: number, limit: number) {
  const rows = db.prepare(`WITH changes AS (
    SELECT e.revision,e.operation,e.caller_key,e.recorded_at_ms,e.approved_revision_hash,
      length(e.changeset) AS changeset_bytes,json_array_length(e.attached_file_ids) AS attachment_count,
      CASE WHEN length(CAST(e.result_json AS BLOB)) <= 16384 THEN e.result_json END AS undo_receipt,
      NULL AS previous_hash,a.automation_id,a.depth AS automation_depth FROM dohc_dataset_events e
      LEFT JOIN dohc_dataset_automation_revisions a ON a.workspace_id=e.workspace_id AND a.dataset_id=e.dataset_id AND a.revision=e.revision
      WHERE e.workspace_id=? AND e.dataset_id=? AND e.revision<?
    UNION ALL
    SELECT h.revision,'Fields and rules',NULL,t.recorded_at_ms,json_extract(h.cursor_json,'$.approvedRevisionHash'),0,0,NULL,
      json_extract(h.previous_json,'$.approvedRevisionHash'),NULL,NULL FROM dohc_dataset_checkpoint_history h
      LEFT JOIN dohc_dataset_checkpoint_times t ON t.workspace_id=h.workspace_id AND t.dataset_id=h.dataset_id AND t.revision=h.revision
      WHERE h.workspace_id=? AND h.dataset_id=? AND h.revision<? AND h.previous_json IS NOT NULL
        AND json_extract(h.previous_json,'$.approvedRevisionHash') != json_extract(h.cursor_json,'$.approvedRevisionHash')
    UNION ALL
    SELECT j.checkpoint_revision,'Fields and rules',NULL,t.recorded_at_ms,j.approved_revision_hash,0,0,NULL,
      json_extract(j.checkpoint_previous_json,'$.approvedRevisionHash'),NULL,NULL FROM dohc_dataset_journals j
      LEFT JOIN dohc_dataset_checkpoint_times t ON t.workspace_id=j.workspace_id AND t.dataset_id=j.dataset_id AND t.revision=j.checkpoint_revision
      WHERE j.workspace_id=? AND j.dataset_id=? AND j.checkpoint_revision<? AND j.checkpoint_previous_json IS NOT NULL
        AND json_extract(j.checkpoint_previous_json,'$.approvedRevisionHash') != j.approved_revision_hash
  ) SELECT * FROM changes ORDER BY revision DESC LIMIT ?`).all(
    scope.workspaceId, scope.datasetId, before, scope.workspaceId, scope.datasetId, before,
    scope.workspaceId, scope.datasetId, before, limit + 1);
  const entries = [];
  let undoBytes = 0;
  for (const row of rows.slice(0, limit)) {
    const undo = datasetHistoryUndo(approved, String(row.operation), String(row.approved_revision_hash), row.undo_receipt);
    const bytes = undo ? Buffer.byteLength(JSON.stringify(undo)) : 0;
    if (entries.length && undoBytes + bytes > 64 * 1024) break;
    undoBytes += bytes;
    const approval = row.previous_hash === null ? undefined : db.prepare("SELECT agent_json FROM dohc_dataset_approval_provenance WHERE workspace_id=? AND dataset_id=? AND revision=? AND approved_revision_hash=?").get(scope.workspaceId,scope.datasetId,Number(row.revision),String(row.approved_revision_hash));
    entries.push({ ...(approval ? {approvalAgent:parseApprovalAgent(JSON.parse(String(approval.agent_json)))} : {}), revision: Number(row.revision), operation: String(row.operation),
      callerReference: row.caller_key === null ? null : String(row.caller_key),
      recordedAtMs: row.recorded_at_ms === null ? null : Number(row.recorded_at_ms),
      approvedRevisionHash: String(row.approved_revision_hash), changesetBytes: Number(row.changeset_bytes),
      attachmentCount: Number(row.attachment_count), ...(undo ? { undo } : {}),
      // The automation that made the change, as the host recorded it at commit.
      ...(row.automation_id === null ? {} : { automation: { automationId: String(row.automation_id), depth: Number(row.automation_depth) } }),
      ...(row.previous_hash === null ? {} : { schema: { previousRevisionHash: String(row.previous_hash), revisionHash: String(row.approved_revision_hash) } }) });
  }
  return { entries, nextBeforeRevision: rows.length > entries.length ? entries.at(-1)!.revision : null };
}

/** Returns the immutable approved source, never the mutable workspace file at the same path. */
export function readDatasetHistoryRevision(db: JournalDb, scope: DatasetScope, revisionSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(revisionSha256)) throw new Error("Choose a saved Collection revision.");
  const row = db.prepare(`SELECT revision_json,artifacts_json FROM dohc_dataset_catalog
    WHERE workspace_id=? AND dataset_id=? AND json_extract(revision_json,'$.revisionSha256')=?
    UNION ALL SELECT revision_json,artifacts_json FROM dohc_dataset_catalog_history
    WHERE workspace_id=? AND dataset_id=? AND json_extract(revision_json,'$.revisionSha256')=? LIMIT 1`).get(
    scope.workspaceId, scope.datasetId, revisionSha256, scope.workspaceId, scope.datasetId, revisionSha256);
  if (!row) throw new Error("This saved revision is unavailable. Choose another change from History.");
  const revision = parseDatasetRevision(JSON.parse(String(row.revision_json)));
  const { schemaSql, operationSource } = JSON.parse(String(row.artifacts_json));
  verifyDatasetArtifacts({ revision, schemaSql, operationSource });
  if (revision.datasetId !== scope.datasetId || revision.revisionSha256 !== revisionSha256) throw new Error("The saved Collection revision does not match this change.");
  const approval = db.prepare("SELECT agent_json FROM dohc_dataset_approval_provenance WHERE workspace_id=? AND dataset_id=? AND approved_revision_hash=? ORDER BY revision LIMIT 1").get(scope.workspaceId,scope.datasetId,revisionSha256);
  return { revision, schemaSql: String(schemaSql), operationSource: String(operationSource), ...(approval ? {approvalAgent:parseApprovalAgent(JSON.parse(String(approval.agent_json)))} : {}) };
}
