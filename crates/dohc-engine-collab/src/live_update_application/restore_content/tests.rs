use super::*;
use dohc_engine_storage::{FaultAction, FaultPoint};
use dohc_test_scratch::ScratchDir;

struct Fixture {
    store: EngineStore,
    owner: ApplicationOwner,
    handle: ApplicationHandle,
    doc: Ydoc,
    binding: LiveObjectBinding,
    host: ApplicationHostCoordinate,
    terminal: Option<LiveUpdateReceipt>,
    sequence: i64,
    baseline_point: NativeRestorePoint,
    dir: ScratchDir,
}

fn point(doc: &Ydoc, cursor: i64, receipt_digest: String) -> NativeRestorePoint {
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    let source = doc
        .preserved_markdown_source(&projection)
        .unwrap_or_else(|| projection.clone());
    NativeRestorePoint {
        journal_cursor: cursor,
        receipt_digest,
        markdown_digest: hex_sha256(source.as_bytes()),
        projection_digest: hex_sha256(projection.as_bytes()),
    }
}

impl Fixture {
    fn new(source: &str) -> Self {
        Self::with_seed(source, "rich-unicode")
    }
    fn with_seed(source: &str, seed_name: &str) -> Self {
        let dir = ScratchDir::new_named("native-restore-proposal").unwrap();
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let doc = Ydoc::wire();
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        let seed = fixtures
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == seed_name)
            .unwrap();
        let seed_bytes: Vec<u8> = serde_json::from_value(seed["bytes"].clone()).unwrap();
        doc.apply(&seed_bytes).unwrap();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
            .unwrap();
        let bytes = doc.encode_full_state();
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&bytes),
            current_path: "a.md".into(),
            selector_paths: vec!["a.md".into()],
            restore_fence_generation: 0,
        };
        let host = ApplicationHostCoordinate {
            host_id: "host".into(),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        };
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        let handle = owner
            .register(
                &mut store,
                "namespace".into(),
                host.clone(),
                binding.clone(),
            )
            .unwrap();
        let bootstrap = LiveApplicationBootstrap {
            bootstrap_id: "bootstrap".into(),
            bootstrap_moment_id: "baseline".into(),
            baseline_moment_relay_sequence: 1,
            baseline_registered_at_ms: 1,
            baseline_digest: binding.lineage_claim_id.clone(),
            baseline_byte_length: bytes.len() as i64,
            projected_markdown_digest: hex_sha256(source.as_bytes()),
            projected_markdown_byte_length: source.len() as i64,
        };
        bootstrap_committed::<Box<dyn std::error::Error>>(
            &mut store,
            &mut WriterDocCache::new(),
            &handle,
            bootstrap,
            bytes,
            &NoFaults,
            |_, _| Ok(()),
        )
        .unwrap();
        let baseline_point = point(&doc, 0, binding.lineage_claim_id.clone());
        Self {
            dir,
            store,
            owner,
            handle,
            doc,
            binding,
            host,
            terminal: None,
            sequence: 0,
            baseline_point,
        }
    }
    fn edit(&mut self, source: &str, cursor: i64) -> NativeRestorePoint {
        let bytes = self
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
            .unwrap();
        let receipt = LiveUpdateReceipt {
            delivery_id: format!("event-{cursor}"),
            update_digest: hex_sha256(&bytes),
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        };
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: receipt.clone(),
                    binding: self.binding.clone(),
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: cursor,
                },
                first_seen: vec![],
            },
            update_bytes: bytes,
        };
        let result = apply_committed(
            &mut self.store,
            &mut WriterDocCache::new(),
            &self.handle,
            event,
            &NoFaults,
        )
        .unwrap();
        let ApplicationResult::Applied(ack) = result else {
            panic!("apply refused")
        };
        self.sequence = ack.local_ydoc_sequence;
        self.terminal = Some(receipt.clone());
        point(&self.doc, cursor, receipt.update_digest)
    }
    fn freeze(&mut self, point: NativeRestorePoint) -> NativeRestorePreparation {
        let operation = NativeRestoreFence {
            operation_id: "restore".into(),
            relay_database_namespace: "namespace".into(),
            old_binding: self.binding.clone(),
            host_id: "host".into(),
            new_fence: 1,
            origin: RestoreDeliveryOrigin::Bootstrap {
                id: "bootstrap".into(),
            },
            terminal: self.terminal.clone(),
            applied_sequence: self.sequence,
        };
        let fence = self
            .owner
            .fence_restore(&mut self.store, operation, self.host.clone(), 50, &NoFaults)
            .unwrap();
        NativeRestorePreparation {
            fence,
            point,
            owner_origin: None,
        }
    }
    fn prepare(
        &mut self,
        input: NativeRestorePreparation,
    ) -> Result<NativeRestoreProposal, ApplicationError> {
        self.owner.prepare_restore(
            &mut self.store,
            input,
            self.host.clone(),
            1_000_000,
            100,
            &NoFaults,
        )
    }
    fn canonical(&self) -> Ydoc {
        self.store
            .read_with(|conn| {
                durable::load_doc_in(conn, &DocKey::new("workspace", "main", "object").unwrap())
            })
            .unwrap()
    }
}

