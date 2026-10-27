use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{reader_resolver, LeaseRegistry, Ydoc};
use dohc_engine_reader::Reader;
use dohc_engine_domain::WriteText;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

struct Fixture {
    scratch: ScratchDir,
    db: PathBuf,
    supervisor: crate::WorkspaceSupervisor,
    actor: ActorHandle,
    key: DocKey,
    claim: String,
    source: String,
    pending: Arc<reader_resolver::PendingProof>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_reader_source(false).await
    }

    async fn with_reader_source(keep_reader: bool) -> Self {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/reader-resolver.json")).unwrap();
        let source = data["source"].as_str().unwrap().to_owned();
        let wire = yrs::Doc::new();
        wire.transact_mut().apply_update(yrs::Update::decode_v1(
            &STANDARD.decode(data["checkpoint"].as_str().unwrap()).unwrap()).unwrap()).unwrap();
        wire.get_or_insert_map("meta").remove(&mut wire.transact_mut(), "dohcLineageEpoch");
        let checkpoint = wire.transact().encode_state_as_update_v1(&yrs::StateVector::default());
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let key = DocKey::new("w", "main", "note").unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store).ensure_main_version("w", "main", 1, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store).write_text(&WriteText {
            workspace_id: "w".into(), version_id: "main".into(), object_id: "note".into(),
            path: "note.md".into(), text: source.clone(), moment_id: "source".into(),
            metadata_origin: "test".into(), metadata_summary: None, metadata_correlation_id: None,
            author_json: None, now_ms: 2, request_id: None,
        }, &NoFaults).unwrap();
        dohc_engine_collab::claim_base(&mut store, &key, ContentKind::Richdoc, &checkpoint, &NoFaults, 3).unwrap();
        store.write_with(&NoFaults, |tx| tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
            .map_err(StorageError::persist_public)).unwrap();
        let original = dohc_engine_collab::load_persisted(&store, &key).unwrap().unwrap().doc;
        let proof_resolver = reader_resolver::ReaderResolver::new(Arc::new(Reader::new(None)));
        let pending = match store.read_with(|conn| reader_resolver::resolve(conn, &key, &original,
            &original.project(ContentKind::Richdoc)?.content, Some(&proof_resolver))) {
            Err(CollabError::MarkdownReaderPending(pending)) => pending,
            _ => panic!("expected a snapshot proof to control the rollback retry"),
        };
        let before = wire.transact().state_vector();
        if !keep_reader {
            wire.get_or_insert_map("meta").remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
        }
        let doc = Ydoc::wire();
        doc.apply(&original.encode_full_state()).unwrap();
        doc.apply(&wire.transact().encode_state_as_update_v1(&before)).unwrap();
        doc.richdoc_append_paragraph("Accepted text remains available");
        store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
            tx, &key, &doc.encode_full_state(), None, None, 4)).unwrap();
        let claim = dohc_engine_collab::read_marker(&store, &key).unwrap().unwrap().lineage_claim_id.unwrap();
        drop(store);
        std::fs::write(scratch.path().join("note.md"), &source).unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 5).unwrap().actor;
        let config = super::super::reader_tests::fake_reader(&scratch, "witness-unsafe");
        actor.configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            Arc::new(Reader::new(Some(config)))))).await.unwrap();
        Self { scratch, db, supervisor, actor, key, claim, source, pending }
    }

    fn consent(&self) -> Arc<MarkdownConversionConsent> {
        Arc::new(MarkdownConversionConsent::new(self.key.clone(), "owner-session".into(),
            Some(self.claim.clone()), None, hex_sha256(self.source.as_bytes()), Some(hex_sha256(self.source.as_bytes()))))
    }

    async fn settle(&self, queued: bool, consent: Option<Arc<MarkdownConversionConsent>>) -> Result<YdocSettleOutcome, RuntimeError> {
        if queued {
            self.actor.ydoc_settle_queued(self.scratch.path().to_owned(), self.key.clone(), "note.md".into(),
                ContentKind::Richdoc, Some(self.claim.clone()), Some(hex_sha256(self.source.as_bytes())),
                "owner-session".into(), Arc::new(()), 10, Arc::new(NoFaults), CancellationToken::new(), None, consent).await
        } else {
            self.actor.ydoc_settle(self.scratch.path().to_owned(), self.key.clone(), "note.md".into(),
                ContentKind::Richdoc, Some(self.claim.clone()), Some(hex_sha256(self.source.as_bytes())),
                "owner-session".into(), Arc::new(()), 10, Arc::new(NoFaults), CancellationToken::new(), None, consent).await
        }
    }

    async fn unchanged(&self) {
        let source = self.source.clone();
        let key = self.key.clone();
        self.actor.run(move |store, _| {
            assert_eq!(store.table_row_count("moments")?, 1);
            assert_eq!(store.table_row_count("materialization_jobs")?, 0);
            assert_eq!(store.table_row_count("live_device_settlements")?, 0);
            let snapshot = VersionedTextStore::new(store).read_text("w", "main", "note.md")?.unwrap();
            assert_eq!(snapshot.text, source);
            let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
            assert!(doc.project(ContentKind::Richdoc)?.content.contains("Accepted text remains available"));
            Ok(())
        }).await.unwrap();
        assert_eq!(std::fs::read_to_string(self.scratch.path().join("note.md")).unwrap(), self.source);
    }

    async fn adopt(&self) {
        let key = self.key.clone();
        let source_sha = hex_sha256(self.source.as_bytes());
        let source_length = self.source.len() as i64;
        let binding = dohc_engine_collab::live_object_binding::LiveObjectBinding {
            workspace_id: "w".into(), main_version_id: "main".into(), object_id: "note".into(),
            lineage_claim_id: self.claim.clone(), current_path: "note.md".into(),
            selector_paths: vec!["note.md".into()], restore_fence_generation: 0,
        };
        self.actor.run(move |store, _| {
            let marker = dohc_engine_collab::read_marker(store, &key)?.unwrap();
            store.write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO ydoc_owner_base_sources(workspace_id,version_id,object_id,lineage_claim_id,\
                    path,source_moment_id,source_blob_sha256,source_byte_length) VALUES ('w','main','note',?1,\
                    'note.md','source',?2,?3)", params![binding.lineage_claim_id,source_sha,source_length])
                    .map_err(StorageError::persist_public)?;
                tx.execute(
                "INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,\
                 object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,\
                 baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,\
                 covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,\
                 max_pending_bytes,max_pending_age_ms) VALUES ('relay','adoption','w','main','note',?1,?2,'source',?3,?4,\
                 0,0,?3,?3,0,?5,0,'null','{}',1000000,1000000)",
                params![binding.lineage_claim_id, serde_json::to_string(&binding).unwrap(), source_sha,
                    source_length, marker.head_update_seq]).map_err(StorageError::persist_public)
            })?;
            Ok(())
        }).await.unwrap();
    }

    async fn audited_host(&self) -> (crate::actor::ActorLiveApplicationOwner, crate::actor::ActorLiveApplicationHandle) {
        let owner = self.actor.live_application_owner("w".into()).await.unwrap();
        let handle = owner.register("relay".into(),
            dohc_engine_collab::live_update_application::ApplicationHostCoordinate {
                host_id: "host".into(), host_epoch: 1, instance_id: "instance".into(), connection_id: "connection".into(),
            }, dohc_engine_collab::live_object_binding::LiveObjectBinding {
                workspace_id: "w".into(), main_version_id: "main".into(), object_id: "note".into(),
                lineage_claim_id: self.claim.clone(), current_path: "note.md".into(),
                selector_paths: vec!["note.md".into()], restore_fence_generation: 0,
            }).await.unwrap();
        (owner, handle)
    }

    async fn audited_settle(&self, handle: &crate::actor::ActorLiveApplicationHandle,
        consent: Option<Arc<MarkdownConversionConsent>>,
    ) -> Result<dohc_engine_collab::live_update_application::LiveSettlementResult, RuntimeError> {
        self.audit_at(handle, None, 100, consent).await
    }

    async fn audit_at(&self, handle: &crate::actor::ActorLiveApplicationHandle,
        terminal: Option<dohc_engine_collab::live_update_application::LiveUpdateReceipt>, max: usize,
        consent: Option<Arc<MarkdownConversionConsent>>,
    ) -> Result<dohc_engine_collab::live_update_application::LiveSettlementResult, RuntimeError> {
        handle.settle_with_consent(terminal, max, self.scratch.path().to_owned(), 10, Arc::new(NoFaults),
            CancellationToken::new(), dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                }, reservation: Arc::new(()),
            }, consent).await
    }

    fn event(&self, cursor: i64, bytes: Vec<u8>)
        -> dohc_engine_collab::live_update_application::AdmittedLiveUpdate {
        use dohc_engine_collab::live_update_application::*;
        AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt { delivery_id: format!("delivery-{cursor}"),
                        update_digest: hex_sha256(&bytes), journal_cursor: cursor, accepting_host_epoch: 1 },
                    binding: dohc_engine_collab::live_object_binding::LiveObjectBinding {
                        workspace_id: "w".into(), main_version_id: "main".into(), object_id: "note".into(),
                        lineage_claim_id: self.claim.clone(), current_path: "note.md".into(),
                        selector_paths: vec!["note.md".into()], restore_fence_generation: 0,
                    }, authority: ServerDerivedLiveUpdateAuthority::Owner { principal_id: "owner".into() },
                    received_at_ms: 10,
                }, first_seen: vec![], canonical_version: None, author_snapshot: None,
                first_seen_deletes: None, checkpoint_coverage: None,
            }, update_bytes: bytes,
        }
    }
}

