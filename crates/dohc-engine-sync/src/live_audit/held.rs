//! Audits a replica refused, held at admission with what a later replay
//! reads: the envelope, its lineage and every blob it names. A held audit is
//! never verified, so each later audit of its lineage that needs it is held
//! with it instead of waiting, and the origin's other work continues.

use super::*;
use crate::BlobKind;

pub(crate) const WAITS_ON_HELD: &str = "live audit waits on a held audit of its lineage";

/// What an audit needs from its lineage before it can verify.
#[derive(Clone, Copy)]
enum Needs {
    /// An application needs every earlier event.
    Events(i64),
    /// A settlement needs the event at its terminal cursor.
    Boundary(i64),
}

/// The lineage an audit application or settlement names, and what it needs.
/// An audit whose count or cursor no event can have is refused, not held.
fn lineage(envelope: &ReplicationEnvelope) -> Option<([&str; 5], Needs)> {
    let payload = &envelope.payload;
    let position = |value: &serde_json::Value, first: i64| {
        value
            .as_i64()
            .filter(|position| (first..=crate::MAX_WIRE_INTEGER).contains(position))
    };
    let (record, binding, needs) = match envelope.op_kind.as_str() {
        application_record::EVENT_OP => (
            payload,
            payload,
            Needs::Events(position(&payload["eventCount"], 1)?),
        ),
        settlement_record::SETTLEMENT_OP => (
            &payload["record"],
            &payload["record"]["binding"],
            Needs::Boundary(position(&payload["record"]["terminalCursor"], 0)?),
        ),
        _ => return None,
    };
    Some((
        [
            record["relayDatabaseNamespace"].as_str()?,
            envelope.workspace_id.as_str(),
            binding["mainVersionId"].as_str()?,
            binding["objectId"].as_str()?,
            binding["lineageClaimId"].as_str()?,
        ],
        needs,
    ))
}

/// Whether a refused audit is held.
pub(crate) fn holds(envelope: &ReplicationEnvelope) -> bool {
    lineage(envelope).is_some()
}

/// Whether `envelope` is an audit application or settlement. A refused one
/// leaves no pending refusal: Notices never show it, and its refused log row
/// is what recovery reads.
pub(crate) fn is_audit(envelope: &ReplicationEnvelope) -> bool {
    matches!(
        envelope.op_kind.as_str(),
        application_record::EVENT_OP | settlement_record::SETTLEMENT_OP
    )
}

/// Each blob `envelope` names, as its digest, whether it is text, and
/// whether this store keeps it.
fn blobs(
    conn: &Connection,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<(String, bool, bool)>, SyncError> {
    // A refused record may name malformed digests; it holds none of them.
    let Ok(refs) = crate::relay::collect_blob_refs(std::slice::from_ref(envelope)) else {
        return Ok(Vec::new());
    };
    let mut blobs = Vec::new();
    for (digest, kinds) in refs {
        for text in [false, true] {
            if !kinds.iter().any(|kind| (*kind == BlobKind::Text) == text) {
                continue;
            }
            let table = if text { "blobs" } else { "binary_blobs" };
            let kept: bool = conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE sha256=?1)"),
                    [&digest],
                    |r| r.get(0),
                )
                .map_err(SyncError::corrupt)?;
            blobs.push((digest.clone(), text, kept));
        }
    }
    Ok(blobs)
}

