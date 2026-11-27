//! Relay work held behind a live conflict. Fetch position and application ACK
//! are separate: retaining an envelope permits the former, never the latter.

use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_domain::WaitingVersion;
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};

use dohc_engine_collab::DocKey;

use crate::conflict_resolve_v1::CONVERSION_ID_PREFIX;
use crate::{BlobKind, RelayError, ReplicationEnvelope, SyncError, SyncIdentity};

const MAX_PENDING_OPS: i64 = 10_000;
// Includes payloads and conservatively charges a referenced blob for each op.
const MAX_PENDING_BYTES: i64 = 512 * 1024 * 1024;
const REPLAY_PAGE: i64 = 500;

/// Whether retained op `d` has yet to apply. Both kinds of replica admit
/// sparsely past held work, so the journal answers; an ordinary replica's
/// ack also covers everything at or below it.
const UNAPPLIED: &str =
    "NOT EXISTS(SELECT 1 FROM replication_log l WHERE l.workspace_id=d.workspace_id
        AND l.origin_id=d.origin_id AND l.origin_seq=d.origin_seq)
    AND (EXISTS(SELECT 1 FROM hosted_replicas h WHERE h.workspace_id=d.workspace_id)
      OR d.origin_seq>COALESCE((SELECT a.acked_seq FROM replication_peers a
        WHERE a.workspace_id=d.workspace_id AND a.origin_id=d.origin_id),-1))";

/// The objects and lowercased paths a file op or a note's conversion to
/// format 2 touches. Any other op, or one with no object, has no scope: it
/// waits for all earlier work of its origin, and all later work waits for it.
#[derive(Default)]
struct Scope {
    objects: BTreeSet<String>,
    paths: BTreeSet<String>,
}

fn scope(op: &ReplicationEnvelope) -> Option<Scope> {
    scope_of(&op.op_kind, |field| op.payload.pointer(field))
}

/// A retained op's kind and the payload fields [`scope_of`] reads, in
/// [`SCOPE_PAYLOAD`] order, so a check need not decode whole envelopes.
const SCOPE_JSON: &str = "json_extract(d.envelope_json,'$.opKind','$.payload.conflictId',
    '$.payload.objectId','$.payload.beforeObjectId','$.payload.path',
    '$.payload.payloadBeforePath','$.payload.payloadAfterPath','$.payload.beforePath',
    '$.payload.transition.current.objectId','$.payload.paths[0]',
    '$.payload.resolution','$.payload.effects')";
const SCOPE_PAYLOAD: [&str; 11] = [
    "/conflictId",
    "/objectId",
    "/beforeObjectId",
    "/path",
    "/payloadBeforePath",
    "/payloadAfterPath",
    "/beforePath",
    NOTE_OBJECT,
    NOTE_PATH,
    "/resolution",
    "/effects",
];
const NOTE_OBJECT: &str = "/transition/current/objectId";
const NOTE_PATH: &str = "/paths/0";

fn conversion_json() -> String {
    format!(
        "json_extract(d.envelope_json,'$.opKind')='conflict.resolve'
        AND substr(json_extract(d.envelope_json,'$.payload.conflictId'),1,{})='{CONVERSION_ID_PREFIX}'
        AND json_extract(d.envelope_json,'$.payload.resolution')='kept-current'
        AND json_array_length(d.envelope_json,'$.payload.effects')=0",
        CONVERSION_ID_PREFIX.len()
    )
}

fn file_json() -> String {
    format!(
        "COALESCE(json_extract(d.envelope_json,'$.payload.objectId'),CASE WHEN {}
        THEN json_extract(d.envelope_json,'$.payload.transition.current.objectId') END)",
        conversion_json()
    )
}

pub(crate) fn base_retained(
    conn: &Connection,
    key: &DocKey,
    claim: &str,
) -> Result<bool, SyncError> {
    conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM relay_deferred_ops d WHERE d.workspace_id=?1 AND {UNAPPLIED}
             AND json_extract(d.envelope_json,'$.opKind')='ydoc.update'
             AND json_extract(d.envelope_json,'$.payload.versionId')=?2
             AND json_extract(d.envelope_json,'$.payload.objectId')=?3
             AND json_extract(d.envelope_json,'$.payload.lineageClaimId')=?4
             AND json_extract(d.envelope_json,'$.payload.isBaseState')=1
             AND NOT EXISTS(SELECT 1 FROM snapshots s WHERE s.workspace_id=?1 AND s.version_id=?2
               AND s.path=json_extract(d.envelope_json,'$.payload.path') AND s.object_id!=?3))"
        ),
        params![key.workspace_id, key.version_id, key.object_id, claim],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

