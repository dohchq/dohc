use super::*;
use std::collections::BTreeSet;

/// Immutable projection coverage. Filesystem status belongs to its materialization job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSettlementResult {
    /// Absent when nothing was accepted since the owner's handover or the
    /// first baseline: such a settlement is not published, and only its
    /// projection is kept locally.
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
    application_count: usize,
    interval_digest: String,
    bootstrap_moment: String,
    bootstrap_digest: String,
    first: bool,
    /// No settlement is stored and the relay accepted nothing since the
    /// owner's handover or the first baseline.
    empty: bool,
}

fn is_ydoc_settlement_moment_id(moment_id: &str) -> bool {
    moment_id
        .strip_prefix("moment-ydoc-apply-")
        .or_else(|| moment_id.strip_prefix("moment-ydoc-"))
        .is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

pub fn moment_renames_from_in(
    conn: &Connection,
    key: &DocKey,
    head_path: &str,
    target_path: &str,
    digest: &str,
    head_moment: &str,
    target_moment: &str,
) -> Result<bool, StorageError> {
    if head_moment == target_moment {
        return Ok(head_path == target_path);
    }
    let mut step = conn
        .prepare(concat!(
            "SELECT moment_order,before_latest_moment_id,COALESCE(before_path,payload_before_path) \
             FROM moments WHERE workspace_id=?1 AND moment_id=?2 AND version_id=?3 AND object_id=?4 \
             AND COALESCE(sync_record_only,0)=0 AND ",
            dohc_engine_domain::exclude_capture_recovery_sql!(),
            " AND operation='rename' AND path=?5 AND COALESCE(payload_after_path,path)=?5 \
             AND before_present=2 AND before_content_kind='text' AND after_content_kind='text' \
             AND before_blob_sha256=?6 AND after_blob_sha256=?6 \
             AND before_latest_moment_id IS NOT NULL \
             AND COALESCE(before_path,payload_before_path) IS NOT NULL"
        ))
        .map_err(StorageError::persist_public)?;
    let mut current_moment = head_moment.to_owned();
    let mut current_path = head_path.to_owned();
    let mut prev_order: Option<i64> = None;
    loop {
        let next: Option<(i64, String, String)> = step
            .query_row(
                params![
                    key.workspace_id,
                    current_moment,
                    key.version_id,
                    key.object_id,
                    current_path,
                    digest,
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(StorageError::persist_public)?;
        let Some((order, before_moment, before_path)) = next else {
            return Ok(false);
        };
        if prev_order.is_some_and(|prev| order >= prev) {
            return Ok(false);
        }
        if before_moment == target_moment {
            if before_path != target_path {
                return Ok(false);
            }
            let target_matches: bool = conn
                .query_row(
                    concat!(
                        "SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2 \
                         AND version_id=?3 AND object_id=?4 AND COALESCE(sync_record_only,0)=0 AND ",
                        dohc_engine_domain::exclude_capture_recovery_sql!(),
                        " AND operation<>'delete' AND path=?5 AND COALESCE(payload_after_path,path)=?5 \
                         AND after_content_kind='text' AND after_blob_sha256=?6 AND moment_order<?7)"
                    ),
                    params![
                        key.workspace_id,
                        target_moment,
                        key.version_id,
                        key.object_id,
                        target_path,
                        digest,
                        order,
                    ],
                    |row| row.get(0),
                )
                .map_err(StorageError::persist_public)?;
            return Ok(target_matches);
        }
        if before_path == target_path
            && is_ydoc_settlement_moment_id(&before_moment)
            && is_ydoc_settlement_moment_id(target_moment)
        {
            let prior: Option<(String, String, String, String, String, Option<String>)> = conn
                .query_row(
                    concat!(
                        "SELECT moment_id,operation,path,COALESCE(payload_after_path,path),\
                         after_content_kind,after_blob_sha256 FROM moments \
                         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                           AND COALESCE(sync_record_only,0)=0 AND ",
                        dohc_engine_domain::exclude_capture_recovery_sql!(),
                        " AND moment_order<?4 ORDER BY moment_order DESC LIMIT 1"
                    ),
                    params![key.workspace_id, key.version_id, key.object_id, order],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(StorageError::persist_public)?;
            if prior.is_some_and(
                |(prior_id, op, prior_path, prior_after_path, kind, prior_digest)| {
                    prior_id == target_moment
                        && op != "delete"
                        && prior_path == target_path
                        && prior_after_path == target_path
                        && kind == "text"
                        && prior_digest.as_deref() == Some(digest)
                },
            ) {
                return Ok(true);
            }
        }
        prev_order = Some(order);
        current_moment = before_moment;
        current_path = before_path;
    }
}

const MAX_RENAME_CHAIN_STEPS: usize = 1024;

fn audit_error(error: ApplicationError) -> ApplicationError {
    match error {
        ApplicationError::Storage(_)
        | ApplicationError::Collab(
            CollabError::MarkdownReaderPending(_)
            | CollabError::MarkdownReaderUnavailable
            | CollabError::MarkdownReaderRetryable
            | CollabError::MarkdownReaderCapacity,
        ) => error,
        _ => StorageError::StateCorrupt { source: None }.into(),
    }
}

impl LiveSettlementAudit {
    pub fn markdown_retry_inputs(&self) -> serde_json::Value {
        serde_json::to_value(crate::markdown_write_obligations::AuditedRetry {
            namespace: self.namespace.clone(),
            binding: self.binding.clone(),
            terminal_cursor: self.terminal_cursor,
            head_update_seq: self.observed_head,
        })
        .expect("audited retry inputs are serializable")
    }

    pub fn markdown_operation_id(&self) -> String {
        crate::markdown_write_obligations::AuditedRetry {
            namespace: self.namespace.clone(),
            binding: self.binding.clone(),
            terminal_cursor: self.terminal_cursor,
            head_update_seq: self.observed_head,
        }
        .operation_id()
    }

    /// A compensated filesystem marker can be restored only for this retained
    /// projection: the lineage's latest recorded settlement, or else its
    /// latest empty one.
    pub fn covers_projection_in(
        &self,
        conn: &Connection,
        moment: &str,
        markdown: &str,
    ) -> Result<bool, ApplicationError> {
        self.saved_projection_in(conn, moment, markdown, true)
    }
    fn saved_projection_in(
        &self,
        conn: &Connection,
        moment: &str,
        markdown: &str,
        empty: bool,
    ) -> Result<bool, ApplicationError> {
        let b = &self.binding;
        let registration = Registration {
            workspace_id: b.workspace_id.clone(),
            namespace: self.namespace.clone(),
            coordinate: self.coordinate.clone(),
            binding: b.clone(),
            activation_id: None,
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
        type SavedProjection = (String, String, i64, String, i64, String, Option<String>);
        let saved: Option<SavedProjection> = conn
            .query_row(
                "SELECT moment_id,markdown_digest,local_ydoc_sequence,binding_json,terminal_cursor,settlement_kind,restore_operation_id FROM (SELECT moment_id,markdown_digest,local_ydoc_sequence,binding_json,terminal_cursor,settlement_kind,restore_operation_id FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 UNION ALL SELECT moment_id,markdown_digest,local_ydoc_sequence,binding_json,-1,'ordinary',NULL FROM live_empty_settlements WHERE ?6 AND relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5) ORDER BY terminal_cursor DESC LIMIT 1",
                params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,empty],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
            )
            .optional()
            .map_err(StorageError::persist_public)?;
        let Some((
            saved_moment,
            saved_markdown,
            sequence,
            binding,
            saved_terminal,
            saved_kind,
            saved_restore_op,
        )) = saved
        else {
            return Ok(false);
        };
        let binding: LiveObjectBinding =
            serde_json::from_str(&binding).map_err(StorageError::persist_public)?;
        same_lineage_generation(&binding, b).map_err(audit_error)?;
        if saved_markdown != markdown || sequence > self.sequence {
            return Ok(false);
        }
        if saved_moment == moment {
            return Ok(binding.current_path == b.current_path);
        }
        if !empty
            && saved_terminal == self.terminal_cursor
            && saved_kind == "ordinary"
            && saved_restore_op.is_none()
            && (binding == *b || binding.current_path != b.current_path)
        {
            let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)
                .map_err(|_| StorageError::StateCorrupt { source: None })?;
            return moment_renames_from_in(
                conn,
                &key,
                &b.current_path,
                &binding.current_path,
                markdown,
                moment,
                &saved_moment,
            )
            .map_err(ApplicationError::Storage);
        }
        Ok(false)
    }
    /// An unchanged projection may name the current head moment only when that
    /// moment is already this document's latest audited settlement. Any other
    /// head, such as a pre-live imported projection, would publish its own
    /// historical before-image. An empty settlement publishes nothing, so any
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
        self.saved_projection_in(conn, moment, markdown, false)
    }
    pub fn binding(&self) -> &LiveObjectBinding {
        &self.binding
    }
    /// The settlement covers no accepted edit. It still projects the file,
    /// but it is not published: the relay accepts only a settlement whose
    /// interval holds an accepted edit. Only its projection is kept locally.
    pub fn is_empty(&self) -> bool {
        self.empty
    }
    /// The accepted document this settlement projects instead of the native
    /// head. Present while the native head holds an update this owner answers
    /// for and has not applied: its own pending, refused, or acknowledged
    /// edits, and what its released chain left it. The moment, file, and
    /// published record then hold accepted content alone, and the native
    /// settled boundary does not advance.
    pub fn accepted_prefix(&self) -> Option<&crate::Ydoc> {
        self.accepted.as_ref()
    }
    pub fn expected_head(&self) -> &str {
        &self.bootstrap_digest
    }
    pub fn stored_settlement(
        &self,
        store: &EngineStore,
        moment: &str,
        markdown: &str,
    ) -> Result<(String, String), StorageError> {
        let b = &self.binding;
        let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)
            .map_err(|_| StorageError::StateCorrupt { source: None })?;
        store.read_with(|conn| {
            let (id, saved_moment, saved_binding_json): (String, String, String) = conn
                .query_row(
                    "SELECT settlement_id,moment_id,binding_json FROM live_device_settlements \
                     WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 \
                       AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6 \
                       AND markdown_digest=?7 AND restore_operation_id IS NULL \
                       AND settlement_kind='ordinary'",
                    params![
                        self.namespace,
                        b.workspace_id,
                        b.main_version_id,
                        b.object_id,
                        b.lineage_claim_id,
                        self.terminal_cursor,
                        markdown,
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(StorageError::persist_public)?;
            let saved_binding: LiveObjectBinding =
                serde_json::from_str(&saved_binding_json).map_err(StorageError::persist_public)?;
            same_lineage_generation(&saved_binding, b)
                .map_err(|_| StorageError::StateCorrupt { source: None })?;
            if saved_binding.current_path == b.current_path && saved_binding != *b {
                return Err(StorageError::StateCorrupt { source: None });
            }
            if (saved_moment != moment || saved_binding.current_path != b.current_path)
                && !moment_renames_from_in(
                    conn,
                    &key,
                    &b.current_path,
                    &saved_binding.current_path,
                    markdown,
                    moment,
                    &saved_moment,
                )?
            {
                return Err(StorageError::StateCorrupt { source: None });
            }
            Ok((id, saved_moment))
        })
    }
    /// An empty settlement publishes nothing, but its lineage keeps the
    /// projection it committed, so a conflicted file write can be restored.
    pub fn record_empty_in_tx(
        &self,
        tx: &Transaction<'_>,
        moment: &str,
        markdown: &str,
    ) -> Result<(), ApplicationError> {
        if !self.empty {
            return Err(StorageError::StateCorrupt { source: None }.into());
        }
        let b = &self.binding;
        let binding = serde_json::to_string(b).map_err(StorageError::persist_public)?;
        tx.execute("INSERT OR REPLACE INTO live_empty_settlements(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,moment_id,markdown_digest,local_ydoc_sequence,binding_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,moment,markdown,self.sequence,binding]).map_err(StorageError::persist_public)?;
        Ok(())
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
        {
            let corrupt = || ApplicationError::Storage(StorageError::StateCorrupt { source: None });
            let b = &self.binding;
            let registration = Registration {
                workspace_id: b.workspace_id.clone(),
                namespace: self.namespace.clone(),
                coordinate: self.coordinate.clone(),
                binding: b.clone(),
                activation_id: None,
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
            let mut interval = IntervalDigest::default();
            visit_interval(
                tx,
                &registration,
                self.previous_cursor,
                self.terminal_cursor,
                Some(self.application_count),
                |receipt| interval.push(&receipt),
            )
            .map_err(audit_error)?;
            if interval.finish() != (self.application_count, self.interval_digest.clone()) {
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
        let settlement_id_for = |recorded_binding: &LiveObjectBinding,
                                 recorded_moment: &str|
         -> Result<String, ApplicationError> {
            let identities = serde_json::to_vec(&(
                &self.namespace,
                recorded_binding,
                self.previous_cursor,
                self.terminal_cursor,
                self.previous_sequence,
                self.sequence,
                &self.interval_digest,
                recorded_moment,
                markdown,
                vector,
            ))
            .map_err(StorageError::persist_public)?;
            Ok(format!("live-settlement-{}", hex_sha256(&identities)))
        };
        type ExistingSettlement = (String, String, String, String, i64, i64, String);
        let existing: Option<ExistingSettlement> = tx.query_row(
            "SELECT settlement_id,moment_id,markdown_digest,interval_digest,application_count,local_ydoc_sequence,binding_json FROM live_device_settlements WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND terminal_cursor=?6 AND restore_operation_id IS NULL AND settlement_kind='ordinary' AND source_state_vector_digest=?7",
            params![self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.terminal_cursor,vector],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional().map_err(StorageError::persist_public)?;
        if let Some((
            saved,
            saved_moment,
            saved_markdown,
            saved_interval,
            count,
            sequence,
            saved_binding_json,
        )) = existing
        {
            let saved_binding: LiveObjectBinding =
                serde_json::from_str(&saved_binding_json).map_err(StorageError::persist_public)?;
            same_lineage_generation(&saved_binding, b).map_err(audit_error)?;
            if saved_binding.current_path == b.current_path && saved_binding != *b {
                return Err(corrupt());
            }
            let same_moment = (saved_binding.current_path == b.current_path
                && saved_moment == moment)
                || (saved_markdown == markdown && {
                    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)
                        .map_err(|_| corrupt())?;
                    moment_renames_from_in(
                        tx,
                        &key,
                        &b.current_path,
                        &saved_binding.current_path,
                        markdown,
                        moment,
                        &saved_moment,
                    )?
                });
            let expected_id = settlement_id_for(&saved_binding, &saved_moment)?;
            if !same_moment
                || saved != expected_id
                || saved_markdown != markdown
                || saved_interval != self.interval_digest
                || count != self.application_count as i64
                || sequence != self.sequence
            {
                return Err(corrupt());
            }
            return Ok(saved);
        }
        let id = settlement_id_for(b, moment)?;
        // Stored settlements may start where they end. A new one must not.
        if self.previous_cursor >= self.terminal_cursor {
            return Err(invalid("a new settlement must cover an accepted edit"));
        }
        tx.execute("INSERT INTO live_device_settlements VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,'ordinary',NULL)",
            params![id,self.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,self.previous_cursor,self.terminal_cursor,self.previous_sequence,self.sequence,self.application_count as i64,self.interval_digest,moment,markdown,vector,
                serde_json::to_string(b).map_err(StorageError::persist_public)?,serde_json::to_string(&self.coordinate).map_err(StorageError::persist_public)?,now_ms]).map_err(StorageError::persist_public)?;
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
            previous_cursor: self.previous_cursor,
            terminal_cursor: self.terminal_cursor,
            application_count: self.application_count,
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
    let held = handle
        .registration
        .lock()
        .map_err(|_| E::from(ApplicationError::Interrupted))?;
    if !held.live {
        return Err(E::from(ApplicationError::Interrupted));
    }
    settle_held(
        store,
        &held,
        terminal,
        max_applications,
        reconstruction,
        settle,
    )
}

/// The retirement form of [`with_settlement`]: settle the activation a
/// retirement names through its own durable binding, with no live
/// registration. Its terminal is its latest application through F, and the
/// deliveries the relay accepted from it after that terminal, which it never
/// applied, wait like its private edits.
#[allow(clippy::too_many_arguments)]
pub fn with_retirement_settlement<E, T>(
    store: &mut EngineStore,
    scope: &super::RetirementScope<'_>,
    key: &super::RetirementKey,
    host: &ApplicationHostCoordinate,
    terminal: Option<LiveUpdateReceipt>,
    max_applications: usize,
    reconstruction: NativeHistoryReconstruction,
    settle: impl FnOnce(&mut EngineStore, &LiveSettlementAudit) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<ApplicationError> + From<StorageError>,
{
    let held = store
        .read_with(|conn| super::retirement::retiring_registration(conn, scope, key, host))
        .map_err(E::from)?;
    if terminal
        .as_ref()
        .is_some_and(|receipt| receipt.journal_cursor > key.accepted_through)
    {
        return Err(E::from(ApplicationError::Conflict));
    }
    settle_held(
        store,
        &held,
        terminal,
        max_applications,
        reconstruction,
        settle,
    )
}

fn settle_held<E, T>(
    store: &mut EngineStore,
    held: &Registration,
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
    let audit = store.read_with(|conn| -> Result<LiveSettlementAudit, ApplicationError> {
        require_workspace(conn, held)?;
        if !read_binding(conn,held)?.is_some_and(|(binding,coordinate,available)| available && binding == held.binding && coordinate == held.coordinate) { return Err(ApplicationError::Interrupted); }
        let b = &held.binding;
        validate_historical_binding(b,b)?;
        let key = DocKey::new(&b.workspace_id,&b.main_version_id,&b.object_id)?;
        restore_fence::require_open(conn,&key)?;
        let marker = durable::read_marker_in(conn,&key)?.ok_or(ApplicationError::Corrupt)?;
        if marker.regime != Regime::Replicated || marker.lineage_claim_status != durable::LineageClaimStatus::Exact || marker.content_kind != crate::ContentKind::Richdoc || marker.lineage_claim_id.as_deref()!=Some(b.lineage_claim_id.as_str()) || marker.path.as_deref()!=Some(b.current_path.as_str()) { return Err(ApplicationError::Conflict); }
        let owner_origin = adoption::read_origin(conn,held)?;
        let (original_binding,origin_moment,origin_digest,origin_cursor,origin_sequence) = if let Some(origin) = &owner_origin {
            (origin.binding.clone(),origin.source_moment.clone(),origin.source_digest.clone(),origin.terminal.as_ref().map_or(0,|r|r.journal_cursor),origin.sequence)
        } else {
            let (bootstrap,original_binding,_,_) = bootstrap::read_bootstrap(conn,held)?.ok_or(ApplicationError::Corrupt)?;
            let written = bootstrap::written_markdown_digest(conn,held)?;
            (original_binding,bootstrap.bootstrap_moment_id,written,0,0)
        };
        validate_historical_binding(&original_binding,b)?;
        let latest = latest_receipt(conn,held)?;
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
            Some((start,end,start_sequence,end_sequence,_)) if end == terminal_cursor => (start,start_sequence,Some(end_sequence)),
            Some((_,end,_,end_sequence,refused_start)) if end < terminal_cursor => {
                let cursor = if let Some(start) = refused_start { verified_previous_cursor(conn,held,start,origin_cursor)? } else {end};
                // A successor's adoption verified its captured head, which
                // holds the rows ordinary sync added after its predecessor's
                // last settlement. Its first settlement covers from there.
                // Every row through that head is in accepted(B) or the seed,
                // and an abandoned seed allows no later application, so it
                // never moves the terminal past B into this branch.
                let floor = owner_origin.as_ref().filter(|origin| origin.successor).map_or(end_sequence,|origin| end_sequence.max(origin.sequence));
                (cursor,floor,None)
            },
            Some(_) => return Err(ApplicationError::Corrupt),
            None => (origin_cursor,origin_sequence,None),
        };
        if replayed.is_some_and(|sequence| sequence < previous_sequence || sequence > head) { return Err(ApplicationError::Corrupt); }
        // A catch-up after refused settlements covers every application since
        // the first refusal, however many. Reading them one at a time keeps
        // its memory to one bit per native sequence.
        let mut sequences = Sequences::new(previous_sequence, head);
        let mut interval = IntervalDigest::default();
        visit_interval(conn,held,previous_cursor,terminal_cursor,None,|receipt| {
            let (delivery,hash,cursor,epoch,sequence,_) = &receipt;
            LiveUpdateReceipt { delivery_id:delivery.clone(),update_digest:hash.clone(),journal_cursor:*cursor,accepting_host_epoch:*epoch }.validate()?;
            integer(*sequence,1,head)?;
            sequences.insert(*sequence);
            interval.push(&receipt)
        })?;
        if head < previous_sequence { return Err(invalid("settlement application coverage is incomplete")); }
        // Every native sequence since the last settlement is an accepted
        // application or an update this owner answers for and has not
        // applied. Its later application counts by journal cursor.
        let tail = private_tail(conn,held,previous_sequence,head,terminal_cursor)?;
        sequences.extend(tail.sequences.iter().copied());
        sequences.extend(tail.accepted_sequences.iter().copied());
        // A private boundary can retain accepted receipts across several intervals.
        // Bound distinct native sequences by the uncovered native gap.
        if (sequences.len() as i64) < head-previous_sequence {
            let mut query = conn.prepare("SELECT DISTINCT local_ydoc_sequence FROM live_device_update_applications WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5 AND journal_cursor<=?6 AND local_ydoc_sequence>?7 ORDER BY journal_cursor DESC LIMIT ?8").map_err(read_sql)?;
            let mut rows = query.query(params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,previous_cursor,previous_sequence,head-previous_sequence]).map_err(read_sql)?;
            while let Some(row) = rows.next().map_err(read_sql)? {
                let sequence: i64 = row.get(0).map_err(read_sql)?;
                integer(sequence,1,head)?;
                if sequence>previous_sequence { sequences.insert(sequence); }
                if sequences.len() as i64 == head-previous_sequence { break; }
            }
        }
        if sequences.len() as i64 != head-previous_sequence { return Err(invalid("settlement application coverage is incomplete")); }
        let covered_sequence = tail.sequences.iter().min().map_or(head, |sequence| sequence - 1);
        let accepted = if tail.any {
            // A pending seed refuses settlement. Once acknowledged, the seed
            // stays private like any edit until it applies, and the file
            // holds accepted state without it.
            if tail.seed { return Err(invalid("the owner's adoption seed must be accepted before a settlement")); }
            // A settlement still answers a missing dependency as a conflict.
            Some(accepted_history::read_state(conn,held,terminal_cursor,reconstruction).map_err(|error| match error {
                ApplicationError::AcceptedStateIncomplete => ApplicationError::Conflict,
                error => error,
            })?)
        } else {
            None
        };
        let (application_count,interval_digest) = interval.finish();
        let last_settled: Option<String> = conn.query_row("SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id],|row|row.get(0)).map_err(read_sql)?;
        // With nothing stored, the next settlement again starts at the origin.
        let empty = previous.is_none() && previous_cursor == terminal_cursor;
        Ok(LiveSettlementAudit { namespace:held.namespace.clone(),binding:b.clone(),coordinate:held.coordinate.clone(),previous_cursor,terminal_cursor,previous_sequence,sequence:replayed.unwrap_or(covered_sequence),observed_head:head,accepted,terminal_source:replayed.is_none() && tail.terminal,application_count,interval_digest,
            bootstrap_moment:origin_moment,bootstrap_digest:origin_digest,first:owner_origin.is_none() && previous.is_none() && last_settled.is_none(),empty })
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
) -> Result<i64, ApplicationError> {
    let b = &held.binding;
    let mut cursor = start.max(origin);
    // Each step moves strictly back toward the origin, so the walk ends
    // however many refused settlements queued up before their refusals.
    while cursor > origin {
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
    }
    Ok(cursor)
}

type ReceiptIdentity = (String, String, i64, i64, i64, String);

/// A native source names one binding and its origin. A larger one is corrupt.
const MAX_NATIVE_SOURCE_BYTES: i64 = 262_144;

/// The native updates this owner answers for and has not applied, which a
/// settlement keeps out of what it projects: the current activation's own
/// adopted entries of the current outbox, pending, refused, or accepted, and
/// the Carried deliveries and refusals its released chain left it. A saved
/// receipt proves acceptance, never application.
#[derive(Default)]
pub(super) struct PrivateTail {
    /// Their distinct native sequences after `previous_sequence`, each entry
    /// verified on its own. A seed names its captured head, which another
    /// entry's update can hold too.
    pub(super) sequences: BTreeSet<i64>,
    accepted_sequences: BTreeSet<i64>,
    /// Whether any exists at all, before or after `previous_sequence`.
    pub(super) any: bool,
    /// Whether the adoption seed is among them.
    seed: bool,
    terminal: bool,
}

pub(super) fn private_tail(
    conn: &Connection,
    held: &Registration,
    previous_sequence: i64,
    head: i64,
    terminal_cursor: i64,
) -> Result<PrivateTail, ApplicationError> {
    let b = &held.binding;
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let Some((activation, _)) = owner_activations::current_activation(
        conn,
        Some(&held.namespace),
        &key,
        &b.lineage_claim_id,
    )?
    else {
        return Ok(PrivateTail::default());
    };
    let adoption = activation.activation_id;
    let chain = activation.predecessor_activation_id.as_deref();
    let tail = "FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4 AND o.restore_fence_generation=?5 AND o.current_path=?6 AND (e.pending=1 OR (e.pending=0 AND e.terminal_reason IS NOT NULL AND e.terminal_blob_digest=e.update_digest AND e.accepted_receipt_json IS NULL) OR (e.pending=0 AND e.terminal_reason IS NULL AND e.accepted_receipt_json IS NOT NULL AND json_extract(e.native_source_json,'$.adoptionId')=?9)) AND e.native_source_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM live_device_update_applications a WHERE a.relay_database_namespace=?7 AND a.delivery_id=e.delivery_id)";
    let bound = params![
        b.workspace_id,
        b.main_version_id,
        b.object_id,
        b.lineage_claim_id,
        b.restore_fence_generation,
        b.current_path,
        held.namespace,
        previous_sequence,
        adoption,
        terminal_cursor
    ];
    let mut any: bool = conn
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 {tail})"),
            &bound[..9],
            |row| row.get(0),
        )
        .map_err(read_sql)?;
    let seed: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 {tail} AND e.pending=1 AND json_extract(e.native_source_json,'$.origin.kind')='adoptionSeed')"),&bound[..9],|row|row.get(0)).map_err(read_sql)?;
    let mut sequences = BTreeSet::new();
    let mut accepted_sequences = BTreeSet::new();
    // Coverage counts native sequences, never entries. Seeds may share a
    // sequence with each other and one native update, never two updates.
    let mut updates = BTreeSet::new();
    let mut count = |source: &crate::owner_outbox::OwnerOutboxNativeSource, accepted: bool| {
        if !matches!(
            source.origin,
            crate::owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed
        ) && !updates.insert(source.native_sequence)
        {
            return Err(ApplicationError::Corrupt);
        }
        if source.native_sequence > previous_sequence {
            if accepted {
                accepted_sequences.insert(source.native_sequence);
            } else {
                sequences.insert(source.native_sequence);
            }
        }
        Ok(())
    };
    // Each validated by the shared resolution, and private until applied
    // even below the coverage floor.
    for inherited in super::retirement::inherited_entries(
        conn,
        &held.namespace,
        &key,
        &b.lineage_claim_id,
        chain,
    )? {
        if inherited.entry.source.native_sequence > head {
            return Err(ApplicationError::Corrupt);
        }
        if super::retirement::applied(
            conn,
            &held.namespace,
            &key,
            &b.lineage_claim_id,
            &inherited.receipt,
        )? {
            if inherited.receipt.journal_cursor <= terminal_cursor {
                count(&inherited.entry.source, true)?;
            }
            continue;
        }
        any = true;
        count(&inherited.entry.source, false)?;
    }
    // Compaction may move an applied delivery to a newer native append. Its
    // retained source still covers the original sequence, without hiding it.
    let accepted = "FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE o.workspace_id=?1 AND o.main_version_id=?2 AND o.object_id=?3 AND o.lineage_claim_id=?4 AND o.restore_fence_generation=?5 AND o.current_path=?6 AND e.native_source_json IS NOT NULL AND json_extract(e.native_source_json,'$.adoptionId')=?9 AND EXISTS(SELECT 1 FROM live_device_update_applications a WHERE a.relay_database_namespace=?7 AND a.delivery_id=e.delivery_id AND a.update_digest=e.update_digest AND a.workspace_id=o.workspace_id AND a.main_version_id=o.main_version_id AND a.object_id=o.object_id AND a.lineage_claim_id=o.lineage_claim_id AND a.journal_cursor<=?10)";
    let columns = "e.append_key,e.update_digest,length(CAST(e.native_source_json AS BLOB)),e.native_source_json,e.pending,e.accepted_receipt_json IS NOT NULL,e.outbox_id,e.sequence";
    let mut query = conn.prepare(&format!("SELECT {columns},0 {tail} AND (json_extract(e.native_source_json,'$.nativeSequence')>?8 OR (json_extract(e.native_source_json,'$.nativeSequence')=?8 AND json_extract(e.native_source_json,'$.origin.kind')='adoptionSeed')) UNION ALL SELECT {columns},1 {accepted} AND json_extract(e.native_source_json,'$.nativeSequence')>?8 ORDER BY 7,8")).map_err(read_sql)?;
    let mut rows = query.query(bound).map_err(read_sql)?;
    let mut terminal = false;
    while let Some(row) = rows.next().map_err(read_sql)? {
        let length: i64 = row.get(2).map_err(read_sql)?;
        if !(1..=MAX_NATIVE_SOURCE_BYTES).contains(&length) {
            return Err(ApplicationError::Corrupt);
        }
        let append_key: String = row.get(0).map_err(read_sql)?;
        let digest: String = row.get(1).map_err(read_sql)?;
        let json: String = row.get(3).map_err(read_sql)?;
        let accepted: bool = row.get(8).map_err(read_sql)?;
        // A refused entry is terminal; a pending or carried one still waits.
        let refused = !accepted
            && !row.get::<_, bool>(4).map_err(read_sql)?
            && !row.get::<_, bool>(5).map_err(read_sql)?;
        let source: crate::owner_outbox::OwnerOutboxNativeSource =
            serde_json::from_str(&json).map_err(|_| ApplicationError::Corrupt)?;
        source
            .validate(&append_key)
            .map_err(|_| ApplicationError::Corrupt)?;
        source
            .verify_retained_row(conn)
            .map_err(|_| ApplicationError::Corrupt)?;
        // Another activation's entry is private only as a refusal its
        // released chain left: its content never reaches accepted state.
        if source.binding != *b
            || source.update_digest != digest
            || source.native_sequence > head
            || source.adoption_id != adoption
                && !(refused
                    && super::retirement::chain_refusal(
                        conn,
                        &held.namespace,
                        &key,
                        &b.lineage_claim_id,
                        chain,
                        &row.get::<_, String>(6).map_err(read_sql)?,
                        row.get(7).map_err(read_sql)?,
                    )?)
        {
            return Err(ApplicationError::Corrupt);
        }
        let adoption_seed = matches!(
            source.origin,
            crate::owner_outbox::OwnerOutboxNativeOrigin::AdoptionSeed
        );
        // Only this adoption's own refusal leaves the settlement without
        // attribution; its chain's settlements already covered theirs.
        terminal |= refused
            && source.adoption_id == adoption
            && (source.native_sequence > previous_sequence
                || adoption_seed && previous_sequence == source.native_sequence);
        count(&source, accepted)?;
    }
    Ok(PrivateTail {
        sequences,
        accepted_sequences,
        any,
        seed,
        terminal,
    })
}

fn same_lineage_generation(
    historical: &LiveObjectBinding,
    current: &LiveObjectBinding,
) -> Result<(), ApplicationError> {
    validate_historical_binding(historical, historical)?;
    if historical.workspace_id != current.workspace_id
        || historical.main_version_id != current.main_version_id
        || historical.object_id != current.object_id
        || historical.lineage_claim_id != current.lineage_claim_id
        || historical.restore_fence_generation != current.restore_fence_generation
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
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
    budget: &mut budget::Budget,
) -> Result<Option<LiveUpdateReceipt>, ApplicationError> {
    latest_receipt_with(conn, registration, Some(budget))
}

fn latest_receipt_with(
    conn: &Connection,
    registration: &Registration,
    mut budget: Option<&mut budget::Budget>,
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

/// Passes each application in `(previous, terminal]` to `visit` in journal
/// order. More than `max` applications is an error.
fn visit_interval(
    conn: &Connection,
    registration: &Registration,
    previous: i64,
    terminal: i64,
    max: Option<usize>,
    mut visit: impl FnMut(ReceiptIdentity) -> Result<(), ApplicationError>,
) -> Result<(), ApplicationError> {
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
            max.map_or(-1, |max| max as i64 + 1)
        ])
        .map_err(read_sql)?;
    let mut count = 0;
    let mut proved_paths = std::collections::HashSet::new();
    while let Some(row) = rows.next().map_err(read_sql)? {
        if Some(count) == max {
            return Err(invalid("settlement application limit exceeded"));
        }
        count += 1;
        let path: String = row.get(5).map_err(read_sql)?;
        let selectors: String = row.get(6).map_err(read_sql)?;
        let selectors: Vec<String> =
            serde_json::from_str(&selectors).map_err(|_| ApplicationError::Corrupt)?;
        let historical = LiveObjectBinding {
            current_path: path,
            selector_paths: selectors,
            restore_fence_generation: row.get(7).map_err(read_sql)?,
            ..b.clone()
        };
        if historical.current_path == b.current_path {
            validate_historical_binding(&historical, b)?;
        } else {
            same_lineage_generation(&historical, b)?;
            if !proved_paths.contains(&historical.current_path) {
                let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
                let needed = std::collections::HashSet::from([historical.current_path.as_str()]);
                let proved = adoption::renamed_from(
                    conn,
                    &key,
                    &b.current_path,
                    &needed,
                    MAX_RENAME_CHAIN_STEPS,
                )?;
                if !proved.contains(&historical.current_path) {
                    return Err(ApplicationError::Conflict);
                }
                proved_paths.extend(proved);
            }
        }
        let binding_digest =
            hex_sha256(&serde_json::to_vec(&historical).map_err(|_| ApplicationError::Corrupt)?);
        visit((
            row.get(0).map_err(read_sql)?,
            row.get(1).map_err(read_sql)?,
            row.get(2).map_err(read_sql)?,
            row.get(3).map_err(read_sql)?,
            row.get(4).map_err(read_sql)?,
            binding_digest,
        ))?;
    }
    Ok(())
}

/// The digest of an interval's applications as one JSON list, hashed one
/// application at a time.
#[derive(Default)]
struct IntervalDigest {
    hash: sha2::Sha256,
    count: usize,
}

impl IntervalDigest {
    fn push(&mut self, receipt: &ReceiptIdentity) -> Result<(), ApplicationError> {
        use sha2::Digest;
        self.hash.update(if self.count == 0 { b"[" } else { b"," });
        self.hash
            .update(serde_json::to_vec(receipt).map_err(|_| ApplicationError::Corrupt)?);
        self.count += 1;
        Ok(())
    }

    fn finish(mut self) -> (usize, String) {
        use sha2::Digest;
        self.hash.update(if self.count == 0 {
            &b"[]"[..]
        } else {
            &b"]"[..]
        });
        (self.count, dohc_engine_storage::hex(&self.hash.finalize()))
    }
}

/// Distinct native sequences, one bit each for those in `(floor, head]`. The
/// bits grow only as far as the sequences seen, never past a word per
/// sequence plus a margin, so a corrupt head or sequence cannot force a huge
/// allocation; the rest go to `outside`.
struct Sequences {
    floor: i64,
    words: usize,
    bits: Vec<u64>,
    outside: BTreeSet<i64>,
    len: usize,
}

impl Sequences {
    fn new(floor: i64, head: i64) -> Self {
        let span = head
            .checked_sub(floor)
            .and_then(|span| usize::try_from(span).ok())
            .unwrap_or(0);
        Self {
            floor,
            words: span.div_ceil(64),
            bits: Vec::new(),
            outside: BTreeSet::new(),
            len: 0,
        }
    }

    /// Ignores sequences at or below the floor.
    fn insert(&mut self, sequence: i64) {
        if sequence <= self.floor {
            return;
        }
        let fresh = match usize::try_from(sequence.abs_diff(self.floor) - 1) {
            Ok(index) if index / 64 < self.words && index / 64 <= self.len + 1024 => {
                if self.bits.len() <= index / 64 {
                    self.bits.resize(index / 64 + 1, 0);
                }
                let word = &mut self.bits[index / 64];
                let bit = 1 << (index % 64);
                // A sequence first seen before the bits reached it is in
                // `outside`.
                let fresh = *word & bit == 0 && !self.outside.contains(&sequence);
                *word |= bit;
                fresh
            }
            _ => self.outside.insert(sequence),
        };
        if fresh {
            self.len += 1;
        }
    }

    fn len(&self) -> usize {
        self.len
    }
}

impl Extend<i64> for Sequences {
    fn extend<I: IntoIterator<Item = i64>>(&mut self, sequences: I) {
        for sequence in sequences {
            self.insert(sequence);
        }
    }
}

#[cfg(test)]
mod publication_state_tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    fn fixture() -> (ScratchDir, EngineStore, LiveSettlementAudit) {
        let dir = ScratchDir::new_named("live-settlement-publication-state").unwrap();
        let mut store = dohc_engine_testkit::open_empty_store(&dir.join("engine.db"), 0);
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
            application_count: 0,
            interval_digest: digest.clone(),
            bootstrap_moment: "moment".into(),
            bootstrap_digest: digest,
            first: false,
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

    #[test]
    fn sequences_count_each_distinct_sequence_once() {
        let mut sequences = Sequences::new(10, i64::MAX);
        sequences.extend([5, 10, 11, 11, 75, 1_000_000, 1_000_000, i64::MAX]);
        assert_eq!(sequences.len(), 4);
        assert!(sequences.bits.len() <= 1026);
        let mut sequences = Sequences::new(0, 200_000);
        sequences.extend([150_000, 1, 150_000]);
        sequences.extend(2..=200_000);
        assert_eq!(sequences.len(), 200_000);
        let mut sequences = Sequences::new(i64::MIN, i64::MAX);
        sequences.extend([i64::MIN, i64::MIN + 1, 0, i64::MAX, 0]);
        assert_eq!(sequences.len(), 3);
    }

    // Stored settlements keep the digest of the whole list. A replay
    // compares against it, so the streamed digest must be the same bytes.
    #[test]
    fn the_streamed_interval_digest_is_the_list_digest() {
        let receipt = |n: i64| -> ReceiptIdentity {
            (
                format!("delivery-{n}"),
                format!("{n:064x}"),
                n,
                1,
                n,
                "binding".into(),
            )
        };
        for count in [0, 1, 3] {
            let receipts: Vec<_> = (1..=count).map(receipt).collect();
            let mut interval = IntervalDigest::default();
            for receipt in &receipts {
                interval.push(receipt).unwrap();
            }
            assert_eq!(
                interval.finish(),
                (
                    receipts.len(),
                    hex_sha256(&serde_json::to_vec(&receipts).unwrap())
                )
            );
        }
    }

    #[test]
    fn moment_renames_from_proves_text_preserving_round_trips_and_refuses_breaks() {
        use dohc_engine_domain::{RenameTextFile, VersionedTextStore, WriteText};

        let dir = ScratchDir::new_named("moment-renames-from").unwrap();
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let m1 = format!("moment-ydoc-{}", "a".repeat(64));
        let seed = |name: &str| {
            let mut store = dohc_engine_testkit::open_empty_store(&dir.join(name), 0);
            VersionedTextStore::new(&mut store)
                .ensure_main_version("workspace", "main", 0, &NoFaults)
                .unwrap();
            let written = VersionedTextStore::new(&mut store)
                .write_text(
                    &WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "object".into(),
                        path: "a.md".into(),
                        text: "hello\n".into(),
                        moment_id: m1.clone(),
                        request_id: None,
                        metadata_origin: "ydoc".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                    },
                    &NoFaults,
                )
                .unwrap();
            for (from, to, id, now) in [
                ("a.md", "b.md", "m2", 2),
                ("b.md", "c.md", "m3", 3),
                ("c.md", "a.md", "m4", 4),
            ] {
                VersionedTextStore::new(&mut store)
                    .rename_text_file(
                        &RenameTextFile {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            from_path: from.into(),
                            to_path: to.into(),
                            moment_id: id.into(),
                            request_id: None,
                            metadata_origin: "user".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: now,
                        },
                        &NoFaults,
                    )
                    .unwrap();
            }
            (store, written.snapshot.blob_sha256)
        };
        let (mut store, digest) = seed("engine.db");
        let check = |store: &EngineStore, head: &str, target: &str| {
            store
                .read_with(|conn| {
                    moment_renames_from_in(conn, &key, "a.md", "a.md", &digest, head, target)
                })
                .unwrap()
        };
        assert!(check(&store, &m1, &m1));
        assert!(check(&store, "m4", &m1));
        assert!(!check(&store, "m3", &m1));
        assert!(store
            .read_with(|conn| {
                moment_renames_from_in(conn, &key, "b.md", "a.md", &digest, "m2", &m1)
            })
            .unwrap());
        assert!(store
            .read_with(|conn| {
                moment_renames_from_in(conn, &key, "c.md", "a.md", &digest, "m3", &m1)
            })
            .unwrap());
        assert!(!store
            .read_with(|conn| {
                moment_renames_from_in(conn, &key, "b.md", "b.md", &digest, "m4", &m1)
            })
            .unwrap());
        assert!(!store
            .read_with(|conn| {
                moment_renames_from_in(conn, &key, "b.md", "a.md", &digest, &m1, &m1)
            })
            .unwrap());
        assert!(!store
            .read_with(|conn| {
                moment_renames_from_in(conn, &key, "a.md", "a.md", &hex_sha256(b"other"), "m4", &m1)
            })
            .unwrap());
        let needed = std::collections::HashSet::from(["c.md", "b.md", "a.md"]);
        let proved = store
            .read_with(|conn| {
                adoption::renamed_from(conn, &key, "a.md", &needed, MAX_RENAME_CHAIN_STEPS)
            })
            .unwrap();
        assert!(proved.contains("c.md") && proved.contains("b.md") && proved.contains("a.md"));

        for (case, sql) in [
            (
                "write in chain",
                "UPDATE moments SET operation='write' WHERE moment_id='m3'",
            ),
            (
                "sync_record_only",
                "UPDATE moments SET sync_record_only=1 WHERE moment_id='m3'",
            ),
            (
                "capture-recovery",
                "UPDATE moments SET metadata_origin='capture-recovery' WHERE moment_id='m3'",
            ),
            (
                "payload_after_path mismatch",
                "UPDATE moments SET payload_after_path='elsewhere.md' WHERE moment_id='m4'",
            ),
            (
                "deleted predecessor",
                "DELETE FROM moments WHERE moment_id='m2'",
            ),
            (
                "cycle",
                "UPDATE moments SET before_latest_moment_id='m4' WHERE moment_id='m2'",
            ),
            (
                "wrong target path",
                &format!("UPDATE moments SET path='other.md' WHERE moment_id='{m1}'"),
            ),
        ] {
            let (mut copy, _) = seed(&format!("{}.db", case.replace(' ', "-")));
            copy.write_with(&NoFaults, |tx| {
                tx.execute(sql, []).map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
            assert!(!check(&copy, "m4", &m1), "{case}");
        }

        let desktop_settlement = format!("moment-ydoc-{}", "b".repeat(64));
        let (mut pre_upgrade, _) = seed("pre-upgrade.db");
        pre_upgrade
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE moments SET before_latest_moment_id=?1 WHERE moment_id='m2'",
                    [&desktop_settlement],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(
            check(&pre_upgrade, "m4", &m1),
            "pre-upgrade persisted equivalent settlement link"
        );
        pre_upgrade
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE moments SET moment_order=moment_order+10 WHERE moment_id IN ('m2','m3','m4')",
                    [],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO moments(workspace_id,moment_order,moment_id,version_id,object_id,\
                     path,recorded_at_ms,operation,after_blob_sha256,before_present,\
                     before_blob_sha256,metadata_origin,after_content_kind,before_content_kind,\
                     payload_after_path) VALUES('workspace',5,'intervening','main','object',\
                     'a.md',2,'write',?1,2,?1,'user','text','text','a.md')",
                    [&digest],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(
            !check(&pre_upgrade, "m4", &m1),
            "intervening write breaks pre-upgrade equivalent settlement proof"
        );

        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE moments SET before_latest_moment_id=?1, before_path='a.md', \
                     payload_before_path='c.md' WHERE moment_id='m4'",
                    [&m1],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(check(&store, "m4", &m1), "content fast-forward rename");
    }
}
