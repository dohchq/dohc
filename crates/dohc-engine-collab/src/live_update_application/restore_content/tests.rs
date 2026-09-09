use super::*;
use dohc_engine_storage::{FaultAction, FaultPoint};
use dohc_test_scratch::ScratchDir;
use serde_json::json;

#[test]
fn restore_serialized_byte_refusals_keep_the_configured_budget_error() {
    assert!(matches!(
        Budget { remaining: 1 }.json(&"retained metadata"),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "retained state");
    assert!(matches!(
        Budget { remaining: 1 }.state(&doc),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

#[test]
fn empty_bootstrap_outbox_does_not_require_owner_adoption() {
    let mut f = Fixture::new("baseline");
    let b = &f.binding;
    let outbox =
        crate::owner_outbox::outbox_id(b, &b.lineage_claim_id, &serde_json::to_string(b).unwrap());
    f.store.write_with(&NoFaults,|tx| -> Result<(),ApplicationError> {
        tx.execute("INSERT INTO owner_ydoc_outboxes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?5,?5,?9,'active',0,NULL,1,NULL,NULL,0)",
            params![outbox,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,serde_json::to_string(&b.selector_paths).unwrap(),b.restore_fence_generation,f.doc.encode_full_state().len() as i64]).map_err(write_sql)?;
        Ok(())
    }).unwrap();
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input).unwrap();
    assert!(proposal.receipt().native_sources.is_empty());
}

fn append_history_copies(f: &mut Fixture, copies: i64, bytes: Vec<u8>) -> Vec<LiveUpdateReceipt> {
    let held = f.handle.registration.lock().unwrap();
    let outcome = f
        .store
        .write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
            let start: i64 = tx
                .query_row(
                    "SELECT coalesce(max(event_count),0) FROM live_accepted_updates",
                    [],
                    |r| r.get(0),
                )
                .map_err(read_sql)?;
            let mut receipts = Vec::new();
            for ordinal in start + 1..=start + copies {
                let receipt = LiveUpdateReceipt {
                    delivery_id: format!("history-{ordinal}"),
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: ordinal * 3,
                    accepting_host_epoch: 1,
                };
                let event = AdmittedLiveUpdate {
                    metadata: AdmittedLiveUpdateMetadata {
                        accepted: RelayAcceptedLiveUpdate {
                            receipt: receipt.clone(),
                            binding: f.binding.clone(),
                            authority: ServerDerivedLiveUpdateAuthority::Owner {
                                principal_id: "owner".into(),
                            },
                            received_at_ms: ordinal,
                        },
                        first_seen: vec![],
                    },
                    update_bytes: bytes.clone(),
                };
                event.validate()?;
                accepted_history::append(tx, &held, &event, 100_000_000)?;
                if f.sequence > 0 {
                    insert_application(tx, &held, &event, f.sequence)?;
                }
                receipts.push(receipt);
            }
            Ok(receipts)
        })
        .unwrap();
    let TxnOutcome::Committed(receipts) = outcome else {
        panic!("history append interrupted")
    };
    receipts
}

#[test]
fn accepted_history_checkpoints_bound_lifetime_replay_and_keep_old_delivery_identity() {
    let mut f = Fixture::new("accepted history");
    let bytes = f.doc.encode_full_state();
    let receipts = append_history_copies(&mut f, 4098, bytes);
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let mut budget = Budget {
                remaining: 1_000_000,
            };
            let history =
                accepted_history::read(conn, &held, receipts[4097].journal_cursor, &mut budget, 3)?;
            assert_eq!(history.proof.checkpoint.event_count, 4095);
            assert_eq!(
                history.proof.checkpoint.terminal,
                Some(receipts[4094].clone())
            );
            assert_eq!(history.proof.event_count, 4098);
            assert_eq!(history.proof.suffix.len(), 3);
            assert!(crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &f.doc
            )?);
            let old = accepted_history::accepted_source(
                conn,
                &held,
                &receipts[0].delivery_id,
                &mut budget,
            )?
            .unwrap();
            assert_eq!(old.accepted.receipt, receipts[0]);
            assert!(
                accepted_history::accepted_source(conn, &held, "never-accepted", &mut budget)?
                    .is_none()
            );
            assert!(accepted_history::read(
                conn,
                &held,
                receipts[4097].journal_cursor,
                &mut Budget {
                    remaining: 1_000_000
                },
                2
            )
            .is_err());
            assert!(accepted_history::read(
                conn,
                &held,
                receipts[4097].journal_cursor - 1,
                &mut Budget {
                    remaining: 1_000_000
                },
                3
            )
            .is_err());
            assert!(accepted_history::read(
                conn,
                &held,
                receipts[4097].journal_cursor,
                &mut Budget { remaining: 1 },
                3
            )
            .is_err());
            // A historical selection and its evidence are independent of the latest checkpoint.
            let point = accepted_history::read(
                conn,
                &held,
                receipts[1].journal_cursor,
                &mut Budget {
                    remaining: 1_000_000,
                },
                2,
            )?;
            assert_eq!(point.proof.event_count, 2);
            assert_eq!(point.proof.checkpoint.event_count, 0);
            Ok(())
        })
        .unwrap();
    for sql in [
        "UPDATE live_accepted_checkpoints SET terminal_json=json_set(terminal_json,'$.deliveryId','forged') WHERE event_count=4095",
        "UPDATE live_accepted_checkpoints SET evidence_digest=printf('%064d',0) WHERE event_count=4095",
        "UPDATE live_accepted_updates SET suffix_count=1 WHERE event_count=4095",
        "UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.receivedAtMs',999) WHERE event_count=4098",
        "UPDATE live_device_bootstraps SET bootstrap_moment_id='changed-origin'",
        "DELETE FROM live_accepted_checkpoints WHERE event_count=4095",
    ] {
        f.store.write_with(&NoFaults,|tx|->Result<(),ApplicationError>{
            tx.execute_batch("SAVEPOINT damage").map_err(write_sql)?;
            tx.execute(sql,[]).map_err(write_sql)?;
            assert!(accepted_history::read(tx,&held,receipts[4097].journal_cursor,&mut Budget{remaining:1_000_000},3).is_err(),"{sql}");
            tx.execute_batch("ROLLBACK TO damage; RELEASE damage").map_err(write_sql)?;
            Ok(())
        }).unwrap();
    }
    for sql in [
        "UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.receivedAtMs',999) WHERE event_count=1",
        "UPDATE live_accepted_updates SET evidence_digest=printf('%064d',0) WHERE event_count=1",
    ] {
        f.store.write_with(&NoFaults,|tx|->Result<(),ApplicationError>{
            tx.execute_batch("SAVEPOINT old_source_damage").map_err(write_sql)?;
            tx.execute(sql,[]).map_err(write_sql)?;
            assert!(accepted_history::accepted_source(tx,&held,&receipts[0].delivery_id,&mut Budget{remaining:1_000_000}).is_err(),"{sql}");
            tx.execute_batch("ROLLBACK TO old_source_damage; RELEASE old_source_damage").map_err(write_sql)?;
            Ok(())
        }).unwrap();
    }
}

