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
    let origin = accepted_history::origin_stamp_in(conn, held, budget)?;
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
    serde_json::to_writer(&mut hasher, &(json, origin)).map_err(|_| ApplicationError::Corrupt)?;
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
    let mut budget = Budget {
        remaining: max_bytes,
    };
    let mut replay = Budget {
        remaining: crate::limits::MAX_YDOC_UPDATE_BYTES,
    };
    let saved = saved_in(conn, held, operation, &mut budget, Some(&mut replay))?;
    Ok(saved.map(|(receipt, ..)| receipt))
}

/// The accepted head the resumed restore settlement replaced: the fenced
/// generation's last settlement, else its adoption, else its bootstrap, chosen
/// as `with_restore_settlement` chose it. Every read is charged to `budget`.
/// The restore settlement's self-certifying identity fixes the cursor and
/// sequence it replaced; a prior settlement's own identity fixes its digest,
/// while an origin's digest is the native row `with_restore_settlement` verified.
pub(super) fn replaced_head(
    conn: &Connection,
    held: &Registration,
    operation: &str,
    budget: &mut Budget,
) -> Result<Option<String>, ApplicationError> {
    let Some((receipt, application, settled)) = saved_in(conn, held, operation, budget, None)?
    else {
        return Ok(None);
    };
    if receipt.binding != held.binding {
        return Err(ApplicationError::Conflict);
    }
    let fence = &application.fence.operation;
    let old = Registration {
        workspace_id: held.workspace_id.clone(),
        namespace: fence.relay_database_namespace.clone(),
        coordinate: held.coordinate.clone(),
        binding: fence.old_binding.clone(),
        activation_id: held.activation_id.clone(),
        live: false,
    };
    let terminal = fence.terminal.as_ref().map_or(0, |r| r.journal_cursor);
    let (digest, cursor, sequence) =
        match settlement::restore::read_anchor_in(conn, &old, terminal, budget)? {
            Some(prior) => (prior.markdown, prior.cursor, prior.sequence),
            None => origin_head(conn, &old, &fence.origin, budget)?,
        };
    if (settled.previous_cursor, settled.previous_sequence) != (cursor, sequence) {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(digest))
}

/// The digest, cursor, and sequence of the origin the fence recorded, which
/// `with_restore_settlement` chose for `held`: that adopted activation, even
/// one released since, else that bootstrap at zero.
pub(super) fn origin_head(
    conn: &Connection,
    held: &Registration,
    origin: &RestoreDeliveryOrigin,
    budget: &mut Budget,
) -> Result<(String, i64, i64), ApplicationError> {
    let b = &held.binding;
    let row = "WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5";
    let (columns, source, id) = match origin {
        RestoreDeliveryOrigin::Owner { id } => (
            ["source_digest", "terminal_cursor", "local_ydoc_sequence"],
            format!("FROM live_owner_activations {row} AND activation_id=?6 AND evidence_digest IS NOT NULL"),
            id,
        ),
        RestoreDeliveryOrigin::Bootstrap { id } => (
            ["projected_markdown_digest", "0", "0"],
            format!("FROM live_device_bootstraps {row} AND bootstrap_id=?6"),
            id,
        ),
    };
    let json = budget.sql_json_array(
        conn,
        &columns,
        &source,
        params![
            held.namespace,
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id,
            id
        ],
    )?;
    serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)
}

/// `replay` keeps the fence replay's separate stage budget; `None` charges it to `budget`.
fn saved_in(
    conn: &Connection,
    held: &Registration,
    operation: &str,
    budget: &mut Budget,
    replay: Option<&mut Budget>,
) -> Result<
    Option<(
        NativeRestoreResumeReceipt,
        NativeRestoreApplicationReceipt,
        settlement::restore::PriorAnchor,
    )>,
    ApplicationError,
