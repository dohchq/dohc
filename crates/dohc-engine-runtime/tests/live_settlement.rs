use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::*;
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_domain::AgentDeclaration;
use dohc_engine_runtime::actor::{ActorLiveApplicationHandle, ActorLiveApplicationOwner};
use dohc_engine_runtime::{RuntimeError, WorkspaceSupervisor};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, NoFaults, hex_sha256,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::PathBuf;
use std::sync::Arc;

struct Fixture {
    root: ScratchDir,
    db: PathBuf,
    supervisor: WorkspaceSupervisor,
    owner: ActorLiveApplicationOwner,
    handle: ActorLiveApplicationHandle,
    binding: LiveObjectBinding,
    doc: Ydoc,
}

fn restore_coordinate() -> ApplicationHostCoordinate {
    ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    }
}

async fn applied_restore(
    f: &Fixture,
    terminal: Option<LiveUpdateReceipt>,
    sequence: i64,
) -> NativeRestoreApplication {
    let point = Ydoc::wire();
    let reader = f.doc.has_reader_source();
    let baseline = if reader {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../dohc-engine-collab/tests/reader-restore.json"
        ))
        .unwrap();
        serde_json::from_value(vector["pointStateBytes"].clone()).unwrap()
    } else {
        vector("rich-unicode")
    };
    point.apply(&baseline).unwrap();
    let projection = point.project(ContentKind::Richdoc).unwrap().content;
    let markdown = if reader {
        point
            .markdown_source(&point.markdown_source_reference().unwrap())
            .unwrap()
    } else {
        projection.clone()
    };
    let fence = f
        .owner
        .fence_restore(
            NativeRestoreFence {
                point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                    journal_cursor: 0,
                    receipt_digest: f.binding.lineage_claim_id.clone(),
                },
                operation_id: "restore-settlement".into(),
                relay_database_namespace: "relay".into(),
                old_binding: f.binding.clone(),
                host_id: "host".into(),
                new_fence: 1,
                origin: RestoreDeliveryOrigin::Bootstrap {
                    id: "bootstrap".into(),
                },
                terminal,
                applied_sequence: sequence,
            },
            restore_coordinate(),
            20,
            Arc::new(NoFaults),
        )
        .await
        .unwrap();
    let preparation = NativeRestorePreparation {
        fence,
        point: NativeRestorePoint {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
            markdown_digest: hex_sha256(markdown.as_bytes()),
            projection_digest: hex_sha256(projection.as_bytes()),
        },
    };
    let proposal = f
        .owner
        .prepare_restore(
            preparation.clone(),
            restore_coordinate(),
            2_000_000,
            100,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = 1;
    let input = NativeRestoreApplication {
        preparation,
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "restore-delivery".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: 71,
                    accepting_host_epoch: 1,
                },
                binding,
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 21,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
    };
    f.owner
        .apply_restore(
            input.clone(),
            restore_coordinate(),
            2_000_000,
            100,
            22,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    input
}

async fn settle_restore(
    f: &Fixture,
    input: NativeRestoreApplication,
    faults: Arc<dyn FaultInjector>,
) -> Result<LiveSettlementResult, RuntimeError> {
    f.owner
        .settle_restore(
            input,
            restore_coordinate(),
            2_000_000,
            100,
            f.root.path().to_owned(),
            30,
            faults,
            tokio_util::sync::CancellationToken::new(),
            Arc::new(()),
        )
        .await
}

