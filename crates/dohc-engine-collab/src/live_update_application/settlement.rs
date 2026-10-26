use super::*;
use std::collections::HashSet;

pub(super) mod restore;

/// Immutable projection coverage. Filesystem status belongs to its materialization job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSettlementResult {
    /// Absent when nothing was accepted since the owner's handover or the
    /// first baseline: such a settlement is neither recorded nor published.
    pub settlement_id: Option<String>,
    pub previous_cursor: i64,
    pub terminal_cursor: i64,
    pub application_count: usize,
    #[serde(rename = "localYDocSequence")]
    pub local_ydoc_sequence: i64,
    pub moment_id: String,
    pub markdown_digest: String,
    pub materialized: bool,
    /// The service must request collection reconciliation after this commit.
    pub collection_reconcile_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveSettlementPublicationState {
    New,
    Retained(Vec<u8>),
    Unavailable,
}

pub struct LiveSettlementAudit {
    namespace: String,
    binding: LiveObjectBinding,
    coordinate: ApplicationHostCoordinate,
    previous_cursor: i64,
    terminal_cursor: i64,
    previous_sequence: i64,
    /// The native head this settlement first covered. A replay at the same
    /// terminal keeps its saved value even if private edits grew the head.
    pub(super) sequence: i64,
    /// The native head the settlement transaction must still observe.
    observed_head: i64,
    /// The accepted document through the terminal, when the owner's private
    /// native tail keeps the native head ahead of acceptance.
    accepted: Option<crate::Ydoc>,
    terminal_source: bool,
    receipts: Vec<ReceiptIdentity>,
    interval_digest: String,
    bootstrap_moment: String,
    bootstrap_digest: String,
    first: bool,
    restore: Option<Box<restore::RestoreAudit>>,
    replay_anchor: Option<restore::PriorAnchor>,
    /// No settlement is stored and the relay accepted nothing since the
    /// owner's handover or the first baseline.
    empty: bool,
}

fn audit_error(error: ApplicationError) -> ApplicationError {
    match error {
        ApplicationError::Storage(_)
        | ApplicationError::Collab(
            CollabError::MarkdownReaderPending(_) | CollabError::MarkdownReaderUnavailable,
        ) => error,
        _ => StorageError::StateCorrupt { source: None }.into(),
    }
}

