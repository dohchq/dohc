import { parseDatasetRevision, type DatasetRevision } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetScope, JournalDb } from "./journal.js";
import { datasetHistoryUndo } from "./dataset-history-undo.js";

/** Called inside an owner-authorized transaction. No input payloads or grants leave this boundary. */
export function readDatasetHistory(db: JournalDb, scope: DatasetScope, approved: DatasetRevision, before: number, limit: number) {
  const rows = db.prepare(`WITH changes AS (
    SELECT revision,operation,caller_key,recorded_at_ms,approved_revision_hash,
      length(changeset) AS changeset_bytes,json_array_length(attached_file_ids) AS attachment_count,
      CASE WHEN length(CAST(result_json AS BLOB)) <= 16384 THEN result_json END AS undo_receipt,
      NULL AS previous_hash FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=? AND revision<?
    UNION ALL
    SELECT revision,'Fields and rules',NULL,NULL,json_extract(cursor_json,'$.approvedRevisionHash'),0,0,NULL,
      json_extract(previous_json,'$.approvedRevisionHash') FROM dohc_dataset_checkpoint_history
      WHERE workspace_id=? AND dataset_id=? AND revision<? AND previous_json IS NOT NULL
        AND json_extract(previous_json,'$.approvedRevisionHash') != json_extract(cursor_json,'$.approvedRevisionHash')
    UNION ALL
    SELECT checkpoint_revision,'Fields and rules',NULL,NULL,approved_revision_hash,0,0,NULL,
      json_extract(checkpoint_previous_json,'$.approvedRevisionHash') FROM dohc_dataset_journals
      WHERE workspace_id=? AND dataset_id=? AND checkpoint_revision<? AND checkpoint_previous_json IS NOT NULL
        AND json_extract(checkpoint_previous_json,'$.approvedRevisionHash') != approved_revision_hash
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
    entries.push({ revision: Number(row.revision), operation: String(row.operation),
      callerReference: row.caller_key === null ? null : String(row.caller_key),
      recordedAtMs: row.recorded_at_ms === null ? null : Number(row.recorded_at_ms),
      approvedRevisionHash: String(row.approved_revision_hash), changesetBytes: Number(row.changeset_bytes),
      attachmentCount: Number(row.attachment_count), ...(undo ? { undo } : {}),
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
  return { revision, schemaSql: String(schemaSql), operationSource: String(operationSource) };
}