#[test]
fn restore_preparation_uses_native_checkpoints_for_a_long_applied_history() {
    let mut f = Fixture::new("baseline");
    f.edit("accepted current", 3);
    let bytes = f.doc.encode_full_state();
    let receipts = append_history_copies(&mut f, 4097, bytes);
    let terminal = receipts.last().unwrap().clone();
    f.terminal = Some(terminal.clone());
    let selected = point(&f.doc, terminal.journal_cursor, terminal.update_digest);
    let input = f.freeze(selected);
    let proposal = f
        .owner
        .prepare_restore(
            &mut f.store,
            input.clone(),
            f.host.clone(),
            1_000_000,
            6,
            &NoFaults,
        )
        .unwrap();
    assert_eq!(
        proposal.receipt().accepted_history.checkpoint.event_count,
        4095
    );
    assert_eq!(proposal.receipt().accepted_history.event_count, 4098);
    assert_eq!(proposal.receipt().selected_history.suffix.len(), 3);
    let replay = f
        .owner
        .prepare_restore(&mut f.store, input, f.host.clone(), 1_000_000, 6, &NoFaults)
        .unwrap();
    assert_eq!(replay.receipt(), proposal.receipt());
}

#[test]
fn due_accepted_checkpoint_refuses_small_working_reserve_and_rolls_back_the_application() {
    let mut f = Fixture::new("baseline");
    f.edit("accepted", 3);
    let bytes = f.doc.encode_full_state();
    append_history_copies(&mut f, 4093, bytes.clone());
    let snapshot = |store: &EngineStore| {
        store.read_with(|conn|conn.query_row(
        "SELECT (SELECT count(*) FROM live_accepted_updates),(SELECT max(event_count) FROM live_accepted_updates),(SELECT count(*) FROM live_accepted_checkpoints),(SELECT count(*) FROM live_device_update_applications),(SELECT count(*) FROM binary_blobs),(SELECT head_update_seq FROM ydoc_docs),(SELECT count(*) FROM owner_ydoc_outbox_entries)",[],
        |r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?)))).unwrap()
    };
    let before = snapshot(&f.store);
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "due".into(),
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: 20_000,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 20_000,
            },
            first_seen: vec![],
        },
        update_bytes: bytes,
    };
    let (checkpoint_metadata, baseline_bytes, history_bytes, prior_metadata): (usize, usize, usize, usize) = f.store.read_with(|conn| conn.query_row(
        "SELECT (SELECT length(CAST(terminal_json AS BLOB))+length(CAST(binding_json AS BLOB)) FROM live_accepted_checkpoints WHERE event_count=0),(SELECT byte_length FROM binary_blobs WHERE sha256=(SELECT state_sha256 FROM live_accepted_checkpoints WHERE event_count=0)),(SELECT sum(length(CAST(a.metadata_json AS BLOB))+b.byte_length) FROM live_accepted_updates a JOIN binary_blobs b ON b.sha256=a.update_sha256),(SELECT length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates ORDER BY event_count DESC LIMIT 1)",[],|r|Ok((r.get::<_,i64>(0)? as usize,r.get::<_,i64>(1)? as usize,r.get::<_,i64>(2)? as usize,r.get::<_,i64>(3)? as usize)))).unwrap();
    let replay_bytes = checkpoint_metadata
        + baseline_bytes
        + history_bytes
        + serde_json::to_vec(&event.metadata).unwrap().len()
        + event.update_bytes.len()
        + f.doc.encode_full_state().len();
    let retained_metadata = checkpoint_metadata + prior_metadata;
    let sufficient = replay_bytes + retained_metadata;
    // Replay alone fits, but the checkpoint and prior binding remain live too.
    for reserve in [4096, 1_000_000, replay_bytes, sufficient - 1] {
        assert!(
            matches!(
                apply_committed(
                    &mut f.store,
                    &mut WriterDocCache::new(),
                    &f.handle,
                    event.clone(),
                    &NoFaults,
                    reserve
                ),
                Err(ApplicationError::ConfiguredByteBudgetExceeded)
            ),
            "accepted under {reserve} bytes; requires {sufficient}"
        );
        assert_eq!(snapshot(&f.store), before);
    }
    let key = DocKey::new("workspace", "main", "object").unwrap();
    assert!(f
        .store
        .read_with(|conn| crate::replay_parity::structurally_equal_v2(
            &durable::load_doc_in(conn, &key)?,
            &f.doc
        ))
        .unwrap());
    assert!(matches!(
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event,
            &NoFaults,
            sufficient
        )
        .unwrap(),
        ApplicationResult::Applied(_)
    ));
    let after = snapshot(&f.store);
    assert_eq!(after.0, 4095);
    assert_eq!(after.2, 2);
}