impl LiveSettlementAudit {
    /// A compensated filesystem marker can be restored only for this retained projection.
    pub fn covers_projection_in(
        &self,
        conn: &Connection,
        moment: &str,
        markdown: &str,
    ) -> Result<bool, ApplicationError> {
        if let Some(restore) = &self.restore {
            return restore
                .covers_projection(conn, self, moment, markdown)
                .map_err(audit_error);
        }
        let b = &self.binding;
        let registration = Registration {
            workspace_id: b.workspace_id.clone(),
            namespace: self.namespace.clone(),
            coordinate: self.coordinate.clone(),
            binding: b.clone(),
            live: true,
        };
        require_workspace(conn, &registration).map_err(audit_error)?;
        if !read_binding(conn, &registration)
            .map_err(audit_error)?
            .is_some_and(|(binding, coordinate, available)| {
                available && binding == *b && coordinate == self.coordinate
            })
        {
            return Err(StorageError::StateCorrupt { source: None }.into());
        }
        let saved:Option<(String,String,i64,String)>=conn.query_row("SELECT moment_id,markdown_digest,local_ydoc_sequence,binding_json FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 ORDER BY terminal_cursor DESC LIMIT 1",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(StorageError::persist_public)?;
        let Some((saved_moment, saved_markdown, sequence, binding)) = saved else {
            return Ok(false);
        };
        let binding: LiveObjectBinding =
            serde_json::from_str(&binding).map_err(StorageError::persist_public)?;
        validate_historical_binding(&binding, b).map_err(audit_error)?;
        Ok(saved_moment == moment && saved_markdown == markdown && sequence <= self.sequence)
    }
    /// An unchanged projection may name the current head moment only when that
    /// moment is already this document's latest audited settlement. Any other
    /// head, such as a pre-live imported projection, would publish its own
    /// historical before-image. A restore reuses only its own saved settlement,
    /// so its first settlement records the restore transition. Replay keeps its
    /// exact record-time checks. An empty settlement publishes nothing, so any
    /// head holding its projection stands.
    pub fn reuses_head_in(
        &self,
        conn: &Connection,
        moment: &str,
        markdown: &str,
    ) -> Result<bool, ApplicationError> {
        if self.empty {
            return Ok(true);
        }
        if self.terminal_source {
            return Ok(false);
        }
        if let Some(restore) = &self.restore {
            let b = &self.binding;
            return conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6 AND settlement_kind='restore' AND restore_operation_id=?7 AND moment_id=?8 AND markdown_digest=?9 AND binding_json=?10)",
                params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.terminal_cursor,restore.operation_id(),moment,markdown,serde_json::to_string(b).map_err(StorageError::persist_public)?],
                |row| row.get(0),
            ).map_err(|error| ApplicationError::Storage(StorageError::persist_public(error)));
        }
        if self.replay_anchor.is_some() {
            return Ok(true);
        }
        self.covers_projection_in(conn, moment, markdown)
    }
    pub fn binding(&self) -> &LiveObjectBinding {
        &self.binding
    }
    /// The settlement covers no accepted edit. It still projects the file,
    /// but nothing is recorded or published: the relay accepts only a
    /// settlement whose interval holds an accepted edit.
    pub fn is_empty(&self) -> bool {
        self.empty
    }
    /// The accepted document this settlement projects instead of the native
    /// head. Present only while this owner's own native edits wait for the
    /// relay: the moment, file, and published record then hold accepted
    /// content alone, and the native settled boundary does not advance.
    pub fn accepted_prefix(&self) -> Option<&crate::Ydoc> {
        self.accepted.as_ref()
    }
    pub fn expected_head(&self) -> &str {
        &self.bootstrap_digest
    }
    pub fn stored_id(
        &self,
        store: &EngineStore,
        moment: &str,
        markdown: &str,
    ) -> Result<String, StorageError> {
        let b = &self.binding;
        store.read_with(|conn| conn.query_row("SELECT settlement_id FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6 AND moment_id=?7 AND markdown_digest=?8",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.terminal_cursor,moment,markdown],|row| row.get(0))).map_err(StorageError::persist_public)
    }
    pub fn permits_absent_bootstrap(&self, moment: &str, digest: &str) -> bool {
        self.first && moment == self.bootstrap_moment && digest == self.bootstrap_digest
    }

    pub fn record_in_tx(
        &self,
        tx: &Transaction<'_>,
        moment: &str,
        markdown: &str,
        vector: &str,
        now_ms: i64,
    ) -> Result<String, ApplicationError> {
        if let Some(restore) = &self.restore {
            restore
                .verify(tx, self, markdown, vector)
                .map_err(audit_error)?;
        } else {
            let corrupt = || ApplicationError::Storage(StorageError::StateCorrupt { source: None });
            let b = &self.binding;
            let registration = Registration {
                workspace_id: b.workspace_id.clone(),
                namespace: self.namespace.clone(),
                coordinate: self.coordinate.clone(),
                binding: b.clone(),
                live: true,
            };
            require_workspace(tx, &registration).map_err(audit_error)?;
            if !read_binding(tx, &registration)
                .map_err(audit_error)?
                .is_some_and(|(binding, coordinate, available)| {
                    available && binding == *b && coordinate == self.coordinate
                })
            {
                return Err(corrupt());
            }
            let latest = latest_receipt(tx, &registration).map_err(audit_error)?;
            if latest.as_ref().map_or(0, |receipt| receipt.journal_cursor) != self.terminal_cursor {
                return Err(corrupt());
            }
            let receipts = read_interval(
                tx,
                &registration,
                self.previous_cursor,
                self.terminal_cursor,
                self.receipts.len(),
            )
            .map_err(audit_error)?;
            if receipts != self.receipts {
                return Err(corrupt());
            }
            let observed: i64 = tx.query_row("SELECT head_update_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |row| row.get(0)).map_err(StorageError::persist_public)?;
            if observed != self.observed_head {
                return Err(corrupt());
            }
        }
        let corrupt = || ApplicationError::Storage(StorageError::StateCorrupt { source: None });
        let b = &self.binding;
        let matches_projection: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshots s JOIN ydoc_docs d ON d.workspace_id=s.workspace_id AND d.version_id=s.version_id AND d.object_id=s.object_id WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.latest_moment_id=?5 AND s.blob_sha256=?6 AND d.path=?4 AND d.lineage_claim_id=?7 AND d.last_settled_sha=?6)",
            params![b.workspace_id,b.main_version_id,b.object_id,b.current_path,moment,markdown,b.lineage_claim_id],|row|row.get(0)).map_err(StorageError::persist_public)?;
        if !matches_projection {
            return Err(corrupt());
        }
        if let Some(anchor) = &self.replay_anchor {
            let held = Registration {
                workspace_id: b.workspace_id.clone(),
                namespace: self.namespace.clone(),
                coordinate: self.coordinate.clone(),
                binding: b.clone(),
                live: true,
            };
            if restore::restored_origin(tx, &held)
                .map_err(audit_error)?
                .as_ref()
                != Some(anchor)
                || anchor.moment != moment
                || anchor.markdown != markdown
                || anchor.vector != vector
            {
                return Err(corrupt());
            }
            return Ok(anchor.id.clone());
        }
        let identities = serde_json::to_vec(&(
            &self.namespace,
            b,
            self.previous_cursor,
            self.terminal_cursor,
            self.previous_sequence,
            self.sequence,
            &self.interval_digest,
            moment,
            markdown,
            vector,
        ))
        .map_err(StorageError::persist_public)?;
        let id = format!("live-settlement-{}", hex_sha256(&identities));
        let operation = self.restore.as_ref().map(|restore| restore.operation_id());
        let existing: Option<(String,String,String,String,i64,i64)> = tx.query_row(
            "SELECT settlement_id,moment_id,markdown_digest,interval_digest,application_count,local_ydoc_sequence FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6 AND restore_operation_id IS ?7 AND settlement_kind=?8 AND binding_json=?9 AND source_state_vector_digest=?10",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.terminal_cursor,operation,if operation.is_some() {"restore"} else {"ordinary"},serde_json::to_string(b).map_err(StorageError::persist_public)?,vector],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(StorageError::persist_public)?;
        if let Some((saved, saved_moment, saved_markdown, saved_interval, count, sequence)) =
            existing
        {
            if saved != id
                || saved_moment != moment
                || saved_markdown != markdown
                || saved_interval != self.interval_digest
                || count != self.receipts.len() as i64
                || sequence != self.sequence
            {
                return Err(corrupt());
            }
            return Ok(id);
        }
        // Stored settlements may start where they end. A new one must not.
        if self.previous_cursor >= self.terminal_cursor {
            return Err(invalid("a new settlement must cover an accepted edit"));
        }
        tx.execute("INSERT INTO live_device_settlements VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
            params![id,self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.previous_cursor,self.terminal_cursor,self.previous_sequence,self.sequence,self.receipts.len() as i64,self.interval_digest,moment,markdown,vector,
                serde_json::to_string(b).map_err(StorageError::persist_public)?,serde_json::to_string(&self.coordinate).map_err(StorageError::persist_public)?,now_ms,if operation.is_some() {"restore"} else {"ordinary"},operation]).map_err(StorageError::persist_public)?;
        if self.terminal_source {
            tx.execute("INSERT INTO live_settlement_attribution_unavailable(workspace_id,moment_id,settlement_id,reason) VALUES (?1,?2,?3,'terminal-owner-source') ON CONFLICT(workspace_id,moment_id) DO NOTHING",params![b.workspace_id,moment,id]).map_err(StorageError::persist_public)?;
        }
        Ok(id)
    }

    /// Before recording, distinguish a new capture from a historical replay.
    /// A historical settlement without retained state cannot capture today's doc.
    pub fn prepare_publication_state_in_tx(
        &self,
        tx: &Transaction<'_>,
    ) -> Result<LiveSettlementPublicationState, StorageError> {
        if self.terminal_source {
            return Ok(LiveSettlementPublicationState::Unavailable);
        }
        let settlement_id: Option<String> = tx
            .query_row(
                "SELECT settlement_id FROM live_device_settlements \
                 WHERE relay_database_namespace=?1 AND workspace_id=?2 \
                 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 \
                 AND terminal_cursor=?6",
                params![
                    self.namespace,
                    self.binding.workspace_id,
                    self.binding.main_version_id,
                    self.binding.object_id,
                    self.binding.lineage_claim_id,
                    self.terminal_cursor,
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::persist_public)?;
        match settlement_id {
            None => Ok(LiveSettlementPublicationState::New),
            Some(id) => Ok(match self.retained_publication_state_in_tx(tx, &id)? {
                Some(bytes) => LiveSettlementPublicationState::Retained(bytes),
                None => LiveSettlementPublicationState::Unavailable,
            }),
        }
    }

    /// A replay keeps the exact accepted state captured by the original commit.
    pub fn retained_publication_state_in_tx(
        &self,
        tx: &Transaction<'_>,
        settlement_id: &str,
    ) -> Result<Option<Vec<u8>>, StorageError> {
        let digest: Option<String> = tx
            .query_row(
                "SELECT p.state_blob_sha256 FROM live_settlement_publication_states p \
                 JOIN live_device_settlements s ON s.settlement_id=p.settlement_id \
                 WHERE s.settlement_id=?1 AND s.relay_database_namespace=?2 \
                 AND s.workspace_id=?3 AND s.main_version_id=?4 AND s.object_id=?5 \
                 AND s.lineage_claim_id=?6 AND s.terminal_cursor=?7",
                params![
                    settlement_id,
                    self.namespace,
                    self.binding.workspace_id,
                    self.binding.main_version_id,
                    self.binding.object_id,
                    self.binding.lineage_claim_id,
                    self.terminal_cursor,
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::persist_public)?;
        digest
            .map(|digest| {
                get_binary_blob(tx, &digest)?.ok_or(StorageError::StateCorrupt { source: None })
            })
            .transpose()
    }

    /// Retain the accepted full state in the settlement's own transaction.
    /// Repeating a capture must name the identical bytes.
    pub fn record_publication_state_in_tx(
        &self,
        tx: &Transaction<'_>,
        settlement_id: &str,
        full_state_bytes: &[u8],
    ) -> Result<(), StorageError> {
        if self.terminal_source {
            return Err(StorageError::StateCorrupt { source: None });
        }
        let matches_audit: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM live_device_settlements \
                 WHERE settlement_id=?1 AND relay_database_namespace=?2 \
                 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5 \
                 AND lineage_claim_id=?6 AND terminal_cursor=?7)",
                params![
                    settlement_id,
                    self.namespace,
                    self.binding.workspace_id,
                    self.binding.main_version_id,
                    self.binding.object_id,
                    self.binding.lineage_claim_id,
                    self.terminal_cursor,
                ],
                |row| row.get(0),
            )
            .map_err(StorageError::persist_public)?;
        if !matches_audit {
            return Err(StorageError::StateCorrupt { source: None });
        }
        if let Some(saved) = self.retained_publication_state_in_tx(tx, settlement_id)? {
            if saved != full_state_bytes {
                return Err(StorageError::StateCorrupt { source: None });
            }
            return Ok(());
        }
        let digest = dohc_engine_storage::put_binary_blob(tx, full_state_bytes)?;
        tx.execute(
            "INSERT INTO live_settlement_publication_states(settlement_id,state_blob_sha256) \
             VALUES (?1,?2)",
            params![settlement_id, digest],
        )
        .map_err(StorageError::persist_public)?;
        Ok(())
    }

    pub fn result(
        &self,
        settlement_id: Option<String>,
        moment_id: String,
        markdown_digest: String,
        materialized: bool,
    ) -> LiveSettlementResult {
        LiveSettlementResult {
            settlement_id,
            previous_cursor: self
                .replay_anchor
                .as_ref()
                .map_or(self.previous_cursor, |anchor| anchor.previous_cursor),
            terminal_cursor: self.terminal_cursor,
            application_count: self
                .replay_anchor
                .as_ref()
                .map_or(self.receipts.len(), |anchor| anchor.application_count),
            local_ydoc_sequence: self.sequence,
            moment_id,
            markdown_digest,
            materialized,
            collection_reconcile_required: false,
        }
    }
}

