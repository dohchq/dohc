//! Relay work held behind a live conflict. Fetch position and application ACK
//! are separate: retaining an envelope permits the former, never the latter.

use std::collections::BTreeSet;

use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{OptionalExtension, params};

use crate::{BlobKind, RelayError, ReplicationEnvelope, SyncError, SyncIdentity};

const MAX_PENDING_OPS: i64 = 10_000;
// Includes payloads and conservatively charges a referenced blob for each op.
const MAX_PENDING_BYTES: i64 = 512 * 1024 * 1024;
const REPLAY_PAGE: i64 = 500;

fn local(error: impl std::fmt::Display) -> RelayError {
    RelayError::Local(error.to_string())
}

pub(crate) fn read(
    store: &EngineStore,
    workspace: &str,
    identity: &SyncIdentity,
) -> Result<(Vec<ReplicationEnvelope>, BTreeSet<String>), RelayError> {
    store.read_with(|conn| {
        let mismatched: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM relay_deferred_ops WHERE workspace_id=?1
             AND (replication_epoch!=?2 OR stream_identity!=?3))",
            params![workspace, identity.replication_epoch, identity.stream_identity], |r| r.get(0))?;

        let mut stmt = conn.prepare(
            "SELECT DISTINCT d.origin_id FROM relay_deferred_ops d
             LEFT JOIN replication_peers a ON a.workspace_id=d.workspace_id AND a.origin_id=d.origin_id
             WHERE d.workspace_id=?1 AND d.origin_seq>COALESCE(a.acked_seq,-1)")?;
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
        if mismatched { return Err(local("deferred relay work belongs to another replication epoch or stream")); }
        let ops = encoded.into_iter().map(|s| serde_json::from_str(&s).map_err(local))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((ops, origins))
    })
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

pub(crate) fn retain(
    store: &mut EngineStore,
    identity: &SyncIdentity,
    ops: &[&ReplicationEnvelope],
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if ops.is_empty() {
        return Ok(());
    }
    let blobs = ops
        .iter()
        .map(|op| crate::relay::collect_blob_refs(std::slice::from_ref(*op)))
        .collect::<Result<Vec<_>, _>>()?;
    let outcome = store.write_with(faults, |tx| {
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
            let last: i64 = tx.query_row(
                "SELECT MAX(COALESCE((SELECT MAX(origin_seq) FROM relay_deferred_ops WHERE workspace_id=?1 AND origin_id=?2),-1),
                 COALESCE((SELECT acked_seq FROM replication_peers WHERE workspace_id=?1 AND origin_id=?2),-1))",
                params![op.workspace_id,op.origin_id], |r| r.get(0)).map_err(SyncError::corrupt)?;
            if last.checked_add(1) != Some(op.origin_seq) { return Err(SyncError::SequenceGap); }
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO relay_deferred_ops
                 (workspace_id,origin_id,origin_seq,replication_epoch,stream_identity,envelope_json,retained_bytes)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![op.workspace_id,op.origin_id,op.origin_seq,identity.replication_epoch,identity.stream_identity,json,json.len() as i64])
                .map_err(SyncError::persist)?;
            if inserted == 0 { continue; }
            for (digest, kinds) in blobs {
                for kind in kinds {
                    let text = *kind == BlobKind::Text;
                    let table = if text { "blobs" } else { "binary_blobs" };
                    let bytes: i64 = tx.query_row(&format!("SELECT byte_length FROM {table} WHERE sha256=?1"),
                        [digest], |r| r.get(0)).map_err(SyncError::corrupt)?;
                    let inserted = tx.execute(
                        "INSERT OR IGNORE INTO relay_deferred_blobs
                         (workspace_id,origin_id,origin_seq,sha256,is_text,text_sha256,binary_sha256)
                         VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        params![op.workspace_id,op.origin_id,op.origin_seq,digest,text,text.then_some(digest),(!text).then_some(digest)])
                        .map_err(SyncError::persist)?;
                    if inserted != 0 {
                        tx.execute("UPDATE relay_deferred_ops SET retained_bytes=retained_bytes+?4
                            WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                            params![op.workspace_id,op.origin_id,op.origin_seq,bytes]).map_err(SyncError::persist)?;
                    }
                }
            }
        }
        let (count, bytes): (i64,i64) = tx.query_row(
            "SELECT COUNT(*),COALESCE(SUM(retained_bytes),0) FROM relay_deferred_ops WHERE workspace_id=?1",
            [&ops[0].workspace_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)?;
        if count > MAX_PENDING_OPS || bytes > MAX_PENDING_BYTES {
            return Err(SyncError::RetryableState { reason: "deferred relay work limit reached; close the conflicting editor to resume sync" });
        }
        Ok::<_,SyncError>(())
    }).map_err(local)?;
    match outcome {
        TxnOutcome::Committed(()) => Ok(()),
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
    let outcome = store.write_with(faults, |tx| {
        let next: i64 = tx.query_row("SELECT COALESCE(MAX(checked_sequence),0)+1 FROM relay_deferred_ops WHERE workspace_id=?1",
            [workspace], |r| r.get(0)).map_err(SyncError::corrupt)?;
        for origin in checked.iter().map(|op| &op.origin_id).collect::<BTreeSet<_>>() {
            tx.execute("UPDATE relay_deferred_ops SET checked_sequence=?3 WHERE workspace_id=?1 AND origin_id=?2",
                params![workspace,origin,next]).map_err(SyncError::persist)?;
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
