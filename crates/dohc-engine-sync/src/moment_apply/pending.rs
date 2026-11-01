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
          relay_namespace,binding_json,terminal_cursor) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            envelope.workspace_id,
            envelope.origin_id,
            envelope.origin_seq,
            binding.main_version_id,
            binding.object_id,
            binding.lineage_claim_id,
            relay_namespace,
            serde_json::to_string(binding).map_err(SyncError::corrupt)?,
            terminal_cursor
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

/// One page of settlements a drain reports, kept across every wait for
/// released-tail validation that splits it: one report id, owned only by the
/// rows it completed.
#[derive(Default)]
pub(crate) struct PendingSettlementReport {
    pub report_id: Option<String>,
    pub has_more: bool,
    pub changes: Vec<MomentMaterializationChange>,
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    /// How many rows the report owns.
    completed: usize,
}

/// A ready row as the drain read it.
struct Ready {
    envelope: ReplicationEnvelope,
    applied: bool,
    deferred: bool,
    facts_json: Option<String>,
    superseded: bool,
    binding_changed: bool,
}

/// Apply accepted settlements into `report` and retain each disk decision
/// until its cursor commits. Empty pulls reclaim applied rows after a crash
/// or failed write. `tails` decides released-lineage protection, bound to
/// `store`. A settlement whose decision waits for validation rolls back with
/// its scheduling, the settlements before it commit with their report, and
/// the drain stops with [`SyncError::ValidationPending`]. Once validation
/// completes, draining into the same `report` goes on from that settlement
/// in a fresh transaction that decides it again.
pub(crate) fn drain_and_claim(
    store: &mut EngineStore,
    workspace_id: &str,
    tails: &ReleasedTails,
    report: &mut PendingSettlementReport,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<(), SyncError> {
    let search_policy = search_policy_for_store(store);
    let limit = PAGE_SIZE.saturating_sub(report.completed);
    let result = store.write_with(faults, |tx| {
        // Paths can change during recovery without advancing the generation.
        // Refuse a changed binding before replaying a ready settlement.
        // A later generation supersedes it regardless of path changes. Rows
        // this report already owns stay out of its page.
        let mut stmt = tx.prepare_cached(
            "SELECT p.origin_id,p.origin_seq,l.payload_json,l.recorded_at_ms,p.applied,\
                    p.main_version_id,p.object_id,p.record_facts_json,\
                    p.applied=0 AND json_extract(b.binding_json,'$.restoreFenceGeneration')>json_extract(p.binding_json,'$.restoreFenceGeneration'),\
                    COALESCE(json(p.binding_json)!=json(b.binding_json),0) \
             FROM owner_pending_settlements p \
             JOIN replication_log l ON l.workspace_id=p.workspace_id \
               AND l.origin_id=p.origin_id AND l.origin_seq=p.origin_seq \
             LEFT JOIN ydoc_owner_bindings b ON b.workspace_id=p.workspace_id \
               AND b.main_version_id=p.main_version_id AND b.object_id=p.object_id \
               AND b.lineage_claim_id=p.lineage_claim_id \
             WHERE p.workspace_id=?1 AND COALESCE(p.report_id!=?2,1) AND (p.applied=1 OR (p.relay_namespace=b.relay_database_namespace AND (\
               (p.terminal_cursor<=b.accepted_cursor AND json_extract(p.binding_json,'$.restoreFenceGeneration')=json_extract(b.binding_json,'$.restoreFenceGeneration')) \
               OR json_extract(b.binding_json,'$.restoreFenceGeneration')>json_extract(p.binding_json,'$.restoreFenceGeneration')))) \
             ORDER BY p.checked_sequence,p.terminal_cursor,p.origin_id,p.origin_seq LIMIT ?3",
        ).map_err(SyncError::corrupt)?;
        let mut rows = stmt.query(params![workspace_id, report.report_id, limit as i64 + 1]).map_err(SyncError::corrupt)?;
        let mut ready = Vec::new();
        while let Some(row) = rows.next().map_err(SyncError::corrupt)? {
            let version: String = row.get(5).map_err(SyncError::corrupt)?;
            let object: String = row.get(6).map_err(SyncError::corrupt)?;
            let key = DocKey::new(workspace_id, &version, &object).map_err(SyncError::corrupt)?;
            let encoded: String = row.get(2).map_err(SyncError::corrupt)?;
            // Each queued row is a bound owner's host settlement, which an open
            // owner editor does not defer. It waits only once the owner is unbound.
            let deferred = leases.is_live(&key) && !is_bound_owner(tx, &key);
            ready.push(Ready {
                envelope: ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: workspace_id.to_owned(),
                    origin_id: row.get(0).map_err(SyncError::corrupt)?,
                    origin_seq: row.get(1).map_err(SyncError::corrupt)?,
                    op_kind: "moment.append".to_owned(),
                    payload: serde_json::from_str(&encoded).map_err(SyncError::corrupt)?,
                    recorded_at_ms: row.get(3).map_err(SyncError::corrupt)?,
                    relay_seq: None,
                },
                applied: row.get(4).map_err(SyncError::corrupt)?,
                deferred,
                facts_json: row.get(7).map_err(SyncError::corrupt)?,
                superseded: row.get(8).map_err(SyncError::corrupt)?,
                binding_changed: row.get(9).map_err(SyncError::corrupt)?,
            });
        }
        drop(rows);
        drop(stmt);
        let has_candidates = ready.len() > limit;
        ready.truncate(limit);
        let report_id = match &report.report_id {
            Some(report_id) => Some(report_id.clone()),
            None if ready.iter().all(|row| row.deferred) => None,
            None => Some(tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get::<_, String>(0)).map_err(SyncError::corrupt)?),
        };
        let mut record_facts = Vec::new();
        let mut envelopes = Vec::new();
        let mut waiting = None;
        let checked_sequence: i64 = tx.query_row("SELECT COALESCE(MAX(checked_sequence),0)+1 FROM owner_pending_settlements WHERE workspace_id=?1", [workspace_id], |r| r.get(0)).map_err(SyncError::corrupt)?;
        for row in ready {
            // Each settlement, its scheduling with it, is atomic: one that
            // waits for validation leaves nothing behind.
            tx.execute_batch("SAVEPOINT owner_settlement").map_err(SyncError::persist)?;
            match settle(tx, workspace_id, &row, checked_sequence, report_id.as_deref(), tails, search_policy.as_ref()) {
                Ok(Some(facts)) => {
                    record_facts.extend(facts);
                    envelopes.push(row.envelope);
                }
                Ok(None) => {}
                Err(SyncError::ValidationPending(pending)) => {
                    tx.execute_batch("ROLLBACK TO owner_settlement; RELEASE owner_settlement").map_err(SyncError::persist)?;
                    waiting = Some(pending);
                    break;
                }
                Err(error) => return Err(error),
            }
            tx.execute_batch("RELEASE owner_settlement").map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>((envelopes, report_id, has_candidates, record_facts, waiting))
    })?;
    let TxnOutcome::Committed((envelopes, report_id, has_candidates, record_facts, waiting)) =
        result
    else {
        return Err(SyncError::FaultCrash);
    };
    report.report_id = report_id;
    report.completed += envelopes.len();
    report.record_facts.extend(record_facts);
    for envelope in envelopes {
        report
            .changes
            .extend(stored_materialization_changes(store, &envelope)?);
    }
    if let Some(pending) = waiting {
        return Err(SyncError::ValidationPending(pending));
    }
    report.has_more = has_candidates && report.completed > 0;
    Ok(())
}

