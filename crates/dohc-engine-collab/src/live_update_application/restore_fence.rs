use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RestoreDeliveryOrigin {
    Bootstrap { id: String },
    Owner { id: String },
}

/// Journal point authenticated before committing the restore fence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreSelection {
    pub journal_cursor: i64,
    pub receipt_digest: String,
}

/// Supplied by an authenticated operation adapter after relay old-cut ACK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFence {
    pub point: NativeRestoreSelection,
    pub operation_id: String,
    pub relay_database_namespace: String,
    pub old_binding: LiveObjectBinding,
    pub host_id: String,
    pub new_fence: i64,
    pub origin: RestoreDeliveryOrigin,
    pub terminal: Option<LiveUpdateReceipt>,
    pub applied_sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreFenceReceipt {
    pub operation: NativeRestoreFence,
    pub local_head_sequence: i64,
    pub recorded_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeRestoreRefusalReason {
    BindingChanged,
    ReaderUnavailable,
    SourceUnavailable,
    SourceTooLarge,
    IncompleteWitness,
}

/// A terminal decision committed before this operation could write a fence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreRefusal {
    pub operation: NativeRestoreFence,
    pub reason: NativeRestoreRefusalReason,
    pub recorded_at_ms: i64,
}

const SELECTED_POINT_REPLAY_BYTES: usize = crate::limits::MAX_YDOC_UPDATE_BYTES * 5;

// This document lineage's settlements whose moments have not reached the relay:
// local moments above the origin's pushed cursor, then settlements a retained
// history export has not journaled yet. Unpushed rows bound the scan, not history.
const UNPUBLISHED_SETTLEMENT_MOMENTS: &str = "SELECT EXISTS(SELECT 1 FROM sync_identity i JOIN replication_log r ON r.workspace_id=i.workspace_id AND r.origin_id=i.origin_id WHERE i.workspace_id=?1 AND r.origin_seq>COALESCE((SELECT pushed_seq FROM sync_relay_push_state p WHERE p.workspace_id=?1 AND p.origin_id=i.origin_id),-1) AND r.imported=0 AND r.op_kind='moment.append' AND EXISTS(SELECT 1 FROM live_device_settlements s WHERE s.relay_database_namespace=?2 AND s.workspace_id=?1 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.moment_id=json_extract(r.payload_json,'$.momentId'))) OR EXISTS(SELECT 1 FROM live_audit_pending_exports e JOIN live_device_settlements s ON s.relay_database_namespace=e.relay_database_namespace AND s.workspace_id=e.workspace_id AND s.main_version_id=e.main_version_id AND s.object_id=e.object_id AND s.lineage_claim_id=e.lineage_claim_id AND s.terminal_cursor>e.after_settlement_cursor WHERE e.workspace_id=?1 AND e.relay_database_namespace=?2 AND e.main_version_id=?3 AND e.object_id=?4 AND e.lineage_claim_id=?5)";

// Every edit and live application on a restored document runs these reads.
// The fence row stores its restore proof, which can be tens of MiB, before the
// resume receipt, so the live_restore_resumed index must answer them.
const CURRENT_GENERATION: &str = "SELECT new_generation,resume_receipt_json IS NOT NULL FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 ORDER BY new_generation DESC LIMIT 1";
const RESUMED_REGISTRATION: &str = "SELECT relay_database_namespace,resume_receipt_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND new_generation=?4";
const RESUMED_BINDING: &str = "SELECT resume_receipt_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND new_generation=?4 AND resume_receipt_json IS NOT NULL";

pub fn require_open(conn: &Connection, key: &DocKey) -> Result<(), CollabError> {
    let stopped: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![key.workspace_id, key.version_id, key.object_id], |r| r.get(0),
    ).map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))?;
    if stopped {
        Err(CollabError::RestoreFenced)
    } else {
        Ok(())
    }
}