#[tokio::test]
async fn markdown_hold_session_and_queue_preserve_edits_until_consented_once() {
    for queued in [false, true] {
        let f = Fixture::new().await;
        for _ in 0..2 {
            assert!(matches!(f.settle(queued, None).await, Err(RuntimeError::MarkdownWriteHeld { .. })));
            f.unchanged().await;
        }
        let grant = f.consent();
        assert!(f.settle(queued, Some(grant.clone())).await.unwrap().settled().unwrap().materialized);
        assert!(grant.is_consumed());
        let key = f.key.clone();
        f.actor.run(move |store, _| {
            assert_eq!(store.table_row_count("moments")?, 2);
            assert_eq!(store.table_row_count("materialization_jobs")?, 1);
            let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, WriteObligationKind::WitnessRefresh);
            assert_eq!(owed[0].key, key);
            Ok(())
        }).await.unwrap();
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_consent_rollback_retries_after_witness_and_journal_preparation() {
    for queued in [false, true] {
    let f = Fixture::new().await;
    let grant = f.consent();
    let pending = f.pending.clone();
    let consent = grant.clone();
    let reran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let checked = reran.clone();
    f.actor.run(move |_, _| {
        MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |conn| {
            assert!(!consent.is_consumed());
            let debt = write_obligations::pending_in(conn, "w")?;
            assert_eq!(debt.len(), 1);
            assert_eq!(debt[0].kind, WriteObligationKind::WitnessRefresh);
            MARKDOWN_BEFORE_SETTLE.with(|slot| *slot.borrow_mut() = Some(Box::new(move |store| {
                assert!(!consent.is_consumed());
                assert_eq!(store.table_row_count("moments")?, 1);
                assert_eq!(store.table_row_count("materialization_jobs")?, 0);
                assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
                assert_eq!(owed.len(), 1);
                assert_eq!(owed[0].kind, WriteObligationKind::Session);
                assert!(owed[0].held_checkpoint_sha256.is_none());
                checked.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })));
            Err(CollabError::MarkdownReaderPending(pending).into())
        })));
        Ok(())
    }).await.unwrap();
    assert!(f.settle(queued, Some(grant.clone())).await.unwrap().settled().unwrap().materialized);
    assert!(reran.load(std::sync::atomic::Ordering::Acquire));
    assert!(grant.is_consumed());
    f.actor.run(|store, _| {
        assert_eq!(store.table_row_count("moments")?, 2);
        assert_eq!(store.table_row_count("materialization_jobs")?, 1);
        assert_eq!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.len(), 1);
        Ok(())
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_adopted_owner_session_owes_an_audited_settle_after_restart() {
    let f = Fixture::new().await;
    f.adopt().await;
    let grant = f.consent();
    for queued in [false, true] {
        assert!(matches!(f.settle(queued, Some(grant.clone())).await,
            Err(RuntimeError::MarkdownWriteHeld { .. })));
        assert!(!grant.is_consumed());
        f.unchanged().await;
    }
    let key = f.key.clone();
    let held_sequence = f.actor.run(move |store, _| {
        let marker = dohc_engine_collab::read_marker(store, &key)?.unwrap();
        let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, WriteObligationKind::AuditedSettle);
        let retry: write_obligations::AuditedRetry = serde_json::from_value(owed[0].retry_inputs.clone()).unwrap();
        assert_eq!(retry.terminal_cursor, 0);
        assert_eq!(retry.head_update_seq, marker.head_update_seq);
        Ok(marker.head_update_seq)
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
    let store = EngineStore::open(&f.db, 20).unwrap();
    let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w")).unwrap();
    assert_eq!(owed.len(), 1);
    let retry: write_obligations::AuditedRetry = serde_json::from_value(owed[0].retry_inputs.clone()).unwrap();
    assert_eq!(retry.head_update_seq, held_sequence);
    assert!(!store.read_with(|conn| retry.covered_in(conn)).unwrap());
    assert!(!grant.is_consumed());
}

#[tokio::test]
async fn markdown_hold_adopted_owner_still_refuses_an_ordinary_noop() {
    let f = Fixture::new().await;
    let grant = f.consent();
    f.settle(false, Some(grant)).await.unwrap().settled().unwrap();
    f.adopt().await;
    assert!(matches!(f.settle(false, None).await,
        Err(RuntimeError::Collab(CollabError::OwnerOutboxFrozen))));
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_audited_consent_rolls_back_pending_journal_then_commits_once() {
    let f = Fixture::new().await;
    f.adopt().await;
    let (_owner, host) = f.audited_host().await;
    let grant = f.consent();
    let pending = f.pending.clone();
    let consent = grant.clone();
    let reran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let checked = reran.clone();
    f.actor.run(move |_, _| {
        MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |conn| {
            assert!(!consent.is_consumed());
            let owed = write_obligations::pending_in(conn, "w")?;
            assert_eq!(owed.iter().filter(|row| row.kind == WriteObligationKind::WitnessRefresh).count(), 1);
            assert_eq!(conn.query_row("SELECT count(*) FROM live_device_settlements", [],
                |row| row.get::<_, i64>(0)).unwrap(), 1);
            MARKDOWN_BEFORE_SETTLE.with(|slot| *slot.borrow_mut() = Some(Box::new(move |store| {
                assert!(!consent.is_consumed());
                assert_eq!(store.table_row_count("moments")?, 1);
                assert_eq!(store.table_row_count("materialization_jobs")?, 0);
                assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
                assert_eq!(owed.len(), 1);
                assert_eq!(owed[0].kind, WriteObligationKind::AuditedSettle);
                assert!(owed[0].held_checkpoint_sha256.is_none());
                checked.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })));
            Err(CollabError::MarkdownReaderPending(pending).into())
        })));
        Ok(())
    }).await.unwrap();
    assert!(f.audited_settle(&host, Some(grant.clone())).await.unwrap().materialized);
    assert!(reran.load(std::sync::atomic::Ordering::Acquire));
    assert!(grant.is_consumed());
    f.actor.run(|store, _| {
        assert_eq!(store.table_row_count("moments")?, 2);
        assert_eq!(store.table_row_count("materialization_jobs")?, 1);
        assert_eq!(store.table_row_count("live_device_settlements")?, 1);
        let debt = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert_eq!(debt.len(), 1);
        assert_eq!(debt[0].kind, WriteObligationKind::WitnessRefresh);
        Ok(())
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_audited_stale_and_conflict_rollbacks_leave_consent_available() {
    for stale in [false, true] {
        let f = Fixture::new().await;
        f.adopt().await;
        let (_owner, host) = f.audited_host().await;
        let grant = f.consent();
        let consent = grant.clone();
        f.actor.run(move |_, _| {
            MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |conn| {
                assert!(!consent.is_consumed());
                let owed = write_obligations::pending_in(conn, "w")?;
                assert_eq!(owed.iter().filter(|row| row.kind == WriteObligationKind::WitnessRefresh).count(), 1);
                Err(if stale { DomainError::ConflictStaleTarget.into() }
                    else { DomainError::InvalidInput { reason: "ydoc-conflict-open" }.into() })
            })));
            Ok(())
        }).await.unwrap();
        assert!(f.audited_settle(&host, Some(grant.clone())).await.is_err());
        assert!(!grant.is_consumed());
        f.unchanged().await;
        f.actor.run(|store, _| {
            let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, WriteObligationKind::AuditedSettle);
            assert!(owed[0].held_checkpoint_sha256.is_none());
            Ok(())
        }).await.unwrap();
        assert!(f.audited_settle(&host, Some(grant.clone())).await.unwrap().materialized);
        assert!(grant.is_consumed());
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_audited_noop_pending_never_uses_fresh_consent_or_adds_debt() {
    let f = Fixture::new().await;
    f.adopt().await;
    let (_owner, host) = f.audited_host().await;
    f.audited_settle(&host, Some(f.consent())).await.unwrap();
    let grant = f.actor.ydoc_conversion_consent(f.key.clone(), "note.md".into(), "owner-session".into(),
        Some(f.claim.clone()), None, hex_sha256(f.source.as_bytes()), CancellationToken::new()).await.unwrap();
    let pending = f.pending.clone();
    f.actor.run(move |_, _| {
        MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |_| {
            Err(CollabError::MarkdownReaderPending(pending).into())
        })));
        Ok(())
    }).await.unwrap();
    f.audited_settle(&host, Some(grant.clone())).await.unwrap();
    assert!(!grant.is_consumed());
    f.actor.run(|store, _| {
        assert_eq!(store.table_row_count("moments")?, 2);
        assert_eq!(store.table_row_count("materialization_jobs")?, 1);
        assert_eq!(store.table_row_count("live_device_settlements")?, 1);
        assert_eq!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.len(), 1);
        Ok(())
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_audited_latest_terminal_covers_older_debt_and_bounds_admission() {
    use dohc_engine_collab::live_update_application::{ApplicationPending, ApplicationResult};
    let f = Fixture::new().await;
    f.adopt().await;
    let (_owner, host) = f.audited_host().await;
    let key = f.key.clone();
    let checkpoint = f.actor.run(move |store, _| Ok(dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc.encode_full_state()))
        .await.unwrap();
    let producer = Ydoc::wire();
    producer.apply(&checkpoint).unwrap();
    let first = f.event(1, producer.richdoc_append_paragraph("First accepted visitor edit"));
    let first_receipt = first.metadata.accepted.receipt.clone();
    assert!(matches!(host.apply_with_reservation(first, Arc::new(NoFaults), None,
        8 * 1024 * 1024, Some(2)).await.unwrap(), ApplicationResult::Applied(_, _)));
    assert!(matches!(f.audit_at(&host, Some(first_receipt), 2, None).await,
        Err(RuntimeError::MarkdownWriteHeld { .. })));
    f.unchanged().await;
    let second = f.event(2, producer.richdoc_append_paragraph("Second accepted visitor edit"));
    let terminal = second.metadata.accepted.receipt.clone();
    assert!(matches!(host.apply_with_reservation(second, Arc::new(NoFaults), None,
        8 * 1024 * 1024, Some(2)).await.unwrap(), ApplicationResult::Applied(_, _)));
    let refused = f.event(3, producer.richdoc_append_paragraph("Unaccepted edit waits for capacity"));
    assert!(matches!(host.apply_with_reservation(refused.clone(), Arc::new(NoFaults), None,
        8 * 1024 * 1024, Some(2)).await.unwrap(),
        ApplicationResult::Pending(ApplicationPending::SettlementRequired)));
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        assert_eq!(store.table_row_count("live_device_update_applications")?, 2);
        assert_eq!(store.table_row_count("live_device_settlements")?, 0);
        let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, WriteObligationKind::AuditedSettle);
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        assert!(!doc.project(ContentKind::Richdoc)?.content.contains("Unaccepted edit"));
        Ok(())
    }).await.unwrap();
    let grant = f.consent();
    let saved = f.audit_at(&host, Some(terminal), 2, Some(grant.clone())).await.unwrap();
    assert!(grant.is_consumed());
    assert_eq!(saved.terminal_cursor, 2);
    assert!(saved.materialized);
    let file = std::fs::read_to_string(f.scratch.path().join("note.md")).unwrap();
    assert!(file.contains("First accepted visitor edit") && file.contains("Second accepted visitor edit"));
    f.actor.run(|store, _| {
        let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert!(owed.iter().all(|row| row.kind == WriteObligationKind::WitnessRefresh));
        assert_eq!(store.table_row_count("live_device_settlements")?, 1);
        Ok(())
    }).await.unwrap();
    assert!(matches!(host.apply_with_reservation(refused, Arc::new(NoFaults), None,
        8 * 1024 * 1024, Some(2)).await.unwrap(), ApplicationResult::Applied(_, _)));
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_author_capacity_keeps_coverage_and_retries_only_after_consent_settles() {
    use dohc_engine_collab::author_coverage;
    use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
    let f = Fixture::new().await;
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        let mut authors = vec![serde_json::json!({"kind":"unattributed"})];
        authors.extend((1..author_coverage::MAX_INTERVAL_AUTHORS).map(|i|
            serde_json::json!({"kind":"human","humanId":format!("human-{i}")})));
        store.write_with(&NoFaults, |tx| tx.execute(
            "UPDATE ydoc_docs SET pending_authors_json=?1 WHERE workspace_id=?2 AND version_id=?3 AND object_id=?4",
            params![serde_json::to_string(&authors).unwrap(),key.workspace_id,key.version_id,key.object_id])
            .map_err(StorageError::persist_public))?;
        Ok(())
    }).await.unwrap();
    for _ in 0..2 { assert!(matches!(f.settle(true, None).await, Err(RuntimeError::MarkdownWriteHeld { .. }))); }
    let append = |actor: &str| {
        let key = f.key.clone();
        let actor = actor.to_owned();
        move |store: &mut EngineStore, cache: &mut WriterDocCache| {
            let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
            let update = doc.richdoc_append_paragraph("Capacity-tested edit");
            let attribution = ChangeAttribution { actor_kind: ChangeActorKind::Human,
                on_behalf_of: None, depth: 0, run: None };
            dohc_engine_collab::record_local_update(store, cache, &key, &update,
                dohc_engine_collab::LocalAppend { actor_origin_id: Some(&actor), attribution: Some(&attribution),
                    ..Default::default() }, &NoFaults, 10, |_, _, _| Ok(()))?;
            Ok(())
        }
    };
    assert!(matches!(f.actor.run(append("new-human")).await,
        Err(RuntimeError::Collab(CollabError::AuthorCapacity))));
    f.actor.run(append("human-1")).await.unwrap();
    f.unchanged().await;
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        assert_eq!(store.read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))?.len(),
            author_coverage::MAX_INTERVAL_AUTHORS);
        Ok(())
    }).await.unwrap();
    f.settle(true, Some(f.consent())).await.unwrap().settled().unwrap();
    f.actor.run(append("new-human")).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
}

