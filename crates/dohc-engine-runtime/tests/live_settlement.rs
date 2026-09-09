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
    let mut remote = Box::pin(f.handle.apply(remote, Arc::new(NoFaults)));
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
            owner_origin: None,
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
