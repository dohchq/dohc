use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::SyncError;
use crate::model::{MAX_PULL_OPS, ReplicationEnvelope, bounded};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncIdentity {
    pub workspace_id: String,
    pub origin_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[cfg(any(test, feature = "fault-injection"))]
pub(crate) fn crashes(faults: &dyn FaultInjector, point: FaultPoint) -> bool {
    faults.poll(point) == dohc_engine_storage::FaultAction::Crash
}

#[cfg(not(any(test, feature = "fault-injection")))]
pub(crate) fn crashes(_faults: &dyn FaultInjector, _point: FaultPoint) -> bool {
    false
}

/// Transaction-composable local journal append for callers that must commit
/// an op in the SAME transaction as a domain mutation (the live-session
/// `ydoc.update` delta: blob-before-log holds because the CRDT append stored
/// the blob earlier in this transaction). Requires an EXISTING sync identity —
/// a replicated, base-claimed lineage cannot exist without one.
pub fn journal_local_op_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    op_kind: &str,
    payload: &serde_json::Value,
    now_ms: i64,
) -> Result<i64, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    if op_kind.is_empty() || op_kind.len() > crate::model::MAX_OP_KIND_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "op_kind must be non-empty and bounded",
        });
    }
    let payload_json = serde_json::to_string(payload).map_err(|_| SyncError::InvalidInput {
        reason: "payload is not valid JSON",
    })?;
    if payload_json.len() > crate::model::MAX_PAYLOAD_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "payload exceeds the relay limit",
        });
    }
    let origin_id: String = tx
        .query_row(
            "SELECT origin_id FROM sync_identity WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::InvalidInput {
            reason: "no sync identity for a replicated journal append",
        })?;
    let previous: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(origin_seq), -1) FROM replication_log              WHERE workspace_id = ?1 AND origin_id = ?2",
            params![workspace_id, origin_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !(-1..crate::MAX_WIRE_INTEGER).contains(&previous) {
        return Err(SyncError::CoordinateDiverged);
    }
    let origin_seq = previous
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    tx.execute(
        "INSERT INTO replication_log          (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported)          VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![workspace_id, origin_id, origin_seq, op_kind, payload_json, now_ms],
    )
    .map_err(SyncError::persist)?;
    Ok(origin_seq)
}

#[allow(clippy::too_many_arguments)]
pub fn journal_local_replication_op(
    store: &mut EngineStore,
    workspace_id: &str,
    origin_id: &str,
    replication_epoch: &str,
    stream_identity: &str,
    op_kind: &str,
    payload: &serde_json::Value,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<i64>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    bounded(origin_id, "origin_id must be non-empty and bounded")?;
    bounded(
        replication_epoch,
        "replication_epoch must be non-empty and bounded",
    )?;
    bounded(
        stream_identity,
        "stream_identity must be non-empty and bounded",
    )?;
    if op_kind.is_empty() || op_kind.len() > crate::model::MAX_OP_KIND_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "op_kind must be non-empty and bounded",
        });
    }
    let payload_json = serde_json::to_string(payload).map_err(|_| SyncError::InvalidInput {
        reason: "payload is not valid JSON",
    })?;
    if payload_json.len() > crate::model::MAX_PAYLOAD_BYTES {
        return Err(SyncError::InvalidInput {
            reason: "payload exceeds the relay limit",
        });
    }

    let outcome = store.write_with(faults, |tx| {
        tx.execute(
            "INSERT OR IGNORE INTO sync_identity \
             (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![workspace_id, origin_id, replication_epoch, stream_identity, now_ms],
        )
        .map_err(SyncError::persist)?;
        let identity: (String, String, String) = tx
            .query_row(
                "SELECT origin_id, replication_epoch, stream_identity FROM sync_identity \
                 WHERE workspace_id = ?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(SyncError::corrupt)?;
        if identity != (origin_id.to_owned(), replication_epoch.to_owned(), stream_identity.to_owned()) {
            return Err(SyncError::CoordinateDiverged);
        }
        let previous: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(origin_seq), -1) FROM replication_log \
                 WHERE workspace_id = ?1 AND origin_id = ?2",
                params![workspace_id, origin_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if !(-1..crate::MAX_WIRE_INTEGER).contains(&previous) {
            return Err(SyncError::CoordinateDiverged);
        }
        let origin_seq = previous.checked_add(1).ok_or(SyncError::CoordinateDiverged)?;
        tx.execute(
            "INSERT INTO replication_log \
             (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, imported) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![workspace_id, origin_id, origin_seq, op_kind, payload_json, now_ms],
        )
        .map_err(SyncError::persist)?;
        if crashes(faults, FaultPoint::SyncDuringJournalTxn) {
            return Err(SyncError::FaultCrash);
        }
        Ok::<i64, SyncError>(origin_seq)
    });
    match outcome {
        Err(SyncError::FaultCrash) => Ok(TxnOutcome::Crashed { committed: false }),
        other => other,
    }
}

