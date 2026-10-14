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
//! document. A document that is not ready reads its rows only through its
//! own cursor, which stops at its first row that cannot apply yet; the main
//! feed skips its rows, and nothing of it is retained, so a held document
//! neither freezes the main cursor nor fills deferred work. A document is in
//! scope while its row carries the replica's scope generation; one that left
//! keeps its state until it retires.

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

/// A pass's read of a document that would restart past the row it stopped at.
pub(crate) const STOPPED_BEFORE_READ: &str =
    "a hosted read stopped before its document's read position";

/// Why a passive store refuses every hosted operation.
pub const PASSIVE_STORE_CANNOT_HOST: &str = "a passive store cannot host documents";

/// Why a workspace with files, history or chats cannot become a hosted replica.
pub const HOSTED_REPLICA_NOT_PRISTINE: &str =
    "a hosted replica starts from a workspace with no files, history or chats";

/// A conflict child whose `conflict.resolve` parent the feed withheld. Its
/// document is held at the child until the relay serves what it needs.
pub(crate) const CONFLICT_PARENT_WITHHELD: &str = "hosted-conflict-parent-withheld";

/// A moment or Y.Doc row whose path a document outside the scope, or the file
/// a retired one left, still holds here. It waits until that path is free.
pub(crate) const PATH_HELD_BY_DEPARTED: &str = "hosted-path-held-by-departed";

/// A backfilled op whose path another document in the scope holds here
/// ([`backfill_path_held`]). Its document waits until that one moves.
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
/// its file is gone; the moment waits and applies after. An ordinary replica
/// holds nothing back.
pub(crate) fn wait_for_departed_occupant_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
) -> Result<(), SyncError> {
    if held_by_departed(tx, workspace_id, version_id, object_id, path)? {
        return Err(SyncError::RetryableState {
            reason: PATH_HELD_BY_DEPARTED,
        });
    }
    Ok(())
}

/// Whether a hosted document that left the scope, or the file a retired one
/// left, holds `path` here against `object_id`.
fn held_by_departed(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM snapshots s \
         JOIN hosted_documents d ON d.workspace_id=s.workspace_id AND d.object_id=s.object_id \
         JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
         WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.path=?3 AND s.object_id<>?4 \
           AND d.scope_generation<>h.scope_generation) \
         OR EXISTS(SELECT 1 FROM hosted_retired_files WHERE workspace_id=?1 AND path=?3)",
        params![workspace_id, version_id, path, object_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// The path and version an op takes or writes through: a moment's after
/// side, unless it deletes, and a Y.Doc row's projection.
fn claimed_path(op: &ReplicationEnvelope) -> Option<(&str, &str)> {
    let payload = &op.payload;
    let path = match op.op_kind.as_str() {
        "moment.append" if payload["operation"] != "delete" => &payload["payloadAfterPath"],
        "ydoc.update" => &payload["path"],
        _ => return None,
    };
    Some((path.as_str()?, payload["versionId"].as_str()?))
}

/// Why a hosted replica holds `op` back before routing it, or `None`. A row
/// its journal already holds is never held: the router skips it as applied.
/// Otherwise an op of a document that is not ready waits while another
/// document in the scope holds its path ([`backfill_path_held`]), and a Y.Doc
/// row waits while a departed document or a retired file holds its path, as
/// a moment does when it applies.
pub(crate) fn held_before_routing(
    conn: &Connection,
    unready: &BTreeSet<String>,
    op: &ReplicationEnvelope,
) -> Result<Option<&'static str>, SyncError> {
    let journaled: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM replication_log \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3)",
            params![op.workspace_id, op.origin_id, op.origin_seq],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if journaled {
        return Ok(None);
    }
    if backfill_path_held(conn, unready, op)?.is_some() {
        return Ok(Some(BACKFILL_PATH_HELD));
    }
    if op.op_kind == "ydoc.update"
        && let (Some((path, version_id)), Some(object_id)) = (claimed_path(op), hosted_document(op))
        && held_by_departed(conn, &op.workspace_id, version_id, object_id, path)?
    {
        return Ok(Some(PATH_HELD_BY_DEPARTED));
    }
    Ok(None)
}

