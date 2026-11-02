use crate::{DomainError, TextConflict};
use rusqlite::{Transaction, params};

pub(crate) fn refuse_synced_deletion_revival(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    choice: Option<&TextConflict>,
) -> Result<(), DomainError> {
    if choice.is_some_and(|conflict| conflict.metadata.origin != "sync") {
        return Ok(());
    }
    if choice.is_some_and(|conflict| {
        !conflict.current.is_present()
            && conflict
                .incoming
                .snapshot
                .as_ref()
                .is_some_and(|s| s.object_id == object_id)
    }) {
        return Err(DomainError::SyncedDeletionRevivalRefused);
    }
    let guarded: bool = tx
        .query_row(
            "SELECT EXISTS (
           SELECT 1 FROM conflicts
           WHERE workspace_id=?1 AND target_version_id=?2 AND metadata_origin='sync'
           AND ((status='resolved' AND (
             (chosen_from='current' AND current_exists=0 AND incoming_exists=1
               AND incoming_content_kind='text' AND incoming_object_id=?3) OR
             (chosen_from='incoming' AND incoming_exists=0 AND current_exists=1
               AND current_content_kind='text' AND current_object_id=?3))) OR
             (status='open' AND current_exists=0 AND incoming_exists=0
               AND base_exists=1 AND base_content_kind='text' AND base_object_id=?3))
         )",
            params![workspace_id, version_id, object_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    if guarded {
        return Err(DomainError::SyncedDeletionRevivalRefused);
    }
    let guarded: bool = tx.query_row(
        "SELECT EXISTS (
           WITH parents(payload) AS (
             SELECT payload_json FROM replication_log
               WHERE workspace_id=?1 AND op_kind='conflict.resolve' AND apply_disposition='applied'
             UNION ALL
             SELECT payload_json FROM replication_pending_conflict_ops ops
               JOIN replication_pending_conflict_bundles bundles USING (bundle_order)
               WHERE bundles.workspace_id=?1 AND ops.op_kind='conflict.resolve'
           ), sides AS (
             SELECT json_extract(payload,'$.chosenFrom') AS chosen,
               json_extract(payload,'$.transition.current') AS current_side,
               json_extract(payload,'$.transition.incoming') AS incoming_side
             FROM parents WHERE json_extract(payload,'$.formatVersion')=1
               AND json_extract(payload,'$.workspaceId')=?1
               AND json_extract(payload,'$.targetVersionId')=?2
               AND json_extract(payload,'$.status')='resolved'
               AND NOT EXISTS (SELECT 1 FROM conflicts c WHERE c.workspace_id=?1
                 AND c.conflict_id=json_extract(payload,'$.conflictId') AND c.metadata_origin!='sync')
           )
           SELECT 1 FROM sides WHERE
             (chosen='current' AND json_extract(current_side,'$.present')=0
               AND json_extract(incoming_side,'$.present')=1
               AND json_extract(incoming_side,'$.contentKind')='text'
               AND json_extract(incoming_side,'$.objectId')=?3) OR
             (chosen='incoming' AND json_extract(incoming_side,'$.present')=0
               AND json_extract(current_side,'$.present')=1
               AND json_extract(current_side,'$.contentKind')='text'
               AND json_extract(current_side,'$.objectId')=?3)
         )",
        params![workspace_id, version_id, object_id], |row| row.get(0),
    ).map_err(DomainError::sql_corrupt)?;
    if guarded {
        Err(DomainError::SyncedDeletionRevivalRefused)
    } else {
        Ok(())
    }
}