#[test]
fn accepted_history_checkpoints_follow_byte_cadence_without_a_local_pending_snapshot() {
    let mut f = Fixture::new(&"a".repeat(524_288));
    let baseline = f.doc.encode_full_state();
    let due = (20_971_520_u64).div_ceil(baseline.len() as u64) as i64;
    assert!(due < 4095);
    let pending = f
        .doc
        .rewrite_content_to_markdown_preserving_source(
            ContentKind::Richdoc,
            "unaccepted native work",
        )
        .unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            durable::record_update_in_tx(tx, &key, &pending, None, None, 99)
        })
        .unwrap();
    let receipts = append_history_copies(&mut f, due + 1, baseline.clone());
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let history = accepted_history::read(
                conn,
                &held,
                receipts[due as usize].journal_cursor,
                &mut Budget {
                    remaining: 40_000_000,
                },
                1,
            )?;
            assert_eq!(history.proof.checkpoint.event_count, due);
            assert_eq!(history.proof.suffix.len(), 1);
            let accepted = Ydoc::wire();
            accepted.apply(&baseline)?;
            assert!(crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &accepted
            )?);
            assert!(!crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &f.doc
            )?);
            assert!(crate::replay_parity::structurally_equal_v2(
                &durable::load_doc_in(conn, &key)?,
                &f.doc
            )?);
            Ok(())
        })
        .unwrap();
}

