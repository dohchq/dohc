use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PriorAnchor {
    pub(super) id: String,
    pub(super) cursor: i64,
    pub(super) sequence: i64,
    pub(super) previous_cursor: i64,
    previous_sequence: i64,
    pub(super) moment: String,
    pub(super) markdown: String,
    interval: String,
    pub(super) vector: String,
    pub(super) application_count: usize,
    pub(super) binding: LiveObjectBinding,
}

pub(super) struct RestoreAudit {
    input: NativeRestoreApplication,
    application: NativeRestoreApplicationReceipt,
    expected_vector: String,
    prior: Option<PriorAnchor>,
    max_bytes: usize,
    max_events: usize,
}

impl RestoreAudit {
    pub(super) fn operation_id(&self) -> &str {
        &self.input.preparation.fence.operation.operation_id
    }

    fn registration(&self, audit: &LiveSettlementAudit) -> Registration {
        Registration {
            workspace_id: audit.binding.workspace_id.clone(),
            namespace: audit.namespace.clone(),
            coordinate: audit.coordinate.clone(),
            binding: self.input.preparation.fence.operation.old_binding.clone(),
            live: false,
        }
    }

    fn verify_saved_anchor(
        &self,
        conn: &Connection,
        audit: &LiveSettlementAudit,
    ) -> Result<(), ApplicationError> {
        let mut held = self.registration(audit);
        held.binding = audit.binding.clone();
        // An earlier anchor belongs to the old fence and is checked separately.
        let exists:bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6)",params![audit.namespace,audit.binding.workspace_id,audit.binding.main_version_id,audit.binding.object_id,audit.binding.lineage_claim_id,audit.terminal_cursor],|row|row.get(0)).map_err(read_sql)?;
        if !exists {
            return Ok(());
        }
        let saved = read_anchor(conn, &held, audit.terminal_cursor, self.max_bytes)?
            .ok_or(ApplicationError::Corrupt)?;
        let bound:bool = conn.query_row("SELECT settlement_kind='restore' AND restore_operation_id=?2 FROM live_device_settlements WHERE settlement_id=?1",params![saved.id,self.operation_id()],|row|row.get(0)).map_err(read_sql)?;
        if !bound
            || saved.cursor != audit.terminal_cursor
            || saved.sequence != audit.sequence
            || saved.previous_cursor != audit.previous_cursor
            || saved.previous_sequence != audit.previous_sequence
            || saved.interval != audit.interval_digest
            || saved.application_count != audit.receipts.len()
            || saved.markdown != self.input.preparation.point.markdown_digest
            || saved.vector != self.expected_vector
        {
            return Err(ApplicationError::Corrupt);
        }
        Ok(())
    }

    pub(super) fn verify(
        &self,
        tx: &Transaction<'_>,
        audit: &LiveSettlementAudit,
        markdown: &str,
        vector: &str,
    ) -> Result<(), ApplicationError> {
        let held = self.registration(audit);
        let (proposal, application) = restore_content::applied_proposal(
            tx,
            &held,
            &self.input,
            self.max_bytes,
            self.max_events,
        )?;
        let prior = read_prior(tx, &held, &application, self.max_bytes)?;
        let old_terminal = self
            .input
            .preparation
            .fence
            .operation
            .terminal
            .as_ref()
            .map_or(0, |r| r.journal_cursor);
        let mut receipts = read_interval(
            tx,
            &held,
            audit.previous_cursor,
            old_terminal,
            self.max_events.saturating_sub(1),
        )?;
        receipts.push(application_identity(&application)?);
        if application != self.application
            || prior != self.prior
            || receipts != audit.receipts
            || latest_receipt(tx, &held)? != Some(application.admitted.accepted.receipt.clone())
            || coverage(
                &prior,
                proposal.receipt(),
                &application,
                &receipts,
                self.max_bytes,
            )? != audit.interval_digest
            || markdown != proposal.receipt().point.markdown_digest
            || vector != hex_sha256(&proposal.receipt().after_state_vector)
        {
            return Err(ApplicationError::Corrupt);
        }
        Ok(())
    }

    pub(super) fn covers_projection(
        &self,
        conn: &Connection,
        audit: &LiveSettlementAudit,
        moment: &str,
        markdown: &str,
    ) -> Result<bool, ApplicationError> {
        let held = self.registration(audit);
        require_workspace(conn, &held)?;
        let mut stopped = held.binding.clone();
        stopped.restore_fence_generation = self.application.fence.operation.new_fence;
        if !read_binding(conn, &held)?.is_some_and(|(binding, coordinate, available)| {
            !available && binding == stopped && coordinate.host_id == held.coordinate.host_id
        }) || restore_fence::marker(conn, &held.binding)?.head_update_seq
            != self.application.local_head_sequence
        {
            return Err(ApplicationError::Conflict);
        }
        let application_json =
            serde_json::to_string(&self.application).map_err(|_| ApplicationError::Corrupt)?;
        let matches: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM live_device_settlements s JOIN live_restore_fences f ON f.relay_database_namespace=s.relay_database_namespace AND f.operation_id=s.restore_operation_id WHERE s.relay_database_namespace=?1 AND s.workspace_id=?2 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.settlement_kind='restore' AND s.restore_operation_id=?6 AND s.terminal_cursor=?7 AND s.local_ydoc_sequence=?8 AND s.interval_digest=?9 AND s.moment_id=?10 AND s.markdown_digest=?11 AND f.application_json=?12)",
            params![audit.namespace, audit.binding.workspace_id, audit.binding.main_version_id, audit.binding.object_id, audit.binding.lineage_claim_id, self.operation_id(), audit.terminal_cursor, audit.sequence, audit.interval_digest, moment, markdown, application_json],
            |row| row.get(0),
        ).map_err(read_sql)?;
        Ok(matches && markdown == self.input.preparation.point.markdown_digest)
    }
}

