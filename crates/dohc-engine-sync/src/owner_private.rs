//! Owner-private records a build received before it knew their kind.
//!
//! A record whose payload carries [`OWNER_PRIVATE_MARKER`] declares that it
//! changes only that account's own state. The relay admits the marker only on
//! kinds it registers as owner-private, and only naming the account that
//! pushed the record. A reader that doesn't know such a kind keeps the record
//! in `replication_log` as refused, acknowledges its coordinate, and writes no
//! Notice. A later build that knows the kind applies it once, from the log.
//!
//! The marker never admits a record on its own. The record must also arrive
//! on the owner's ordinary lane, and the marker must name the account this
//! copy recorded as its owner. Everything else unknown stays a visible
//! refusal.

use dohc_engine_domain::chats::OWNER_PRIVATE_MARKER;
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::journal::crashes;
use crate::{ReplicationEnvelope, SyncError};

/// Origins another account, a share, or the relay writes. None of them is the
/// owner's own lane, whatever its payload says.
const FOREIGN_ORIGIN_PREFIXES: [&str; 4] = ["shared:", "share:", "relay:", "service-host:"];

/// The account this copy shows private state for. Desktop records it from the
/// signed-in owner's credentials and a server copy from its owner, never from
/// a record.
fn owner_account(conn: &Connection, workspace_id: &str) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT account_user_id FROM chat_account_read_seeds WHERE workspace_id=?1",
        [workspace_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

/// Whether a record of a kind this build doesn't know is the owner's own
/// private state, to keep without a Notice. A share lane never reaches here:
/// it applies through `share.rs`, which refuses every kind it doesn't list.
pub(crate) fn retains_quietly(
    conn: &Connection,
    envelope: &ReplicationEnvelope,
) -> Result<bool, SyncError> {
    // Every registered owner-private kind is a chat kind, replayed by the
    // chat applier.
    if !envelope.op_kind.starts_with("chat.")
        || FOREIGN_ORIGIN_PREFIXES
            .iter()
            .any(|prefix| envelope.origin_id.starts_with(prefix))
    {
        return Ok(false);
    }
    let Some(marked) = envelope
        .payload
        .get(OWNER_PRIVATE_MARKER)
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(false);
    };
    if marked.is_empty() || crate::hosted::is_hosted(conn, &envelope.workspace_id)? {
        return Ok(false);
    }
    Ok(owner_account(conn, &envelope.workspace_id)?.as_deref() == Some(marked))
}

/// Whether the coordinate is still kept quietly: refused, with no Notice.
fn still_retained(tx: &Transaction<'_>, envelope: &ReplicationEnvelope) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replication_log r \
         WHERE r.workspace_id=?1 AND r.origin_id=?2 AND r.origin_seq=?3 \
           AND r.imported=1 AND r.apply_disposition='refused' \
           AND NOT EXISTS(SELECT 1 FROM replication_pending_refusals p \
             WHERE p.workspace_id=r.workspace_id AND p.origin_id=r.origin_id \
               AND p.origin_seq=r.origin_seq))",
        params![
            envelope.workspace_id,
            envelope.origin_id,
            envelope.origin_seq
        ],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// The quietly kept records, in arrival order: refused, marked for the copy's
/// owner, and without a Notice. A refusal from an older build carries no
/// marker, so it is never one of them. No index covers these columns, so this
/// visits each log row of a workspace that recorded its owner once; the
/// substring test keeps JSON parsing to the few rows that name the marker.
fn retained(conn: &Connection) -> Result<Vec<ReplicationEnvelope>, SyncError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT r.workspace_id, r.origin_id, r.origin_seq, r.op_kind, r.payload_json, \
                    r.recorded_at_ms \
             FROM chat_account_read_seeds s \
             JOIN replication_log r ON r.workspace_id = s.workspace_id \
             WHERE r.apply_disposition = 'refused' AND r.imported = 1 \
               AND substr(r.op_kind, 1, 5) = 'chat.' \
               AND instr(r.payload_json, '\"{OWNER_PRIVATE_MARKER}\"') > 0 \
               AND json_valid(r.payload_json) \
               AND json_extract(r.payload_json, '$.{OWNER_PRIVATE_MARKER}') = s.account_user_id \
               AND NOT EXISTS(SELECT 1 FROM replication_pending_refusals p \
                 WHERE p.workspace_id = r.workspace_id AND p.origin_id = r.origin_id \
                   AND p.origin_seq = r.origin_seq) \
             ORDER BY r.workspace_id, r.rowid"
        ))
        .map_err(SyncError::corrupt)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(SyncError::corrupt)?;
    let mut out = Vec::new();
    for row in rows {
        let (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) =
            row.map_err(SyncError::corrupt)?;
        out.push(ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id,
            origin_id,
            origin_seq,
            relay_seq: None,
            op_kind,
            payload: serde_json::from_str(&payload_json).map_err(SyncError::corrupt)?,
            recorded_at_ms,
        });
    }
    Ok(out)
}

/// The kinds the last completed replay could apply live in `engine_requests`,
/// which already keys the engine's own markers. A client request id never
/// starts with NUL.
const FINGERPRINT_REQUEST_ID: &str = "\0owner-private-replay";
const FINGERPRINT_KIND: &str = "owner-private-replay";