pub(in crate::live_update_application) fn record_test_projection(
    store: &mut EngineStore,
    audit: &LiveSettlementAudit,
    moment: &str,
) -> Result<LiveSettlementResult, ApplicationError> {
    let b = audit.binding();
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let doc = store.read_with(|conn| durable::load_doc_in(conn, &key))?;
    let projected = doc.project(ContentKind::Richdoc)?.content;
    let content = doc
        .preserved_markdown_source(&projected)
        .unwrap_or(projected);
    let vector = hex_sha256(&doc.encode_state_vector());
    let result = store.write_with(&NoFaults,|tx| -> Result<_, ApplicationError> {
        let written = dohc_engine_domain::write_projected_text_in_tx(tx,dohc_engine_domain::ProjectedWriteText {
            workspace_id:&b.workspace_id,version_id:&b.main_version_id,object_id:&b.object_id,path:std::borrow::Cow::Borrowed(&b.current_path),text:std::borrow::Cow::Borrowed(&content),moment_id:moment,metadata_origin:"ydoc",metadata_summary:None,metadata_correlation_id:None,author_json:None,now_ms:90,request_id:None,
        }).map_err(|_|ApplicationError::Corrupt)?;
        tx.execute("UPDATE ydoc_docs SET last_settled_sha=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id,written.snapshot.blob_sha256]).map_err(write_sql)?;
        let id=audit.record_in_tx(tx,moment,&written.snapshot.blob_sha256,&vector,90)?;
        Ok(audit.result(id,moment.into(),written.snapshot.blob_sha256,false))
    })?;
    let TxnOutcome::Committed(result) = result else {
        return Err(ApplicationError::Interrupted);
    };
    Ok(result)
}

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
            100_000_000,
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
        NativeRestorePreparation { fence, point }
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
    assert_eq!(proposal.receipt().accepted_history.suffix.len(), 2);
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
                receipt["acceptedHistory"]["suffix"][0]["accepted"]["receivedAtMs"] =
                    serde_json::json!(99)
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

fn admitted_restore(
    f: &mut Fixture,
    preparation: NativeRestorePreparation,
) -> NativeRestoreApplication {
    let proposal = f.prepare(preparation.clone()).unwrap();
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = preparation.fence.operation.new_fence;
    NativeRestoreApplication {
        preparation,
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "restore-delivery".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: 71,
                    accepting_host_epoch: 3,
                },
                binding,
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "restoring-owner".into(),
                },
                received_at_ms: 80,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
        },
    }
}