impl ApplicationOwner {
    #[allow(clippy::too_many_arguments)]
    pub fn with_restore_settlement<E, T>(
        &mut self,
        store: &mut EngineStore,
        input: NativeRestoreApplication,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        settle: impl FnOnce(&mut EngineStore, &LiveSettlementAudit) -> Result<T, E>,
    ) -> Result<T, E>
    where
        E: From<ApplicationError> + From<StorageError>,
    {
        input
            .validate_budget(max_bytes, max_events)
            .map_err(E::from)?;
        coordinate.validate().map_err(E::from)?;
        let operation = &input.preparation.fence.operation;
        if operation.host_id != coordinate.host_id {
            return Err(E::from(ApplicationError::Conflict));
        }
        validate_application_binding(store, &self.workspace_id, &operation.old_binding)
            .map_err(E::from)?;
        let held = Registration {
            workspace_id: self.workspace_id.clone(),
            namespace: operation.relay_database_namespace.clone(),
            coordinate,
            binding: operation.old_binding.clone(),
            live: false,
        };
        let result = store.write_with(&NoFaults, |tx| -> Result<LiveSettlementAudit, ApplicationError> {
            let (proposal, application) = restore_content::applied_proposal(tx, &held, &input, max_bytes, max_events)?;
            let prior = read_prior(tx, &held, &application, max_bytes)?;
            let owner = adoption::read_origin(tx, &held)?;
            let (origin_binding, origin_moment, origin_digest, origin_cursor, origin_sequence) = if let Some(origin) = &owner {
                (origin.binding.clone(), origin.source_moment.clone(), origin.source_digest.clone(), origin.terminal.as_ref().map_or(0, |r| r.journal_cursor), origin.sequence)
            } else {
                let (bootstrap, binding, _, _) = bootstrap::read_bootstrap(tx, &held)?.ok_or(ApplicationError::Corrupt)?;
                (binding, bootstrap.bootstrap_moment_id, bootstrap.projected_markdown_digest, 0, 0)
            };
            validate_historical_binding(&origin_binding, &held.binding)?;
            let (previous_cursor, previous_sequence, expected_moment, expected_digest) = prior.as_ref().map_or(
                (origin_cursor, origin_sequence, origin_moment, origin_digest),
                |prior| (prior.cursor, prior.sequence, prior.moment.clone(), prior.markdown.clone()),
            );
            if previous_sequence > application.fence.local_head_sequence {
                return Err(ApplicationError::Corrupt);
            }
            let old_terminal = operation.terminal.as_ref().map_or(0, |r| r.journal_cursor);
            let mut receipts = read_interval(tx, &held, previous_cursor, old_terminal, max_events.saturating_sub(1))?;
            receipts.push(application_identity(&application)?);
            let interval_digest = coverage(&prior, proposal.receipt(), &application, &receipts, max_bytes)?;
            let last_settled: Option<String> = tx.query_row("SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3", params![held.binding.workspace_id, held.binding.main_version_id, held.binding.object_id], |row| row.get(0)).map_err(read_sql)?;
            if latest_receipt(tx,&held)? != Some(application.admitted.accepted.receipt.clone()) {return Err(ApplicationError::Conflict);}
            let audit = LiveSettlementAudit {
                namespace: held.namespace.clone(), binding: application.admitted.accepted.binding.clone(), coordinate: held.coordinate.clone(),
                previous_cursor, terminal_cursor: application.admitted.accepted.receipt.journal_cursor,
                previous_sequence, sequence: application.local_head_sequence, receipts, interval_digest,
                bootstrap_moment: expected_moment, bootstrap_digest: expected_digest,
                first: owner.is_none() && prior.is_none() && last_settled.is_none(),
                restore: Some(Box::new(RestoreAudit { input: input.clone(), expected_vector: hex_sha256(&proposal.receipt().after_state_vector), application, prior, max_bytes, max_events })),
                replay_anchor: None,
            };
            if let Some(restore) = &audit.restore {restore.verify_saved_anchor(tx,&audit)?;}
            Ok(audit)
        }).map_err(E::from)?;
        let TxnOutcome::Committed(audit) = result else {
            return Err(E::from(ApplicationError::Interrupted));
        };
        settle(store, &audit)
    }
}

