//! A hosted replica: the session host's store for the documents the relay's
//! scoped feed serves it. The feed serves each hosted document's rows with
//! their original coordinates and withholds every other row, so one origin's
//! sequence reaches this store with gaps, and a document that joins the scope
//! backfills below coordinates already applied. Its journal is therefore the
//! ledger of what applied; the contiguous origin ack never moves.
//!
//! The `hosted_replicas` row selects this mode. Nothing infers it.
//!
//! Its fetch position lives here too, never in `sync_relay_cursors`: one main
//! cursor, frozen while any document backfills, and one backfill cursor per
//! document. A document is in scope while its row carries the replica's scope
//! generation; one that left keeps its state for removal.

use std::collections::BTreeMap;

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{ReplicationEnvelope, SyncError};

/// The origin prefix the relay reserves for a service host's writes.
pub const SERVICE_HOST_ORIGIN_PREFIX: &str = "service-host:";

/// A conflict child whose `conflict.resolve` parent the feed withheld. The
/// child waits in deferred work until the relay serves what it needs.
pub(crate) const CONFLICT_PARENT_WITHHELD: &str = "hosted-conflict-parent-withheld";

pub(crate) fn is_hosted(conn: &Connection, workspace_id: &str) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM hosted_replicas WHERE workspace_id=?1)",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// The next sequence a hosted replica writes under its own origin, or `None`
/// for any other replica. The count lives in the replica's row because the
/// relay never forgets a coordinate, while this store's journal rows can go.
///
/// A hosted replica writes only what a session host does for a document it
/// hosts: live `ydoc.update`, settlement `moment.append` and `live.audit.*`.
/// The relay refuses anything else from a host, so it is refused here, before
/// it commits a coordinate nothing could push.
pub(crate) fn allocate_outbound_seq_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload_json: &str,
) -> Result<Option<i64>, SyncError> {
    let last: Option<i64> = tx
        .query_row(
            "SELECT last_outbound_seq FROM hosted_replicas WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(last) = last else { return Ok(None) };
    let payload = serde_json::from_str(payload_json).map_err(|_| SyncError::InvalidInput {
        reason: "payload is not valid JSON",
    })?;
    let hosted = match document_named(op_kind, &payload) {
        Some(object_id) => tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM hosted_documents \
                 WHERE workspace_id=?1 AND object_id=?2)",
                params![workspace_id, object_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?,
        None => false,
    };
    if !hosted {
        return Err(SyncError::InvalidInput {
            reason: dohc_engine_domain::HOSTED_REPLICA_WRITE_REFUSED,
        });
    }
    if !(-1..crate::MAX_WIRE_INTEGER).contains(&last) {
        return Err(SyncError::CoordinateDiverged);
    }
    let next = last + 1;
    tx.execute(
        "UPDATE hosted_replicas SET last_outbound_seq=?2 WHERE workspace_id=?1",
        rusqlite::params![workspace_id, next],
    )
    .map_err(SyncError::persist)?;
    Ok(Some(next))
}

/// The hosted document an op names, read where each kind states it, as the
/// relay's scoped feed reads it. `None` for an op that names no document.
pub(crate) fn hosted_document(op: &ReplicationEnvelope) -> Option<&str> {
    document_named(&op.op_kind, &op.payload)
}

fn document_named<'a>(op_kind: &str, payload: &'a serde_json::Value) -> Option<&'a str> {
    match op_kind {
        "moment.append" | "ydoc.update" | "live.audit.application" => &payload["objectId"],
        "live.audit.settlement" => &payload["record"]["binding"]["objectId"],
        "live.audit.base" => &payload["record"]["checkpoint"]["binding"]["objectId"],
        _ => return None,
    }
    .as_str()
}

/// The before side of a hosted moment that replaced an object the feed
/// withholds, as the moment's row states it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WithheldBefore {
    pub(crate) object_id: String,
    pub(crate) path: String,
    pub(crate) sha256: String,
    pub(crate) content_kind: crate::moment_apply::ContentKind,
}

/// The before side of `op` this replica can never hold, or `None`.
///
/// The feed serves a moment whose before side names another object with its
/// after blob alone, and serves no row of an object outside the scope. So on
/// a hosted replica, a `moment.append` that replaced an object outside the
/// current scope replaced content this replica never sees: that object never
/// existed here. Both facts come from the row and the stored scope.
pub(crate) fn withheld_before(
    conn: &Connection,
    op: &ReplicationEnvelope,
) -> Result<Option<WithheldBefore>, SyncError> {
    let payload = &op.payload;
    let field = |name: &str| payload.get(name).and_then(serde_json::Value::as_str);
    let Some(before_object_id) = field("beforeObjectId") else {
        return Ok(None);
    };
    if op.op_kind != "moment.append"
        || field("beforePresent") != Some("present")
        || field("objectId") == Some(before_object_id)
    {
        return Ok(None);
    }
    let in_scope: Option<bool> = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM hosted_documents d WHERE d.workspace_id=h.workspace_id \
               AND d.object_id=?2 AND d.scope_generation=h.scope_generation) \
             FROM hosted_replicas h WHERE h.workspace_id=?1",
            params![op.workspace_id, before_object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if in_scope != Some(false) {
        return Ok(None);
    }
    let (Some(path), Some(sha256)) = (field("beforePath"), field("beforeBlobSha256")) else {
        return Err(SyncError::InvalidInput {
            reason: "moment.append before side is incomplete",
        });
    };
    Ok(Some(WithheldBefore {
        object_id: before_object_id.to_owned(),
        path: path.to_owned(),
        sha256: sha256.to_owned(),
        content_kind: crate::moment_apply::ContentKind::from_wire(field("beforeContentKind")),
    }))
}