#[test]
fn prepares_one_forward_restore_of_an_exact_source_point_and_replays_after_restart() {
    let mut f = Fixture::new("# Baseline\n");
    let chosen = "---\ntitle: 'été 😀'\n---\n\n# Chosen 🐱\n\n**Keep** this.\n";
    let selected = f.edit(chosen, 7);
    f.edit(
        "---\ntitle: Later\nextra: yes\n---\n\nDiscard later work.\n",
        11,
    );
    let before = f.canonical().encode_full_state();
    let input = f.freeze(selected);
    let proposal = f.prepare(input.clone()).unwrap();
    assert_eq!(proposal.receipt().fence.local_head_sequence, 2);
    assert_eq!(proposal.receipt().accepted_sources.len(), 2);
    assert!(!proposal.receipt().replacement_ranges.is_empty());
    assert_eq!(
        proposal
            .receipt()
            .fence
            .operation
            .old_binding
            .lineage_claim_id,
        f.binding.lineage_claim_id
    );
    let restored = Ydoc::wire();
    restored.apply(proposal.frozen_state_bytes()).unwrap();
    restored.apply(proposal.candidate_bytes()).unwrap();
    let projection = restored.project(ContentKind::Richdoc).unwrap().content;
    assert_eq!(
        restored.preserved_markdown_source(&projection).unwrap(),
        chosen
    );
    let before_doc = Ydoc::wire();
    before_doc.apply(&before).unwrap();
    assert!(crate::replay_parity::structurally_equal_v2(&before_doc, &f.canonical()).unwrap());
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    let expected = serde_json::to_vec(&proposal).unwrap();
    assert_eq!(
        serde_json::to_vec(&f.prepare(input.clone()).unwrap()).unwrap(),
        expected
    );
    drop(f.store);
    f.store = EngineStore::open(&f.dir.join("engine.db"), 60).unwrap();
    f.owner = ApplicationOwner::new("workspace".into()).unwrap();
    f.host.connection_id = "reconnected".into();
    f.host.host_epoch = 2;
    assert_eq!(
        serde_json::to_vec(&f.prepare(input).unwrap()).unwrap(),
        expected
    );
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
}

#[test]
fn same_content_point_still_prepares_a_forward_owner_operation() {
    let mut f = Fixture::new("# Same 😀\n");
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input).unwrap();
    assert!(!proposal.receipt().replacement_ranges.is_empty());
    assert_eq!(proposal.receipt().point.journal_cursor, 0);
    assert_eq!(proposal.receipt().fence.local_head_sequence, 0);
}