#[tokio::test]
async fn uncaptured_historical_settlement_replay_keeps_saved_work_without_recapturing() {
    let f = Fixture::new().await;
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Saved work\n")
        .unwrap();
    let terminal = f.apply(7, update).await;
    let first = f
        .settle(Some(terminal.clone()), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    let before = f.counts();
    let text = std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap();
    {
        let db = rusqlite::Connection::open(&f.db).unwrap();
        db.execute(
            "DELETE FROM live_settlement_publication_states WHERE settlement_id=?1",
            [&first.settlement_id],
        )
        .unwrap();
    }
    for _ in 0..2 {
        let replay = f
            .settle(Some(terminal.clone()), 100, Arc::new(NoFaults))
            .await
            .unwrap();
        assert_eq!(replay.settlement_id, first.settlement_id);
        assert_eq!(f.counts(), before);
        assert_eq!(
            std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap(),
            text
        );
        assert_eq!(f.read(|db|db.query_row("SELECT count(*) FROM live_settlement_publication_states WHERE settlement_id=?1",[&first.settlement_id],|r|r.get::<_,i64>(0)).unwrap()),0);
    }
}

#[tokio::test]
async fn restore_settlement_materializes_selected_point_and_preserves_old_anchor() {
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    let expected = std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap();
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Later\n")
        .unwrap();
    let terminal = f.apply(7, update).await;
    let old = f
        .settle(Some(terminal.clone()), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    let old_count = f.counts();
    let input = applied_restore(&f, Some(terminal), 1).await;
    let result = settle_restore(&f, input.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(result.materialized);
    assert_eq!(result.previous_cursor, 7);
    assert_eq!(result.terminal_cursor, 71);
    assert_eq!(result.application_count, 1);
    assert_eq!(
        std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap(),
        expected
    );
    assert_eq!(result.markdown_digest, hex_sha256(&expected));
    assert_eq!(f.counts(), (old_count.0 + 1, old_count.1 + 1));
    assert_eq!(
        settle_restore(&f, input, Arc::new(NoFaults))
            .await
            .unwrap()
            .settlement_id,
        result.settlement_id
    );
    assert_eq!(f.counts(), (old_count.0 + 1, old_count.1 + 1));
    f.read(|db| {
        let retained: String = db
            .query_row(
                "SELECT settlement_id FROM live_device_settlements WHERE terminal_cursor=7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(Some(retained), old.settlement_id);
        let kind: String = db
            .query_row(
                "SELECT settlement_kind FROM live_device_settlements WHERE terminal_cursor=71",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kind, "restore");
        let available: bool = db
            .query_row(
                "SELECT available FROM live_device_application_bindings",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!available);
    });
    assert!(f.settle(None, 100, Arc::new(NoFaults)).await.is_err());
}

#[tokio::test]
async fn restore_settlement_replays_real_projection_commit_and_materialization_crashes() {
    for fault in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ] {
        let f = Fixture::new().await;
        let input = applied_restore(&f, None, 0).await;
        let _interrupted = settle_restore(&f, input.clone(), Arc::new(Crash(fault))).await;
        let result = settle_restore(&f, input.clone(), Arc::new(NoFaults))
            .await
            .unwrap();
        assert!(result.materialized, "{fault:?}");
        assert_eq!(
            result.markdown_digest,
            input.preparation.point.markdown_digest
        );
        assert_eq!(f.counts(), (1, 2));
        assert_eq!(
            std::fs::read(f.root.path().join(&f.binding.current_path))
                .map(|bytes| hex_sha256(&bytes))
                .unwrap(),
            result.markdown_digest
        );
        assert_eq!(
            settle_restore(&f, input, Arc::new(NoFaults))
                .await
                .unwrap()
                .settlement_id,
            result.settlement_id
        );
        assert_eq!(f.counts(), (1, 2));
    }
}

#[tokio::test]
async fn restore_settlement_keeps_pending_artifact_and_rejects_damaged_anchor_before_replay() {
    for damage in [
        None,
        Some("UPDATE live_device_settlements SET interval_digest=printf('%064d',0)"),
        Some("UPDATE live_device_settlements SET source_state_vector_digest=printf('%064d',0)"),
        Some(
            "UPDATE live_device_settlements SET settlement_kind='ordinary',restore_operation_id=NULL",
        ),
        Some(
            "UPDATE live_restore_fences SET application_json=json_set(application_json,'$.admitted.accepted.receivedAtMs',99)",
        ),
    ] {
        let f = Fixture::new().await;
        let input = applied_restore(&f, None, 0).await;
        std::fs::write(f.root.path().join("notes"), "owned obstacle").unwrap();
        let initial = settle_restore(&f, input.clone(), Arc::new(NoFaults)).await;
        assert!(initial.as_ref().map_or(true, |result| !result.materialized));
        assert_eq!(f.counts(), (1, 2));
        f.assert_pending_absent_projection();
        if let Some(sql) = damage {
            rusqlite::Connection::open(&f.db)
                .unwrap()
                .execute(sql, [])
                .unwrap();
        }
        std::fs::remove_file(f.root.path().join("notes")).unwrap();
        let replay = settle_restore(&f, input, Arc::new(NoFaults)).await;
        if damage.is_some() {
            assert!(replay.is_err(), "{damage:?}");
            assert!(!f.root.path().join(&f.binding.current_path).exists());
        } else {
            assert!(replay.unwrap().materialized);
        }
        assert_eq!(f.counts(), (1, 2));
    }
}

#[tokio::test]
async fn restore_settlement_checks_old_anchor_and_records_its_own_same_content_moment() {
    for damage in [false, true] {
        let f = Fixture::new().await;
        // A projection-neutral accepted edit leaves a stored anchor holding B.
        let terminal = f.apply(1, vec![0, 0]).await;
        let original = f
            .settle(Some(terminal.clone()), 100, Arc::new(NoFaults))
            .await
            .unwrap();
        let counts = f.counts();
        let before = std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap();
        let input = applied_restore(&f, Some(terminal), original.local_ydoc_sequence).await;
        if damage {
            rusqlite::Connection::open(&f.db)
                .unwrap()
                .execute(
                    "UPDATE live_device_settlements SET markdown_digest=printf('%064d',0)",
                    [],
                )
                .unwrap();
        }
        let result = settle_restore(&f, input.clone(), Arc::new(NoFaults)).await;
        if damage {
            assert!(result.is_err());
            assert_eq!(f.counts(), counts);
        } else {
            let result = result.unwrap();
            assert!(result.materialized);
            // Restoring B over B still records the restore transition from the
            // accepted head, never the older moment that produced B.
            assert_ne!(result.moment_id, original.moment_id);
            assert_eq!(f.counts(), (counts.0 + 1, counts.1 + 1));
            let (before_moment, before_digest, after_digest): (String, String, String) = f.read(|db| {
                db.query_row(
                    "SELECT before_latest_moment_id,before_blob_sha256,after_blob_sha256 FROM moments WHERE moment_id=?1",
                    [&result.moment_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap()
            });
            assert_eq!(before_moment, original.moment_id);
            assert_eq!(
                (before_digest.as_str(), after_digest.as_str()),
                (
                    original.markdown_digest.as_str(),
                    result.markdown_digest.as_str()
                )
            );
            assert_eq!(result.markdown_digest, original.markdown_digest);
            // A retry reuses exactly the saved restore settlement and its moment.
            let retried = settle_restore(&f, input, Arc::new(NoFaults)).await.unwrap();
            assert_eq!(
                (retried.settlement_id, retried.moment_id),
                (result.settlement_id, result.moment_id)
            );
            assert_eq!(f.counts(), (counts.0 + 1, counts.1 + 1));
        }
        assert_eq!(
            std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn restore_settlement_preserves_collection_index_and_requests_id_reconciliation() {
    let f = Fixture::new().await;
    f.supervisor
        .open(&f.db, 2)
        .unwrap()
        .actor
        .versioned_text_write(
            dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "schema".into(),
                path: "notes/.collection.json".into(),
                text: "{\"fields\":[],\"views\":[]}".into(),
                moment_id: "schema-moment".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    let raw = rusqlite::Connection::open(&f.db).unwrap();
    raw.execute("INSERT INTO collections VALUES ('workspace','main','notes','notes/.collection.json','valid','[]')",[]).unwrap();
    raw.execute("INSERT INTO collection_records (workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state) VALUES ('workspace','main','rec_00000000000000000000000000','notes','notes/example.md','object','adopted')",[]).unwrap();
    drop(raw);
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(
            ContentKind::Richdoc,
            "---\nid: rec_00000000000000000000000000\nstatus: later\n---\n# Later\n",
        )
        .unwrap();
    let terminal = f.apply(5, update).await;
    f.settle(Some(terminal.clone()), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    f.read(|db| {
        assert_eq!(
            db.query_row(
                "SELECT value_json FROM collection_record_fields WHERE field_name='status'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "\"later\""
        )
    });
    let input = applied_restore(&f, Some(terminal), 1).await;
    f.read(|db| {
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM collection_record_fields WHERE field_name='status'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        )
    });
    let result = settle_restore(&f, input.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(result.materialized);
    assert!(result.collection_reconcile_required);
    assert!(
        settle_restore(&f, input, Arc::new(NoFaults))
            .await
            .unwrap()
            .collection_reconcile_required
    );
    assert_eq!(
        std::fs::read(f.root.path().join(&f.binding.current_path))
            .map(|bytes| hex_sha256(&bytes))
            .unwrap(),
        result.markdown_digest
    );
}

#[tokio::test]
async fn restore_settlement_refuses_wrong_host_budget_cancel_and_changed_admission_before_write() {
    let f = Fixture::new().await;
    let input = applied_restore(&f, None, 0).await;
    for variant in 0..5 {
        let mut attempted = input.clone();
        let mut coordinate = restore_coordinate();
        let mut max_bytes = 2_000_000;
        let mut max_events = 100;
        let cancel = tokio_util::sync::CancellationToken::new();
        match variant {
            0 => coordinate.host_id = "foreign-host".into(),
            1 => max_bytes = 1,
            2 => max_events = 0,
            3 => cancel.cancel(),
            4 => attempted.admitted.accepted.received_at_ms += 1,
            _ => unreachable!(),
        }
        assert!(
            f.owner
                .settle_restore(
                    attempted,
                    coordinate,
                    max_bytes,
                    max_events,
                    f.root.path().to_owned(),
                    30,
                    Arc::new(NoFaults),
                    cancel,
                    Arc::new(())
                )
                .await
                .is_err()
        );
        assert_eq!(f.counts(), (0, 1));
        assert!(!f.root.path().join(&f.binding.current_path).exists());
    }
    assert!(
        settle_restore(&f, input, Arc::new(NoFaults))
            .await
            .unwrap()
            .materialized
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_settlement_retains_queued_proof_after_caller_drop_and_replays_after_restart() {
    struct Hold {
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl FaultInjector for Hold {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == FaultPoint::StorageBeforePersist {
                if let Some(entered) = self.entered.lock().unwrap().take() {
                    let _ = entered.send(());
                    self.release.lock().unwrap().recv().unwrap();
                }
            }
            FaultAction::Continue
        }
    }
    struct Reservation(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Reservation {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    for retire in [false, true] {
        let mut f = Fixture::new().await;
        let input = applied_restore(&f, None, 0).await;
        let (entered, at_commit) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let disposed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut call = Box::pin(f.owner.settle_restore(
            input.clone(),
            restore_coordinate(),
            2_000_000,
            100,
            f.root.path().to_owned(),
            30,
            Arc::new(Hold {
                entered: std::sync::Mutex::new(Some(entered)),
                release: std::sync::Mutex::new(wait),
            }),
            tokio_util::sync::CancellationToken::new(),
            Arc::new(Reservation(disposed.clone())),
        ));
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(call.as_mut().poll(cx).is_pending()))
                .await
        );
        at_commit.await.unwrap();
        if retire {
            f.owner.retire();
        }
        drop(call);
        assert!(!disposed.load(std::sync::atomic::Ordering::SeqCst));
        release.send(()).unwrap();
        // A queued owner request establishes completion without polling time.
        f.owner = f
            .supervisor
            .open(&f.db, 35)
            .unwrap()
            .actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        assert!(disposed.load(std::sync::atomic::Ordering::SeqCst));
        let settled = settle_restore(&f, input.clone(), Arc::new(NoFaults))
            .await
            .unwrap();
        let counts = f.counts();
        f.supervisor.close(&f.db).unwrap();
        f.owner = f
            .supervisor
            .open(&f.db, 40)
            .unwrap()
            .actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let replay = settle_restore(&f, input, Arc::new(NoFaults)).await.unwrap();
        assert!(replay.materialized);
        assert_eq!(replay.settlement_id, settled.settlement_id);
        assert_eq!(f.counts(), counts);
        assert!(f.settle(None, 100, Arc::new(NoFaults)).await.is_err());
    }
}

fn vector(name: &str) -> Vec<u8> {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    serde_json::from_value(
        fixtures
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .unwrap()["bytes"]
            .clone(),
    )
    .unwrap()
}

impl Fixture {
    async fn new() -> Self {
        Self::with_relay(false).await
    }
    async fn with_relay(replicates: bool) -> Self {
        Self::build(
            replicates,
            vector("rich-unicode"),
            "notes/example.md",
            |_| {},
        )
        .await
    }
    /// Bootstrap `bytes` as the live document at `path`, after `seed`
    /// writes the store.
    async fn build(
        replicates: bool,
        bytes: Vec<u8>,
        path: &str,
        seed: impl FnOnce(&mut EngineStore),
    ) -> Self {
        let root = ScratchDir::new().unwrap();
        let db = engine_db_path(&root).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        if replicates {
            dohc_engine_sync::journal_local_replication_op(
                &mut store,
                "workspace",
                "owner-origin",
                "epoch",
                "stream",
                "workspace.init",
                &serde_json::json!({}),
                0,
                &NoFaults,
            )
            .unwrap();
            dohc_engine_sync::commit_relay_cursor(
                &mut store,
                "workspace",
                &dohc_engine_sync::RelayCursor {
                    bootstrap_complete: true,
                    cursor: 0,
                    replication_epoch: "epoch".into(),
                    stream_identity: "stream".into(),
                    settlement_report_id: None,
                    ordinary_pull: None,
                },
                &NoFaults,
                &dohc_engine_sync::NoLiveLeases,
                0,
            )
            .unwrap();
        }
        seed(&mut store);
        drop(store);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        let markdown = if doc.has_reader_source() {
            let config =
                serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
            actor
                .configure_reader_resolver(Arc::new(
                    dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                        dohc_engine_reader::Reader::new(Some(config)),
                    )),
                ))
                .await
                .unwrap();
            doc.markdown_source(&doc.markdown_source_reference().unwrap())
                .unwrap()
        } else {
            doc.project(ContentKind::Richdoc).unwrap().content
        };
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&bytes),
            current_path: path.into(),
            selector_paths: vec![path.into()],
            restore_fence_generation: 0,
        };
        let handle = owner
            .register(
                "relay".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                binding.clone(),
            )
            .await
            .unwrap();
        let input = LiveApplicationBootstrap {
            bootstrap_id: "bootstrap".into(),
            bootstrap_moment_id: "bootstrap-moment".into(),
            baseline_moment_relay_sequence: 0,
            baseline_registered_at_ms: 1,
            baseline_digest: hex_sha256(&bytes),
            baseline_byte_length: bytes.len() as i64,
            projected_markdown_digest: hex_sha256(markdown.as_bytes()),
            projected_markdown_byte_length: markdown.len() as i64,
        };
        assert!(matches!(
            handle
                .bootstrap(
                    input,
                    bytes,
                    root.path().to_owned(),
                    Arc::new(NoFaults),
                    None
                )
                .await
                .unwrap(),
            BootstrapResult::Bootstrapped(_)
        ));
        Self {
            root,
            db,
            supervisor,
            owner,
            handle,
            binding,
            doc,
        }
    }
    async fn settle(
        &self,
        terminal: Option<LiveUpdateReceipt>,
        max: usize,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        self.handle
            .settle(
                terminal,
                max,
                self.root.path().to_owned(),
                10,
                faults,
                tokio_util::sync::CancellationToken::new(),
                dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction {
                    policy:
                        dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                            working_reserve_bytes: 8 * 1024 * 1024,
                        },
                    reservation: Arc::new(()),
                },
            )
            .await
    }
    async fn apply(&self, cursor: i64, bytes: Vec<u8>) -> LiveUpdateReceipt {
        self.apply_as(
            cursor,
            bytes,
            ServerDerivedLiveUpdateAuthority::Owner {
                principal_id: "owner".into(),
            },
            2,
        )
        .await
    }
    async fn apply_as(
        &self,
        cursor: i64,
        bytes: Vec<u8>,
        authority: ServerDerivedLiveUpdateAuthority,
        received_at_ms: i64,
    ) -> LiveUpdateReceipt {
        let (receipt, result) = self
            .apply_declared(cursor, bytes, authority, received_at_ms, None)
            .await;
        assert!(matches!(result, ApplicationResult::Applied(..)));
        receipt
    }
    async fn apply_declared(
        &self,
        cursor: i64,
        bytes: Vec<u8>,
        authority: ServerDerivedLiveUpdateAuthority,
        received_at_ms: i64,
        agent_declaration: Option<AgentDeclaration>,
    ) -> (LiveUpdateReceipt, ApplicationResult) {
        self.apply_declared_with_content(
            cursor,
            bytes,
            authority,
            received_at_ms,
            (agent_declaration, vec![]),
        )
        .await
    }
    async fn apply_declared_with_content(
        &self,
        cursor: i64,
        bytes: Vec<u8>,
        authority: ServerDerivedLiveUpdateAuthority,
        received_at_ms: i64,
        authorship: (Option<AgentDeclaration>, Vec<LiveUpdateStructRange>),
    ) -> (LiveUpdateReceipt, ApplicationResult) {
        let (agent_declaration, first_seen) = authorship;
        self.doc.apply(&bytes).unwrap();
        let receipt = LiveUpdateReceipt {
            delivery_id: format!("delivery-{cursor}"),
            update_digest: hex_sha256(&bytes),
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        };
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: receipt.clone(),
                    binding: self.binding.clone(),
                    authority,
                    received_at_ms,
                },
                first_seen,
                canonical_version: Some(2),
                author_snapshot: Some(
                    (agent_declaration)
                        .into_iter()
                        .map(dohc_engine_collab::live_update_application::LiveAuthorEntry::from)
                        .collect(),
                ),
                first_seen_deletes: Some(vec![]),
                checkpoint_coverage: None,
            },
            update_bytes: bytes,
        };
        let result = self
            .handle
            .apply(event, Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap();
        (receipt, result)
    }

    async fn apply_folder_scope(&mut self) -> LiveUpdateReceipt {
        let mut folder = self.binding.clone();
        folder.selector_paths = vec!["notes".into()];
        let handle = self
            .owner
            .register(
                "relay".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                folder.clone(),
            )
            .await
            .unwrap();
        let receipt = LiveUpdateReceipt {
            delivery_id: "folder-delivery".into(),
            update_digest: hex_sha256(&[0, 0]),
            journal_cursor: 1,
            accepting_host_epoch: 1,
        };
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: receipt.clone(),
                    binding: folder,
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: 2,
                },
                first_seen: vec![],
                canonical_version: None,
                author_snapshot: None,
                first_seen_deletes: None,
                checkpoint_coverage: None,
            },
            update_bytes: vec![0, 0],
        };
        assert!(matches!(
            handle
                .apply(event, Arc::new(NoFaults), 100_000_000)
                .await
                .unwrap(),
            ApplicationResult::Applied(..)
        ));
        self.handle = self
            .owner
            .register(
                "relay".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                self.binding.clone(),
            )
            .await
            .unwrap();
        receipt
    }
    fn counts(&self) -> (i64, i64) {
        self.read(|db|db.query_row("SELECT (SELECT COUNT(*) FROM live_device_settlements),(SELECT COUNT(*) FROM moments)",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap())
    }
    fn assert_pending_absent_projection(&self) {
        let count: i64 = self.read(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE job_id LIKE 'ydoc-mat_%' AND target_path=?1 AND status='pending' AND preimage_present=0 AND preimage_sha256 IS NULL",
                [&self.binding.current_path],
                |row| row.get(0),
            ).unwrap()
        });
        assert_eq!(count, 1);
    }
    fn read<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
        let db = rusqlite::Connection::open_with_flags(
            &self.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        f(&db)
    }
    fn assert_projection(&self) {
        let markdown = self.doc.project(ContentKind::Richdoc).unwrap().content;
        assert_eq!(
            std::fs::read_to_string(self.root.path().join(&self.binding.current_path)).unwrap(),
            markdown
        );
        self.read(|db| {
            let count:i64=db.query_row("SELECT COUNT(*) FROM engine_search_files_fts WHERE object_id='object' AND text=?1",[&markdown],|r|r.get(0)).unwrap();assert_eq!(count,1);
            let hash:String=db.query_row("SELECT blob_sha256 FROM snapshots WHERE object_id='object'",[],|r|r.get(0)).unwrap();assert_eq!(hash,hex_sha256(markdown.as_bytes()));
        });
    }
}

fn owner_authority() -> ServerDerivedLiveUpdateAuthority {
    ServerDerivedLiveUpdateAuthority::Owner {
        principal_id: "owner".into(),
    }
}

fn agent(agent_id: &str, on_behalf_of: &str) -> Option<AgentDeclaration> {
    Some(AgentDeclaration {
        agent_id: agent_id.into(),
        on_behalf_of: Some(on_behalf_of.into()),
        depth: 1,
    })
}

/// The authors the latest settlement moment names.
fn latest_authors(f: &Fixture) -> serde_json::Value {
    f.read(|db| {
        db.query_row(
            "SELECT author_json FROM moments ORDER BY moment_order DESC LIMIT 1",
            [],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap()
    })
    .map_or(serde_json::Value::Null, |json| {
        serde_json::from_str(&json).unwrap()
    })
}

async fn named_delivery_settles_without_marker(author: serde_json::Value) {
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    let bytes = f.doc.richdoc_append_paragraph("Named contribution");
    let receipt = LiveUpdateReceipt {
        delivery_id: "named-delivery".into(),
        update_digest: hex_sha256(&bytes),
        journal_cursor: 3,
        accepting_host_epoch: 1,
    };
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: receipt.clone(),
                binding: f.binding.clone(),
                authority: owner_authority(),
                received_at_ms: 2,
            },
            first_seen: vec![],
            canonical_version: Some(2),
            author_snapshot: Some(vec![serde_json::from_value(author.clone()).unwrap()]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
        update_bytes: bytes,
    };
    assert!(matches!(
        f.handle
            .apply(event, Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap(),
        ApplicationResult::Applied(..)
    ));
    f.settle(Some(receipt), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(latest_authors(&f), serde_json::json!([author]));
    f.assert_projection();
}

#[tokio::test]
async fn accepted_agent_delivery_settles_without_an_unattributed_marker() {
    named_delivery_settles_without_marker(serde_json::json!({"kind":"agent","agentId":"cleanup-agent","onBehalfOf":"owner","depth":1})).await;
}

#[tokio::test]
async fn accepted_human_delivery_settles_without_an_unattributed_marker() {
    named_delivery_settles_without_marker(
        serde_json::json!({"kind":"human","humanId":"owner","humanName":"Owner"}),
    )
    .await;
}

/// An update that only removes the body's last block: no new structs.
fn delete_last_block(doc: &Ydoc) -> Vec<u8> {
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, XmlFragment};
    let local = yrs::Doc::new();
    local
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap())
        .unwrap();
    let before = local.transact().state_vector();
    let body = local.get_or_insert_xml_fragment("body");
    {
        let mut txn = local.transact_mut();
        let len = body.len(&txn);
        body.remove_range(&mut txn, len - 1, 1);
    }
    local.transact().encode_state_as_update_v1(&before)
}

/// A live settlement names the agents the owner declared for the deliveries
/// it covers and the collaborator the relay accepted a delivery from. The
/// owner's undeclared delivery names no author, so the interval keeps an
/// unattributed gap. A delete-only edit with no new structs counts too. The
/// next interval names only its own.
#[tokio::test]
async fn live_settlement_names_declared_agents_of_its_exact_interval() {
    fn paragraph(doc: &Ydoc, text: &str) -> (Vec<u8>, Vec<LiveUpdateStructRange>) {
        use yrs::updates::decoder::Decode;
        let before = yrs::StateVector::decode_v1(&doc.encode_state_vector()).unwrap();
        let bytes = doc.richdoc_append_paragraph(text);
        let after = yrs::StateVector::decode_v1(&doc.encode_state_vector()).unwrap();
        let mut ranges: Vec<_> = after
            .iter()
            .filter_map(|(client, clock)| {
                let start = before.get(client);
                (*clock > start).then_some(LiveUpdateStructRange {
                    client_id: client.get() as i64,
                    start_clock: i64::from(start),
                    end_clock: i64::from(*clock),
                })
            })
            .collect();
        ranges.sort_by_key(|range| range.client_id);
        (bytes, ranges)
    }
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    let added = f.doc.richdoc_append_paragraph("Agent paragraph");
    let (_, result) = f
        .apply_declared(
            3,
            added,
            owner_authority(),
            2,
            agent("trip-agent âœˆ", "owner"),
        )
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    let (bytes, ranges) = paragraph(&f.doc, "Owner paragraph");
    let (_, result) = f
        .apply_declared_with_content(4, bytes, owner_authority(), 2, (None, ranges))
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    let (bytes, ranges) = paragraph(&f.doc, "Friend paragraph");
    let (terminal, result) = f
        .apply_declared_with_content(
            5,
            bytes,
            ServerDerivedLiveUpdateAuthority::Named {
                principal_id: "friend".into(),
                grant_id: "grant".into(),
                grant_generation: 1,
            },
            2,
            (None, ranges),
        )
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    f.settle(Some(terminal), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        latest_authors(&f),
        serde_json::json!([
            {"kind":"agent","agentId":"trip-agent âœˆ","onBehalfOf":"owner","depth":1},
            {"kind":"named","userId":"friend","grantId":"grant","grantGeneration":1},
            {"kind":"unattributed"},
        ])
    );
    let vector = f.doc.encode_state_vector();
    let removed = delete_last_block(&f.doc);
    let (terminal, result) = f
        .apply_declared(
            6,
            removed,
            owner_authority(),
            3,
            agent("cleanup-agent", "owner"),
        )
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    assert_eq!(f.doc.encode_state_vector(), vector, "the edit only deletes");
    f.settle(Some(terminal), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        latest_authors(&f),
        serde_json::json!([{"kind":"agent","agentId":"cleanup-agent","onBehalfOf":"owner","depth":1}])
    );
    f.assert_projection();
}

/// A delivery whose bytes an earlier delivery in the same interval already
/// carried deduplicates natively, yet the settlement moment of that
/// content-bearing interval still names its declared agent beside the first.
#[tokio::test]
async fn settlement_moment_names_a_byte_deduplicated_declared_delivery() {
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    let before = f.counts();
    let added = f.doc.richdoc_append_paragraph("Agent paragraph");
    let (_, first) = f
        .apply_declared(
            3,
            added.clone(),
            owner_authority(),
            2,
            agent("trip-agent", "owner"),
        )
        .await;
    assert!(matches!(first, ApplicationResult::Applied(..)));
    let (terminal, repeated) = f
        .apply_declared(
            4,
            added,
            owner_authority(),
            3,
            agent("review-agent", "owner"),
        )
        .await;
    let ApplicationResult::Applied(ack, _) = repeated else {
        panic!("the repeated delivery applies");
    };
    assert!(!ack.application_replayed);
    let sequences: Vec<i64> = f.read(|db| {
        db.prepare(
            "SELECT local_ydoc_sequence FROM live_device_update_applications \
             WHERE journal_cursor IN (3,4) ORDER BY journal_cursor",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    });
    assert_eq!(
        sequences[0], sequences[1],
        "the second delivery's bytes deduplicate"
    );
    let settled = f
        .settle(Some(terminal), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(settled.application_count, 2);
    assert_eq!(
        f.counts(),
        (before.0 + 1, before.1 + 1),
        "the interval creates a moment"
    );
    let authors: String = f.read(|db| {
        db.query_row(
            "SELECT author_json FROM moments WHERE moment_id=?1",
            [&settled.moment_id],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&authors).unwrap(),
        serde_json::json!([
            {"kind":"agent","agentId":"review-agent","onBehalfOf":"owner","depth":1},
            {"kind":"agent","agentId":"trip-agent","onBehalfOf":"owner","depth":1},
        ])
    );
    f.assert_projection();
}

/// A delivery whose agent the next settlement could not name within the
/// moment's author bounds waits for that settlement instead of being
/// truncated. After it, the same delivery applies.
#[tokio::test]
async fn declared_agent_past_the_author_bound_waits_for_settlement() {
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    // Escaped quotes make each author entry as large as the contract allows.
    let large = |index: usize| {
        let mut declared = agent(&format!("{index:03}{}", "\"".repeat(509)), "owner").unwrap();
        declared.on_behalf_of = Some("\"".repeat(512));
        Some(declared)
    };
    let mut terminal = None;
    let mut refused = None;
    for index in 0..80 {
        let bytes = f.doc.richdoc_append_paragraph(&format!("p{index}"));
        let cursor = index as i64 + 3;
        let (receipt, result) = f
            .apply_declared(cursor, bytes.clone(), owner_authority(), 2, large(index))
            .await;
        match result {
            ApplicationResult::Applied(..) => terminal = Some(receipt),
            ApplicationResult::Pending(ApplicationPending::SettlementRequired) => {
                refused = Some((index, cursor, bytes));
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let (index, cursor, bytes) = refused.expect("the author bound refuses a delivery");
    assert!(index > 1);
    f.read(|db| {
        let applied: i64 = db
            .query_row(
                "SELECT count(*) FROM live_device_update_applications WHERE journal_cursor=?1",
                [cursor],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(applied, 0, "a refused delivery writes nothing");
    });
    f.settle(terminal, 100, Arc::new(NoFaults)).await.unwrap();
    let named = latest_authors(&f);
    assert_eq!(named.as_array().unwrap().len(), index);
    assert!(named.to_string().len() <= dohc_engine_domain::MAX_AUTHOR_JSON_BYTES);
    let (terminal, result) = f
        .apply_declared(cursor, bytes, owner_authority(), 2, large(index))
        .await;
    assert!(matches!(result, ApplicationResult::Applied(..)));
    f.settle(Some(terminal), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(latest_authors(&f).as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn live_settlement_history_syncs_after_restore_without_granting_native_authority() {
    use dohc_engine_sync::{
        ApplyDisposition, BlobContent, BlobHydration, NoLiveLeases, SyncError,
        apply_replication_envelope, hydrate_blob_content,
    };
    use yrs::updates::decoder::Decode;
    let f = Fixture::with_relay(true).await;
    let first = f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    // The first baseline covers no accepted edit, so it journals nothing.
    assert_eq!(first.settlement_id, None);
    let expected = std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap();
    let before = yrs::StateVector::decode_v1(&f.doc.encode_state_vector()).unwrap();
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Later\n")
        .unwrap();
    let mut first_seen = Vec::new();
    let after = yrs::StateVector::decode_v1(&f.doc.encode_state_vector()).unwrap();
    for (client, end) in after.iter() {
        let start = before.get(client);
        if *end > start {
            first_seen.push(LiveUpdateStructRange {
                client_id: i64::try_from(client.get()).unwrap(),
                start_clock: i64::from(start),
                end_clock: i64::from(*end),
            });
        }
    }
    first_seen.sort_by_key(|range| range.client_id);
    assert!(!first_seen.is_empty());
    let terminal = LiveUpdateReceipt {
        delivery_id: "link-delivery".into(),
        update_digest: hex_sha256(&update),
        journal_cursor: 7,
        accepting_host_epoch: 1,
    };
    let metadata = AdmittedLiveUpdateMetadata {
        accepted: RelayAcceptedLiveUpdate {
            receipt: terminal.clone(),
            binding: f.binding.clone(),
            authority: ServerDerivedLiveUpdateAuthority::Link {
                principal_id: "link-principal".into(),
                grant_id: "link-grant".into(),
                grant_generation: 1,
            },
            received_at_ms: 2,
        },
        first_seen,
        canonical_version: None,
        author_snapshot: None,
        first_seen_deletes: None,
        checkpoint_coverage: None,
    };
    assert!(matches!(
        f.handle
            .apply(
                AdmittedLiveUpdate {
                    metadata: metadata.clone(),
                    update_bytes: update,
                },
                Arc::new(NoFaults),
                100_000_000
            )
            .await
            .unwrap(),
        ApplicationResult::Applied(..)
    ));
    let second = f
        .settle(Some(terminal.clone()), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    // The relay has not acknowledged either settlement moment. Their
    // before-images publish only while this generation is current.
    let fence_state = |f: &Fixture| {
        f.read(|db| {
            db.query_row(
                "SELECT (SELECT count(*) FROM live_restore_fences),(SELECT available FROM live_device_application_bindings),(SELECT restore_fence_generation FROM live_device_application_bindings)",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
            )
            .unwrap()
        })
    };
    assert_eq!(fence_state(&f), (0, 1, 0));
    assert!(matches!(
        f.owner
            .fence_restore(
                NativeRestoreFence {
                    point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                        journal_cursor: 0,
                        receipt_digest: f.binding.lineage_claim_id.clone()
                    },
                    operation_id: "restore-settlement".into(),
                    relay_database_namespace: "relay".into(),
                    old_binding: f.binding.clone(),
                    host_id: "host".into(),
                    new_fence: 1,
                    origin: RestoreDeliveryOrigin::Bootstrap {
                        id: "bootstrap".into(),
                    },
                    terminal: Some(terminal.clone()),
                    applied_sequence: 1,
                },
                restore_coordinate(),
                20,
                Arc::new(NoFaults),
            )
            .await,
        Err(RuntimeError::LiveApplication(
            ApplicationError::PublicationPending
        ))
    ));
    assert_eq!(fence_state(&f), (0, 1, 0));
    // Ordinary publication reaches the relay: it acknowledges the local
    // origin through the journal's high-water mark, as a completed push does.
    rusqlite::Connection::open(&f.db)
        .unwrap()
        .execute(
            "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) SELECT workspace_id,origin_id,max(origin_seq) FROM replication_log WHERE workspace_id='workspace' AND origin_id='owner-origin' GROUP BY workspace_id,origin_id ON CONFLICT(workspace_id,origin_id) DO UPDATE SET pushed_seq=MAX(pushed_seq,excluded.pushed_seq)",
            [],
        )
        .unwrap();
    let restore = applied_restore(&f, Some(terminal), 1).await;
    let final_settlement = settle_restore(&f, restore.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        settle_restore(&f, restore, Arc::new(NoFaults))
            .await
            .unwrap()
            .settlement_id,
        final_settlement.settlement_id
    );
    assert_eq!(
        std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap(),
        expected
    );
    f.supervisor.close(&f.db).unwrap();
    let mut source = EngineStore::open(&f.db, 40).unwrap();
    let final_content_digest: String = source
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(proposal_json,'$.finalContentDigest') FROM live_restore_fences WHERE operation_id='restore-settlement'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_ne!(final_content_digest, hex_sha256(&expected));
    let key = dohc_engine_collab::DocKey::new("workspace", "main", "object").unwrap();
    assert!(matches!(
        dohc_engine_collab::maybe_compact(&mut source, &key, 0, &NoFaults, 40).unwrap(),
        dohc_engine_storage::TxnOutcome::Committed(dohc_engine_collab::CompactOutcome::Compacted { pruned_updates, .. }) if pruned_updates > 0
    ));
    let ops = dohc_engine_sync::list_replication_ops(&source, "workspace", "owner-origin", -1, 500)
        .unwrap();
    for settlement in [&second, &final_settlement] {
        let moments: Vec<_> = ops
            .iter()
            .filter(|op| {
                op.op_kind == "moment.append" && op.payload["momentId"] == settlement.moment_id
            })
            .collect();
        assert_eq!(
            moments.len(),
            1,
            "settled files must reach share viewers once"
        );
        assert_eq!(
            moments[0].payload["payloadAfterBlobSha256"],
            settlement.markdown_digest
        );
        assert_eq!(
            moments[0].payload["payloadAfterPath"],
            f.binding.current_path
        );
    }
    let settlements: Vec<_> = ops
        .iter()
        .filter(|op| op.op_kind == "live.audit.settlement")
        .cloned()
        .collect();
    assert_eq!(settlements.len(), 2);
    assert_eq!(
        settlements[0].payload["record"]["settlementId"],
        serde_json::json!(second.settlement_id)
    );
    assert_eq!(
        settlements[1].payload["record"]["restoreOperationId"],
        "restore-settlement"
    );
    let binary: Vec<(String, Vec<u8>)> = source
        .read_with(|conn| {
            conn.prepare("SELECT sha256,bytes FROM binary_blobs")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, rusqlite::Error>>()
        })
        .unwrap();
    let texts: Vec<(String, String)> = source
        .read_with(|conn| {
            conn.prepare("SELECT sha256,text FROM blobs")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, rusqlite::Error>>()
        })
        .unwrap();
    let (_receiver_root, receiver_path, mut receiver) = dohc_engine_testkit::open_store();
    for (sha256, bytes) in binary {
        hydrate_blob_content(
            &mut receiver,
            &BlobHydration {
                sha256,
                content: BlobContent::Binary(bytes),
            },
            &NoFaults,
        )
        .unwrap();
    }
    for (sha256, text) in texts {
        hydrate_blob_content(
            &mut receiver,
            &BlobHydration {
                sha256,
                content: BlobContent::Text(text),
            },
            &NoFaults,
        )
        .unwrap();
    }
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        let result =
            apply_replication_envelope(&mut receiver, &mut cache, &op, &NoFaults, &NoLiveLeases)
                .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{}: {:?}",
            op.op_kind,
            result.primary
        );
        if op.op_kind == "live.audit.base" {
            let mut missing = settlements[0].clone();
            missing.origin_id = "early-settlement".into();
            missing.origin_seq = 0;
            missing.relay_seq = Some(100);
            assert!(matches!(
                apply_replication_envelope(
                    &mut receiver,
                    &mut cache,
                    &missing,
                    &NoFaults,
                    &NoLiveLeases
                ),
                Err(SyncError::RetryableState { .. })
            ));
            assert_eq!(
                dohc_engine_sync::read_replication_acked_seq(
                    &receiver,
                    "workspace",
                    "early-settlement"
                )
                .unwrap(),
                -1
            );
        }
    }
    drop(receiver);
    let mut receiver = EngineStore::open(&receiver_path, 41).unwrap();
    let accepted_bytes = read_link_audit_record(&receiver);
    let accepted_record: serde_json::Value = serde_json::from_slice(&accepted_bytes).unwrap();
    assert_eq!(
        accepted_record["metadata"],
        serde_json::to_value(&metadata).unwrap()
    );
    receiver
        .read_with(|conn| -> Result<(), rusqlite::Error> {
            let count: i64 =
                conn.query_row("SELECT count(*) FROM live_audit_settlements", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 2);
            let restore:(String,String)=conn.query_row("SELECT restore_operation_id,restore_markdown_digest FROM live_audit_events WHERE restore_operation_id IS NOT NULL",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(restore,("restore-settlement".into(),hex_sha256(&expected)));
            let chunks:Vec<Vec<u8>>=conn.prepare("SELECT b.bytes FROM live_audit_events e JOIN live_audit_record_chunks c ON c.record_digest=e.record_digest JOIN binary_blobs b ON b.sha256=c.chunk_sha256 WHERE e.restore_operation_id IS NOT NULL ORDER BY c.ordinal")?.query_map([],|r|r.get(0))?.collect::<Result<_,_>>()?;
            let bytes:Vec<u8>=chunks.into_iter().flatten().collect();
            let audit:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
            assert_eq!(audit["sourceRestore"]["operationId"],"restore-settlement");
            assert_eq!(audit["sourceRestore"]["oldGeneration"],0);
            assert_eq!(audit["sourceRestore"]["selected"]["eventCount"],0);
            assert_eq!(audit["sourceRestore"]["accepted"]["eventCount"],1);
            assert_eq!(audit["metadata"]["accepted"]["binding"]["restoreFenceGeneration"],1);
            assert_eq!(audit["sourceRestore"]["point"]["markdownDigest"],hex_sha256(&expected));
            assert_eq!(audit["sourceRestore"]["finalContentDigest"],final_content_digest);
            assert!(audit["sourceRestore"].get("nativeSources").is_none());
            for table in [
                "live_device_settlements",
                "live_device_application_bindings",
                "live_device_update_applications",
                "live_owner_adoptions",
                "live_restore_fences",
            ] {
                let count: i64 =
                    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
                assert_eq!(count, 0, "{table}");
            }
            let projection: String = conn.query_row(
                "SELECT markdown_digest FROM live_audit_settlements WHERE settlement_id=?1",
                [&final_settlement.settlement_id],
                |row| row.get(0),
            )?;
            assert_eq!(projection, hex_sha256(&expected));
            assert!(
                conn.execute("DELETE FROM blobs WHERE sha256=?1", [projection])
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    let mut forged_restore = settlements[1].clone();
    forged_restore.origin_id = "forged-restore-linkage".into();
    forged_restore.origin_seq = 0;
    forged_restore.relay_seq = Some(199);
    let valid_restore_json = serde_json::to_string(&forged_restore.payload["record"]).unwrap();
    let forged_restore_json = valid_restore_json.replace("restore-settlement", "forged-restore");
    assert_ne!(forged_restore_json, valid_restore_json);
    forged_restore.payload["record"] = serde_json::from_str(&forged_restore_json).unwrap();
    // Hash the typed record's canonical field order retained in the source payload.
    let stored_restore: String = receiver
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_json FROM live_audit_settlements WHERE settlement_id=?1",
                [&final_settlement.settlement_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    forged_restore.payload["recordDigest"] = serde_json::json!(hex_sha256(
        stored_restore
            .replace("restore-settlement", "forged-restore")
            .as_bytes()
    ));
    assert!(matches!(
        apply_replication_envelope(
            &mut receiver,
            &mut cache,
            &forged_restore,
            &NoFaults,
            &NoLiveLeases
        )
        .unwrap()
        .primary,
        ApplyDisposition::Refused(_)
    ));
    let retained: String = receiver
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_json FROM live_audit_settlements WHERE settlement_id=?1",
                [&second.settlement_id],
                |row| row.get(0),
            )
        })
        .unwrap();
    let malformed = retained.replace("\"acceptedEventCount\":1", "\"acceptedEventCount\":2");
    assert_ne!(malformed, retained);
    let mut forged = settlements[0].clone();
    forged.origin_id = "forged-interval".into();
    forged.origin_seq = 0;
    forged.relay_seq = Some(200);
    forged.payload["record"] = serde_json::from_str(&malformed).unwrap();
    forged.payload["recordDigest"] = serde_json::json!(hex_sha256(malformed.as_bytes()));
    assert!(matches!(
        apply_replication_envelope(&mut receiver, &mut cache, &forged, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    let conflicting = retained.replace(
        "\"connectionId\":\"connection\"",
        "\"connectionId\":\"other-connection\"",
    );
    assert_ne!(conflicting, retained);
    forged.origin_id = "conflicting-settlement".into();
    forged.relay_seq = Some(201);
    forged.payload["record"] = serde_json::from_str(&conflicting).unwrap();
    forged.payload["recordDigest"] = serde_json::json!(hex_sha256(conflicting.as_bytes()));
    assert!(matches!(
        apply_replication_envelope(&mut receiver, &mut cache, &forged, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    receiver
        .read_with(|conn| -> Result<(), rusqlite::Error> {
            let conflict_count: i64 = conn.query_row(
                "SELECT count(*) FROM live_audit_settlement_conflicts",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(conflict_count, 1);
            let still: String = conn.query_row(
                "SELECT record_json FROM live_audit_settlements WHERE settlement_id=?1",
                [&second.settlement_id],
                |row| row.get(0),
            )?;
            assert_eq!(still, retained);
            Ok(())
        })
        .unwrap();
    resolve_imported_history_successor(
        receiver,
        &receiver_path,
        &key,
        &f.binding.lineage_claim_id,
        &accepted_bytes,
        &retained,
    )
    .await;
}

fn read_link_audit_record(store: &EngineStore) -> Vec<u8> {
    store.read_with(|conn| {
        conn.prepare("SELECT b.bytes FROM live_audit_events e JOIN live_audit_record_chunks c ON c.record_digest=e.record_digest JOIN binary_blobs b ON b.sha256=c.chunk_sha256 WHERE e.delivery_id='link-delivery' ORDER BY c.ordinal")?
            .query_map([], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<Result<Vec<_>, rusqlite::Error>>()
    }).unwrap().into_iter().flatten().collect()
}

async fn resolve_imported_history_successor(
    mut store: EngineStore,
    db: &std::path::Path,
    key: &dohc_engine_collab::DocKey,
    predecessor: &str,
    accepted_bytes: &[u8],
    settlement_record: &str,
) {
    use dohc_engine_domain::{
        ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, ResolveConflictKind,
        ResolveTextConflict, TextConflict, VersionedTextStore,
    };
    let current = VersionedTextStore::new(&mut store)
        .read_text("workspace", "main", "notes/example.md")
        .unwrap()
        .unwrap();
    let mut incoming = current.clone();
    incoming.version_id = "incoming-version".into();
    incoming.object_id = "incoming-object".into();
    incoming.text = "# Conflicting incoming\n".into();
    incoming.blob_sha256 = hex_sha256(incoming.text.as_bytes());
    incoming.latest_moment_id = "incoming-moment".into();
    incoming.updated_at_ms = 50;
    dohc_engine_sync::journal_local_replication_op(
        &mut store,
        "workspace",
        "receiver-origin",
        "epoch",
        "stream",
        "workspace.init",
        &serde_json::json!({}),
        50,
        &NoFaults,
    )
    .unwrap();
    dohc_engine_sync::commit_relay_cursor(
        &mut store,
        "workspace",
        &dohc_engine_sync::RelayCursor {
            bootstrap_complete: true,
            cursor: 500,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: None,
            ordinary_pull: None,
        },
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
        50,
    )
    .unwrap();
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(db, 51).unwrap().actor;
    actor
        .conflict_open(
            Box::new(TextConflict {
                conflict_id: "imported-history-conflict".into(),
                workspace_id: "workspace".into(),
                path: current.path.clone(),
                target_version_id: "main".into(),
                source_version_id: "incoming-version".into(),
                created_at_ms: 50,
                updated_at_ms: 50,
                status: ConflictStatus::Open,
                chosen_from: ConflictChoice::Current,
                resolution: None,
                metadata: ConflictMetadata::origin("api"),
                base: ConflictFileState::text(&current.path, None),
                current: ConflictFileState::text(&current.path, Some(current.clone())),
                incoming: ConflictFileState::text(&current.path, Some(incoming)),
            }),
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    actor
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: "workspace".into(),
                conflict_id: "imported-history-conflict".into(),
                resolution: ResolveConflictKind::KeepCurrent,
                object_id: "successor-object".into(),
                write_moment_id: "successor-write".into(),
                delete_moment_id: "successor-delete".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 52,
                request_id: Some("successor-request".into()),
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(db).unwrap();
    let store = EngineStore::open(db, 53).unwrap();
    let marker = dohc_engine_collab::read_marker(&store, key)
        .unwrap()
        .unwrap();
    let successor = marker.lineage_claim_id.unwrap();
    assert_ne!(successor, predecessor);
    assert_eq!(marker.lineage_parent_claim_id.as_deref(), Some(predecessor));
    assert_eq!(
        dohc_engine_collab::load_persisted(&store, key)
            .unwrap()
            .unwrap()
            .doc
            .project(ContentKind::Richdoc)
            .unwrap()
            .content,
        current.text
    );
    assert_eq!(read_link_audit_record(&store), accepted_bytes);
    let records: Vec<String> = store
        .read_with(|conn| {
            conn.prepare("SELECT record_json FROM live_audit_settlements ORDER BY settlement_id")?
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, rusqlite::Error>>()
        })
        .unwrap();
    assert_eq!(records.len(), 2);
    assert!(records.iter().any(|record| record == settlement_record));
    let ops =
        dohc_engine_sync::list_replication_ops(&store, "workspace", "receiver-origin", -1, 500)
            .unwrap();
    let resolutions: Vec<_> = ops
        .iter()
        .filter(|op| op.op_kind == "conflict.resolve")
        .collect();
    assert_eq!(resolutions.len(), 1);
    assert_eq!(
        resolutions[0].payload["lineageTransition"]["predecessorClaimId"],
        predecessor
    );
    assert_eq!(
        resolutions[0].payload["lineageTransition"]["successor"]["lineageClaimId"],
        successor
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.supervisor.close(&self.db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_fence_serializes_queued_writes_and_preserves_other_documents() {
    struct Block {
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl FaultInjector for Block {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == FaultPoint::StorageBeforePersist {
                if let Some(entered) = self.entered.lock().unwrap().take() {
                    entered.send(()).unwrap();
                    self.release.lock().unwrap().recv().unwrap();
                }
            }
            FaultAction::Continue
        }
    }
    let f = Fixture::new().await;
    let actor = f.supervisor.open(&f.db, 2).unwrap().actor;
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    let input = NativeRestoreFence {
        point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
        },
        operation_id: "restore".into(),
        relay_database_namespace: "relay".into(),
        old_binding: f.binding.clone(),
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: None,
        applied_sequence: 0,
    };
    let (entered, at_commit) = tokio::sync::oneshot::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let mut fence = Box::pin(f.owner.fence_restore(
        input.clone(),
        coordinate.clone(),
        3,
        Arc::new(Block {
            entered: std::sync::Mutex::new(Some(entered)),
            release: std::sync::Mutex::new(wait_release),
        }),
    ));
    std::future::poll_fn(|cx| {
        assert!(fence.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    at_commit.await.unwrap();
    let key = dohc_engine_collab::DocKey::new("workspace", "main", "object").unwrap();
    let mut local = Box::pin(actor.ydoc_record_update(
        key,
        f.binding.current_path.clone(),
        ContentKind::Richdoc,
        dohc_engine_collab::Regime::Replicated,
        vec![0, 0],
        None,
        None,
        Some(f.binding.lineage_claim_id.clone()),
        false,
        None,
        None,
        4,
        Arc::new(NoFaults),
        tokio_util::sync::CancellationToken::new(),
        None,
    ));
    let remote = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "late".into(),
                    update_digest: hex_sha256(&[0, 0]),
                    journal_cursor: 1,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 4,
            },
            first_seen: vec![],
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes: vec![0, 0],
    };
    let mut remote = Box::pin(f.handle.apply(remote, Arc::new(NoFaults), 100_000_000));
    std::future::poll_fn(|cx| {
        assert!(local.as_mut().poll(cx).is_pending());
        assert!(remote.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    release.send(()).unwrap();
    assert_eq!(fence.await.unwrap().local_head_sequence, 0);
    assert!(local.await.is_err());
    assert!(matches!(
        remote.await.unwrap(),
        ApplicationResult::Pending(_)
    ));
    assert!(f.settle(None, 4, Arc::new(NoFaults)).await.is_err());
    assert!(
        f.owner
            .register(
                "another-relay".into(),
                coordinate.clone(),
                f.binding.clone()
            )
            .await
            .is_err()
    );
    let other = dohc_engine_collab::DocKey::new("workspace", "main", "other").unwrap();
    let doc = Ydoc::wire();
    actor
        .ydoc_record_update(
            other,
            "other.txt".into(),
            ContentKind::Plaintext,
            dohc_engine_collab::Regime::LocalOnly,
            doc.plaintext_insert(0, "unrelated"),
            None,
            None,
            None,
            false,
            None,
            None,
            5,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    let receipt = f
        .owner
        .fence_restore(input, coordinate, 6, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(receipt.recorded_at_ms, 3);
}

#[tokio::test]
async fn restore_fence_accepts_terminal_history_under_an_earlier_selector() {
    let mut f = Fixture::new().await;
    let terminal = f.apply_folder_scope().await;
    let input = NativeRestoreFence {
        point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
        },
        operation_id: "restore".into(),
        relay_database_namespace: "relay".into(),
        old_binding: f.binding.clone(),
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: Some(terminal),
        applied_sequence: 1,
    };
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    assert_eq!(
        f.owner
            .fence_restore(input, coordinate, 3, Arc::new(NoFaults))
            .await
            .unwrap()
            .local_head_sequence,
        1
    );
}

#[tokio::test]
async fn restore_fence_recovers_first_commit_after_reconnect_without_readoption() {
    let f = Fixture::new().await;
    let input = NativeRestoreFence {
        point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
            journal_cursor: 0,
            receipt_digest: f.binding.lineage_claim_id.clone(),
        },
        operation_id: "restore-reconnected".into(),
        relay_database_namespace: "relay".into(),
        old_binding: f.binding.clone(),
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: None,
        applied_sequence: 0,
    };
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 2,
        instance_id: "restarted-instance".into(),
        connection_id: "reconnected".into(),
    };
    let snapshot = || {
        let conn = rusqlite::Connection::open_with_flags(
            &f.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        [
            "live_device_application_bindings",
            "live_restore_fences",
            "live_owner_adoptions",
            "owner_ydoc_outboxes",
            "ydoc_docs",
            "live_device_update_applications",
        ]
        .map(|table| {
            let mut query = conn
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let count = query.column_count();
            query
                .query_map([], |row| {
                    (0..count)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
    };
    let before = snapshot();
    f.supervisor.close(&f.db).unwrap();
    let actor = f.supervisor.open(&f.db, 2).unwrap().actor;
    let replacement = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    assert!(
        f.owner
            .fence_restore_after_reconnect(input.clone(), coordinate.clone(), 3, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(snapshot(), before, "retired connection cannot fence");
    assert!(
        replacement
            .fence_restore(input.clone(), coordinate.clone(), 3, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(
        snapshot(),
        before,
        "strict entry retains exact coordinate checks"
    );
    for variant in 0..11 {
        let mut wrong = input.clone();
        let mut host = coordinate.clone();
        match variant {
            0 => {
                wrong.host_id = "foreign-host".into();
                host.host_id = wrong.host_id.clone();
            }
            1 => wrong.operation_id.clear(),
            2 => wrong.relay_database_namespace = "foreign-relay".into(),
            3 => wrong.old_binding.current_path = "elsewhere.md".into(),
            4 => wrong.old_binding.lineage_claim_id = "f".repeat(64),
            5 => {
                wrong.origin = RestoreDeliveryOrigin::Bootstrap {
                    id: "foreign-bootstrap".into(),
                }
            }
            6 => {
                wrong.origin = RestoreDeliveryOrigin::Owner {
                    id: "foreign-owner".into(),
                }
            }
            7 => wrong.applied_sequence = 1,
            8 => wrong.new_fence = 2,
            9 => wrong.old_binding.selector_paths = vec!["notes".into()],
            _ => {
                wrong.terminal = Some(LiveUpdateReceipt {
                    delivery_id: "unapplied".into(),
                    update_digest: "a".repeat(64),
                    journal_cursor: 1,
                    accepting_host_epoch: 1,
                })
            }
        }
        assert!(
            replacement
                .fence_restore_after_reconnect(wrong, host, 3, Arc::new(NoFaults))
                .await
                .is_err(),
            "variant {variant}"
        );
        assert_eq!(
            snapshot(),
            before,
            "variant {variant} changed durable state"
        );
    }
    let receipt = replacement
        .fence_restore_after_reconnect(input.clone(), coordinate.clone(), 4, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(receipt.operation, input);
    assert_eq!(receipt.local_head_sequence, 0);
    let stopped = snapshot();
    let mut wrong = input.clone();
    wrong.operation_id = "different-operation".into();
    assert!(
        replacement
            .fence_restore_after_reconnect(wrong, coordinate.clone(), 5, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(snapshot(), stopped, "wrong replay operation changed state");
    assert_eq!(
        replacement
            .fence_restore_after_reconnect(input, coordinate, 6, Arc::new(NoFaults))
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(snapshot(), stopped, "exact replay changed state");
}

#[tokio::test]
async fn stopped_bootstrap_preserves_replay_after_file_mutation_attempts() {
    use dohc_engine_domain::{DeleteTextFile, RenameTextFile, WriteBinary};
    use dohc_engine_runtime::CancellationToken;
    for mutation in ["rename", "delete", "binary"] {
        let f = Fixture::new().await;
        f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
        let actor = f.supervisor.open(&f.db, 2).unwrap().actor;
        let coordinate = ApplicationHostCoordinate {
            host_id: "host".into(),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        };
        let input = NativeRestoreFence {
            point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                journal_cursor: 0,
                receipt_digest: f.binding.lineage_claim_id.clone(),
            },
            operation_id: "restore".into(),
            relay_database_namespace: "relay".into(),
            old_binding: f.binding.clone(),
            host_id: "host".into(),
            new_fence: 1,
            origin: RestoreDeliveryOrigin::Bootstrap {
                id: "bootstrap".into(),
            },
            terminal: None,
            applied_sequence: 0,
        };
        let receipt = f
            .owner
            .fence_restore(input.clone(), coordinate.clone(), 3, Arc::new(NoFaults))
            .await
            .unwrap();
        let snapshot = || {
            let conn = rusqlite::Connection::open_with_flags(
                &f.db,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            conn.query_row("SELECT (SELECT COUNT(*) FROM moments), (SELECT COUNT(*) FROM binary_blobs), (SELECT path FROM ydoc_docs WHERE object_id='object'), (SELECT COUNT(*) FROM live_restore_fences)", [], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).unwrap()
        };
        let before = snapshot();
        let original = std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap();
        let result = match mutation {
            "rename" => actor
                .versioned_text_rename(
                    RenameTextFile {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        from_path: f.binding.current_path.clone(),
                        to_path: "moved.md".into(),
                        moment_id: "rename-stopped".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 4,
                    },
                    f.root.path().to_owned(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .map(|_| ()),
            "delete" => actor
                .versioned_text_delete(
                    DeleteTextFile {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        path: f.binding.current_path.clone(),
                        moment_id: "delete-stopped".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 4,
                    },
                    f.root.path().to_owned(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .map(|_| ()),
            _ => actor
                .versioned_binary_write(
                    WriteBinary {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "replacement".into(),
                        path: f.binding.current_path.clone(),
                        bytes: vec![0, 1, 2, 3],
                        moment_id: "binary-stopped".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 4,
                    },
                    f.root.path().to_owned(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .map(|_| ()),
        };
        let error = result.expect_err("file mutation must refuse a stopped bootstrap document");
        assert!(
            error.to_string().contains("live document is stopped"),
            "{mutation}: {error}"
        );
        assert_eq!(
            snapshot(),
            before,
            "{mutation} must not change durable state"
        );
        assert_eq!(
            std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap(),
            original
        );
        assert!(!f.root.path().join("moved.md").exists());
        assert_eq!(
            f.owner
                .fence_restore(input, coordinate, 5, Arc::new(NoFaults))
                .await
                .unwrap(),
            receipt
        );
    }
}

/// A live-shared record on the session host: the owner's and a
/// collaborator's accepted frames each claim once. Settling the session,
/// capturing the settled file, and reconciling the Collection claim nothing
/// more.
#[tokio::test]
async fn accepted_frames_claim_once_through_settlement_and_capture() {
    use dohc_engine_domain::{AutomationChangeKind, AutomationSubscription};
    const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PATH: &str = "tasks/alpha.md";
    let source = Ydoc::wire();
    source.apply(&vector("ordinary-frontmatter-order")).unwrap();
    source.frontmatter_set("id", RECORD).expect("set id");
    source
        .frontmatter_set("status", "open")
        .expect("set status");
    let f = Fixture::build(false, source.encode_full_state(), PATH, |store| {
        dohc_engine_domain::VersionedTextStore::new(store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "schema-object".into(),
                    path: "tasks/collection.yaml".into(),
                    text: "fields:\n  status:\n    type: text\n".into(),
                    moment_id: "schema".into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 0,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    })
    .await;
    let actor = f.supervisor.open(&f.db, 2).unwrap().actor;
    let reconcile = async |now_ms: i64| {
        actor
            .reconcile_collections(
                "workspace".into(),
                "main".into(),
                f.root.path().to_owned(),
                dohc_engine_collab::LeaseRegistry::new(),
                Arc::new(()),
                now_ms,
                Arc::new(NoFaults),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap()
            .automation_claims
    };
    // Bind the bootstrapped record as adopted; its file reaches disk only
    // when the session settles.
    let mut raw = rusqlite::Connection::open(&f.db).unwrap();
    let tx = raw
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    dohc_engine_domain::reconcile_collections_in_tx(&tx, "workspace", "main").unwrap();
    dohc_engine_domain::set_collection_adoption_state_in_tx(
        &tx,
        "workspace",
        "main",
        PATH,
        RECORD,
        "adopted",
    )
    .unwrap();
    tx.commit().unwrap();
    drop(raw);
    actor
        .automation_subscribe(
            "workspace".into(),
            AutomationSubscription {
                automation_id: "collection:tasks#watch".into(),
                prefix: "tasks".into(),
                kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
                fields: None,
            },
            4,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    let claims = || -> Vec<(String, Option<String>)> {
        f.read(|db| {
            let mut statement = db
                .prepare(
                    "SELECT change_kind, author_origin_id FROM automation_claims \
                     ORDER BY created_at_ms, claim_id",
                )
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
    };

    f.apply(
        5,
        source
            .frontmatter_set("status", "done")
            .expect("set status"),
    )
    .await;
    // The collaborator's frame arrives later, so its claim sorts after.
    let terminal = f
        .apply_as(
            6,
            source
                .frontmatter_set("status", "late")
                .expect("set status"),
            ServerDerivedLiveUpdateAuthority::Named {
                principal_id: "guest".into(),
                grant_id: "grant".into(),
                grant_generation: 1,
            },
            6,
        )
        .await;
    let accepted = vec![
        ("changed".to_owned(), Some("owner".to_owned())),
        ("changed".to_owned(), Some("guest".to_owned())),
    ];
    assert_eq!(claims(), accepted, "each accepted frame claims once");

    f.settle(Some(terminal), 4, Arc::new(NoFaults))
        .await
        .unwrap();
    let settled = std::fs::read_to_string(f.root.path().join(PATH)).unwrap();
    assert!(settled.contains("status: late"), "{settled}");
    let captured = actor
        .capture_ingest_indexed(
            dohc_engine_domain::CaptureIngest {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                path: PATH.into(),
                text: settled,
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
                request_id: None,
                claim_foreign_head: true,
            },
            f.root.path().to_owned(),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(captured.automation_claims.is_empty());
    assert!(reconcile(21).await.is_empty());
    assert_eq!(
        claims(),
        accepted,
        "settlement and capture claim nothing more"
    );
}

#[tokio::test]
async fn configured_settlement_projects_baseline_updates_and_unchanged_coverage() {
    let f = Fixture::new().await;
    assert!(!f.root.path().join(&f.binding.current_path).exists());
    let baseline = f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
    assert!(baseline.materialized);
    assert_eq!(baseline.application_count, 0);
    // The first baseline covers no accepted edit, so nothing is recorded.
    assert_eq!(baseline.settlement_id, None);
    f.assert_projection();
    let counts = f.counts();
    assert_eq!(counts.0, 0);
    assert_eq!(
        f.settle(None, 4, Arc::new(NoFaults))
            .await
            .unwrap()
            .settlement_id,
        baseline.settlement_id
    );
    assert_eq!(f.counts(), counts);
    let update = f.apply(3, vector("ordinary-frontmatter-order")).await;
    assert!(f.settle(None, 4, Arc::new(NoFaults)).await.is_err());
    let settled = f
        .settle(Some(update.clone()), 4, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(
        (
            settled.previous_cursor,
            settled.terminal_cursor,
            settled.application_count
        ),
        (0, 3, 1)
    );
    f.assert_projection();
    let counts = f.counts();
    assert_eq!(
        f.settle(Some(update), 4, Arc::new(NoFaults))
            .await
            .unwrap()
            .settlement_id,
        settled.settlement_id
    );
    assert_eq!(f.counts(), counts);
    let noop = f.apply(7, vec![0, 0]).await;
    let same = f.settle(Some(noop), 4, Arc::new(NoFaults)).await.unwrap();
    assert_eq!(same.moment_id, settled.moment_id);
    assert_eq!(same.application_count, 1);
    assert_eq!(f.counts(), (counts.0 + 1, counts.1));
    f.owner.retire();
    assert!(f.settle(None, 4, Arc::new(NoFaults)).await.is_err());
}

#[tokio::test]
async fn a_stored_settlement_that_starts_where_it_ends_still_opens_and_reads() {
    let mut f = Fixture::with_relay(true).await;
    f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
    // Earlier builds recorded the first baseline as an interval from 0 to 0.
    f.supervisor.close(&f.db).unwrap();
    let (moment, markdown, sequence): (String, String, i64) = f.read(|db| {
        db.query_row(
            "SELECT s.latest_moment_id,s.blob_sha256,d.head_update_seq FROM snapshots s JOIN ydoc_docs d ON d.object_id=s.object_id WHERE s.object_id='object'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    });
    let state_vector = hex_sha256(&f.doc.encode_state_vector());
    let interval = hex_sha256(b"[]");
    let identity = serde_json::to_vec(&(
        "relay",
        &f.binding,
        0,
        0,
        0,
        sequence,
        &interval,
        &moment,
        &markdown,
        &state_vector,
    ))
    .unwrap();
    let id = format!("live-settlement-{}", hex_sha256(&identity));
    let state = f.doc.encode_full_state();
    let mut store = EngineStore::open(&f.db, 1).unwrap();
    store.write_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO live_device_settlements VALUES (?1,'relay','workspace','main','object',?2,0,0,0,?3,0,?4,?5,?6,?7,?8,?9,1,'ordinary',NULL)",
            rusqlite::params![id, f.binding.lineage_claim_id, sequence, interval, moment, markdown, state_vector,
                serde_json::to_string(&f.binding).unwrap(), serde_json::to_string(&restore_coordinate()).unwrap()],
        ).map_err(dohc_engine_storage::StorageError::persist_public)?;
        let digest = dohc_engine_storage::put_binary_blob(tx, &state)?;
        tx.execute(
            "INSERT INTO live_settlement_publication_states(settlement_id,state_blob_sha256) VALUES (?1,?2)",
            rusqlite::params![id, digest],
        ).map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_, dohc_engine_storage::StorageError>(())
    }).unwrap();
    drop(store);
    (f.owner, f.handle) = open_owner(&f.supervisor, &f.db, &f.binding).await;

    let replayed = f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
    assert_eq!(replayed.settlement_id.as_deref(), Some(id.as_str()));
    assert_eq!((replayed.previous_cursor, replayed.terminal_cursor), (0, 0));
    let journaled: (i64, i64) = f.read(|db| {
        db.query_row(
            "SELECT json_extract(payload_json,'$.record.previousCursor'),json_extract(payload_json,'$.record.terminalCursor') FROM replication_log WHERE op_kind='live.audit.settlement' AND json_extract(payload_json,'$.record.settlementId')=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    });
    assert_eq!(journaled, (0, 0));

    let update = f.apply(1, vector("ordinary-frontmatter-order")).await;
    let next = f.settle(Some(update), 4, Arc::new(NoFaults)).await.unwrap();
    assert_eq!(
        (
            next.previous_cursor,
            next.terminal_cursor,
            next.application_count
        ),
        (0, 1, 1)
    );
    assert_ne!(next.settlement_id.as_deref(), Some(id.as_str()));
    f.assert_projection();
}

struct Crash(FaultPoint);
impl FaultInjector for Crash {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.0 {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

struct Rival {
    path: PathBuf,
    injected: std::sync::atomic::AtomicBool,
}
impl FaultInjector for Rival {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::MaterializeBeforePreimageRevalidate
            && !self
                .injected
                .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            std::fs::write(&self.path, "rival survives").unwrap();
        }
        FaultAction::Continue
    }
}

#[tokio::test]
async fn configured_settlement_recovers_compensated_conflict_after_operator_restores_preimage() {
    for already_settled in [false, true] {
        let f = Fixture::new().await;
        let path = f.root.path().join(&f.binding.current_path);
        let original = if already_settled {
            f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
            Some(std::fs::read(&path).unwrap())
        } else {
            None
        };
        let terminal = f.apply(1, vector("ordinary-frontmatter-order")).await;
        assert!(
            f.settle(
                Some(terminal.clone()),
                4,
                Arc::new(Rival {
                    path: path.clone(),
                    injected: std::sync::atomic::AtomicBool::new(false)
                })
            )
            .await
            .is_err()
        );
        let counts = f.counts();
        let id:String=f.read(|db|db.query_row("SELECT settlement_id FROM live_device_settlements ORDER BY terminal_cursor DESC LIMIT 1",[],|r|r.get(0)).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "rival survives");
        assert!(
            f.settle(Some(terminal.clone()), 4, Arc::new(NoFaults))
                .await
                .is_err()
        );
        assert_eq!(f.counts(), counts);
        if let Some(bytes) = &original {
            std::fs::write(&path, bytes).unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
        }
        assert!(
            f.settle(
                Some(terminal.clone()),
                4,
                Arc::new(Rival {
                    path: path.clone(),
                    injected: std::sync::atomic::AtomicBool::new(false)
                })
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "rival survives");
        assert_eq!(f.counts(), counts);
        if let Some(bytes) = &original {
            std::fs::write(&path, bytes).unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
        }
        let recovered = f
            .settle(Some(terminal), 4, Arc::new(NoFaults))
            .await
            .unwrap();
        assert!(recovered.materialized);
        assert_eq!(recovered.settlement_id, Some(id));
        assert_eq!(f.counts(), counts);
        f.assert_projection();
    }
}

#[tokio::test]
async fn configured_settlement_does_not_rearm_a_conflict_over_newer_completed_work() {
    let f = Fixture::new().await;
    let path = f.root.path().join(&f.binding.current_path);
    let terminal = f.apply(1, vector("ordinary-frontmatter-order")).await;
    assert!(
        f.settle(
            Some(terminal.clone()),
            4,
            Arc::new(Rival {
                path: path.clone(),
                injected: std::sync::atomic::AtomicBool::new(false)
            })
        )
        .await
        .is_err()
    );
    let counts = f.counts();
    std::fs::remove_file(&path).unwrap();
    let raw = rusqlite::Connection::open(&f.db).unwrap();
    raw.execute("INSERT INTO materialization_jobs (job_id,workspace_id,target_path,content_sha256,preimage_present,preimage_sha256,target_generation,status,created_at_ms,completed_at_ms,operation) SELECT 'newer-job',workspace_id,target_path,content_sha256,preimage_present,preimage_sha256,target_generation+1,'complete',created_at_ms,completed_at_ms,operation FROM materialization_jobs LIMIT 1",[]).unwrap();
    drop(raw);
    assert!(
        f.settle(Some(terminal), 4, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(f.counts(), counts);
    assert!(!path.exists());
}

#[tokio::test]
async fn configured_settlement_bounds_interval_and_preserves_precommit_rollback() {
    let f = Fixture::new().await;
    f.apply(1, vector("ordinary-frontmatter-order")).await;
    let terminal = f.apply(4, vec![0, 0]).await;
    assert!(
        f.settle(Some(terminal.clone()), 1, Arc::new(NoFaults))
            .await
            .is_err()
    );
    assert_eq!(f.counts(), (0, 1));
    assert!(
        f.settle(
            Some(terminal.clone()),
            2,
            Arc::new(Crash(FaultPoint::StorageBeforePersist))
        )
        .await
        .is_err()
    );
    assert_eq!(f.counts(), (0, 1));
    assert!(!f.root.path().join(&f.binding.current_path).exists());
    let result = f
        .settle(Some(terminal), 2, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(result.application_count, 2);
    f.assert_projection();
}

#[tokio::test]
async fn configured_settlement_refuses_a_file_ancestor_before_committing() {
    let f = Fixture::new().await;
    f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
    let path = f.root.path().join(&f.binding.current_path);
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(path.parent().unwrap()).unwrap();
    let obstacle = f.root.path().join("notes");
    std::fs::write(&obstacle, b"owned obstacle").unwrap();
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Later\n")
        .unwrap();
    let terminal = f.apply(7, update).await;
    let state = || {
        f.read(|db| {
        db.query_row(
            "SELECT (SELECT COUNT(*) FROM live_device_settlements), (SELECT COUNT(*) FROM moments), (SELECT COUNT(*) FROM materialization_jobs), (SELECT blob_sha256 FROM snapshots WHERE object_id='object'), (SELECT text FROM engine_search_files_fts WHERE object_id='object')",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
        ).unwrap()
    })
    };
    let before = state();
    let error = f
        .settle(Some(terminal), 4, Arc::new(NoFaults))
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            RuntimeError::Domain(dohc_engine_domain::DomainError::ConflictStaleTarget)
        ),
        "unexpected settlement error: {error:?}",
    );
    assert_eq!(state(), before);
    assert_eq!(std::fs::read(obstacle).unwrap(), b"owned obstacle");
}

#[tokio::test]
async fn configured_settlement_refuses_competing_bootstrap_artifact() {
    let f = Fixture::new().await;
    let path = f.root.path().join(&f.binding.current_path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "competing").unwrap();
    assert!(f.settle(None, 4, Arc::new(NoFaults)).await.is_err());
    assert_eq!(f.counts(), (0, 1));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "competing");
}

#[tokio::test]
async fn configured_settlement_covers_distinct_valid_historical_selectors() {
    let mut f = Fixture::new().await;
    let terminal = f.apply_folder_scope().await;
    let settled = f
        .settle(Some(terminal.clone()), 4, Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(settled.application_count, 1);
    f.assert_projection();
    let raw = rusqlite::Connection::open(&f.db).unwrap();
    raw.execute(
        "UPDATE live_device_update_applications SET selector_paths_json='[\"elsewhere\"]'",
        [],
    )
    .unwrap();
    drop(raw);
    assert!(
        f.settle(Some(terminal), 4, Arc::new(NoFaults))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn configured_settlement_refuses_missing_receipts_and_foreign_local_updates() {
    for damage in [
        "DELETE FROM live_device_update_applications",
        "UPDATE ydoc_docs SET head_update_seq=2",
        "UPDATE ydoc_docs SET content_kind='plaintext'",
    ] {
        let f = Fixture::new().await;
        let terminal = f.apply(1, vec![0, 0]).await;
        let raw = rusqlite::Connection::open(&f.db).unwrap();
        raw.execute(damage, []).unwrap();
        drop(raw);
        assert!(
            f.settle(Some(terminal), 4, Arc::new(NoFaults))
                .await
                .is_err()
        );
        assert_eq!(f.counts(), (0, 1));
    }
}

#[tokio::test]
async fn configured_settlement_recovers_committed_projection_and_pending_materialization() {
    for point in [
        FaultPoint::StorageAfterCommitBeforeAck,
        FaultPoint::MaterializeAfterJobCommit,
        FaultPoint::MaterializeAfterRenameBeforeComplete,
    ] {
        let f = Fixture::new().await;
        let terminal = f.apply(2, vector("ordinary-frontmatter-order")).await;
        let _interrupted = f
            .settle(Some(terminal.clone()), 4, Arc::new(Crash(point)))
            .await;
        let counts = f.counts();
        assert_eq!(counts.0, 1, "{point:?}");
        let original: String = f.read(|db| {
            db.query_row(
                "SELECT settlement_id FROM live_device_settlements",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        let repaired = f
            .settle(Some(terminal), 4, Arc::new(NoFaults))
            .await
            .unwrap();
        assert_eq!(repaired.settlement_id, Some(original));
        assert_eq!(f.counts(), counts);
        assert!(repaired.materialized);
        f.assert_projection();
    }
}

#[tokio::test]
async fn configured_settlement_refuses_changed_binding_or_retained_receipt_path() {
    for damage in [
        "UPDATE live_device_application_bindings SET restore_fence_generation=1",
        "UPDATE live_device_update_applications SET current_path='other.md'",
    ] {
        let f = Fixture::new().await;
        let terminal = f.apply(1, vec![0, 0]).await;
        // Inject retained-evidence corruption between actor operations.
        let raw = rusqlite::Connection::open(&f.db).unwrap();
        raw.execute(damage, []).unwrap();
        drop(raw);
        assert!(
            f.settle(Some(terminal), 4, Arc::new(NoFaults))
                .await
                .is_err()
        );
        assert_eq!(f.counts(), (0, 1));
        assert!(!f.root.path().join(&f.binding.current_path).exists());
    }
}

#[tokio::test]
async fn configured_settlement_retains_pending_projection_when_parent_is_unusable() {
    let f = Fixture::new().await;
    std::fs::write(f.root.path().join("notes"), "owned file").unwrap();
    assert!(f.settle(None, 4, Arc::new(NoFaults)).await.is_err());
    f.assert_pending_absent_projection();
    let counts = f.counts();
    // The first baseline covers no accepted edit, so it records no settlement.
    assert_eq!(counts.0, 0);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("notes")).unwrap(),
        "owned file"
    );
    std::fs::remove_file(f.root.path().join("notes")).unwrap();
    assert!(
        f.settle(None, 4, Arc::new(NoFaults))
            .await
            .unwrap()
            .materialized
    );
    assert_eq!(f.counts(), counts);
    f.assert_projection();
}

async fn unload(f: &Fixture) -> Option<UnloadPending> {
    f.owner
        .unload(
            f.binding.object_id.clone(),
            vec![dohc_engine_collab::DocKey::new("workspace", "main", "object").unwrap()],
            f.root.path().to_owned(),
            40,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn unload_waits_for_a_committed_settlement_whose_file_write_failed() {
    for crash in [false, true] {
        let f = Fixture::new().await;
        let terminal = if crash {
            let terminal = f.apply(2, vector("ordinary-frontmatter-order")).await;
            let _interrupted = f
                .settle(
                    Some(terminal.clone()),
                    4,
                    Arc::new(Crash(FaultPoint::MaterializeAfterJobCommit)),
                )
                .await;
            Some(terminal)
        } else {
            std::fs::write(f.root.path().join("notes"), "owned file").unwrap();
            assert!(f.settle(None, 4, Arc::new(NoFaults)).await.is_err());
            None
        };
        // Only the accepted edit records a settlement; the first baseline does not.
        assert_eq!(f.counts().0, i64::from(crash), "crash={crash}");
        assert_eq!(
            unload(&f).await,
            Some(UnloadPending::Materialization),
            "crash={crash}"
        );
        if !crash {
            std::fs::remove_file(f.root.path().join("notes")).unwrap();
        }
        // The refusal kept the registration, so the normal retry lands the file.
        assert!(
            f.settle(terminal, 4, Arc::new(NoFaults))
                .await
                .unwrap()
                .materialized
        );
        f.assert_projection();
        assert_eq!(unload(&f).await, None, "crash={crash}");
    }
}

#[tokio::test]
async fn unload_waits_for_a_committed_settlement_whose_file_write_was_blocked() {
    let f = Fixture::new().await;
    f.settle(None, 4, Arc::new(NoFaults)).await.unwrap();
    let path = f.root.path().join(&f.binding.current_path);
    let settled = std::fs::read(&path).unwrap();
    let terminal = f.apply(1, vector("ordinary-frontmatter-order")).await;
    let elsewhere = ScratchDir::new().unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(
        dohc_engine_testkit::try_make_dir_alias(elsewhere.path(), &path).unwrap(),
        "host must create the directory alias; this regression cannot skip"
    );
    let blocked = f
        .settle(Some(terminal.clone()), 4, Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(!blocked.materialized);
    assert_eq!(unload(&f).await, Some(UnloadPending::Materialization));
    #[cfg(windows)]
    std::fs::remove_dir(&path).unwrap();
    #[cfg(not(windows))]
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, settled).unwrap();
    assert!(
        f.settle(Some(terminal), 4, Arc::new(NoFaults))
            .await
            .unwrap()
            .materialized
    );
    f.assert_projection();
    assert_eq!(unload(&f).await, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_application_keeps_queued_memory_and_replays_after_cancelled_or_retired_owner() {
    struct Hold {
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl FaultInjector for Hold {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == FaultPoint::StorageBeforePersist {
                if let Some(entered) = self.entered.lock().unwrap().take() {
                    let _ = entered.send(());
                    self.release.lock().unwrap().recv().unwrap();
                }
            }
            FaultAction::Continue
        }
    }
    struct Reservation(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Reservation {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    for retire in [false, true] {
        let mut f = Fixture::new().await;
        let coordinate = ApplicationHostCoordinate {
            host_id: "host".into(),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        };
        let projection = f.doc.project(ContentKind::Richdoc).unwrap().content;
        let source = f
            .doc
            .preserved_markdown_source(&projection)
            .unwrap_or_else(|| projection.clone());
        let fence = f
            .owner
            .fence_restore(
                NativeRestoreFence {
                    point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                        journal_cursor: 0,
                        receipt_digest: f.binding.lineage_claim_id.clone(),
                    },
                    operation_id: "restore".into(),
                    relay_database_namespace: "relay".into(),
                    old_binding: f.binding.clone(),
                    host_id: "host".into(),
                    new_fence: 1,
                    origin: RestoreDeliveryOrigin::Bootstrap {
                        id: "bootstrap".into(),
                    },
                    terminal: None,
                    applied_sequence: 0,
                },
                coordinate.clone(),
                20,
                Arc::new(NoFaults),
            )
            .await
            .unwrap();
        let preparation = NativeRestorePreparation {
            fence,
            point: NativeRestorePoint {
                journal_cursor: 0,
                receipt_digest: f.binding.lineage_claim_id.clone(),
                markdown_digest: hex_sha256(source.as_bytes()),
                projection_digest: hex_sha256(projection.as_bytes()),
            },
        };
        let proposal = f
            .owner
            .prepare_restore(
                preparation.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        let mut binding = f.binding.clone();
        binding.restore_fence_generation = 1;
        let input = NativeRestoreApplication {
            preparation,
            candidate_digest: proposal.receipt().candidate_digest.clone(),
            native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
            admitted: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: "restore-delivery".into(),
                        update_digest: proposal.receipt().candidate_digest.clone(),
                        journal_cursor: 17,
                        accepting_host_epoch: 2,
                    },
                    binding,
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "restoring-owner".into(),
                    },
                    received_at_ms: 25,
                },
                first_seen: proposal.receipt().replacement_ranges.clone(),
                canonical_version: Some(2),
                author_snapshot: Some(vec![]),
                first_seen_deletes: Some(vec![]),
                checkpoint_coverage: None,
            },
        };
        let (entered, at_commit) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let disposed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut call = Box::pin(f.owner.apply_restore(
            input.clone(),
            coordinate.clone(),
            2_000_000,
            100,
            30,
            Arc::new(Hold {
                entered: std::sync::Mutex::new(Some(entered)),
                release: std::sync::Mutex::new(wait),
            }),
            Arc::new(Reservation(disposed.clone())),
        ));
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(call.as_mut().poll(cx).is_pending()))
                .await
        );
        at_commit.await.unwrap();
        assert!(!disposed.load(std::sync::atomic::Ordering::SeqCst));
        if retire {
            f.owner.retire();
            release.send(()).unwrap();
            assert!(matches!(call.await, Err(RuntimeError::ActorUnavailable)));
        } else {
            drop(call);
            assert!(!disposed.load(std::sync::atomic::Ordering::SeqCst));
            release.send(()).unwrap();
        }
        if retire {
            f.owner = f
                .supervisor
                .open(&f.db, 35)
                .unwrap()
                .actor
                .live_application_owner("workspace".into())
                .await
                .unwrap();
        }
        let receipt = f
            .owner
            .apply_restore(
                input.clone(),
                coordinate.clone(),
                2_000_000,
                100,
                40,
                Arc::new(NoFaults),
                Arc::new(()),
            )
            .await
            .unwrap();
        assert!(disposed.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(receipt.local_head_sequence, 1);
        assert_eq!(receipt.recorded_at_ms, 30);
        assert_eq!(
            receipt,
            f.owner
                .apply_restore(
                    input,
                    coordinate,
                    2_000_000,
                    100,
                    50,
                    Arc::new(NoFaults),
                    Arc::new(())
                )
                .await
                .unwrap()
        );
        assert!(f.settle(None, 100, Arc::new(NoFaults)).await.is_err());
        f.supervisor.close(&f.db).unwrap();
        let store = EngineStore::open(&f.db, 60).unwrap();
        assert_eq!(store.table_row_count("moments").unwrap(), 1);
        assert_eq!(
            store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            1
        );
        assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
    }
}

#[tokio::test]
async fn unchanged_configured_bootstrap_materializes_before_noop_coverage() {
    for apply_noop in [false, true] {
        let f = Fixture::new().await;
        let path = f.root.path().join(&f.binding.current_path);
        assert!(!path.exists());
        let terminal = if apply_noop {
            Some(f.apply(1, vec![0, 0]).await)
        } else {
            None
        };
        let result = f
            .settle(terminal, 4, Arc::new(NoFaults))
            .await
            .expect("first unchanged settle");
        assert!(result.materialized);
        assert!(
            path.exists(),
            "a no-op cannot prove an absent bootstrap artifact"
        );
        f.assert_projection();
    }
}

const HISTORY_INTERVAL: usize = 32;
const HISTORY_MAX_APPLICATIONS: usize = 128;
const HISTORY_PUBLICATION_BUDGET: usize = 32 << 20;
/// Four full 4,095-event checkpoint segments precede a long scenario's
/// measured interval, so its accepted suffix holds 32 events like a short one.
const HISTORY_LONG_PREFIX: usize = 4 * 4_095;
const HISTORY_MAX_UPDATE_BYTES: usize = 64 << 10;
const HISTORY_MAX_BOOTSTRAP_BYTES: usize = 1 << 20;
const HISTORY_MAX_CORPUS_BYTES: usize = 64 << 20;
/// Name, visible document, and what accepted history holds before the
/// measured interval. Short scenarios carry their visible document in the
/// bootstrap. `long-empty-updates` is a history-only control: empty updates
/// precede short-small's exact bytes, so accepted history grows while native
/// state does not.
const HISTORY_SCENARIOS: [(&str, &str, &str); 5] = [
    ("short-small", "small", "none"),
    ("short-large", "large", "none"),
    ("long-small", "small", "status edits"),
    ("long-large", "large", "status and paragraph edits"),
    ("long-empty-updates", "small", "empty updates"),
];
const HISTORY_LIMITS: [&str; 2] = [
    "The operating system file cache is warm. First calls follow a new connection or actor restart, not a cold disk.",
    "Nearest-rank p95 of fewer than 20 samples is the slowest sample.",
];

fn history_env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

fn elapsed_ms(started: std::time::Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn dir_bytes(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .map(|entry| match entry.file_type() {
                Ok(kind) if kind.is_dir() => dir_bytes(&entry.path()),
                _ => entry.metadata().map_or(0, |m| m.len()),
            })
            .sum()
    })
}

/// Nearest-rank summary of raw milliseconds. With fewer than 20 samples, p95
/// is the slowest sample.
fn summary(samples: &[f64]) -> serde_json::Value {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = |q: f64| {
        sorted
            .get(((q * sorted.len() as f64).ceil() as usize).max(1) - 1)
            .copied()
    };
    serde_json::json!({
        "count": sorted.len(),
        "medianMs": rank(0.5),
        "p95Ms": rank(0.95),
        "maxMs": sorted.last(),
    })
}

/// Edit `i` of the long realistic lineage, unchanged from the first frozen
/// corpus: a status change on most edits and a short Unicode paragraph every
/// 64th, never a full-body replacement.
fn history_edit(doc: &Ydoc, i: usize) -> Vec<u8> {
    if i % 64 == 63 {
        doc.richdoc_append_paragraph(&format!("Revision {i}: Ã¼nÃ¯cÃ¸dÃ© âœ“ ðŸš€"))
    } else {
        history_status(doc, i)
    }
}

fn history_status(doc: &Ydoc, i: usize) -> Vec<u8> {
    doc.frontmatter_set("status", ["draft", "review", "done"][i % 3])
        .unwrap()
}

/// A fresh generation of `name`: its own bootstrap, unless it uses the
/// `rich-unicode` fixture, and its accepted updates. Every scenario ends with
/// edits 16380..16412 of the realistic lineage, so each measured interval
/// makes the same edits to the same visible document.
fn history_generate(name: &str) -> (Option<Vec<u8>>, Vec<Vec<u8>>) {
    let doc = Ydoc::wire();
    doc.apply(&vector("rich-unicode")).unwrap();
    let (bootstrap, mut updates) = match name {
        "short-small" | "short-large" => {
            // The realistic prefix's visible result, without its history.
            history_status(&doc, HISTORY_LONG_PREFIX - 1);
            if name == "short-large" {
                for i in (63..HISTORY_LONG_PREFIX).step_by(64) {
                    history_edit(&doc, i);
                }
            }
            (Some(doc.encode_full_state()), Vec::new())
        }
        "long-small" => (
            None,
            (0..HISTORY_LONG_PREFIX)
                .map(|i| history_status(&doc, i))
                .collect(),
        ),
        "long-large" => (
            None,
            (0..HISTORY_LONG_PREFIX)
                .map(|i| history_edit(&doc, i))
                .collect(),
        ),
        _ => unreachable!("{name} has no generator"),
    };
    updates.extend(
        (HISTORY_LONG_PREFIX..HISTORY_LONG_PREFIX + HISTORY_INTERVAL)
            .map(|i| history_edit(&doc, i)),
    );
    (bootstrap, updates)
}

fn encode_frames(updates: &[Vec<u8>]) -> Vec<u8> {
    updates
        .iter()
        .flat_map(|u| {
            (u.len() as u32)
                .to_le_bytes()
                .into_iter()
                .chain(u.iter().copied())
        })
        .collect()
}

fn decode_frames(encoded: &[u8], expected: usize) -> Vec<Vec<u8>> {
    let (mut updates, mut rest) = (Vec::with_capacity(expected), encoded);
    while !rest.is_empty() {
        assert!(
            updates.len() < expected,
            "corpus holds more than {expected} updates"
        );
        let Some((length, tail)) = rest.split_first_chunk::<4>() else {
            panic!("corpus ends inside frame {}", updates.len());
        };
        let length = u32::from_le_bytes(*length) as usize;
        assert!(
            length <= HISTORY_MAX_UPDATE_BYTES && length <= tail.len(),
            "corpus frame {} is truncated or exceeds 64 KiB",
            updates.len()
        );
        let (update, tail) = tail.split_at(length);
        updates.push(update.to_vec());
        rest = tail;
    }
    assert_eq!(updates.len(), expected, "corpus update count");
    updates
}

fn read_capped(path: &std::path::Path, cap: usize) -> Vec<u8> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .unwrap()
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= cap, "{} exceeds {cap} bytes", path.display());
    bytes
}

/// Replay `updates` beside a fresh generation and compare projections at the
/// bootstrap, at the end of the prefix, and after each measured update. Yrs
/// client ids differ between the two; the visible edits must not.
fn history_validate(
    name: &str,
    bootstrap: &[u8],
    updates: &[Vec<u8>],
    reference_bootstrap: &[u8],
    reference: &[Vec<u8>],
) -> Ydoc {
    let (loaded, fresh) = (Ydoc::wire(), Ydoc::wire());
    let project = |doc: &Ydoc| doc.project(ContentKind::Richdoc).unwrap().content;
    loaded.apply(bootstrap).unwrap();
    fresh.apply(reference_bootstrap).unwrap();
    assert_eq!(project(&loaded), project(&fresh), "{name}: bootstrap");
    let prefix = updates.len() - HISTORY_INTERVAL;
    for (index, (update, expected)) in updates.iter().zip(reference).enumerate() {
        assert!(update.len() > 2, "{name}: update {index} is empty");
        loaded.apply(update).unwrap();
        fresh.apply(expected).unwrap();
        if index + 1 >= prefix {
            assert_eq!(
                project(&loaded),
                project(&fresh),
                "{name}: projection after update {}",
                index + 1
            );
        }
    }
    loaded
}

#[derive(Clone)]
struct HistoryCorpus {
    bootstrap: Vec<u8>,
    updates: Vec<Vec<u8>>,
    identity: serde_json::Value,
    /// The replayed corpus's terminal projection and native sizes.
    markdown: String,
    full_state_bytes: usize,
    delete_set_bytes: usize,
}

/// `name`'s bootstrap and length-prefixed update frames, frozen under
/// DOHC_LIVE_HISTORY_CORPUS_DIR as `<name>.updates` and, for a scenario with
/// its own bootstrap, `<name>.bootstrap`. Frozen files keep native bytes
/// identical across builds; a fresh `Ydoc::wire()` picks a new Yrs client id.
/// A scenario with none of its files is generated and frozen. Existing files
/// are never rewritten: a partial or invalid scenario stops the run.
fn history_corpus(name: &str) -> HistoryCorpus {
    let (own_bootstrap, generated) = history_generate(name);
    let dir = std::env::var_os("DOHC_LIVE_HISTORY_CORPUS_DIR").map(PathBuf::from);
    let path = |extension: &str| {
        dir.as_ref()
            .map(|dir| dir.join(format!("{name}.{extension}")))
    };
    let bootstrap_path = path("bootstrap").filter(|_| own_bootstrap.is_some());
    let updates_path = path("updates");
    let bootstrap_source = if own_bootstrap.is_some() {
        "scenario"
    } else {
        "fixture rich-unicode"
    };
    let fresh_bootstrap = own_bootstrap.unwrap_or_else(|| vector("rich-unicode"));
    let present: Vec<bool> = updates_path
        .iter()
        .chain(&bootstrap_path)
        .map(|path| path.try_exists().unwrap())
        .collect();
    let frozen = present.contains(&true);
    assert!(
        !frozen || !present.contains(&false),
        "{name}: frozen corpus is incomplete; restore or remove its files"
    );
    let (bootstrap, encoded) = if frozen {
        (
            bootstrap_path.as_ref().map_or_else(
                || fresh_bootstrap.clone(),
                |path| read_capped(path, HISTORY_MAX_BOOTSTRAP_BYTES),
            ),
            read_capped(updates_path.as_ref().unwrap(), HISTORY_MAX_CORPUS_BYTES),
        )
    } else {
        (fresh_bootstrap.clone(), encode_frames(&generated))
    };
    let updates = decode_frames(&encoded, generated.len());
    let doc = history_validate(name, &bootstrap, &updates, &fresh_bootstrap, &generated);
    if !frozen {
        for (path, bytes) in [(&bootstrap_path, &bootstrap), (&updates_path, &encoded)] {
            use std::io::Write;
            let Some(path) = path else { continue };
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .unwrap()
                .write_all(bytes)
                .unwrap();
        }
    }
    let source = match (frozen, &dir) {
        (true, _) => "frozen",
        (false, Some(_)) => "generated-and-frozen",
        (false, None) => "generated",
    };
    HistoryCorpus {
        identity: serde_json::json!({
            "scenario": name,
            "source": source,
            "sha256": hex_sha256(&encoded),
            "updates": updates.len(),
            "usedBytes": updates.iter().map(Vec::len).sum::<usize>(),
            "bootstrapSource": bootstrap_source,
        }),
        markdown: doc.project(ContentKind::Richdoc).unwrap().content,
        full_state_bytes: doc.encode_full_state().len(),
        delete_set_bytes: doc.encode_delete_set().len(),
        bootstrap,
        updates,
    }
}

/// The `long-empty-updates` control: empty updates before short-small's
/// exact bootstrap and update bytes, so it shares their native state.
fn history_empty_updates(short_small: &HistoryCorpus) -> HistoryCorpus {
    let updates: Vec<Vec<u8>> = std::iter::repeat_n(vec![0, 0], HISTORY_LONG_PREFIX)
        .chain(short_small.updates.iter().cloned())
        .collect();
    HistoryCorpus {
        identity: serde_json::json!({
            "scenario": "long-empty-updates",
            "sha256": hex_sha256(&encode_frames(&updates)),
            "updates": updates.len(),
            "usedBytes": updates.iter().map(Vec::len).sum::<usize>(),
            "emptyUpdates": HISTORY_LONG_PREFIX,
            "base": short_small.identity,
        }),
        updates,
        ..short_small.clone()
    }
}

impl Fixture {
    /// Admit `updates` at the cursors after `after`, every eighth with link
    /// authority, and return the last receipt.
    async fn admit(&self, after: usize, updates: &[Vec<u8>]) -> LiveUpdateReceipt {
        let mut terminal = None;
        for (index, update) in updates.iter().enumerate() {
            let cursor = after + index + 1;
            let authority = if cursor.is_multiple_of(8) {
                ServerDerivedLiveUpdateAuthority::Link {
                    principal_id: "link-principal".into(),
                    grant_id: "link-grant".into(),
                    grant_generation: 1,
                }
            } else {
                ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                }
            };
            terminal = Some(
                self.apply_as(cursor as i64, update.clone(), authority, 2)
                    .await,
            );
        }
        terminal.unwrap()
    }

    async fn settle_interval(
        &self,
        terminal: Option<LiveUpdateReceipt>,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        self.settle(terminal, HISTORY_MAX_APPLICATIONS, Arc::new(NoFaults))
            .await
    }

    /// Close the actor, then reacquire the owner and register the binding, as
    /// a restarted process would.
    async fn reopen(&mut self) {
        self.supervisor.close(&self.db).unwrap();
        (self.owner, self.handle) = open_owner(&self.supervisor, &self.db, &self.binding).await;
    }

    /// Close this actor and open a separate fixture on a byte copy of the
    /// quiesced workspace, its database and Markdown artifact included.
    async fn copy(&self) -> Fixture {
        self.supervisor.close(&self.db).unwrap();
        let root = ScratchDir::new().unwrap();
        copy_dir(self.root.path(), root.path());
        let db = engine_db_path(&root).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let (owner, handle) = open_owner(&supervisor, &db, &self.binding).await;
        let doc = Ydoc::wire();
        doc.apply(&self.doc.encode_full_state()).unwrap();
        Fixture {
            root,
            db,
            supervisor,
            owner,
            handle,
            binding: self.binding.clone(),
            doc,
        }
    }
}

async fn open_owner(
    supervisor: &WorkspaceSupervisor,
    db: &std::path::Path,
    binding: &LiveObjectBinding,
) -> (ActorLiveApplicationOwner, ActorLiveApplicationHandle) {
    let owner = supervisor
        .open(db, 20)
        .unwrap()
        .actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register("relay".into(), restore_coordinate(), binding.clone())
        .await
        .unwrap();
    (owner, handle)
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            std::fs::create_dir(&target).unwrap();
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Manual measurement of native accepted-history publication and settlement.
/// Raw samples only, no timing assertions; correctness checks run after each
/// timer stops.
///
/// The scenarios vary accepted-history length and visible document size
/// independently. Short scenarios hold 32 accepted updates on a bootstrap
/// that already carries their document. Long ones hold 16412, with the latest
/// checkpoint at event 16380. Large documents add 255 paragraphs to small
/// ones. Scenarios with the same document size end with the same projected
/// Markdown, and every measured interval makes the same 32 edits. Their
/// native bytes still differ: a long edit history leaves tombstones that the
/// native state and each update's delete set carry. `long-empty-updates`
/// holds native state fixed and grows only accepted history. Each result
/// records native sizes instead of assuming them.
///
/// Each scenario admits authentic incremental updates at monotonic cursors
/// and settles the prefix in 32-update intervals plus one shorter final
/// interval. Copies of that closed template then each take one fresh
/// settlement of the last 32 updates. Half settle on the actor that admitted
/// them; half restart the actor first. The template then settles the same
/// interval and measures warm same-terminal replay, `owner_publication_prefix`
/// on the settlement's journaled `moment.append` (first call on a new
/// connection, then warm), and per actor restart the first replay and first
/// publication. The operating system's file cache stays warm throughout.
///
/// Build the executable once under the repository's cargo budget, then run
/// it serially. The first run writes the corpus; later runs and other builds
/// read the same bytes. A `long-large.updates` copied from the first
/// benchmark's single-file corpus reproduces that corpus's bytes. Scratch
/// fixtures stay under DOHC_TEST_SCRATCH_ROOT and are removed on drop.
///
///   CARGO_BUILD_JOBS=<cores/4> cargo test -p dohc-engine-runtime --release --test live_settlement --no-run
///   DOHC_TEST_SCRATCH_ROOT=<task>/scratch DOHC_LIVE_HISTORY_CORPUS_DIR=<task>/corpus \
///     <live_settlement executable> live_history_publication_and_settlement_benchmark \
///     --ignored --exact --nocapture --test-threads=1
///
/// DOHC_LIVE_HISTORY_SCENARIOS (all five, comma separated),
/// DOHC_LIVE_HISTORY_SAMPLES (31), DOHC_LIVE_HISTORY_FRESH (5 of each fresh
/// kind), and DOHC_LIVE_HISTORY_RESTARTS (5) override the defaults.
#[tokio::test]
#[ignore = "manual live history benchmark; run without competing workloads"]
async fn live_history_publication_and_settlement_benchmark() {
    use dohc_engine_sync::{ReplicationEnvelope, owner_publication_prefix};
    use std::time::Instant;
    let all = HISTORY_SCENARIOS.map(|(name, ..)| name).join(",");
    let scenarios: Vec<_> = history_env("DOHC_LIVE_HISTORY_SCENARIOS", &all)
        .split(',')
        .map(|name| {
            *HISTORY_SCENARIOS
                .iter()
                .find(|(known, ..)| *known == name.trim())
                .unwrap_or_else(|| panic!("unknown scenario {name}"))
        })
        .collect();
    let count = |name: &str, default: &str| history_env(name, default).parse::<usize>().unwrap();
    let samples = count("DOHC_LIVE_HISTORY_SAMPLES", "31");
    let fresh_samples = count("DOHC_LIVE_HISTORY_FRESH", "5");
    let restarts = count("DOHC_LIVE_HISTORY_RESTARTS", "5");
    assert!(
        samples <= 1_000 && (5..=50).contains(&fresh_samples) && restarts <= 100,
        "samples exceed 1000, fresh samples are outside 5..=50, or restarts exceed 100"
    );
    // Every corpus is generated or validated before any fixture work.
    // Short-small loads once, so the empty-update control reuses its bytes.
    let short_small = scenarios
        .iter()
        .any(|(name, ..)| matches!(*name, "short-small" | "long-empty-updates"))
        .then(|| history_corpus("short-small"));
    let corpora: Vec<HistoryCorpus> = scenarios
        .iter()
        .map(|(name, ..)| match *name {
            "short-small" => short_small.clone().unwrap(),
            "long-empty-updates" => history_empty_updates(short_small.as_ref().unwrap()),
            name => history_corpus(name),
        })
        .collect();
    let find = |wanted: &str| {
        scenarios
            .iter()
            .zip(&corpora)
            .find(|((name, ..), _)| *name == wanted)
            .map(|(_, corpus)| corpus)
    };
    if let (Some(small), Some(empty)) = (find("short-small"), find("long-empty-updates")) {
        assert_eq!(
            small.bootstrap, empty.bootstrap,
            "long-empty-updates: bootstrap bytes"
        );
        assert_eq!(
            small.updates[..],
            empty.updates[HISTORY_LONG_PREFIX..],
            "long-empty-updates: measured update bytes"
        );
    }
    for ((name, document, _), corpus) in scenarios.iter().zip(&corpora) {
        let (_, first) = scenarios
            .iter()
            .zip(&corpora)
            .find(|((_, other, _), _)| other == document)
            .unwrap();
        assert_eq!(
            corpus.markdown, first.markdown,
            "{name}: final projection differs within the {document} document"
        );
    }
    for ((name, document, history), corpus) in scenarios.iter().zip(&corpora) {
        let size = corpus.updates.len();
        let prior = size - HISTORY_INTERVAL;
        let incomplete = |reason: &str| {
            println!(
                "LIVE_HISTORY_BENCH {}",
                serde_json::json!({ "scenario": name, "acceptedUpdates": size, "outcome": "incomplete", "reason": reason })
            )
        };
        if corpus.markdown.len() > 1 << 20 || corpus.full_state_bytes > 8 << 20 {
            incomplete("projection exceeds 1 MiB or native state exceeds 8 MiB");
            continue;
        }
        let started = Instant::now();
        let mut f =
            Fixture::build(true, corpus.bootstrap.clone(), "notes/example.md", |_| {}).await;
        // First-bootstrap materialization stays out of the measured interval.
        f.settle_interval(None).await.unwrap();
        let (before, suffix) = corpus.updates.split_at(prior);
        let mut over = false;
        for (index, interval) in before.chunks(HISTORY_INTERVAL).enumerate() {
            let after = index * HISTORY_INTERVAL;
            let terminal = f.admit(after, interval).await;
            let settled = f.settle_interval(Some(terminal)).await.unwrap();
            assert!(settled.materialized);
            assert_eq!(settled.terminal_cursor, (after + interval.len()) as i64);
            over = dir_bytes(f.root.path()) > 256 << 20;
            if over {
                break;
            }
        }
        if over {
            incomplete("workspace exceeds 256 MiB");
            continue;
        }
        let setup_ms = elapsed_ms(started);

        let check = |f: &Fixture, settled: &LiveSettlementResult| {
            assert!(settled.materialized);
            assert_eq!(
                (
                    settled.previous_cursor,
                    settled.terminal_cursor,
                    settled.application_count
                ),
                (prior as i64, size as i64, HISTORY_INTERVAL)
            );
            f.assert_projection();
        };
        // Each fresh sample settles its own copy of the closed template, so no
        // sample repeats work that another already settled.
        let (mut admitted, mut restarted) = (Vec::new(), Vec::new());
        for index in 0..2 * fresh_samples {
            let started = Instant::now();
            let mut copy = f.copy().await;
            let terminal = copy.admit(prior, suffix).await;
            if index % 2 == 1 {
                copy.reopen().await;
            }
            let prepare_ms = elapsed_ms(started);
            let started = Instant::now();
            let settled = copy.settle_interval(Some(terminal)).await;
            let settle_ms = elapsed_ms(started);
            let settled = settled.unwrap();
            check(&copy, &settled);
            let sample = serde_json::json!({
                "settleMs": settle_ms,
                "prepareMs": prepare_ms,
                "settlementId": settled.settlement_id,
                "momentId": settled.moment_id,
            });
            if index % 2 == 0 {
                admitted.push((settle_ms, sample));
            } else {
                restarted.push((settle_ms, sample));
            }
        }
        let fresh = |samples: Vec<(f64, serde_json::Value)>| {
            let (ms, raw): (Vec<f64>, Vec<_>) = samples.into_iter().unzip();
            serde_json::json!({ "summary": summary(&ms), "samples": raw })
        };

        f.reopen().await;
        let terminal = Some(f.admit(prior, suffix).await);
        let settled = f.settle_interval(terminal.clone()).await.unwrap();
        check(&f, &settled);
        let file = f.root.path().join(&f.binding.current_path);
        let (counts, bytes) = (f.counts(), std::fs::read(&file).unwrap());
        let replayed = |f: &Fixture, again: LiveSettlementResult| {
            assert_eq!(
                (again.settlement_id, again.moment_id),
                (settled.settlement_id.clone(), settled.moment_id.clone())
            );
            assert_eq!(f.counts(), counts);
            assert_eq!(std::fs::read(&file).unwrap(), bytes);
        };
        let mut replay_ms = Vec::new();
        for _ in 0..samples {
            let started = Instant::now();
            let again = f.settle_interval(terminal.clone()).await;
            replay_ms.push(elapsed_ms(started));
            replayed(&f, again.unwrap());
        }

        let published = f.read(|db| {
            db.query_row(
                "SELECT origin_id,origin_seq,recorded_at_ms,payload_json FROM replication_log WHERE imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",
                [&settled.moment_id],
                |r| {
                    Ok(ReplicationEnvelope {
                        settlement_admission: None,
                        admitted_author_snapshot: None,
                        workspace_id: "workspace".into(),
                        origin_id: r.get(0)?,
                        origin_seq: r.get(1)?,
                        op_kind: "moment.append".into(),
                        recorded_at_ms: r.get(2)?,
                        relay_seq: None,
                        payload: serde_json::from_str(&r.get::<_, String>(3)?).unwrap(),
                    })
                },
            )
            .unwrap()
        });
        let references = [
            "payloadBeforeBlobSha256",
            "payloadAfterBlobSha256",
            "beforeBlobSha256",
        ]
        .iter()
        .filter(|name| {
            published.payload[**name]
                .as_str()
                .is_some_and(|d| !d.is_empty())
        })
        .count();
        let publish = |store: &EngineStore| {
            let started = Instant::now();
            let prefix = owner_publication_prefix(
                store,
                "workspace",
                std::slice::from_ref(&published),
                HISTORY_PUBLICATION_BUDGET,
            );
            let elapsed = elapsed_ms(started);
            let prefix = prefix.unwrap();
            assert_eq!(
                (prefix.allowed_ops, prefix.pending, prefix.budget_exhausted),
                (1, None, false)
            );
            elapsed
        };
        let store = EngineStore::open(&f.db, 20).unwrap();
        let publication_first_ms = publish(&store);
        let publication_warm_ms: Vec<f64> = (0..samples).map(|_| publish(&store)).collect();
        drop(store);

        let mut restart_samples = Vec::new();
        for _ in 0..restarts {
            let started = Instant::now();
            f.reopen().await;
            let prepare_ms = elapsed_ms(started);
            let started = Instant::now();
            let again = f.settle_interval(terminal.clone()).await;
            let replay_ms = elapsed_ms(started);
            replayed(&f, again.unwrap());
            let started = Instant::now();
            let store = EngineStore::open(&f.db, 20).unwrap();
            let store_open_ms = elapsed_ms(started);
            let publication_ms = publish(&store);
            drop(store);
            restart_samples.push(serde_json::json!({
                "prepareMs": prepare_ms,
                "replayMs": replay_ms,
                "storeOpenMs": store_open_ms,
                "publicationMs": publication_ms,
            }));
        }

        let names = [
            "acceptedEvents",
            "checkpoints",
            "latestCheckpointEvent",
            "latestCheckpointStateBytes",
            "suffixEvents",
            "suffixBytes",
            "applicationReceipts",
            "settlements",
            "moments",
            "replicationOps",
            "localSnapshots",
            "localSnapshotBytes",
            "localTailUpdates",
            "localTailBytes",
        ];
        let storage: Vec<Option<i64>> = f.read(|db| {
            db.query_row(
                "SELECT (SELECT count(*) FROM live_accepted_updates),
                    (SELECT count(*) FROM live_accepted_checkpoints),
                    (SELECT max(event_count) FROM live_accepted_checkpoints),
                    (SELECT b.byte_length FROM live_accepted_checkpoints c JOIN binary_blobs b ON b.sha256=c.state_sha256 ORDER BY c.event_count DESC LIMIT 1),
                    (SELECT suffix_count FROM live_accepted_updates ORDER BY event_count DESC LIMIT 1),
                    (SELECT suffix_bytes FROM live_accepted_updates ORDER BY event_count DESC LIMIT 1),
                    (SELECT count(*) FROM live_device_update_applications),
                    (SELECT count(*) FROM live_device_settlements),
                    (SELECT count(*) FROM moments),
                    (SELECT count(*) FROM replication_log),
                    (SELECT count(*) FROM ydoc_snapshots),
                    (SELECT b.byte_length FROM ydoc_snapshots s JOIN binary_blobs b ON b.sha256=s.snapshot_blob_sha256 ORDER BY s.up_to_seq DESC LIMIT 1),
                    (SELECT count(*) FROM ydoc_updates WHERE seq>(SELECT coalesce(max(up_to_seq),0) FROM ydoc_snapshots)),
                    (SELECT coalesce(sum(b.byte_length),0) FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.seq>(SELECT coalesce(max(up_to_seq),0) FROM ydoc_snapshots))",
                [],
                |r| (0..names.len()).map(|i| r.get(i)).collect(),
            )
            .unwrap()
        });
        let layout = (storage[2], storage[4]);
        let mut wal = f.db.clone().into_os_string();
        wal.push("-wal");
        let restart_ms = |field: &str| {
            let ms: Vec<f64> = restart_samples
                .iter()
                .map(|sample| sample[field].as_f64().unwrap())
                .collect();
            summary(&ms)
        };
        println!(
            "LIVE_HISTORY_BENCH {}",
            serde_json::json!({
                "outcome": "complete",
                "scenario": name,
                "document": document,
                "historyBeforeMeasure": history,
                "acceptedUpdates": size,
                "settledBeforeMeasure": prior,
                "measuredUpdateBytes": suffix.iter().map(Vec::len).sum::<usize>(),
                "parameters": {
                    "measuredInterval": HISTORY_INTERVAL,
                    "linkAuthorityUpdates": size / 8,
                    "maxApplications": HISTORY_MAX_APPLICATIONS,
                    "publicationBudgetBytes": HISTORY_PUBLICATION_BUDGET,
                },
                "corpus": corpus.identity,
                "bootstrapBytes": corpus.bootstrap.len(),
                "bootstrapSha256": hex_sha256(&corpus.bootstrap),
                "projectedMarkdownBytes": corpus.markdown.len(),
                "projectedMarkdownSha256": hex_sha256(corpus.markdown.as_bytes()),
                "fullStateBytes": corpus.full_state_bytes,
                "deleteSetBytes": corpus.delete_set_bytes,
                "storage": names.iter().zip(storage).map(|(n, v)| (n.to_string(), serde_json::Value::from(v))).collect::<serde_json::Map<_, _>>(),
                "files": {
                    "dbBytes": std::fs::metadata(&f.db).map_or(0, |m| m.len()),
                    "walBytes": std::fs::metadata(&wal).map_or(0, |m| m.len()),
                    "workspaceBytes": dir_bytes(f.root.path()),
                },
                "process": {
                    "pid": std::process::id(),
                    "executable": std::env::current_exe().unwrap(),
                    "os": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                    "cpus": std::thread::available_parallelism().map_or(0, |n| n.get()),
                    "debugAssertions": cfg!(debug_assertions),
                },
                "limits": HISTORY_LIMITS,
                "setupMs": setup_ms,
                "freshSettlement": {
                    "afterAdmission": fresh(admitted),
                    "afterRestart": fresh(restarted),
                },
                "replayWarmMs": replay_ms,
                "publicationReferences": references,
                "publicationAllowedOps": 1,
                "publicationFirstMs": publication_first_ms,
                "publicationWarmMs": publication_warm_ms,
                "restarts": restart_samples,
                "summaries": {
                    "replayWarm": summary(&replay_ms),
                    "publicationWarm": summary(&publication_warm_ms),
                    "restartReplay": restart_ms("replayMs"),
                    "restartPublication": restart_ms("publicationMs"),
                },
                "settlementId": settled.settlement_id,
                "momentId": settled.moment_id,
            })
        );
        // Long and short scenarios compare equal accepted suffixes.
        assert_eq!(
            layout,
            (Some(prior as i64), Some(HISTORY_INTERVAL as i64)),
            "{name}: latest checkpoint event and suffix events"
        );
    }
}

#[tokio::test]
async fn resumed_binding_publication_starts_at_authenticated_restore_cut() {
    resumed_binding_publication(false, false).await;
}

#[tokio::test]
async fn refused_restore_publication_keeps_new_binding_at_authenticated_restore_cut() {
    resumed_binding_publication(true, false).await;
}

#[tokio::test]
async fn unchanged_restore_tail_keeps_next_proof_at_the_last_settled_cut() {
    resumed_binding_publication(false, true).await;
}

#[tokio::test]
async fn refused_restore_publication_recovers_after_an_unchanged_tail() {
    resumed_binding_publication(true, true).await;
}

async fn resumed_binding_publication(refused: bool, unchanged_tail: bool) {
    let mut f = Fixture::with_relay(true).await;
    let first = f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    // Finish publication before the authenticated stop/restore transition.
    rusqlite::Connection::open(&f.db).unwrap().execute("INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) SELECT workspace_id,origin_id,max(origin_seq) FROM replication_log WHERE workspace_id='workspace' GROUP BY workspace_id,origin_id",[]).unwrap();
    let input = applied_restore(&f, None, 0).await;
    let restored = settle_restore(&f, input.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    if refused {
        let mut store = EngineStore::open(&f.db, 30).unwrap();
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let mut echoes =
            dohc_engine_sync::list_replication_ops(&store, "workspace", "owner-origin", -1, 500)
                .unwrap();
        let last = echoes
            .iter()
            .find(|op| {
                op.op_kind == "moment.append" && op.payload["momentId"] == restored.moment_id
            })
            .unwrap()
            .origin_seq;
        for op in &mut echoes {
            if op.origin_seq > last {
                break;
            }
            op.relay_seq = Some(op.origin_seq + 1);
            if op.op_kind == "moment.append" && op.payload["momentId"] == restored.moment_id {
                op.settlement_admission = Some(dohc_engine_sync::SettlementAdmission::Refused {
                    settlement_id: restored.settlement_id.clone().unwrap(),
                    reason: "authorship-mismatch".into(),
                });
            }
            dohc_engine_sync::apply_replication_envelope(
                &mut store,
                &mut cache,
                op,
                &NoFaults,
                &dohc_engine_sync::NoLiveLeases,
            )
            .unwrap();
        }
        assert_eq!(
            store
                .table_row_count("live_settlement_attribution_unavailable")
                .unwrap(),
            1
        );
    }
    let resumed = f
        .owner
        .resume_restore(
            NativeRestoreResume {
                application: input.clone(),
                settlement_id: restored.settlement_id.clone().unwrap(),
            },
            restore_coordinate(),
            2_000_000,
            100,
            f.root.path().to_owned(),
            31,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert_eq!(resumed.application_receipt.journal_cursor, 71);
    f.binding = input.admitted.accepted.binding;
    f.handle = f
        .owner
        .register("relay".into(), restore_coordinate(), f.binding.clone())
        .await
        .unwrap();
    // The selected checkpoint is the resumed document; private old-head bytes
    // cannot supply the publication base.
    f.doc = f.read(|db| {
        dohc_engine_collab::load_doc_in(
            db,
            &dohc_engine_collab::DocKey::new("workspace", "main", "object").unwrap(),
        )
        .unwrap()
    });
    if unchanged_tail {
        let no_change = f.apply(72, vec![0, 0]).await;
        let unchanged = f
            .settle(Some(no_change), 100, Arc::new(NoFaults))
            .await
            .unwrap();
        assert_eq!(unchanged.moment_id, restored.moment_id);
    }
    let cursor = if unchanged_tail { 73 } else { 72 };
    let receipt = f
        .apply(
            cursor,
            f.doc.richdoc_append_paragraph("After recovered binding"),
        )
        .await;
    let settled = f
        .settle(Some(receipt), 100, Arc::new(NoFaults))
        .await
        .unwrap();
    let previous_cursor = if unchanged_tail && !refused { 72 } else { 71 };
    assert_eq!(settled.previous_cursor, previous_cursor);
    assert_eq!(
        settled.application_count,
        (cursor - previous_cursor) as usize
    );
    assert_eq!(settled.terminal_cursor, cursor);
    f.read(|db| {
        let payload:String=db.query_row("SELECT payload_json FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",[&settled.moment_id],|r|r.get(0)).unwrap();
        let payload:serde_json::Value=serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["settlementReference"]["record"]["previousCursor"],previous_cursor);
        assert_eq!(payload["settlementReference"]["record"]["binding"]["restoreFenceGeneration"],1);
        assert_eq!(payload["payloadBeforeBlobSha256"],restored.markdown_digest);
        assert_eq!(payload["beforeLatestMomentId"],restored.moment_id);
        assert_ne!(settled.settlement_id,first.settlement_id);
    });
}

#[tokio::test]
async fn recovery_request_ledger_uses_the_resumed_restore_generation() {
    let f = Fixture::new().await;
    f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
    let input = applied_restore(&f, None, 0).await;
    let restored = settle_restore(&f, input.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    f.owner
        .resume_restore(
            NativeRestoreResume {
                application: input,
                settlement_id: restored.settlement_id.unwrap(),
            },
            restore_coordinate(),
            2_000_000,
            100,
            f.root.path().to_owned(),
            31,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    let key = dohc_engine_collab::DocKey::new("workspace", "main", "object").unwrap();
    let doc = f.read(|db| dohc_engine_collab::load_doc_in(db, &key).unwrap());
    let update = doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# After restore\n")
        .unwrap();
    let mut store = EngineStore::open(&f.db, 32).unwrap();
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    let outcome = dohc_engine_collab::durable::record_local_update(
        &mut store,
        &mut cache,
        &key,
        &update,
        dohc_engine_collab::durable::LocalAppend {
            marker: Some(dohc_engine_collab::durable::MarkerCreation {
                path: Some(&f.binding.current_path),
                content_kind: ContentKind::Richdoc,
                regime: dohc_engine_collab::Regime::Replicated,
            }),
            restore_generation: Some(1),
            request_id: Some("generation-one-original"),
            ..Default::default()
        },
        &NoFaults,
        33,
        |_, _, _| Ok(()),
    )
    .unwrap();
    assert!(matches!(
        outcome,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
    store
        .write_with(
            &NoFaults,
            |tx| -> Result<(), dohc_engine_collab::CollabError> {
                assert_eq!(
                    dohc_engine_collab::live_update_application::restore_generation(tx, &key)?,
                    Some(1)
                );
                assert!(dohc_engine_collab::durable::recovery_update_is_recorded_in(
                    tx,
                    &key,
                    &f.binding.current_path,
                    "generation-one-original",
                    &update,
                    None,
                    None
                )?);
                assert!(
                    dohc_engine_collab::durable::record_recovery_update_in_tx(
                        tx,
                        &key,
                        &f.binding.current_path,
                        "generation-one-original",
                        &update,
                        None,
                        None,
                        34
                    )?
                    .deduped
                );
                Ok(())
            },
        )
        .unwrap();
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the staged bundle"]
async fn reader_restore_dispatches_outside_the_actor_at_every_phase() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-restore.json"
    ))
    .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(vector["pointStateBytes"].clone()).unwrap();
    let source = vector["source"].as_str().unwrap().to_owned();
    let path = "notes/reader.md";
    let f = Fixture::build(false, bytes, path, |store| {
        dohc_engine_domain::VersionedTextStore::new(store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: path.into(),
                    text: source.clone(),
                    moment_id: "received-file".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 0,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    })
    .await;
    let actor = f.supervisor.open(&f.db, 2).unwrap().actor;
    let fresh = || {
        let config =
            serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
        let reader = Arc::new(dohc_engine_reader::Reader::new(Some(config)));
        (
            Arc::new(dohc_engine_collab::reader_resolver::ReaderResolver::new(
                reader.clone(),
            )),
            reader,
        )
    };
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    let update = f.doc.richdoc_append_paragraph("later accepted paragraph");
    let terminal = f.apply(7, update).await;
    let input = applied_restore(&f, Some(terminal), 1).await;
    assert!(reader.dispatch_count() > 0, "preparation dispatches");
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    f.owner
        .apply_restore(
            input.clone(),
            restore_coordinate(),
            2_000_000,
            100,
            25,
            Arc::new(NoFaults),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert!(
        reader.dispatch_count() > 0,
        "replayed application revalidates"
    );
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    let settlement = settle_restore(&f, input.clone(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(reader.dispatch_count() > 0, "settlement revalidates");
    assert_eq!(
        std::fs::read_to_string(f.root.path().join(path)).unwrap(),
        source
    );
    let (resolver, reader) = fresh();
    actor.configure_reader_resolver(resolver).await.unwrap();
    let resumed = f
        .owner
        .resume_restore(
            NativeRestoreResume {
                application: input,
                settlement_id: settlement.settlement_id.unwrap(),
            },
            restore_coordinate(),
            2_000_000,
            100,
            f.root.path().to_owned(),
            40,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap();
    assert_eq!(resumed.binding.restore_fence_generation, 1);
    assert!(reader.dispatch_count() > 0, "resume revalidates");
    f.supervisor.close(&f.db).unwrap();
}