/// The registered application mutex remains held across projection and its transaction.
pub fn with_settlement<E, T>(
    store: &mut EngineStore,
    handle: &ApplicationHandle,
    terminal: Option<LiveUpdateReceipt>,
    max_applications: usize,
    reconstruction: NativeHistoryReconstruction,
    settle: impl FnOnce(&mut EngineStore, &LiveSettlementAudit) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<ApplicationError> + From<StorageError>,
{
    if max_applications == 0 || max_applications >= i64::MAX as usize {
        return Err(E::from(invalid("invalid settlement application limit")));
    }
    if let Some(receipt) = &terminal {
        receipt.validate().map_err(E::from)?;
    }
    let held = handle
        .registration
        .lock()
        .map_err(|_| E::from(ApplicationError::Interrupted))?;
    if !held.live {
        return Err(E::from(ApplicationError::Interrupted));
    }
    let audit = store.read_with(|conn| -> Result<LiveSettlementAudit, ApplicationError> {
        require_workspace(conn, &held)?;
        if !read_binding(conn,&held)?.is_some_and(|(binding,coordinate,available)| available && binding == held.binding && coordinate == held.coordinate) { return Err(ApplicationError::Interrupted); }
        let b = &held.binding;
        validate_historical_binding(b,b)?;
        let key = DocKey::new(&b.workspace_id,&b.main_version_id,&b.object_id)?;
        let marker = durable::read_marker_in(conn,&key)?.ok_or(ApplicationError::Corrupt)?;
        if marker.regime != Regime::Replicated || marker.lineage_claim_status != durable::LineageClaimStatus::Exact || marker.content_kind != crate::ContentKind::Richdoc || marker.lineage_claim_id.as_deref()!=Some(b.lineage_claim_id.as_str()) || marker.path.as_deref()!=Some(b.current_path.as_str()) { return Err(ApplicationError::Conflict); }
        let owner_origin = adoption::read_origin(conn,&held)?;
        let restored_origin = restore::restored_origin(conn,&held)?;
        let (original_binding,origin_moment,origin_digest,origin_cursor,origin_sequence) = if let Some(origin) = &restored_origin {
            (origin.binding.clone(),origin.moment.clone(),origin.markdown.clone(),origin.cursor,origin.sequence)
        } else if let Some(origin) = &owner_origin {
            (origin.binding.clone(),origin.source_moment.clone(),origin.source_digest.clone(),origin.terminal.as_ref().map_or(0,|r|r.journal_cursor),origin.sequence)
        } else {
            let (bootstrap,original_binding,_,_) = bootstrap::read_bootstrap(conn,&held)?.ok_or(ApplicationError::Corrupt)?;
            (original_binding,bootstrap.bootstrap_moment_id,bootstrap.projected_markdown_digest,0,0)
        };
        validate_historical_binding(&original_binding,b)?;
        let latest = latest_receipt(conn,&held)?;
        if latest != terminal { return Err(invalid("settlement terminal is not current")); }
        let terminal_cursor = terminal.as_ref().map_or(0,|r|r.journal_cursor);
        let previous: Option<(i64,i64,i64,i64,Option<i64>)> = conn.query_row(
            "SELECT s.previous_cursor,s.terminal_cursor,s.previous_ydoc_sequence,s.local_ydoc_sequence,
             (SELECT p.previous_cursor FROM live_settlement_attribution_unavailable u
              JOIN live_device_settlements p ON p.settlement_id=u.settlement_id
              WHERE u.workspace_id=s.workspace_id AND u.moment_id=s.moment_id
                AND p.relay_database_namespace=s.relay_database_namespace AND p.workspace_id=s.workspace_id
                AND p.main_version_id=s.main_version_id AND p.object_id=s.object_id
                AND p.lineage_claim_id=s.lineage_claim_id AND p.moment_id=s.moment_id AND p.binding_json=s.binding_json
                AND p.terminal_cursor=(SELECT min(f.terminal_cursor) FROM live_device_settlements f
                  WHERE f.relay_database_namespace=s.relay_database_namespace AND f.workspace_id=s.workspace_id
                    AND f.main_version_id=s.main_version_id AND f.object_id=s.object_id
                    AND f.lineage_claim_id=s.lineage_claim_id AND f.moment_id=s.moment_id AND f.binding_json=s.binding_json)),
             s.binding_json FROM live_device_settlements s
             WHERE s.relay_database_namespace=?1 AND s.workspace_id=?2 AND s.main_version_id=?3
               AND s.object_id=?4 AND s.lineage_claim_id=?5 ORDER BY s.terminal_cursor DESC LIMIT 1",
            params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row| {
                let binding: LiveObjectBinding = serde_json::from_str(&row.get::<_,String>(5)?).map_err(|error|rusqlite::Error::FromSqlConversionFailure(5,rusqlite::types::Type::Text,Box::new(error)))?;
                Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get::<_,Option<i64>>(4)?.filter(|_| binding == *b)))
            }).optional().map_err(read_sql)?;
        // A settlement at the current terminal replays with the native head
        // it first covered. Private native edits since then extend the head
        // but never this settlement's identity.
        let head = marker.head_update_seq;
        let (previous_cursor,previous_sequence,replayed) = match previous {
            Some((_,end,_,end_sequence,_)) if end == terminal_cursor && restored_origin.as_ref().is_some_and(|anchor|anchor.cursor == end) => (end,end_sequence,None),
            Some((start,end,start_sequence,end_sequence,_)) if end == terminal_cursor => (start,start_sequence,Some(end_sequence)),
            Some((_,end,_,end_sequence,refused_start)) if end < terminal_cursor => {
                let cursor = if let Some(start) = refused_start { verified_previous_cursor(conn,&held,start,origin_cursor,max_applications)? } else {end};
                (cursor,end_sequence,None)
            },
            Some(_) => return Err(ApplicationError::Corrupt),
            None => (origin_cursor,origin_sequence,None),
        };
        if replayed.is_some_and(|sequence| sequence < previous_sequence || sequence > head) { return Err(ApplicationError::Corrupt); }
        let receipts = read_interval(conn,&held,previous_cursor,terminal_cursor,max_applications)?;
        let mut sequences=HashSet::new();
        for (delivery,hash,cursor,epoch,sequence,_) in &receipts {
            LiveUpdateReceipt { delivery_id:delivery.clone(),update_digest:hash.clone(),journal_cursor:*cursor,accepting_host_epoch:*epoch }.validate()?;
            integer(*sequence,1,head)?;
            if *sequence>previous_sequence { sequences.insert(*sequence); }
        }
        if head < previous_sequence { return Err(invalid("settlement application coverage is incomplete")); }
        // Every native sequence since the last settlement is an accepted
        // application or one of this owner's own updates still waiting for
        // the relay. Its own later application counts by journal cursor.
        let tail = private_tail(conn,&held,previous_sequence,head)?;
        sequences.extend(tail.sequences.iter().copied());
        if sequences.len() as i64 != head-previous_sequence { return Err(invalid("settlement application coverage is incomplete")); }
        let accepted = if tail.any {
            // Accepting the pending seed must not roll back the owner's file
            // to an accepted state that lacks its pre-adoption head.
            if tail.seed { return Err(invalid("the owner's adoption seed must be accepted before a settlement")); }
            // A settlement still answers a missing dependency as a conflict.
            Some(accepted_history::read_state(conn,&held,terminal_cursor,reconstruction).map_err(|error| match error {
                ApplicationError::AcceptedStateIncomplete => ApplicationError::Conflict,
                error => error,
            })?)
        } else {
            None
        };
        let interval_digest=hex_sha256(&serde_json::to_vec(&receipts).map_err(|_| ApplicationError::Corrupt)?);
        let last_settled: Option<String> = conn.query_row("SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id],|row|row.get(0)).map_err(read_sql)?;
        // With nothing stored, the next settlement again starts at the origin.
        let empty = previous.is_none() && restored_origin.is_none() && previous_cursor == terminal_cursor;
        Ok(LiveSettlementAudit { namespace:held.namespace.clone(),binding:b.clone(),coordinate:held.coordinate.clone(),previous_cursor,terminal_cursor,previous_sequence,sequence:replayed.unwrap_or(head),observed_head:head,accepted,terminal_source:replayed.is_none() && tail.terminal,receipts,interval_digest,
            bootstrap_moment:origin_moment,bootstrap_digest:origin_digest,first:owner_origin.is_none() && previous.is_none() && last_settled.is_none(),restore:None,
            replay_anchor:restored_origin.filter(|anchor|anchor.cursor == terminal_cursor),empty })
    }).map_err(E::from)?;
    settle(store, &audit)
}

