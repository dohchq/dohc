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
//! document. A fetched document that something still holds from being ready
//! does not freeze it. A document is in scope while its row carries the
//! replica's scope generation; one that left keeps its state until it retires.

mod retirement;

use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{ReplicationEnvelope, SyncError};

pub use retirement::{
    DepartedDocument, DepartedHead, RetiredFile, departed_hosted_documents,
    forget_retired_hosted_file, hosted_document_retirable, retire_hosted_document,
    retired_hosted_files,
};

/// The origin prefix the relay reserves for a service host's writes.
pub const SERVICE_HOST_ORIGIN_PREFIX: &str = "service-host:";

pub(crate) const NOT_A_HOSTED_REPLICA: &str = "workspace is not a hosted replica";

/// Why a passive store refuses every hosted operation.
pub const PASSIVE_STORE_CANNOT_HOST: &str = "a passive store cannot host documents";

/// A conflict child whose `conflict.resolve` parent the feed withheld. The
/// child waits in deferred work until the relay serves what it needs.
pub(crate) const CONFLICT_PARENT_WITHHELD: &str = "hosted-conflict-parent-withheld";

/// A moment whose path a document outside the scope still holds here. It
/// waits in deferred work until that document retires.
pub(crate) const PATH_HELD_BY_DEPARTED: &str = "hosted-path-held-by-departed";

/// A backfilled op whose path another document in the scope holds here
/// ([`backfill_path_held`]). It waits in deferred work until that one moves.
pub(crate) const BACKFILL_PATH_HELD: &str = "hosted-backfill-path-held";

pub(crate) fn is_hosted(conn: &Connection, workspace_id: &str) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM hosted_replicas WHERE workspace_id=?1)",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// Whether `workspace_id` is a hosted replica.
pub fn is_hosted_replica(store: &EngineStore, workspace_id: &str) -> Result<bool, SyncError> {
    store.read_with(|conn| is_hosted(conn, workspace_id))
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

/// [`document_named`] over a `replication_log` row's `op_kind` and
/// `payload_json`.
const DOCUMENT_NAMED_SQL: &str = "CASE op_kind \
    WHEN 'moment.append' THEN json_extract(payload_json,'$.objectId') \
    WHEN 'ydoc.update' THEN json_extract(payload_json,'$.objectId') \
    WHEN 'live.audit.application' THEN json_extract(payload_json,'$.objectId') \
    WHEN 'live.audit.settlement' THEN json_extract(payload_json,'$.record.binding.objectId') \
    WHEN 'live.audit.base' \
      THEN json_extract(payload_json,'$.record.checkpoint.binding.objectId') END";

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

/// Hold back a moment that would take `path` while a hosted document that
/// left the scope still holds it here. That document may still settle work
/// against its head there, so the path stays its own until it retires and
/// its file is gone; the moment waits in deferred work and applies after. An
/// ordinary replica holds nothing back.
pub(crate) fn wait_for_departed_occupant_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
) -> Result<(), SyncError> {
    let held: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM snapshots s \
             JOIN hosted_documents d ON d.workspace_id=s.workspace_id AND d.object_id=s.object_id \
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
             WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.path=?3 AND s.object_id<>?4 \
               AND d.scope_generation<>h.scope_generation) \
             OR EXISTS(SELECT 1 FROM hosted_retired_files WHERE workspace_id=?1 AND path=?3)",
            params![workspace_id, version_id, path, object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if held {
        return Err(SyncError::RetryableState {
            reason: PATH_HELD_BY_DEPARTED,
        });
    }
    Ok(())
}

