use super::*;
use dohc_engine_collab::owner_outbox::{self, prefix};
use rusqlite::Connection;

macro_rules! owned_pending { () => { "EXISTS(SELECT 1 FROM release_held_ops r JOIN release_holds h
    ON h.workspace_id=r.workspace_id AND h.version_id=r.version_id AND h.object_id=r.object_id AND h.release_digest=r.release_digest
    WHERE r.workspace_id=p.workspace_id AND r.origin_id=p.origin_id AND r.origin_seq=p.origin_seq
    AND r.version_id=p.main_version_id AND r.object_id=p.object_id AND h.relay_namespace=p.relay_namespace
    AND json(h.binding_json)=json(p.binding_json) AND json(r.envelope_json)=json(p.envelope_json))" }; }
pub(crate) use owned_pending;

/// Open before sending a claim. Pending settlements still block unbinding until adopted.
pub fn begin_release_hold_in(
    tx: &Transaction<'_>,
    binding: &LiveObjectBinding,
    namespace: &str,
    digest: &str,
) -> Result<ReleaseHold, SyncError> {
    open_in(tx, binding, namespace, digest, true)
}

/// Each page owns at most 64 previously validated coordinates, with their exact envelopes.
pub fn adopt_pending_page_in(tx: &Transaction<'_>, hold: &ReleaseHold) -> Result<usize, SyncError> {
    hold.check_in(tx, false)?;
    let b = &hold.binding;
    let encoded = serde_json::to_string(b).map_err(SyncError::corrupt)?;
    let rows = {
        let mut stmt = tx.prepare("SELECT p.envelope_json FROM owner_pending_settlements p
            WHERE p.workspace_id=?1 AND p.main_version_id=?2 AND p.object_id=?3 AND p.lineage_claim_id=?4
              AND p.relay_namespace=?5 AND json(p.binding_json)=json(?6) AND p.applied=0
              AND NOT EXISTS(SELECT 1 FROM release_held_ops r WHERE r.workspace_id=p.workspace_id AND r.origin_id=p.origin_id AND r.origin_seq=p.origin_seq)
            ORDER BY p.checked_sequence,p.terminal_cursor,p.origin_id,p.origin_seq LIMIT 64").map_err(SyncError::corrupt)?;
        stmt.query_map(
            params![
                b.workspace_id,
                b.main_version_id,
                b.object_id,
                b.lineage_claim_id,
                hold.namespace,
                encoded
            ],
            |r| r.get::<_, Option<String>>(0),
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?
    };
    for json in &rows {
        // A pre-migration row needs authenticated redelivery; never invent missing headers.
        let json = json.as_ref().ok_or_else(waiting)?;
        let op: ReplicationEnvelope = serde_json::from_str(json).map_err(SyncError::corrupt)?;
        validate_pending_envelope_in(tx, hold, &op)?;
        hold.retain_in(tx, &op)?;
    }
    Ok(rows.len())
}

fn validate_pending_envelope_in(
    conn: &Connection,
    hold: &ReleaseHold,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    op.validate()?;
    let encoded = serde_json::to_string(&hold.binding).map_err(SyncError::corrupt)?;
    let matches: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM owner_pending_settlements p JOIN replication_log l
        ON l.workspace_id=p.workspace_id AND l.origin_id=p.origin_id AND l.origin_seq=p.origin_seq
        WHERE p.workspace_id=?1 AND p.origin_id=?2 AND p.origin_seq=?3 AND p.applied=0
          AND json(p.binding_json)=json(?4) AND p.relay_namespace=?5
          AND l.op_kind='moment.append' AND json(l.payload_json)=json(?6) AND l.recorded_at_ms=?7)",
            params![
                op.workspace_id,
                op.origin_id,
                op.origin_seq,
                encoded,
                hold.namespace,
                op.payload_json()?,
                op.recorded_at_ms
            ],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !matches || op.op_kind != "moment.append" || !hold.matches(op) || op.relay_seq.is_none() {
        return Err(SyncError::CoordinateDiverged);
    }
    Ok(())
}

/// Restore the missing envelope only from the authenticated replication caller.
pub fn adopt_redelivered_pending_in(
    tx: &Transaction<'_>,
    hold: &ReleaseHold,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    hold.check_in(tx, false)?;
    validate_pending_envelope_in(tx, hold, op)?;
    let saved: Option<String> = tx.query_row("SELECT envelope_json FROM owner_pending_settlements WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![op.workspace_id,op.origin_id,op.origin_seq],|r|r.get(0)).map_err(SyncError::corrupt)?;
    let json = serde_json::to_string(op).map_err(SyncError::corrupt)?;
    if saved.is_some_and(|saved| saved != json) {
        return Err(SyncError::CoordinateDiverged);
    }
    tx.execute("UPDATE owner_pending_settlements SET envelope_json=?4 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![op.workspace_id,op.origin_id,op.origin_seq,json]).map_err(SyncError::persist)?;
    let existing: Option<(String,String)> = tx.query_row("SELECT envelope_json,release_digest FROM release_held_ops WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",params![op.workspace_id,op.origin_id,op.origin_seq],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
    if existing
        .as_ref()
        .is_some_and(|(saved, digest)| saved != &json || digest != &hold.digest)
    {
        return Err(SyncError::CoordinateDiverged);
    }
    if existing.is_none() {
        hold.retain_in(tx, op)?;
    }
    Ok(())
}

/// The readiness and final unbinding checks share this exact coordinate predicate.
pub fn pending_release_blocked_in(
    conn: &Connection,
    hold: &ReleaseHold,
) -> Result<bool, SyncError> {
    let b = &hold.binding;
    hold.check_identity_in(conn)?;
    conn.query_row(concat!("SELECT EXISTS(SELECT 1 FROM owner_pending_settlements p
        WHERE p.workspace_id=?1 AND p.main_version_id=?2 AND p.object_id=?3 AND p.lineage_claim_id=?4 AND p.relay_namespace=?5 AND p.applied=0
        AND NOT (",owned_pending!(),"))"),
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,hold.namespace],|r|r.get(0)).map_err(SyncError::corrupt)
}

/// Final local release does no folding; all credited entries and History boundaries already committed.
pub fn unbind_release_in(
    tx: &Transaction<'_>,
    hold: &ReleaseHold,
    now_ms: i64,
) -> Result<(), SyncError> {
    hold.check_in(tx, false)?;
    let b = &hold.binding;
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)
        .map_err(SyncError::corrupt)?;
    let sealed: bool=tx.query_row("SELECT anchor_cursor IS NOT NULL AND abandoned=0 AND EXISTS(SELECT 1 FROM ydoc_owner_bindings b WHERE b.workspace_id=h.workspace_id AND b.main_version_id=h.version_id AND b.object_id=h.object_id AND b.accepted_cursor=h.anchor_cursor AND b.checkpoint_digest=h.anchor_sha256) FROM release_holds h WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id],|r|r.get(0)).map_err(SyncError::corrupt)?;
    if !sealed || pending_release_blocked_in(tx, hold)? {
        return Err(waiting());
    }
    let progress = prefix::progress_in(tx, &key)
        .map_err(SyncError::corrupt)?
        .ok_or_else(waiting)?;
    if progress.release_digest != hold.digest
        || progress.settlement_owed
        || prefix::pending_entries_in(tx, b).map_err(SyncError::corrupt)? != 0
        || dohc_engine_collab::author_coverage::unresolved_in(tx, &key)
            .map_err(SyncError::corrupt)?
    {
        return Err(waiting());
    }
    let saved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_docs d JOIN snapshots s ON s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id AND s.path=d.path WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3 AND d.settled_update_seq=d.head_update_seq AND COALESCE(d.last_settled_sha,d.seed_source_sha256)=s.blob_sha256 AND NOT EXISTS(SELECT 1 FROM materialization_jobs j WHERE j.workspace_id IN (?1,'') AND j.target_path=s.path AND j.status='pending'))",params![b.workspace_id,b.main_version_id,b.object_id],|r|r.get(0)).map_err(SyncError::corrupt)?;
    if !saved {
        return Err(waiting());
    }
    owner_outbox::release::require_not_host_in(tx, &key).map_err(SyncError::corrupt)?;
    let encoded = serde_json::to_string(b).map_err(SyncError::corrupt)?;
    let removed=tx.execute("DELETE FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND json(binding_json)=json(?4) AND relay_database_namespace=?5",params![b.workspace_id,b.main_version_id,b.object_id,encoded,hold.namespace]).map_err(SyncError::persist)?;
    if removed != 1 {
        return Err(waiting());
    }
    prefix::mark_released_in_tx(tx, b, &hold.digest, now_ms).map_err(SyncError::corrupt)
}

/// Fence unfinished claims; a released claim can only replay already-held peer work.
pub fn abandon_release_hold_in(
    tx: &Transaction<'_>,
    hold: &ReleaseHold,
    expected_digest: &str,
) -> Result<(), SyncError> {
    hold.check_identity_in(tx)?;
    if expected_digest != hold.digest {
        return Err(SyncError::CoordinateDiverged);
    }
    let encoded = serde_json::to_string(&hold.binding).map_err(SyncError::corrupt)?;
    tx.execute("UPDATE release_holds SET abandoned=1,replay_ready=EXISTS(SELECT 1 FROM owner_live_stops s WHERE s.workspace_id=?1 AND s.main_version_id=?2 AND s.object_id=?3 AND s.state='released' AND json_extract(s.binding_json,'$.binding')=json(?5) AND json_extract(s.binding_json,'$.prefix.releaseDigest')=?4 AND s.relay_database_namespace=?6) WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND release_digest=?4",params![hold.binding.workspace_id,hold.binding.main_version_id,hold.binding.object_id,hold.digest,encoded,hold.namespace]).map_err(SyncError::persist)?;
    Ok(())
}

pub(crate) fn check_deferred_release_in(
    conn: &Connection,
    key: &DocKey,
    origin: &str,
    seq: i64,
) -> Result<(), SyncError> {
    let saved:Option<(String,i64,Option<String>,bool)>=conn.query_row("SELECT d.release_digest,d.release_generation,h.release_digest,COALESCE(h.replay_ready,0) FROM ydoc_deferred_updates d LEFT JOIN release_holds h ON h.workspace_id=d.workspace_id AND h.version_id=d.version_id AND h.object_id=d.object_id WHERE d.workspace_id=?1 AND d.origin_id=?2 AND d.origin_seq=?3 AND d.release_digest IS NOT NULL",params![key.workspace_id,origin,seq],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(SyncError::corrupt)?;
    if let Some((digest, generation, held, ready)) = saved {
        // Unfinished abandonment clears readiness; only the exact final release retains it.
        if held.is_some_and(|held| held != digest || !ready) {
            return Err(waiting());
        }
        dohc_engine_collab::live_update_application::require_restore_generation(
            conn,
            key,
            (generation > 0).then_some(generation),
        )
        .map_err(crate::ydoc_apply::map_collab_hard_error)?;
    }
    Ok(())
}

/// Durable dependency rows are the wake source after a crash or a report acknowledgement.
pub fn release_deferred_wakes_in(
    conn: &Connection,
    workspace: &str,
    after: Option<&DocKey>,
) -> Result<Vec<DocKey>, SyncError> {
    if after.is_some_and(|key| key.workspace_id != workspace) {
        return Err(SyncError::CoordinateDiverged);
    }
    let mut stmt=conn.prepare("SELECT DISTINCT version_id,object_id FROM ydoc_deferred_updates WHERE workspace_id=?1 AND release_digest IS NOT NULL AND (?2 IS NULL OR (version_id,object_id)>(?2,?3)) ORDER BY version_id,object_id LIMIT 64").map_err(SyncError::corrupt)?;
    stmt.query_map(
        params![
            workspace,
            after.map(|k| &k.version_id),
            after.map(|k| &k.object_id)
        ],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .map_err(SyncError::corrupt)?
    .map(|r| {
        let (v, o) = r.map_err(SyncError::corrupt)?;
        DocKey::new(workspace, &v, &o).map_err(SyncError::corrupt)
    })
    .collect()
}

pub(crate) fn deferred_release_ready_in(
    conn: &Connection,
    key: &DocKey,
    origin: &str,
    seq: i64,
) -> Result<bool, SyncError> {
    match check_deferred_release_in(conn, key, origin, seq) {
        Ok(()) => Ok(true),
        Err(SyncError::RetryableState { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}
