use std::cell::Cell;

use dohc_engine_collab::{DocKey, WriterDocCache};
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::{ApplyDisposition, ReplicationEnvelope, SyncError};

pub(crate) const CANNOT_SETTLE: &str = "ydoc-kept-base-cannot-settle";

thread_local! {
    static REPLAYING: Cell<bool> = const { Cell::new(false) };
}

const KEPT_ROWS: &str = "FROM replication_refused_ydoc_blobs k \
     JOIN replication_log l USING (workspace_id, origin_id, origin_seq)";
const CLAIM_OF: &str = "(CASE l.op_kind WHEN 'conflict.resolve' THEN json_array(k.workspace_id, \
       json_extract(l.payload_json,'$.targetVersionId'), \
       json_extract(l.payload_json,'$.transition.result.objectId'), \
       json_extract(l.payload_json,'$.lineageTransition.successor.lineageClaimId')) \
     ELSE json_array(k.workspace_id, json_extract(l.payload_json,'$.versionId'), \
       json_extract(l.payload_json,'$.objectId'), json_extract(l.payload_json,'$.lineageClaimId')) END)";
const BASE: &str = "(l.op_kind='conflict.resolve' OR json_extract(l.payload_json,'$.isBaseState'))";
const UNREPLAYED: &str = "k.reason='ydoc-note-uses-a-newer-body-format' AND k.replayed=0";
const CANDIDATE: &str = "k.reason='ydoc-note-uses-a-newer-body-format' AND k.replayed=0 \
     AND l.op_kind='ydoc.update' AND k.relay_seq IS NOT NULL \
     AND k.workspace_id NOT IN (SELECT workspace_id FROM hosted_replicas) \
     AND k.replication_epoch IS \
       (SELECT replication_epoch FROM sync_identity s WHERE s.workspace_id=k.workspace_id) \
     AND k.stream_identity IS \
       (SELECT stream_identity FROM sync_identity s WHERE s.workspace_id=k.workspace_id)";
const AT: &str = "k.workspace_id=?1 AND k.origin_id=?2 AND k.origin_seq=?3";

pub(crate) fn replaying<R>(run: impl FnOnce() -> R) -> R {
    let before = REPLAYING.replace(true);
    let ran = run();
    REPLAYING.set(before);
    ran
}

fn at(envelope: &ReplicationEnvelope) -> (&str, &str, i64) {
    (
        envelope.workspace_id.as_str(),
        envelope.origin_id.as_str(),
        envelope.origin_seq,
    )
}

fn kept_row<T: rusqlite::types::FromSql>(
    conn: &Connection,
    select: &str,
    filter: &str,
    envelope: &ReplicationEnvelope,
) -> Result<Option<T>, SyncError> {
    let sql = format!("SELECT {select} {KEPT_ROWS} WHERE {AT} AND {filter}");
    conn.query_row(&sql, at(envelope), |row| row.get(0))
        .optional()
        .map_err(SyncError::corrupt)
}

fn strings(store: &EngineStore, sql: &str, claim: Option<&str>) -> Result<Vec<String>, SyncError> {
    store
        .read_with(|conn| -> rusqlite::Result<Vec<String>> {
            conn.prepare(sql)?
                .query_map(rusqlite::params_from_iter(claim), |row| row.get(0))?
                .collect()
        })
        .map_err(SyncError::corrupt)
}

/// Whether this apply is the open's replay of `envelope`'s kept format-2 row.
pub(crate) fn kept_candidate(
    conn: &Connection,
    envelope: &ReplicationEnvelope,
) -> Result<bool, SyncError> {
    Ok(REPLAYING.get() && kept_row::<i64>(conn, "1", CANDIDATE, envelope)?.is_some())
}

/// Whether a kept delta's claim still waits on its own kept base.
pub(crate) fn held_behind_its_base(
    conn: &Connection,
    envelope: &ReplicationEnvelope,
) -> Result<bool, SyncError> {
    let Some(claim) = kept_row::<String>(conn, CLAIM_OF, &format!("NOT {BASE}"), envelope)? else {
        return Ok(false);
    };
    let base = format!(
        "SELECT EXISTS(SELECT 1 {KEPT_ROWS} WHERE k.update_sha256=json_extract(?1,'$[3]') \
           AND {CLAIM_OF}=?1 AND {BASE} AND {UNREPLAYED})"
    );
    conn.query_row(&base, [claim], |row| row.get(0))
        .map_err(SyncError::corrupt)
}

pub(crate) fn mark_replayed_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    for sql in [
        "DELETE FROM replication_pending_refusals",
        "UPDATE replication_refused_ydoc_blobs SET replayed=1",
    ] {
        let sql = format!("{sql} WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3");
        tx.execute(&sql, at(envelope)).map_err(SyncError::persist)?;
    }
    Ok(())
}