/// The path an op of a document that is not ready would claim or validate
/// against, when another document in the scope holds it here. A backfill
/// replays a document's history after other documents' later rows, so a path
/// it only passed through may since belong to another document. Such an op
/// neither applies nor opens a conflict: it waits in deferred work, and its
/// document is held, until the other document moves. A ready document's op
/// meets ordinary occupancy instead.
pub(crate) fn backfill_path_held(
    conn: &Connection,
    unready: &BTreeSet<String>,
    op: &ReplicationEnvelope,
) -> Result<Option<HostedHold>, SyncError> {
    let Some(object_id) = hosted_document(op).filter(|id| unready.contains(*id)) else {
        return Ok(None);
    };
    let payload = &op.payload;
    let path = match op.op_kind.as_str() {
        "moment.append" if payload["operation"] != "delete" => &payload["payloadAfterPath"],
        "ydoc.update" => &payload["path"],
        _ => return Ok(None),
    };
    let (Some(path), Some(version_id)) = (path.as_str(), payload["versionId"].as_str()) else {
        return Ok(None);
    };
    let held_by: Option<String> = conn
        .query_row(
            "SELECT o.object_id FROM hosted_documents o JOIN hosted_replicas h \
               ON h.workspace_id=o.workspace_id AND h.scope_generation=o.scope_generation \
             WHERE o.workspace_id=?1 AND o.object_id<>?3 AND o.object_id IN \
               (SELECT object_id FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND path=?4 \
                UNION SELECT object_id FROM path_aliases \
                  WHERE workspace_id=?1 AND version_id=?2 AND path=?4) \
             LIMIT 1",
            params![op.workspace_id, version_id, object_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(held_by.map(|held_by| HostedHold::PathHeld {
        path: path.to_owned(),
        held_by,
    }))
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
    pub status: HostedDocumentStatus,
    pub backfill_cursor: i64,
}

/// Where a hosted document stands. Only a ready document can be edited live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedDocumentStatus {
    /// Its backfill is still being fetched. The main cursor waits for it.
    Backfilling,
    /// Its backfill was fetched, but something holds it from being ready.
    /// Later passes retry it; the main cursor does not wait.
    Held(HostedHold),
    /// Its backfill was fetched and applied, and it is at its scope's path.
    Ready,
}

/// What holds a fetched hosted document from being ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedHold {
    /// Its history reaches `path`, which `held_by`, another document in the
    /// scope, holds here. Its work waits until `held_by` moves.
    PathHeld { path: String, held_by: String },
    /// Its work waits for another reason: a live session, a conflict parent
    /// the feed withheld, or a departed document still holding its path.
    WorkRetained,
    /// Its history leaves it at `head_path`, or at no path, while the scope
    /// names it at `scope_path`. It waits for the row that moves it there.
    ScopePathMismatch {
        scope_path: String,
        head_path: Option<String>,
    },
}

impl HostedHold {
    /// The reason code a hold is stored and reported under.
    pub const fn reason(&self) -> &'static str {
        match self {
            Self::PathHeld { .. } => BACKFILL_PATH_HELD,
            Self::WorkRetained => "hosted-backfill-work-retained",
            Self::ScopePathMismatch { .. } => "hosted-scope-path-mismatch",
        }
    }

    fn held_path(&self) -> Option<&str> {
        match self {
            Self::PathHeld { path, .. } => Some(path),
            Self::WorkRetained => None,
            Self::ScopePathMismatch { head_path, .. } => head_path.as_deref(),
        }
    }

    fn held_by(&self) -> Option<&str> {
        match self {
            Self::PathHeld { held_by, .. } => Some(held_by),
            Self::WorkRetained | Self::ScopePathMismatch { .. } => None,
        }
    }
}