pub fn read_sync_identity(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Option<SyncIdentity>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    store.read_with(|conn| {
        conn.query_row(
            "SELECT origin_id, replication_epoch, stream_identity FROM sync_identity \
             WHERE workspace_id = ?1",
            [workspace_id],
            |row| {
                Ok(SyncIdentity {
                    workspace_id: workspace_id.to_owned(),
                    origin_id: row.get(0)?,
                    replication_epoch: row.get(1)?,
                    stream_identity: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(SyncError::corrupt)
    })
}

pub fn list_replication_ops(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
    after_seq: i64,
    limit: usize,
) -> Result<Vec<ReplicationEnvelope>, SyncError> {
    bounded(workspace_id, "workspace_id must be non-empty and bounded")?;
    bounded(origin_id, "origin_id must be non-empty and bounded")?;
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&after_seq) || limit == 0 || limit > MAX_PULL_OPS {
        return Err(SyncError::InvalidInput {
            reason: "replication page bounds are invalid",
        });
    }
    let sql_limit = i64::try_from(limit).map_err(|_| SyncError::InvalidInput {
        reason: "replication page bounds are invalid",
    })?;
    store.read_with(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT origin_seq, op_kind, payload_json, recorded_at_ms FROM replication_log \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq > ?3 \
                 ORDER BY origin_seq LIMIT ?4",
            )
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map(
                params![workspace_id, origin_id, after_seq, sql_limit],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .map_err(SyncError::corrupt)?;
        let mut out = Vec::with_capacity(limit);
        for row in rows {
            let (origin_seq, op_kind, payload_json, recorded_at_ms) =
                row.map_err(SyncError::corrupt)?;
            let payload =
                serde_json::from_str(&payload_json).map_err(|_| SyncError::CoordinateDiverged)?;
            out.push(ReplicationEnvelope {
                workspace_id: workspace_id.to_owned(),
                origin_id: origin_id.to_owned(),
                origin_seq,
                op_kind,
                payload,
                recorded_at_ms,
            });
        }
        Ok(out)
    })
}

pub fn read_replication_acked_seq(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    store.read_with(|conn| read_ack_conn(conn, workspace_id, origin_id))
}

pub fn ack_replication_peer(
    store: &mut EngineStore,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<i64>, SyncError> {
    let outcome = store.write_with(faults, |tx| {
        ack_tx(tx, workspace_id, origin_id, origin_seq)?;
        Ok::<i64, SyncError>(origin_seq)
    })?;
    Ok(outcome)
}

pub(crate) fn read_ack_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    read_ack_conn(tx, workspace_id, origin_id)
}

fn read_ack_conn(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    conn.query_row(
        "SELECT acked_seq FROM replication_peers WHERE workspace_id = ?1 AND origin_id = ?2",
        params![workspace_id, origin_id],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(-1))
    .map_err(SyncError::corrupt)
}

pub(crate) fn ack_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
) -> Result<(), SyncError> {
    if !(0..=crate::MAX_WIRE_INTEGER).contains(&origin_seq) {
        return Err(SyncError::InvalidInput {
            reason: "origin_seq is outside the wire integer range",
        });
    }
    tx.execute(
        "INSERT INTO replication_peers (workspace_id, origin_id, acked_seq) VALUES (?1, ?2, ?3) \
         ON CONFLICT(workspace_id, origin_id) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)",
        params![workspace_id, origin_id, origin_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}