struct RecoveryRoot(PathBuf);
impl WorkspaceRootGuard for RecoveryRoot {
    fn validate(&self, root: &std::path::Path) -> Result<(), RuntimeError> {
        assert_eq!(root, self.0);
        assert!(root.is_dir());
        Ok(())
    }
}

#[tokio::test]
async fn markdown_hold_no_session_recovery_reopens_debt_without_reappending_accepted_edits() {
    let mut f = Fixture::new().await;
    let modified = std::fs::metadata(f.scratch.path().join("note.md")).unwrap().modified().unwrap();
    assert!(matches!(f.settle(false, None).await, Err(RuntimeError::MarkdownWriteHeld { .. })));
    f.supervisor.close(&f.db).unwrap();
    f.actor = f.supervisor.open(&f.db, 20).unwrap().actor;
    let resolver = reader_resolver::ReaderResolver::new(Arc::new(Reader::new(Some(
        super::super::reader_tests::fake_reader(&f.scratch, "witness-unsafe")))));
    f.actor.configure_reader_resolver(Arc::new(resolver)).await.unwrap();
    let candidates = f.actor.markdown_recovery_candidates("w".into()).await.unwrap();
    assert_eq!(candidates.len(), 1);
    let owed = candidates[0].obligation.clone();
    let root = f.scratch.path().to_owned();
    assert!(matches!(f.actor.recover_markdown_write(owed.clone(), root.clone(),
        Arc::new(RecoveryRoot(root.clone())), LeaseRegistry::new(), Arc::new(()), 21,
        CancellationToken::new()).await, Err(RuntimeError::MarkdownWriteHeld { .. })));
    f.unchanged().await;
    assert_eq!(std::fs::metadata(root.join("note.md")).unwrap().modified().unwrap(), modified);
    let key = f.key.clone();
    let accepted_sequence = f.actor.run(move |store, _| {
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        let clear = doc.clear_markdown_source_witness();
        store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(tx, &key, &clear, None, None, 22))?;
        Ok(dohc_engine_collab::read_marker(store, &key)?.unwrap().head_update_seq)
    }).await.unwrap();
    let current = f.actor.markdown_recovery_candidates("w".into()).await.unwrap();
    assert_ne!(current[0].fingerprint, candidates[0].fingerprint);
    for now in [23, 24] {
        assert!(f.actor.recover_markdown_write(owed.clone(), root.clone(),
            Arc::new(RecoveryRoot(root.clone())), LeaseRegistry::new(), Arc::new(()), now,
            CancellationToken::new()).await.unwrap());
    }
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        assert!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.is_empty());
        assert_eq!(store.table_row_count("moments")?, 2);
        assert_eq!(store.table_row_count("materialization_jobs")?, 1);
        assert_eq!(dohc_engine_collab::read_marker(store, &key)?.unwrap().head_update_seq, accepted_sequence);
        Ok(())
    }).await.unwrap();
    let saved = std::fs::read_to_string(root.join("note.md")).unwrap();
    assert_eq!(saved.matches("Accepted text remains available").count(), 1);
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_no_session_recovery_keeps_debt_when_an_outside_head_replaces_the_source() {
    let f = Fixture::new().await;
    assert!(matches!(f.settle(false, None).await, Err(RuntimeError::MarkdownWriteHeld { .. })));
    let owed = f.actor.markdown_recovery_candidates("w".into()).await.unwrap().remove(0).obligation;
    f.actor.run(|store, _| {
        VersionedTextStore::new(store).write_text(&WriteText {
            workspace_id: "w".into(), version_id: "main".into(), object_id: "note".into(),
            path: "note.md".into(), text: "Outside change\n".into(), moment_id: "outside".into(),
            metadata_origin: "capture".into(), metadata_summary: None, metadata_correlation_id: None,
            author_json: None, now_ms: 20, request_id: None,
        }, &NoFaults)?;
        Ok(())
    }).await.unwrap();
    let root = f.scratch.path().to_owned();
    std::fs::write(root.join("note.md"), "Outside change\n").unwrap();
    assert!(matches!(f.actor.recover_markdown_write(owed, root.clone(),
        Arc::new(RecoveryRoot(root.clone())), LeaseRegistry::new(), Arc::new(()), 21,
        CancellationToken::new()).await, Err(RuntimeError::Domain(DomainError::ConflictStaleTarget))));
    assert_eq!(std::fs::read_to_string(root.join("note.md")).unwrap(), "Outside change\n");
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        assert_eq!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.len(), 1);
        assert_eq!(store.table_row_count("moments")?, 2);
        assert_eq!(store.table_row_count("materialization_jobs")?, 0);
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        assert!(doc.project(ContentKind::Richdoc)?.content.contains("Accepted text remains available"));
        Ok(())
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_absent_reader_snapshot_refuses_before_the_hold_and_keeps_consent_unused() {
    for unsafe_witness in [false, true] {
        let f = Fixture::with_reader_source(true).await;
        let mode = if unsafe_witness { "witness-unsafe" } else { "witness-safe" };
        f.actor.configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            Arc::new(Reader::new(Some(super::super::reader_tests::fake_reader(&f.scratch, mode)))))))
            .await.unwrap();
        f.actor.run(|store, _| {
            store.write_with(&NoFaults, |tx| tx.execute("DELETE FROM snapshots", [])
                .map_err(StorageError::persist_public))?;
            Ok(())
        }).await.unwrap();
        std::fs::remove_file(f.scratch.path().join("note.md")).unwrap();
        let grant = Arc::new(MarkdownConversionConsent::new(f.key.clone(), "owner-session".into(),
            Some(f.claim.clone()), None, hex_sha256(f.source.as_bytes()), None));
        assert!(matches!(f.actor.ydoc_settle(f.scratch.path().to_owned(), f.key.clone(), "note.md".into(),
            ContentKind::Richdoc, Some(f.claim.clone()), None, "owner-session".into(), Arc::new(()),
            20, Arc::new(NoFaults), CancellationToken::new(), None, Some(grant.clone())).await,
            Err(RuntimeError::Collab(CollabError::MarkdownReaderUnavailable))));
        assert!(!grant.is_consumed());
        assert!(!f.scratch.path().join("note.md").exists());
        let key = f.key.clone();
        f.actor.run(move |store, _| {
            assert_eq!(store.table_row_count("snapshots")?, 0);
            assert_eq!(store.table_row_count("moments")?, 1);
            assert_eq!(store.table_row_count("materialization_jobs")?, 0);
            assert_eq!(store.table_row_count("live_device_settlements")?, 0);
            assert!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.is_empty());
            let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
            assert!(doc.project(ContentKind::Richdoc)?.content.contains("Accepted text remains available"));
            Ok(())
        }).await.unwrap();
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_absent_head_without_reader_source_still_reaches_the_session_guard() {
    let f = Fixture::new().await;
    f.actor.run(|store, _| {
        store.write_with(&NoFaults, |tx| tx.execute("DELETE FROM snapshots", [])
            .map_err(StorageError::persist_public))?;
        Ok(())
    }).await.unwrap();
    std::fs::remove_file(f.scratch.path().join("note.md")).unwrap();
    assert!(matches!(f.actor.ydoc_settle(f.scratch.path().to_owned(), f.key.clone(), "note.md".into(),
        ContentKind::Richdoc, Some(f.claim.clone()), None, "owner-session".into(), Arc::new(()),
        20, Arc::new(NoFaults), CancellationToken::new(), None, None).await,
        Err(RuntimeError::MarkdownWriteHeld { head_sha256: None, .. })));
    assert!(!f.scratch.path().join("note.md").exists());
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        assert_eq!(store.table_row_count("snapshots")?, 0);
        assert_eq!(store.table_row_count("moments")?, 1);
        assert_eq!(store.table_row_count("materialization_jobs")?, 0);
        assert_eq!(store.table_row_count("live_device_settlements")?, 0);
        let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, WriteObligationKind::Session);
        assert_eq!(owed[0].held_head_sha256, None);
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        assert!(doc.project(ContentKind::Richdoc)?.content.contains("Accepted text remains available"));
        Ok(())
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_witness_verdict_reuses_source_identity_across_edits_but_rechecks_a_new_import() {
    let f = Fixture::new().await;
    let reader = Arc::new(Reader::new(Some(super::super::reader_tests::fake_reader(&f.scratch, "witness-unsafe"))));
    f.actor.configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(reader.clone()))).await.unwrap();
    for index in 0..2 {
        assert!(matches!(f.settle(false, None).await, Err(RuntimeError::MarkdownWriteHeld { .. })));
        assert_eq!(reader.dispatch_count(), 1);
        let key = f.key.clone();
        f.actor.run(move |store, _| {
            let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
            let update = doc.richdoc_append_paragraph(&format!("Later accepted edit {index}"));
            store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 21))?;
            Ok(())
        }).await.unwrap();
    }
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        let update = doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "A different import\n")?;
        store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(tx, &key, &update, None, None, 22))?;
        Ok(())
    }).await.unwrap();
    let key = f.key.clone();
    assert!(!f.actor.run_with_reader_retry(move |store, cache| {
        let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
        Ok(markdown_write_safety::check_witness(&doc, &key, "note.md", cache.reader_resolver.as_deref())?)
    }).await.unwrap());
    assert_eq!(reader.dispatch_count(), 2);
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_third_preparation_stays_pending_without_consuming_consent_or_refresh_debt() {
    let f = Fixture::new().await;
    let grant = f.consent();
    let proof = f.pending.clone();
    let key = f.key.clone();
    f.actor.run(move |_, _| {
        MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |_| {
            MARKDOWN_BEFORE_SETTLE.with(|slot| *slot.borrow_mut() = Some(Box::new(move |store| {
                let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
                let wire = yrs::Doc::new();
                wire.transact_mut().apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap()).unwrap();
                let before = wire.transact().state_vector();
                wire.get_or_insert_map("meta").insert(&mut wire.transact_mut(),
                    "dohcMarkdownSourceProjectionSha256", "f".repeat(64));
                let update = wire.transact().encode_state_as_update_v1(&before);
                store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
                    tx, &key, &update, None, None, 11))?;
                Ok(())
            })));
            Err(CollabError::MarkdownReaderPending(proof).into())
        })));
        Ok(())
    }).await.unwrap();
    let pending = match f.settle(false, Some(grant.clone())).await {
        Err(RuntimeError::Collab(CollabError::MarkdownWitnessCheckPending { pending, .. })) => pending,
        _ => panic!("a third preparation must leave the foreground save pending"),
    };
    assert!(!grant.is_consumed());
    f.unchanged().await;
    f.actor.run(|store, _| {
        let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, WriteObligationKind::Session);
        assert!(owed[0].held_checkpoint_sha256.is_none());
        Ok(())
    }).await.unwrap();
    pending.resolve().await;
    f.settle(false, Some(grant.clone())).await.unwrap().settled().unwrap();
    assert!(grant.is_consumed());
    f.actor.run(|store, _| {
        assert_eq!(store.table_row_count("moments")?, 2);
        assert_eq!(store.table_row_count("materialization_jobs")?, 1);
        let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, WriteObligationKind::WitnessRefresh);
        Ok(())
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_third_proof_returns_pending_and_wakes_recovery_without_using_consent() {
    for queued in [false, true] {
        let f = Fixture::new().await;
        let grant = f.consent();
        let proof = f.pending.clone();
        let again = proof.clone();
        f.actor.run(move |_, _| {
            MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |_| {
                MARKDOWN_BEFORE_SETTLE.with(|slot| *slot.borrow_mut() = Some(Box::new(move |store| {
                    let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
                    assert_eq!(owed.len(), 1);
                    assert_eq!(owed[0].kind, WriteObligationKind::Session);
                    assert!(owed[0].held_checkpoint_sha256.is_none());
                    MARKDOWN_SETTLEMENT_FAULT.with(|slot| *slot.borrow_mut() = Some(Box::new(move |_| {
                        Err(CollabError::MarkdownReaderPending(again).into())
                    })));
                    Ok(())
                })));
                Err(CollabError::MarkdownReaderPending(proof).into())
            })));
            Ok(())
        }).await.unwrap();
        let epoch = f.actor.markdown_recovery_epoch();
        let modified = std::fs::metadata(f.scratch.path().join("note.md")).unwrap().modified().unwrap();
        assert!(matches!(f.settle(queued, Some(grant.clone())).await,
            Err(RuntimeError::Collab(CollabError::MarkdownReaderPending(_)))));
        assert!(!grant.is_consumed());
        f.unchanged().await;
        assert_eq!(std::fs::metadata(f.scratch.path().join("note.md")).unwrap().modified().unwrap(), modified);
        f.actor.run(|store, _| {
            let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, WriteObligationKind::Session);
            assert!(owed[0].held_checkpoint_sha256.is_none());
            assert!(dohc_engine_sync::list_refusal_notices(store, "w")?.is_empty());
            Ok(())
        }).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            while f.actor.markdown_recovery_epoch() == epoch { tokio::task::yield_now().await; }
        }).await.expect("background proof completion wakes the recovery owner");
        assert!(f.settle(queued, Some(grant.clone())).await.unwrap().settled().unwrap().materialized);
        assert!(grant.is_consumed());
        f.actor.run(|store, _| {
            assert_eq!(store.table_row_count("moments")?, 2);
            assert_eq!(store.table_row_count("materialization_jobs")?, 1);
            let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, WriteObligationKind::WitnessRefresh);
            Ok(())
        }).await.unwrap();
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_safe_expired_and_native_notes_save_without_conversion_consent() {
    for native in [false, true] {
        for absent in [false, true] {
            let f = Fixture::new().await;
            let reader = Arc::new(Reader::new(Some(super::super::reader_tests::fake_reader(&f.scratch, "witness-safe"))));
            f.actor.configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(reader.clone())))
                .await.unwrap();
            let key = f.key.clone();
            f.actor.run(move |store, _| {
                let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
                assert!(doc.preserved_markdown_source(&doc.project(ContentKind::Richdoc)?.content).is_none());
                if native {
                    let update = doc.clear_markdown_source_witness();
                    store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
                        tx, &key, &update, None, None, 9))?;
                }
                if absent {
                    store.write_with(&NoFaults, |tx| tx.execute("DELETE FROM snapshots", [])
                        .map_err(StorageError::persist_public))?;
                }
                Ok(())
            }).await.unwrap();
            if absent { std::fs::remove_file(f.scratch.path().join("note.md")).unwrap(); }
            let saved = f.actor.ydoc_settle(f.scratch.path().to_owned(), f.key.clone(), "note.md".into(),
                ContentKind::Richdoc, Some(f.claim.clone()),
                (!absent).then(|| hex_sha256(f.source.as_bytes())), "owner-session".into(),
                Arc::new(()), 10, Arc::new(NoFaults), CancellationToken::new(), None, None)
                .await.unwrap().settled().unwrap();
            assert!(saved.materialized);
            assert_eq!(reader.dispatch_count(), if native { 0 } else { 1 });
            let file = std::fs::read_to_string(f.scratch.path().join("note.md")).unwrap();
            assert!(file.contains("Accepted text remains available"));
            f.actor.run(|store, _| {
                assert!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.is_empty());
                assert_eq!(store.table_row_count("materialization_jobs")?, 1);
                assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                Ok(())
            }).await.unwrap();
            f.supervisor.close(&f.db).unwrap();
        }
    }
}