/// The refused applications of a lineage with an event count in a range.
/// The history lookup is keyed by workspace and document.
pub(super) const REFUSED_APPLICATIONS: &str = "SELECT r.origin_id,r.origin_seq,r.payload_json,r.recorded_at_ms,(SELECT q.reason_message FROM replication_pending_refusals q WHERE q.workspace_id=r.workspace_id AND q.origin_id=r.origin_id AND q.origin_seq=r.origin_seq)
            FROM replication_log r WHERE r.op_kind='live.audit.application' AND r.apply_disposition='refused'
              AND r.workspace_id=?2 AND json_extract(r.payload_json,'$.objectId')=?4 AND json_extract(r.payload_json,'$.eventCount')>=?6 AND json_extract(r.payload_json,'$.eventCount')<?7
              AND json_extract(r.payload_json,'$.relayDatabaseNamespace')=?1 AND json_extract(r.payload_json,'$.mainVersionId')=?3 AND json_extract(r.payload_json,'$.lineageClaimId')=?5
              AND NOT EXISTS(SELECT 1 FROM live_audit_held_records h WHERE h.workspace_id=r.workspace_id AND h.origin_id=r.origin_id AND h.origin_seq=r.origin_seq)
              AND NOT EXISTS(SELECT 1 FROM live_audit_event_conflicts c WHERE c.workspace_id=r.workspace_id AND c.origin_id=r.origin_id AND c.origin_seq=r.origin_seq)";

/// Each refused application of lineage `p`, from any origin, with an event
/// count in `counts` and not held yet. The lookup reads `replication_log`
/// through its refused-audit index, so a coordinate refused before this
/// store held audits is found even after its Notice was dismissed.
fn refused_unheld(
    conn: &Connection,
    p: [&str; 5],
    counts: std::ops::Range<i64>,
) -> Result<Vec<(ReplicationEnvelope, String)>, SyncError> {
    let mut statement = conn
        .prepare_cached(REFUSED_APPLICATIONS)
        .map_err(SyncError::corrupt)?;
    let rows = statement
        .query_map(
            params![p[0], p[1], p[2], p[3], p[4], counts.start, counts.end],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    rows.into_iter()
        .map(|(origin_id, origin_seq, payload, recorded_at_ms, reason)| {
            Ok((
                ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: p[1].to_owned(),
                    origin_id,
                    origin_seq,
                    relay_seq: None,
                    op_kind: application_record::EVENT_OP.to_owned(),
                    payload: serde_json::from_str(&payload).map_err(SyncError::corrupt)?,
                    recorded_at_ms,
                },
                reason.unwrap_or_else(|| "refused".to_owned()),
            ))
        })
        .filter(|refused| {
            refused
                .as_ref()
                .map_or(true, |(envelope, _)| holds(envelope))
        })
        .collect()
}

/// Whether a waiting audit waits on a held or refused audit of its lineage.
/// If so, it returns the refused applications not held yet, which the
/// caller holds with it. Events verify in order, so an audit waits on an
/// event above the lineage's verified frontier: an application on each one
/// below its count, and a settlement with an unverified terminal boundary
/// on the next one. Any other wait, and an audit missing a blob, stays
/// retryable. Reads only.
pub(crate) fn waits_on_held(
    conn: &Connection,
    envelope: &ReplicationEnvelope,
    error: &SyncError,
) -> Result<Option<Vec<(ReplicationEnvelope, String)>>, SyncError> {
    if !matches!(error.original(), SyncError::RetryableState { .. }) {
        return Ok(None);
    }
    let Some((p, needs)) = lineage(envelope) else {
        return Ok(None);
    };
    let verified = frontier(conn, p)?;
    let counts = match needs {
        Needs::Events(count) if count - 1 > verified => verified + 1..count,
        // A settlement that ends at the base waits only on the base.
        Needs::Events(_) | Needs::Boundary(0) => return Ok(None),
        Needs::Boundary(cursor) => {
            let boundary: bool = conn
                .query_row(&format!("SELECT EXISTS(SELECT 1 FROM live_audit_events WHERE {SCOPE} AND journal_cursor=?6)"), params![p[0], p[1], p[2], p[3], p[4], cursor], |r| r.get(0))
                .map_err(SyncError::corrupt)?;
            if boundary {
                return Ok(None);
            }
            verified + 1..verified + 2
        }
    };
    if blobs(conn, envelope)?.iter().any(|(_, _, kept)| !kept) {
        return Ok(None);
    }
    let (held, recovered) = unheld(conn, p, counts)?;
    Ok((held || !recovered.is_empty()).then_some(recovered))
}