pub(crate) fn latest_generation(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<(i64, bool)>, CollabError> {
    conn.query_row(
        CURRENT_GENERATION,
        params![key.workspace_id, key.version_id, key.object_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))
}

/// Fresh sessions capture this value; queued work must retain its original value.
pub fn current_generation(conn: &Connection, key: &DocKey) -> Result<Option<i64>, CollabError> {
    let row = latest_generation(conn, key)?;
    match row {
        None => Ok(None),
        Some((generation, true)) if (1..=SAFE).contains(&generation) => Ok(Some(generation)),
        _ => Err(CollabError::RestoreFenced),
    }
}

pub fn require_generation(
    conn: &Connection,
    key: &DocKey,
    expected: Option<i64>,
) -> Result<(), CollabError> {
    if current_generation(conn, key)? == expected {
        Ok(())
    } else {
        Err(CollabError::RestoreFenced)
    }
}

/// No restore fence is active, and a resumed one names exactly this binding and namespace.
pub(crate) fn require_registration(
    conn: &Connection,
    key: &DocKey,
    namespace: &str,
    binding: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    let Some(generation) = current_generation(conn, key)? else {
        return Ok(());
    };
    if generation != binding.restore_fence_generation {
        return Err(ApplicationError::Conflict);
    };
    let (saved_namespace, json): (String, String) = conn
        .query_row(
            RESUMED_REGISTRATION,
            params![key.workspace_id, key.version_id, key.object_id, generation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(read_sql)?;
    let resumed: NativeRestoreResumeReceipt =
        serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
    if saved_namespace != namespace || resumed.binding != *binding {
        return Err(ApplicationError::Conflict);
    };
    Ok(())
}

impl NativeRestoreFence {
    pub(super) fn validate(&self) -> Result<(), ApplicationError> {
        integer(self.point.journal_cursor, 0, SAFE)?;
        digest(&self.point.receipt_digest)?;
        identifier(&self.operation_id, 512)?;
        identifier(&self.relay_database_namespace, 512)?;
        identifier(&self.host_id, 1024)?;
        self.old_binding.validate_canonical().map_err(invalid)?;
        integer(self.old_binding.restore_fence_generation, 0, SAFE - 1)?;
        if self.new_fence != self.old_binding.restore_fence_generation + 1 {
            return Err(ApplicationError::Conflict);
        }
        integer(self.applied_sequence, 0, SAFE)?;
        let id = match &self.origin {
            RestoreDeliveryOrigin::Bootstrap { id } | RestoreDeliveryOrigin::Owner { id } => id,
        };
        identifier(id, 512)?;
        if let Some(terminal) = &self.terminal {
            terminal.validate()?;
        }
        Ok(())
    }
}

pub(super) fn marker(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<durable::Marker, ApplicationError> {
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )?;
    let marker = durable::read_marker_in(conn, &key)?.ok_or(ApplicationError::Conflict)?;
    if marker.regime != Regime::Replicated
        || marker.content_kind != crate::ContentKind::Richdoc
        || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
        || marker.path.as_deref() != Some(&binding.current_path)
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(marker)
}

pub(super) fn applied_tip(
    conn: &Connection,
    held: &Registration,
    input: &NativeRestoreFence,
) -> Result<(Option<LiveUpdateReceipt>, i64), ApplicationError> {
    let b = &held.binding;
    let origin = match &input.origin {
        RestoreDeliveryOrigin::Bootstrap { id } => {
            if adoption::read_origin(conn, held)?.is_some() {
                return Err(ApplicationError::Conflict);
            }
            let (bootstrap, binding, coordinate, sequence) =
                bootstrap::read_bootstrap(conn, held)?.ok_or(ApplicationError::Conflict)?;
            bootstrap.validate()?;
            restore_resume::validate_origin_binding(conn, held, &binding)?;
            if bootstrap.bootstrap_id != *id || coordinate.host_id != input.host_id {
                return Err(ApplicationError::Conflict);
            }
            (None, sequence)
        }
        RestoreDeliveryOrigin::Owner { id } => {
            let origin = adoption::read_origin(conn, held)?.ok_or(ApplicationError::Conflict)?;
            let (saved_id, host): (String, String) = conn.query_row(
                "SELECT adoption_id,host_coordinate_json FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
                params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
                |r| Ok((r.get(0)?,r.get(1)?)),
            ).map_err(read_sql)?;
            let host: ApplicationHostCoordinate =
                serde_json::from_str(&host).map_err(|_| ApplicationError::Corrupt)?;
            host.validate()?;
            if saved_id != *id || host.host_id != input.host_id {
                return Err(ApplicationError::Conflict);
            }
            (origin.terminal, origin.sequence)
        }
    };
    let origin = if let Some(resumed) = restore_resume::generation(conn, held)? {
        (
            Some(resumed.application_receipt),
            resumed.local_head_sequence,
        )
    } else {
        origin
    };
    let latest: Option<LiveUpdateReceipt> = conn.query_row(
        "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND restore_fence_generation=?6 ORDER BY journal_cursor DESC LIMIT 1",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.restore_fence_generation],
        |r| Ok(LiveUpdateReceipt {delivery_id:r.get(0)?,update_digest:r.get(1)?,journal_cursor:r.get(2)?,accepting_host_epoch:r.get(3)?}),
    ).optional().map_err(read_sql)?;
    let Some(terminal) =
        latest.filter(|r| r.journal_cursor > origin.0.as_ref().map_or(0, |r| r.journal_cursor))
    else {
        return Ok(origin);
    };
    let record =
        read_application(conn, &held.namespace, &terminal)?.ok_or(ApplicationError::Corrupt)?;
    settlement::validate_historical_binding(&record.event.metadata.accepted.binding, b)?;
    if record.event.metadata.accepted.receipt != terminal
        || record.coordinate.host_id != input.host_id
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok((Some(terminal), record.sequence))
}

impl ApplicationOwner {
    /// Replays need no ordinary registration, which stays refused after restart.
    pub fn fence_restore(
        &mut self,
        store: &mut EngineStore,
        resolver: Option<&Arc<crate::reader_resolver::ReaderResolver>>,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
        self.fence_restore_inner(store, resolver, input, coordinate, now_ms, faults, false)
    }

    /// The authenticated host adapter holds its current connection output guard.
    /// Resume a saved old cut without registering or adopting the document again.
    pub fn fence_restore_after_reconnect(
        &mut self,
        store: &mut EngineStore,
        resolver: Option<&Arc<crate::reader_resolver::ReaderResolver>>,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: &dyn FaultInjector,
    ) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
        self.fence_restore_inner(store, resolver, input, coordinate, now_ms, faults, true)
    }

    #[allow(clippy::too_many_arguments)]
    fn fence_restore_inner(
        &mut self,
        store: &mut EngineStore,
        resolver: Option<&Arc<crate::reader_resolver::ReaderResolver>>,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: &dyn FaultInjector,
        after_reconnect: bool,
    ) -> Result<NativeRestoreFenceReceipt, ApplicationError> {
        input.validate()?;
        coordinate.validate()?;
        integer(now_ms, 0, SAFE)?;
        if input.host_id != coordinate.host_id {
            return Err(ApplicationError::Conflict);
        }
        validate_application_binding(store, &self.workspace_id, &input.old_binding)?;
        let b = &input.old_binding;
        let held = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace: input.relay_database_namespace.clone(),
            coordinate,
            binding: b.clone(),
            live: true,
        };
        let selected = store.read_with(|conn| {
            if !accepted_history::may_have_reader(conn, &held)? {
                return Ok(None);
            }
            let read = conn.unchecked_transaction().map_err(read_sql)?;
            accepted_history::read_selected_point(
                &read,
                &held,
                &input.point,
                &mut restore_content::Budget {
                    remaining: SELECTED_POINT_REPLAY_BYTES,
                },
                accepted_history::CHECKPOINT_EVENTS as usize,
            )
            .map(|history| Some(history.doc))
        });
        // Saved fences replay independently of history; preserve transaction error precedence.
        let (selected, mut selection_error) = match selected {
            Ok(doc) => (doc, None),
            Err(error) => (None, Some(error)),
        };
        let input_json = serde_json::to_string(&input).map_err(|_| ApplicationError::Corrupt)?;
        // Canonical identifiers and at most 100 selector paths bound the JSON,
        // including six-byte JSON escaping, below this stored-input limit.
        if input_json.len() > 1_048_576 {
            return Err(ApplicationError::ConfiguredByteBudgetExceeded);
        }
        let outcome = store.write_with(faults, |tx| {
            require_workspace(tx, &held)?;
            let saved: Option<(String, String)> = tx.query_row(
                "SELECT input_json,receipt_json FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?5 AND resume_receipt_json IS NULL",
                params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,input.operation_id],
                |r| Ok((r.get(0)?,r.get(1)?)),
            ).optional().map_err(read_sql)?;
            if let Some((saved_input, receipt)) = saved {
                if saved_input != input_json { return Err(ApplicationError::Conflict); }
                let receipt: NativeRestoreFenceReceipt = serde_json::from_str(&receipt).map_err(|_| ApplicationError::Corrupt)?;
                if receipt.operation != input || receipt.local_head_sequence < input.applied_sequence {
                    return Err(ApplicationError::Corrupt);
                }
                integer(receipt.local_head_sequence, 0, SAFE)?;
                integer(receipt.recorded_at_ms, 0, SAFE)?;
                let mut stopped = b.clone();
                stopped.restore_fence_generation = input.new_fence;
                if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| {
                    binding == stopped && coordinate.host_id == input.host_id && !available
                }) || marker(tx, b)?.head_update_seq != restore_content::application::fence_replay_head(tx,&held,&receipt)? {
                    return Err(ApplicationError::Corrupt);
                }
                return Ok(Ok(receipt));
            }
            let saved: Option<(String, String, i64)> = tx.query_row(
                "SELECT input_json,reason,recorded_at_ms FROM live_restore_refusals WHERE relay_database_namespace=?1 AND operation_id=?2",
                params![held.namespace,input.operation_id],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
            ).optional().map_err(read_sql)?;
            if let Some((saved_input, reason, recorded_at_ms)) = saved {
                if saved_input != input_json { return Err(ApplicationError::Conflict); }
                let reason = match reason.as_str() {
                    "binding-changed" => NativeRestoreRefusalReason::BindingChanged,
                    "reader-unavailable" => NativeRestoreRefusalReason::ReaderUnavailable,
                    "source-unavailable" => NativeRestoreRefusalReason::SourceUnavailable,
                    "source-too-large" => NativeRestoreRefusalReason::SourceTooLarge,
                    "incomplete-witness" => NativeRestoreRefusalReason::IncompleteWitness,
                    _ => return Err(ApplicationError::Corrupt),
                };
                integer(recorded_at_ms, 0, SAFE)?;
                return Ok(Err(Box::new(NativeRestoreRefusal { operation: input.clone(), reason, recorded_at_ms })));
            }
            let collision: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2)",
                params![held.namespace,input.operation_id], |r| r.get(0),
            ).map_err(read_sql)?;
            if collision { return Err(ApplicationError::Conflict); }
            let refused = |reason| {
                let refusal = Box::new(NativeRestoreRefusal {
                    operation: input.clone(), reason, recorded_at_ms: now_ms,
                });
                let reason = serde_json::to_value(&refusal.reason).map_err(|_| ApplicationError::Corrupt)?;
                tx.execute(
                    "INSERT INTO live_restore_refusals(relay_database_namespace,operation_id,workspace_id,input_json,reason,recorded_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![held.namespace,input.operation_id,b.workspace_id,input_json,reason.as_str().ok_or(ApplicationError::Corrupt)?,now_ms],
                ).map_err(write_sql)?;
                Ok(Err(refusal))
            };
            let key = DocKey::new(&b.workspace_id,&b.main_version_id,&b.object_id)?;
            require_hosted_ready(tx, &key)?;
            require_registration(tx,&key,&held.namespace,b)?;
            let previous=restore_resume::generation(tx,&held)?.map(|receipt|receipt.operation_id);
            if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| {
                binding == *b && available && (coordinate == held.coordinate
                    || (after_reconnect && coordinate.host_id == held.coordinate.host_id))
            }) {
                return refused(NativeRestoreRefusalReason::BindingChanged);
            }
            // A settlement moment's before-image is publishable only while its
            // generation is current. Refuse until the relay acknowledged this
            // document's journaled settlement moments.
            let unpublished: bool = tx.query_row(
                UNPUBLISHED_SETTLEMENT_MOMENTS,
                params![b.workspace_id,held.namespace,b.main_version_id,b.object_id,b.lineage_claim_id],
                |r| r.get(0),
            ).map_err(read_sql)?;
            if unpublished { return Err(ApplicationError::PublicationPending); }
            let marker = marker(tx, b)?;
            let (terminal, sequence) = applied_tip(tx, &held, &input)?;
            if terminal != input.terminal || sequence != input.applied_sequence || marker.head_update_seq < sequence {
                return Err(ApplicationError::Conflict);
            }
            let current = durable::load_doc_in(tx, &key)?;
            if let Some(error) = selection_error.take() {
                return Err(error);
            }
            accepted_history::require_selected_terminal(tx, &held, &input.point)?;
            // A new reader-bearing append after the preflight needs a fresh attempt.
            if selected.is_none() && accepted_history::may_have_reader(tx, &held)? {
                return Err(ApplicationError::Interrupted);
            }
            let needed = if selected.as_ref().is_some_and(|doc| doc.has_reader_source()) { selected.as_ref() }
                else if current.has_reader_source() { Some(&current) } else { None };
            if let Some(doc) = needed {
                let Some(reference) = doc.markdown_source_reference() else {
                    return refused(NativeRestoreRefusalReason::IncompleteWitness);
                };
                if doc.markdown_source(&reference).is_none() {
                    return refused(NativeRestoreRefusalReason::IncompleteWitness);
                }
                if resolver.is_none() {
                    return refused(NativeRestoreRefusalReason::ReaderUnavailable);
                }
                let Some((_, length)) = crate::reader_snapshot::history_artifact_header(tx, &key, &b.current_path, &reference.source_sha256)? else {
                    return refused(NativeRestoreRefusalReason::SourceUnavailable);
                };
                if usize::try_from(length).ok().filter(|n| *n <= crate::limits::MAX_PUBLIC_MARKDOWN_BYTES).is_none() {
                    return refused(NativeRestoreRefusalReason::SourceTooLarge);
                }
            }
            let receipt = NativeRestoreFenceReceipt {
                operation: input.clone(),
                local_head_sequence: marker.head_update_seq,
                recorded_at_ms: now_ms,
            };
            tx.execute(
                "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json,previous_operation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,input.operation_id,input_json,serde_json::to_string(&receipt).map_err(|_| ApplicationError::Corrupt)?,previous],
            ).map_err(write_sql)?;
            let changed = tx.execute(
                "UPDATE live_device_application_bindings SET available=0,restore_fence_generation=?5 WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4",
                params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,input.new_fence],
            ).map_err(write_sql)?;
            if changed != 1 { return Err(ApplicationError::Corrupt); }
            let mut observed = b.clone();
            observed.restore_fence_generation = input.new_fence;
            let outboxes = {
                let mut stmt = tx.prepare(
                    "SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5 AND state!='quarantined'",
                ).map_err(read_sql)?;
                let rows = stmt.query_map(
                    params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.restore_fence_generation],
                    |row| row.get::<_, String>(0),
                ).map_err(read_sql)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
            };
            for outbox_id in outboxes {
                crate::owner_outbox::quarantine_in_tx(
                    tx,
                    &b.workspace_id,
                    &crate::owner_outbox::OwnerOutboxQuarantineInput {
                        outbox_id,
                        reason: "restore-fenced".into(),
                        observed_binding: Some(observed.clone()),
                    },
                    now_ms,
                ).map_err(|error| match error {
                    crate::OwnerOutboxError::Storage(error) => ApplicationError::Storage(error),
                    _ => ApplicationError::Corrupt,
                })?;
            }
            Ok(Ok(receipt))
        })?;
        let receipt = match outcome {
            TxnOutcome::Committed(Ok(receipt)) => receipt,
            TxnOutcome::Committed(Err(refusal)) => {
                return Err(ApplicationError::RestoreRefused(refusal))
            }
            TxnOutcome::Crashed { .. } => return Err(ApplicationError::Interrupted),
        };
        for current in &self.current {
            let mut current = current.lock().map_err(|_| ApplicationError::Interrupted)?;
            if current.binding.main_version_id == b.main_version_id
                && current.binding.object_id == b.object_id
            {
                current.live = false;
            }
        }
        Ok(receipt)
    }
}

