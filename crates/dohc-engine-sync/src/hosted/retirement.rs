//! Retiring a hosted document that left the scope. Everything this replica
//! holds for it goes in one transaction, so a return backfills it from the
//! start like a document that never was here. The same transaction records
//! its file as a [retired file](RetiredFile), which holds its path until the
//! file is gone. The host's copies are derived: the relay and the owner's
//! devices keep the authoritative history and provenance.

use std::collections::BTreeSet;

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, ToSql, Transaction, params};

use super::DOCUMENT_NAMED_SQL;
use crate::SyncError;

/// A hosted document outside the current scope that still holds state here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepartedDocument {
    pub object_id: String,
    /// Its head in each version.
    pub heads: Vec<DepartedHead>,
    /// The versions holding a Y.Doc lineage of it.
    pub ydoc_versions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepartedHead {
    pub version_id: String,
    pub path: String,
    /// The digest of the head's bytes, as its file holds them.
    pub sha256: String,
}

/// The hosted documents outside the current scope, by object id.
pub fn departed_hosted_documents(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<DepartedDocument>, SyncError> {
    store.read_with(|conn| {
        let object_ids = strings(
            conn,
            "SELECT d.object_id FROM hosted_documents d \
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
             WHERE d.workspace_id=?1 AND d.scope_generation<>h.scope_generation \
             ORDER BY d.object_id",
            &[&workspace_id],
        )?;
        object_ids
            .into_iter()
            .map(|object_id| {
                let heads = conn
                    .prepare(
                        "SELECT version_id,path,COALESCE(blob_sha256,binary_sha256) FROM snapshots \
                         WHERE workspace_id=?1 AND object_id=?2 ORDER BY version_id",
                    )
                    .map_err(SyncError::corrupt)?
                    .query_map(params![workspace_id, object_id], |row| {
                        Ok(DepartedHead {
                            version_id: row.get(0)?,
                            path: row.get(1)?,
                            sha256: row.get(2)?,
                        })
                    })
                    .map_err(SyncError::corrupt)?
                    .collect::<Result<_, _>>()
                    .map_err(SyncError::corrupt)?;
                let ydoc_versions = strings(
                    conn,
                    "SELECT version_id FROM ydoc_docs WHERE workspace_id=?1 AND object_id=?2 \
                     ORDER BY version_id",
                    &[&workspace_id, &object_id],
                )?;
                Ok(DepartedDocument {
                    object_id,
                    heads,
                    ydoc_versions,
                })
            })
            .collect()
    })
}

/// Retire `object_id`, a hosted document that left the scope. Answers
/// `false`, removing nothing, while it is not
/// [retirable](hosted_document_retirable). The caller first proves that its
/// Y.Doc settled into its head and that its file holds nothing else. Its head
/// in `version_id`, the version the root holds, becomes a retired file for
/// the caller to remove.
pub fn retire_hosted_document(
    store: &mut EngineStore,
    workspace_id: &str,
    object_id: &str,
    version_id: &str,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<bool>, SyncError> {
    store.write_with(faults, |tx| {
        if !retirable(tx, workspace_id, object_id)? {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO hosted_retired_files (workspace_id,path,sha256) \
             SELECT workspace_id,path,COALESCE(blob_sha256,binary_sha256) FROM snapshots \
             WHERE workspace_id=?1 AND object_id=?2 AND version_id=?3",
            params![workspace_id, object_id, version_id],
        )
        .map_err(SyncError::persist)?;
        let journal = tx
            .prepare(&format!(
                "SELECT origin_id,origin_seq FROM replication_log \
                 WHERE workspace_id=?1 AND {DOCUMENT_NAMED_SQL}=?2"
            ))
            .map_err(SyncError::corrupt)?
            .query_map(params![workspace_id, object_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        let coordinates = serde_json::to_string(&journal).map_err(SyncError::corrupt)?;
        let bound: [&dyn ToSql; 3] = [&workspace_id, &object_id, &coordinates];

        let manifests = strings(
            tx,
            &format!(
                "SELECT record_digest FROM live_audit_events WHERE {OBJECT} \
                 UNION SELECT record_digest FROM live_audit_event_conflicts WHERE {JOURNAL}"
            ),
            &bound,
        )?;
        for (origin_id, origin_seq) in &journal {
            for request_id in [
                crate::moment_apply::materialization_decision_id_at(
                    workspace_id,
                    origin_id,
                    *origin_seq,
                ),
                crate::ydoc_apply::ydoc_conflict_coordinate_id(workspace_id, origin_id, *origin_seq),
            ] {
                tx.execute(
                    "DELETE FROM engine_requests WHERE request_id=?1",
                    [request_id],
                )
                .map_err(SyncError::persist)?;
            }
        }
        tx.execute(
            "DELETE FROM engine_requests WHERE request_id IN \
             (SELECT 'sync-ydoc-provisional-author:'||json_array(workspace_id,version_id,?2) \
              FROM versions WHERE workspace_id=?1)",
            params![workspace_id, object_id],
        )
        .map_err(SyncError::persist)?;
        // A restore and the settlement that resumed it name each other.
        for unlink in [
            "UPDATE live_device_settlements SET settlement_kind='ordinary',restore_operation_id=NULL \
             WHERE workspace_id=?1 AND object_id=?2 AND restore_operation_id IS NOT NULL",
            "UPDATE live_restore_fences SET previous_operation_id=NULL \
             WHERE workspace_id=?1 AND object_id=?2 AND previous_operation_id IS NOT NULL",
        ] {
            tx.execute(unlink, params![workspace_id, object_id])
                .map_err(SyncError::persist)?;
        }

        let mut blobs = BTreeSet::new();
        for (table, rows) in retired_rows() {
            let referenced = strings(
                tx,
                "SELECT \"from\" FROM pragma_foreign_key_list(?1) \
                 WHERE \"table\" IN ('blobs','binary_blobs')",
                &[&table],
            )?;
            for column in referenced {
                blobs.extend(strings(
                    tx,
                    &format!("SELECT {column} FROM {table} WHERE ({rows}) AND {column} IS NOT NULL"),
                    &bound,
                )?);
            }
            execute(tx, &format!("DELETE FROM {table} WHERE {rows}"), &bound)?;
        }
        for digest in manifests {
            let referenced: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM live_audit_events WHERE record_digest=?1) \
                     OR EXISTS(SELECT 1 FROM live_audit_event_conflicts WHERE record_digest=?1)",
                    [&digest],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            if referenced {
                continue;
            }
            blobs.extend(strings(
                tx,
                "SELECT chunk_sha256 FROM live_audit_record_chunks WHERE record_digest=?1 \
                 UNION SELECT update_sha256 FROM live_audit_record_manifests WHERE record_digest=?1",
                &[&digest],
            )?);
            for table in ["live_audit_record_chunks", "live_audit_record_manifests"] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE record_digest=?1"),
                    [&digest],
                )
                .map_err(SyncError::persist)?;
            }
        }
        for sha256 in blobs {
            release_blob(tx, &sha256)?;
        }
        Ok(true)
    })
}

/// Whether [`retire_hosted_document`] would retire `object_id` now: it is
/// out of the scope, the relay has acknowledged every row this replica wrote
/// for it, and nothing of its live state is pending.
pub fn hosted_document_retirable(
    store: &EngineStore,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, SyncError> {
    store.read_with(|conn| retirable(conn, workspace_id, object_id))
}

/// A file a retired document left in the root: its path, and the digest of
/// the head it held. No moment takes the path until the file is forgotten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredFile {
    pub path: String,
    pub sha256: String,
}

/// The retired files still to remove, by path.
pub fn retired_hosted_files(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<RetiredFile>, SyncError> {
    store.read_with(|conn| {
        conn.prepare(
            "SELECT path,sha256 FROM hosted_retired_files WHERE workspace_id=?1 ORDER BY path",
        )
        .map_err(SyncError::corrupt)?
        .query_map([workspace_id], |row| {
            Ok(RetiredFile {
                path: row.get(0)?,
                sha256: row.get(1)?,
            })
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<_, _>>()
        .map_err(SyncError::corrupt)
    })
}

/// Forget the retired file at `path` once it is gone, or is left alone
/// because it holds something else. Its path is free again.
pub fn forget_retired_hosted_file(
    store: &mut EngineStore,
    workspace_id: &str,
    path: &str,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    store.write_with(faults, |tx| {
        tx.execute(
            "DELETE FROM hosted_retired_files WHERE workspace_id=?1 AND path=?2",
            params![workspace_id, path],
        )
        .map_err(SyncError::persist)?;
        Ok(())
    })
}

fn retirable(conn: &Connection, workspace_id: &str, object_id: &str) -> Result<bool, SyncError> {
    let quiet: bool = conn
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM hosted_documents d \
                   JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
                   WHERE d.workspace_id=?1 AND d.object_id=?2 \
                     AND d.scope_generation<>h.scope_generation) \
                 AND NOT EXISTS(SELECT 1 FROM replication_log \
                   JOIN sync_identity USING (workspace_id,origin_id) \
                   WHERE workspace_id=?1 AND {DOCUMENT_NAMED_SQL}=?2 \
                     AND origin_seq>COALESCE((SELECT p.pushed_seq FROM sync_relay_push_state p \
                       WHERE p.workspace_id=?1 AND p.origin_id=sync_identity.origin_id),-1)) \
                 AND NOT EXISTS(SELECT 1 FROM live_audit_pending_exports \
                   WHERE workspace_id=?1 AND object_id=?2)"
            ),
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(quiet
        && dohc_engine_collab::live_update_application::unload_pending(
            conn,
            workspace_id,
            object_id,
        )
        .map_err(SyncError::corrupt)?
        .is_none())
}

/// `?1` is the workspace, `?2` the document.
const OBJECT: &str = "workspace_id=?1 AND object_id=?2";
/// The document's journal rows; `?3` holds their coordinates.
const JOURNAL: &str = "workspace_id=?1 AND (origin_id,origin_seq) IN \
    (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?3))";

/// The document's rows in each table, in the order retirement deletes them:
/// a row goes before every row it references, and a table's rows go before
/// the rows that select them.
fn retired_rows() -> Vec<(&'static str, String)> {
    let moments = "SELECT moment_id FROM moments WHERE workspace_id=?1 AND object_id=?2";
    let records = "SELECT version_id,record_id FROM collection_records \
                   WHERE workspace_id=?1 AND object_id=?2";
    // A conflict that also names another document hosted here is that
    // document's to resolve, so it stays, with the blobs its sides reference.
    // The last of its documents to retire takes it.
    let conflicts = "SELECT conflict_id FROM conflicts c WHERE c.workspace_id=?1 \
                     AND ?2 IN (c.base_object_id,c.current_object_id,c.incoming_object_id) \
                     AND NOT EXISTS(SELECT 1 FROM hosted_documents d \
                       WHERE d.workspace_id=?1 AND d.object_id<>?2 AND d.object_id IN \
                         (c.base_object_id,c.current_object_id,c.incoming_object_id))";
    let bundles = format!(
        "bundle_order IN (SELECT bundle_order FROM replication_pending_conflict_bundles \
         WHERE workspace_id=?1 AND conflict_id IN ({conflicts}))"
    );
    let retained = "workspace_id=?1 AND (origin_id,origin_seq) IN \
                    (SELECT origin_id,origin_seq FROM hosted_deferred_ops \
                     WHERE workspace_id=?1 AND object_id=?2)";
    let object = |table| (table, OBJECT.to_owned());
    let journal = |table| (table, JOURNAL.to_owned());
    vec![
        object("live_audit_event_publications"),
        journal("live_audit_event_conflicts"),
        object("live_audit_events"),
        object("live_audit_base_publications"),
        journal("live_audit_base_conflicts"),
        object("live_audit_bases"),
        object("live_audit_settlement_publications"),
        journal("live_audit_settlement_conflicts"),
        (
            "live_audit_settlements",
            "workspace_id=?1 AND json_extract(record_json,'$.binding.objectId')=?2".to_owned(),
        ),
        object("live_audit_projection_authors"),
        journal("live_audit_projection_contributions"),
        object("live_audit_pending_exports"),
        journal("live_settlement_publication_admissions"),
        (
            "live_settlement_attribution_unavailable",
            format!("workspace_id=?1 AND moment_id IN ({moments})"),
        ),
        (
            "owner_pending_settlement_blobs",
            "workspace_id=?1 AND (origin_id,origin_seq) IN (SELECT origin_id,origin_seq \
             FROM owner_pending_settlements WHERE workspace_id=?1 AND object_id=?2)"
                .to_owned(),
        ),
        object("owner_pending_settlements"),
        object("live_accepted_checkpoints"),
        object("live_accepted_updates"),
        object("live_restore_fences"),
        (
            "live_settlement_publication_states",
            "settlement_id IN (SELECT settlement_id FROM live_device_settlements \
             WHERE workspace_id=?1 AND object_id=?2)"
                .to_owned(),
        ),
        object("live_device_settlements"),
        (
            "live_device_application_first_seen",
            "workspace_id=?1 AND (relay_database_namespace,delivery_id) IN \
             (SELECT relay_database_namespace,delivery_id FROM live_device_update_applications \
              WHERE workspace_id=?1 AND object_id=?2)"
                .to_owned(),
        ),
        object("live_device_update_applications"),
        object("live_device_application_bindings"),
        object("live_device_bootstraps"),
        object("live_owner_adoptions"),
        (
            "owner_ydoc_outbox_entries",
            "outbox_id IN (SELECT outbox_id FROM owner_ydoc_outboxes \
             WHERE workspace_id=?1 AND object_id=?2)"
                .to_owned(),
        ),
        object("owner_ydoc_outboxes"),
        object("ydoc_owner_applied_frames"),
        object("ydoc_owner_bindings"),
        object("ydoc_owner_activation_sources"),
        object("ydoc_recovery_decisions"),
        object("ydoc_inactive_lineages"),
        object("ydoc_pending_artifacts"),
        object("ydoc_owner_base_sources"),
        object("ydoc_snapshots"),
        object("ydoc_updates"),
        object("ydoc_deferred_updates"),
        object("ydoc_base_relay_candidates"),
        object("ydoc_docs"),
        ("replication_pending_conflict_text_blobs", bundles.clone()),
        ("replication_pending_conflict_binary_blobs", bundles),
        (
            "replication_pending_conflict_bundles",
            format!("workspace_id=?1 AND conflict_id IN ({conflicts})"),
        ),
        (
            "conflicts",
            format!("workspace_id=?1 AND conflict_id IN ({conflicts})"),
        ),
        (
            "scene_asset_delete_authorities",
            "workspace_id=?1 AND drawing_object_id=?2".to_owned(),
        ),
        (
            "collection_record_fields",
            format!("workspace_id=?1 AND (version_id,record_id) IN ({records})"),
        ),
        (
            "collection_relation_edges",
            format!("workspace_id=?1 AND (version_id,source_record_id) IN ({records})"),
        ),
        (
            "collection_field_history",
            format!("workspace_id=?1 AND (version_id,record_id) IN ({records})"),
        ),
        (
            "automation_claims",
            format!(
                "workspace_id=?1 AND (record_id IN (SELECT record_id FROM collection_records \
                   WHERE workspace_id=?1 AND object_id=?2) \
                 OR trigger_moment_order IN (SELECT moment_order FROM moments \
                   WHERE workspace_id=?1 AND object_id=?2) \
                 OR (trigger_origin_id,trigger_origin_seq) IN (SELECT json_extract(value,'$[0]'), \
                   json_extract(value,'$[1]') FROM json_each(?3)))"
            ),
        ),
        object("collection_records"),
        object("collection_historical_record_owners"),
        (
            "merged_moments",
            "workspace_id=?1 AND moment_order IN (SELECT moment_order FROM moments \
             WHERE workspace_id=?1 AND object_id=?2)"
                .to_owned(),
        ),
        (
            "hosted_withheld_befores",
            format!("workspace_id=?1 AND moment_id IN ({moments})"),
        ),
        object("engine_search_files_fts"),
        object("share_direct_write_marks"),
        object("path_aliases"),
        object("fork_base_snapshots"),
        object("snapshots"),
        object("moments"),
        ("relay_deferred_blobs", retained.to_owned()),
        ("relay_deferred_ops", retained.to_owned()),
        object("hosted_deferred_ops"),
        journal("replication_refused_moment_blobs"),
        journal("replication_refused_ydoc_blobs"),
        journal("replication_pending_refusals"),
        journal("replication_log"),
        object("file_objects"),
        object("hosted_documents"),
    ]
}

/// Delete a blob no remaining row needs. A row that still references it
/// keeps it: its delete fails a foreign key, or the materialization trigger.
fn release_blob(tx: &Transaction<'_>, sha256: &str) -> Result<(), SyncError> {
    let seeds: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_docs \
             WHERE last_settled_sha=?1 OR seed_source_sha256=?1)",
            [sha256],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if seeds {
        return Ok(());
    }
    for table in ["blobs", "binary_blobs"] {
        match tx.execute(&format!("DELETE FROM {table} WHERE sha256=?1"), [sha256]) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(error, message))
                if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
                    || (error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
                        && matches!(
                            message.as_deref(),
                            Some(
                                "FOREIGN KEY constraint failed"
                                    | "referenced materialization content"
                            )
                        )) => {}
            Err(error) => return Err(SyncError::persist(error)),
        }
    }
    Ok(())
}

fn strings(conn: &Connection, sql: &str, bound: &[&dyn ToSql]) -> Result<Vec<String>, SyncError> {
    let mut statement = conn.prepare(sql).map_err(SyncError::corrupt)?;
    let count = statement.parameter_count();
    statement
        .query_map(&bound[..count], |row| row.get(0))
        .map_err(SyncError::corrupt)?
        .collect::<Result<_, _>>()
        .map_err(SyncError::corrupt)
}

fn execute(conn: &Connection, sql: &str, bound: &[&dyn ToSql]) -> Result<(), SyncError> {
    let mut statement = conn.prepare(sql).map_err(SyncError::persist)?;
    let count = statement.parameter_count();
    statement
        .execute(&bound[..count])
        .map_err(SyncError::persist)?;
    Ok(())
}