#[test]
fn rejects_changed_point_host_fence_and_unclassified_native_tail_without_a_proposal() {
    for damage in [
        "point",
        "source",
        "projection",
        "host",
        "fence",
        "head",
        "tail",
    ] {
        let mut f = Fixture::new("# Original\n");
        if damage == "tail" {
            let bytes = f
                .doc
                .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Unsent")
                .unwrap();
            let key = DocKey::new("workspace", "main", "object").unwrap();
            f.store
                .write_with(&NoFaults, |tx| {
                    durable::record_update_in_tx(tx, &key, &bytes, None, None, 2)
                })
                .unwrap();
        }
        let mut input = f.freeze(f.baseline_point.clone());
        match damage {
            "point" => input.point.journal_cursor = 5,
            "source" => input.point.markdown_digest = "f".repeat(64),
            "projection" => input.point.projection_digest = "f".repeat(64),
            "host" => f.host.host_id = "foreign".into(),
            "fence" => input.fence.operation.new_fence = 2,
            "head" => {
                f.store
                    .write_with(&NoFaults, |tx| {
                        tx.execute("UPDATE ydoc_docs SET head_update_seq=head_update_seq+1", [])
                            .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .unwrap();
            }
            _ => {}
        }
        assert!(f.prepare(input).is_err(), "{damage}");
        let present: i64 = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM live_restore_fences WHERE proposal_json IS NOT NULL",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(present, 0, "{damage}");
    }
}

struct CrashAt(FaultPoint);
impl FaultInjector for CrashAt {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.0 {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[test]
fn preparation_commit_boundaries_retain_exact_candidate_or_roll_back_every_reference() {
    for fault in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new("# Point\n");
        f.edit("# Later\n", 3);
        let input = f.freeze(f.baseline_point.clone());
        assert!(f
            .owner
            .prepare_restore(
                &mut f.store,
                input.clone(),
                f.host.clone(),
                1_000_000,
                100,
                &CrashAt(fault)
            )
            .is_err());
        let stored: Option<String> = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT proposal_candidate_sha256 FROM live_restore_fences",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            stored.is_some(),
            fault == FaultPoint::StorageAfterCommitBeforeAck
        );
        drop(f.store);
        f.store = EngineStore::open(&f.dir.join("engine.db"), 70).unwrap();
        let proposal = f.prepare(input).unwrap();
        if let Some(digest) = stored {
            assert_eq!(proposal.receipt().candidate_digest, digest);
        }
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
}

#[test]
fn configured_limits_and_foreign_key_retention_apply_to_preparation_and_replay() {
    let mut f = Fixture::new("# Point\n");
    f.edit("# Later\n", 3);
    let input = f.freeze(f.baseline_point.clone());
    for (bytes, events) in [(1, 100), (1_000_000, 0)] {
        assert!(f
            .owner
            .prepare_restore(
                &mut f.store,
                input.clone(),
                f.host.clone(),
                bytes,
                events,
                &NoFaults
            )
            .is_err());
    }
    let proposal = f.prepare(input.clone()).unwrap();
    for digest in [
        &proposal.receipt().candidate_digest,
        &proposal.receipt().frozen_state_digest,
        &proposal.receipt().point_state_digest,
    ] {
        assert!(f
            .store
            .write_with(&NoFaults, |tx| tx
                .execute("DELETE FROM binary_blobs WHERE sha256=?1", [digest])
                .map_err(write_sql))
            .is_err());
    }
    assert!(f
        .owner
        .prepare_restore(&mut f.store, input, f.host.clone(), 1, 100, &NoFaults)
        .is_err());
}

#[test]
fn durable_replay_rejects_modified_replacement_ranges_and_source_evidence() {
    for damage in ["ranges", "source", "vector", "content", "candidate"] {
        let mut f = Fixture::new("# Point\n");
        f.edit("# Later\n", 3);
        let input = f.freeze(f.baseline_point.clone());
        let proposal = f.prepare(input.clone()).unwrap();
        let mut receipt = serde_json::to_value(proposal.receipt()).unwrap();
        match damage {
            "ranges" => receipt["replacementRanges"][0]["endClock"] = serde_json::json!(1),
            "source" => {
                receipt["acceptedSources"][0]["accepted"]["receivedAtMs"] = serde_json::json!(99)
            }
            "vector" => receipt["afterStateVector"] = serde_json::json!([0]),
            "content" => receipt["finalContentDigest"] = serde_json::json!("f".repeat(64)),
            "candidate" => receipt["candidateDigest"] = serde_json::json!("f".repeat(64)),
            _ => unreachable!(),
        }
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE live_restore_fences SET proposal_json=?1",
                    [receipt.to_string()],
                )
                .map_err(write_sql)
            })
            .unwrap();
        assert!(f.prepare(input).is_err(), "{damage}");
    }
}

#[test]
fn verified_backup_retains_prepared_candidate_and_all_replay_evidence() {
    use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, RealFreeSpace};
    let mut f = Fixture::new("# Point\n");
    f.edit("# Later\n", 3);
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input.clone()).unwrap();
    let BackupOutcome::Verified(record) = create_verified_backup(
        &f.store,
        &f.dir.join("recovery"),
        "proposal",
        "test",
        90,
        &RealFreeSpace,
        &NoFaults,
    )
    .unwrap() else {
        panic!("backup interrupted")
    };
    let mut restored = EngineStore::open(&record.backup_path, 100).unwrap();
    let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
    let replay = owner
        .prepare_restore(
            &mut restored,
            input,
            f.host.clone(),
            1_000_000,
            100,
            &NoFaults,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&proposal).unwrap(),
        serde_json::to_vec(&replay).unwrap()
    );
}

#[test]
fn tagged_restore_preserves_the_selected_projection_after_later_tags_are_cleared() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    for row in fixtures.as_array().unwrap().iter().filter(|row| {
        row["name"].as_str().unwrap().starts_with("tagged") && row["registrationAccepted"] == true
    }) {
        for clear in [false, true] {
            let source = row["markdown"].as_str().unwrap();
            let mut f = Fixture::with_seed(source, row["name"].as_str().unwrap());
            if clear {
                f.edit("# Later untagged content\n", 7);
            }
            let before = f.canonical();
            let input = f.freeze(f.baseline_point.clone());
            let proposal = f.prepare(input.clone()).unwrap();
            let restored = Ydoc::wire();
            restored.apply(proposal.frozen_state_bytes()).unwrap();
            restored.apply(proposal.candidate_bytes()).unwrap();
            let projection = restored.project(ContentKind::Richdoc).unwrap().content;
            assert_eq!(projection, source, "{} clear={clear}", row["name"]);
            assert_eq!(
                restored.preserved_markdown_source(&projection).as_deref(),
                Some(source)
            );
            assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
            assert_eq!(
                serde_json::to_vec(&proposal).unwrap(),
                serde_json::to_vec(&f.prepare(input).unwrap()).unwrap()
            );
        }
    }
}
