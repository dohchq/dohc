//! Relay work held behind a live conflict. Fetch position and application ACK
//! are separate: retaining an envelope permits the former, never the latter.

use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{BlobKind, RelayError, ReplicationEnvelope, SyncError, SyncIdentity};

const MAX_PENDING_OPS: i64 = 10_000;
// Includes payloads and conservatively charges a referenced blob for each op.
const MAX_PENDING_BYTES: i64 = 512 * 1024 * 1024;
const REPLAY_PAGE: i64 = 500;

/// Whether retained op `d` has yet to apply. An ordinary replica admits each
/// origin contiguously, so its ack answers; a hosted replica admits sparsely,
/// so only its journal does.
const UNAPPLIED: &str =
    "CASE WHEN EXISTS(SELECT 1 FROM hosted_replicas h WHERE h.workspace_id=d.workspace_id)
    THEN NOT EXISTS(SELECT 1 FROM replication_log l WHERE l.workspace_id=d.workspace_id
        AND l.origin_id=d.origin_id AND l.origin_seq=d.origin_seq)
    ELSE d.origin_seq>COALESCE((SELECT a.acked_seq FROM replication_peers a
        WHERE a.workspace_id=d.workspace_id AND a.origin_id=d.origin_id),-1) END";

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
        let mut stmt = conn.prepare(
            "SELECT d.envelope_json FROM relay_deferred_ops d JOIN
             (SELECT origin_id,MIN(checked_sequence) AS checked FROM relay_deferred_ops
              WHERE workspace_id=?1 GROUP BY origin_id) q ON q.origin_id=d.origin_id
             WHERE d.workspace_id=?1 ORDER BY q.checked,d.origin_id,d.origin_seq LIMIT ?2")?;
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

/// Retain `ops` within the workspace's limit. Past it, an ordinary replica
/// fails and retains nothing. A hosted replica never fails: a document whose
/// next op would pass it retains no more, and is answered so its read can
/// stop at that op instead. Each hosted op records the feed it arrived on,
/// `relay_namespace` as the pull's trusted configuration names it; a hosted
/// pull it names none for retains nothing and fails.
pub(crate) fn retain(
    store: &mut EngineStore,
    identity: &SyncIdentity,
    relay_namespace: Option<&str>,
    ops: &[&ReplicationEnvelope],
    faults: &dyn FaultInjector,
) -> Result<BTreeSet<String>, RelayError> {
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
                if last.checked_add(1) != Some(op.origin_seq) { return Err(SyncError::SequenceGap); }
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
                    None => return Err(SyncError::RetryableState { reason: "deferred relay work limit reached; close the conflicting editor to resume sync" }),
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
    }).map_err(local)?;
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
            for origin in checked.iter().map(|op| &op.origin_id).collect::<BTreeSet<_>>() {
                tx.execute("UPDATE relay_deferred_ops SET checked_sequence=?3 WHERE workspace_id=?1 AND origin_id=?2",
                    params![workspace,origin,next]).map_err(SyncError::persist)?;
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