/// Settle a kept row refused again for another reason. A base refuses its
/// whole claim with it, and no row it decides replays again.
pub(crate) fn refuse_claim_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    reason: &str,
) -> Result<(), SyncError> {
    let (workspace, origin, seq) = at(envelope);
    let decided = format!(
        "SELECT k.workspace_id, k.origin_id, k.origin_seq, l.op_kind, k.rowid AS kept, ?4 AS why \
         {KEPT_ROWS} WHERE ({AT}) OR ({CANDIDATE} \
           AND {CLAIM_OF}=(SELECT {CLAIM_OF} {KEPT_ROWS} WHERE {AT} AND {BASE}))"
    );
    for sql in [
        "INSERT INTO replication_pending_refusals \
           (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) \
         SELECT workspace_id,origin_id,origin_seq,op_kind,'invalid-input',why FROM decided WHERE 1 \
         ON CONFLICT(workspace_id,origin_id,origin_seq) DO UPDATE SET \
           reason_message=excluded.reason_message, report_id=NULL",
        "UPDATE replication_log SET apply_disposition='refused' WHERE op_kind='ydoc.update' \
           AND (workspace_id,origin_id,origin_seq) IN \
             (SELECT workspace_id,origin_id,origin_seq FROM decided)",
        "UPDATE replication_refused_ydoc_blobs SET reason=?4 \
           WHERE rowid IN (SELECT kept FROM decided)",
    ] {
        tx.execute(
            &format!("WITH decided AS ({decided}) {sql}"),
            (workspace, origin, seq, reason),
        )
        .map_err(SyncError::persist)?;
    }
    crate::ydoc_apply::refuse_rows_of_a_kept_base_in_tx(tx, envelope, reason)
}

/// Replay `claim`'s kept rows, base first, then drain its parked edits, and
/// forget its rows once none is left to replay.
fn finish_claim(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    faults: &dyn FaultInjector,
    claim: &str,
) -> Result<usize, SyncError> {
    let rows = format!(
        "SELECT json_object('workspaceId',k.workspace_id,'originId',k.origin_id, \
           'originSeq',k.origin_seq,'relaySeq',k.relay_seq,'opKind',l.op_kind, \
           'payload',json(l.payload_json),'recordedAtMs',l.recorded_at_ms) {KEPT_ROWS} \
         WHERE {CLAIM_OF}=?1 AND {CANDIDATE} ORDER BY NOT {BASE}, k.rowid"
    );
    let mut replayed = 0;
    for row in strings(store, &rows, Some(claim))? {
        let envelope: ReplicationEnvelope =
            serde_json::from_str(&row).map_err(SyncError::corrupt)?;
        if store
            .read_with(|conn| kept_row::<i64>(conn, "1", CANDIDATE, &envelope))?
            .is_none()
        {
            continue;
        }
        let outcome = replaying(|| {
            crate::apply_replication_envelope(store, cache, &envelope, faults, &crate::NoLiveLeases)
        })?;
        if let ApplyDisposition::Crashed { .. } = outcome.primary {
            return Err(SyncError::FaultCrash);
        }
        let done = store.read_with(|conn| kept_row::<i64>(conn, "1", "k.replayed=1", &envelope))?;
        replayed += usize::from(done.is_some());
    }
    let (workspace, version, object, _): (String, String, String, String) =
        serde_json::from_str(claim).map_err(SyncError::corrupt)?;
    let key = DocKey::new(workspace, version, object).map_err(SyncError::corrupt)?;
    crate::ydoc_apply::drain_deferred_ydoc_for_key(store, cache, &key, faults)?;
    let forget = format!(
        "DELETE FROM replication_refused_ydoc_blobs WHERE rowid IN \
           (SELECT k.rowid {KEPT_ROWS} WHERE {CLAIM_OF}=?1 AND k.replayed=1) \
         AND NOT EXISTS(SELECT 1 {KEPT_ROWS} WHERE {CLAIM_OF}=?1 AND {CANDIDATE})"
    );
    match store.write_with(faults, |tx| {
        tx.execute(&forget, [claim]).map_err(SyncError::persist)
    })? {
        TxnOutcome::Committed(_) => Ok(replayed),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

/// Replay the format-2 notes this desktop kept while it couldn't read them,
/// now that it reads format 2. Hosted copies and resolved successors keep
/// theirs.
pub fn replay_kept_format_two(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    faults: &dyn FaultInjector,
) -> Result<usize, SyncError> {
    if !dohc_engine_collab::ydoc::reads_body_sequence() {
        return Ok(0);
    }
    let claims = format!(
        "SELECT {CLAIM_OF} {KEPT_ROWS} WHERE k.replayed=1 OR ({CANDIDATE}) \
         GROUP BY 1 ORDER BY MIN(k.rowid)"
    );
    let mut replayed = 0;
    for claim in strings(store, &claims, None)? {
        match finish_claim(store, cache, faults, &claim) {
            Ok(count) => replayed += count,
            Err(SyncError::FaultCrash) => return Err(SyncError::FaultCrash),
            Err(error) => eprintln!("engine: kept format-2 note {claim} stays kept: {error}"),
        }
    }
    Ok(replayed)
}