fn apply_restore(
    f: &mut Fixture,
    input: NativeRestoreApplication,
    faults: &dyn FaultInjector,
) -> Result<NativeRestoreApplicationReceipt, ApplicationError> {
    f.owner.apply_restore(
        &mut f.store,
        &mut WriterDocCache::new(),
        input,
        f.host.clone(),
        2_000_000,
        100,
        90,
        faults,
    )
}

#[test]
fn native_restore_apply_commits_once_and_replays_the_original_operation_after_restart() {
    let mut f = Fixture::new("# Original\n");
    let selected = f.edit("# Chosen\n", 7);
    f.edit("# Later\n", 11);
    let prep = f.freeze(selected);
    let input = admitted_restore(&mut f, prep.clone());
    let receipt = apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
    assert_eq!(receipt.local_head_sequence, 3);
    assert_eq!(receipt.admitted, input.admitted);
    let projected = f.canonical().project(ContentKind::Richdoc).unwrap().content;
    assert_eq!(
        f.canonical()
            .preserved_markdown_source(&projected)
            .as_deref(),
        Some("# Chosen\n")
    );
    assert_eq!(
        receipt,
        apply_restore(&mut f, input.clone(), &NoFaults).unwrap()
    );
    assert_eq!(
        f.store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        3
    );
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    assert_eq!(
        f.owner
            .fence_restore(
                &mut f.store,
                prep.fence.operation.clone(),
                f.host.clone(),
                100,
                &NoFaults
            )
            .unwrap(),
        prep.fence
    );
    let proposal = f.prepare(prep.clone()).unwrap();
    assert_eq!(proposal.receipt().candidate_digest, input.candidate_digest);
    drop(f.store);
    f.store = EngineStore::open(&f.dir.join("engine.db"), 110).unwrap();
    f.owner = ApplicationOwner::new("workspace".into()).unwrap();
    f.host.connection_id = "new-connection".into();
    f.host.host_epoch = 2;
    assert_eq!(receipt, apply_restore(&mut f, input, &NoFaults).unwrap());
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
}

#[test]
fn native_restore_apply_refuses_changed_admission_before_and_after_commit() {
    for replay in [false, true] {
        for change in 0..8 {
            let mut f = Fixture::new("# Original\n");
            f.edit("# Later\n", 7);
            let prep = f.freeze(f.baseline_point.clone());
            let mut input = admitted_restore(&mut f, prep);
            if replay {
                apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
            }
            let before = f.canonical();
            let count = f
                .store
                .table_row_count("live_device_update_applications")
                .unwrap();
            match change {
                0 => input.candidate_digest = "a".repeat(64),
                1 => input.native_source_manifest_digest = "a".repeat(64),
                2 => input.admitted.accepted.binding.object_id = "foreign".into(),
                3 => input.admitted.accepted.binding.restore_fence_generation = 0,
                4 => input.admitted.accepted.receipt.journal_cursor = 7,
                5 => input.admitted.first_seen.clear(),
                6 => input.preparation.fence.operation.operation_id = "foreign".into(),
                _ => {
                    input.admitted.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
                        principal_id: "named".into(),
                        grant_id: "grant".into(),
                        grant_generation: 1,
                    }
                }
            }
            assert!(
                apply_restore(&mut f, input, &NoFaults).is_err(),
                "change {change}, replay={replay}"
            );
            assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
            assert_eq!(
                f.store
                    .table_row_count("live_device_update_applications")
                    .unwrap(),
                count
            );
        }
    }
}

#[test]
fn native_restore_apply_commit_crashes_preserve_one_candidate_and_one_application() {
    for fault in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new("# Original\n");
        f.edit("# Later\n", 7);
        let prep = f.freeze(f.baseline_point.clone());
        let input = admitted_restore(&mut f, prep);
        assert!(apply_restore(&mut f, input.clone(), &CrashAt(fault)).is_err());
        let receipt = apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
        assert_eq!(receipt.local_head_sequence, 2);
        assert_eq!(receipt, apply_restore(&mut f, input, &NoFaults).unwrap());
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            2
        );
        assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 2);
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
}

