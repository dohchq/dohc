use super::*;
use dohc_engine_storage::replica::{advance_frontiers, read_frontiers};
use dohc_engine_storage::{FaultAction, FaultPoint};

#[cfg(any(test, feature = "test-support"))]
#[path = "passive/page_timings.rs"]
pub mod page_timings;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// A restore the relay declined after its native fence committed, as the
/// journal carries it at its own cursor, between accepted deliveries. It is
/// no delivery: no update, no event count, no evidence digest of its own.
/// `cancellation` is the host's terminal cancellation, which binds the
/// operation and its fence to the stopped binding at the new generation and
/// the accepted endpoint the fence froze. A replica at exactly the fence's
/// old generation and that endpoint advances its generation; its document
/// state and accepted history stay, and no retained work arrives with it.
/// Before the lineage's first accepted event that endpoint is event zero at
/// the lineage's initial digest. The replica keeps the record it applied, and
/// a replay must be that record. `authority` is the document's current
/// authority when the relay served the page, as a delivery carries it; it can
/// change between replays, so the replica neither keeps nor compares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaRestoreCancellation {
    pub relay_database_namespace: String,
    pub journal_cursor: i64,
    pub cancellation: NativeRestoreCancellationReceipt,
    // Require the field while allowing an explicit null.
    #[serde(deserialize_with = "Option::<ReplicaAuthority>::deserialize")]
    pub authority: Option<ReplicaAuthority>,
}