#[tokio::test]
async fn markdown_hold_converted_head_allows_ordinary_edits_before_and_after_witness_clear() {
    let f = Fixture::new().await;
    f.settle(false, Some(f.consent())).await.unwrap().settled().unwrap();
    for cleared in [false, true] {
        let key = f.key.clone();
        let head = f.actor.run(move |store, cache| {
            if cleared { refresh_markdown_witnesses_on_store(store, cache, &key, 20)?; }
            let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
            assert_eq!(doc.has_markdown_witness(), !cleared);
            let update = doc.richdoc_append_paragraph(if cleared { "After witness clear" } else { "Before witness clear" });
            store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
                tx, &key, &update, None, None, 21))?;
            Ok(VersionedTextStore::new(store).read_text("w", "main", "note.md")?.unwrap().blob_sha256)
        }).await.unwrap();
        assert_ne!(head, hex_sha256(f.source.as_bytes()));
        assert!(f.actor.ydoc_settle(f.scratch.path().to_owned(), f.key.clone(), "note.md".into(),
            ContentKind::Richdoc, Some(f.claim.clone()), Some(head), "reopened-session".into(),
            Arc::new(()), 22, Arc::new(NoFaults), CancellationToken::new(), None, None)
            .await.unwrap().settled().unwrap().materialized);
    }
    let file = std::fs::read_to_string(f.scratch.path().join("note.md")).unwrap();
    for text in ["Accepted text remains available", "Before witness clear", "After witness clear"] {
        assert_eq!(file.matches(text).count(), 1);
    }
    f.actor.run(|store, _| {
        assert_eq!(store.table_row_count("moments")?, 4);
        assert_eq!(store.table_row_count("materialization_jobs")?, 3);
        assert!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.is_empty());
        Ok(())
    }).await.unwrap();
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_reopened_or_other_device_session_cannot_reuse_the_old_grant() {
    for session_id in ["reopened-owner", "other-device"] {
        let f = Fixture::new().await;
        let grant = f.consent();
        let modified = std::fs::metadata(f.scratch.path().join("note.md")).unwrap().modified().unwrap();
        assert!(matches!(f.actor.ydoc_settle(f.scratch.path().to_owned(), f.key.clone(), "note.md".into(),
            ContentKind::Richdoc, Some(f.claim.clone()), Some(hex_sha256(f.source.as_bytes())),
            session_id.into(), Arc::new(()), 10, Arc::new(NoFaults), CancellationToken::new(), None,
            Some(grant.clone())).await, Err(RuntimeError::MarkdownWriteHeld { .. })));
        assert!(!grant.is_consumed());
        f.unchanged().await;
        assert_eq!(std::fs::metadata(f.scratch.path().join("note.md")).unwrap().modified().unwrap(), modified);
        f.supervisor.close(&f.db).unwrap();
    }
}
