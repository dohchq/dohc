use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::*;
use dohc_engine_collab::{ContentKind, Ydoc};
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
    point.apply(&vector("rich-unicode")).unwrap();
    let markdown = point.project(ContentKind::Richdoc).unwrap().content;
    let fence = f
        .owner
        .fence_restore(
            NativeRestoreFence {
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
            projection_digest: hex_sha256(markdown.as_bytes()),
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
        assert_eq!(retained, old.settlement_id);
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
async fn restore_settlement_checks_old_anchor_and_retains_exact_same_content_moment() {
    for damage in [false, true] {
        let f = Fixture::new().await;
        let original = f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
        let before = std::fs::read(f.root.path().join(&f.binding.current_path)).unwrap();
        let input = applied_restore(&f, None, 0).await;
        if damage {
            rusqlite::Connection::open(&f.db)
                .unwrap()
                .execute(
                    "UPDATE live_device_settlements SET markdown_digest=printf('%064d',0)",
                    [],
                )
                .unwrap();
        }
        let result = settle_restore(&f, input, Arc::new(NoFaults)).await;
        if damage {
            assert!(result.is_err());
            assert_eq!(f.counts(), (1, 2));
        } else {
            let result = result.unwrap();
            assert!(result.materialized);
            assert_eq!(result.moment_id, original.moment_id);
            assert_eq!(f.counts(), (2, 2));
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
                    refusal_report_id: None,
                    settlement_report_id: None,
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
        let markdown = doc.project(ContentKind::Richdoc).unwrap().content;
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
                Arc::new(()),
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
                first_seen: vec![],
            },
            update_bytes: bytes,
        };
        assert!(matches!(
            self.handle
                .apply(event, Arc::new(NoFaults), 100_000_000)
                .await
                .unwrap(),
            ApplicationResult::Applied(..)
        ));
        receipt
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

#[tokio::test]
async fn live_settlement_history_syncs_after_restore_without_granting_native_authority() {
    use dohc_engine_sync::{
        ApplyDisposition, BlobContent, BlobHydration, NoLiveLeases, SyncError,
        apply_replication_envelope, hydrate_blob_content,
    };
    use yrs::updates::decoder::Decode;
    let f = Fixture::with_relay(true).await;
    let first = f.settle(None, 100, Arc::new(NoFaults)).await.unwrap();
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
    assert_eq!(settlements.len(), 3);
    assert_eq!(
        settlements[0].payload["record"]["settlementId"],
        first.settlement_id
    );
    assert_eq!(
        settlements[1].payload["record"]["settlementId"],
        second.settlement_id
    );
    assert_eq!(
        settlements[2].payload["record"]["restoreOperationId"],
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
            let mut missing = settlements[1].clone();
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
            assert_eq!(count, 3);
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
    let mut forged_restore = settlements[2].clone();
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
    let mut forged = settlements[1].clone();
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
            refusal_report_id: None,
            settlement_report_id: None,
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
    assert_eq!(records.len(), 3);
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
    source.frontmatter_set("id", RECORD);
    source.frontmatter_set("status", "open");
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
    let tx = raw.transaction().unwrap();
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

    f.apply(5, source.frontmatter_set("status", "done")).await;
    // The collaborator's frame arrives later, so its claim sorts after.
    let terminal = f
        .apply_as(
            6,
            source.frontmatter_set("status", "late"),
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
    f.assert_projection();
    let counts = f.counts();
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
        assert_eq!(recovered.settlement_id, id);
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
        assert_eq!(repaired.settlement_id, original);
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
    let counts = f.counts();
    assert_eq!(counts.0, 1);
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