/// The path an op of a document that is not ready would claim or validate
/// against, when another document in the scope holds it here. A backfill
/// replays a document's history after other documents' later rows, so a path
/// it only passed through may since belong to another document. Such an op
/// neither applies nor opens a conflict: its document's read stops there,
/// and the document is held, until the other document moves. A ready
/// document's op meets ordinary occupancy instead.
pub(crate) fn backfill_path_held(
    conn: &Connection,
    unready: &BTreeSet<String>,
    op: &ReplicationEnvelope,
) -> Result<Option<HostedHold>, SyncError> {
    let Some(object_id) = hosted_document(op).filter(|id| unready.contains(*id)) else {
        return Ok(None);
    };
    let Some((path, version_id)) = claimed_path(op) else {
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
    /// How many hosted passes have committed.
    pub cursor_commits: i64,
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
    /// Its read stopped at a row that cannot apply yet, or reached the end
    /// away from its scope's path. Each pass reads one page from its cursor
    /// again; the main cursor does not wait.
    Held(HostedHold),
    /// Its backfill was fetched and applied, and it is at its scope's path.
    Ready,
}

/// What holds a hosted document from being ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedHold {
    /// Its history reaches `path`, which `held_by`, another document in the
    /// scope, holds here. Its work waits until `held_by` moves.
    PathHeld { path: String, held_by: String },
    /// Its next row resolves `conflict_id`, whose `conflict.resolve` the feed
    /// withholds. Its work waits until the relay serves it.
    ConflictParentWithheld { conflict_id: String },
    /// Its work waits for another reason: a live session, or a departed
    /// document or retired file still holding its path, while the document
    /// is not ready or the workspace's retained work is full.
    WorkWaiting,
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
            Self::ConflictParentWithheld { .. } => CONFLICT_PARENT_WITHHELD,
            Self::WorkWaiting => "hosted-backfill-work-waiting",
            Self::ScopePathMismatch { .. } => SCOPE_PATH_MISMATCH,
        }
    }

    fn held_path(&self) -> Option<&str> {
        match self {
            Self::PathHeld { path, .. } => Some(path),
            Self::ConflictParentWithheld { .. } | Self::WorkWaiting => None,
            Self::ScopePathMismatch { head_path, .. } => head_path.as_deref(),
        }
    }

    fn held_by(&self) -> Option<&str> {
        match self {
            Self::PathHeld { held_by, .. } => Some(held_by),
            Self::ConflictParentWithheld { .. }
            | Self::WorkWaiting
            | Self::ScopePathMismatch { .. } => None,
        }
    }

    fn held_conflict_id(&self) -> Option<&str> {
        match self {
            Self::ConflictParentWithheld { conflict_id } => Some(conflict_id),
            Self::PathHeld { .. } | Self::WorkWaiting | Self::ScopePathMismatch { .. } => None,
        }
    }
}

const SCOPE_PATH_MISMATCH: &str = "hosted-scope-path-mismatch";

