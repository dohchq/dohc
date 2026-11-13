//! Owner-private records a build received before it knew their kind.
//!
//! A record whose payload carries [`OWNER_PRIVATE_MARKER`] declares that it
//! changes only that account's own state. The relay admits the marker only on
//! kinds it registers as owner-private, and only naming the account that
//! pushed the record. A reader that doesn't know such a kind keeps the record
//! in `replication_log` as refused, acknowledges its coordinate, writes no
//! Notice, and records that it kept it quietly. A later build that knows the
//! kind is owner-private applies it once, from the log.
//!
//! The marker never admits a record on its own. The record must also arrive
//! on the owner's ordinary lane, and the marker must name the account this
//! copy recorded as its owner. Everything else unknown stays a visible
//! refusal, and a visible refusal never replays, even after its Notice is
//! dismissed.

use dohc_engine_domain::chats::OWNER_PRIVATE_MARKER;
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::journal::crashes;
use crate::{ReplicationEnvelope, SyncError};

/// Origins another account, a share, or the relay writes. None of them is the
/// owner's own lane, whatever its payload says.
const FOREIGN_ORIGIN_PREFIXES: [&str; 4] = ["shared:", "share:", "relay:", "service-host:"];

/// `engine_requests` already keys the engine's own markers. These rows use
/// NUL-prefixed ids, which no client request id can take.
///
/// One quiet admission per coordinate: `payload_hash` holds the JSON array
/// `[workspace_id, origin_id]` and `result_seq` the origin sequence.
const QUIET_KIND: &str = "owner-private-quiet";
/// The owner-private kinds the last completed replay could apply.
const FINGERPRINT_REQUEST_ID: &str = "\0owner-private-replay";
const FINGERPRINT_KIND: &str = "owner-private-replay";
/// After a record fails with an error that isn't a refusal, the next opens
/// scan again, this many times in all, before the fingerprint settles.
const MAX_REPLAY_ATTEMPTS: u32 = 3;
const ATTEMPT_SEPARATOR: &str = "\nattempt:";

