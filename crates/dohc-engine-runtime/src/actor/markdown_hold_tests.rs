use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{reader_resolver, Ydoc};
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
        wire.get_or_insert_map("meta").remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
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
            store.write_with(&NoFaults, |tx| tx.execute(
                "INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,\
                 object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,\
                 baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,\
                 covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,\
                 max_pending_bytes,max_pending_age_ms) VALUES ('relay','adoption','w','main','note',?1,?2,'source',?3,?4,\
                 0,0,?3,?3,0,?5,0,'null','{}',1000000,1000000)",
                params![binding.lineage_claim_id, serde_json::to_string(&binding).unwrap(), source_sha,
                    source_length, marker.head_update_seq]).map_err(StorageError::persist_public))?;
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
        handle.settle_with_consent(None, 100, self.scratch.path().to_owned(), 10, Arc::new(NoFaults),
            CancellationToken::new(), dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                policy: dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                }, reservation: Arc::new(()),
            }, consent).await
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
                assert!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.is_empty());
                checked.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })));
            Err(CollabError::MarkdownReaderPending(pending).into())
        })));
        Ok(())
    }).await.unwrap();
    assert!(f.settle(false, Some(grant.clone())).await.unwrap().settled().unwrap().materialized);
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
            assert_eq!(write_obligations::pending_in(conn, "w")?.len(), 1);
            assert_eq!(conn.query_row("SELECT count(*) FROM live_device_settlements", [],
                |row| row.get::<_, i64>(0)).unwrap(), 1);
            MARKDOWN_BEFORE_SETTLE.with(|slot| *slot.borrow_mut() = Some(Box::new(move |store| {
                assert!(!consent.is_consumed());
                assert_eq!(store.table_row_count("moments")?, 1);
                assert_eq!(store.table_row_count("materialization_jobs")?, 0);
                assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                assert!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.is_empty());
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
                assert_eq!(write_obligations::pending_in(conn, "w")?.len(), 1);
                Err(if stale { DomainError::ConflictStaleTarget.into() }
                    else { DomainError::InvalidInput { reason: "ydoc-conflict-open" }.into() })
            })));
            Ok(())
        }).await.unwrap();
        assert!(f.audited_settle(&host, Some(grant.clone())).await.is_err());
        assert!(!grant.is_consumed());
        f.unchanged().await;
        f.actor.run(|store, _| {
            assert!(store.read_with(|conn| write_obligations::pending_in(conn, "w"))?.is_empty());
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