fn application_identity(
    application: &NativeRestoreApplicationReceipt,
) -> Result<ReceiptIdentity, ApplicationError> {
    let accepted = &application.admitted.accepted;
    Ok((
        accepted.receipt.delivery_id.clone(),
        accepted.receipt.update_digest.clone(),
        accepted.receipt.journal_cursor,
        accepted.receipt.accepting_host_epoch,
        application.local_head_sequence,
        hex_sha256(&serde_json::to_vec(&accepted.binding).map_err(|_| ApplicationError::Corrupt)?),
    ))
}

fn read_prior(
    conn: &Connection,
    held: &Registration,
    application: &NativeRestoreApplicationReceipt,
    max_bytes: usize,
) -> Result<Option<PriorAnchor>, ApplicationError> {
    let terminal = application
        .fence
        .operation
        .terminal
        .as_ref()
        .map_or(0, |r| r.journal_cursor);
    read_anchor(conn, held, terminal, max_bytes)
}

fn read_anchor(
    conn: &Connection,
    held: &Registration,
    terminal: i64,
    max_bytes: usize,
) -> Result<Option<PriorAnchor>, ApplicationError> {
    let b = &held.binding;
    let length: Option<i64> = conn.query_row(
        "SELECT length(CAST(binding_json AS BLOB))+length(CAST(settlement_id AS BLOB))+length(CAST(moment_id AS BLOB))+192 FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor<=?6 ORDER BY terminal_cursor DESC LIMIT 1",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,terminal], |row| row.get(0),
    ).optional().map_err(read_sql)?;
    let Some(length) = length else {
        return Ok(None);
    };
    if usize::try_from(length).map_err(|_| ApplicationError::Corrupt)? > max_bytes {
        return Err(invalid("restore anchor exceeds configured byte budget"));
    }
    let (id,cursor,sequence,moment,markdown,interval,vector,binding,previous_cursor,previous_sequence,count): (String,i64,i64,String,String,String,String,String,i64,i64,i64) = conn.query_row(
        "SELECT settlement_id,terminal_cursor,local_ydoc_sequence,moment_id,markdown_digest,interval_digest,source_state_vector_digest,binding_json,previous_cursor,previous_ydoc_sequence,application_count FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor<=?6 ORDER BY terminal_cursor DESC LIMIT 1",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,terminal], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)),
    ).map_err(read_sql)?;
    let binding = serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
    validate_historical_binding(&binding, b)?;
    let expected_id = format!(
        "live-settlement-{}",
        hex_sha256(
            &serde_json::to_vec(&(
                &held.namespace,
                &binding,
                previous_cursor,
                cursor,
                previous_sequence,
                sequence,
                &interval,
                &moment,
                &markdown,
                &vector,
            ))
            .map_err(|_| ApplicationError::Corrupt)?
        )
    );
    if id != expected_id {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(PriorAnchor {
        id,
        cursor,
        sequence,
        previous_cursor,
        previous_sequence,
        application_count: usize::try_from(count).map_err(|_| ApplicationError::Corrupt)?,
        moment,
        markdown,
        interval,
        vector,
        binding,
    }))
}