/// The kinds the last completed replay could apply, if one completed.
pub(crate) fn stored_fingerprint(conn: &Connection) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT payload_hash FROM engine_requests WHERE request_id=?1 AND kind=?2",
        params![FINGERPRINT_REQUEST_ID, FINGERPRINT_KIND],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn store_fingerprint(tx: &Transaction<'_>, fingerprint: &str) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at, kind) \
         VALUES (?1, ?2, 0, 0, ?3) \
         ON CONFLICT(request_id) DO UPDATE SET payload_hash = excluded.payload_hash \
         WHERE engine_requests.kind = excluded.kind",
        params![FINGERPRINT_REQUEST_ID, fingerprint, FINGERPRINT_KIND],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Apply each quietly kept record whose kind this build now knows, through
/// the chat applier, from the log alone. Answers how many applied.
///
/// It reads the log only when this build knows a chat kind the last completed
/// replay didn't, and only on a copy that recorded its owner, since no other
/// copy keeps a record quietly. Each record applies and turns `applied` in one
/// transaction, so none applies twice. One its applier refuses stays as it
/// was, without a Notice: it is private state the copy can leave out.
pub fn replay_retained_owner_private(
    store: &mut EngineStore,
    faults: &dyn FaultInjector,
) -> Result<usize, SyncError> {
    replay_known(
        store,
        faults,
        &crate::router::chat_op_kinds_fingerprint(),
        crate::router::is_chat_op_kind,
        |tx, op| crate::apply::apply_chat_tx(tx, op).map(|_| ()),
    )
}

/// [`replay_retained_owner_private`] with the build's knowledge passed in, so
/// a test can stand in for a later build. `fingerprint` names the kinds
/// `knows` accepts.
pub(crate) fn replay_known(
    store: &mut EngineStore,
    faults: &dyn FaultInjector,
    fingerprint: &str,
    knows: impl Fn(&str) -> bool,
    mut apply: impl FnMut(&Transaction<'_>, &ReplicationEnvelope) -> Result<(), SyncError>,
) -> Result<usize, SyncError> {
    let current = store.read_with(|conn| -> Result<bool, SyncError> {
        let seeded: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_account_read_seeds)",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        Ok(!seeded || stored_fingerprint(conn)?.as_deref() == Some(fingerprint))
    })?;
    if current {
        return Ok(0);
    }
    let candidates: Vec<ReplicationEnvelope> = store
        .read_with(retained)?
        .into_iter()
        .filter(|envelope| knows(&envelope.op_kind))
        .collect();
    if candidates.is_empty() {
        return match store.write_with(faults, |tx| {
            store_fingerprint(tx, fingerprint)?;
            if crashes(faults, FaultPoint::SyncBeforeApplyCommit) {
                return Err(SyncError::FaultCrash);
            }
            Ok(())
        })? {
            TxnOutcome::Committed(()) => Ok(0),
            TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
        };
    }
    // The fingerprint commits with the last record, so a crash before it
    // leaves the scan to run again. Rows already applied are no longer
    // candidates then.
    let last = candidates.len() - 1;
    let mut applied = 0;
    for (index, envelope) in candidates.iter().enumerate() {
        let outcome = store.write_with(faults, |tx| {
            let marked = replay_one(tx, envelope, &mut apply)?;
            if index == last {
                store_fingerprint(tx, fingerprint)?;
            }
            if crashes(faults, FaultPoint::SyncBeforeApplyCommit) {
                return Err(SyncError::FaultCrash);
            }
            Ok(marked)
        });
        match outcome {
            Ok(TxnOutcome::Committed(true)) => applied += 1,
            Ok(TxnOutcome::Committed(false)) => {}
            Ok(TxnOutcome::Crashed { .. }) => return Err(SyncError::FaultCrash),
            Err(error) => return Err(error),
        }
    }
    Ok(applied)
}

/// Apply one quietly kept record and mark it applied. Answers false, changing
/// nothing, when it is no longer kept quietly or its applier refuses it.
fn replay_one(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    apply: &mut impl FnMut(&Transaction<'_>, &ReplicationEnvelope) -> Result<(), SyncError>,
) -> Result<bool, SyncError> {
    if !still_retained(tx, envelope)? || !retains_quietly(tx, envelope)? {
        return Ok(false);
    }
    tx.execute_batch("SAVEPOINT dohc_owner_private_replay")
        .map_err(SyncError::persist)?;
    match apply(tx, envelope) {
        Ok(()) => tx
            .execute_batch("RELEASE dohc_owner_private_replay")
            .map_err(SyncError::persist)?,
        Err(error) if crate::apply::refusal_reason(&error).is_some() => {
            tx.execute_batch(
                "ROLLBACK TO dohc_owner_private_replay; \
                 RELEASE dohc_owner_private_replay",
            )
            .map_err(SyncError::persist)?;
            return Ok(false);
        }
        Err(error) => return Err(error),
    }
    tx.execute(
        "UPDATE replication_log SET apply_disposition='applied' \
         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![
            envelope.workspace_id,
            envelope.origin_id,
            envelope.origin_seq
        ],
    )
    .map_err(SyncError::persist)?;
    dohc_engine_storage::count_remote_change_in_tx(tx, &envelope.workspace_id)?;
    Ok(true)
}