/// Schedule and settle one ready row; the facts of one the report now owns,
/// or none for one that still waits.
fn settle(
    tx: &Transaction<'_>,
    workspace_id: &str,
    row: &Ready,
    checked_sequence: i64,
    report_id: Option<&str>,
    tails: &ReleasedTails,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<Option<Option<dohc_engine_domain::CollectionRecordApplyFacts>>, SyncError> {
    let envelope = &row.envelope;
    tx.execute("UPDATE owner_pending_settlements SET checked_sequence=?4 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3", params![workspace_id,envelope.origin_id,envelope.origin_seq,checked_sequence]).map_err(SyncError::persist)?;
    if row.deferred {
        return Ok(None);
    }
    let mut facts = None;
    if row.superseded {
        refuse(
            tx,
            workspace_id,
            envelope,
            crate::RefusalReason::InvalidInput {
                reason: SUPERSEDED.into(),
            },
        )?;
    } else if !row.applied && row.binding_changed {
        refuse(
            tx,
            workspace_id,
            envelope,
            crate::RefusalReason::InvalidInput {
                reason: BINDING_CHANGED.into(),
            },
        )?;
    } else if !row.applied {
        let payload: MomentAppendPayload =
            serde_json::from_value(envelope.payload.clone()).map_err(SyncError::corrupt)?;
        envelope.validate()?;
        validate_payload_bounds(&payload)?;
        validate_payload(&payload)?;
        // Re-run native binding, settlement digest and cursor checks.
        // The envelope was ACKed on enqueue, so bypass coordinate dedup.
        tx.execute_batch("SAVEPOINT owner_settlement_replay")
            .map_err(SyncError::persist)?;
        match apply_moment_append(
            tx,
            envelope,
            &payload,
            search_policy,
            MomentApplyMode::Ordinary(tails),
            false,
            None,
            None,
        ) {
            Ok(result) => {
                tx.execute_batch("RELEASE owner_settlement_replay")
                    .map_err(SyncError::persist)?;
                let facts_json = result
                    .record_facts
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(SyncError::corrupt)?;
                tx.execute("UPDATE owner_pending_settlements SET record_facts_json=?4 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3", params![workspace_id,envelope.origin_id,envelope.origin_seq,facts_json]).map_err(SyncError::persist)?;
                facts = result.record_facts;
            }
            Err(error) => {
                tx.execute_batch(
                    "ROLLBACK TO owner_settlement_replay; RELEASE owner_settlement_replay",
                )
                .map_err(SyncError::persist)?;
                if matches!(error, SyncError::RetryableState { .. }) {
                    return Ok(None);
                }
                // A decision waiting for validation is not a refusal.
                let Some(reason) = crate::apply::refusal_reason(&error) else {
                    return Err(error);
                };
                refuse(tx, workspace_id, envelope, reason)?;
            }
        }
    } else if let Some(facts_json) = &row.facts_json {
        facts = Some(serde_json::from_str(facts_json).map_err(SyncError::corrupt)?);
    }
    tx.execute(
        "UPDATE owner_pending_settlements SET applied=1,report_id=?4 \
         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![
            workspace_id,
            envelope.origin_id,
            envelope.origin_seq,
            report_id
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(Some(facts))
}

/// [`drain_and_claim`] on fresh tails bound to `store`, run to its end: each
/// validation it waits for completes on the worker before it goes on.
#[cfg(test)]
pub(crate) fn drain_to_end(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<PendingSettlementReport, SyncError> {
    let tails = ReleasedTails::default().bound_to(store);
    let mut report = PendingSettlementReport::default();
    loop {
        match drain_and_claim(store, workspace_id, &tails, &mut report, faults, leases) {
            Ok(()) => return Ok(report),
            Err(SyncError::ValidationPending(pending)) => {
                pending.validate().wait().expect("released tails validate");
            }
            Err(error) => return Err(error),
        }
    }
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