pub(crate) fn wait_for_conversion(
    conn: &Connection,
    key: &DocKey,
    claim: &str,
) -> Result<(), SyncError> {
    let retained: bool = conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM relay_deferred_ops d WHERE d.workspace_id=?1 AND {UNAPPLIED}
             AND {}
             AND json_extract(d.envelope_json,'$.payload.targetVersionId')=?2
             AND json_extract(d.envelope_json,'$.payload.transition.current.objectId')=?3
             AND json_extract(d.envelope_json,'$.payload.lineageTransition.successor.lineageClaimId')=?4)",
            conversion_json()
        ),
        params![key.workspace_id, key.version_id, key.object_id, claim],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)?;
    if retained {
        return Err(SyncError::RetryableState {
            reason: crate::conflict_resolve_v1::CONVERSION_PENDING,
        });
    }
    Ok(())
}

fn file_of(op: &ReplicationEnvelope) -> &str {
    let field = match (op.op_kind.as_str(), scope(op)) {
        ("conflict.resolve", Some(_)) => NOTE_OBJECT,
        _ => "/objectId",
    };
    op.payload
        .pointer(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

fn retained_scope(fields: &str) -> Result<Option<Scope>, SyncError> {
    let fields: Vec<serde_json::Value> =
        serde_json::from_str(fields).map_err(SyncError::corrupt)?;
    let op_kind = fields
        .first()
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let payload: BTreeMap<&str, &serde_json::Value> = SCOPE_PAYLOAD
        .into_iter()
        .zip(fields.iter().skip(1))
        .collect();
    Ok(scope_of(op_kind, |field| payload.get(field).copied()))
}

fn scope_of<'a>(
    op_kind: &str,
    field: impl Fn(&str) -> Option<&'a serde_json::Value>,
) -> Option<Scope> {
    let conflict = field("/conflictId").filter(|id| !id.is_null());
    let (objects, paths): (&[&str], &[&str]) = match (op_kind, conflict) {
        ("moment.append" | "ydoc.update", None) => (
            &["/objectId", "/beforeObjectId"],
            &[
                "/path",
                "/payloadBeforePath",
                "/payloadAfterPath",
                "/beforePath",
            ],
        ),
        ("conflict.resolve", Some(id))
            if id
                .as_str()
                .is_some_and(|id| id.starts_with(CONVERSION_ID_PREFIX))
                && field("/resolution").and_then(serde_json::Value::as_str)
                    == Some("kept-current")
                && field("/effects")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(Vec::is_empty) =>
        {
            (&[NOTE_OBJECT], &[NOTE_PATH])
        }
        _ => return None,
    };
    let text = |name: &str| field(name).and_then(serde_json::Value::as_str);
    let objects: BTreeSet<String> = objects
        .iter()
        .copied()
        .filter_map(text)
        .map(str::to_owned)
        .collect();
    if objects.is_empty() {
        return None;
    }
    let paths = paths
        .iter()
        .copied()
        .filter_map(text)
        .map(str::to_lowercase)
        .collect();
    Some(Scope { objects, paths })
}

fn path_overlaps(left: &str, right: &str) -> bool {
    let under = |inner: &str, outer: &str| {
        inner.len() > outer.len()
            && inner.starts_with(outer)
            && inner.as_bytes()[outer.len()] == b'/'
    };
    left == right || under(left, right) || under(right, left)
}

impl Scope {
    fn merge(&mut self, other: Scope) {
        self.objects.extend(other.objects);
        self.paths.extend(other.paths);
    }

    fn independent(&self, other: &Scope) -> bool {
        self.objects.is_disjoint(&other.objects)
            && !self
                .paths
                .iter()
                .any(|left| other.paths.iter().any(|right| path_overlaps(left, right)))
    }
}

/// The key an ordinary pass holds `op` under: its origin and file, or the
/// origin alone for an op with no scope.
pub(crate) fn hold_key(op: &ReplicationEnvelope) -> String {
    match scope(op) {
        Some(_) => format!("{}\u{1f}{}", op.origin_id, file_of(op)),
        None => op.origin_id.clone(),
    }
}

/// Whether ordinary op `op` may apply although its origin's ops after
/// `acked` and before it have not all applied: each of them applied, or
/// waits retained here on files and paths `op` does not touch.
pub(crate) fn passes_held_work(
    tx: &rusqlite::Transaction<'_>,
    op: &ReplicationEnvelope,
    acked: i64,
) -> Result<bool, SyncError> {
    let Some(mine) = scope(op) else {
        return Ok(false);
    };
    // An op past the ack applied, or was retained, only once each op before
    // it had applied or was retained, and retained work leaves only once it
    // applies. So the op just before `op` answers for all of them.
    let covered: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM replication_log
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3)
               OR EXISTS(SELECT 1 FROM relay_deferred_ops
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3)",
            params![op.workspace_id, op.origin_id, op.origin_seq - 1],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !covered {
        return Ok(false);
    }
    let mut stmt = tx
        .prepare_cached(&format!(
            "SELECT DISTINCT {SCOPE_JSON} FROM relay_deferred_ops d
             WHERE d.workspace_id=?1 AND d.origin_id=?2 AND d.origin_seq>?3 AND d.origin_seq<?4
               AND {UNAPPLIED}"
        ))
        .map_err(SyncError::corrupt)?;
    let waiting = stmt
        .query_map(
            params![op.workspace_id, op.origin_id, acked, op.origin_seq],
            |r| r.get::<_, String>(0),
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    for fields in waiting {
        if !retained_scope(&fields)?.is_some_and(|theirs| mine.independent(&theirs)) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn local(error: impl std::fmt::Display) -> RelayError {
    RelayError::Local(error.to_string())
}

fn mismatched(
    conn: &Connection,
    workspace: &str,
    identity: &SyncIdentity,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM relay_deferred_ops WHERE workspace_id=?1
         AND (replication_epoch!=?2 OR stream_identity!=?3))",
        params![
            workspace,
            identity.replication_epoch,
            identity.stream_identity
        ],
        |r| r.get(0),
    )
}

const MISMATCHED: &str = "deferred relay work belongs to another replication epoch or stream";

pub(crate) fn read(
    store: &EngineStore,
    workspace: &str,
    identity: &SyncIdentity,
) -> Result<(Vec<ReplicationEnvelope>, BTreeSet<String>), RelayError> {
    store.read_with(|conn| {
        let mismatched = mismatched(conn, workspace, identity)?;

        let mut stmt = conn.prepare(&format!(
            "SELECT DISTINCT d.origin_id FROM relay_deferred_ops d WHERE d.workspace_id=?1 AND {UNAPPLIED}"))?;
        let origins = stmt.query_map([workspace], |r| r.get(0))?
            .collect::<Result<BTreeSet<String>, _>>()?;
        // Origins take turns by when any of their work was last checked, and
        // within one, files take turns by when their work was last checked,
        // then share the page op by op, so held files cannot keep a ready
        // file out of it.
        let mut stmt = conn.prepare(&format!(
            "SELECT d.envelope_json FROM relay_deferred_ops d JOIN
             (SELECT origin_id,MAX(checked_sequence) AS checked FROM relay_deferred_ops
              WHERE workspace_id=?1 GROUP BY origin_id) q ON q.origin_id=d.origin_id
             WHERE d.workspace_id=?1
             WINDOW file AS (PARTITION BY d.origin_id,{})
             ORDER BY q.checked,d.origin_id,MIN(d.checked_sequence) OVER file,
               ROW_NUMBER() OVER (file ORDER BY d.origin_seq),d.origin_seq LIMIT ?2", file_json()))?;
        let encoded = stmt.query_map(params![workspace, REPLAY_PAGE], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, rusqlite::Error>((mismatched, encoded, origins))
    }).map_err(local).and_then(|(mismatched, encoded, origins)| {
        if mismatched { return Err(local(MISMATCHED)); }
        let ops = encoded.into_iter().map(|s| serde_json::from_str(&s).map_err(local))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((ops, origins))
    })
}

/// A hosted pass's share of retained work.
pub(crate) struct HostedReplay {
    /// One page of the current scope's retained work.
    pub(crate) ops: Vec<ReplicationEnvelope>,
    /// Each scoped document with unapplied retained work, and the relay
    /// position of the first such op the page leaves out, if any.
    pub(crate) documents: BTreeMap<String, Option<i64>>,
}

/// The retained work of the documents in the current scope, in pages that
/// keep each document's work in relay order. Documents take turns by when
/// their work was last checked, so a held document cannot starve another,
/// and a document that left the scope keeps its work for its removal.
const HOSTED_PAGE: &str = "scoped AS (
    SELECT d.origin_id,d.origin_seq,d.envelope_json,d.checked_sequence,h.object_id,h.relay_seq,
      {UNAPPLIED} AS unapplied
    FROM relay_deferred_ops d
    JOIN hosted_deferred_ops h ON h.workspace_id=d.workspace_id
      AND h.origin_id=d.origin_id AND h.origin_seq=d.origin_seq
    JOIN hosted_replicas r ON r.workspace_id=d.workspace_id
    JOIN hosted_documents s ON s.workspace_id=d.workspace_id AND s.object_id=h.object_id
      AND s.scope_generation=r.scope_generation
    WHERE d.workspace_id=?1),
  page AS (
    SELECT w.origin_id,w.origin_seq,w.envelope_json,w.relay_seq FROM scoped w
    JOIN (SELECT object_id,MIN(checked_sequence) AS turn FROM scoped GROUP BY object_id) t
      ON t.object_id=w.object_id
    ORDER BY t.turn,w.object_id,w.relay_seq LIMIT ?2)";

pub(crate) fn read_hosted(
    store: &EngineStore,
    workspace: &str,
    identity: &SyncIdentity,
) -> Result<HostedReplay, RelayError> {
    let page = HOSTED_PAGE.replace("{UNAPPLIED}", UNAPPLIED);
    store
        .read_with(|conn| {
            let mismatched = mismatched(conn, workspace, identity)?;
            let mut stmt = conn.prepare(&format!(
                "WITH {page} SELECT envelope_json FROM page ORDER BY relay_seq"
            ))?;
            let encoded = stmt
                .query_map(params![workspace, REPLAY_PAGE], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut stmt = conn.prepare(&format!(
                "WITH {page} SELECT w.object_id,MIN(CASE WHEN p.origin_id IS NULL THEN w.relay_seq END)
                 FROM scoped w LEFT JOIN page p ON p.origin_id=w.origin_id AND p.origin_seq=w.origin_seq
                 WHERE w.unapplied GROUP BY w.object_id"
            ))?;
            let documents = stmt
                .query_map(params![workspace, REPLAY_PAGE], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect::<Result<BTreeMap<_, _>, _>>()?;
            Ok::<_, rusqlite::Error>((mismatched, encoded, documents))
        })
        .map_err(local)
        .and_then(|(mismatched, encoded, documents)| {
            if mismatched {
                return Err(local(MISMATCHED));
            }
            let ops = encoded
                .into_iter()
                .map(|s| serde_json::from_str(&s).map_err(local))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(HostedReplay { ops, documents })
        })
}

/// The first of `object_id`'s retained work, in relay order, still to apply.
pub(crate) fn first_unapplied_hosted(
    conn: &Connection,
    workspace: &str,
    object_id: &str,
) -> Result<Option<ReplicationEnvelope>, SyncError> {
    let encoded: Option<String> = conn
        .query_row(
            &format!(
                "SELECT d.envelope_json FROM relay_deferred_ops d JOIN hosted_deferred_ops h
                 ON h.workspace_id=d.workspace_id AND h.origin_id=d.origin_id AND h.origin_seq=d.origin_seq
                 WHERE d.workspace_id=?1 AND h.object_id=?2 AND {UNAPPLIED}
                 ORDER BY h.relay_seq LIMIT 1"
            ),
            params![workspace, object_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    encoded
        .map(|encoded| serde_json::from_str(&encoded).map_err(SyncError::corrupt))
        .transpose()
}

/// Release `object_id`'s retained work still to apply, answering the relay
/// position of the first released op. A held document retains nothing: its
/// own read fetches the work again from before that position.
pub(crate) fn release_hosted_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace: &str,
    object_id: &str,
) -> Result<Option<i64>, SyncError> {
    let retained = format!(
        "FROM relay_deferred_ops d JOIN hosted_deferred_ops h
         ON h.workspace_id=d.workspace_id AND h.origin_id=d.origin_id AND h.origin_seq=d.origin_seq
         WHERE d.workspace_id=?1 AND h.object_id=?2 AND {UNAPPLIED}"
    );
    let first: Option<i64> = tx
        .query_row(
            &format!("SELECT MIN(h.relay_seq) {retained}"),
            params![workspace, object_id],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if first.is_some() {
        tx.execute(
            &format!(
                "DELETE FROM relay_deferred_ops WHERE workspace_id=?1 AND (origin_id,origin_seq) IN
                 (SELECT d.origin_id,d.origin_seq {retained})"
            ),
            params![workspace, object_id],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(first)
}

/// The relay namespace a hosted replica recorded when it retained `op`, or
/// none when it recorded none; `None` when nothing hosted retains `op`. A
/// replay decides under the feed the op arrived on, never the current one.
pub(crate) fn retained_namespace(
    store: &EngineStore,
    op: &ReplicationEnvelope,
) -> Result<Option<Option<String>>, RelayError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT relay_namespace FROM relay_deferred_ops WHERE workspace_id=?1 \
                 AND origin_id=?2 AND origin_seq=?3 AND ingress_kind<>'local'",
                params![op.workspace_id, op.origin_id, op.origin_seq],
                |row| row.get(0),
            )
            .optional()
        })
        .map_err(local)
}

/// The stable code of a version that waits behind its conflict.
pub const WAITING_VERSION_CODE: &str = crate::moment_apply::RESOLVE_EXISTING_CONFLICT;

/// The newer version that waits behind each of `conflict_ids` still open
/// from sync, by conflict id. Only a retained op still to apply that waits
/// behind none of its origin's earlier retained work can wait on a conflict.
/// A hosted replica reads none here: it retains by document, not origin.
pub fn waiting_versions(
    store: &EngineStore,
    workspace: &str,
    conflict_ids: &[&str],
) -> Result<BTreeMap<String, WaitingVersion>, SyncError> {
    store.read_with(|conn| {
        let mut waiting = BTreeMap::new();
        if conflict_ids.is_empty() || crate::hosted::is_hosted(conn, workspace)? {
            return Ok(waiting);
        }
        let mut stmt = conn
            .prepare(
                "SELECT target_version_id,incoming_object_id,incoming_latest_moment_id FROM conflicts \
                 WHERE workspace_id=?1 AND conflict_id=?2 AND status='open' AND metadata_origin='sync' \
                   AND incoming_object_id IS NOT NULL",
            )
            .map_err(SyncError::corrupt)?;
        let mut open = Vec::new();
        for id in conflict_ids {
            let row: Option<(String, String, Option<String>)> = stmt
                .query_row(params![workspace, id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()
                .map_err(SyncError::corrupt)?;
            open.extend(row.map(|row| (*id, row)));
        }
        if open.is_empty() {
            return Ok(waiting);
        }
        let mut stmt = conn
            .prepare(&format!(
                "SELECT d.envelope_json FROM relay_deferred_ops d
                 WHERE d.workspace_id=?1 AND {UNAPPLIED} ORDER BY d.origin_id,d.origin_seq"
            ))
            .map_err(SyncError::corrupt)?;
        let encoded = stmt
            .query_map([workspace], |r| r.get::<_, String>(0))
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        // What each origin's earlier retained work touches, or `None` once
        // an op with no scope holds the rest.
        let mut earlier: BTreeMap<String, Option<Scope>> = BTreeMap::new();
        for encoded in encoded {
            let op: ReplicationEnvelope =
                serde_json::from_str(&encoded).map_err(SyncError::corrupt)?;
            let mine = scope(&op);
            let behind = match (earlier.get(&op.origin_id), &mine) {
                (None, _) => false,
                (Some(Some(before)), Some(mine)) => !mine.independent(before),
                _ => true,
            };
            let before = earlier
                .entry(op.origin_id.clone())
                .or_insert_with(|| Some(Scope::default()));
            match (before.as_mut(), mine) {
                (Some(before), Some(mine)) => before.merge(mine),
                _ => *before = None,
            }
            if behind || op.op_kind != "moment.append" {
                continue;
            }
            let field = |name: &str| op.payload[name].as_str();
            let (Some(object), Some(version)) = (field("objectId"), field("versionId")) else {
                continue;
            };
            let before = field("beforeLatestMomentId");
            // The open-conflict hold in moment_apply.rs (RESOLVE_EXISTING_CONFLICT):
            // the same object and version, on another branch than the
            // conflict's incoming side.
            for (id, (target, incoming, incoming_latest)) in &open {
                if target == version && incoming == object && incoming_latest.as_deref() != before {
                    waiting.entry((*id).to_owned()).or_insert_with(|| WaitingVersion {
                        object_id: object.to_owned(),
                        origin_id: op.origin_id.clone(),
                        origin_seq: op.origin_seq,
                    });
                }
            }
        }
        Ok(waiting)
    })
}

pub(crate) fn has_unapplied(store: &EngineStore, workspace: &str) -> Result<bool, RelayError> {
    store
        .read_with(|conn| {
            conn.query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM relay_deferred_ops d WHERE d.workspace_id=?1 AND {UNAPPLIED})"
                ),
                [workspace],
                |row| row.get(0),
            )
        })
        .map_err(local)
}

pub(crate) fn check_redelivery(
    store: &EngineStore,
    ops: &[ReplicationEnvelope],
) -> Result<(), RelayError> {
    store.read_with(|conn| {
        for op in ops {
            let saved: Option<String> = conn.query_row(
                "SELECT envelope_json FROM relay_deferred_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![op.workspace_id,op.origin_id,op.origin_seq], |r| r.get(0))
                .optional().map_err(SyncError::corrupt)?;
            if let Some(saved) = saved {
                let saved: ReplicationEnvelope = serde_json::from_str(&saved).map_err(SyncError::corrupt)?;
                if saved != *op { return Err(SyncError::CoordinateDiverged); }
            }
        }
        Ok::<_, SyncError>(())
    }).map_err(local)
}

/// [`retain_waiting`] with no origin held by a conflict.
#[cfg(test)]
pub(crate) fn retain(
    store: &mut EngineStore,
    identity: &SyncIdentity,
    relay_namespace: Option<&str>,
    ops: &[&ReplicationEnvelope],
    faults: &dyn FaultInjector,
) -> Result<BTreeSet<String>, RelayError> {
    retain_waiting(
        store,
        identity,
        relay_namespace,
        ops,
        &BTreeMap::new(),
        faults,
    )
}

/// The stable code of an ordinary origin that passed the retention limit
/// while it waits on a conflict.
pub(crate) const CONFLICT_WAIT_LIMIT: &str = "conflict-wait-limit";

/// Retain `ops` within the workspace's limit. Past it, an ordinary replica
/// fails and retains nothing. A hosted replica never fails: a document whose
/// next op would pass it retains no more, and is answered so its read can
/// stop at that op instead. Each hosted op records the feed it arrived on,
/// `relay_namespace` as the pull's trusted configuration names it; a hosted
/// pull it names none for retains nothing and fails. `conflict_waits` names
/// each origin held by a conflict with the conflict's path, so passing the
/// limit says what to resolve.
pub(crate) fn retain_waiting(
    store: &mut EngineStore,
    identity: &SyncIdentity,
    relay_namespace: Option<&str>,
    ops: &[&ReplicationEnvelope],
    conflict_waits: &BTreeMap<String, Option<String>>,
    faults: &dyn FaultInjector,
) -> Result<BTreeSet<String>, RelayError> {
    let mut limit_detail = None;
    let relay_namespace = relay_namespace.filter(|namespace| !namespace.is_empty());
    if ops.is_empty() {
        return Ok(BTreeSet::new());
    }
    let blobs = ops
        .iter()
        .map(|op| crate::relay::blob_refs_to_apply(store, std::slice::from_ref(*op)))
        .collect::<Result<Vec<_>, _>>()?;
    let outcome = store.write_with(faults, |tx| {
        let hosted = crate::hosted::is_hosted(tx, &ops[0].workspace_id)?;
        let (mut count, mut bytes): (i64,i64) = tx.query_row(
            "SELECT COUNT(*),COALESCE(SUM(retained_bytes),0) FROM relay_deferred_ops WHERE workspace_id=?1",
            [&ops[0].workspace_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)?;
        let mut unretained = BTreeSet::new();
        for (op, blobs) in ops.iter().zip(&blobs) {
            op.validate()?;
            let json = serde_json::to_string(op).map_err(SyncError::corrupt)?;
            let previous: Option<String> = tx.query_row(
                "SELECT envelope_json FROM relay_deferred_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![op.workspace_id,op.origin_id,op.origin_seq], |r| r.get(0)).optional().map_err(SyncError::corrupt)?;
            if let Some(previous) = previous {
                let saved: ReplicationEnvelope = serde_json::from_str(&previous).map_err(SyncError::corrupt)?;
                if saved != **op { return Err(SyncError::CoordinateDiverged); }
                continue;
            }
            // A hosted replica's origins arrive sparse, and the journal, not a
            // sequence, says what applied. It replays each document in relay
            // order, so it keeps both with the op.
            let placed = if hosted {
                let object_id = crate::hosted::hosted_document(op).ok_or(SyncError::InvalidInput {
                    reason: "a hosted replica retains only its documents' work",
                })?;
                let relay_seq = op.relay_seq.filter(|seq| *seq > 0).ok_or(SyncError::InvalidInput {
                    reason: "retained hosted work has no relay position",
                })?;
                Some((object_id, relay_seq))
            } else {
                let last: i64 = tx.query_row(
                    "SELECT MAX(COALESCE((SELECT MAX(origin_seq) FROM relay_deferred_ops WHERE workspace_id=?1 AND origin_id=?2),-1),
                     COALESCE((SELECT acked_seq FROM replication_peers WHERE workspace_id=?1 AND origin_id=?2),-1))",
                    params![op.workspace_id,op.origin_id], |r| r.get(0)).map_err(SyncError::corrupt)?;
                // Ops between the last retained or acknowledged one and this
                // one applied ahead of held work.
                let skipped: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>?3 AND origin_seq<?4",
                    params![op.workspace_id,op.origin_id,last,op.origin_seq], |r| r.get(0)).map_err(SyncError::corrupt)?;
                if last.checked_add(1 + skipped) != Some(op.origin_seq) { return Err(SyncError::SequenceGap); }
                None
            };
            // A document's retained work stays a prefix of its unapplied work.
            if let Some((object_id, _)) = placed && unretained.contains(object_id) {
                continue;
            }
            let mut charged = Vec::new();
            for (digest, kinds) in blobs {
                // Binary and Y.Doc bytes share one row, so each is charged once.
                for text in kinds.iter().map(|kind| *kind == BlobKind::Text).collect::<BTreeSet<_>>() {
                    let table = if text { "blobs" } else { "binary_blobs" };
                    let bytes: i64 = tx.query_row(&format!("SELECT byte_length FROM {table} WHERE sha256=?1"),
                        [digest], |r| r.get(0)).map_err(SyncError::corrupt)?;
                    charged.push((digest, text, bytes));
                }
            }
            let cost = json.len() as i64 + charged.iter().map(|(_, _, bytes)| bytes).sum::<i64>();
            // A hosted pull no configured host names a feed for fails
            // rather than stop at the same op on every pass.
            if hosted && relay_namespace.is_none() {
                return Err(SyncError::RetryableState {
                    reason: crate::ydoc_apply::HOSTED_DEFERRAL_UNNAMED,
                });
            }
            if count >= MAX_PENDING_OPS || bytes + cost > MAX_PENDING_BYTES {
                match placed {
                    Some((object_id, _)) => {
                        unretained.insert(object_id.to_owned());
                        continue;
                    }
                    None => {
                        let Some(path) = conflict_waits.get(&op.origin_id) else {
                            return Err(SyncError::RetryableState { reason: "deferred relay work limit reached; close the conflicting editor to resume sync" });
                        };
                        let sentence = match path {
                            Some(path) => format!("Changes from another computer are waiting on the conflict in {path}. They reached a limit, so dohc stopped receiving changes. Resolve the conflict to receive changes again."),
                            None => "Changes from another computer are waiting on a conflict. They reached a limit, so dohc stopped receiving changes. Resolve the conflict to receive changes again.".to_owned(),
                        };
                        let path = path.as_ref().map(|path| format!("path {path}, ")).unwrap_or_default();
                        limit_detail = Some(format!(
                            "{CONFLICT_WAIT_LIMIT}: {sentence} ({path}origin {} seq {}, retained ops {count}, retained bytes {bytes})",
                            op.origin_id, op.origin_seq,
                        ));
                        return Err(SyncError::RetryableState { reason: CONFLICT_WAIT_LIMIT });
                    }
                }
            }
            // It waits its turn with the rest of its document's work or, on an
            // ordinary replica, its origin's.
            let turn: Option<i64> = match placed {
                Some((object_id, _)) => tx.query_row(
                    "SELECT MAX(d.checked_sequence) FROM relay_deferred_ops d JOIN hosted_deferred_ops h
                     ON h.workspace_id=d.workspace_id AND h.origin_id=d.origin_id AND h.origin_seq=d.origin_seq
                     WHERE h.workspace_id=?1 AND h.object_id=?2",
                    params![op.workspace_id,object_id], |r| r.get(0)),
                None => tx.query_row(
                    "SELECT MAX(checked_sequence) FROM relay_deferred_ops WHERE workspace_id=?1 AND origin_id=?2",
                    params![op.workspace_id,op.origin_id], |r| r.get(0)),
            }.map_err(SyncError::corrupt)?;
            let inserted = tx.execute(
                "INSERT INTO relay_deferred_ops
                 (workspace_id,origin_id,origin_seq,replication_epoch,stream_identity,envelope_json,retained_bytes,checked_sequence,
                  ingress_kind,relay_namespace)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,
                    COALESCE(?8,(SELECT MAX(checked_sequence) FROM relay_deferred_ops WHERE workspace_id=?1),0),?9,?10)
                 ON CONFLICT DO NOTHING",
                params![op.workspace_id,op.origin_id,op.origin_seq,identity.replication_epoch,identity.stream_identity,json,cost,turn,
                    if hosted { "hosted" } else { "local" }, relay_namespace.filter(|_| hosted)])
                .map_err(SyncError::persist)?;
            if inserted == 0 { continue; }
            if let Some((object_id, relay_seq)) = placed {
                tx.execute(
                    "INSERT INTO hosted_deferred_ops (workspace_id,origin_id,origin_seq,object_id,relay_seq)
                     VALUES (?1,?2,?3,?4,?5)",
                    params![op.workspace_id,op.origin_id,op.origin_seq,object_id,relay_seq])
                    .map_err(SyncError::persist)?;
            }
            for (digest, text, _) in charged {
                tx.execute(
                    "INSERT OR IGNORE INTO relay_deferred_blobs
                     (workspace_id,origin_id,origin_seq,sha256,is_text,text_sha256,binary_sha256)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![op.workspace_id,op.origin_id,op.origin_seq,digest,text,text.then_some(digest),(!text).then_some(digest)])
                    .map_err(SyncError::persist)?;
            }
            count += 1;
            bytes += cost;
        }
        Ok::<_,SyncError>(unretained)
    }).map_err(|error| limit_detail.take().map_or_else(|| local(error), RelayError::Local))?;
    match outcome {
        TxnOutcome::Committed(unretained) => Ok(unretained),
        TxnOutcome::Crashed { .. } => Err(local("injected-crash")),
    }
}

/// Reuse the pending cursor's settlement report token. Rows stay pinned until
/// the caller materializes the report and commits that exact token.
pub(crate) fn claim_report(
    store: &mut EngineStore,
    workspace: &str,
    checked: &[ReplicationEnvelope],
    completed: &[&ReplicationEnvelope],
    report: &mut Option<String>,
    faults: &dyn FaultInjector,
) -> Result<bool, RelayError> {
    let pending: bool = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM relay_deferred_ops WHERE workspace_id=?1)",
                [workspace],
                |row| row.get(0),
            )
        })
        .map_err(local)?;
    if !pending {
        return Ok(false);
    }
    let outcome = store.write_with(faults, |tx| {
        let next: i64 = tx.query_row("SELECT COALESCE(MAX(checked_sequence),0)+1 FROM relay_deferred_ops WHERE workspace_id=?1",
            [workspace], |r| r.get(0)).map_err(SyncError::corrupt)?;
        if crate::hosted::is_hosted(tx, workspace)? {
            for object_id in checked.iter().filter_map(crate::hosted::hosted_document).collect::<BTreeSet<_>>() {
                tx.execute("UPDATE relay_deferred_ops SET checked_sequence=?3 WHERE workspace_id=?1 AND (origin_id,origin_seq) IN
                    (SELECT origin_id,origin_seq FROM hosted_deferred_ops WHERE workspace_id=?1 AND object_id=?2)",
                    params![workspace,object_id,next]).map_err(SyncError::persist)?;
            }
        } else {
            let mut files: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
            for op in checked {
                files.entry(&op.origin_id).or_default().insert(file_of(op));
            }
            for (origin, objects) in files {
                let objects = serde_json::to_string(&objects).map_err(SyncError::corrupt)?;
                tx.execute(&format!("UPDATE relay_deferred_ops AS d SET checked_sequence=?4 WHERE d.workspace_id=?1 AND d.origin_id=?2
                    AND COALESCE({},'') IN (SELECT value FROM json_each(?3))", file_json()),
                    params![workspace,origin,objects,next]).map_err(SyncError::persist)?;
            }
        }
        let mut claimed = false;
        for op in completed {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM relay_deferred_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3)",
                params![workspace,op.origin_id,op.origin_seq], |r| r.get(0)).map_err(SyncError::corrupt)?;
            if !exists { continue; }
            if report.is_none() {
                *report = Some(tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0)).map_err(SyncError::corrupt)?);
            }
            tx.execute("UPDATE relay_deferred_ops SET report_id=?4 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![workspace,op.origin_id,op.origin_seq,report.as_deref()]).map_err(SyncError::persist)?;
            claimed = true;
        }
        // Only productive replay asks for another immediate pass. Held leases
        // otherwise wait for the next normal sync, rather than spinning.
        let more: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM relay_deferred_ops WHERE workspace_id=?1 AND report_id IS NULL)",
            [workspace], |r| r.get(0)).map_err(SyncError::corrupt)?;
        Ok::<_,SyncError>(claimed && more)
    }).map_err(local)?;
    match outcome {
        TxnOutcome::Committed(more) => Ok(more),
        TxnOutcome::Crashed { .. } => Err(local("injected-crash")),
    }
}
