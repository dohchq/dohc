use super::*;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_storage::TxnOutcome;

const PAGE_SIZE: usize = 64;
pub(crate) const SUPERSEDED: &str =
    "A later restore replaced this save. Open the file to continue.";
pub(crate) const BINDING_CHANGED: &str = "This file's name, location, or sharing changed before this save arrived. Open the file to continue.";

/// The row becomes ready once the authenticated owner reaches the held restore
/// generation and cursor. Any later generation supersedes the row. The drain
/// refuses a ready row if its binding changed; otherwise replay validates it.
pub(super) fn enqueue(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    payload: &MomentAppendPayload,
    relay_namespace: &str,
    binding: &LiveObjectBinding,
    terminal_cursor: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO owner_pending_settlements \
         (workspace_id,origin_id,origin_seq,main_version_id,object_id,lineage_claim_id,\
          relay_namespace,binding_json,terminal_cursor,envelope_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            envelope.workspace_id,
            envelope.origin_id,
            envelope.origin_seq,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
            relay_namespace,
            serde_json::to_string(binding).map_err(SyncError::corrupt)?,
            terminal_cursor,
            serde_json::to_string(envelope).map_err(SyncError::corrupt)?
        ],
    )
    .map_err(SyncError::persist)?;
    for (role, digest, kind) in [
        (
            "payload-before",
            payload.payload_before_blob_sha256.as_deref(),
            payload.payload_before_content_kind.as_deref(),
        ),
        (
            "payload-after",
            Some(payload.payload_after_blob_sha256.as_str()),
            payload.payload_after_content_kind.as_deref(),
        ),
        (
            "before",
            payload.before_blob_sha256.as_deref(),
            payload.before_content_kind.as_deref(),
        ),
    ] {
        if let Some(digest) = digest {
            tx.execute(
                "INSERT INTO owner_pending_settlement_blobs \
                 (workspace_id,origin_id,origin_seq,role,text_sha256,binary_sha256) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    envelope.workspace_id,
                    envelope.origin_id,
                    envelope.origin_seq,
                    role,
                    (ContentKind::from_wire(kind) == ContentKind::Text).then_some(digest),
                    (ContentKind::from_wire(kind) == ContentKind::Binary).then_some(digest)
                ],
            )
            .map_err(SyncError::persist)?;
        }
    }
    Ok(())
}

pub(crate) struct PendingSettlementReport {
    pub report_id: Option<String>,
    pub has_more: bool,
    pub changes: Vec<MomentMaterializationChange>,
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
}

