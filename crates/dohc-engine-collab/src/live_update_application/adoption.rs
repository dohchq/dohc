use super::*;
use crate::{ContentKind, Ydoc};

/// A complete cut acquired by the authenticated owner transport. Parsing this
/// value does not authenticate it. The renderer must not construct this input.
#[derive(Clone)]
pub struct OwnerAdoptionCut {
    pub relay_database_namespace: String,
    pub adoption_id: String,
    pub source_moment_id: String,
    pub source_digest: String,
    pub source_byte_length: i64,
    pub baseline_moment_relay_sequence: i64,
    pub baseline_registered_at_ms: i64,
    pub baseline_bytes: Vec<u8>,
    pub expected_local_sequence: i64,
    pub events: Vec<AdmittedLiveUpdate>,
    pub terminal_receipt: Option<LiveUpdateReceipt>,
    /// Native host configuration, never decoded from the relay cut.
    pub outbox_limits: crate::OwnerOutboxLimits,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owner_base_source::{OwnerSeedSource, retain_owner_base_source_in_tx};
    use crate::owner_outbox;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_test_scratch::ScratchDir;

    struct Fixture {
        store: EngineStore,
        _owner: ApplicationOwner,
        handle: ApplicationHandle,
        binding: LiveObjectBinding,
        cut: OwnerAdoptionCut,
        doc: Ydoc,
        key: DocKey,
        _scratch: ScratchDir,
    }
    impl Fixture {
        fn new() -> Self {
            let scratch = ScratchDir::new_named("existing-owner-adoption").unwrap();
            let mut store = EngineStore::open(&scratch.join("engine.db"), 0).unwrap();
            VersionedTextStore::new(&mut store)
                .ensure_main_version("workspace", "main", 0, &NoFaults)
                .unwrap();
            let fixture: Value = serde_json::from_str(include_str!(
                "../../tests/owner-source/owner-source-seed.json"
            ))
            .unwrap();
            let text = fixture["markdown"].as_str().unwrap().to_owned();
            let bytes: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
            VersionedTextStore::new(&mut store)
                .write_text(
                    &WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "object".into(),
                        path: "owner.md".into(),
                        text: text.clone(),
                        moment_id: "original".into(),
                        metadata_origin: "user".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            let key = DocKey::new("workspace", "main", "object").unwrap();
            durable::claim_base(&mut store, &key, ContentKind::Richdoc, &bytes, &NoFaults, 2)
                .unwrap();
            let source = OwnerSeedSource {
                moment_id: "original".into(),
                blob_sha256: hex_sha256(text.as_bytes()),
            };
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                        .unwrap();
                    assert!(retain_owner_base_source_in_tx(
                        tx,
                        &key,
                        "owner.md",
                        &hex_sha256(&bytes),
                        &source
                    )?);
                    Ok::<_, CollabError>(())
                })
                .unwrap();
            let binding = LiveObjectBinding {
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: "object".into(),
                lineage_claim_id: hex_sha256(&bytes),
                current_path: "owner.md".into(),
                selector_paths: vec!["owner.md".into()],
                restore_fence_generation: 0,
            };
            let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
            let handle = owner
                .register(
                    &mut store,
                    "namespace".into(),
                    ApplicationHostCoordinate {
                        host_id: "host".into(),
                        host_epoch: 1,
                        instance_id: "instance".into(),
                        connection_id: "connection".into(),
                    },
                    binding.clone(),
                )
                .unwrap();
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            let cut = OwnerAdoptionCut {
                relay_database_namespace: "namespace".into(),
                adoption_id: "adoption".into(),
                source_moment_id: source.moment_id,
                source_digest: source.blob_sha256,
                source_byte_length: text.len() as i64,
                baseline_moment_relay_sequence: 1,
                baseline_registered_at_ms: 3,
                baseline_bytes: bytes,
                expected_local_sequence: 0,
                events: vec![],
                terminal_receipt: None,
                outbox_limits: crate::OwnerOutboxLimits {
                    max_pending_bytes: 1_000_000,
                    max_pending_age_ms: 100_000,
                },
            };
            Self {
                _scratch: scratch,
                store,
                _owner: owner,
                handle,
                binding,
                cut,
                doc,
                key,
            }
        }
        fn edit(&mut self, acknowledge: bool) {
            self.edit_with_limit(acknowledge, 1_000_000);
        }
        fn edit_with_limit(&mut self, acknowledge: bool, max_pending_bytes: i64) {
            self.doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, "owner edit")
                .unwrap();
            let bytes = self.doc.encode_full_state();
            let sequence = self
                .store
                .write_with(&NoFaults, |tx| {
                    durable::record_update_in_tx(tx, &self.key, &bytes, None, None, 4)
                })
                .unwrap();
            let TxnOutcome::Committed(sequence) = sequence else {
                panic!("record crash")
            };
            let entry = owner_outbox::append(
                &mut self.store,
                "workspace",
                owner_outbox::OwnerOutboxAppendInput {
                    binding: self.binding.clone(),
                    base_update: self.cut.baseline_bytes.clone(),
                    append_key: "edit".into(),
                    update: bytes.clone(),
                    limits: owner_outbox::OwnerOutboxLimits {
                        max_pending_bytes,
                        max_pending_age_ms: 100_000,
                    },
                    created_at_ms: 4,
                },
            )
            .unwrap();
            let receipt = LiveUpdateReceipt {
                delivery_id: entry.delivery_id,
                update_digest: entry.update_digest,
                journal_cursor: 7,
                accepting_host_epoch: 1,
            };
            if acknowledge {
                owner_outbox::acknowledge(
                    &mut self.store,
                    "workspace",
                    &entry.outbox_id,
                    &[owner_outbox::OwnerDeliveryReceipt {
                        delivery_id: receipt.delivery_id.clone(),
                        update_digest: receipt.update_digest.clone(),
                        journal_cursor: 7,
                        accepting_host_epoch: 1,
                    }],
                )
                .unwrap();
            }
            self.cut.expected_local_sequence = sequence.seq;
            self.cut.events.push(AdmittedLiveUpdate {
                metadata: AdmittedLiveUpdateMetadata {
                    accepted: RelayAcceptedLiveUpdate {
                        receipt: receipt.clone(),
                        binding: self.binding.clone(),
                        authority: ServerDerivedLiveUpdateAuthority::Owner {
                            principal_id: "owner".into(),
                        },
                        received_at_ms: 4,
                    },
                    first_seen: vec![],
                },
                update_bytes: bytes,
            });
            self.cut.terminal_receipt = Some(receipt);
        }
        fn adopt(&mut self) -> Result<OwnerAdoptionAck, ApplicationError> {
            adopt_owner_committed(
                &mut self.store,
                &self.handle,
                self.cut.clone(),
                1_000_000,
                100,
                &NoFaults,
            )
        }
        fn counts(&self) -> Vec<i64> {
            [
                "moments",
                "snapshots",
                "ydoc_docs",
                "ydoc_snapshots",
                "ydoc_updates",
                "owner_ydoc_outboxes",
                "owner_ydoc_outbox_entries",
            ]
            .iter()
            .map(|t| self.store.table_row_count(t).unwrap())
            .collect()
        }
    }
    #[test]
    fn owner_adoption_is_the_origin_for_remote_apply_and_settlement_coverage() {
        let mut f = Fixture::new();
        f.edit(true);
        f.adopt().unwrap();
        assert_eq!(
            f.store.table_row_count("live_device_bootstraps").unwrap(),
            0
        );
        let mut event = f.cut.events[0].clone();
        assert!(matches!(
            apply_committed(
                &mut f.store,
                &mut WriterDocCache::new(),
                &f.handle,
                event.clone(),
                &NoFaults
            ),
            Err(ApplicationError::Conflict)
        ));
        f.doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "remote after adoption")
            .unwrap();
        event.update_bytes = f.doc.encode_full_state();
        event.metadata.accepted.receipt.delivery_id = "remote-after-adoption".into();
        event.metadata.accepted.receipt.journal_cursor = 8;
        event.metadata.accepted.receipt.update_digest = hex_sha256(&event.update_bytes);
        let applied = apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event.clone(),
            &NoFaults,
        )
        .unwrap();
        assert!(matches!(applied, ApplicationResult::Applied(_)));
        let result: Result<_, ApplicationError> = with_settlement(
            &mut f.store,
            &f.handle,
            Some(event.metadata.accepted.receipt.clone()),
            10,
            |_, audit| Ok(audit.result("test".into(), "test-moment".into(), "a".repeat(64), false)),
        );
        let result = result.unwrap();
        assert_eq!(result.previous_cursor, 7);
        assert_eq!(result.terminal_cursor, 8);
        assert_eq!(result.application_count, 1);
        assert_eq!(result.local_ydoc_sequence, 2);
        assert_eq!(
            f.store.table_row_count("live_device_bootstraps").unwrap(),
            0
        );
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
    #[test]
    fn owner_adoption_accepts_drained_sealed_outbox_and_rejects_identity_collision() {
        let mut f = Fixture::new();
        f.edit_with_limit(true, 1);
        let state: String = f
            .store
            .read_with(|conn| {
                conn.query_row("SELECT state FROM owner_ydoc_outboxes", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(state, "sealed");
        let before = f.counts();
        assert!(!f.adopt().unwrap().adoption_replayed);
        assert!(f.adopt().unwrap().adoption_replayed);
        f.cut.adoption_id = "different-attempt".into();
        assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
        assert_eq!(before, f.counts());
        f.cut.adoption_id = "adoption".into();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE owner_ydoc_outbox_entries SET update_digest=?1",
                    params![hex_sha256(b"changed")],
                )
                .map_err(write_sql)?;
                Ok::<_, ApplicationError>(())
            })
            .unwrap();
        assert!(f.adopt().is_err());
    }
    #[test]
    fn owner_adoption_preserves_exact_owner_and_replays_after_later_edits() {
        for edit in [false, true] {
            let mut f = Fixture::new();
            if edit {
                f.edit(true);
            }
            let before = f.counts();
            let state = f
                .store
                .read_with(|c| durable::load_doc_in(c, &f.key))
                .unwrap();
            let ack = f.adopt().unwrap();
            assert!(!ack.adoption_replayed);
            assert_eq!(ack.local_ydoc_sequence, f.cut.expected_local_sequence);
            assert_eq!(before, f.counts());
            assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
            let after = f
                .store
                .read_with(|c| durable::load_doc_in(c, &f.key))
                .unwrap();
            assert!(crate::replay_parity::structurally_equal_v2(&state, &after).unwrap());
            let replay = f.adopt().unwrap();
            assert!(replay.adoption_replayed);
            assert_eq!(replay.local_ydoc_sequence, ack.local_ydoc_sequence);
            f.doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, "later edit")
                .unwrap();
            f.store
                .write_with(&NoFaults, |tx| {
                    durable::record_update_in_tx(
                        tx,
                        &f.key,
                        &f.doc.encode_full_state(),
                        None,
                        None,
                        5,
                    )
                })
                .unwrap();
            assert_eq!(
                f.adopt().unwrap().local_ydoc_sequence,
                ack.local_ydoc_sequence
            );
        }
    }
    #[test]
    fn owner_adoption_refuses_unaccounted_state_and_receipts_without_mutation() {
        for mode in 0..10 {
            let mut f = Fixture::new();
            f.edit(mode != 0);
            match mode {
                0 => {}
                1 => {
                    f.cut.events.clear();
                    f.cut.terminal_receipt = None;
                }
                2 => f.cut.source_moment_id = "same-digest-other-moment".into(),
                3 => f.cut.expected_local_sequence += 1,
                4 => f.cut.events[0].metadata.accepted.receipt.delivery_id = "forged".into(),
                5 => {
                    f.cut.events[0]
                        .metadata
                        .accepted
                        .binding
                        .restore_fence_generation += 1
                }
                6 => f
                    .store
                    .write_with(&NoFaults, |tx| {
                        tx.execute("DELETE FROM owner_ydoc_outbox_entries", [])
                            .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .map(|_| ())
                    .unwrap(),
                7 => {
                    f.cut.events[0].metadata.accepted.binding.selector_paths =
                        vec!["elsewhere".into()]
                }
                8 => f
                    .store
                    .write_with(&NoFaults, |tx| {
                        tx.execute("UPDATE ydoc_docs SET regime='local-only',lineage_claim_status='unclaimed',lineage_claim_id=NULL", [])
                            .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .map(|_| ())
                    .unwrap(),
                _ => f.cut.relay_database_namespace = "other-relay".into(),
            }
            let before = f.counts();
            assert!(f.adopt().is_err(), "mode {mode}");
            assert_eq!(before, f.counts());
            assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 0);
        }
    }
    #[test]
    fn owner_adoption_refuses_missing_source_and_retired_registration() {
        let mut f = Fixture::new();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM ydoc_owner_base_sources", [])
                    .unwrap();
                Ok::<_, StorageError>(())
            })
            .unwrap();
        assert!(f.adopt().is_err());
        let mut f = Fixture::new();
        f._owner.invalidate(&mut f.store).unwrap();
        assert!(f.adopt().is_err());
    }
    #[test]
    fn owner_source_public_vectors_match_native_validation() {
        let rows: Value = serde_json::from_str(include_str!(
            "../../tests/owner-source/owner-source-public.json"
        ))
        .unwrap();
        for row in rows.as_array().unwrap() {
            let bytes: Vec<u8> = serde_json::from_value(row["bytes"].clone()).unwrap();
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            assert_eq!(
                doc.validate_public_baseline(&bytes).is_ok(),
                row["accepted"].as_bool().unwrap(),
                "{}",
                row["name"]
            );
            if row["accepted"] == true {
                let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
                assert_eq!(
                    doc.preserved_markdown_source(&canonical)
                        .unwrap_or(canonical),
                    row["markdown"].as_str().unwrap()
                );
            }
        }
    }
    #[cfg(feature = "fault-injection")]
    #[test]
    fn owner_adoption_rolls_back_before_commit_and_replays_lost_ack_after_restart() {
        use dohc_engine_storage::{FaultAction, FaultPoint};
        struct Crash(FaultPoint);
        impl FaultInjector for Crash {
            fn poll(&self, p: FaultPoint) -> FaultAction {
                if p == self.0 {
                    FaultAction::Crash
                } else {
                    FaultAction::Continue
                }
            }
        }
        for point in [
            FaultPoint::StorageBeforePersist,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let mut f = Fixture::new();
            f.edit(true);
            let before = f.counts();
            assert!(
                adopt_owner_committed(
                    &mut f.store,
                    &f.handle,
                    f.cut.clone(),
                    1_000_000,
                    100,
                    &Crash(point)
                )
                .is_err()
            );
            assert_eq!(before, f.counts());
            let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(
                f.store.table_row_count("live_owner_adoptions").unwrap(),
                i64::from(committed)
            );
            let path = f._scratch.join("engine.db");
            drop(f.store);
            f.store = EngineStore::open(&path, 10).unwrap();
            let ack = f.adopt().unwrap();
            assert_eq!(ack.adoption_replayed, committed);
            assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
            f.cut.adoption_id = "another-id".into();
            assert!(f.adopt().is_err());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerAdoptionAck {
    pub adoption_id: String,
    #[serde(rename = "localYDocSequence")]
    pub local_ydoc_sequence: i64,
    pub terminal_cursor: i64,
    pub adoption_replayed: bool,
}

fn validate_cut(
    cut: &OwnerAdoptionCut,
    binding: &LiveObjectBinding,
    max_bytes: usize,
    max_events: usize,
) -> Result<String, ApplicationError> {
    identifier(&cut.relay_database_namespace, 1024)?;
    identifier(&cut.adoption_id, 512)?;
    identifier(&cut.source_moment_id, 512)?;
    digest(&cut.source_digest)?;
    integer(
        cut.source_byte_length,
        0,
        dohc_engine_domain::MAX_TEXT_BYTES as i64,
    )?;
    integer(cut.baseline_moment_relay_sequence, 0, SAFE)?;
    integer(cut.baseline_registered_at_ms, 0, SAFE)?;
    integer(cut.expected_local_sequence, 0, SAFE)?;
    integer(cut.outbox_limits.max_pending_bytes, 1, SAFE)?;
    integer(cut.outbox_limits.max_pending_age_ms, 1, SAFE)?;
    if max_bytes == 0
        || max_events == 0
        || max_events >= i64::MAX as usize
        || cut.events.len() > max_events
        || cut.baseline_bytes.len() < 2
        || cut.baseline_bytes.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
        || hex_sha256(&cut.baseline_bytes) != binding.lineage_claim_id
    {
        return Err(invalid("owner adoption baseline or capacity"));
    }
    let mut size = cut.baseline_bytes.len();
    let mut cursor = 0;
    let mut deliveries = std::collections::HashSet::new();
    let mut identities = Vec::with_capacity(cut.events.len());
    for event in &cut.events {
        event.validate()?;
        settlement::validate_historical_binding(&event.metadata.accepted.binding, binding)?;
        let receipt = &event.metadata.accepted.receipt;
        if receipt.journal_cursor <= cursor
            || !deliveries.insert(&receipt.delivery_id)
            || event.update_bytes.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
        {
            return Err(invalid("owner adoption journal order"));
        }
        let metadata_length = serde_json::to_vec(&event.metadata)
            .map_err(|_| ApplicationError::Corrupt)?
            .len();
        size = size
            .checked_add(event.update_bytes.len())
            .and_then(|size| size.checked_add(metadata_length))
            .ok_or(invalid("owner adoption capacity"))?;
        if size > max_bytes {
            return Err(invalid("owner adoption capacity"));
        }
        cursor = receipt.journal_cursor;
        identities.push(&event.metadata);
    }
    if size > max_bytes
        || cut.events.last().map(|e| &e.metadata.accepted.receipt) != cut.terminal_receipt.as_ref()
    {
        return Err(invalid("owner adoption terminal or capacity"));
    }
    Ok(hex_sha256(
        &serde_json::to_vec(&(
            binding,
            &cut.relay_database_namespace,
            &cut.source_moment_id,
            &cut.source_digest,
            cut.source_byte_length,
            cut.baseline_moment_relay_sequence,
            cut.baseline_registered_at_ms,
            cut.expected_local_sequence,
            cut.outbox_limits.max_pending_bytes,
            cut.outbox_limits.max_pending_age_ms,
            identities,
        ))
        .map_err(|_| ApplicationError::Corrupt)?,
    ))
}

/// Prove an existing owner's state without changing its domain history, base,
/// update sequence, delivery entries, or projection. The captured registration
/// mutex and actor writer lane remain held through the audit transaction.
pub fn adopt_owner_committed(
    store: &mut EngineStore,
    handle: &ApplicationHandle,
    cut: OwnerAdoptionCut,
    max_bytes: usize,
    max_events: usize,
    faults: &dyn FaultInjector,
) -> Result<OwnerAdoptionAck, ApplicationError> {
    let held = handle
        .registration
        .lock()
        .map_err(|_| ApplicationError::Interrupted)?;
    if !held.live {
        return Err(ApplicationError::Interrupted);
    }
    if cut.relay_database_namespace != held.namespace {
        return Err(ApplicationError::Conflict);
    }
    settlement::validate_historical_binding(&held.binding, &held.binding)?;
    let evidence_digest = validate_cut(&cut, &held.binding, max_bytes, max_events)?;
    let b = &held.binding;
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let result = store.write_with(faults, |tx| {
        require_workspace(tx, &held)?;
        if !read_binding(tx, &held)?.is_some_and(|(binding, coordinate, available)| available && binding == *b && coordinate == held.coordinate) {
            return Err(ApplicationError::Interrupted);
        }
        let marker = durable::read_marker_in(tx, &key)?.ok_or(ApplicationError::Conflict)?;
        if marker.content_kind != ContentKind::Richdoc || marker.regime != Regime::Replicated
            || marker.lineage_claim_status != durable::LineageClaimStatus::Exact
            || marker.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
            || marker.path.as_deref() != Some(&b.current_path) {
            return Err(ApplicationError::Conflict);
        }
        let present:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshots s JOIN path_aliases p USING(workspace_id,version_id,object_id,path) WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.content_kind='text')",
            params![b.workspace_id,b.main_version_id,b.object_id,b.current_path],|r|r.get(0)).map_err(read_sql)?;
        if !present { return Err(ApplicationError::Conflict); }
        let source: Option<(String, String, i64, String)> = tx.query_row(
            "SELECT s.source_moment_id,s.source_blob_sha256,s.source_byte_length,t.text
             FROM ydoc_owner_base_sources s JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id
             AND m.object_id=s.object_id AND m.path=s.path AND m.moment_id=s.source_moment_id
             AND m.after_blob_sha256=s.source_blob_sha256 AND m.after_content_kind='text'
             JOIN blobs t ON t.sha256=s.source_blob_sha256 AND t.byte_length=s.source_byte_length
             WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.lineage_claim_id=?4 AND s.path=?5",
            params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(read_sql)?;
        let Some((moment,digest,length,text)) = source else { return Err(invalid("owner adoption source evidence missing")); };
        if moment != cut.source_moment_id || digest != cut.source_digest || length != cut.source_byte_length
            || text.len() as i64 != length || hex_sha256(text.as_bytes()) != digest {
            return Err(ApplicationError::Conflict);
        }
        let original: Option<String> = tx.query_row(
            "SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
            params![b.workspace_id,b.main_version_id,b.object_id], |r| r.get(0)).optional().map_err(read_sql)?;
        if original.as_deref() != Some(&b.lineage_claim_id)
            || get_binary_blob(tx, &b.lineage_claim_id)?.as_deref() != Some(cut.baseline_bytes.as_slice()) {
            return Err(ApplicationError::Conflict);
        }
        let previous: Option<(String,String,i64,i64,String,i64)> = tx.query_row(
            "SELECT evidence_digest,binding_json,local_ydoc_sequence,terminal_cursor,coverage_digest,covered_outbox_sequence FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND adoption_id=?2",
            params![held.namespace,cut.adoption_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(read_sql)?;
        let binding_json=serde_json::to_string(b).map_err(|_| ApplicationError::Corrupt)?;
        if let Some((saved_digest,saved_binding,sequence,cursor,coverage,covered_sequence)) = previous {
            let origin = read_origin(tx,&held)?.ok_or(ApplicationError::Corrupt)?;
            if origin.terminal != cut.terminal_receipt { return Err(ApplicationError::Corrupt); }
            if saved_digest != evidence_digest || saved_binding != binding_json || sequence != cut.expected_local_sequence
                || marker.head_update_seq < sequence || cursor != cut.terminal_receipt.as_ref().map_or(0,|r|r.journal_cursor) {
                return Err(ApplicationError::Conflict);
            }
            if outbox_coverage(tx,b,&cut.events,max_events,Some(covered_sequence))? != (coverage,covered_sequence) { return Err(ApplicationError::Corrupt); }
            return Ok(OwnerAdoptionAck {adoption_id:cut.adoption_id.clone(),local_ydoc_sequence:sequence,terminal_cursor:cursor,adoption_replayed:true});
        }
        let existing_document: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM live_owner_adoptions WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
            params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |r| r.get(0)).map_err(read_sql)?;
        if existing_document { return Err(ApplicationError::Conflict); }
        if marker.head_update_seq != cut.expected_local_sequence { return Err(invalid("owner adoption evidence is stale")); }
        let local = durable::load_doc_in(tx, &key)?;
        let journal = Ydoc::wire();
        journal.apply(&cut.baseline_bytes)?;
        journal.validate_public_baseline(&cut.baseline_bytes)?;
        for event in &cut.events { journal.apply(&event.update_bytes)?; }
        if local.has_missing_updates() || journal.has_missing_updates()
            || !crate::replay_parity::structurally_equal_v2(&local, &journal)? {
            return Err(invalid("owner adoption journal does not account for durable state"));
        }
        let (coverage,covered_sequence) = outbox_coverage(tx, b, &cut.events, max_events,None)?;
        let terminal_cursor = cut.terminal_receipt.as_ref().map_or(0,|r|r.journal_cursor);
        tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            params![held.namespace,cut.adoption_id,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,binding_json,cut.source_moment_id,cut.source_digest,cut.source_byte_length,cut.baseline_moment_relay_sequence,cut.baseline_registered_at_ms,evidence_digest,coverage,covered_sequence,marker.head_update_seq,terminal_cursor,serde_json::to_string(&cut.terminal_receipt).map_err(|_|ApplicationError::Corrupt)?,serde_json::to_string(&held.coordinate).map_err(|_|ApplicationError::Corrupt)?,cut.outbox_limits.max_pending_bytes,cut.outbox_limits.max_pending_age_ms]).map_err(write_sql)?;
        Ok(OwnerAdoptionAck { adoption_id:cut.adoption_id.clone(),local_ydoc_sequence:marker.head_update_seq,terminal_cursor,adoption_replayed:false })
    })?;
    match result {
        TxnOutcome::Committed(ack) => Ok(ack),
        TxnOutcome::Crashed { .. } => Err(ApplicationError::Interrupted),
    }
}

fn outbox_coverage(
    conn: &Connection,
    b: &LiveObjectBinding,
    events: &[AdmittedLiveUpdate],
    max_events: usize,
    replay_sequence: Option<i64>,
) -> Result<(String, i64), ApplicationError> {
    let parent: Option<(String,String,String,i64,i64)> = conn.query_row(
        "SELECT outbox_id,state,base_update_digest,pending_bytes,next_sequence FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND current_path=?5 AND restore_fence_generation=?6",
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,b.restore_fence_generation],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(read_sql)?;
    let receipts: std::collections::HashMap<_, _> = events
        .iter()
        .map(|event| {
            (
                &event.metadata.accepted.receipt.delivery_id,
                &event.metadata.accepted,
            )
        })
        .collect();
    let mut coverage = Vec::new();
    if let Some((id, state, base, pending, next)) = parent {
        let terminal = replay_sequence.unwrap_or(next - 1);
        if (state != "active" && state != "sealed")
            || base != b.lineage_claim_id
            || (replay_sequence.is_none() && pending != 0)
            || next < 1
            || terminal < 0
            || terminal >= next
            || terminal as u64 > max_events as u64
        {
            return Err(invalid("owner adoption outbox is not drained"));
        }
        let mut query = conn.prepare("SELECT sequence,delivery_id,update_digest,pending FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND sequence<=?2 ORDER BY sequence LIMIT ?3").map_err(read_sql)?;
        let rows = query
            .query_map(params![id, terminal, max_events as i64 + 1], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(read_sql)?;
        for row in rows {
            let (sequence, delivery, digest, pending) = row.map_err(read_sql)?;
            if sequence != coverage.len() as i64 + 1 || pending != 0 {
                return Err(ApplicationError::Conflict);
            }
            let accepted = receipts
                .get(&delivery)
                .ok_or(invalid("owner adoption receipt coverage missing"))?;
            let receipt = &accepted.receipt;
            if receipt.update_digest != digest
                || !matches!(
                    accepted.authority,
                    ServerDerivedLiveUpdateAuthority::Owner { .. }
                )
                || coverage
                    .last()
                    .is_some_and(|(_, previous): &(i64, LiveUpdateReceipt)| {
                        previous.journal_cursor >= receipt.journal_cursor
                    })
            {
                return Err(ApplicationError::Conflict);
            }
            coverage.push((sequence, receipt.clone()));
        }
        if coverage.len() as i64 != terminal {
            return Err(invalid("owner adoption retained outbox coverage missing"));
        }
    } else {
        let exists: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|r.get(0)).map_err(read_sql)?;
        if exists || replay_sequence.is_some_and(|sequence| sequence != 0) {
            return Err(ApplicationError::Conflict);
        }
    }
    Ok((
        hex_sha256(&serde_json::to_vec(&coverage).map_err(|_| ApplicationError::Corrupt)?),
        coverage.len() as i64,
    ))
}

pub(super) struct AdoptedOrigin {
    pub binding: LiveObjectBinding,
    pub source_moment: String,
    pub source_digest: String,
    pub sequence: i64,
    pub terminal: Option<LiveUpdateReceipt>,
}

pub(super) fn read_origin(
    conn: &Connection,
    held: &Registration,
) -> Result<Option<AdoptedOrigin>, ApplicationError> {
    let b = &held.binding;
    let raw: Option<(String,String,String,i64,i64,String)> = conn.query_row(
        "SELECT a.binding_json,a.source_moment_id,a.source_digest,a.local_ydoc_sequence,a.terminal_cursor,a.terminal_receipt_json FROM live_owner_adoptions a
        JOIN ydoc_owner_base_sources s ON s.workspace_id=a.workspace_id AND s.version_id=a.main_version_id AND s.object_id=a.object_id AND s.lineage_claim_id=a.lineage_claim_id AND s.source_moment_id=a.source_moment_id AND s.source_blob_sha256=a.source_digest AND s.source_byte_length=a.source_byte_length
        JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id AND m.object_id=s.object_id AND m.path=s.path AND m.moment_id=s.source_moment_id AND m.after_blob_sha256=s.source_blob_sha256 AND m.after_content_kind='text'
        JOIN ydoc_snapshots snap ON snap.workspace_id=a.workspace_id AND snap.version_id=a.main_version_id AND snap.object_id=a.object_id AND snap.up_to_seq=0 AND snap.snapshot_blob_sha256=a.lineage_claim_id
        WHERE a.relay_database_namespace=?1 AND a.workspace_id=?2 AND a.main_version_id=?3 AND a.object_id=?4 AND a.lineage_claim_id=?5",
        params![held.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(read_sql)?;
    let Some((binding, source_moment, source_digest, sequence, cursor, terminal)) = raw else {
        return Ok(None);
    };
    let binding = serde_json::from_str(&binding).map_err(|_| ApplicationError::Corrupt)?;
    settlement::validate_historical_binding(&binding, b)?;
    let terminal: Option<LiveUpdateReceipt> =
        serde_json::from_str(&terminal).map_err(|_| ApplicationError::Corrupt)?;
    if let Some(receipt) = &terminal {
        receipt.validate()?;
    }
    if terminal.as_ref().map_or(0, |r| r.journal_cursor) != cursor || sequence < 0 {
        return Err(ApplicationError::Corrupt);
    }
    Ok(Some(AdoptedOrigin {
        binding,
        source_moment,
        source_digest,
        sequence,
        terminal,
    }))
}