/// `payload` as a hosted replica applies a moment whose before side it
/// withholds: as if the path held nothing.
pub(crate) fn forget_before(payload: &mut serde_json::Value) {
    let Some(fields) = payload.as_object_mut() else {
        return;
    };
    for (name, value) in fields.iter_mut() {
        if name.starts_with("before") || name.starts_with("payloadBefore") {
            *value = serde_json::Value::Null;
        }
    }
    fields.insert("beforePresent".to_owned(), "null".into());
}

/// Clear `path` of every head this replica holds for an object outside the
/// current scope, so the hosted document `object_id` arriving there is the
/// path's only occupant. The feed withholds those objects, so here they never
/// held it. Each keeps its history, journal rows, retained work and live
/// document state for its removal. An ordinary replica clears nothing.
pub(crate) fn clear_withheld_occupants_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
) -> Result<(), SyncError> {
    if !is_hosted(tx, workspace_id)? {
        return Ok(());
    }
    let withheld = tx
        .prepare(
            "SELECT s.object_id FROM snapshots s \
             JOIN hosted_replicas h ON h.workspace_id=s.workspace_id \
             WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.path=?3 AND s.object_id<>?4 \
               AND NOT EXISTS(SELECT 1 FROM hosted_documents d \
                 WHERE d.workspace_id=s.workspace_id AND d.object_id=s.object_id \
                   AND d.scope_generation=h.scope_generation)",
        )
        .map_err(SyncError::corrupt)?
        .query_map(params![workspace_id, version_id, path, object_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    for occupant in withheld {
        for table in ["path_aliases", "snapshots"] {
            tx.execute(
                &format!(
                    "DELETE FROM {table} WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3"
                ),
                params![workspace_id, version_id, occupant],
            )
            .map_err(SyncError::persist)?;
        }
        crate::file_search::delete_file_search_index(tx, workspace_id, version_id, &occupant)?;
    }
    Ok(())
}

/// Record the withheld before side of a moment this transaction applied. A
/// moment the apply only deferred has no row yet and records on its replay.
pub(crate) fn record_withheld_before_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
    before: &WithheldBefore,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO hosted_withheld_befores \
         (workspace_id,moment_id,before_object_id,before_path,before_sha256,before_content_kind) \
         SELECT ?1,?2,?3,?4,?5,?6 \
         WHERE EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2)",
        params![
            workspace_id,
            moment_id,
            before.object_id,
            before.path,
            before.sha256,
            before.content_kind.as_str()
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// What a hosted replica knows of its scope and position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedReplicaState {
    /// `None` until the first scoped response.
    pub scope_token: Option<String>,
    pub scope_generation: i64,
    pub main_cursor: i64,
    /// The documents in the current scope, by object id.
    pub documents: BTreeMap<String, HostedDocumentState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedDocumentState {
    /// The path the scope names it at.
    pub path: String,
    /// Its backfill completed and committed.
    pub ready: bool,
    pub backfill_cursor: i64,
}

/// The replica's state, or `None` for a workspace that is not hosted.
pub fn read_hosted_replica(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Option<HostedReplicaState>, SyncError> {
    store.read_with(|conn| {
        let replica = conn
            .query_row(
                "SELECT scope_token,scope_generation,main_cursor FROM hosted_replicas \
                 WHERE workspace_id=?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let Some((scope_token, scope_generation, main_cursor)) = replica else {
            return Ok(None);
        };
        let mut statement = conn
            .prepare(
                "SELECT object_id,path,state,backfill_cursor FROM hosted_documents \
                 WHERE workspace_id=?1 AND scope_generation=?2",
            )
            .map_err(SyncError::corrupt)?;
        let documents = statement
            .query_map(params![workspace_id, scope_generation], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    HostedDocumentState {
                        path: row.get(1)?,
                        ready: row.get::<_, String>(2)? == "ready",
                        backfill_cursor: row.get(3)?,
                    },
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<_, _>>()
            .map_err(SyncError::corrupt)?;
        Ok(Some(HostedReplicaState {
            scope_token,
            scope_generation,
            main_cursor,
            documents,
        }))
    })
}

/// Whether `workspace.init` created the main version every hosted document's
/// rows apply to.
pub(crate) fn has_main_version(store: &EngineStore, workspace_id: &str) -> Result<bool, SyncError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versioned_workspaces w \
                 JOIN versions v ON v.workspace_id=w.workspace_id \
                   AND v.version_id=w.main_version_id \
                 WHERE w.workspace_id=?1)",
                [workspace_id],
                |row| row.get(0),
            )
        })
        .map_err(SyncError::corrupt)
}