> {
    let length:Option<i64>=conn.query_row("SELECT length(CAST(resume_receipt_json AS BLOB))+coalesce(length(CAST(resume_settlement_id AS BLOB)),0)+coalesce(length(CAST(resume_evidence_digest AS BLOB)),0) FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5",params![held.namespace,operation,held.workspace_id,held.binding.main_version_id,held.binding.object_id],|r|r.get(0)).optional().map_err(read_sql)?.flatten();
    let Some(length) = length else {
        return Ok(None);
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
    let application = restore_content::application::read_saved(conn, held, operation, budget)?
        .ok_or(ApplicationError::Corrupt)?;
    if receipt.relay_database_namespace != held.namespace
        || receipt.operation_id != operation
        || receipt.settlement_id != settlement
        || receipt.binding != application.admitted.accepted.binding
        || receipt.application_receipt != application.admitted.accepted.receipt
        || receipt.local_head_sequence != application.local_head_sequence
        || restore_content::application::fence_replay_head_in(
            conn,
            held,
            &application.fence,
            replay.unwrap_or(&mut *budget),
        )? != receipt.local_head_sequence
        || evidence(conn, held, operation, &settlement, budget)? != stamp
    {
        return Err(ApplicationError::Corrupt);
    }
    let at_generation = Registration {
        workspace_id: held.workspace_id.clone(),
        namespace: held.namespace.clone(),
        coordinate: held.coordinate.clone(),
        binding: receipt.binding.clone(),
        activation_id: held.activation_id.clone(),
        live: false,
    };
    let anchor = settlement::restore::read_anchor_in(
        conn,
        &at_generation,
        receipt.application_receipt.journal_cursor,
        budget,
    )?
    .ok_or(ApplicationError::Corrupt)?;
    if anchor.id != receipt.settlement_id
        || anchor.moment != receipt.moment_id
        || anchor.markdown != receipt.markdown_digest
        || anchor.sequence != receipt.local_head_sequence
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some((receipt, application, anchor)))
}

