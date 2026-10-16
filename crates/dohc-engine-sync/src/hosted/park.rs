//! Parking a hosted document that left the scope. The replica keeps
//! everything its return needs to resume live editing: its moments, its
//! Y.Doc, its activation and adoption, its accepted work, restore fences and
//! receipts, and its journal, whose rows the return skips as redelivered.
//! Parking releases only what holds a path here: its heads and path aliases
//! move to the parked tables, which keep their bytes, and its file is
//! recorded as a [retired file](RetiredFile), which holds its path until the
//! file is gone. On its return, its heads come back once nothing holds their
//! paths, the same gate a replayed row meets.

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, ToSql, params};

use super::{DOCUMENT_NAMED_SQL, HostedHold};
use crate::{MomentMaterializationChange, SyncError};

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

/// The hosted documents outside the current scope that have not parked, by
/// object id.
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
               AND d.state<>'parked' \
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

/// The hosted documents outside the current scope that this replica has not
/// finished releasing, by object id: it has not parked, or its retired file
/// remains. A parked document whose file is gone is gone from the host. A
/// file retired before retired files named their document names none.
pub fn departed_hosted_object_ids(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<String>, SyncError> {
    store.read_with(|conn| {
        strings(
            conn,
            "SELECT d.object_id FROM hosted_documents d \
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
             WHERE d.workspace_id=?1 AND d.scope_generation<>h.scope_generation \
               AND d.state<>'parked' \
             UNION SELECT object_id FROM hosted_retired_files \
             WHERE workspace_id=?1 AND object_id IS NOT NULL \
             ORDER BY 1",
            &[&workspace_id],
        )
    })
}

/// Park `object_id`, a hosted document that left the scope. Answers `false`,
/// changing nothing, while it is not [parkable](hosted_document_parkable).
/// The caller first proves that its Y.Doc settled into its head and that its
/// file holds nothing else. Its head in `version_id`, the version the root
/// holds, becomes a retired file for the caller to remove. Work the relay
/// served that it never journaled is released, as a hold releases it; its
/// return fetches that work again.
pub fn park_hosted_document(
    store: &mut EngineStore,
    workspace_id: &str,
    object_id: &str,
    version_id: &str,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<bool>, SyncError> {
    store.write_with(faults, |tx| {
        if !parkable(tx, workspace_id, object_id)? {
            return Ok(false);
        }
        // Removing a head clears the export state its Y.Doc keeps, which a
        // parked document keeps as it was.
        let exports = tx
            .prepare(
                "SELECT version_id,sharing_declined_json,file_export_lane FROM ydoc_docs \
                 WHERE workspace_id=?1 AND object_id=?2",
            )
            .map_err(SyncError::corrupt)?
            .query_map(params![workspace_id, object_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        let bound: [&dyn ToSql; 3] = [&workspace_id, &object_id, &version_id];
        for sql in PARK {
            execute(tx, sql, &bound)?;
        }
        for (version, declined, lane) in exports {
            tx.execute(
                "UPDATE ydoc_docs SET sharing_declined_json=?4,file_export_lane=?5 \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![workspace_id, version, object_id, declined, lane],
            )
            .map_err(SyncError::persist)?;
        }
        crate::deferred::release_hosted_in_tx(tx, workspace_id, object_id)?;
        Ok(true)
    })
}

/// Whether [`park_hosted_document`] would park `object_id` now: it is out of
/// the scope and not parked, the relay has acknowledged every row this
/// replica wrote for it, nothing it accepted is pending (outbox bytes,
/// applied updates past their settlement, or a restore fence), and every
/// activation of it has its adoption. A pending activation can resume only
/// on the state it captured, which a return would change. Deferred updates
/// from the relay do not count: parking keeps them, and the return applies
/// them.
pub fn hosted_document_parkable(
    store: &EngineStore,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, SyncError> {
    store.read_with(|conn| parkable(conn, workspace_id, object_id))
}

/// A file a parked document left in the root: its path, and the digest of
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

/// Forget the retired file at `path` once it is gone. Its path is free again.
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

/// What holds `object_id`, a hosted document whose heads are parked, from
/// them, or `None` for one with none parked: a document of the scope at one
/// of their paths, a departed document or retired file at one, its own
/// included, or, once all are free, the pass that has yet to bring them back.
pub(crate) fn parked_hold(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<HostedHold>, SyncError> {
    let paths = parked_paths(conn, workspace_id, object_id)?;
    if paths.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        paths_hold(conn, workspace_id, object_id, &paths)?.unwrap_or(HostedHold::WorkWaiting),
    ))
}

/// Whether `object_id`'s heads are parked and nothing holds their paths any
/// more, so the next pass brings them back.
pub(crate) fn unparks_next(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, SyncError> {
    let paths = parked_paths(conn, workspace_id, object_id)?;
    Ok(!paths.is_empty() && paths_hold(conn, workspace_id, object_id, &paths)?.is_none())
}

/// Bring back the heads of each document of the scope whose heads are
/// parked, once nothing holds their paths. Answers each path it wrote, for
/// the pass to materialize.
pub(crate) fn unpark_returned(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
) -> Result<Vec<MomentMaterializationChange>, SyncError> {
    // A document still held writes nothing, pass after pass.
    let returned = store.read_with(|conn| {
        let mut returned = Vec::new();
        for object_id in strings(conn, RETURNED, &[&workspace_id])? {
            if unparks_next(conn, workspace_id, &object_id)? {
                returned.push(object_id);
            }
        }
        Ok::<_, SyncError>(returned)
    })?;
    if returned.is_empty() {
        return Ok(Vec::new());
    }
    let policy = crate::file_search::search_policy_for_store(store);
    let outcome = store.write_with(faults, |tx| {
        let mut changes = Vec::new();
        for object_id in &returned {
            if !unparks_next(tx, workspace_id, object_id)? {
                continue;
            }
            let heads = tx
                .prepare(
                    "SELECT p.version_id,p.path,p.content_kind,b.text FROM hosted_parked_snapshots p \
                     LEFT JOIN blobs b ON b.sha256=p.blob_sha256 \
                     WHERE p.workspace_id=?1 AND p.object_id=?2",
                )
                .map_err(SyncError::corrupt)?
                .query_map(params![workspace_id, object_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(SyncError::corrupt)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(SyncError::corrupt)?;
            let bound: [&dyn ToSql; 2] = [&workspace_id, object_id];
            for sql in UNPARK {
                execute(tx, sql, &bound)?;
            }
            for (version_id, path, kind, text) in heads {
                let binary = kind == "binary";
                crate::file_search::upsert_file_search_index(
                    tx,
                    workspace_id,
                    &version_id,
                    object_id,
                    &path,
                    text.as_deref().filter(|_| !binary),
                    policy.as_ref(),
                )?;
                changes.push(MomentMaterializationChange {
                    version_id,
                    path,
                    operation: "write",
                    content_kind: if binary { "binary" } else { "text" },
                });
            }
        }
        Ok::<_, SyncError>(changes)
    })?;
    match outcome {
        TxnOutcome::Committed(changes) => Ok(changes),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

/// Each version and path `object_id` parked a head or path alias at.
fn parked_paths(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Vec<(String, String)>, SyncError> {
    conn.prepare_cached(
        "SELECT version_id,path FROM hosted_parked_snapshots WHERE workspace_id=?1 AND object_id=?2 \
         UNION SELECT version_id,path FROM hosted_parked_path_aliases \
         WHERE workspace_id=?1 AND object_id=?2",
    )
    .map_err(SyncError::corrupt)?
    .query_map(params![workspace_id, object_id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })
    .map_err(SyncError::corrupt)?
    .collect::<Result<_, _>>()
    .map_err(SyncError::corrupt)
}

/// What holds one of `paths` here against `object_id`: another document's
/// head or path alias, matched like a capture hold, which names a document of
/// the scope as holding it, or a retired file.
fn paths_hold(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
    paths: &[(String, String)],
) -> Result<Option<HostedHold>, SyncError> {
    use dohc_engine_storage::capture_file_holds::path_is_held;
    let collides = |held: &str, path: &str| path_is_held(held, path) || path_is_held(path, held);
    let mut departed = false;
    for (version_id, path) in paths {
        let mut statement = conn
            .prepare_cached(
                "SELECT o.object_id,o.path,EXISTS(SELECT 1 FROM hosted_documents d \
                   JOIN hosted_replicas h \
                     ON h.workspace_id=d.workspace_id AND h.scope_generation=d.scope_generation \
                   WHERE d.workspace_id=?1 AND d.object_id=o.object_id) \
                 FROM (SELECT object_id,path FROM snapshots \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id<>?3 \
                   UNION SELECT object_id,path FROM path_aliases \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id<>?3) o",
            )
            .map_err(SyncError::corrupt)?;
        let occupants = statement
            .query_map(params![workspace_id, version_id, object_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })
            .map_err(SyncError::corrupt)?;
        for occupant in occupants {
            let (held_by, held, in_scope) = occupant.map_err(SyncError::corrupt)?;
            if !collides(&held, path) {
                continue;
            }
            if in_scope {
                return Ok(Some(HostedHold::PathHeld {
                    path: path.clone(),
                    held_by,
                }));
            }
            departed = true;
        }
        departed |= strings(
            conn,
            "SELECT path FROM hosted_retired_files WHERE workspace_id=?1",
            &[&workspace_id],
        )?
        .iter()
        .any(|held| collides(held, path));
    }
    Ok(departed.then_some(HostedHold::WorkWaiting))
}

fn parkable(conn: &Connection, workspace_id: &str, object_id: &str) -> Result<bool, SyncError> {
    let quiet: bool = conn
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM hosted_documents d \
                   JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
                   WHERE d.workspace_id=?1 AND d.object_id=?2 \
                     AND d.scope_generation<>h.scope_generation AND d.state<>'parked') \
                 AND NOT EXISTS(SELECT 1 FROM replication_log \
                   JOIN sync_identity USING (workspace_id,origin_id) \
                   WHERE workspace_id=?1 AND {DOCUMENT_NAMED_SQL}=?2 \
                     AND origin_seq>COALESCE((SELECT p.pushed_seq FROM sync_relay_push_state p \
                       WHERE p.workspace_id=?1 AND p.origin_id=sync_identity.origin_id),-1)) \
                 AND NOT EXISTS(SELECT 1 FROM live_audit_pending_exports \
                   WHERE workspace_id=?1 AND object_id=?2) \
                 AND NOT EXISTS(SELECT 1 FROM ydoc_owner_activation_sources a \
                   WHERE a.workspace_id=?1 AND a.object_id=?2 \
                     AND NOT EXISTS(SELECT 1 FROM live_owner_adoptions o \
                       WHERE o.workspace_id=a.workspace_id AND o.main_version_id=a.version_id \
                         AND o.object_id=a.object_id AND o.lineage_claim_id=a.lineage_claim_id \
                         AND o.relay_database_namespace=a.relay_database_namespace))"
            ),
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(quiet
        && dohc_engine_collab::live_update_application::park_pending(conn, workspace_id, object_id)
            .map_err(SyncError::corrupt)?
            .is_none())
}

/// A head's columns, as `snapshots` and `hosted_parked_snapshots` both hold them.
macro_rules! head_columns {
    () => {
        "workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,\
         metadata_origin,content_kind,binary_sha256,metadata_summary,metadata_correlation_id"
    };
}

/// What parking writes, in order. `?1` is the workspace, `?2` the document,
/// and `?3` the version the root holds.
const PARK: [&str; 9] = [
    "INSERT INTO hosted_retired_files (workspace_id,path,object_id,sha256) \
     SELECT workspace_id,path,object_id,COALESCE(blob_sha256,binary_sha256) FROM snapshots \
     WHERE workspace_id=?1 AND object_id=?2 AND version_id=?3",
    concat!(
        "INSERT INTO hosted_parked_snapshots (",
        head_columns!(),
        ") SELECT ",
        head_columns!(),
        " FROM snapshots WHERE workspace_id=?1 AND object_id=?2"
    ),
    "INSERT INTO hosted_parked_path_aliases (workspace_id,version_id,path,object_id) \
     SELECT workspace_id,version_id,path,object_id FROM path_aliases \
     WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM path_aliases WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM snapshots WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM engine_search_files_fts WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM capture_file_holds WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM share_direct_write_marks WHERE workspace_id=?1 AND object_id=?2",
    "UPDATE hosted_documents SET state='parked',held_reason=NULL,held_path=NULL,held_by=NULL, \
     held_conflict_id=NULL WHERE workspace_id=?1 AND object_id=?2",
];

/// The documents of the scope whose heads are parked. `?1` is the workspace.
const RETURNED: &str = "SELECT p.object_id FROM \
      (SELECT workspace_id,object_id FROM hosted_parked_snapshots \
       UNION SELECT workspace_id,object_id FROM hosted_parked_path_aliases) p \
    JOIN hosted_documents d USING (workspace_id,object_id) \
    JOIN hosted_replicas h \
      ON h.workspace_id=d.workspace_id AND h.scope_generation=d.scope_generation \
    WHERE p.workspace_id=?1 ORDER BY 1";

/// What bringing a document's heads back writes, in order. `?1` is the
/// workspace and `?2` the document.
const UNPARK: [&str; 4] = [
    concat!(
        "INSERT INTO snapshots (",
        head_columns!(),
        ") SELECT ",
        head_columns!(),
        " FROM hosted_parked_snapshots WHERE workspace_id=?1 AND object_id=?2"
    ),
    "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
     SELECT workspace_id,version_id,path,object_id FROM hosted_parked_path_aliases \
     WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM hosted_parked_path_aliases WHERE workspace_id=?1 AND object_id=?2",
    "DELETE FROM hosted_parked_snapshots WHERE workspace_id=?1 AND object_id=?2",
];

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