/// Adopt the scope a response announced: its documents, each at its path.
/// Its generation moves, so no pass fetched under the old scope can commit.
/// A document still in scope keeps its progress; one that joins, or returns
/// after leaving, backfills from the start, because the feed withheld its
/// rows while it was out.
pub(crate) fn adopt_scope(
    store: &mut EngineStore,
    workspace_id: &str,
    token: &str,
    documents: &BTreeMap<String, String>,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    store.write_with(faults, |tx| {
        let previous: i64 = tx
            .query_row(
                "SELECT scope_generation FROM hosted_replicas WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        let generation = previous
            .checked_add(1)
            .ok_or(SyncError::CoordinateDiverged)?;
        tx.execute(
            "UPDATE hosted_replicas SET scope_token=?2,scope_generation=?3 WHERE workspace_id=?1",
            params![workspace_id, token, generation],
        )
        .map_err(SyncError::persist)?;
        for (object_id, path) in documents {
            tx.execute(
                "INSERT INTO hosted_documents \
                 (workspace_id,object_id,path,state,backfill_cursor,scope_generation) \
                 VALUES (?1,?2,?5,'backfilling',0,?4) \
                 ON CONFLICT(workspace_id,object_id) DO UPDATE SET \
                 path=excluded.path, \
                 state=CASE WHEN scope_generation=?3 THEN state ELSE 'backfilling' END, \
                 backfill_cursor=CASE WHEN scope_generation=?3 THEN backfill_cursor ELSE 0 END, \
                 scope_generation=excluded.scope_generation",
                params![workspace_id, object_id, previous, generation, path],
            )
            .map_err(SyncError::persist)?;
        }
        Ok(())
    })
}

/// A hosted pass's position, committed only after its work materializes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedCursor {
    /// The scope generation the pass fetched under.
    pub scope_generation: i64,
    /// The document a backfill pass read, or `None` for the main feed.
    pub backfill_object_id: Option<String>,
    pub cursor: i64,
    /// The backfill read reached the end of its document's rows.
    pub backfill_complete: bool,
    /// Local-only ownership token for applied settlements and deferred relay work.
    pub settlement_report_id: Option<String>,
}

/// Commit a hosted pass's position. Answers `false`, committing nothing, when
/// the scope moved since the pass fetched: its page may hold rows the current
/// scope withholds. A backfill that completed marks its document ready in the
/// same transaction, so readiness never precedes its content.
pub fn commit_hosted_cursor(
    store: &mut EngineStore,
    workspace_id: &str,
    cursor: &HostedCursor,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<bool>, SyncError> {
    crate::model::bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    if !(0..=crate::MAX_WIRE_INTEGER).contains(&cursor.cursor) {
        return Err(SyncError::InvalidInput {
            reason: "cursor is outside the wire integer range",
        });
    }
    store.write_with(faults, |tx| {
        let generation: Option<i64> = tx
            .query_row(
                "SELECT scope_generation FROM hosted_replicas WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let generation = generation.ok_or(SyncError::InvalidInput {
            reason: "workspace is not a hosted replica",
        })?;
        if generation != cursor.scope_generation {
            return Ok(false);
        }
        let moved = match &cursor.backfill_object_id {
            // The main cursor stays frozen while any document backfills.
            None => tx.execute(
                "UPDATE hosted_replicas SET main_cursor=MAX(main_cursor,?2) \
                 WHERE workspace_id=?1 AND NOT EXISTS(SELECT 1 FROM hosted_documents d \
                   WHERE d.workspace_id=?1 AND d.scope_generation=?3 AND d.state='backfilling')",
                params![workspace_id, cursor.cursor, generation],
            ),
            Some(object_id) => tx.execute(
                "UPDATE hosted_documents SET backfill_cursor=MAX(backfill_cursor,?3), \
                 state=CASE WHEN ?4 THEN 'ready' ELSE state END \
                 WHERE workspace_id=?1 AND object_id=?2 AND scope_generation=?5 \
                   AND state='backfilling'",
                params![
                    workspace_id,
                    object_id,
                    cursor.cursor,
                    cursor.backfill_complete,
                    generation
                ],
            ),
        }
        .map_err(SyncError::persist)?;
        if moved != 1 {
            return Ok(false);
        }
        if let Some(report_id) = &cursor.settlement_report_id {
            crate::cursor::release_settlement_report_in_tx(tx, workspace_id, report_id)?;
        }
        Ok(true)
    })
}