/// A `hosted_documents` row's state, held reason, held path, held-by and
/// held conflict columns, with `scope_path` its `path`.
fn decode_status(
    scope_path: &str,
    state: &str,
    reason: Option<&str>,
    held_path: Option<String>,
    held_by: Option<String>,
    held_conflict_id: Option<String>,
) -> Result<HostedDocumentStatus, SyncError> {
    Ok(
        match (state, reason, held_path, held_by, held_conflict_id) {
            ("backfilling", None, None, None, None) => HostedDocumentStatus::Backfilling,
            ("ready", None, None, None, None) => HostedDocumentStatus::Ready,
            ("held", Some("hosted-backfill-path-held"), Some(path), Some(held_by), None) => {
                HostedDocumentStatus::Held(HostedHold::PathHeld { path, held_by })
            }
            ("held", Some("hosted-conflict-parent-withheld"), None, None, Some(conflict_id)) => {
                HostedDocumentStatus::Held(HostedHold::ConflictParentWithheld { conflict_id })
            }
            ("held", Some("hosted-backfill-work-waiting"), None, None, None) => {
                HostedDocumentStatus::Held(HostedHold::WorkWaiting)
            }
            ("held", Some("hosted-scope-path-mismatch"), head_path, None, None) => {
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
        },
    )
}

/// The replica's state, or `None` for a workspace that is not hosted.
pub fn read_hosted_replica(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Option<HostedReplicaState>, SyncError> {
    store.read_with(|conn| {
        let replica = conn
            .query_row(
                "SELECT scope_token,scope_generation,main_cursor,cursor_commits \
                 FROM hosted_replicas WHERE workspace_id=?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let Some((scope_token, scope_generation, main_cursor, cursor_commits)) = replica else {
            return Ok(None);
        };
        let mut statement = conn
            .prepare(
                "SELECT object_id,path,state,held_reason,held_path,held_by,held_conflict_id, \
                 backfill_cursor FROM hosted_documents WHERE workspace_id=?1 AND scope_generation=?2",
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
                    row.get(7)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        let documents = rows
            .into_iter()
            .map(
                |(object_id, path, state, reason, held_path, held_by, conflict_id, cursor)| {
                    let status = decode_status(
                        &path,
                        &state,
                        reason.as_deref(),
                        held_path,
                        held_by,
                        conflict_id,
                    )?;
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
            cursor_commits,
            documents,
        }))
    })
}

/// Adopt the scope a response announced: its documents, each at its path.
/// Its generation moves, so no pass fetched under the old scope can commit.
/// A document still in scope keeps its progress; one that joins, or returns
/// after leaving, backfills from the start, because the feed withheld its
/// rows while it was out. A ready document the scope moves away from its
/// head is held until the row that takes it there applies; its own read
/// picks up where the main feed is, which applied or retained everything of
/// it before.
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
            let moved_ready: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM hosted_documents WHERE workspace_id=?1 \
                     AND object_id=?2 AND scope_generation=?3 AND state='ready' AND path<>?4)",
                    params![workspace_id, object_id, previous, path],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
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
                 held_conflict_id=CASE WHEN scope_generation=?3 THEN held_conflict_id END, \
                 backfill_cursor=CASE WHEN scope_generation=?3 THEN backfill_cursor ELSE 0 END, \
                 scope_generation=excluded.scope_generation",
                params![workspace_id, object_id, previous, generation, path],
            )
            .map_err(SyncError::persist)?;
            if !moved_ready {
                continue;
            }
            let head_path = head_path(tx, workspace_id, object_id)?;
            if head_path.as_deref() != Some(path.as_str()) {
                tx.execute(
                    "UPDATE hosted_documents SET state='held',held_reason=?3,held_path=?4, \
                     backfill_cursor=MAX(backfill_cursor, \
                       (SELECT main_cursor FROM hosted_replicas WHERE workspace_id=?1)) \
                     WHERE workspace_id=?1 AND object_id=?2",
                    params![workspace_id, object_id, SCOPE_PATH_MISMATCH, head_path],
                )
                .map_err(SyncError::persist)?;
            }
        }
        Ok(())
    })
}

/// A hosted pass's position, committed only after its work materializes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedCursor {
    /// The scope generation the pass fetched under.
    pub scope_generation: i64,
    /// How many hosted passes had committed when the pass read the replica.
    pub cursor_commits: i64,
    /// The main feed's position, or `None` when a document backfilled instead.
    pub main_cursor: Option<i64>,
    /// Each document whose own rows the pass read, by object id: the one
    /// backfilling, if any, every held one, and every ready one that stopped
    /// at a conflict child whose parent the feed withholds or at work past
    /// the retention limit.
    pub reads: BTreeMap<String, HostedRead>,
    /// Local-only ownership token for applied settlements and deferred relay work.
    pub settlement_report_id: Option<String>,
}

/// How far a pass read one document's own rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedRead {
    /// Where its next read starts: before its first row that could not
    /// apply, or past the rows read.
    pub cursor: i64,
    /// What stopped the read at `cursor`.
    pub stopped: Option<HostedHold>,
    /// The read reached the end of its rows, and every row applied.
    pub complete: bool,
}

impl HostedRead {
    /// What holds its document once this read commits, if anything.
    pub(crate) fn hold(
        &self,
        conn: &Connection,
        workspace_id: &str,
        object_id: &str,
    ) -> Result<Option<HostedHold>, SyncError> {
        match &self.stopped {
            Some(hold) => Ok(Some(hold.clone())),
            None if self.complete => completed_hold(conn, workspace_id, object_id),
            None => Ok(None),
        }
    }
}