/// A `hosted_documents` row's state, held reason, held path and held-by
/// columns, with `scope_path` its `path`.
fn decode_status(
    scope_path: &str,
    state: &str,
    reason: Option<&str>,
    held_path: Option<String>,
    held_by: Option<String>,
) -> Result<HostedDocumentStatus, SyncError> {
    Ok(match (state, reason, held_path, held_by) {
        ("backfilling", None, None, None) => HostedDocumentStatus::Backfilling,
        ("ready", None, None, None) => HostedDocumentStatus::Ready,
        ("held", Some("hosted-backfill-path-held"), Some(path), Some(held_by)) => {
            HostedDocumentStatus::Held(HostedHold::PathHeld { path, held_by })
        }
        ("held", Some("hosted-backfill-work-retained"), None, None) => {
            HostedDocumentStatus::Held(HostedHold::WorkRetained)
        }
        ("held", Some("hosted-scope-path-mismatch"), head_path, None) => {
            HostedDocumentStatus::Held(HostedHold::ScopePathMismatch {
                scope_path: scope_path.to_owned(),
                head_path,
            })
        }
        _ => {
            return Err(crate::error::local_corruption(
                "a hosted document's state is malformed",
            ));
        }
    })
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
                "SELECT object_id,path,state,held_reason,held_path,held_by,backfill_cursor \
                 FROM hosted_documents WHERE workspace_id=?1 AND scope_generation=?2",
            )
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map(params![workspace_id, scope_generation], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        let documents = rows
            .into_iter()
            .map(
                |(object_id, path, state, reason, held_path, held_by, cursor)| {
                    let status =
                        decode_status(&path, &state, reason.as_deref(), held_path, held_by)?;
                    Ok((
                        object_id,
                        HostedDocumentState {
                            path,
                            status,
                            backfill_cursor: cursor,
                        },
                    ))
                },
            )
            .collect::<Result<_, SyncError>>()?;
        Ok(Some(HostedReplicaState {
            scope_token,
            scope_generation,
            main_cursor,
            documents,
        }))
    })
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
                 held_reason=CASE WHEN scope_generation=?3 THEN held_reason END, \
                 held_path=CASE WHEN scope_generation=?3 THEN held_path END, \
                 held_by=CASE WHEN scope_generation=?3 THEN held_by END, \
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
/// scope withholds. A backfill that completed, and every held document, is
/// settled in the same transaction: ready when none of its work waits in
/// deferred work and its head is at its scope's path, held otherwise. So
/// readiness never precedes its content.
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
            reason: NOT_A_HOSTED_REPLICA,
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
                "UPDATE hosted_documents SET backfill_cursor=MAX(backfill_cursor,?3) \
                 WHERE workspace_id=?1 AND object_id=?2 AND scope_generation=?4 \
                   AND state='backfilling'",
                params![workspace_id, object_id, cursor.cursor, generation],
            ),
        }
        .map_err(SyncError::persist)?;
        if moved != 1 {
            return Ok(false);
        }
        let fetched = cursor
            .backfill_object_id
            .as_deref()
            .filter(|_| cursor.backfill_complete);
        for (object_id, hold) in hosted_holds(tx, workspace_id, fetched)? {
            tx.execute(
                "UPDATE hosted_documents SET state=CASE WHEN ?3 IS NULL THEN 'ready' ELSE 'held' END, \
                 held_reason=?3,held_path=?4,held_by=?5 WHERE workspace_id=?1 AND object_id=?2",
                params![
                    workspace_id,
                    object_id,
                    hold.as_ref().map(HostedHold::reason),
                    hold.as_ref().and_then(HostedHold::held_path),
                    hold.as_ref().and_then(HostedHold::held_by)
                ],
            )
            .map_err(SyncError::persist)?;
        }
        if let Some(report_id) = &cursor.settlement_report_id {
            crate::cursor::release_settlement_report_in_tx(tx, workspace_id, report_id)?;
        }
        Ok(true)
    })
}

/// The documents in the scope whose backfill was fetched but that are not
/// ready yet, the held ones and `fetched`, each with what holds it, if
/// anything still does.
pub(crate) fn hosted_holds(
    conn: &Connection,
    workspace_id: &str,
    fetched: Option<&str>,
) -> Result<BTreeMap<String, Option<HostedHold>>, SyncError> {
    let mut statement = conn
        .prepare(
            "SELECT d.object_id,d.path FROM hosted_documents d JOIN hosted_replicas h \
               ON h.workspace_id=d.workspace_id AND h.scope_generation=d.scope_generation \
             WHERE d.workspace_id=?1 AND (d.state='held' OR (d.object_id=?2 AND d.state='backfilling'))",
        )
        .map_err(SyncError::corrupt)?;
    let documents = statement
        .query_map(params![workspace_id, fetched], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    documents
        .into_iter()
        .map(|(object_id, scope_path)| {
            let hold = hosted_hold(conn, workspace_id, &object_id, &scope_path)?;
            Ok((object_id, hold))
        })
        .collect()
}

/// What holds a document whose backfill was fetched from being ready: the
/// first of its work still waiting in deferred work, or a head away from the
/// path its scope names. `None` once nothing does.
fn hosted_hold(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
    scope_path: &str,
) -> Result<Option<HostedHold>, SyncError> {
    if let Some(waiting) = crate::deferred::first_unapplied_hosted(conn, workspace_id, object_id)? {
        let unready = BTreeSet::from([object_id.to_owned()]);
        return Ok(Some(
            backfill_path_held(conn, &unready, &waiting)?.unwrap_or(HostedHold::WorkRetained),
        ));
    }
    let head_path: Option<String> = conn
        .query_row(
            "SELECT path FROM snapshots WHERE workspace_id=?1 AND object_id=?2 AND version_id=\
               COALESCE((SELECT version_id FROM active_versions WHERE workspace_id=?1), \
                 (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1))",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(
        (head_path.as_deref() != Some(scope_path)).then(|| HostedHold::ScopePathMismatch {
            scope_path: scope_path.to_owned(),
            head_path,
        }),
    )
}