fn quiet_request_id(envelope: &ReplicationEnvelope) -> String {
    format!(
        "\0{QUIET_KIND}:{}",
        serde_json::json!([
            envelope.workspace_id,
            envelope.origin_id,
            envelope.origin_seq
        ])
    )
}

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
/// private state. A share lane never reaches here: it applies through
/// `share.rs`, which refuses every kind it doesn't list.
fn retains_quietly(conn: &Connection, envelope: &ReplicationEnvelope) -> Result<bool, SyncError> {
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

/// Keep a record of a kind this build doesn't know quietly, if it is the
/// owner's own private state, and record that in the arrival transaction.
/// Answers whether it did.
pub(crate) fn admit_quietly(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<bool, SyncError> {
    if !retains_quietly(tx, envelope)? {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at, kind) \
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(request_id) DO NOTHING",
        params![
            quiet_request_id(envelope),
            serde_json::json!([envelope.workspace_id, envelope.origin_id]).to_string(),
            envelope.origin_seq,
            envelope.recorded_at_ms,
            QUIET_KIND
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(true)
}

/// Whether the coordinate is still kept quietly: admitted quietly, still
/// refused in the log, and with no Notice.
fn still_retained(tx: &Transaction<'_>, envelope: &ReplicationEnvelope) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?4 AND kind=?5) \
           AND EXISTS(SELECT 1 FROM replication_log \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 \
               AND imported=1 AND apply_disposition='refused') \
           AND NOT EXISTS(SELECT 1 FROM replication_pending_refusals \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3)",
        params![
            envelope.workspace_id,
            envelope.origin_id,
            envelope.origin_seq,
            quiet_request_id(envelope),
            QUIET_KIND
        ],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// The quietly admitted records of `kinds`, in arrival order. It starts from
/// the admissions, through the `engine_requests` kind index, and reads each
/// log row by its key, so its cost follows the number of quiet records, not
/// the size of the log. A kind this build doesn't know is never decoded.
fn retained(conn: &Connection, kinds: &[&str]) -> Result<Vec<ReplicationEnvelope>, SyncError> {
    let kinds = serde_json::to_string(kinds).map_err(SyncError::corrupt)?;
    let mut stmt = conn
        .prepare(
            "SELECT r.workspace_id, r.origin_id, r.origin_seq, r.op_kind, r.payload_json, \
                    r.recorded_at_ms \
             FROM engine_requests q \
             JOIN replication_log r \
               ON r.workspace_id = json_extract(q.payload_hash, '$[0]') \
              AND r.origin_id = json_extract(q.payload_hash, '$[1]') \
              AND r.origin_seq = q.result_seq \
             WHERE q.kind = ?1 \
               AND r.op_kind IN (SELECT value FROM json_each(?2)) \
               AND r.imported = 1 AND r.apply_disposition = 'refused' \
             ORDER BY r.rowid",
        )
        .map_err(SyncError::corrupt)?;
    let rows = stmt
        .query_map(params![QUIET_KIND, kinds], |row| {
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

/// The owner-private kinds a replay could apply, sorted and joined.
fn fingerprint_of(kinds: &[&str]) -> String {
    let mut sorted = kinds.to_vec();
    sorted.sort_unstable();
    sorted.join(",")
}

/// The stored value: the fingerprint of the last completed replay, with an
/// attempt count while a record it couldn't try waits for another scan.
pub(crate) fn stored_fingerprint(conn: &Connection) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT payload_hash FROM engine_requests WHERE request_id=?1 AND kind=?2",
        params![FINGERPRINT_REQUEST_ID, FINGERPRINT_KIND],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn store_fingerprint(tx: &Transaction<'_>, value: &str) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at, kind) \
         VALUES (?1, ?2, 0, 0, ?3) \
         ON CONFLICT(request_id) DO UPDATE SET payload_hash = excluded.payload_hash \
         WHERE engine_requests.kind = excluded.kind",
        params![FINGERPRINT_REQUEST_ID, value, FINGERPRINT_KIND],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// The value a replay stores. A replay that left a record to an error that
/// isn't a refusal stores an attempt count, which doesn't match the
/// fingerprint, so the next opens scan again. After the last attempt it
/// stores the plain fingerprint: the record stays kept, and the next build
/// whose owner-private kinds differ tries it again.
fn settled_value(fingerprint: &str, stored: Option<&str>, failed: bool) -> String {
    if !failed {
        return fingerprint.to_owned();
    }
    let attempts = stored
        .and_then(|value| value.strip_prefix(fingerprint))
        .and_then(|rest| rest.strip_prefix(ATTEMPT_SEPARATOR))
        .and_then(|count| count.parse::<u32>().ok())
        .unwrap_or(0)
        .saturating_add(1);
    if attempts >= MAX_REPLAY_ATTEMPTS {
        fingerprint.to_owned()
    } else {
        format!("{fingerprint}{ATTEMPT_SEPARATOR}{attempts}")
    }
}

/// Apply each quietly kept record whose kind this build knows to be
/// owner-private, through the chat applier, from the log alone. Answers how
/// many applied.
///
/// It reads the log only when this build's owner-private kinds differ from the
/// last completed replay's, and only on a copy that recorded its owner, since
/// no other copy keeps a record quietly. Each record applies, turns `applied`,
/// and gives up its quiet admission in one transaction, so none applies twice.
/// One its applier refuses stays as it was, without a Notice: it is private
/// state the copy can leave out.
pub fn replay_retained_owner_private(
    store: &mut EngineStore,
    faults: &dyn FaultInjector,
) -> Result<usize, SyncError> {
    replay_known(
        store,
        faults,
        crate::router::OWNER_PRIVATE_KINDS,
        |tx, op| crate::apply::apply_chat_tx(tx, op).map(|_| ()),
    )
}

/// [`replay_retained_owner_private`] with the build's owner-private kinds
/// passed in, so a test can stand in for a later build.
pub(crate) fn replay_known(
    store: &mut EngineStore,
    faults: &dyn FaultInjector,
    kinds: &[&str],
    mut apply: impl FnMut(&Transaction<'_>, &ReplicationEnvelope) -> Result<(), SyncError>,
) -> Result<usize, SyncError> {
    let fingerprint = fingerprint_of(kinds);
    let (seeded, stored) =
        store.read_with(|conn| -> Result<(bool, Option<String>), SyncError> {
            let seeded: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_account_read_seeds)",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            Ok((seeded, stored_fingerprint(conn)?))
        })?;
    if !seeded || stored.as_deref() == Some(fingerprint.as_str()) {
        return Ok(0);
    }
    let candidates = store.read_with(|conn| retained(conn, kinds))?;
    // The fingerprint commits with the last record, so a crash before it
    // leaves the scan to run again. Rows already applied are no longer
    // candidates then.
    let mut applied = 0;
    let mut failed = false;
    let mut settled = false;
    for (index, envelope) in candidates.iter().enumerate() {
        let last = index + 1 == candidates.len();
        let value = settled_value(&fingerprint, stored.as_deref(), failed);
        let outcome = store.write_with(faults, |tx| {
            let marked = replay_one(tx, envelope, &mut apply)?;
            if last {
                store_fingerprint(tx, &value)?;
            }
            if crashes(faults, FaultPoint::SyncBeforeApplyCommit) {
                return Err(SyncError::FaultCrash);
            }
            Ok(marked)
        });
        match outcome {
            Ok(TxnOutcome::Committed(marked)) => {
                applied += usize::from(marked);
                settled = last;
            }
            Ok(TxnOutcome::Crashed { .. }) | Err(SyncError::FaultCrash) => {
                return Err(SyncError::FaultCrash);
            }
            // The record stays kept quietly, and the rest still replay.
            Err(error) => {
                eprintln!(
                    "engine: owner-private record {}:{} stays kept: {error}",
                    envelope.origin_id, envelope.origin_seq
                );
                failed = true;
            }
        }
    }
    if !settled {
        let value = settled_value(&fingerprint, stored.as_deref(), failed);
        match store.write_with(faults, |tx| {
            store_fingerprint(tx, &value)?;
            if crashes(faults, FaultPoint::SyncBeforeApplyCommit) {
                return Err(SyncError::FaultCrash);
            }
            Ok(())
        })? {
            TxnOutcome::Committed(()) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
    Ok(applied)
}

/// Apply one quietly kept record, mark it applied, and consume its quiet
/// admission. Answers false, changing nothing, when it is no longer kept
/// quietly or its applier refuses it.
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
    tx.execute(
        "DELETE FROM engine_requests WHERE request_id=?1 AND kind=?2",
        params![quiet_request_id(envelope), QUIET_KIND],
    )
    .map_err(SyncError::persist)?;
    dohc_engine_storage::count_remote_change_in_tx(tx, &envelope.workspace_id)?;
    Ok(true)
}
