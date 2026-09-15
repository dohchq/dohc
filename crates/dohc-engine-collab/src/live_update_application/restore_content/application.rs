use super::*;

/// The authenticated operation adapter supplies admission facts, never replacement bytes.
#[derive(Clone)]
pub struct NativeRestoreApplication {
    pub preparation: NativeRestorePreparation,
    pub candidate_digest: String,
    pub native_source_manifest_digest: String,
    pub admitted: AdmittedLiveUpdateMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreApplicationReceipt {
    pub fence: NativeRestoreFenceReceipt,
    pub candidate_digest: String,
    pub native_source_manifest_digest: String,
    pub admitted: AdmittedLiveUpdateMetadata,
    pub local_head_sequence: i64,
    pub host_coordinate: ApplicationHostCoordinate,
    pub recorded_at_ms: i64,
}

impl NativeRestoreApplication {
    pub fn validate_budget(
        &self,
        max_bytes: usize,
        max_events: usize,
    ) -> Result<(), ApplicationError> {
        let mut budget = Budget {
            remaining: max_bytes,
        };
        budget.json(&self.admitted)?;
        self.preparation
            .validate_budget(budget.remaining, max_events)?;
        digest(&self.candidate_digest)?;
        digest(&self.native_source_manifest_digest)?;
        let a = &self.admitted.accepted;
        a.receipt.validate()?;
        a.binding.validate_canonical().map_err(invalid)?;
        a.authority.validate()?;
        integer(a.received_at_ms, 0, SAFE)?;
        canonical_ranges(&self.admitted.first_seen)?;
        let operation = &self.preparation.fence.operation;
        let mut new_binding = operation.old_binding.clone();
        new_binding.restore_fence_generation = operation.new_fence;
        if a.binding != new_binding
            || !matches!(a.authority, ServerDerivedLiveUpdateAuthority::Owner { .. })
            || a.receipt.update_digest != self.candidate_digest
            || a.receipt.journal_cursor
                <= operation.terminal.as_ref().map_or(0, |r| r.journal_cursor)
        {
            return Err(ApplicationError::Conflict);
        }
        Ok(())
    }
}

pub(in crate::live_update_application) fn read_saved(
    conn: &Connection,
    held: &Registration,
    operation_id: &str,
    budget: &mut Budget,
) -> Result<Option<NativeRestoreApplicationReceipt>, ApplicationError> {
    let b = &held.binding;
    let length:Option<i64>=conn.query_row("SELECT length(CAST(application_json AS BLOB)) FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?5",params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,operation_id],|row|row.get(0)).map_err(read_sql)?;
    let Some(length) = length else {
        return Ok(None);
    };
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    let (json,delivery):(String,String)=conn.query_row("SELECT application_json,application_delivery_id FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?5",params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,operation_id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(read_sql)?;
    let receipt: NativeRestoreApplicationReceipt =
        serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
    if receipt.admitted.accepted.receipt.delivery_id != delivery {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(receipt))
}

pub(super) fn verify_saved(
    conn: &Connection,
    held: &Registration,
    receipt: &NativeRestoreApplicationReceipt,
    proposal: &NativeRestoreProposal,
    current: &Ydoc,
) -> Result<(), ApplicationError> {
    let saved = &proposal.receipt;
    let op = &saved.fence.operation;
    let mut new_binding = op.old_binding.clone();
    new_binding.restore_fence_generation = op.new_fence;
    if receipt.fence != saved.fence
        || receipt.candidate_digest != saved.candidate_digest
        || receipt.native_source_manifest_digest != saved.native_source_manifest_digest
        || receipt.admitted.accepted.binding != new_binding
        || !matches!(
            receipt.admitted.accepted.authority,
            ServerDerivedLiveUpdateAuthority::Owner { .. }
        )
        || receipt.admitted.accepted.receipt.update_digest != saved.candidate_digest
        || receipt.admitted.accepted.receipt.journal_cursor
            <= op.terminal.as_ref().map_or(0, |r| r.journal_cursor)
        || receipt.admitted.first_seen != saved.replacement_ranges
        || receipt.local_head_sequence
            != saved
                .fence
                .local_head_sequence
                .checked_add(1)
                .ok_or(ApplicationError::Corrupt)?
        || receipt.host_coordinate.host_id != op.host_id
    {
        return Err(ApplicationError::Corrupt);
    }
    receipt.host_coordinate.validate()?;
    integer(receipt.recorded_at_ms, 0, SAFE)?;
    let record = read_restore_application(
        conn,
        &held.namespace,
        &receipt.admitted,
        proposal.candidate_bytes.len(),
    )?
    .ok_or(ApplicationError::Corrupt)?;
    if record.event.metadata != receipt.admitted
        || record.event.update_bytes != proposal.candidate_bytes
        || record.sequence != receipt.local_head_sequence
        || record.coordinate != receipt.host_coordinate
    {
        return Err(ApplicationError::Corrupt);
    }
    let expected = Ydoc::wire();
    expected.apply(&proposal.frozen_state_bytes)?;
    crate::validate_replay_parity(&expected, &proposal.candidate_bytes)?;
    expected.apply(&proposal.candidate_bytes)?;
    if !crate::replay_parity::structurally_equal_v2(&expected, current)? {
        return Err(ApplicationError::Corrupt);
    }
    Ok(())
}

pub(in crate::live_update_application) fn fence_replay_head(
    conn: &Connection,
    held: &Registration,
    fence: &NativeRestoreFenceReceipt,
) -> Result<i64, ApplicationError> {
    let mut budget = Budget {
        remaining: crate::limits::MAX_YDOC_UPDATE_BYTES,
    };
    let Some(receipt) = read_saved(conn, held, &fence.operation.operation_id, &mut budget)? else {
        return Ok(fence.local_head_sequence);
    };
    let b = &held.binding;
    digest(&receipt.candidate_digest)?;
    digest(&receipt.native_source_manifest_digest)?;
    let bound:bool=conn.query_row("SELECT proposal_candidate_sha256=?5 AND json_extract(proposal_json,'$.nativeSourceManifestDigest')=?6 AND json_extract(proposal_json,'$.replacementRanges')=?7 FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?8",params![b.workspace_id,b.main_version_id,b.object_id,held.namespace,receipt.candidate_digest,receipt.native_source_manifest_digest,serde_json::to_string(&receipt.admitted.first_seen).map_err(|_|ApplicationError::Corrupt)?,fence.operation.operation_id],|row|row.get(0)).map_err(read_sql)?;
    let mut new_binding = b.clone();
    new_binding.restore_fence_generation = fence.operation.new_fence;
    receipt.admitted.accepted.receipt.validate()?;
    receipt.admitted.accepted.authority.validate()?;
    receipt.host_coordinate.validate()?;
    integer(receipt.recorded_at_ms, 0, SAFE)?;
    integer(receipt.admitted.accepted.received_at_ms, 0, SAFE)?;
    canonical_ranges(&receipt.admitted.first_seen)?;
    if receipt.fence != *fence
        || !bound
        || receipt.admitted.accepted.binding != new_binding
        || receipt.admitted.accepted.receipt.update_digest != receipt.candidate_digest
        || !matches!(
            receipt.admitted.accepted.authority,
            ServerDerivedLiveUpdateAuthority::Owner { .. }
        )
        || receipt.admitted.accepted.receipt.journal_cursor
            <= fence
                .operation
                .terminal
                .as_ref()
                .map_or(0, |r| r.journal_cursor)
        || receipt.local_head_sequence
            != fence
                .local_head_sequence
                .checked_add(1)
                .ok_or(ApplicationError::Corrupt)?
        || receipt.host_coordinate.host_id != fence.operation.host_id
    {
        return Err(ApplicationError::Corrupt);
    }
    let candidate_length = budget.blob_length(conn, &receipt.candidate_digest)?;
    let record =
        read_restore_application(conn, &held.namespace, &receipt.admitted, candidate_length)?
            .ok_or(ApplicationError::Corrupt)?;
    if record.event.metadata != receipt.admitted
        || record.sequence != receipt.local_head_sequence
        || record.coordinate != receipt.host_coordinate
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok(receipt.local_head_sequence)
}

fn read_restore_application(
    conn: &Connection,
    namespace: &str,
    expected: &AdmittedLiveUpdateMetadata,
    candidate_length: usize,
) -> Result<Option<ApplicationRecord>, ApplicationError> {
    let receipt = &expected.accepted.receipt;
    let mut query = conn.prepare("SELECT selector_paths_json=?4 AND update_digest=?5 AND update_byte_length=?6 AND first_seen_count=?7 AND (SELECT count(*) FROM live_device_application_first_seen f WHERE f.relay_database_namespace=a.relay_database_namespace AND f.delivery_id=a.delivery_id)=?7 FROM live_device_update_applications a WHERE a.relay_database_namespace=?1 AND (a.delivery_id=?2 OR a.journal_cursor=?3)").map_err(read_sql)?;
    let mut rows = query
        .query(params![
            namespace,
            receipt.delivery_id,
            receipt.journal_cursor,
            serde_json::to_string(&expected.accepted.binding.selector_paths)
                .map_err(|_| ApplicationError::Corrupt)?,
            receipt.update_digest,
            i64::try_from(candidate_length).map_err(|_| ApplicationError::Corrupt)?,
            i64::try_from(expected.first_seen.len()).map_err(|_| ApplicationError::Corrupt)?
        ])
        .map_err(read_sql)?;
    let Some(row) = rows.next().map_err(read_sql)? else {
        return Ok(None);
    };
    if !row.get::<_, bool>(0).map_err(read_sql)? || rows.next().map_err(read_sql)?.is_some() {
        return Err(ApplicationError::Corrupt);
    }
    read_application(conn, namespace, receipt)
}

impl ApplicationOwner {
    #[allow(clippy::too_many_arguments)]
    pub fn apply_restore(
        &mut self,
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        input: NativeRestoreApplication,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        now_ms: i64,
        faults: &dyn FaultInjector,
        follow_up: impl FnOnce(
            &Transaction<'_>,
            &str,
            &LiveObjectBinding,
            i64,
        ) -> Result<(), ApplicationError>,
    ) -> Result<NativeRestoreApplicationReceipt, ApplicationError> {
        self.apply_restore_with_facts(
            store, cache, input, coordinate, max_bytes, max_events, now_ms, faults, follow_up,
        )
        .map(|(receipt, _)| receipt)
    }

    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn apply_restore_with_facts(
        &mut self,
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
        input: NativeRestoreApplication,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        now_ms: i64,
        faults: &dyn FaultInjector,
        follow_up: impl FnOnce(
            &Transaction<'_>,
            &str,
            &LiveObjectBinding,
            i64,
        ) -> Result<(), ApplicationError>,
    ) -> Result<
        (
            NativeRestoreApplicationReceipt,
            Option<dohc_engine_domain::CollectionRecordApplyFacts>,
        ),
        ApplicationError,
    > {
        input.validate_budget(max_bytes, max_events)?;
        coordinate.validate()?;
        integer(now_ms, 0, SAFE)?;
        let operation = &input.preparation.fence.operation;
        if operation.host_id != coordinate.host_id {
            return Err(ApplicationError::Conflict);
        }
        validate_application_binding(store, &self.workspace_id, &operation.old_binding)?;
        let held = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace: operation.relay_database_namespace.clone(),
            coordinate,
            binding: operation.old_binding.clone(),
            live: false,
        };
        let b = &held.binding;
        let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
        let outcome = store.write_with(faults, |tx| {
            let mut budget = Budget { remaining: max_bytes };
            budget.json(&input.admitted)?;
            let prepared: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_restore_fences WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND proposal_candidate_sha256=?5 AND operation_id=?6 AND resume_receipt_json IS NULL)",
                params![b.workspace_id, b.main_version_id, b.object_id, held.namespace, input.candidate_digest,operation.operation_id],
                |row| row.get(0),
            ).map_err(read_sql)?;
            if !prepared {
                return Err(ApplicationError::Conflict);
            }
            let saved = read_saved(tx, &held, &operation.operation_id, &mut budget)?;
            let proposal = prepare_in(tx, &held, &input.preparation, budget.remaining, max_events)?;
            if proposal.receipt.candidate_digest != input.candidate_digest
                || proposal.receipt.native_source_manifest_digest != input.native_source_manifest_digest
                || proposal.receipt.replacement_ranges != input.admitted.first_seen
            {
                return Err(ApplicationError::Conflict);
            }
            if let Some(saved) = saved {
                if saved.admitted != input.admitted {
                    return Err(ApplicationError::Conflict);
                }
                return Ok((saved,None));
            }
            let event = AdmittedLiveUpdate {
                metadata: input.admitted.clone(),
                update_bytes: proposal.candidate_bytes.clone(),
            };
            event.validate()?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE relay_database_namespace=?1 AND (delivery_id=?2 OR journal_cursor=?3))",
                params![held.namespace, event.metadata.accepted.receipt.delivery_id, event.metadata.accepted.receipt.journal_cursor],
                |row| row.get(0),
            ).map_err(read_sql)?;
            if exists {
                return Err(ApplicationError::Conflict);
            }
            check_provenance(tx, &held.namespace, &event)?;
            let frozen = Ydoc::wire();
            frozen.apply(&proposal.frozen_state_bytes)?;
            let (projected, sequence, record_facts) = durable::append_and_index_update(
                tx, &key, ContentKind::Richdoc, &frozen, &event.update_bytes,
                &input.candidate_digest, true, None, None, None, now_ms,
            )?;
            let application_held = Registration {
                workspace_id: held.workspace_id.clone(),
                namespace: held.namespace.clone(),
                coordinate: held.coordinate.clone(),
                binding: event.metadata.accepted.binding.clone(),
                live: false,
            };
            insert_application(tx, &application_held, &event, sequence)?;
            let receipt = NativeRestoreApplicationReceipt {
                fence: input.preparation.fence.clone(),
                candidate_digest: input.candidate_digest.clone(),
                native_source_manifest_digest: input.native_source_manifest_digest.clone(),
                admitted: input.admitted.clone(),
                local_head_sequence: sequence,
                host_coordinate: held.coordinate.clone(),
                recorded_at_ms: now_ms,
            };
            verify_saved(tx, &held, &receipt, &proposal, &projected)?;
            let json = String::from_utf8(budget.json(&receipt)?).map_err(|_| ApplicationError::Corrupt)?;
            let changed = tx.execute(
                "UPDATE live_restore_fences SET application_json=?5,application_delivery_id=?6 WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND relay_database_namespace=?4 AND operation_id=?7 AND application_json IS NULL AND resume_receipt_json IS NULL",
                params![b.workspace_id, b.main_version_id, b.object_id, held.namespace, json, receipt.admitted.accepted.receipt.delivery_id,operation.operation_id],
            ).map_err(write_sql)?;
            if changed != 1 {
                return Err(ApplicationError::Conflict);
            }
            accepted_history::append_restore(tx, &application_held, &event, &projected, &operation.operation_id, &mut budget)?;
            let count:Option<i64>=tx.query_row("SELECT event_count FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",params![held.namespace,event.metadata.accepted.receipt.delivery_id],|r|r.get(0)).optional().map_err(read_sql)?;
            if let Some(count)=count {
                follow_up(tx,&held.namespace,&application_held.binding,count)?;
            }
            Ok((receipt,record_facts))
        });
        cache.remove(&key);
        match outcome? {
            TxnOutcome::Committed(receipt) => Ok(receipt),
            TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
        }
    }
}
