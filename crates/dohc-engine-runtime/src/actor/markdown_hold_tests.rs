use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{LeaseRegistry, Ydoc, reader_resolver};
use dohc_engine_domain::WriteText;
use dohc_engine_reader::Reader;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

struct Fixture {
    db: PathBuf,
    supervisor: crate::WorkspaceSupervisor,
    actor: ActorHandle,
    key: DocKey,
    claim: String,
    source: String,
    pending: Arc<reader_resolver::PendingProof>,
    scratch: ScratchDir,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_reader_source(false).await
    }

    async fn with_reader_source(keep_reader: bool) -> Self {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/reader-resolver.json"
        ))
        .unwrap();
        let source = data["source"].as_str().unwrap().to_owned();
        let wire = yrs::Doc::new();
        wire.transact_mut()
            .apply_update(
                yrs::Update::decode_v1(
                    &STANDARD
                        .decode(data["checkpoint"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        wire.get_or_insert_map("meta")
            .remove(&mut wire.transact_mut(), "dohcLineageEpoch");
        let checkpoint = wire
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let key = DocKey::new("w", "main", "note").unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("w", "main", 1, &NoFaults)
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: "note".into(),
                    path: "note.md".into(),
                    text: source.clone(),
                    moment_id: "source".into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &checkpoint,
            &NoFaults,
            3,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        let original = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc;
        let proof_resolver = reader_resolver::ReaderResolver::new(Arc::new(Reader::new(None)));
        let pending = match store.read_with(|conn| {
            reader_resolver::resolve(
                conn,
                &key,
                &original,
                &original.project(ContentKind::Richdoc)?.content,
                Some(&proof_resolver),
            )
        }) {
            Err(CollabError::MarkdownReaderPending(pending)) => pending,
            _ => panic!("expected a snapshot proof to control the rollback retry"),
        };
        let before = wire.transact().state_vector();
        if !keep_reader {
            wire.get_or_insert_map("meta")
                .remove(&mut wire.transact_mut(), "dohcMarkdownSourceReader");
        }
        let doc = Ydoc::wire();
        doc.apply(&original.encode_full_state()).unwrap();
        doc.apply(&wire.transact().encode_state_as_update_v1(&before))
            .unwrap();
        doc.richdoc_append_paragraph("Accepted text remains available");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(
                    tx,
                    &key,
                    &doc.encode_full_state(),
                    None,
                    None,
                    4,
                )
            })
            .unwrap();
        let claim = dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .lineage_claim_id
            .unwrap();
        drop(store);
        std::fs::write(scratch.path().join("note.md"), &source).unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 5).unwrap().actor;
        let config = super::super::reader_tests::fake_reader(&scratch, "witness-unsafe");
        actor
            .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(Arc::new(
                Reader::new(Some(config)),
            ))))
            .await
            .unwrap();
        Self {
            scratch,
            db,
            supervisor,
            actor,
            key,
            claim,
            source,
            pending,
        }
    }

    fn consent(&self) -> Arc<MarkdownConversionConsent> {
        Arc::new(MarkdownConversionConsent::new(
            self.key.clone(),
            "owner-session".into(),
            Some(self.claim.clone()),
            None,
            hex_sha256(self.source.as_bytes()),
            Some(hex_sha256(self.source.as_bytes())),
        ))
    }

    async fn settle(
        &self,
        queued: bool,
        consent: Option<Arc<MarkdownConversionConsent>>,
    ) -> Result<YdocSettleOutcome, RuntimeError> {
        if queued {
            self.actor
                .ydoc_settle_queued(
                    self.scratch.path().to_owned(),
                    self.key.clone(),
                    "note.md".into(),
                    ContentKind::Richdoc,
                    Some(self.claim.clone()),
                    Some(hex_sha256(self.source.as_bytes())),
                    "owner-session".into(),
                    Arc::new(()),
                    10,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                    None,
                    consent,
                )
                .await
        } else {
            self.actor
                .ydoc_settle(
                    self.scratch.path().to_owned(),
                    self.key.clone(),
                    "note.md".into(),
                    ContentKind::Richdoc,
                    Some(self.claim.clone()),
                    Some(hex_sha256(self.source.as_bytes())),
                    "owner-session".into(),
                    Arc::new(()),
                    10,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                    None,
                    consent,
                )
                .await
        }
    }

    async fn held_change(&self, path: &str) -> Option<HeldMarkdownChange> {
        self.actor
            .held_markdown_change("w".into(), path.into(), self.scratch.path().to_owned())
            .await
            .unwrap()
    }

    async fn unchanged(&self) {
        let source = self.source.clone();
        let key = self.key.clone();
        self.actor
            .run(move |store, _| {
                assert_eq!(store.table_row_count("moments")?, 1);
                assert_eq!(store.table_row_count("materialization_jobs")?, 0);
                assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                let snapshot = VersionedTextStore::new(store)
                    .read_text("w", "main", "note.md")?
                    .unwrap();
                assert_eq!(snapshot.text, source);
                let doc = dohc_engine_collab::load_persisted(store, &key)?
                    .unwrap()
                    .doc;
                assert!(
                    doc.project(ContentKind::Richdoc)?
                        .content
                        .contains("Accepted text remains available")
                );
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(self.scratch.path().join("note.md")).unwrap(),
            self.source
        );
    }

    async fn adopt(&self) {
        let key = self.key.clone();
        let source_sha = hex_sha256(self.source.as_bytes());
        let source_length = self.source.len() as i64;
        let binding = dohc_engine_collab::live_object_binding::LiveObjectBinding {
            workspace_id: "w".into(),
            main_version_id: "main".into(),
            object_id: "note".into(),
            lineage_claim_id: self.claim.clone(),
            current_path: "note.md".into(),
            selector_paths: vec!["note.md".into()],
            restore_fence_generation: 0,
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
                 0,0,?3,?3,0,?5,0,'null','{\"hostId\":\"host\",\"hostEpoch\":1,\"instanceId\":\"instance\",\"connectionId\":\"connection\"}',1000000,1000000)",
                params![binding.lineage_claim_id, serde_json::to_string(&binding).unwrap(), source_sha,
                    source_length, marker.head_update_seq]).map_err(StorageError::persist_public)?;
                tx.execute(dohc_engine_collab::live_update_application::owner_activations::ACTIVATE_ADOPTION,
                    rusqlite::params!["relay", "adoption", None::<String>]).map_err(StorageError::persist_public)?;
                dohc_engine_collab::live_update_application::initialize_adopted_history_for_test(tx, "relay", &binding)
                    .map_err(StorageError::persist_public)
            })?;
            Ok(())
        }).await.unwrap();
    }

    async fn audited_host(
        &self,
    ) -> (
        crate::actor::ActorLiveApplicationOwner,
        crate::actor::ActorLiveApplicationHandle,
    ) {
        let owner = self.actor.live_application_owner("w".into()).await.unwrap();
        let handle = owner
            .register(
                "relay".into(),
                dohc_engine_collab::live_update_application::ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                dohc_engine_collab::live_object_binding::LiveObjectBinding {
                    workspace_id: "w".into(),
                    main_version_id: "main".into(),
                    object_id: "note".into(),
                    lineage_claim_id: self.claim.clone(),
                    current_path: "note.md".into(),
                    selector_paths: vec!["note.md".into()],
                    restore_fence_generation: 0,
                },
            )
            .await
            .unwrap();
        (owner, handle)
    }

    async fn audit_at(
        &self,
        handle: &crate::actor::ActorLiveApplicationHandle,
        terminal: Option<dohc_engine_collab::live_update_application::LiveUpdateReceipt>,
        max: usize,
        consent: Option<Arc<MarkdownConversionConsent>>,
    ) -> Result<dohc_engine_collab::live_update_application::LiveSettlementResult, RuntimeError>
    {
        handle
            .settle_with_consent(
                terminal,
                max,
                self.scratch.path().to_owned(),
                10,
                Arc::new(NoFaults),
                CancellationToken::new(),
                dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                    policy:
                        dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                            working_reserve_bytes: 8 * 1024 * 1024,
                        },
                    reservation: Arc::new(()),
                },
                consent,
            )
            .await
    }

    fn event(
        &self,
        cursor: i64,
        bytes: Vec<u8>,
    ) -> dohc_engine_collab::live_update_application::AdmittedLiveUpdate {
        use dohc_engine_collab::live_update_application::*;
        AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: format!("delivery-{cursor}"),
                        update_digest: hex_sha256(&bytes),
                        journal_cursor: cursor,
                        accepting_host_epoch: 1,
                    },
                    binding: dohc_engine_collab::live_object_binding::LiveObjectBinding {
                        workspace_id: "w".into(),
                        main_version_id: "main".into(),
                        object_id: "note".into(),
                        lineage_claim_id: self.claim.clone(),
                        current_path: "note.md".into(),
                        selector_paths: vec!["note.md".into()],
                        restore_fence_generation: 0,
                    },
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: 10,
                },
                first_seen: vec![],
                canonical_version: None,
                author_snapshot: None,
                first_seen_deletes: None,
                checkpoint_coverage: None,
            },
            update_bytes: bytes,
        }
    }
}

