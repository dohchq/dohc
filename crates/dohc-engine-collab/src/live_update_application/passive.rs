use super::*;
use dohc_engine_storage::replica::{advance_frontiers, read_frontiers};
use dohc_engine_storage::{FaultAction, FaultPoint};

#[cfg(any(test, feature = "test-support"))]
#[path = "passive/page_timings.rs"]
pub mod page_timings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaAuthority {
    pub lineage_claim_id: String,
    pub baseline_sequence: i64,
    pub restore_fence_generation: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaRestore {
    pub operation_id: String,
    pub checkpoint_digest: String,
    pub checkpoint_bytes: Vec<u8>,
    pub proof: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaJournalRow {
    pub admitted: AdmittedLiveUpdate,
    pub relay_database_namespace: String,
    pub evidence_digest: String,
    pub journal_cursor: i64,
    pub authority: Option<ReplicaAuthority>,
    pub restore: Option<ReplicaRestore>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaPageResult {
    pub revision: i64,
    pub log_cursor: i64,
    pub journal_cursor: i64,
    pub applied: usize,
    pub skipped: usize,
    pub blocked_cursor: Option<i64>,
}

pub fn apply_page(
    store: &mut EngineStore,
    workspace: &str,
    after: i64,
    epoch_log_floor: i64,
    rows: &[ReplicaJournalRow],
    faults: &dyn FaultInjector,
) -> Result<ReplicaPageResult, ApplicationError> {
    if !store.is_passive() {
        return Err(invalid("journal application requires a passive store"));
    }
    integer(after, 0, SAFE)?;
    integer(epoch_log_floor, 0, SAFE)?;
    if rows.len() > 500 {
        return Err(invalid("replica page exceeds row limit"));
    }
    let mut appended = std::collections::HashMap::<DocKey, i64>::new();
    #[cfg(any(test, feature = "test-support"))]
    let mut timings = page_timings::PhaseTimer::default();
    let result = store.write_with(faults, |tx| -> Result<ReplicaPageResult, ApplicationError> {
        let mut cache = durable::TransactionDocCache::new(tx);
        let mut touched = std::collections::HashSet::new();
        let frontier = read_frontiers(tx, workspace)?;
        if after > frontier.journal_cursor { return Err(ApplicationError::Conflict); }
        let mut result = ReplicaPageResult {revision:frontier.revision, log_cursor:frontier.log_cursor,
            journal_cursor:frontier.journal_cursor, applied:0, skipped:0, blocked_cursor:None};
        let mut previous_cursor = after;
        #[cfg(any(test, feature = "test-support"))]
        timings.start_rows();
        for row in rows {
            row.admitted.validate()?;
            identifier(&row.relay_database_namespace, 512)?;
            digest(&row.evidence_digest)?;
            let event = &row.admitted;
            let b = &event.metadata.accepted.binding;
            let receipt = &event.metadata.accepted.receipt;
            if let Some(authority) = &row.authority {
                digest(&authority.lineage_claim_id)?;
                integer(authority.baseline_sequence, 0, SAFE)?;
                integer(authority.restore_fence_generation, 0, SAFE)?;
                if authority.lineage_claim_id == b.lineage_claim_id && authority.restore_fence_generation < b.restore_fence_generation {
                    return Err(ApplicationError::Conflict);
                }
            }
            if b.workspace_id != workspace { return Err(ApplicationError::WorkspaceMismatch); }
            if row.journal_cursor != receipt.journal_cursor || row.journal_cursor <= previous_cursor {
                return Err(ApplicationError::Conflict);
            }
            previous_cursor = row.journal_cursor;
            let retained = retained_delivery(tx, row)?;
            let key = DocKey::new(workspace, &b.main_version_id, &b.object_id)?;
            let marker = durable::read_marker_in(tx, &key)?;
            let matches = marker.as_ref().is_some_and(|m| m.lineage_claim_id.as_deref()==Some(&b.lineage_claim_id));
            let retired: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_inactive_lineages WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
                params![workspace,b.main_version_id,b.object_id,b.lineage_claim_id], |r| r.get(0)).map_err(read_sql)?;
            // Delete removes rich-document markers rather than archiving them.
            // An applied base proves this missing lineage was already present.
            let retired = !matches && (retired || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND op_kind='ydoc.update' AND apply_disposition='applied' \
                 AND json_extract(payload_json,'$.versionId')=?2 AND json_extract(payload_json,'$.objectId')=?3 \
                 AND json_extract(payload_json,'$.lineageClaimId')=?4 AND json_extract(payload_json,'$.isBaseState')=1)",
                params![workspace,b.main_version_id,b.object_id,b.lineage_claim_id], |r|r.get::<_,bool>(0)).map_err(read_sql)?);
            let retired_by_authority = row.authority.as_ref().is_none_or(|a| a.lineage_claim_id != b.lineage_claim_id)
                && !matches && row.authority.as_ref().is_none_or(|a| frontier.log_cursor >= a.baseline_sequence);
            // Epoch-floor skips depend on the relay refusing sessions at/below the floor
            // and refusing re-registration with a different baseline for the same lineage.
            let retired_by_epoch = !matches && row.authority.as_ref().is_some_and(|a| a.baseline_sequence <= epoch_log_floor);
            if retained.replay || retired || retired_by_authority || retired_by_epoch {
                result.skipped += 1;
            } else if !matches {
                result.blocked_cursor = Some(row.journal_cursor);
                break;
            } else {
                let did_append = apply_row(tx, row, &key, retained.audit, &mut cache)?;
                touched.insert(key.clone());
                if did_append {
                    appended.insert(key, event.metadata.accepted.received_at_ms);
                }
                result.applied += 1;
            }
            if faults.poll(FaultPoint::SyncBeforeApplyCommit)==FaultAction::Crash { return Err(ApplicationError::Interrupted); }
            result.journal_cursor = result.journal_cursor.max(row.journal_cursor);
        }
        #[cfg(any(test, feature = "test-support"))]
        timings.start_check();
        for key in touched {
            if cache.has_missing_updates(&key)? { return Err(ApplicationError::Conflict); }
        }
        #[cfg(any(test, feature = "test-support"))]
        timings.finish_check();
        advance_frontiers(tx, workspace, frontier.log_cursor, result.journal_cursor)?;
        let frontier = read_frontiers(tx, workspace)?;
        result.revision = frontier.revision;
        Ok(result)
    })?;
    #[cfg(any(test, feature = "test-support"))]
    timings.publish();
    match result {
        TxnOutcome::Committed(result) => {
            for (key, now_ms) in appended {
                durable::maybe_compact(store, &key, DEFAULT_COMPACTION_THRESHOLD, faults, now_ms)?;
            }
            Ok(result)
        }
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

struct RetainedDelivery {
    replay: bool,
    audit: Option<(i64, String)>,
}

fn retained_delivery(
    tx: &Transaction<'_>,
    row: &ReplicaJournalRow,
) -> Result<RetainedDelivery, ApplicationError> {
    let event = &row.admitted;
    let receipt = &event.metadata.accepted.receipt;
    let namespace = &row.relay_database_namespace;
    let saved: Option<(String,String,i64,String)> = tx.query_row(
        "SELECT metadata_json,update_sha256,journal_cursor,evidence_digest FROM live_accepted_updates WHERE relay_database_namespace=?1 AND (delivery_id=?2 OR journal_cursor=?3)",
        params![namespace,receipt.delivery_id,receipt.journal_cursor], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(read_sql)?;
    if let Some((json, update, cursor, evidence)) = saved {
        let metadata: AdmittedLiveUpdateMetadata =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        if metadata != event.metadata
            || update != receipt.update_digest
            || cursor != row.journal_cursor
            || evidence != row.evidence_digest
        {
            return Err(ApplicationError::Conflict);
        }
        return Ok(RetainedDelivery {
            replay: true,
            audit: None,
        });
    }
    Ok(RetainedDelivery {
        replay: false,
        audit: retained_audit(tx, row)?,
    })
}

fn retained_audit(
    tx: &Transaction<'_>,
    row: &ReplicaJournalRow,
) -> Result<Option<(i64, String)>, ApplicationError> {
    let event = &row.admitted;
    let b = &event.metadata.accepted.binding;
    let receipt = &event.metadata.accepted.receipt;
    let namespace = &row.relay_database_namespace;
    let audited: Option<(i64, String, bool)> = tx.query_row(
        "SELECT a.event_count,a.evidence_digest,(a.workspace_id=?4 AND a.main_version_id=?5 AND a.object_id=?6 AND a.lineage_claim_id=?7 AND a.delivery_id=?2 AND a.journal_cursor=?3 AND m.update_sha256=?8) \
         FROM live_audit_events a JOIN live_audit_record_manifests m ON m.record_digest=a.record_digest \
         WHERE a.relay_database_namespace=?1 AND (a.delivery_id=?2 OR a.journal_cursor=?3)",
        params![namespace,receipt.delivery_id,receipt.journal_cursor,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,receipt.update_digest],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(read_sql)?;
    let Some((count, evidence, matches)) = audited else {
        return Ok(None);
    };
    if !matches || evidence != row.evidence_digest {
        return Err(ApplicationError::Conflict);
    }
    let previous = if count == 1 {
        Some(accepted_history::initial_digest(namespace, b)?)
    } else {
        tx.query_row("SELECT evidence_digest FROM live_accepted_updates WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND event_count=?6 \
            UNION ALL SELECT evidence_digest FROM live_audit_events WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND event_count=?6 LIMIT 1",
            params![namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,count-1],|r|r.get::<_,String>(0)).optional().map_err(read_sql)?
    };
    if let Some(previous) = previous {
        if accepted_history::next_digest(&previous, count, &event.metadata)? != evidence {
            return Err(ApplicationError::Conflict);
        }
    }
    Ok(Some((count, evidence)))
}

fn apply_row(
    tx: &Transaction<'_>,
    row: &ReplicaJournalRow,
    key: &DocKey,
    audited: Option<(i64, String)>,
    cache: &mut durable::TransactionDocCache<'_, '_>,
) -> Result<bool, ApplicationError> {
    let event = &row.admitted;
    let b = &event.metadata.accepted.binding;
    let receipt = &event.metadata.accepted.receipt;
    let namespace = &row.relay_database_namespace;
    type Position = (String, i64, i64, String, i64);
    let previous: Option<Position> = tx.query_row(
        "SELECT relay_database_namespace,restore_generation,event_count,evidence_digest,journal_cursor FROM replica_documents WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(read_sql)?;
    let (generation, count, evidence, cursor) = match previous {
        Some((saved_namespace, generation, count, evidence, cursor)) => {
            if saved_namespace != *namespace {
                return Err(ApplicationError::Conflict);
            }
            (generation, count, evidence, cursor)
        }
        None => {
            let initial = accepted_history::initial_digest(namespace, b)?;
            // The relay registers every new lineage at restore generation one.
            (1, 0, initial, 0)
        }
    };
    if receipt.journal_cursor <= cursor || b.restore_fence_generation < generation {
        return Err(ApplicationError::Conflict);
    }
    if b.restore_fence_generation > generation && row.restore.is_none() {
        return Err(ApplicationError::Conflict);
    }
    if let Some(restore) = &row.restore {
        validate_restore(row, restore, generation)?;
    }
    let count = count
        .checked_add(1)
        .filter(|n| *n <= SAFE)
        .ok_or(ApplicationError::Conflict)?;
    let evidence = accepted_history::next_digest(&evidence, count, &event.metadata)?;
    if evidence != row.evidence_digest
        || audited
            .as_ref()
            .is_some_and(|(saved_count, saved_evidence)| {
                *saved_count != count || *saved_evidence != evidence
            })
    {
        return Err(ApplicationError::Conflict);
    }
    record_provenance(tx, namespace, event)?;
    let mut appended = false;
    if let Some(restore) = &row.restore {
        // Restore admissions can include native sources absent from the journal,
        // including delete-only updates with no new clock ranges. Their retained
        // proof contains digests, not bytes, so the checkpoint supplies that state.
        appended = !cache
            .append(
                key,
                &restore.checkpoint_bytes,
                event.metadata.accepted.received_at_ms,
            )?
            .deduped;
    }
    let append = cache.append(
        key,
        &event.update_bytes,
        event.metadata.accepted.received_at_ms,
    )?;
    accepted_history::append(
        tx,
        namespace,
        b,
        event,
        count,
        1,
        event.update_bytes.len() as i64,
        &evidence,
    )?;
    save_position(tx, row, count, &evidence)?;
    Ok(appended || !append.deduped)
}

// The index contains disjoint ranges. The last range starting before a
// candidate's end is therefore the only possible overlap, even across pages.
fn record_provenance(
    tx: &Transaction<'_>,
    namespace: &str,
    event: &AdmittedLiveUpdate,
) -> Result<(), ApplicationError> {
    let b = &event.metadata.accepted.binding;
    for range in &event.metadata.first_seen {
        let end: Option<i64> = tx.query_row(
            "SELECT end_clock FROM replica_first_seen WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND client_id=?6 AND start_clock<?7 ORDER BY start_clock DESC LIMIT 1",
            params![namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,range.client_id,range.end_clock],|r|r.get(0)).optional().map_err(read_sql)?;
        if end.is_some_and(|end| end > range.start_clock) {
            return Err(ApplicationError::Conflict);
        }
        tx.execute(
            "INSERT INTO replica_first_seen VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                namespace,
                b.workspace_id,
                b.main_version_id,
                b.object_id,
                b.lineage_claim_id,
                range.client_id,
                range.start_clock,
                range.end_clock
            ],
        )
        .map_err(write_sql)?;
    }
    Ok(())
}

fn save_position(
    tx: &Transaction<'_>,
    row: &ReplicaJournalRow,
    count: i64,
    evidence: &str,
) -> Result<(), ApplicationError> {
    let b = &row.admitted.metadata.accepted.binding;
    tx.execute("INSERT INTO replica_documents(workspace_id,main_version_id,object_id,lineage_claim_id,relay_database_namespace,restore_generation,event_count,evidence_digest,journal_cursor) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
        ON CONFLICT(workspace_id,main_version_id,object_id,lineage_claim_id) DO UPDATE SET
        restore_generation=excluded.restore_generation,event_count=excluded.event_count,evidence_digest=excluded.evidence_digest,journal_cursor=excluded.journal_cursor
        WHERE excluded.journal_cursor>replica_documents.journal_cursor AND excluded.restore_generation>=replica_documents.restore_generation",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,row.relay_database_namespace,b.restore_fence_generation,count,evidence,row.journal_cursor]).map_err(write_sql)?;
    Ok(())
}

fn validate_restore(
    row: &ReplicaJournalRow,
    restore: &ReplicaRestore,
    generation: i64,
) -> Result<(), ApplicationError> {
    identifier(&restore.operation_id, 512)?;
    let proof = &restore.proof;
    let admitted: AdmittedLiveUpdateMetadata = serde_json::from_value(proof["admitted"].clone())
        .map_err(|_| ApplicationError::Conflict)?;
    let fence: NativeRestoreFenceReceipt =
        serde_json::from_value(proof["preparation"]["fence"].clone())
            .map_err(|_| ApplicationError::Conflict)?;
    fence.operation.validate()?;
    integer(fence.local_head_sequence, 0, SAFE)?;
    integer(fence.recorded_at_ms, 0, SAFE)?;
    let operation = &fence.operation;
    let b = &row.admitted.metadata.accepted.binding;
    let mut intended = operation.old_binding.clone();
    intended.restore_fence_generation = operation.new_fence;
    if !matches!(
        admitted.accepted.authority,
        ServerDerivedLiveUpdateAuthority::Owner { .. }
    ) || admitted != row.admitted.metadata
        || operation.operation_id != restore.operation_id
        || operation.relay_database_namespace != row.relay_database_namespace
        || proof["preparation"]["point"]["journalCursor"].as_i64()
            != Some(operation.point.journal_cursor)
        || proof["preparation"]["point"]["receiptDigest"].as_str()
            != Some(operation.point.receipt_digest.as_str())
        || fence.local_head_sequence < operation.applied_sequence
        || intended != *b
        || operation.old_binding.restore_fence_generation != generation
        || operation.new_fence != generation + 1
        || proof["candidateDigest"] != row.admitted.metadata.accepted.receipt.update_digest
        || proof["checkpointDigest"] != restore.checkpoint_digest
        || hex_sha256(&restore.checkpoint_bytes) != restore.checkpoint_digest
    {
        return Err(ApplicationError::Conflict);
    }
    let checkpoint = crate::Ydoc::wire();
    checkpoint.apply(&restore.checkpoint_bytes)?;
    checkpoint.validate_public_baseline(&restore.checkpoint_bytes)?;
    Ok(())
}