/// Refused queued proofs can point to one another. Only this full binding's
/// unavailable native predecessors are skipped; the authenticated origin stays.
fn verified_previous_cursor(
    conn: &Connection,
    held: &Registration,
    start: i64,
    origin: i64,
    limit: usize,
) -> Result<i64, ApplicationError> {
    let b = &held.binding;
    let mut cursor = start.max(origin);
    let mut visited = 0;
    while cursor > origin {
        if visited >= limit {
            return Err(invalid("settlement application limit exceeded"));
        }
        let prior: Option<(i64,String)> = conn.query_row(
            "SELECT p.previous_cursor,p.binding_json FROM live_device_settlements s
             JOIN live_settlement_attribution_unavailable u ON u.workspace_id=s.workspace_id AND u.moment_id=s.moment_id
             JOIN live_device_settlements p ON p.settlement_id=u.settlement_id
             WHERE s.relay_database_namespace=?1 AND s.workspace_id=?2 AND s.main_version_id=?3 AND s.object_id=?4
               AND s.lineage_claim_id=?5 AND s.terminal_cursor=?6 AND json_extract(s.binding_json,'$.currentPath')=?7
               AND json_extract(s.binding_json,'$.restoreFenceGeneration')=?8 AND json_extract(s.binding_json,'$.selectorPaths')=json(?9)
               AND p.relay_database_namespace=s.relay_database_namespace AND p.workspace_id=s.workspace_id
               AND p.main_version_id=s.main_version_id AND p.object_id=s.object_id AND p.lineage_claim_id=s.lineage_claim_id
               AND p.moment_id=s.moment_id AND p.binding_json=s.binding_json AND p.terminal_cursor<=s.terminal_cursor
               AND p.terminal_cursor=(SELECT min(f.terminal_cursor) FROM live_device_settlements f
                 WHERE f.relay_database_namespace=s.relay_database_namespace AND f.workspace_id=s.workspace_id
                   AND f.main_version_id=s.main_version_id AND f.object_id=s.object_id AND f.lineage_claim_id=s.lineage_claim_id
                   AND f.moment_id=s.moment_id AND f.binding_json=s.binding_json)",
            params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,cursor,b.current_path,b.restore_fence_generation,serde_json::to_string(&b.selector_paths).map_err(|_|ApplicationError::Corrupt)?],|row|Ok((row.get(0)?,row.get(1)?)),
        ).optional().map_err(read_sql)?;
        let Some((previous, binding)) = prior else {
            break;
        };
        let binding: LiveObjectBinding =
            serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
        if binding != *b || previous < 0 || previous >= cursor {
            return Err(ApplicationError::Corrupt);
        }
        cursor = previous.max(origin);
        visited += 1;
    }
    Ok(cursor)
}