pub(super) fn restored_origin(
    conn: &Connection,
    held: &Registration,
) -> Result<Option<PriorAnchor>, ApplicationError> {
    let b = &held.binding;
    let row: Option<(i64,i64)> = conn.query_row(
        "SELECT s.terminal_cursor,length(CAST(f.application_json AS BLOB)) FROM live_device_settlements s JOIN live_restore_fences f ON f.relay_database_namespace=s.relay_database_namespace AND f.operation_id=s.restore_operation_id WHERE s.relay_database_namespace=?1 AND s.workspace_id=?2 AND s.main_version_id=?3 AND s.object_id=?4 AND s.lineage_claim_id=?5 AND s.settlement_kind='restore' ORDER BY s.terminal_cursor DESC LIMIT 1",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(read_sql)?;
    let Some((cursor, length)) = row else {
        return Ok(None);
    };
    if usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?
        > crate::limits::MAX_YDOC_UPDATE_BYTES
    {
        return Err(ApplicationError::Corrupt);
    }
    let anchor = read_anchor(conn, held, cursor, crate::limits::MAX_YDOC_UPDATE_BYTES)?
        .ok_or(ApplicationError::Corrupt)?;
    let (application,markdown):(String,String) = conn.query_row(
        "SELECT f.application_json,json_extract(f.proposal_json,'$.point.markdownDigest') FROM live_device_settlements s JOIN live_restore_fences f ON f.relay_database_namespace=s.relay_database_namespace AND f.operation_id=s.restore_operation_id WHERE s.settlement_id=?1 AND f.workspace_id=s.workspace_id AND f.main_version_id=s.main_version_id AND f.object_id=s.object_id",
        [&anchor.id],|row|Ok((row.get(0)?,row.get(1)?)),
    ).map_err(read_sql)?;
    let application: NativeRestoreApplicationReceipt =
        serde_json::from_str(&application).map_err(|_| ApplicationError::Corrupt)?;
    if application.admitted.accepted.binding != anchor.binding
        || application.local_head_sequence != anchor.sequence
        || application.admitted.accepted.receipt.journal_cursor != anchor.cursor
        || markdown != anchor.markdown
    {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(anchor))
}

fn coverage(
    prior: &Option<PriorAnchor>,
    proposal: &NativeRestoreProposalReceipt,
    application: &NativeRestoreApplicationReceipt,
    receipts: &[ReceiptIdentity],
    max_bytes: usize,
) -> Result<String, ApplicationError> {
    use sha2::Digest;
    struct Hasher {
        hash: sha2::Sha256,
        remaining: usize,
    }
    impl std::io::Write for Hasher {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.remaining = self
                .remaining
                .checked_sub(bytes.len())
                .ok_or_else(|| std::io::Error::other("restore coverage budget exceeded"))?;
            self.hash.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Hasher {
        hash: sha2::Sha256::new(),
        remaining: max_bytes,
    };
    serde_json::to_writer(&mut writer, &(prior, proposal, application, receipts))
        .map_err(|_| invalid("restore coverage exceeds configured byte budget"))?;
    Ok(writer
        .hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