/// Commit a hosted pass's position. Answers `false`, committing nothing, when
/// the scope moved since the pass fetched, since its page may hold rows the
/// current scope withholds, or when another pass committed since it read the
/// replica, since it read from a position and states that one replaced: its
/// caller pulls again. Each document read is settled in the same transaction:
/// held where its read stopped, ready once its read completes with nothing of
/// it waiting in deferred work and its head at its scope's path, and still
/// backfilling otherwise. So readiness never precedes its content. A held
/// document releases the deferred work it still has to apply, and its read
/// restarts before it.
pub fn commit_hosted_cursor(
    store: &mut EngineStore,
    workspace_id: &str,
    cursor: &HostedCursor,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<bool>, SyncError> {
    crate::model::bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    let positions = cursor
        .main_cursor
        .iter()
        .chain(cursor.reads.values().map(|read| &read.cursor));
    for position in positions {
        if !(0..=crate::MAX_WIRE_INTEGER).contains(position) {
            return Err(SyncError::InvalidInput {
                reason: "cursor is outside the wire integer range",
            });
        }
    }
    store.write_with(faults, |tx| {
        let replica: Option<(i64, i64)> = tx
            .query_row(
                "SELECT scope_generation,cursor_commits FROM hosted_replicas WHERE workspace_id=?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let (generation, commits) = replica.ok_or(SyncError::InvalidInput {
            reason: NOT_A_HOSTED_REPLICA,
        })?;
        // Only a scope change or a commit changes the scope's documents, so
        // the pass's reads still name documents in the states it read.
        if generation != cursor.scope_generation || commits != cursor.cursor_commits {
            return Ok(false);
        }
        let commits = commits
            .checked_add(1)
            .ok_or(SyncError::CoordinateDiverged)?;
        tx.execute(
            "UPDATE hosted_replicas SET cursor_commits=?2, \
             main_cursor=MAX(main_cursor,COALESCE(?3,main_cursor)) WHERE workspace_id=?1",
            params![workspace_id, commits, cursor.main_cursor],
        )
        .map_err(SyncError::persist)?;
        for (object_id, read) in &cursor.reads {
            let hold = read.hold(tx, workspace_id, object_id)?;
            let state = match &hold {
                Some(_) => "held",
                None if read.complete => "ready",
                None => "backfilling",
            };
            // A held document retains nothing, so its own read starts before
            // the work it retained while ready.
            let released = if hold.is_some() {
                crate::deferred::release_hosted_in_tx(tx, workspace_id, object_id)?
            } else {
                None
            };
            let from: i64 = tx
                .query_row(
                    "SELECT backfill_cursor FROM hosted_documents \
                     WHERE workspace_id=?1 AND object_id=?2",
                    params![workspace_id, object_id],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            // A read that stops below where its document's read already is,
            // and not at work this commit releases, would skip the row it
            // stopped at.
            if read.cursor < from && released.is_none_or(|first| read.cursor < first - 1) {
                return Err(SyncError::InvalidInput {
                    reason: STOPPED_BEFORE_READ,
                });
            }
            let position = released.map_or(read.cursor, |first| read.cursor.min(first - 1));
            tx.execute(
                "UPDATE hosted_documents SET backfill_cursor=?3,state=?4, \
                 held_reason=?5,held_path=?6,held_by=?7,held_conflict_id=?8 \
                 WHERE workspace_id=?1 AND object_id=?2",
                params![
                    workspace_id,
                    object_id,
                    position,
                    state,
                    hold.as_ref().map(HostedHold::reason),
                    hold.as_ref().and_then(HostedHold::held_path),
                    hold.as_ref().and_then(HostedHold::held_by),
                    hold.as_ref().and_then(HostedHold::held_conflict_id)
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

/// What holds a document whose read stopped at `op`, its first row that
/// could not apply.
pub(crate) fn stopped_hold(
    conn: &Connection,
    object_id: &str,
    op: &ReplicationEnvelope,
) -> Result<HostedHold, SyncError> {
    let unready = BTreeSet::from([object_id.to_owned()]);
    if let Some(hold) = backfill_path_held(conn, &unready, op)? {
        return Ok(hold);
    }
    Ok(
        match crate::conflict_resolve_v1::withheld_parent_conflict(conn, op)? {
            Some(conflict_id) => HostedHold::ConflictParentWithheld { conflict_id },
            None => HostedHold::WorkWaiting,
        },
    )
}

/// What holds a document whose read reached the end of its rows from being
/// ready: retained work of it still waiting, or a head away from the path
/// its scope names. `None` once nothing does.
fn completed_hold(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<HostedHold>, SyncError> {
    if let Some(waiting) = crate::deferred::first_unapplied_hosted(conn, workspace_id, object_id)? {
        return stopped_hold(conn, object_id, &waiting).map(Some);
    }
    let scope_path: String = conn
        .query_row(
            "SELECT path FROM hosted_documents WHERE workspace_id=?1 AND object_id=?2",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let head_path = head_path(conn, workspace_id, object_id)?;
    Ok(
        (head_path.as_deref() != Some(scope_path.as_str())).then_some(
            HostedHold::ScopePathMismatch {
                scope_path,
                head_path,
            },
        ),
    )
}

/// The path of `object_id`'s head in the version the root holds.
fn head_path(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT path FROM snapshots WHERE workspace_id=?1 AND object_id=?2 AND version_id=\
           COALESCE((SELECT version_id FROM active_versions WHERE workspace_id=?1), \
             (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1))",
        params![workspace_id, object_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}