#[tokio::test]
async fn markdown_hold_no_reader_session_and_queue_keep_durable_edits_until_consent() {
    for queued in [false, true] {
        let mut f = Fixture::new().await;
        f.supervisor.close(&f.db).unwrap();
        f.actor = f.supervisor.open(&f.db, 6).unwrap().actor;
        for _ in 0..2 {
            assert!(matches!(
                f.settle(queued, None).await,
                Err(RuntimeError::MarkdownWriteHeld { .. })
            ));
            f.unchanged().await;
        }
        f.supervisor.close(&f.db).unwrap();
        let store = EngineStore::open(&f.db, 20).unwrap();
        let owed = store
            .read_with(|conn| write_obligations::pending_in(conn, "w"))
            .unwrap();
        assert_eq!(owed.len(), 1);
        assert!(owed[0].held_checkpoint_sha256.is_some());
        assert_eq!(
            dohc_engine_sync::list_refusal_notices(&store, "w")
                .unwrap()
                .len(),
            1
        );
        drop(store);
        f.actor = f.supervisor.open(&f.db, 21).unwrap().actor;
        let grant = f.consent();
        assert!(
            f.settle(queued, Some(grant.clone()))
                .await
                .unwrap()
                .settled()
                .unwrap()
                .materialized
        );
        assert!(grant.is_consumed());
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_held_change_stays_readable_after_its_notice_is_dismissed() {
    let f = Fixture::new().await;
    assert_eq!(f.held_change("note.md").await, None);
    assert!(matches!(
        f.settle(false, None).await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    f.actor
        .run(|store, _| {
            let notices = dohc_engine_sync::list_refusal_notices(store, "w")?;
            assert_eq!(notices.len(), 1);
            dohc_engine_sync::dismiss_refusal_notice(
                store,
                "w",
                &notices[0].notice_id,
                &notices[0].refusal_coordinates,
                &NoFaults,
            )?;
            assert!(dohc_engine_sync::list_refusal_notices(store, "w")?.is_empty());
            Ok(())
        })
        .await
        .unwrap();
    // Dismissing the Notice deleted nothing: the save is still held.
    let Some(HeldMarkdownChange::Ready { file, held, .. }) = f.held_change("note.md").await else {
        panic!("a dismissed Notice must leave its held change readable");
    };
    assert_eq!(file.as_deref(), Some(f.source.as_str()));
    assert_ne!(held, f.source);
    assert!(held.contains("Accepted text remains available"));
    assert_eq!(f.held_change("other.md").await, None);
    f.unchanged().await;
    // What the review showed is exactly what consenting writes.
    assert!(
        f.settle(false, Some(f.consent()))
            .await
            .unwrap()
            .settled()
            .unwrap()
            .materialized
    );
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join("note.md")).unwrap(),
        held
    );
    assert_eq!(f.held_change("note.md").await, None);
    f.supervisor.close(&f.db).unwrap();
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
        f.actor
            .run(move |_, _| {
                MARKDOWN_SETTLEMENT_FAULT.with(|slot| {
                    *slot.borrow_mut() = Some(Box::new(move |conn| {
                        assert!(!consent.is_consumed());
                        let debt = write_obligations::pending_in(conn, "w")?;
                        assert_eq!(debt.len(), 1);
                        assert_eq!(debt[0].kind, WriteObligationKind::WitnessRefresh);
                        MARKDOWN_BEFORE_SETTLE.with(|slot| {
                            *slot.borrow_mut() = Some(Box::new(move |store| {
                                assert!(!consent.is_consumed());
                                assert_eq!(store.table_row_count("moments")?, 1);
                                assert_eq!(store.table_row_count("materialization_jobs")?, 0);
                                assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                                let owed = store
                                    .read_with(|conn| write_obligations::pending_in(conn, "w"))?;
                                assert_eq!(owed.len(), 1);
                                assert_eq!(owed[0].kind, WriteObligationKind::Session);
                                assert!(owed[0].held_checkpoint_sha256.is_none());
                                checked.store(true, std::sync::atomic::Ordering::Release);
                                Ok(())
                            }))
                        });
                        Err(CollabError::MarkdownReaderPending(pending).into())
                    }))
                });
                Ok(())
            })
            .await
            .unwrap();
        assert!(
            f.settle(queued, Some(grant.clone()))
                .await
                .unwrap()
                .settled()
                .unwrap()
                .materialized
        );
        assert!(reran.load(std::sync::atomic::Ordering::Acquire));
        assert!(grant.is_consumed());
        f.actor
            .run(|store, _| {
                assert_eq!(store.table_row_count("moments")?, 2);
                assert_eq!(store.table_row_count("materialization_jobs")?, 1);
                assert_eq!(
                    store
                        .read_with(|conn| write_obligations::pending_in(conn, "w"))?
                        .len(),
                    1
                );
                Ok(())
            })
            .await
            .unwrap();
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_audited_latest_terminal_covers_older_debt_and_bounds_admission() {
    use dohc_engine_collab::live_update_application::{ApplicationPending, ApplicationResult};
    let f = Fixture::new().await;
    f.adopt().await;
    let (_owner, host) = f.audited_host().await;
    let key = f.key.clone();
    let checkpoint = f
        .actor
        .run(move |store, _| {
            Ok(dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc
                .encode_full_state())
        })
        .await
        .unwrap();
    let producer = Ydoc::wire();
    producer.apply(&checkpoint).unwrap();
    let first = f.event(
        1,
        producer.richdoc_append_paragraph("First accepted visitor edit"),
    );
    let first_receipt = first.metadata.accepted.receipt.clone();
    assert!(matches!(
        host.apply_with_reservation(first, Arc::new(NoFaults), None, 8 * 1024 * 1024, Some(2))
            .await
            .unwrap(),
        ApplicationResult::Applied(_, _)
    ));
    assert!(matches!(
        f.audit_at(&host, Some(first_receipt), 2, None).await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    f.unchanged().await;
    let second = f.event(
        2,
        producer.richdoc_append_paragraph("Second accepted visitor edit"),
    );
    let terminal = second.metadata.accepted.receipt.clone();
    assert!(matches!(
        host.apply_with_reservation(second, Arc::new(NoFaults), None, 8 * 1024 * 1024, Some(2))
            .await
            .unwrap(),
        ApplicationResult::Applied(_, _)
    ));
    let refused = f.event(
        3,
        producer.richdoc_append_paragraph("Unaccepted edit waits for capacity"),
    );
    assert!(matches!(
        host.apply_with_reservation(
            refused.clone(),
            Arc::new(NoFaults),
            None,
            8 * 1024 * 1024,
            Some(2)
        )
        .await
        .unwrap(),
        ApplicationResult::Pending(ApplicationPending::SettlementRequired)
    ));
    let key = f.key.clone();
    f.actor
        .run(move |store, _| {
            assert_eq!(store.table_row_count("live_device_update_applications")?, 2);
            assert_eq!(store.table_row_count("live_device_settlements")?, 0);
            let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, WriteObligationKind::AuditedSettle);
            let doc = dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc;
            assert!(
                !doc.project(ContentKind::Richdoc)?
                    .content
                    .contains("Unaccepted edit")
            );
            Ok(())
        })
        .await
        .unwrap();
    let grant = f.consent();
    let saved = f
        .audit_at(&host, Some(terminal), 2, Some(grant.clone()))
        .await
        .unwrap();
    assert!(grant.is_consumed());
    assert_eq!(saved.terminal_cursor, 2);
    assert!(saved.materialized);
    let file = std::fs::read_to_string(f.scratch.path().join("note.md")).unwrap();
    assert!(
        file.contains("First accepted visitor edit")
            && file.contains("Second accepted visitor edit")
    );
    f.actor
        .run(|store, _| {
            let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
            assert!(
                owed.iter()
                    .all(|row| row.kind == WriteObligationKind::WitnessRefresh)
            );
            assert_eq!(store.table_row_count("live_device_settlements")?, 1);
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        host.apply_with_reservation(refused, Arc::new(NoFaults), None, 8 * 1024 * 1024, Some(2))
            .await
            .unwrap(),
        ApplicationResult::Applied(_, _)
    ));
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
    let modified = std::fs::metadata(f.scratch.path().join("note.md"))
        .unwrap()
        .modified()
        .unwrap();
    assert!(matches!(
        f.settle(false, None).await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    f.supervisor.close(&f.db).unwrap();
    f.actor = f.supervisor.open(&f.db, 20).unwrap().actor;
    let resolver = reader_resolver::ReaderResolver::new(Arc::new(Reader::new(Some(
        super::super::reader_tests::fake_reader(&f.scratch, "witness-unsafe"),
    ))));
    f.actor
        .configure_reader_resolver(Arc::new(resolver))
        .await
        .unwrap();
    let candidates = f
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_eq!(candidates.len(), 1);
    let owed = candidates[0].obligation.clone();
    let root = f.scratch.path().to_owned();
    assert!(matches!(
        f.actor
            .recover_markdown_write(
                owed.clone(),
                root.clone(),
                Arc::new(RecoveryRoot(root.clone())),
                LeaseRegistry::new(),
                Arc::new(()),
                21,
                CancellationToken::new()
            )
            .await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    f.unchanged().await;
    assert_eq!(
        std::fs::metadata(root.join("note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    let key = f.key.clone();
    let accepted_sequence = f
        .actor
        .run(move |store, _| {
            let doc = dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc;
            let clear = doc.clear_markdown_source_witness();
            store.write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(tx, &key, &clear, None, None, 22)
            })?;
            Ok(dohc_engine_collab::read_marker(store, &key)?
                .unwrap()
                .head_update_seq)
        })
        .await
        .unwrap();
    let current = f
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap();
    assert_ne!(current[0].fingerprint, candidates[0].fingerprint);
    for now in [23, 24] {
        assert!(
            f.actor
                .recover_markdown_write(
                    owed.clone(),
                    root.clone(),
                    Arc::new(RecoveryRoot(root.clone())),
                    LeaseRegistry::new(),
                    Arc::new(()),
                    now,
                    CancellationToken::new()
                )
                .await
                .unwrap()
        );
    }
    let key = f.key.clone();
    f.actor
        .run(move |store, _| {
            assert!(
                store
                    .read_with(|conn| write_obligations::pending_in(conn, "w"))?
                    .is_empty()
            );
            assert_eq!(store.table_row_count("moments")?, 2);
            assert_eq!(store.table_row_count("materialization_jobs")?, 1);
            assert_eq!(
                dohc_engine_collab::read_marker(store, &key)?
                    .unwrap()
                    .head_update_seq,
                accepted_sequence
            );
            Ok(())
        })
        .await
        .unwrap();
    let saved = std::fs::read_to_string(root.join("note.md")).unwrap();
    assert_eq!(saved.matches("Accepted text remains available").count(), 1);
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn markdown_hold_absent_reader_snapshot_refuses_before_the_hold_and_keeps_consent_unused() {
    for unsafe_witness in [false, true] {
        let f = Fixture::with_reader_source(true).await;
        let mode = if unsafe_witness {
            "witness-unsafe"
        } else {
            "witness-safe"
        };
        f.actor
            .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(Arc::new(
                Reader::new(Some(super::super::reader_tests::fake_reader(
                    &f.scratch, mode,
                ))),
            ))))
            .await
            .unwrap();
        f.actor
            .run(|store, _| {
                store.write_with(&NoFaults, |tx| {
                    tx.execute("DELETE FROM snapshots", [])
                        .map_err(StorageError::persist_public)
                })?;
                Ok(())
            })
            .await
            .unwrap();
        std::fs::remove_file(f.scratch.path().join("note.md")).unwrap();
        let grant = Arc::new(MarkdownConversionConsent::new(
            f.key.clone(),
            "owner-session".into(),
            Some(f.claim.clone()),
            None,
            hex_sha256(f.source.as_bytes()),
            None,
        ));
        assert!(matches!(
            f.actor
                .ydoc_settle(
                    f.scratch.path().to_owned(),
                    f.key.clone(),
                    "note.md".into(),
                    ContentKind::Richdoc,
                    Some(f.claim.clone()),
                    None,
                    "owner-session".into(),
                    Arc::new(()),
                    20,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                    None,
                    Some(grant.clone())
                )
                .await,
            Err(RuntimeError::Sync(
                dohc_engine_sync::SyncError::RetryableState {
                    reason: "dohc could not verify this file. Try again."
                }
            ))
        ));
        assert!(!grant.is_consumed());
        assert!(!f.scratch.path().join("note.md").exists());
        let key = f.key.clone();
        f.actor
            .run(move |store, _| {
                assert_eq!(store.table_row_count("snapshots")?, 0);
                assert_eq!(store.table_row_count("moments")?, 1);
                assert_eq!(store.table_row_count("materialization_jobs")?, 0);
                assert_eq!(store.table_row_count("live_device_settlements")?, 0);
                assert!(
                    store
                        .read_with(|conn| write_obligations::pending_in(conn, "w"))?
                        .is_empty()
                );
                let doc = dohc_engine_collab::load_persisted(store, &key)?
                    .unwrap()
                    .doc;
                assert!(
                    doc.project(ContentKind::Richdoc)?
                        .content
                        .contains("Accepted text remains available")
                );
                Ok(())
            })
            .await
            .unwrap();
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_reopened_or_other_device_session_cannot_reuse_the_old_grant() {
    for session_id in ["reopened-owner", "other-device"] {
        let f = Fixture::new().await;
        let grant = f.consent();
        let modified = std::fs::metadata(f.scratch.path().join("note.md"))
            .unwrap()
            .modified()
            .unwrap();
        assert!(matches!(
            f.actor
                .ydoc_settle(
                    f.scratch.path().to_owned(),
                    f.key.clone(),
                    "note.md".into(),
                    ContentKind::Richdoc,
                    Some(f.claim.clone()),
                    Some(hex_sha256(f.source.as_bytes())),
                    session_id.into(),
                    Arc::new(()),
                    10,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                    None,
                    Some(grant.clone())
                )
                .await,
            Err(RuntimeError::MarkdownWriteHeld { .. })
        ));
        assert!(!grant.is_consumed());
        f.unchanged().await;
        assert_eq!(
            std::fs::metadata(f.scratch.path().join("note.md"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        f.supervisor.close(&f.db).unwrap();
    }
}

#[tokio::test]
async fn markdown_hold_replaced_lineage_retires_old_debt_and_requires_a_new_grant() {
    let f = Fixture::new().await;
    let grant = f.consent();
    assert!(matches!(
        f.settle(false, None).await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    let owed = f
        .actor
        .markdown_recovery_candidates("w".into())
        .await
        .unwrap()
        .remove(0)
        .obligation;
    let next_claim = replace_lineage(&f).await;
    assert_ne!(next_claim, f.claim);
    // Recovery retires the old row without writing, so the review shows no
    // held change rather than the replacement lineage's document.
    assert_eq!(f.held_change("note.md").await, None);
    assert!(matches!(
        f.settle(false, Some(grant.clone())).await,
        Err(RuntimeError::Collab(CollabError::LineageWriteStale { .. }))
    ));
    let root = f.scratch.path().to_owned();
    assert!(
        f.actor
            .recover_markdown_write(
                owed,
                root.clone(),
                Arc::new(RecoveryRoot(root.clone())),
                LeaseRegistry::new(),
                Arc::new(()),
                22,
                CancellationToken::new()
            )
            .await
            .unwrap()
    );
    assert!(
        f.actor
            .markdown_recovery_candidates("w".into())
            .await
            .unwrap()
            .is_empty()
    );
    let modified = std::fs::metadata(root.join("note.md"))
        .unwrap()
        .modified()
        .unwrap();
    assert!(matches!(
        f.actor
            .ydoc_settle(
                root.clone(),
                f.key.clone(),
                "note.md".into(),
                ContentKind::Richdoc,
                Some(next_claim.clone()),
                Some(hex_sha256(f.source.as_bytes())),
                "owner-session".into(),
                Arc::new(()),
                23,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                Some(grant.clone())
            )
            .await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    assert!(!grant.is_consumed());
    f.unchanged().await;
    assert_eq!(
        std::fs::metadata(root.join("note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    let fresh = f
        .actor
        .ydoc_conversion_consent(
            f.key.clone(),
            "note.md".into(),
            "owner-session".into(),
            Some(next_claim.clone()),
            None,
            hex_sha256(f.source.as_bytes()),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        f.actor
            .ydoc_settle(
                root.clone(),
                f.key.clone(),
                "note.md".into(),
                ContentKind::Richdoc,
                Some(next_claim),
                Some(hex_sha256(f.source.as_bytes())),
                "owner-session".into(),
                Arc::new(()),
                24,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                Some(fresh.clone())
            )
            .await
            .unwrap()
            .settled()
            .unwrap()
            .materialized
    );
    assert!(fresh.is_consumed());
    assert!(!grant.is_consumed());
    let saved = std::fs::read_to_string(root.join("note.md")).unwrap();
    assert!(
        saved.contains("Accepted text remains available")
            && saved.contains("A replacement lineage edit")
    );
    f.supervisor.close(&f.db).unwrap();
}

async fn replace_lineage(f: &Fixture) -> String {
    let key = f.key.clone();
    f.actor
        .run(move |store, cache| {
            let marker = dohc_engine_collab::read_marker(store, &key)?.unwrap();
            store.write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_base_coordinate_in_tx(
                    tx,
                    dohc_engine_collab::BaseCoordinateRecord {
                        key: &key,
                        lineage_claim_id: marker.lineage_claim_id.as_deref().unwrap(),
                        origin_id: "old-base",
                        origin_seq: 0,
                        relay_seq: Some(20),
                        now_ms: 20,
                    },
                )
            })?;
            let doc = dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc;
            doc.richdoc_append_paragraph("A replacement lineage edit");
            let base = doc.encode_full_state();
            let result = dohc_engine_collab::claim_base_at_relay(
                store,
                &key,
                ContentKind::Richdoc,
                &base,
                &dohc_engine_collab::BaseRelayCoordinate::new("new-base", 0, 10)?,
                &NoFaults,
                21,
            )?;
            assert!(matches!(
                result,
                TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Replaced { .. })
            ));
            cache.remove(&key);
            Ok(dohc_engine_collab::read_marker(store, &key)?
                .unwrap()
                .lineage_claim_id
                .unwrap())
        })
        .await
        .unwrap()
}

impl Fixture {
    async fn held_action(
        &self,
        action: crate::actor::HeldChangeAction,
    ) -> Result<crate::actor::HeldChangeResult, RuntimeError> {
        self.held_action_as(action, r#"[{"kind":"human","humanId":"drop-owner"}]"#)
            .await
    }

    async fn held_action_as(
        &self,
        action: crate::actor::HeldChangeAction,
        author_json: &str,
    ) -> Result<crate::actor::HeldChangeResult, RuntimeError> {
        self.actor
            .held_note_change(
                self.key.clone(),
                "note.md".into(),
                self.scratch.path().to_owned(),
                action,
                Some(author_json.to_owned()),
                40,
            )
            .await
    }

    async fn hold_and_review(&self) -> crate::actor::HeldChangeResult {
        self.actor
            .run(|store, _| {
                dohc_engine_sync::create_claim_identity(
                    store,
                    "w",
                    "drop-owner",
                    "epoch",
                    "stream",
                    8,
                    &NoFaults,
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(matches!(
            self.settle(false, None).await,
            Err(RuntimeError::MarkdownWriteHeld { .. })
        ));
        self.held_action(crate::actor::HeldChangeAction::Review)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn held_drop_undo_restores_waiting_text_and_holds_again_without_consent() {
    use crate::actor::HeldChangeAction;
    let f = Fixture::new().await;
    let review = f.hold_and_review().await;
    let dropped = f
        .held_action(HeldChangeAction::Drop {
            token: review.token,
        })
        .await
        .unwrap();
    let expected_correlation = format!("held-change:undo:{}", dropped.token);
    let restored = f
        .held_action_as(
            HeldChangeAction::Undo {
                token: dropped.token,
            },
            r#"[{"kind":"agent","agentId":"restore-agent","onBehalfOf":"drop-owner"}]"#,
        )
        .await
        .unwrap();
    assert!(restored.held);
    let moment_id = restored.history_moment_id.unwrap();
    let key = f.key.clone();
    f.actor.run(move |store, _| {
        let moment = VersionedTextStore::new(store).get_moment("w", &moment_id)?.unwrap();
        assert_eq!(moment.metadata_summary.as_deref(), Some("Restored held change"));
        assert_eq!(moment.metadata_correlation_id, Some(expected_correlation));
        assert_eq!(serde_json::from_str::<serde_json::Value>(moment.author_json.as_deref().unwrap()).unwrap(),
            serde_json::json!([{"kind":"agent","agentId":"restore-agent","onBehalfOf":"drop-owner"}]));
        let credit: (String, String, String) = store.read_with(|conn| conn.query_row(
            "SELECT actor_origin_id,actor_kind,on_behalf_of FROM ydoc_updates ORDER BY seq DESC LIMIT 1", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(StorageError::corrupt_public))?;
        assert_eq!(credit, ("restore-agent".into(),"agent".into(),"drop-owner".into()));
        let marker = dohc_engine_collab::read_marker(store, &key)?.unwrap();
        let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
        assert_eq!(owed.len(),1);
        assert_eq!(owed[0].retry_inputs["headUpdateSeq"], marker.head_update_seq);
        Ok(())
    }).await.unwrap();
    assert!(matches!(
        f.settle(false, None).await,
        Err(RuntimeError::MarkdownWriteHeld { .. })
    ));
    let key = f.key.clone();
    f.actor
        .run(move |store, _| {
            let doc = dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc;
            assert!(
                doc.project(ContentKind::Richdoc)?
                    .content
                    .contains("Accepted text remains available")
            );
            assert!(
                !store
                    .read_with(|conn| write_obligations::pending_in(conn, "w"))?
                    .is_empty()
            );
            assert_eq!(store.table_row_count("materialization_jobs")?, 0);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join("note.md")).unwrap(),
        f.source
    );
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn held_drop_undo_survives_restart_and_refuses_a_later_edit() {
    use crate::actor::HeldChangeAction;
    let mut f = Fixture::new().await;
    let review = f.hold_and_review().await;
    let dropped = f
        .held_action(HeldChangeAction::Drop {
            token: review.token,
        })
        .await
        .unwrap();
    f.supervisor.close(&f.db).unwrap();
    f.actor = f.supervisor.open(&f.db, 50).unwrap().actor;
    assert!(
        f.held_action(HeldChangeAction::Undo {
            token: dropped.token.clone()
        })
        .await
        .unwrap()
        .held
    );
    let review = f.held_action(HeldChangeAction::Review).await.unwrap();
    let dropped = f
        .held_action(HeldChangeAction::Drop {
            token: review.token,
        })
        .await
        .unwrap();
    let key = f.key.clone();
    f.actor
        .run(move |store, _| {
            let doc = dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc;
            let delta = doc.richdoc_append_paragraph("Later work must survive a stale Undo");
            store.write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(tx, &key, &delta, None, None, 60)
            })?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        f.held_action(HeldChangeAction::Undo {
            token: dropped.token
        })
        .await
        .is_err()
    );
    let key = f.key.clone();
    f.actor
        .run(move |store, _| {
            assert!(
                dohc_engine_collab::load_persisted(store, &key)?
                    .unwrap()
                    .doc
                    .project(ContentKind::Richdoc)?
                    .content
                    .contains("Later work must survive")
            );
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.scratch.path().join("note.md")).unwrap(),
        f.source
    );
    f.supervisor.close(&f.db).unwrap();
}

#[tokio::test]
async fn held_drop_does_not_bypass_the_adopted_owner_audit() {
    use crate::actor::HeldChangeAction;
    let f = Fixture::new().await;
    let review = f.hold_and_review().await;
    f.adopt().await;
    for action in [
        HeldChangeAction::Drop {
            token: review.token.clone(),
        },
        HeldChangeAction::Undo {
            token: review.token,
        },
    ] {
        assert!(matches!(
            f.held_action(action).await,
            Err(RuntimeError::Domain(DomainError::InvalidInput {
                reason: "held-change-shared-owner"
            }))
        ));
    }
    f.unchanged().await;
    f.supervisor.close(&f.db).unwrap();
}

impl Fixture {
    async fn hold_peer_delta(&self) {
        let key = self.key.clone();
        let op = self.actor.run(move |store, _| {
            dohc_engine_sync::create_claim_identity(store, "w", "drop-owner", "epoch", "stream", 8, &NoFaults)?;
            let marker = dohc_engine_collab::read_marker(store, &key)?.unwrap();
            let doc = dohc_engine_collab::load_persisted(store, &key)?.unwrap().doc;
            let delta = doc.richdoc_append_paragraph("Waiting peer edit");
            let sha = store.put_binary_blob(&delta)?;
            Ok(dohc_engine_sync::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "w".into(), origin_id: "held-peer".into(), origin_seq: 0,
                relay_seq: Some(1), op_kind: "ydoc.update".into(), recorded_at_ms: 9,
                payload: serde_json::json!({"versionId":"main", "objectId":"note", "path":"note.md",
                    "contentKind":"richdoc", "lineageClaimId":marker.lineage_claim_id.unwrap(),
                    "updateBlobSha256":sha, "isBaseState":false}),
            })
        }).await.unwrap();
        loop {
            let op = op.clone();
            match self
                .actor
                .run(move |store, cache| {
                    Ok(dohc_engine_sync::apply_ydoc_envelope(
                        store,
                        cache,
                        &op,
                        &NoFaults,
                        &dohc_engine_sync::NoLiveLeases,
                    )?)
                })
                .await
            {
                Ok(outcome) => {
                    assert!(
                        matches!(outcome.primary, dohc_engine_sync::ApplyDisposition::Refused(
                        dohc_engine_sync::ReplicationRefusal {reason: dohc_engine_sync::RefusalReason::InvalidInput {ref reason}, ..}
                    ) if reason == "markdown-write-held")
                    );
                    break;
                }
                Err(RuntimeError::Sync(
                    dohc_engine_sync::SyncError::MarkdownWitnessCheckPending { pending, .. },
                )) => pending.resolve().await,
                Err(RuntimeError::Sync(dohc_engine_sync::SyncError::MarkdownReaderPending(
                    pending,
                ))) => pending.resolve().await,
                Err(error) => panic!("{error:?}"),
            }
        }
        self.actor
            .run(|store, _| {
                let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
                assert_eq!(owed.len(), 1);
                assert_eq!(owed[0].kind, WriteObligationKind::SyncProjection);
                assert!(owed[0].held_checkpoint_sha256.is_some());
                assert_eq!(store.table_row_count("replication_pending_refusals")?, 1);
                assert!(!dohc_engine_sync::list_refusal_notices(store, "w")?.is_empty());
                Ok(())
            })
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn held_drop_and_undo_work_with_only_a_sync_projection_hold() {
    use crate::actor::HeldChangeAction;
    let f = Fixture::new().await;
    f.hold_peer_delta().await;
    let key = f.key.clone();
    let peer_checkpoint = f
        .actor
        .run(move |store, _| {
            Ok(dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc
                .encode_full_state())
        })
        .await
        .unwrap();
    let path = f.scratch.path().join("note.md");
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let review = f.held_action(HeldChangeAction::Review).await.unwrap();
    let token = review.token.clone();
    let dropped = f
        .held_action(HeldChangeAction::Drop {
            token: review.token,
        })
        .await
        .unwrap();
    assert!(!dropped.held);
    let key = f.key.clone();
    let drop_moment = dropped.history_moment_id.unwrap();
    let expected_correlation = format!("held-change:drop:{token}");
    let claim = f.claim.clone();
    f.actor
        .run(move |store, _| {
            assert!(
                store
                    .read_with(|conn| write_obligations::pending_in(conn, "w"))?
                    .is_empty()
            );
            assert!(dohc_engine_sync::list_refusal_notices(store, "w")?.is_empty());
            let doc = dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc;
            assert!(
                !doc.project(ContentKind::Richdoc)?
                    .content
                    .contains("Waiting peer edit")
            );
            assert_eq!(
                dohc_engine_collab::read_marker(store, &key)?
                    .unwrap()
                    .lineage_claim_id,
                Some(claim)
            );
            let moment = VersionedTextStore::new(store)
                .get_moment("w", &drop_moment)?
                .unwrap();
            assert!(moment.before_text.unwrap().contains("Waiting peer edit"));
            assert_eq!(moment.metadata_correlation_id, Some(expected_correlation));
            let outbound: Vec<u8> = store.read_with(|conn| {
                conn.query_row(
                    "SELECT b.bytes FROM replication_log r JOIN binary_blobs b \
             ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') \
             WHERE r.workspace_id=?1 AND r.imported=0 AND r.op_kind='ydoc.update' \
             AND json_extract(r.payload_json,'$.objectId')=?2 ORDER BY r.origin_seq DESC LIMIT 1",
                    params![key.workspace_id, key.object_id],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)
            })?;
            let peer = Ydoc::wire();
            peer.apply(&peer_checkpoint)?;
            assert!(
                peer.project(ContentKind::Richdoc)?
                    .content
                    .contains("Waiting peer edit")
            );
            peer.apply(&outbound)?;
            assert!(
                !peer
                    .project(ContentKind::Richdoc)?
                    .content
                    .contains("Waiting peer edit")
            );
            assert_eq!(store.table_row_count("materialization_jobs")?, 0);
            Ok(())
        })
        .await
        .unwrap();
    let restored = f
        .held_action(HeldChangeAction::Undo {
            token: dropped.token,
        })
        .await
        .unwrap();
    assert!(restored.held);
    let undo_moment = restored.history_moment_id.unwrap();
    let key = f.key.clone();
    f.actor
        .run(move |store, _| {
            let doc = dohc_engine_collab::load_persisted(store, &key)?
                .unwrap()
                .doc;
            assert!(
                doc.project(ContentKind::Richdoc)?
                    .content
                    .contains("Waiting peer edit")
            );
            let owed = store.read_with(|conn| write_obligations::pending_in(conn, "w"))?;
            assert_eq!(owed.len(), 1);
            assert!(owed[0].held_checkpoint_sha256.is_some());
            assert!(!dohc_engine_sync::list_refusal_notices(store, "w")?.is_empty());
            let moment = VersionedTextStore::new(store)
                .get_moment("w", &undo_moment)?
                .unwrap();
            assert_eq!(
                moment.metadata_correlation_id,
                Some(format!("held-change:undo:{token}"))
            );
            assert_eq!(store.table_row_count("materialization_jobs")?, 0);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), f.source);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    f.supervisor.close(&f.db).unwrap();
}

use super::super::markdown_recovery::HeldMarkdownChange;
