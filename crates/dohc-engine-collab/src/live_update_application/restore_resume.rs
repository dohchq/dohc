use super::*;
use restore_content::Budget;

#[derive(Clone)]
pub struct NativeRestoreResume {
    pub application: NativeRestoreApplication,
    pub settlement_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestoreResumeReceipt {
    pub relay_database_namespace: String,
    pub operation_id: String,
    pub binding: LiveObjectBinding,
    pub application_receipt: LiveUpdateReceipt,
    pub settlement_id: String,
    pub moment_id: String,
    pub markdown_digest: String,
    pub local_head_sequence: i64,
    pub recorded_at_ms: i64,
}

impl NativeRestoreResume {
    pub fn validate_budget(
        &self,
        max_bytes: usize,
        max_events: usize,
    ) -> Result<(), ApplicationError> {
        identifier(&self.settlement_id, 512)?;
        self.application.validate_budget(max_bytes, max_events)
    }
}

fn evidence(
    conn: &Connection,
    held: &Registration,
    operation: &str,
    settlement: &str,
    budget: &mut Budget,
) -> Result<String, ApplicationError> {
    let json = budget.sql_json_array(
        conn,
        &["f.input_json", "f.receipt_json", "f.proposal_json", "f.application_json", "f.previous_operation_id", "p.resume_receipt_json", "p.resume_evidence_digest", "s.settlement_id", "s.previous_cursor", "s.terminal_cursor", "s.previous_ydoc_sequence", "s.local_ydoc_sequence", "s.application_count", "s.interval_digest", "s.moment_id", "s.markdown_digest", "s.source_state_vector_digest", "s.binding_json", "s.host_coordinate_json", "s.recorded_at_ms", "s.settlement_kind", "s.restore_operation_id"],
        "FROM live_restore_fences f JOIN live_device_settlements s ON s.relay_database_namespace=f.relay_database_namespace AND s.restore_operation_id=f.operation_id LEFT JOIN live_restore_fences p ON p.relay_database_namespace=f.relay_database_namespace AND p.operation_id=f.previous_operation_id WHERE f.relay_database_namespace=?1 AND f.operation_id=?2 AND s.settlement_id=?3",
        params![held.namespace,operation,settlement],
    )?;
    use sha2::Digest;
    struct Hasher(sha2::Sha256);
    impl std::io::Write for Hasher {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut hasher = Hasher(sha2::Sha256::new());
    serde_json::to_writer(
        &mut hasher,
        &(json, accepted_history::origin_stamp(conn, held)?),
    )
    .map_err(|_| ApplicationError::Corrupt)?;
    Ok(hasher
        .0
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(super) fn saved(
    conn: &Connection,
    held: &Registration,
    operation: &str,
    max_bytes: usize,
) -> Result<Option<NativeRestoreResumeReceipt>, ApplicationError> {
    let length:Option<i64>=conn.query_row("SELECT length(CAST(resume_receipt_json AS BLOB)) FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5",params![held.namespace,operation,held.workspace_id,held.binding.main_version_id,held.binding.object_id],|r|r.get(0)).optional().map_err(read_sql)?.flatten();
    let Some(length) = length else {
        return Ok(None);
    };
    let mut budget = Budget {
        remaining: max_bytes,
    };
    budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    let (json,settlement,stamp):(String,String,String)=conn.query_row("SELECT resume_receipt_json,resume_settlement_id,resume_evidence_digest FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",params![held.namespace,operation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(read_sql)?;
    let receipt: NativeRestoreResumeReceipt =
        serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
    receipt
        .binding
        .validate_canonical()
        .map_err(|_| ApplicationError::Corrupt)?;
    receipt.application_receipt.validate()?;
    integer(receipt.recorded_at_ms, 0, SAFE)?;
    let application = restore_content::application::read_saved(conn, held, operation, &mut budget)?
        .ok_or(ApplicationError::Corrupt)?;
    if receipt.relay_database_namespace != held.namespace
        || receipt.operation_id != operation
        || receipt.settlement_id != settlement
        || receipt.binding != application.admitted.accepted.binding
        || receipt.application_receipt != application.admitted.accepted.receipt
        || receipt.local_head_sequence != application.local_head_sequence
        || restore_content::application::fence_replay_head(conn, held, &application.fence)?
            != receipt.local_head_sequence
        || evidence(conn, held, operation, &settlement, &mut budget)? != stamp
    {
        return Err(ApplicationError::Corrupt);
    }
    let at_generation = Registration {
        workspace_id: held.workspace_id.clone(),
        namespace: held.namespace.clone(),
        coordinate: held.coordinate.clone(),
        binding: receipt.binding.clone(),
        live: false,
    };
    let anchor = settlement::restore::read_anchor(
        conn,
        &at_generation,
        receipt.application_receipt.journal_cursor,
        budget.remaining,
    )?
    .ok_or(ApplicationError::Corrupt)?;
    if anchor.id != receipt.settlement_id
        || anchor.moment != receipt.moment_id
        || anchor.markdown != receipt.markdown_digest
        || anchor.sequence != receipt.local_head_sequence
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(receipt))
}

pub(super) fn generation(
    conn: &Connection,
    held: &Registration,
) -> Result<Option<NativeRestoreResumeReceipt>, ApplicationError> {
    let b = &held.binding;
    let id:Option<String>=conn.query_row("SELECT operation_id FROM live_restore_fences WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND new_generation=?6",params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.restore_fence_generation],|r|r.get(0)).optional().map_err(read_sql)?;
    id.map(|id| {
        saved(conn, held, &id, crate::limits::MAX_YDOC_UPDATE_BYTES)?
            .ok_or(ApplicationError::Conflict)
    })
    .transpose()
}

pub(super) fn validate_origin_binding(
    conn: &Connection,
    held: &Registration,
    original: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    if original.restore_fence_generation == held.binding.restore_fence_generation {
        return settlement::validate_historical_binding(original, &held.binding);
    }
    let resumed = generation(conn, held)?.ok_or(ApplicationError::Conflict)?;
    let mut same = original.clone();
    same.restore_fence_generation = held.binding.restore_fence_generation;
    settlement::validate_historical_binding(&same, &held.binding)?;
    if resumed.binding != held.binding {
        return Err(ApplicationError::Conflict);
    };
    Ok(())
}

impl ApplicationOwner {
    #[allow(clippy::too_many_arguments)]
    pub fn resume_restore(
        &mut self,
        store: &mut EngineStore,
        input: NativeRestoreResume,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        now_ms: i64,
        faults: &dyn FaultInjector,
        verify_materialized: impl FnOnce(
            &Connection,
            &LiveObjectBinding,
            &str,
            &str,
        ) -> Result<(), ApplicationError>,
    ) -> Result<NativeRestoreResumeReceipt, ApplicationError> {
        input.validate_budget(max_bytes, max_events)?;
        coordinate.validate()?;
        integer(now_ms, 0, SAFE)?;
        let operation = &input.application.preparation.fence.operation;
        if operation.host_id != coordinate.host_id {
            return Err(ApplicationError::Conflict);
        };
        validate_application_binding(store, &self.workspace_id, &operation.old_binding)?;
        let held = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace: operation.relay_database_namespace.clone(),
            coordinate: coordinate.clone(),
            binding: operation.old_binding.clone(),
            live: false,
        };
        if let Some(receipt) =
            store.read_with(|conn| saved(conn, &held, &operation.operation_id, max_bytes))?
        {
            let mut budget = Budget {
                remaining: max_bytes,
            };
            let application = store
                .read_with(|conn| {
                    restore_content::application::read_saved(
                        conn,
                        &held,
                        &operation.operation_id,
                        &mut budget,
                    )
                })?
                .ok_or(ApplicationError::Corrupt)?;
            let point:bool=store.read_with(|conn|conn.query_row("SELECT json_extract(proposal_json,'$.point')=?3 FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",params![held.namespace,operation.operation_id,serde_json::to_string(&input.application.preparation.point).map_err(|_|ApplicationError::Corrupt)?],|r|r.get(0)).map_err(read_sql))?;
            if !point
                || receipt.settlement_id != input.settlement_id
                || application.fence != input.application.preparation.fence
                || application.admitted != input.application.admitted
                || application.candidate_digest != input.application.candidate_digest
                || application.native_source_manifest_digest
                    != input.application.native_source_manifest_digest
            {
                return Err(ApplicationError::Conflict);
            }
            let history = store.read_with(|conn| {
                accepted_history::read(
                    conn,
                    &held,
                    receipt.application_receipt.journal_cursor,
                    &mut budget,
                    max_events,
                )
            })?;
            if history.proof.checkpoint.restore_operation_id.as_deref()
                != Some(operation.operation_id.as_str())
                || history.proof.terminal.as_ref() != Some(&receipt.application_receipt)
            {
                return Err(ApplicationError::Corrupt);
            };
            return Ok(receipt);
        }
        let result=self.with_restore_settlement(store,input.application.clone(),coordinate,max_bytes,max_events,|store,audit| {
            let outcome=store.write_with(faults,|tx|->Result<_,ApplicationError>{
                let b=audit.binding();
                let (moment,markdown,vector):(String,String,String)=tx.query_row("SELECT moment_id,markdown_digest,source_state_vector_digest FROM live_device_settlements WHERE settlement_id=?1 AND relay_database_namespace=?2 AND restore_operation_id=?3",params![input.settlement_id,held.namespace,operation.operation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(read_sql)?.ok_or(ApplicationError::Conflict)?;
                if audit.record_in_tx(tx,&moment,&markdown,&vector,now_ms)?!=input.settlement_id {return Err(ApplicationError::Conflict)};
                verify_materialized(tx,b,&moment,&markdown)?;
                let receipt=NativeRestoreResumeReceipt{relay_database_namespace:held.namespace.clone(),operation_id:operation.operation_id.clone(),binding:b.clone(),application_receipt:input.application.admitted.accepted.receipt.clone(),settlement_id:input.settlement_id.clone(),moment_id:moment,markdown_digest:markdown,local_head_sequence:audit.sequence,recorded_at_ms:now_ms};
                let mut budget=Budget{remaining:max_bytes};
                let stamp=evidence(tx,&held,&operation.operation_id,&input.settlement_id,&mut budget)?;
                let json=String::from_utf8(budget.json(&receipt)?).map_err(|_|ApplicationError::Corrupt)?;
                if tx.execute("UPDATE live_restore_fences SET resume_receipt_json=?3,resume_settlement_id=?4,resume_evidence_digest=?5 WHERE relay_database_namespace=?1 AND operation_id=?2 AND resume_receipt_json IS NULL",params![held.namespace,operation.operation_id,json,input.settlement_id,stamp]).map_err(write_sql)?!=1 {return Err(ApplicationError::Conflict)};
                Ok(receipt)
            })?;
            match outcome {TxnOutcome::Committed(receipt)=>Ok(receipt),TxnOutcome::Crashed{..}=>Err(ApplicationError::Interrupted)}
        })?;
        for entry in &self.current {
            let mut entry = entry.lock().map_err(|_| ApplicationError::Interrupted)?;
            if entry.binding.main_version_id == result.binding.main_version_id
                && entry.binding.object_id == result.binding.object_id
            {
                entry.live = false;
            }
        }
        Ok(result)
    }
}