type ReceiptIdentity = (String, String, i64, i64, i64, String);

/// A native source names one binding and its origin. A larger one is corrupt.
const MAX_NATIVE_SOURCE_BYTES: i64 = 262_144;

/// This owner's own native updates that the relay has not accepted: pending
/// adopted entries of the current outbox with no application of their
/// delivery.
#[derive(Default)]
struct PrivateTail {
    /// Their native sequences after `previous_sequence`, each verified
    /// against its own journal row.
    sequences: Vec<i64>,
    /// Whether any exists at all, before or after `previous_sequence`.
    any: bool,
    /// Whether the adoption seed is among them.
    seed: bool,
    terminal: bool,
}

fn private_tail(
    conn: &Connection,
    held: &Registration,
    previous_sequence: i64,
    head: i64,
) -> Result<PrivateTail, ApplicationError> {
    let b = &held.binding;
    let adoption: Option<String> = conn.query_row("SELECT adoption_id FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row|row.get(0)).optional().map_err(read_sql)?;
    let Some(adoption) = adoption else {
        return Ok(PrivateTail::default());
    };
    let tail = "FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4 AND o.restore_fence_generation=?5 AND o.current_path=?6 AND (e.pending=1 OR (e.pending=0 AND e.terminal_reason IS NOT NULL AND e.terminal_blob_digest=e.update_digest AND e.accepted_receipt_json IS NULL)) AND e.native_source_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM live_device_update_applications a WHERE a.relay_database_namespace=?7 AND a.delivery_id=e.delivery_id)";
    let any: bool = conn
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 {tail})"),
            params![
                b.workspace_id,
                b.main_version_id,
                b.object_id,
                b.lineage_claim_id,
                b.restore_fence_generation,
                b.current_path,
                held.namespace
            ],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    let seed: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 {tail} AND e.pending=1 AND json_extract(e.native_source_json,'$.origin.kind')='adoptionSeed')"),params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.restore_fence_generation,b.current_path,held.namespace],|row|row.get(0)).map_err(read_sql)?;
    let gap = head - previous_sequence;
    let mut query = conn.prepare(&format!("SELECT e.append_key,e.update_digest,length(CAST(e.native_source_json AS BLOB)),e.native_source_json,e.pending {tail} AND (json_extract(e.native_source_json,'$.nativeSequence')>?8 OR (json_extract(e.native_source_json,'$.nativeSequence')=?8 AND json_extract(e.native_source_json,'$.origin.kind')='adoptionSeed')) ORDER BY e.outbox_id,e.sequence LIMIT ?9")).map_err(read_sql)?;
    let mut rows = query
        .query(params![
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id,
            b.restore_fence_generation,
            b.current_path,
            held.namespace,
            previous_sequence,
            gap + 2
        ])
        .map_err(read_sql)?;
    let mut sequences = Vec::new();
    let mut terminal = false;
    while let Some(row) = rows.next().map_err(read_sql)? {
        let length: i64 = row.get(2).map_err(read_sql)?;
        if !(1..=MAX_NATIVE_SOURCE_BYTES).contains(&length) {
            return Err(ApplicationError::Corrupt);
        }
        let append_key: String = row.get(0).map_err(read_sql)?;
        let digest: String = row.get(1).map_err(read_sql)?;
        let json: String = row.get(3).map_err(read_sql)?;
        let pending: bool = row.get(4).map_err(read_sql)?;
        let source: crate::owner_outbox::OwnerOutboxNativeSource =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        source
            .validate(&append_key)
            .map_err(|_| ApplicationError::Corrupt)?;
        source
            .verify_retained_row(conn)
            .map_err(|_| ApplicationError::Corrupt)?;
        if source.binding != *b
            || source.adoption_id != adoption
            || source.update_digest != digest
            || source.native_sequence > head
        {
            return Err(ApplicationError::Corrupt);
        }
        let adoption_seed = matches!(
            source.origin,
            crate::owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed
        );
        terminal |= !pending
            && (source.native_sequence > previous_sequence
                || adoption_seed && previous_sequence == source.native_sequence);
        if source.native_sequence > previous_sequence {
            if sequences.len() as i64 >= gap {
                return Err(ApplicationError::Corrupt);
            }
            sequences.push(source.native_sequence);
        }
    }
    Ok(PrivateTail {
        sequences,
        any,
        seed,
        terminal,
    })
}