/// Apply accepted settlements and retain each disk decision until its cursor
/// commits. Empty pulls reclaim applied rows after a crash or failed write.
pub(crate) fn drain_and_claim(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<PendingSettlementReport, SyncError> {
    let search_policy = search_policy_for_store(store);
    let result = store.write_with(faults, |tx| {
        // Paths can change during recovery without advancing the generation.
        // Refuse a changed binding before replaying a ready settlement.
        // A later generation supersedes it regardless of path changes.
        let mut stmt = tx.prepare_cached(
            &"SELECT p.origin_id,p.origin_seq,l.payload_json,l.recorded_at_ms,p.applied,\
                    p.main_version_id,p.object_id,p.record_facts_json,\
                    p.applied=0 AND json_extract(b.binding_json,'$.restoreFenceGeneration')>json_extract(p.binding_json,'$.restoreFenceGeneration'),\
                    COALESCE(json(p.binding_json)!=json(b.binding_json),0) \
             FROM owner_pending_settlements p \
             JOIN replication_log l ON l.workspace_id=p.workspace_id \
               AND l.origin_id=p.origin_id AND l.origin_seq=p.origin_seq \
             LEFT JOIN ydoc_owner_bindings b ON b.workspace_id=p.workspace_id \
               AND b.main_version_id=p.main_version_id AND b.object_id=p.object_id \
               AND b.lineage_claim_id=p.lineage_claim_id \
             WHERE p.workspace_id=?1 AND (p.applied=1 OR (p.relay_namespace=b.relay_database_namespace AND (\
               (p.terminal_cursor<=b.accepted_cursor AND json_extract(p.binding_json,'$.restoreFenceGeneration')=json_extract(b.binding_json,'$.restoreFenceGeneration')) \
               OR json_extract(b.binding_json,'$.restoreFenceGeneration')>json_extract(p.binding_json,'$.restoreFenceGeneration')))) \
             AND (p.applied=1 OR NOT (/* release ownership */)) \
             ORDER BY p.checked_sequence,p.terminal_cursor,p.origin_id,p.origin_seq LIMIT 65".replace("/* release ownership */",crate::release_hold::OWNED_PENDING),
        ).map_err(SyncError::corrupt)?;
        let mut rows = stmt.query([workspace_id]).map_err(SyncError::corrupt)?;
        let mut ready = Vec::new();
        while let Some(row) = rows.next().map_err(SyncError::corrupt)? {
            let version: String = row.get(5).map_err(SyncError::corrupt)?;
            let object: String = row.get(6).map_err(SyncError::corrupt)?;
            let key = DocKey::new(workspace_id, &version, &object).map_err(SyncError::corrupt)?;
            let encoded: String = row.get(2).map_err(SyncError::corrupt)?;
            // Each queued row is a bound owner's host settlement, which an open
            // owner editor does not defer. It waits only once the owner is unbound.
            let deferred = leases.is_live(&key) && !is_bound_owner(tx, &key);
            ready.push((ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: workspace_id.to_owned(),
                origin_id: row.get(0).map_err(SyncError::corrupt)?,
                origin_seq: row.get(1).map_err(SyncError::corrupt)?,
                op_kind: "moment.append".to_owned(),
                payload: serde_json::from_str(&encoded).map_err(SyncError::corrupt)?,
                recorded_at_ms: row.get(3).map_err(SyncError::corrupt)?,
                relay_seq: None,
            }, row.get::<_, bool>(4).map_err(SyncError::corrupt)?, deferred, row.get::<_, Option<String>>(7).map_err(SyncError::corrupt)?, row.get::<_, bool>(8).map_err(SyncError::corrupt)?, row.get::<_, bool>(9).map_err(SyncError::corrupt)?));
            if ready.len() > PAGE_SIZE { break; }
        }
        drop(rows);
        drop(stmt);
        let has_candidates = ready.len() > PAGE_SIZE;
        ready.truncate(PAGE_SIZE);
        let report_id = if ready.iter().all(|row| row.2) { None } else {
            Some(tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get::<_, String>(0)).map_err(SyncError::corrupt)?)
        };
        let mut record_facts = Vec::new();
        let mut envelopes = Vec::new();
        let checked_sequence: i64 = tx.query_row("SELECT COALESCE(MAX(checked_sequence),0)+1 FROM owner_pending_settlements WHERE workspace_id=?1", [workspace_id], |r| r.get(0)).map_err(SyncError::corrupt)?;
        for (envelope, applied, deferred, facts_json, superseded, binding_changed) in ready {
            tx.execute("UPDATE owner_pending_settlements SET checked_sequence=?4 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3", params![workspace_id,envelope.origin_id,envelope.origin_seq,checked_sequence]).map_err(SyncError::persist)?;
            if deferred { continue; }
            if superseded {
                refuse(tx, workspace_id, &envelope, crate::RefusalReason::InvalidInput { reason: SUPERSEDED.into() })?;
            } else if !applied && binding_changed {
                refuse(tx, workspace_id, &envelope, crate::RefusalReason::InvalidInput { reason: BINDING_CHANGED.into() })?;
            } else if !applied {
                let payload: MomentAppendPayload = serde_json::from_value(envelope.payload.clone()).map_err(SyncError::corrupt)?;
                envelope.validate()?;
                validate_payload_bounds(&payload)?;
                validate_payload(&payload)?;
                // Re-run native binding, settlement digest and cursor checks.
                // The envelope was ACKed on enqueue, so bypass coordinate dedup.
                tx.execute_batch("SAVEPOINT owner_settlement_replay").map_err(SyncError::persist)?;
                match apply_moment_append(tx, &envelope, &payload, search_policy.as_ref(), MomentApplyMode::Ordinary, false, None) {
                    Ok(result) => {
                        tx.execute_batch("RELEASE owner_settlement_replay").map_err(SyncError::persist)?;
                        let facts_json = result.record_facts.as_ref().map(serde_json::to_string).transpose().map_err(SyncError::corrupt)?;
                        tx.execute("UPDATE owner_pending_settlements SET record_facts_json=?4 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3", params![workspace_id,envelope.origin_id,envelope.origin_seq,facts_json]).map_err(SyncError::persist)?;
                        record_facts.extend(result.record_facts);
                    }
                    Err(error) => {
                        tx.execute_batch("ROLLBACK TO owner_settlement_replay; RELEASE owner_settlement_replay").map_err(SyncError::persist)?;
                        if matches!(error, SyncError::RetryableState { .. }) { continue; }
                        let Some(reason) = crate::apply::refusal_reason(&error) else { return Err(error); };
                        refuse(tx, workspace_id, &envelope, reason)?;
                    }
                }
            } else if let Some(facts_json) = facts_json {
                record_facts.push(serde_json::from_str(&facts_json).map_err(SyncError::corrupt)?);
            }
            tx.execute(
                "UPDATE owner_pending_settlements SET applied=1,report_id=?4 \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![workspace_id,envelope.origin_id,envelope.origin_seq,report_id],
            ).map_err(SyncError::persist)?;
            envelopes.push(envelope);
        }
        let has_more = has_candidates && !envelopes.is_empty();
        Ok::<_, SyncError>((envelopes, report_id, has_more, record_facts))
    })?;
    let TxnOutcome::Committed((envelopes, report_id, has_more, record_facts)) = result else {
        return Err(SyncError::FaultCrash);
    };
    let mut changes = Vec::new();
    for envelope in envelopes {
        changes.extend(stored_materialization_changes(store, &envelope)?);
    }
    Ok(PendingSettlementReport {
        report_id,
        has_more,
        changes,
        record_facts,
    })
}

fn refuse(
    tx: &Transaction<'_>,
    workspace_id: &str,
    envelope: &ReplicationEnvelope,
    reason: crate::RefusalReason,
) -> Result<(), SyncError> {
    crate::apply::persist_refusal(
        tx,
        &crate::ReplicationRefusal {
            workspace_id: workspace_id.to_owned(),
            origin_id: envelope.origin_id.clone(),
            origin_seq: envelope.origin_seq,
            op_kind: envelope.op_kind.clone(),
            reason,
        },
    )?;
    tx.execute(
        "UPDATE replication_log SET apply_disposition='refused' WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![workspace_id, envelope.origin_id, envelope.origin_seq],
    )
    .map_err(SyncError::persist)?;
    // A refused envelope remains inspectable after the queue clears.
    retain_refused_moment_blobs(tx, envelope)
}