/// Used only after a local mutation has checked its captured generation.
pub(crate) fn resumed_binding(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<LiveObjectBinding>, CollabError> {
    let Some(generation) = current_generation(conn, key)? else {
        return Ok(None);
    };
    let json: String = conn
        .query_row(
            RESUMED_BINDING,
            params![key.workspace_id, key.version_id, key.object_id, generation],
            |r| r.get(0),
        )
        .map_err(|e| CollabError::Storage(StorageError::corrupt_public(e)))?;
    let receipt: NativeRestoreResumeReceipt =
        serde_json::from_str(&json).map_err(|_| CollabError::RestoreFenced)?;
    let b = receipt.binding;
    if b.workspace_id != key.workspace_id
        || b.main_version_id != key.version_id
        || b.object_id != key.object_id
        || b.restore_fence_generation != generation
    {
        return Err(CollabError::RestoreFenced);
    };
    Ok(Some(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{Arc, Mutex};

    /// The fence columns `sql` reads, and its query plan.
    fn inspect(conn: &Connection, sql: &str) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
        let columns = Arc::new(Mutex::new(Vec::new()));
        let seen = columns.clone();
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if let AuthAction::Read {
                table_name: "live_restore_fences",
                column_name,
            } = context.action
            {
                seen.lock().unwrap().push(column_name.to_owned());
            }
            Authorization::Allow
        }))?;
        conn.prepare(sql)?;
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        let mut plan = Vec::new();
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let mut rows = statement.raw_query();
        while let Some(row) = rows.next()? {
            plan.push(row.get(3)?);
        }
        let columns = columns.lock().unwrap().clone();
        Ok((columns, plan))
    }

    /// Each edit and live application on a restored document reads its fence.
    /// None of those reads may reach the restore proof stored in the fence row.
    #[test]
    fn restored_document_reads_never_walk_the_restore_proof() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("restore-proof-reads").unwrap();
        let store = EngineStore::open(&scratch.join("engine.db"), 0).unwrap();
        store
            .read_with(|conn| {
                let indexed: Vec<String> = conn
                    .prepare("SELECT name FROM pragma_index_info('live_restore_resumed')")?
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<_, _>>()?;
                for sql in [CURRENT_GENERATION, RESUMED_REGISTRATION, RESUMED_BINDING] {
                    let (columns, plan) = inspect(conn, sql)?;
                    assert!(
                        columns.iter().all(|column| indexed.contains(column)),
                        "{sql} reads {columns:?}"
                    );
                    assert!(
                        plan.iter().all(|detail| detail.starts_with(
                            "SEARCH live_restore_fences USING INDEX live_restore_resumed ("
                        )),
                        "{sql}: {plan:?}"
                    );
                }
                // The checkpoint bind reads stored columns before the proof,
                // and generated columns, which derive from input_json.
                let (stored, generated): (Vec<String>, Vec<String>) = {
                    let mut statement = conn.prepare(
                        "SELECT name,hidden FROM pragma_table_xinfo('live_restore_fences') ORDER BY cid",
                    )?;
                    let rows: Vec<(String, i64)> = statement
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<Result<_, _>>()?;
                    let proof = rows.iter().position(|(name, _)| name == "proposal_json").unwrap();
                    (
                        rows[..proof].iter().filter(|(_, hidden)| *hidden == 0).map(|(name, _)| name.clone()).collect(),
                        rows.iter().filter(|(_, hidden)| *hidden == 2).map(|(name, _)| name.clone()).collect(),
                    )
                };
                let (columns, plan) = inspect(conn, accepted_history::NATIVE_APPEND_FENCE)?;
                assert!(
                    columns.iter().all(|column| column == "application_delivery_id"
                        || stored.contains(column)
                        || generated.contains(column)),
                    "the checkpoint bind reads {columns:?}"
                );
                assert_eq!(
                    plan,
                    ["SEARCH live_restore_fences USING INDEX live_restore_application_delivery (relay_database_namespace=? AND application_delivery_id=?)"]
                );
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
    }
}