#[test]
fn restore_copy_preserves_public_point_actual_rich_marks() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    let row = fixtures
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "rich-unicode")
        .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&serde_json::from_value::<Vec<u8>>(row["bytes"].clone()).unwrap())
        .unwrap();
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    let before = doc.canonical_content();
    let point = Ydoc::wire();
    point.apply(&doc.encode_full_state()).unwrap();
    let before_vector = doc.state_vector();
    doc.rewrite_richdoc_preserving_source_bounded(&projection, &point, 8 * 1024 * 1024)
        .unwrap();
    assert!(doc
        .state_vector()
        .iter()
        .any(|(client, _)| before_vector.get(client) == 0));
    assert_eq!(
        doc.project(ContentKind::Richdoc).unwrap().content,
        projection
    );
    assert_eq!(doc.canonical_content()["body"], before["body"]);
}

#[test]
fn native_restore_apply_replay_refuses_damaged_saved_admission_and_application() {
    for damage in 0..9 {
        let mut f = Fixture::new("# Original\n");
        f.edit("# Later\n", 7);
        let prep = f.freeze(f.baseline_point.clone());
        let input = admitted_restore(&mut f, prep.clone());
        let receipt = apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
        let before = f.canonical();
        f.store.write_with(&NoFaults, |tx| {
            let mut json = serde_json::to_value(&receipt).unwrap();
            match damage {
                0 => json["admitted"]["accepted"]["receivedAtMs"] = json!(987),
                1 => json["admitted"]["accepted"]["authority"]["principalId"] = json!("foreign-owner"),
                2 => json["localHeadSequence"] = json!(99),
                3 => json["candidateDigest"] = json!("a".repeat(64)),
                4 => json["admitted"]["firstSeen"] = json!([]),
                5 => { return tx.execute("UPDATE live_device_update_applications SET first_seen_count=999999 WHERE delivery_id='restore-delivery'", []).map_err(write_sql); }
                6 => { return tx.execute("UPDATE live_device_update_applications SET selector_paths_json=?1 WHERE delivery_id='restore-delivery'", [serde_json::to_string(&vec!["a.md"; 10_000]).unwrap()]).map_err(write_sql); }
                7 => { return tx.execute("UPDATE live_restore_fences SET application_json=NULL,application_delivery_id=NULL", []).map_err(write_sql); }
                _ => { return tx.execute("UPDATE live_restore_fences SET application_json='{}'", []).map_err(write_sql); }
            }
            tx.execute("UPDATE live_restore_fences SET application_json=?1", [json.to_string()]).map_err(write_sql)
        }).unwrap();
        assert!(
            apply_restore(&mut f, input, &NoFaults).is_err(),
            "damage {damage}"
        );
        assert!(f.prepare(prep.clone()).is_err(), "prepare damage {damage}");
        assert!(
            f.owner
                .fence_restore(
                    &mut f.store,
                    prep.fence.operation,
                    f.host.clone(),
                    100,
                    &NoFaults
                )
                .is_err(),
            "fence damage {damage}"
        );
        assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            2
        );
    }
}

#[test]
fn native_restore_fence_replay_checks_candidate_bytes_after_length_precharge() {
    let mut f = Fixture::new("# Original\n");
    f.edit("# Later\n", 7);
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(&mut f, prep.clone());
    let candidate = f.prepare(prep.clone()).unwrap().candidate_bytes().to_vec();
    apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
    let before = f.canonical();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes=zeroblob(byte_length) WHERE sha256=?1",
                [&input.candidate_digest],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(f
        .owner
        .fence_restore(
            &mut f.store,
            prep.fence.operation.clone(),
            f.host.clone(),
            100,
            &NoFaults
        )
        .is_err());
    assert_eq!(
        f.store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        2
    );
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes=?2 WHERE sha256=?1",
                params![input.candidate_digest, candidate],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert_eq!(
        f.owner
            .fence_restore(
                &mut f.store,
                prep.fence.operation.clone(),
                f.host.clone(),
                100,
                &NoFaults
            )
            .unwrap(),
        prep.fence
    );
    assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
}