pub(super) fn validate_historical_binding(
    historical: &LiveObjectBinding,
    current: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    historical.validate_canonical().map_err(invalid)?;
    if historical.workspace_id != current.workspace_id
        || historical.main_version_id != current.main_version_id
        || historical.object_id != current.object_id
        || historical.lineage_claim_id != current.lineage_claim_id
        || historical.current_path != current.current_path
        || historical.restore_fence_generation != current.restore_fence_generation
        || !historical.selector_paths.iter().any(|selector| {
            historical.current_path == *selector
                || historical
                    .current_path
                    .strip_prefix(selector)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}

pub(super) fn latest_receipt(
    conn: &Connection,
    registration: &Registration,
) -> Result<Option<LiveUpdateReceipt>, ApplicationError> {
    latest_receipt_with(conn, registration, None)
}

/// The same receipt, with each raw text read charged to a publication proof's budget.
pub(super) fn latest_receipt_in(
    conn: &Connection,
    registration: &Registration,
    budget: &mut restore_content::Budget,
) -> Result<Option<LiveUpdateReceipt>, ApplicationError> {
    latest_receipt_with(conn, registration, Some(budget))
}

fn latest_receipt_with(
    conn: &Connection,
    registration: &Registration,
    mut budget: Option<&mut restore_content::Budget>,
) -> Result<Option<LiveUpdateReceipt>, ApplicationError> {
    let b = &registration.binding;
    if let Some(budget) = budget.as_deref_mut() {
        let length: i64 = conn.query_row("SELECT coalesce((SELECT length(CAST(delivery_id AS BLOB))+length(CAST(update_digest AS BLOB)) FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 ORDER BY journal_cursor DESC LIMIT 1),0)",
            params![registration.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|row| row.get(0)).map_err(read_sql)?;
        budget.charge(usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?)?;
    }
    let applied: Option<LiveUpdateReceipt> = conn.query_row("SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 ORDER BY journal_cursor DESC LIMIT 1",
        params![registration.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
        |row| Ok(LiveUpdateReceipt { delivery_id:row.get(0)?,update_digest:row.get(1)?,journal_cursor:row.get(2)?,accepting_host_epoch:row.get(3)? })).optional().map_err(read_sql)?;
    let adopted =
        adoption::read_origin_with(conn, registration, budget)?.and_then(|origin| origin.terminal);
    match (applied, adopted) {
        (Some(applied), Some(adopted)) if applied.journal_cursor <= adopted.journal_cursor => {
            Ok(Some(adopted))
        }
        (Some(applied), _) => Ok(Some(applied)),
        (None, adopted) => Ok(adopted),
    }
}

fn read_interval(
    conn: &Connection,
    registration: &Registration,
    previous: i64,
    terminal: i64,
    max: usize,
) -> Result<Vec<ReceiptIdentity>, ApplicationError> {
    let b = &registration.binding;
    let mut query=conn.prepare("SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch,local_ydoc_sequence,current_path,selector_paths_json,restore_fence_generation FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND journal_cursor>?6 AND journal_cursor<=?7 ORDER BY journal_cursor LIMIT ?8").map_err(read_sql)?;
    let mut rows = query
        .query(params![
            registration.namespace,
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id,
            previous,
            terminal,
            max as i64 + 1
        ])
        .map_err(read_sql)?;
    let mut receipts = Vec::new();
    while let Some(row) = rows.next().map_err(read_sql)? {
        if receipts.len() == max {
            return Err(invalid("settlement application limit exceeded"));
        }
        let path: String = row.get(5).map_err(read_sql)?;
        let selectors: String = row.get(6).map_err(read_sql)?;
        let selectors: Vec<String> =
            serde_json::from_str(&selectors).map_err(|_| ApplicationError::Corrupt)?;
        let generation: i64 = row.get(7).map_err(read_sql)?;
        let historical = LiveObjectBinding {
            current_path: path,
            selector_paths: selectors,
            restore_fence_generation: generation,
            ..b.clone()
        };
        validate_historical_binding(&historical, b)?;
        let binding_digest =
            hex_sha256(&serde_json::to_vec(&historical).map_err(|_| ApplicationError::Corrupt)?);
        receipts.push((
            row.get(0).map_err(read_sql)?,
            row.get(1).map_err(read_sql)?,
            row.get(2).map_err(read_sql)?,
            row.get(3).map_err(read_sql)?,
            row.get(4).map_err(read_sql)?,
            binding_digest,
        ));
    }
    Ok(receipts)
}

#[cfg(test)]
mod publication_state_tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    fn fixture() -> (ScratchDir, EngineStore, LiveSettlementAudit) {
        let dir = ScratchDir::new_named("live-settlement-publication-state").unwrap();
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let digest = hex_sha256(b"projection");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO live_device_settlements VALUES \
                 ('settlement','relay','workspace','main','object','lineage', \
                  0,1,0,1,1,?1,'moment',?1,?1,'{}','{}',0,'ordinary',NULL)",
                    [&digest],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let audit = LiveSettlementAudit {
            namespace: "relay".into(),
            binding: LiveObjectBinding {
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: "object".into(),
                lineage_claim_id: "lineage".into(),
                current_path: "notes/a.md".into(),
                selector_paths: vec!["notes/a.md".into()],
                restore_fence_generation: 0,
            },
            coordinate: ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            previous_cursor: 0,
            terminal_cursor: 1,
            previous_sequence: 0,
            sequence: 1,
            observed_head: 1,
            accepted: None,
            terminal_source: false,
            receipts: Vec::new(),
            interval_digest: digest.clone(),
            bootstrap_moment: "moment".into(),
            bootstrap_digest: digest,
            first: false,
            restore: None,
            replay_anchor: None,
            empty: false,
        };
        (dir, store, audit)
    }

    #[test]
    fn publication_state_is_immutable_and_replay_reads_the_prior_capture() {
        let (_dir, mut store, mut audit) = fixture();
        let state = crate::Ydoc::wire().encode_full_state();
        store
            .write_with(&NoFaults, |tx| {
                assert_eq!(
                    audit.prepare_publication_state_in_tx(tx)?,
                    LiveSettlementPublicationState::Unavailable
                );
                audit.terminal_cursor = 2;
                assert_eq!(
                    audit.prepare_publication_state_in_tx(tx)?,
                    LiveSettlementPublicationState::New
                );
                audit.terminal_cursor = 1;
                audit.record_publication_state_in_tx(tx, "settlement", &state)?;
                audit.record_publication_state_in_tx(tx, "settlement", &state)?;
                assert!(matches!(
                    audit.record_publication_state_in_tx(tx, "settlement", b"private tail"),
                    Err(StorageError::StateCorrupt { .. })
                ));
                Ok::<_, StorageError>(())
            })
            .unwrap();
        audit.observed_head = 2;
        store
            .write_with(&NoFaults, |tx| {
                assert_eq!(
                    audit.prepare_publication_state_in_tx(tx)?,
                    LiveSettlementPublicationState::Retained(state.clone())
                );
                audit.binding.workspace_id = "another-workspace".into();
                assert!(matches!(
                    audit.record_publication_state_in_tx(tx, "settlement", &state),
                    Err(StorageError::StateCorrupt { .. })
                ));
                Ok::<_, StorageError>(())
            })
            .unwrap();
    }

    #[test]
    fn publication_state_and_blob_roll_back_with_the_transaction() {
        let (_dir, mut store, audit) = fixture();
        let state = crate::Ydoc::wire().encode_full_state();
        let digest = hex_sha256(&state);
        let result = store.write_with(&NoFaults, |tx| {
            audit.record_publication_state_in_tx(tx, "settlement", &state)?;
            Err::<(), StorageError>(StorageError::StateCorrupt { source: None })
        });
        assert!(result.is_err());
        store
            .read_with(|conn| {
                let count: i64 = conn
                    .query_row(
                        "SELECT count(*) FROM live_settlement_publication_states",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::persist_public)?;
                assert_eq!(count, 0);
                assert!(get_binary_blob(conn, &digest)?.is_none());
                Ok::<_, StorageError>(())
            })
            .unwrap();
    }
}
