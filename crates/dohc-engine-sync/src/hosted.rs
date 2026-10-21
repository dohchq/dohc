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
//! keeps its state until it parks, and keeps what its return needs after.

mod park;

use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{ReplicationEnvelope, SyncError};

#[cfg(test)]
pub(crate) use park::OCCUPANTS_READ;
pub use park::{
    DepartedDocument, DepartedHead, RetiredFile, departed_hosted_documents,
    departed_hosted_materialization, departed_hosted_object_ids, forget_retired_hosted_file,
    hosted_document_parkable, park_hosted_document, retired_hosted_files,
};
pub(crate) use park::{Occupancy, unpark_returned, unparks_next};

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
/// a parked one left, still holds here. It waits until that path is free.
pub(crate) const PATH_HELD_BY_DEPARTED: &str = "hosted-path-held-by-departed";

/// A backfilled op whose path another document in the scope holds here
/// ([`backfill_path_held`]). Its document waits until that one moves.
pub(crate) const BACKFILL_PATH_HELD: &str = "hosted-backfill-path-held";

/// A moment of a ready document that would move it to another spelling of a
/// path another document in the scope holds here ([`wait_for_occupant_in_tx`]).
/// The pass holds its document there, as [`BACKFILL_PATH_HELD`] does, until
/// that one moves.
pub(crate) const PATH_HELD_IN_SCOPE: &str = "hosted-path-held-in-scope";

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
/// it commits a coordinate nothing could push. A parked document is no longer
/// hosted.
pub(crate) fn allocate_outbound_seq_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload_json: &str,
) -> Result<Option<i64>, SyncError> {
    let Some(last) = last_outbound_seq(tx, workspace_id)? else {
        return Ok(None);
    };
    let payload = serde_json::from_str(payload_json).map_err(|_| SyncError::InvalidInput {
        reason: "payload is not valid JSON",
    })?;
    let hosted = match document_named(op_kind, &payload) {
        Some(object_id) => tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM hosted_documents \
                 WHERE workspace_id=?1 AND object_id=?2 AND state<>'parked')",
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

/// The last sequence a hosted replica numbered under its own origin, or `None`
/// for any other replica.
pub(crate) fn last_outbound_seq(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Option<i64>, SyncError> {
    conn.query_row(
        "SELECT last_outbound_seq FROM hosted_replicas WHERE workspace_id=?1",
        [workspace_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
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

/// Record that a pass journaled `op`, a row of the document it names, which
/// no committed pass has written the files of yet. Until a commit's read
/// covers it, that document finishes its files before it parks, since once
/// it leaves the scope no pass serves the row again ([`commit_hosted_cursor`]).
pub(crate) fn record_unmaterialized_in_tx(
    tx: &rusqlite::Transaction<'_>,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let (Some(object_id), Some(relay_seq)) = (hosted_document(op), op.relay_seq) else {
        return Ok(());
    };
    tx.execute(
        "UPDATE hosted_documents SET unmaterialized_seq=MAX(COALESCE(unmaterialized_seq,0),?3) \
         WHERE workspace_id=?1 AND object_id=?2 AND state<>'parked' AND ?3>0",
        params![op.workspace_id, object_id, relay_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// The longest refusal reason a hosted push response may carry.
const MAX_PUSH_REFUSAL_REASON_BYTES: usize = 256;

/// Check the relay's refusals of a pushed batch: only a hosted push has any,
/// and each names one distinct op of the batch, by coordinate and kind, that
/// is not also a settlement refusal.
pub(crate) fn validate_push_refusals(
    response: &crate::PushResponse,
    batch: &[ReplicationEnvelope],
    hosted: bool,
) -> Result<(), crate::RelayError> {
    if !hosted && !response.hosted_refusals.is_empty() {
        return Err(crate::RelayError::InvalidResponse);
    }
    let mut coordinates = BTreeSet::new();
    for refusal in &response.hosted_refusals {
        let coordinate = (refusal.origin_id.as_str(), refusal.origin_seq);
        if !coordinates.insert(coordinate)
            || refusal.reason.is_empty()
            || refusal.reason.len() > MAX_PUSH_REFUSAL_REASON_BYTES
            || response
                .settlement_refusals
                .iter()
                .any(|settled| (settled.origin_id.as_str(), settled.origin_seq) == coordinate)
            || !batch.iter().any(|op| {
                (op.origin_id.as_str(), op.origin_seq) == coordinate
                    && op.op_kind == refusal.op_kind
            })
        {
            return Err(crate::RelayError::InvalidResponse);
        }
    }
    Ok(())
}

/// Record the relay's refusals of this replica's own ops, in the transaction
/// that acknowledges them. A refusal is a recorded outcome, not a fallback:
/// nothing is journaled again. A retried push records each one once.
pub(crate) fn record_push_refusals_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    refusals: &[crate::HostedPushRefusal],
) -> Result<(), SyncError> {
    if refusals.is_empty() {
        return Ok(());
    }
    if !is_hosted(tx, workspace_id)? {
        return Err(SyncError::InvalidInput {
            reason: NOT_A_HOSTED_REPLICA,
        });
    }
    for refusal in refusals {
        let journaled: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 \
                 AND origin_id=?2 AND origin_seq=?3 AND op_kind=?4 AND imported=0)",
                params![
                    workspace_id,
                    refusal.origin_id,
                    refusal.origin_seq,
                    refusal.op_kind
                ],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if !journaled {
            return Err(SyncError::CoordinateDiverged);
        }
        let reason = push_refusal(workspace_id, refusal).reason;
        tx.execute(
            "INSERT INTO replication_pending_refusals \
             (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
             VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id,origin_id,origin_seq) DO NOTHING",
            params![
                workspace_id,
                refusal.origin_id,
                refusal.origin_seq,
                refusal.op_kind,
                reason.code(),
                reason.message()
            ],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

/// How a hosted pass reports an op the relay refused.
pub(crate) fn push_refusal(
    workspace_id: &str,
    refusal: &crate::HostedPushRefusal,
) -> crate::ReplicationRefusal {
    crate::ReplicationRefusal {
        workspace_id: workspace_id.to_owned(),
        origin_id: refusal.origin_id.clone(),
        origin_seq: refusal.origin_seq,
        op_kind: refusal.op_kind.clone(),
        reason: crate::RefusalReason::InvalidInput {
            reason: format!("the relay refused this hosted write: {}", refusal.reason),
        },
    }
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
/// against its head there, so the path stays its own until it parks and its
/// file is gone; the moment waits and applies after.
///
/// Also hold back a moment that would move its document onto another
/// spelling of a path another document of the scope holds
/// ([`spelling_holder`]). A disk that ignores case gives both one file
/// (#2036). An ordinary replica holds nothing back.
pub(crate) fn wait_for_occupant_in_tx(
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
    if spelling_holder(tx, workspace_id, version_id, object_id, path)?.is_some() {
        return Err(SyncError::RetryableState {
            reason: PATH_HELD_IN_SCOPE,
        });
    }
    Ok(())
}

/// Whether a hosted document that left the scope, or the file a parked one
/// left, holds `path` here against `object_id`. A path held this way matches
/// like a capture hold: in any case, and with everything beneath it. It also
/// holds each folder above it, which a file at that path would collide with.
fn held_by_departed(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
) -> Result<bool, SyncError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT s.path FROM snapshots s \
             JOIN hosted_documents d ON d.workspace_id=s.workspace_id AND d.object_id=s.object_id \
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
             WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id<>?3 \
               AND d.scope_generation<>h.scope_generation \
             UNION ALL SELECT path FROM hosted_retired_files WHERE workspace_id=?1",
        )
        .map_err(SyncError::corrupt)?;
    let held = statement
        .query_map(params![workspace_id, version_id, object_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(SyncError::corrupt)?;
    for held in held {
        let held = held.map_err(SyncError::corrupt)?;
        use dohc_engine_files::path_is_held;
        if path_is_held(&held, path) || path_is_held(path, &held) {
            return Ok(true);
        }
    }
    Ok(false)
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
/// Otherwise every op of a returning document waits while its heads are
/// parked, an op of a document that is not ready waits while another
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
    if let Some(object_id) = hosted_document(op).filter(|id| unready.contains(*id))
        && let Some(hold) =
            park::parked_hold(&mut Occupancy::new(conn, &op.workspace_id), object_id)?
    {
        return Ok(Some(match hold {
            HostedHold::PathHeld { .. } => BACKFILL_PATH_HELD,
            _ => PATH_HELD_BY_DEPARTED,
        }));
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
///
/// The same holds for another spelling of the path ([`spelling_holder`]): a
/// disk that ignores case keeps one file for both, so two documents there
/// would write each other's file (#2036). A document at exactly the path is
/// named first.
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
    let held_by = match held_by {
        Some(held_by) => Some(held_by),
        None => spelling_holder(conn, &op.workspace_id, version_id, object_id, path)?,
    };
    Ok(held_by.map(|held_by| HostedHold::PathHeld {
        path: path.to_owned(),
        held_by,
    }))
}

/// The first other document of the scope by id whose head or path alias in
/// `version_id` collides with `path` as capture holds match paths, by another
/// spelling or as a folder above or inside it, when `object_id` would move
/// to `path`. A document already there meets no new collision, so two that
/// already collide hold neither, and an edit reads nothing more. An ordinary
/// replica has none.
fn spelling_holder(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
) -> Result<Option<String>, SyncError> {
    if !is_hosted(conn, workspace_id)? {
        return Ok(None);
    }
    let at: Option<String> = conn
        .query_row(
            "SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![workspace_id, version_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if at.as_deref() == Some(path) {
        return Ok(None);
    }
    let first = path.split('/').next().unwrap_or(path);
    let prefix = first
        .is_ascii()
        .then(|| dohc_engine_files::floor::collision_key(first));
    let mut statement = conn
        .prepare_cached(SPELLING_HOLDERS_SQL)
        .map_err(SyncError::corrupt)?;
    let occupants = statement
        .query_map(
            params![workspace_id, version_id, object_id, prefix],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(SyncError::corrupt)?;
    for occupant in occupants {
        let (held_by, held) = occupant.map_err(SyncError::corrupt)?;
        use dohc_engine_files::path_is_held;
        if held != path && (path_is_held(&held, path) || path_is_held(path, &held)) {
            return Ok(Some(held_by));
        }
    }
    Ok(None)
}

/// Every head and path alias in one version, by document, of a document of
/// the scope other than `?3` that could collide with a path whose first
/// segment has the collision key `?4`. Two paths collide only when their
/// first segments do, so an ASCII path must start with `?4` in ASCII
/// lowercase. A path with other characters is always read, since only its
/// full key can tell, as is every path when `?4` is `NULL`. `?1` is the
/// workspace and `?2` the version.
const SPELLING_HOLDERS_SQL: &str = "SELECT o.object_id,o.path FROM \
       (SELECT object_id,path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 \
        UNION ALL SELECT object_id,path FROM path_aliases \
          WHERE workspace_id=?1 AND version_id=?2) o \
     WHERE o.object_id<>?3 \
       AND (?4 IS NULL OR lower(substr(o.path,1,length(?4)))=?4 \
         OR length(o.path)<>length(CAST(o.path AS BLOB))) \
       AND EXISTS(SELECT 1 FROM hosted_documents d JOIN hosted_replicas h \
         ON h.workspace_id=d.workspace_id AND h.scope_generation=d.scope_generation \
         WHERE d.workspace_id=?1 AND d.object_id=o.object_id) \
     ORDER BY o.object_id";

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
    /// Its history holds an ordinary edit of its live lineage that this
    /// replica refused because its session never admitted it, so its content
    /// here is incomplete. It cannot be edited live here.
    LiveEditUnadmitted,
}

impl HostedHold {
    /// The reason code a hold is stored and reported under.
    pub const fn reason(&self) -> &'static str {
        match self {
            Self::PathHeld { .. } => BACKFILL_PATH_HELD,
            Self::ConflictParentWithheld { .. } => CONFLICT_PARENT_WITHHELD,
            Self::WorkWaiting => "hosted-backfill-work-waiting",
            Self::ScopePathMismatch { .. } => SCOPE_PATH_MISMATCH,
            Self::LiveEditUnadmitted => LIVE_EDIT_UNADMITTED,
        }
    }

    fn held_path(&self) -> Option<&str> {
        match self {
            Self::PathHeld { path, .. } => Some(path),
            Self::ConflictParentWithheld { .. } | Self::WorkWaiting | Self::LiveEditUnadmitted => {
                None
            }
            Self::ScopePathMismatch { head_path, .. } => head_path.as_deref(),
        }
    }

    fn held_by(&self) -> Option<&str> {
        match self {
            Self::PathHeld { held_by, .. } => Some(held_by),
            Self::ConflictParentWithheld { .. }
            | Self::WorkWaiting
            | Self::ScopePathMismatch { .. }
            | Self::LiveEditUnadmitted => None,
        }
    }

    fn held_conflict_id(&self) -> Option<&str> {
        match self {
            Self::ConflictParentWithheld { conflict_id } => Some(conflict_id),
            Self::PathHeld { .. }
            | Self::WorkWaiting
            | Self::ScopePathMismatch { .. }
            | Self::LiveEditUnadmitted => None,
        }
    }
}

const SCOPE_PATH_MISMATCH: &str = "hosted-scope-path-mismatch";
const LIVE_EDIT_UNADMITTED: &str = "hosted-live-edit-unadmitted";

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
            ("held", Some(LIVE_EDIT_UNADMITTED), None, None, None) => {
                HostedDocumentStatus::Held(HostedHold::LiveEditUnadmitted)
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
/// rows while it was out, and a parked one's journal skips what it already
/// applied. A ready document the scope moves away from its
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
    /// The read was complete and nothing held its document, so the pass
    /// wrote its heads. Only such a read's commit makes it ready.
    pub heads_written: bool,
}

impl HostedRead {
    /// What holds its document once this read commits, if anything.
    pub(crate) fn hold(
        &self,
        occupancy: &mut Occupancy<'_>,
        object_id: &str,
    ) -> Result<Option<HostedHold>, SyncError> {
        match &self.stopped {
            Some(hold) => Ok(Some(hold.clone())),
            None if self.complete => completed_hold(occupancy, object_id),
            None => Ok(None),
        }
    }
}

/// What a hosted pass's commit did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedCommit {
    /// `false` when the scope moved or another pass committed since the pass
    /// read the replica; nothing committed.
    pub committed: bool,
    /// A document the pass found held is free now, but the pass wrote none
    /// of its files, so it stays held for the next pass, which writes them.
    pub has_more: bool,
}

/// Commit a hosted pass's position. Commits nothing when the scope moved since
/// the pass fetched, since its page may hold rows the current scope
/// withholds, or when another pass committed since it read the replica, since
/// it read from a position and states that one replaced: its caller pulls
/// again. Each document read is settled in the same transaction: held where
/// its read stopped, ready once its read completes with nothing of it waiting
/// in deferred work and its head at its scope's path, both when the pass read
/// it and now, and still backfilling otherwise. So readiness never precedes
/// its content, nor the pass that wrote its files. A held document releases
/// the deferred work it still has to apply, and its read restarts before it.
pub fn commit_hosted_cursor(
    store: &mut EngineStore,
    workspace_id: &str,
    cursor: &HostedCursor,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<HostedCommit>, SyncError> {
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
            return Ok(HostedCommit {
                committed: false,
                has_more: false,
            });
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
        let mut occupancy = Occupancy::new(tx, workspace_id);
        let mut has_more = false;
        for (object_id, read) in &cursor.reads {
            let hold = match read.hold(&mut occupancy, object_id)? {
                // What held it when the pass read it is gone; the next pass
                // writes its heads.
                None if read.complete && !read.heads_written => {
                    has_more = true;
                    Some(HostedHold::WorkWaiting)
                }
                hold => hold,
            };
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
        // A ready document's files are written through its read position:
        // the pass that made it ready wrote its heads, and every committed
        // pass since materialized what it read. One not ready keeps what
        // it applied unwritten until then.
        tx.execute(
            "UPDATE hosted_documents SET unmaterialized_seq=NULL \
             WHERE workspace_id=?1 AND scope_generation=?2 AND state='ready' \
               AND unmaterialized_seq<=MAX(backfill_cursor, \
                 (SELECT main_cursor FROM hosted_replicas WHERE workspace_id=?1))",
            params![workspace_id, generation],
        )
        .map_err(SyncError::persist)?;
        if let Some(report_id) = &cursor.settlement_report_id {
            crate::cursor::release_settlement_report_in_tx(tx, workspace_id, report_id)?;
        }
        Ok(HostedCommit {
            committed: true,
            has_more,
        })
    })
}

/// What holds a document whose read stopped at `op`, its first row that
/// could not apply.
pub(crate) fn stopped_hold(
    occupancy: &mut Occupancy<'_>,
    object_id: &str,
    op: &ReplicationEnvelope,
) -> Result<HostedHold, SyncError> {
    if let Some(hold) = park::parked_hold(occupancy, object_id)? {
        return Ok(hold);
    }
    let conn = occupancy.conn;
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
/// ready: heads still parked, retained work of it still waiting, a live edit
/// it refused, or a head away from the path its scope names. `None` once
/// nothing does.
fn completed_hold(
    occupancy: &mut Occupancy<'_>,
    object_id: &str,
) -> Result<Option<HostedHold>, SyncError> {
    let (conn, workspace_id) = (occupancy.conn, occupancy.workspace_id);
    if let Some(hold) = park::parked_hold(occupancy, object_id)? {
        return Ok(Some(hold));
    }
    if let Some(waiting) = crate::deferred::first_unapplied_hosted(conn, workspace_id, object_id)? {
        return stopped_hold(occupancy, object_id, &waiting).map(Some);
    }
    if live_edit_unadmitted(conn, workspace_id, object_id)? {
        return Ok(Some(HostedHold::LiveEditUnadmitted));
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

/// A write of each head `object_id` has, for the pass whose commit can make
/// it ready: its read reached the end with nothing holding it. The files a
/// document that is not ready left unwritten, after an interrupted pass or a
/// return, come back from its heads, whichever pass or settlement wrote them.
pub(crate) fn head_writes(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    conn.prepare_cached(HEADS_SQL)
        .map_err(SyncError::corrupt)?
        .query_map(params![workspace_id, object_id], |row| {
            Ok(crate::MomentMaterializationChange {
                version_id: row.get(0)?,
                path: row.get(1)?,
                operation: "write",
                content_kind: if row.get::<_, String>(2)? == "binary" {
                    "binary"
                } else {
                    "text"
                },
            })
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<_, _>>()
        .map_err(SyncError::corrupt)
}

/// Each head of a document, by version, read through the version's key.
/// `CROSS JOIN` keeps SQLite from reading every head of the workspace first.
const HEADS_SQL: &str = "SELECT s.version_id,s.path,s.content_kind FROM versions v \
     CROSS JOIN snapshots s ON s.workspace_id=v.workspace_id AND s.version_id=v.version_id \
     WHERE v.workspace_id=?1 AND s.object_id=?2";

/// Which of `stored`, the decisions journaled rows of `object_id`, a document
/// that is not ready, recorded when they applied, its pass materializes
/// again. Materializing a path brings its file to the head there. Its history
/// since may have left those paths to another document or a retired file, so
/// one stands only where nothing holds its path now ([`park::Occupancy`]).
/// None stands at a path that collides with a parked head, which comes back
/// with its own writes once nothing holds it, nor at a current head's own
/// path: the pass that makes it ready writes that, and a document still held
/// writes nothing. One at a current head's path in another case, or inside
/// or above it, stands: its delete clears what is in the way of that head's
/// write, and the materializer runs it first.
pub(crate) fn redelivered_unready(
    occupancy: &mut Occupancy<'_>,
    object_id: &str,
    stored: impl IntoIterator<Item = crate::MomentMaterializationChange>,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    use dohc_engine_files::path_is_held;
    let (conn, workspace_id) = (occupancy.conn, occupancy.workspace_id);
    let parked = park::parked_paths(conn, workspace_id, object_id)?;
    let heads = head_writes(conn, workspace_id, object_id)?;
    let mut standing = Vec::new();
    for change in stored {
        let parked_at = parked.iter().any(|(version_id, path)| {
            *version_id == change.version_id
                && (path_is_held(path, &change.path) || path_is_held(&change.path, path))
        });
        let head_at = heads
            .iter()
            .any(|head| head.version_id == change.version_id && head.path == change.path);
        if !parked_at
            && !head_at
            && occupancy
                .hold(object_id, &change.version_id, &change.path)?
                .is_none()
        {
            standing.push(change);
        }
    }
    Ok(standing)
}

/// Hold the ready document whose ordinary `ydoc.update` at this coordinate
/// was just refused because its live session never admitted it, when the
/// update is of its current lineage. Its content here is now incomplete, so
/// it is no longer ready, in the refusal's own transaction. Its own read
/// starts where the main feed is, which applied everything of it before, and
/// only [`completed_hold`] clears the hold. A document that is not ready
/// meets the refusal there when its read completes.
pub(crate) fn hold_unadmitted_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "UPDATE hosted_documents SET state='held',held_reason=?4,held_path=NULL,held_by=NULL, \
           held_conflict_id=NULL,backfill_cursor=MAX(backfill_cursor, \
             (SELECT main_cursor FROM hosted_replicas WHERE workspace_id=?1)) \
         WHERE workspace_id=?1 AND state='ready' \
           AND scope_generation=(SELECT scope_generation FROM hosted_replicas WHERE workspace_id=?1) \
           AND object_id=(SELECT d.object_id FROM replication_log l JOIN ydoc_docs d \
             ON d.workspace_id=l.workspace_id \
             AND d.version_id=json_extract(l.payload_json,'$.versionId') \
             AND d.object_id=json_extract(l.payload_json,'$.objectId') \
             AND d.lineage_claim_id=json_extract(l.payload_json,'$.lineageClaimId') \
             WHERE l.workspace_id=?1 AND l.origin_id=?2 AND l.origin_seq=?3 \
               AND l.op_kind='ydoc.update')",
        params![workspace_id, origin_id, origin_seq, LIVE_EDIT_UNADMITTED],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// What holds `object_id` as its row records it now, or `None` when its row
/// is not held.
pub(crate) fn recorded_hold(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<HostedHold>, SyncError> {
    let row = conn
        .query_row(
            "SELECT path,state,held_reason,held_path,held_by,held_conflict_id \
             FROM hosted_documents WHERE workspace_id=?1 AND object_id=?2 AND state='held'",
            params![workspace_id, object_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((path, state, reason, held_path, held_by, conflict_id)) = row else {
        return Ok(None);
    };
    Ok(
        match decode_status(
            &path,
            &state,
            reason.as_deref(),
            held_path,
            held_by,
            conflict_id,
        )? {
            HostedDocumentStatus::Held(hold) => Some(hold),
            _ => None,
        },
    )
}

/// Whether this replica refused an ordinary `ydoc.update` of `object_id`'s
/// current lineage because its live session never admitted it. The refusal
/// keeps the row journaled, so no later read applies it.
fn live_edit_unadmitted(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM replication_refused_ydoc_blobs r \
         JOIN replication_log l USING (workspace_id,origin_id,origin_seq) \
         JOIN ydoc_docs d ON d.workspace_id=l.workspace_id \
           AND d.version_id=json_extract(l.payload_json,'$.versionId') \
           AND d.object_id=json_extract(l.payload_json,'$.objectId') \
           AND d.lineage_claim_id=json_extract(l.payload_json,'$.lineageClaimId') \
         WHERE r.workspace_id=?1 AND d.object_id=?2)",
        params![workspace_id, object_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
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