#[test]
fn native_restore_apply_enforces_budget_on_first_apply_and_replay() {
    for replay in [false, true] {
        let mut f = Fixture::new("# Original\n");
        f.edit("# Later\n", 7);
        let prep = f.freeze(f.baseline_point.clone());
        let input = admitted_restore(&mut f, prep);
        if replay {
            apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
        }
        let before = f.canonical();
        for (bytes, events) in [(1, 100), (2_000_000, 0)] {
            assert!(f
                .owner
                .apply_restore(
                    &mut f.store,
                    &mut WriterDocCache::new(),
                    input.clone(),
                    f.host.clone(),
                    bytes,
                    events,
                    90,
                    &NoFaults
                )
                .is_err());
            assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
        }
        apply_restore(&mut f, input, &NoFaults).unwrap();
    }
}

#[test]
fn ordinary_settlement_starts_at_verified_restore_anchor_under_future_open_binding() {
    let mut f = Fixture::new("# Original\n");
    f.edit("# Later\n", 7);
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(&mut f, prep);
    apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
    let restored = f
        .owner
        .with_restore_settlement(
            &mut f.store,
            input.clone(),
            f.host.clone(),
            2_000_000,
            100,
            |store, audit| record_test_projection(store, audit, "restore-moment"),
        )
        .unwrap();
    assert!(f
        .owner
        .register(
            &mut f.store,
            "namespace".into(),
            f.host.clone(),
            input.admitted.accepted.binding.clone()
        )
        .is_err());
    // Simulate only the registration state a future reopen must authenticate.
    let mut held = f.handle.registration.lock().unwrap();
    held.live = true;
    held.binding = input.admitted.accepted.binding.clone();
    f.store
        .write_with(&NoFaults, |tx| install_binding(tx, &held))
        .unwrap();
    drop(held);
    let replay = with_settlement(
        &mut f.store,
        &f.handle,
        Some(input.admitted.accepted.receipt.clone()),
        100,
        |store, audit| record_test_projection(store, audit, "restore-moment"),
    )
    .unwrap();
    assert_eq!(replay.settlement_id, restored.settlement_id);
    assert_eq!(replay.previous_cursor, restored.previous_cursor);
    assert_eq!(replay.application_count, restored.application_count);
    let before = f.canonical();
    let edited = Ydoc::wire();
    edited.apply(&before.encode_full_state()).unwrap();
    let bytes = edited.richdoc_append_paragraph("Fresh owner edit");
    let mut event = AdmittedLiveUpdate {
        metadata: input.admitted.clone(),
        update_bytes: bytes,
    };
    event.metadata.accepted.receipt.delivery_id = "fresh-delivery".into();
    event.metadata.accepted.receipt.journal_cursor = 82;
    event.metadata.accepted.receipt.update_digest = hex_sha256(&event.update_bytes);
    event.metadata.first_seen.clear();
    let held = f.handle.registration.lock().unwrap();
    let key = DocKey::new(
        &held.binding.workspace_id,
        &held.binding.main_version_id,
        &held.binding.object_id,
    )
    .unwrap();
    f.store
        .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
            let (_, seq, _) = durable::append_and_index_update(
                tx,
                &key,
                ContentKind::Richdoc,
                &before,
                &event.update_bytes,
                &event.metadata.accepted.receipt.update_digest,
                true,
                None,
                None,
                None,
                100,
            )?;
            insert_application(tx, &held, &event, seq)
        })
        .unwrap();
    drop(held);
    let next = with_settlement(
        &mut f.store,
        &f.handle,
        Some(event.metadata.accepted.receipt),
        100,
        |store, audit| record_test_projection(store, audit, "fresh-moment"),
    )
    .unwrap();
    assert_eq!(next.previous_cursor, 71);
    assert_eq!(next.terminal_cursor, 82);
    assert_eq!(next.application_count, 1);
    assert_eq!(
        f.store.table_row_count("live_device_settlements").unwrap(),
        2
    );
}