/// One entry of a replica page, in journal order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReplicaJournalEntry {
    Update(ReplicaJournalRow),
    Cancellation(ReplicaRestoreCancellation),
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
    rows: &[ReplicaJournalEntry],
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
    let result = store.write_with(
        faults,
        |tx| -> Result<ReplicaPageResult, ApplicationError> {
            let mut cache = durable::TransactionDocCache::new(tx);
            let mut touched = std::collections::HashSet::new();
            let frontier = read_frontiers(tx, workspace)?;
            if after > frontier.journal_cursor {
                return Err(ApplicationError::Conflict);
            }
            let mut result = ReplicaPageResult {
                revision: frontier.revision,
                log_cursor: frontier.log_cursor,
                journal_cursor: frontier.journal_cursor,
                applied: 0,
                skipped: 0,
                blocked_cursor: None,
            };
            let mut previous_cursor = after;
            #[cfg(any(test, feature = "test-support"))]
            timings.start_rows();
            for entry in rows {
                let row = match entry {
                    ReplicaJournalEntry::Update(row) => row,
                    ReplicaJournalEntry::Cancellation(record) => {
                        if record.journal_cursor <= previous_cursor {
                            return Err(ApplicationError::Conflict);
                        }
                        previous_cursor = record.journal_cursor;
                        match apply_cancellation(
                            tx,
                            workspace,
                            record,
                            frontier.log_cursor,
                            epoch_log_floor,
                        )? {
                            Control::Applied => result.applied += 1,
                            Control::Skipped => result.skipped += 1,
                            Control::Blocked => {
                                result.blocked_cursor = Some(record.journal_cursor);
                                break;
                            }
                        }
                        if faults.poll(FaultPoint::SyncBeforeApplyCommit) == FaultAction::Crash {
                            return Err(ApplicationError::Interrupted);
                        }
                        result.journal_cursor = result.journal_cursor.max(record.journal_cursor);
                        continue;
                    }
                };
                row.admitted.validate()?;
                identifier(&row.relay_database_namespace, 512)?;
                digest(&row.evidence_digest)?;
                let event = &row.admitted;
                let b = &event.metadata.accepted.binding;
                let receipt = &event.metadata.accepted.receipt;
                validate_authority(row.authority.as_ref(), b)?;
                if b.workspace_id != workspace {
                    return Err(ApplicationError::WorkspaceMismatch);
                }
                if row.journal_cursor != receipt.journal_cursor
                    || row.journal_cursor <= previous_cursor
                {
                    return Err(ApplicationError::Conflict);
                }
                previous_cursor = row.journal_cursor;
                let retained = retained_delivery(tx, row)?;
                let key = DocKey::new(workspace, &b.main_version_id, &b.object_id)?;
                let marker = durable::read_marker_in(tx, &key)?;
                let matches = marker
                    .as_ref()
                    .is_some_and(|m| m.lineage_claim_id.as_deref() == Some(&b.lineage_claim_id));
                let retired = !matches && retired_lineage(tx, b)?;
                let retired_by_authority = !matches
                    && row
                        .authority
                        .as_ref()
                        .is_none_or(|a| retired_by(a, b, frontier.log_cursor, epoch_log_floor));
                if retained.replay || retired || retired_by_authority {
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
                if faults.poll(FaultPoint::SyncBeforeApplyCommit) == FaultAction::Crash {
                    return Err(ApplicationError::Interrupted);
                }
                result.journal_cursor = result.journal_cursor.max(row.journal_cursor);
            }
            #[cfg(any(test, feature = "test-support"))]
            timings.start_check();
            for key in touched {
                if cache.has_missing_updates(&key)? {
                    return Err(ApplicationError::Conflict);
                }
            }
            #[cfg(any(test, feature = "test-support"))]
            timings.finish_check();
            advance_frontiers(tx, workspace, frontier.log_cursor, result.journal_cursor)?;
            let frontier = read_frontiers(tx, workspace)?;
            result.revision = frontier.revision;
            Ok(result)
        },
    )?;
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
    let (generation, count, evidence, cursor) = position(tx, namespace, b)?;
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

enum Control {
    Applied,
    Skipped,
    Blocked,
}

/// Where the replica holds `binding`'s lineage in `namespace`: its
/// generation, then the event count, evidence digest and cursor of its last
/// accepted event. Before the first event the lineage stands at event zero
/// and its initial digest, at the generation its last cancelled restore
/// reached, else at one, where the relay registers every new lineage.
fn position(
    tx: &Transaction<'_>,
    namespace: &str,
    b: &LiveObjectBinding,
) -> Result<(i64, i64, String, i64), ApplicationError> {
    let document = params![
        b.workspace_id,
        b.main_version_id,
        b.object_id,
        b.lineage_claim_id
    ];
    let saved: Option<(String, i64, i64, String, i64)> = tx.query_row(
        "SELECT relay_database_namespace,restore_generation,event_count,evidence_digest,journal_cursor FROM replica_documents WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
        document, |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(read_sql)?;
    let (saved_namespace, position) = match saved {
        Some((saved, generation, count, evidence, cursor)) => {
            (Some(saved), (generation, count, evidence, cursor))
        }
        None => {
            let cancelled: Option<(String, i64)> = tx.query_row(
                "SELECT relay_database_namespace,restore_generation FROM replica_restore_cancellations WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 ORDER BY restore_generation DESC LIMIT 1",
                document, |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(read_sql)?;
            let initial = accepted_history::initial_digest(namespace, b)?;
            match cancelled {
                Some((saved, generation)) => (Some(saved), (generation, 0, initial, 0)),
                None => (None, (1, 0, initial, 0)),
            }
        }
    };
    if saved_namespace.is_some_and(|saved| saved != namespace) {
        return Err(ApplicationError::Conflict);
    }
    Ok(position)
}

/// Whether a lineage this replica no longer marks was present before: its
/// archive, or an applied base. Delete removes rich-document markers rather
/// than archiving them.
fn retired_lineage(tx: &Transaction<'_>, b: &LiveObjectBinding) -> Result<bool, ApplicationError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_inactive_lineages WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4) \
         OR EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND op_kind='ydoc.update' AND apply_disposition='applied' \
         AND json_extract(payload_json,'$.versionId')=?2 AND json_extract(payload_json,'$.objectId')=?3 \
         AND json_extract(payload_json,'$.lineageClaimId')=?4 AND json_extract(payload_json,'$.isBaseState')=1)",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |r|r.get(0)).map_err(read_sql)
}

/// The relay's current authority for a document never holds `b`'s lineage at
/// a generation before `b`'s.
fn validate_authority(
    authority: Option<&ReplicaAuthority>,
    b: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    let Some(authority) = authority else {
        return Ok(());
    };
    digest(&authority.lineage_claim_id)?;
    integer(authority.baseline_sequence, 0, SAFE)?;
    integer(authority.restore_fence_generation, 0, SAFE)?;
    if authority.lineage_claim_id == b.lineage_claim_id
        && authority.restore_fence_generation < b.restore_fence_generation
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

/// Whether the relay's current authority retires `b`'s lineage, which the
/// replica does not mark: another lineage whose baseline the replica's log
/// has reached, or a baseline at or below the epoch floor.
// Epoch-floor skips depend on the relay refusing sessions at/below the floor
// and refusing re-registration with a different baseline for the same lineage.
fn retired_by(
    authority: &ReplicaAuthority,
    b: &LiveObjectBinding,
    log_cursor: i64,
    epoch_log_floor: i64,
) -> bool {
    authority.lineage_claim_id != b.lineage_claim_id && log_cursor >= authority.baseline_sequence
        || authority.baseline_sequence <= epoch_log_floor
}

/// Advance the replica's lineage past a cancelled restore. The record must
/// agree with itself and name this namespace, and the replica must stand at
/// exactly the fence's old generation and the endpoint the cancellation
/// kept: its event count, evidence digest and cursor. The replica keeps the
/// record with the generation it moved; a record sharing its cursor,
/// operation or lineage generation skips only when it is that record.
/// Anything else refuses. A lineage the replica once held and no longer
/// marks skips the record, as its deliveries skip, and so does one the
/// record's authority retires; any other blocks.
fn apply_cancellation(
    tx: &Transaction<'_>,
    workspace: &str,
    record: &ReplicaRestoreCancellation,
    log_cursor: i64,
    epoch_log_floor: i64,
) -> Result<Control, ApplicationError> {
    identifier(&record.relay_database_namespace, 512)?;
    integer(record.journal_cursor, 1, SAFE)?;
    let cancellation = &record.cancellation;
    cancellation
        .validate()
        .map_err(|_| ApplicationError::Conflict)?;
    let operation = &cancellation.fence.operation;
    let endpoint = &cancellation.endpoint;
    let b = &cancellation.binding;
    validate_authority(record.authority.as_ref(), b)?;
    let endpoint_cursor = endpoint
        .terminal_receipt
        .as_ref()
        .map_or(0, |r| r.journal_cursor);
    if b.workspace_id != workspace {
        return Err(ApplicationError::WorkspaceMismatch);
    }
    if operation.relay_database_namespace != record.relay_database_namespace
        || endpoint_cursor >= record.journal_cursor
    {
        return Err(ApplicationError::Conflict);
    }
    let kept = ReplicaRestoreCancellation {
        authority: None,
        ..record.clone()
    };
    let json = serde_json::to_string(&kept).map_err(|_| ApplicationError::Corrupt)?;
    let saved = {
        let mut query = tx.prepare(
            "SELECT record_json FROM replica_restore_cancellations WHERE (relay_database_namespace=?1 AND (journal_cursor=?2 OR operation_id=?3)) \
             OR (workspace_id=?4 AND main_version_id=?5 AND object_id=?6 AND lineage_claim_id=?7 AND restore_generation=?8)",
        ).map_err(read_sql)?;
        let rows = query
            .query_map(
                params![
                    record.relay_database_namespace,
                    record.journal_cursor,
                    operation.operation_id,
                    b.workspace_id,
                    b.main_version_id,
                    b.object_id,
                    b.lineage_claim_id,
                    b.restore_fence_generation
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(read_sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    if !saved.is_empty() {
        for saved in &saved {
            let saved: ReplicaRestoreCancellation =
                serde_json::from_str(saved).map_err(|_| ApplicationError::Corrupt)?;
            if saved != kept {
                return Err(ApplicationError::Conflict);
            }
        }
        return Ok(Control::Skipped);
    }
    let key = DocKey::new(workspace, &b.main_version_id, &b.object_id)?;
    let matches = durable::read_marker_in(tx, &key)?
        .is_some_and(|m| m.lineage_claim_id.as_deref() == Some(&b.lineage_claim_id));
    if !matches {
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM replica_documents WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
            params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |r| r.get(0)).map_err(read_sql)?;
        let retired = record
            .authority
            .as_ref()
            .is_none_or(|a| retired_by(a, b, log_cursor, epoch_log_floor));
        return Ok(if held || retired || retired_lineage(tx, b)? {
            Control::Skipped
        } else {
            Control::Blocked
        });
    }
    let (generation, count, evidence, cursor) = position(tx, &record.relay_database_namespace, b)?;
    if generation != operation.old_binding.restore_fence_generation
        || count != endpoint.event_count
        || evidence != endpoint.history_evidence_digest
        || cursor != endpoint_cursor
    {
        return Err(ApplicationError::Conflict);
    }
    // A lineage with no accepted event yet has no position row; its record
    // alone holds the generation.
    let changed = tx.execute(
        "UPDATE replica_documents SET restore_generation=?5 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_generation=?6",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,operation.new_fence,generation],
    ).map_err(write_sql)?;
    if changed != usize::from(count > 0) {
        return Err(ApplicationError::Corrupt);
    }
    tx.execute(
        "INSERT INTO replica_restore_cancellations(relay_database_namespace,journal_cursor,operation_id,workspace_id,main_version_id,object_id,lineage_claim_id,restore_generation,record_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![record.relay_database_namespace,record.journal_cursor,operation.operation_id,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,operation.new_fence,json],
    ).map_err(write_sql)?;
    Ok(Control::Applied)
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
