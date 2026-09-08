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
        let root = ScratchDir::new().unwrap();
        let db = engine_db_path(&root).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        drop(store);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let bytes = vector("rich-unicode");
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        let markdown = doc.project(ContentKind::Richdoc).unwrap().content;
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&bytes),
            current_path: "notes/example.md".into(),
            selector_paths: vec!["notes/example.md".into()],
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
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: 2,
                },
                first_seen: vec![],
            },
            update_bytes: bytes,
        };
        assert!(matches!(
            self.handle.apply(event, Arc::new(NoFaults)).await.unwrap(),
            ApplicationResult::Applied(_)
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
            handle.apply(event, Arc::new(NoFaults)).await.unwrap(),
            ApplicationResult::Applied(_)
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
impl Drop for Fixture {
    fn drop(&mut self) {
        self.supervisor.close(&self.db).unwrap();
    }
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