/// Native continuation validates the committed resume/checkpoint association.
/// External publication proofs retain saved_in's full evidence and read budget.
fn native_saved(
    conn: &Connection,
    held: &Registration,
    operation: &str,
) -> Result<Option<NativeRestoreResumeReceipt>, ApplicationError> {
    identifier(operation, 512)?;
    let b = &held.binding;
    let length:Option<i64>=conn.query_row(
        "SELECT length(CAST(resume_receipt_json AS BLOB)) FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5 AND lineage_claim_id=?6",
        params![held.namespace,operation,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|r.get(0)).optional().map_err(read_sql)?.flatten();
    let Some(length) = length else {
        return Ok(None);
    };
    if !(1..=NativeHistoryReconstruction::HEADER_BYTES as i64).contains(&length) {
        return Err(ApplicationError::Corrupt);
    };
    let (json,settlement,stamp):(String,String,String)=conn.query_row(
        "SELECT resume_receipt_json,resume_settlement_id,resume_evidence_digest FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND length(CAST(resume_settlement_id AS BLOB))<=512 AND length(CAST(resume_evidence_digest AS BLOB))=64",
        params![held.namespace,operation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(read_sql)?;
    let receipt: NativeRestoreResumeReceipt =
        serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
    digest(&stamp)?;
    identifier(&settlement, 512)?;
    receipt
        .binding
        .validate_canonical()
        .map_err(|_| ApplicationError::Corrupt)?;
    receipt
        .application_receipt
        .validate()
        .map_err(|_| ApplicationError::Corrupt)?;
    identifier(&receipt.moment_id, 512)?;
    digest(&receipt.markdown_digest)?;
    integer(receipt.recorded_at_ms, 0, SAFE).map_err(|_| ApplicationError::Corrupt)?;
    integer(receipt.local_head_sequence, 1, SAFE).map_err(|_| ApplicationError::Corrupt)?;
    if receipt.operation_id != operation
        || receipt.relay_database_namespace != held.namespace
        || receipt.settlement_id != settlement
    {
        return Err(ApplicationError::Corrupt);
    };
    settlement::validate_historical_binding(&receipt.binding, b)?;
    let bound:bool=conn.query_row(
        "SELECT new_generation=?3 AND application_delivery_id=?4 AND json_extract(application_json,'$.admitted.accepted.receipt.deliveryId')=?4 AND json_extract(application_json,'$.admitted.accepted.receipt.updateDigest')=?5 AND json_extract(application_json,'$.admitted.accepted.receipt.journalCursor')=?6 AND json_extract(application_json,'$.admitted.accepted.receipt.acceptingHostEpoch')=?7 AND json_extract(application_json,'$.localHeadSequence')=?8 AND json_extract(proposal_json,'$.point.markdownDigest')=?9 AND EXISTS(SELECT 1 FROM live_device_settlements s WHERE s.relay_database_namespace=?1 AND s.settlement_id=?10 AND s.workspace_id=?11 AND s.main_version_id=?12 AND s.object_id=?13 AND s.lineage_claim_id=?14 AND s.settlement_kind='restore' AND s.restore_operation_id=?2 AND s.terminal_cursor=?6 AND s.binding_json=?15) FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2",
        params![held.namespace,operation,b.restore_fence_generation,receipt.application_receipt.delivery_id,receipt.application_receipt.update_digest,receipt.application_receipt.journal_cursor,receipt.application_receipt.accepting_host_epoch,receipt.local_head_sequence,receipt.markdown_digest,receipt.settlement_id,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,serde_json::to_string(&receipt.binding).map_err(|_|ApplicationError::Corrupt)?],|r|r.get(0)).map_err(read_sql)?;
    if !bound {
        return Err(ApplicationError::Corrupt);
    };
    let anchor = settlement::restore::read_anchor(
        conn,
        held,
        receipt.application_receipt.journal_cursor,
        NativeHistoryReconstruction::HEADER_BYTES,
    )?
    .ok_or(ApplicationError::Corrupt)?;
    if anchor.id != receipt.settlement_id
        || anchor.moment != receipt.moment_id
        || anchor.markdown != receipt.markdown_digest
        || anchor.sequence != receipt.local_head_sequence
        || anchor.cursor != receipt.application_receipt.journal_cursor
    {
        return Err(ApplicationError::Corrupt);
    };
    let at_resume = Registration {
        workspace_id: held.workspace_id.clone(),
        namespace: held.namespace.clone(),
        coordinate: held.coordinate.clone(),
        binding: receipt.binding.clone(),
        activation_id: held.activation_id.clone(),
        live: false,
    };
    accepted_history::validate_resume_checkpoint(
        conn,
        &at_resume,
        operation,
        &receipt.application_receipt,
    )?;
    Ok(Some(receipt))
}

/// How a restore fence that moved the registration's generation ended.
pub(super) enum Settled {
    /// The restore applied and resumed.
    Resumed(Box<NativeRestoreResumeReceipt>),
    /// The restore was cancelled before anything applied it.
    Cancelled(Box<NativeRestoreCancellationReceipt>),
}

impl Settled {
    pub(super) fn operation_id(&self) -> &str {
        match self {
            Self::Resumed(receipt) => &receipt.operation_id,
            Self::Cancelled(receipt) => &receipt.fence.operation.operation_id,
        }
    }

    fn binding(&self) -> &LiveObjectBinding {
        match self {
            Self::Resumed(receipt) => &receipt.binding,
            Self::Cancelled(receipt) => &receipt.binding,
        }
    }
}

/// The resumed restore that produced the registration's generation; None for
/// a generation no restore produced, or one a cancelled restore did.
#[cfg(test)]
pub(super) fn generation(
    conn: &Connection,
    held: &Registration,
) -> Result<Option<NativeRestoreResumeReceipt>, ApplicationError> {
    Ok(match settled(conn, held)? {
        Some(Settled::Resumed(receipt)) => Some(*receipt),
        _ => None,
    })
}

pub(super) fn settled(
    conn: &Connection,
    held: &Registration,
) -> Result<Option<Settled>, ApplicationError> {
    generation_with(conn, held, None)
}

/// The cancellation that ended the restore fenced into the registration's
/// exact generation and binding, if one did.
fn cancellation(
    conn: &Connection,
    held: &Registration,
    budget: Option<&mut Budget>,
) -> Result<Option<NativeRestoreCancellationReceipt>, ApplicationError> {
    let b = &held.binding;
    let doc = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let Some(receipt) = restore_fence::cancelled_at(
        conn,
        &held.namespace,
        &doc,
        Some(&b.lineage_claim_id),
        b.restore_fence_generation,
        budget,
    )?
    else {
        return Ok(None);
    };
    settlement::validate_historical_binding(&receipt.binding, b)?;
    Ok(Some(receipt))
}

/// Native generation reads bounded committed associations. An explicit budget
/// retains the full proof and charges every read, including the fence replay.
fn generation_with(
    conn: &Connection,
    held: &Registration,
    mut budget: Option<&mut Budget>,
) -> Result<Option<Settled>, ApplicationError> {
    let b = &held.binding;
    let generation = "FROM live_restore_fences WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND new_generation=?6";
    let p = params![
        held.namespace,
        b.workspace_id,
        b.main_version_id,
        b.object_id,
        b.lineage_claim_id,
        b.restore_fence_generation
    ];
    let length: i64 = conn
        .query_row(
            &format!("SELECT coalesce(sum(length(CAST(operation_id AS BLOB))),0) {generation}"),
            p,
            |r| r.get(0),
        )
        .map_err(read_sql)?;
    if let Some(budget) = budget.as_deref_mut() {
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    } else if !(0..=512).contains(&length) {
        return Err(ApplicationError::Corrupt);
    }
    let id: Option<String> = conn
        .query_row(&format!("SELECT operation_id {generation}"), p, |r| {
            r.get(0)
        })
        .optional()
        .map_err(read_sql)?;
    let Some(id) = id else {
        return Ok(None);
    };
    if let Some(cancelled) = cancellation(conn, held, budget.as_deref_mut())? {
        if cancelled.fence.operation.operation_id != id {
            return Err(ApplicationError::Corrupt);
        }
        return Ok(Some(Settled::Cancelled(Box::new(cancelled))));
    }
    let receipt = match budget {
        Some(budget) => saved_in(conn, held, &id, budget, None)?.map(|(receipt, ..)| receipt),
        None => native_saved(conn, held, &id)?,
    };
    receipt
        .map(|receipt| Settled::Resumed(Box::new(receipt)))
        .ok_or(ApplicationError::Conflict)
        .map(Some)
}

pub(super) fn validate_origin_binding(
    conn: &Connection,
    held: &Registration,
    original: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    validate_origin_binding_with(conn, held, original, None)
}

pub(super) fn validate_origin_binding_with(
    conn: &Connection,
    held: &Registration,
    original: &LiveObjectBinding,
    budget: Option<&mut Budget>,
) -> Result<(), ApplicationError> {
    if original.restore_fence_generation == held.binding.restore_fence_generation {
        return settlement::validate_historical_binding(original, &held.binding);
    }
    // A resumed restore, or one cancelled after its fence, produced the
    // registration's generation.
    let settled = generation_with(conn, held, budget)?.ok_or(ApplicationError::Conflict)?;
    let mut same = original.clone();
    same.restore_fence_generation = held.binding.restore_fence_generation;
    settlement::validate_historical_binding(&same, &held.binding)?;
    if *settled.binding() != held.binding {
        return Err(ApplicationError::Conflict);
    };
    Ok(())
}

impl ApplicationOwner {
    #[allow(clippy::too_many_arguments)]
    pub fn resume_restore(
        &mut self,
        store: &mut EngineStore,
        resolver: Option<&Arc<crate::reader_resolver::ReaderResolver>>,
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
            activation_id: None,
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
        let result=self.with_restore_settlement(store, resolver,input.application.clone(),coordinate,max_bytes,max_events,|store,audit| {
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