/// The highest event count of lineage `p` that this store has verified.
fn frontier(conn: &Connection, p: [&str; 5]) -> Result<i64, SyncError> {
    conn.query_row(
        &format!("SELECT COALESCE(MAX(event_count),0) FROM live_audit_events WHERE {SCOPE}"),
        p,
        |r| r.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// Whether lineage `p` holds an application with a count in `counts`, and
/// its refused applications in `counts` that are not held yet. Each hold of
/// an application takes every refused application below its count, so only
/// counts above the highest held one are read.
fn unheld(
    conn: &Connection,
    p: [&str; 5],
    counts: std::ops::Range<i64>,
) -> Result<(bool, Vec<(ReplicationEnvelope, String)>), SyncError> {
    let top: Option<i64> = conn
        .query_row(&format!("SELECT MAX(event_count) FROM live_audit_held_records WHERE {SCOPE} AND event_count>=?6 AND event_count<?7"), params![p[0], p[1], p[2], p[3], p[4], counts.start, counts.end], |r| r.get(0))
        .map_err(SyncError::corrupt)?;
    let start = top.map_or(counts.start, |top| top + 1);
    Ok((top.is_some(), refused_unheld(conn, p, start..counts.end)?))
}

/// The refused applications a refused application holds with it: those of
/// its lineage below its count and above the verified frontier, not held yet.
pub(crate) fn refused_before(
    conn: &Connection,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<(ReplicationEnvelope, String)>, SyncError> {
    let Some((p, Needs::Events(count))) = lineage(envelope) else {
        return Ok(Vec::new());
    };
    let verified = frontier(conn, p)?;
    Ok(unheld(conn, p, verified + 1..count)?.1)
}

/// Hold a refused audit application or settlement, with every blob it names
/// that this store keeps, before its coordinate is acknowledged. The refused
/// applications it waits on that are not held yet are held first, and the
/// pending refusal an earlier build left for each is cleared.
pub(crate) fn hold_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    reason: &str,
    recovered: &[(ReplicationEnvelope, String)],
) -> Result<(), SyncError> {
    let Some((p, needs)) = lineage(envelope) else {
        return Ok(());
    };
    for (refused, reason) in recovered {
        let count = refused.payload["eventCount"].as_i64();
        insert(tx, refused, p, count, None, reason)?;
        tx.execute(
            "DELETE FROM replication_pending_refusals WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![refused.workspace_id, refused.origin_id, refused.origin_seq],
        )
        .map_err(SyncError::persist)?;
    }
    let count = match needs {
        Needs::Events(count) => Some(count),
        Needs::Boundary(_) => None,
    };
    let replay = serde_json::to_string(envelope).map_err(SyncError::corrupt)?;
    insert(tx, envelope, p, count, Some(&replay), reason)
}

fn insert(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    p: [&str; 5],
    count: Option<i64>,
    replay: Option<&str>,
    reason: &str,
) -> Result<(), SyncError> {
    let ReplicationEnvelope {
        workspace_id,
        origin_id,
        origin_seq,
        ..
    } = envelope;
    tx.execute(
        "INSERT INTO live_audit_held_records(workspace_id,origin_id,origin_seq,relay_database_namespace,main_version_id,object_id,lineage_claim_id,event_count,envelope_json,reason) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![workspace_id, origin_id, origin_seq, p[0], p[2], p[3], p[4], count, replay, reason],
    )
    .map_err(SyncError::persist)?;
    for (digest, text, kept) in blobs(tx, envelope)? {
        if !kept {
            continue;
        }
        let column = if text { "text_sha256" } else { "binary_sha256" };
        tx.execute(
            &format!("INSERT OR IGNORE INTO live_audit_held_blobs(workspace_id,origin_id,origin_seq,{column}) VALUES (?1,?2,?3,?4)"),
            params![workspace_id, origin_id, origin_seq, digest],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}
