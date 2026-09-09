use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationError, ApplicationHostCoordinate,
    ApplicationPending, ApplicationResult, LiveUpdateReceipt, RelayAcceptedLiveUpdate,
    ServerDerivedLiveUpdateAuthority,
};
use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, durable};
use dohc_engine_runtime::actor::{ActorLiveApplicationHandle, ActorLiveApplicationOwner};
use dohc_engine_runtime::{ActorHandle, RuntimeError, WorkspaceSupervisor};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, NoFaults, StorageError, hex_sha256,
    put_binary_blob_with_sha,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn binding(object: &str) -> LiveObjectBinding {
    LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: object.into(),
        lineage_claim_id: hex_sha256(&Ydoc::wire().encode_full_state()),
        current_path: format!("{object}.md"),
        selector_paths: vec![format!("{object}.md")],
        restore_fence_generation: 7,
    }
}
fn coordinate(connection: &str) -> ApplicationHostCoordinate {
    ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 2,
        instance_id: "instance".into(),
        connection_id: connection.into(),
    }
}
fn fixture() -> (ScratchDir, PathBuf, WorkspaceSupervisor, ActorHandle) {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    for object in ["one", "two"] {
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('workspace',?1,0)", [object]).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
        let key = DocKey::new("workspace", "main", object).unwrap();
        durable::ensure_marker(
            &mut store,
            &key,
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            0,
        )
        .unwrap();
        store.write_with(&NoFaults, |tx| {
            put_binary_blob_with_sha(tx, &Ydoc::wire().encode_full_state(), &binding(object).lineage_claim_id).unwrap();
            tx.execute("UPDATE ydoc_docs SET lineage_claim_status='exact',lineage_claim_id=?1,path=?2 WHERE object_id=?3", rusqlite::params![binding(object).lineage_claim_id,binding(object).current_path,object]).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
    }
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    (scratch, db, supervisor, actor)
}
async fn registered(
    actor: &ActorHandle,
) -> (ActorLiveApplicationOwner, ActorLiveApplicationHandle) {
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register("relay-A".into(), coordinate("connection"), binding("one"))
        .await
        .unwrap();
    (owner, handle)
}
fn event(delivery: &str, cursor: i64, object: &str, bytes: Vec<u8>) -> AdmittedLiveUpdate {
    AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: delivery.into(),
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                },
                binding: binding(object),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "person".into(),
                },
                received_at_ms: 2,
            },
            first_seen: vec![],
        },
        update_bytes: bytes,
    }
}
fn ack(
    result: ApplicationResult,
) -> dohc_engine_collab::live_update_application::LiveUpdateHostApplicationAck {
    match result {
        ApplicationResult::Applied(value) => value,
        other => panic!("expected ACK: {other:?}"),
    }
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

struct CrashSecondCommit {
    point: FaultPoint,
    visits: std::sync::atomic::AtomicUsize,
}
impl FaultInjector for CrashSecondCommit {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point
            && self
                .visits
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                == 1
        {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_application_compacts_and_preserves_replay_through_fold_failures() {
    for mode in [
        "success",
        "before-fold-commit",
        "after-fold-commit",
        "fold-error",
    ] {
        let (_scratch, db, supervisor, actor) = fixture();
        let (_owner, handle) = registered(&actor).await;
        let raw = rusqlite::Connection::open(&db).unwrap();
        let source = Ydoc::wire();
        let mut deliveries = Vec::new();
        for cursor in 1..=64 {
            let update = event(
                &format!("delivery-{cursor}"),
                cursor,
                "one",
                source.plaintext_insert(cursor as u32 - 1, "x"),
            );
            if cursor == 64 && mode == "fold-error" {
                raw.execute_batch("CREATE TRIGGER refuse_fold BEFORE INSERT ON ydoc_snapshots WHEN NEW.up_to_seq>0 BEGIN SELECT RAISE(ABORT, 'fold failure'); END;").unwrap();
            }
            let faults: Arc<dyn FaultInjector> = if cursor == 64 && mode.contains("fold-commit") {
                Arc::new(CrashSecondCommit {
                    point: if mode == "before-fold-commit" {
                        FaultPoint::StorageBeforePersist
                    } else {
                        FaultPoint::StorageAfterCommitBeforeAck
                    },
                    visits: std::sync::atomic::AtomicUsize::new(0),
                })
            } else {
                Arc::new(NoFaults)
            };
            let result = handle.apply(update.clone(), faults, 100_000_000).await;
            if cursor == 64 && mode == "fold-error" {
                assert!(matches!(
                    result,
                    Err(RuntimeError::LiveApplication(ApplicationError::Collab(_)))
                ));
            } else {
                let applied = ack(result.unwrap());
                assert!(!applied.application_replayed);
                assert_eq!(applied.local_ydoc_sequence, cursor);
            }
            deliveries.push(update);
            if cursor == 63 {
                actor
                    .ydoc_resync(
                        DocKey::new("workspace", "main", "one").unwrap(),
                        Some(binding("one").lineage_claim_id),
                        tokio_util::sync::CancellationToken::new(),
                        None,
                    )
                    .await
                    .unwrap();
            }
        }
        let refreshed = actor
            .ydoc_resync(
                DocKey::new("workspace", "main", "one").unwrap(),
                Some(binding("one").lineage_claim_id),
                tokio_util::sync::CancellationToken::new(),
                None,
            )
            .await
            .unwrap();
        let refreshed_doc = Ydoc::wire();
        refreshed_doc.apply(&refreshed.initial_update).unwrap();
        assert!(
            dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(
                &refreshed_doc,
                &source
            )
            .unwrap()
        );
        let count = |table: &str| -> i64 {
            raw.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        };
        assert_eq!(count("live_device_update_applications"), 64);
        let folded = matches!(mode, "success" | "after-fold-commit");
        assert_eq!(count("ydoc_updates"), if folded { 0 } else { 64 });
        for (index, update) in deliveries.iter().enumerate() {
            let replay = ack(handle
                .apply(update.clone(), Arc::new(NoFaults), 100_000_000)
                .await
                .unwrap());
            assert!(replay.application_replayed);
            assert_eq!(replay.local_ydoc_sequence, index as i64 + 1);
        }
        // Exact replay does not retry compaction, including while the failing
        // trigger remains installed. A new delivery retries the existing fold.
        assert_eq!(count("ydoc_updates"), if folded { 0 } else { 64 });
        if mode == "fold-error" {
            raw.execute_batch("DROP TRIGGER refuse_fold").unwrap();
        }
        if !folded {
            let mut duplicate_bytes = deliveries[0].clone();
            duplicate_bytes.metadata.accepted.receipt.delivery_id = "delivery-65".into();
            duplicate_bytes.metadata.accepted.receipt.journal_cursor = 65;
            let applied = ack(handle
                .apply(duplicate_bytes, Arc::new(NoFaults), 100_000_000)
                .await
                .unwrap());
            assert!(!applied.application_replayed);
            assert_eq!(applied.local_ydoc_sequence, 1);
            assert_eq!(count("ydoc_updates"), 0);
            assert_eq!(count("live_device_update_applications"), 65);
        }
        drop(raw);
        supervisor.close(&db).unwrap();
        let store = EngineStore::open(&db, 99).unwrap();
        let restored = store
            .read_with(|conn| {
                durable::load_doc_in(conn, &DocKey::new("workspace", "main", "one").unwrap())
            })
            .unwrap();
        assert!(
            dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&restored, &source)
                .unwrap()
        );
        drop(store);
        let restarted = supervisor.open(&db, 100).unwrap().actor;
        let (_next_owner, next) = registered(&restarted).await;
        for update in deliveries {
            assert!(
                ack(next
                    .apply(update, Arc::new(NoFaults), 100_000_000)
                    .await
                    .unwrap())
                .application_replayed
            );
        }
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_close_or_replacement_retains_durable_invalidation_for_retry() {
    for replace in [false, true] {
        let (_scratch, db, supervisor, actor) = fixture();
        let (owner, one) = registered(&actor).await;
        let two = owner
            .register("relay-A".into(), coordinate("connection"), binding("two"))
            .await
            .unwrap();
        let raw = rusqlite::Connection::open(&db).unwrap();
        raw.execute_batch("CREATE TRIGGER refuse_second_invalidation BEFORE UPDATE OF available ON live_device_application_bindings WHEN OLD.object_id='two' AND NEW.available=0 BEGIN SELECT RAISE(ABORT, 'invalidation failure'); END;").unwrap();
        let result = if replace {
            actor
                .live_application_owner("workspace".into())
                .await
                .map(drop)
        } else {
            owner.close().await
        };
        assert!(matches!(
            result,
            Err(RuntimeError::LiveApplication(ApplicationError::Storage(_)))
        ));
        let availability = || {
            let mut query = raw
                .prepare(
                    "SELECT available FROM live_device_application_bindings ORDER BY object_id",
                )
                .unwrap();
            query
                .query_map([], |row| row.get::<_, i64>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(availability(), vec![0, 1]);
        for (handle, object) in [(&one, "one"), (&two, "two")] {
            assert!(matches!(
                handle
                    .apply(
                        event("retired", 1, object, vec![0, 0]),
                        Arc::new(NoFaults),
                        100_000_000
                    )
                    .await,
                Err(RuntimeError::ActorUnavailable)
            ));
        }
        raw.execute_batch("DROP TRIGGER refuse_second_invalidation")
            .unwrap();
        let next = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        assert_eq!(availability(), vec![0, 0]);
        let live = next
            .register("relay-A".into(), coordinate("next"), binding("one"))
            .await
            .unwrap();
        ack(live
            .apply(
                event("recovered", 1, "one", vec![0, 0]),
                Arc::new(NoFaults),
                100_000_000,
            )
            .await
            .unwrap());
        next.close().await.unwrap();
        drop(raw);
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn documents_use_the_actor_writer_and_owner_replacement_retires_captured_handles() {
    let (_scratch, db, supervisor, actor) = fixture();
    let (owner, one) = registered(&actor).await;
    let two = owner
        .register("relay-A".into(), coordinate("connection"), binding("two"))
        .await
        .unwrap();
    let first = event("one", 1, "one", Ydoc::wire().plaintext_insert(0, "first"));
    let second = event("two", 2, "two", Ydoc::wire().plaintext_insert(0, "second"));
    ack(one
        .apply(first.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    ack(two
        .apply(second.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    let replacement = owner
        .register("relay-A".into(), coordinate("connection"), binding("one"))
        .await
        .unwrap();
    assert_eq!(
        one.apply(first.clone(), Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap(),
        ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
    );
    assert!(
        ack(two
            .apply(second.clone(), Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap())
        .application_replayed
    );
    let (next_owner, next) = registered(&actor).await;
    assert!(matches!(
        replacement
            .apply(first.clone(), Arc::new(NoFaults), 100_000_000)
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    assert!(matches!(
        two.apply(second, Arc::new(NoFaults), 100_000_000).await,
        Err(RuntimeError::ActorUnavailable)
    ));
    assert!(
        ack(next
            .apply(first.clone(), Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap())
        .application_replayed
    );
    drop(next_owner);
    assert!(matches!(
        next.clone()
            .apply(first, Arc::new(NoFaults), 100_000_000)
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 20).unwrap();
    assert_eq!(
        store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        2
    );
    assert_eq!(
        store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
        0
    );
    assert_eq!(store.table_row_count("ydoc_updates").unwrap(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identical_strings_cannot_redirect_an_old_handle_after_restart_or_new_supervisor() {
    let (_scratch, db, supervisor, actor) = fixture();
    let (owner, old) = registered(&actor).await;
    let update = event(
        "replay",
        1,
        "one",
        Ydoc::wire().plaintext_insert(0, "durable"),
    );
    let original = ack(old
        .apply(update.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    let restarted = supervisor.restart(&db, 5).unwrap();
    assert!(matches!(
        old.apply(update.clone(), Arc::new(NoFaults), 100_000_000)
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    assert!(matches!(
        owner
            .register("relay-A".into(), coordinate("connection"), binding("one"))
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    let (_new_owner, new) = registered(&restarted).await;
    let replay = ack(new
        .apply(update.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    assert!(replay.application_replayed);
    assert_eq!(replay.local_ydoc_sequence, original.local_ydoc_sequence);
    assert_eq!(replay.accepting_host_epoch, 1);
    supervisor.close(&db).unwrap();
    let mut store = EngineStore::open(&db, 6).unwrap();
    durable::maybe_compact(
        &mut store,
        &DocKey::new("workspace", "main", "one").unwrap(),
        0,
        &NoFaults,
        7,
    )
    .unwrap();
    drop(store);
    let other_supervisor = WorkspaceSupervisor::new();
    let other = other_supervisor.open(&db, 8).unwrap().actor;
    let (_other_owner, live) = registered(&other).await;
    assert!(matches!(
        new.apply(update.clone(), Arc::new(NoFaults), 100_000_000)
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    assert_eq!(
        ack(live
            .apply(update, Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap())
        .local_ydoc_sequence,
        original.local_ydoc_sequence
    );
    other_supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_conflicts_and_storage_failures_keep_their_typed_errors() {
    let (_scratch, db, supervisor, actor) = fixture();
    let (owner, handle) = registered(&actor).await;
    let mut wrong = binding("one");
    wrong.workspace_id = "foreign".into();
    assert!(matches!(
        owner
            .register("relay-A".into(), coordinate("connection"), wrong)
            .await,
        Err(RuntimeError::LiveApplication(
            ApplicationError::WorkspaceMismatch
        ))
    ));
    let update = event("same", 1, "one", vec![0, 0]);
    ack(handle
        .apply(update.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    let mut conflict = update;
    conflict.metadata.accepted.received_at_ms += 1;
    let error = handle
        .apply(conflict, Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        RuntimeError::LiveApplication(ApplicationError::Conflict)
    ));
    assert_eq!(error.code(), "live-application-conflict");
    owner.close().await.unwrap();
    assert!(matches!(
        handle
            .apply(
                event("late", 2, "one", vec![0, 0]),
                Arc::new(NoFaults),
                100_000_000
            )
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_actor_cannot_register_an_application_handle() {
    let (_scratch, db, supervisor, _actor) = fixture();
    supervisor.close(&db).unwrap();
    let actor = supervisor.open_read_only(&db).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    assert!(matches!(
        owner
            .register("relay-A".into(), coordinate("connection"), binding("one"))
            .await,
        Err(RuntimeError::LiveApplication(ApplicationError::Storage(_)))
    ));
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 5).unwrap();
    assert_eq!(
        store
            .table_row_count("live_device_application_bindings")
            .unwrap(),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dependencies_and_commit_crashes_recover_through_the_real_actor() {
    for delete in [false, true] {
        for parked in [false, true] {
            let (_scratch, db, supervisor, actor) = fixture();
            let producer = Ydoc::wire();
            let first = producer.plaintext_insert(0, "x");
            let dependent = if delete {
                producer.plaintext_delete(0, 1)
            } else {
                producer.plaintext_insert(1, "y")
            };
            let actor = if parked {
                supervisor.close(&db).unwrap();
                let mut store = EngineStore::open(&db, 2).unwrap();
                store
                    .write_with(&NoFaults, |tx| {
                        durable::record_update_in_tx(
                            tx,
                            &DocKey::new("workspace", "main", "one").unwrap(),
                            &dependent,
                            None,
                            None,
                            2,
                        )
                    })
                    .unwrap();
                drop(store);
                supervisor.open(&db, 3).unwrap().actor
            } else {
                actor
            };
            let (_owner, handle) = registered(&actor).await;
            let update = event("dependent", 2, "one", dependent);
            assert_eq!(
                handle
                    .apply(update.clone(), Arc::new(NoFaults), 100_000_000)
                    .await
                    .unwrap(),
                ApplicationResult::Pending(ApplicationPending::DependenciesUnresolved)
            );
            ack(handle
                .apply(
                    event("first", 1, "one", first),
                    Arc::new(NoFaults),
                    100_000_000,
                )
                .await
                .unwrap());
            assert!(matches!(
                handle
                    .apply(
                        update.clone(),
                        Arc::new(Crash(FaultPoint::StorageAfterCommitBeforeAck)),
                        100_000_000
                    )
                    .await,
                Err(RuntimeError::LiveApplication(ApplicationError::Interrupted))
            ));
            let restarted = supervisor.restart(&db, 5).unwrap();
            let (_new_owner, new) = registered(&restarted).await;
            assert!(matches!(
                handle
                    .apply(update.clone(), Arc::new(NoFaults), 100_000_000)
                    .await,
                Err(RuntimeError::ActorUnavailable)
            ));
            assert!(
                ack(new
                    .apply(update, Arc::new(NoFaults), 100_000_000)
                    .await
                    .unwrap())
                .application_replayed
            );
            supervisor.close(&db).unwrap();
            let store = EngineStore::open(&db, 6).unwrap();
            assert_eq!(
                store
                    .table_row_count("live_device_update_applications")
                    .unwrap(),
                2
            );
            let doc = store
                .read_with(|conn| {
                    durable::load_doc_in(conn, &DocKey::new("workspace", "main", "one").unwrap())
                })
                .unwrap();
            assert!(
                dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&doc, &producer)
                    .unwrap()
            );
        }
    }
}

struct HoldCommit {
    entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl FaultInjector for HoldCommit {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::StorageAfterCommitBeforeAck {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
        }
        FaultAction::Continue
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_drop_suppresses_a_committed_ack_and_a_queued_request() {
    let (_scratch, db, supervisor, actor) = fixture();
    let (owner, handle) = registered(&actor).await;
    let update = event("commit", 1, "one", Ydoc::wire().plaintext_insert(0, "x"));
    let (entered, at_commit) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let held = Arc::new(HoldCommit {
        entered: Mutex::new(Some(entered)),
        release: Mutex::new(wait),
    });
    let in_flight = tokio::spawn({
        let handle = handle.clone();
        let update = update.clone();
        async move { handle.apply(update, held, 100_000_000).await }
    });
    at_commit.await.unwrap();
    let mut oversized = event(
        "oversized",
        3,
        "one",
        vec![0; dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES + 1],
    );
    oversized.metadata.accepted.receipt.update_digest = "a".repeat(64);
    let mut oversized = Box::pin(handle.apply(oversized, Arc::new(NoFaults), 100_000_000));
    let oversized_result =
        std::future::poll_fn(|context| std::task::Poll::Ready(oversized.as_mut().poll(context)))
            .await;
    let later = event("queued", 2, "one", vec![0, 0]);
    let mut queued = Box::pin(handle.apply(later, Arc::new(NoFaults), 100_000_000));
    assert!(
        std::future::poll_fn(|context| std::task::Poll::Ready(
            queued.as_mut().poll(context).is_pending()
        ))
        .await
    );
    drop(owner);
    release.send(()).unwrap();
    assert!(matches!(
        oversized_result,
        std::task::Poll::Ready(Err(RuntimeError::LiveApplication(
            ApplicationError::Collab(dohc_engine_collab::CollabError::UpdateTooLarge { .. })
        )))
    ));
    assert!(matches!(
        in_flight.await.unwrap(),
        Err(RuntimeError::ActorUnavailable)
    ));
    assert!(matches!(queued.await, Err(RuntimeError::ActorUnavailable)));
    let (_new_owner, current) = registered(&actor).await;
    assert!(
        ack(current
            .apply(update, Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap())
        .application_replayed
    );
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 5).unwrap();
    assert_eq!(
        store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        1
    );
}

struct PanicCommit;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_preparation_reservation_survives_cancellation_and_owner_retirement() {
    use dohc_engine_collab::live_update_application::{
        NativeRestoreFence, NativeRestoreFenceReceipt, NativeRestorePoint,
        NativeRestorePreparation, RestoreDeliveryOrigin,
    };
    struct Reservation(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Reservation {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let (_scratch, db, supervisor, actor) = fixture();
    let (owner, handle) = registered(&actor).await;
    let (entered, at_commit) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let held = Arc::new(HoldCommit {
        entered: Mutex::new(Some(entered)),
        release: Mutex::new(wait),
    });
    let in_flight = tokio::spawn(async move {
        handle
            .apply(event("held", 1, "one", vec![0, 0]), held, 100_000_000)
            .await
    });
    at_commit.await.unwrap();
    // The writer must reject this queued operation after retirement before reading its fence.
    let input = NativeRestorePreparation {
        fence: NativeRestoreFenceReceipt {
            operation: NativeRestoreFence {
                operation_id: "restore".into(),
                relay_database_namespace: "relay-A".into(),
                old_binding: binding("one"),
                host_id: "host".into(),
                new_fence: 8,
                origin: RestoreDeliveryOrigin::Bootstrap {
                    id: "bootstrap".into(),
                },
                terminal: None,
                applied_sequence: 0,
            },
            local_head_sequence: 0,
            recorded_at_ms: 1,
        },
        point: NativeRestorePoint {
            journal_cursor: 0,
            receipt_digest: binding("one").lineage_claim_id,
            markdown_digest: hex_sha256(b""),
            projection_digest: hex_sha256(b""),
        },
    };
    let disposed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut queued = Box::pin(owner.prepare_restore(
        input.clone(),
        coordinate("connection"),
        1_000_000,
        100,
        Arc::new(NoFaults),
        Arc::new(Reservation(disposed.clone())),
    ));
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(queued.as_mut().poll(cx).is_pending()))
            .await
    );
    drop(queued);
    assert!(!disposed.load(std::sync::atomic::Ordering::SeqCst));
    owner.retire();
    release.send(()).unwrap();
    assert!(matches!(
        in_flight.await.unwrap(),
        Err(RuntimeError::ActorUnavailable)
    ));
    let _replacement = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    assert!(disposed.load(std::sync::atomic::Ordering::SeqCst));
    assert!(matches!(
        owner
            .prepare_restore(
                input,
                coordinate("connection"),
                1_000_000,
                100,
                Arc::new(NoFaults),
                Arc::new(())
            )
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 5).unwrap();
    assert_eq!(store.table_row_count("live_restore_fences").unwrap(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_caller_keeps_queued_input_memory_reserved_until_writer_disposal() {
    struct Reservation(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Reservation {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let (_scratch, db, supervisor, actor) = fixture();
    let (owner, handle) = registered(&actor).await;
    let (entered, at_commit) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let held = Arc::new(HoldCommit {
        entered: Mutex::new(Some(entered)),
        release: Mutex::new(wait),
    });
    let in_flight = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .apply(event("held", 1, "one", vec![0, 0]), held, 100_000_000)
                .await
        }
    });
    at_commit.await.unwrap();
    let disposed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reservation = Arc::new(Reservation(disposed.clone()));
    let mut queued = Box::pin(handle.apply_with_reservation(
        event("queued", 2, "one", vec![0, 0]),
        Arc::new(NoFaults),
        Some(reservation),
        100_000_000,
    ));
    assert!(
        std::future::poll_fn(|context| std::task::Poll::Ready(
            queued.as_mut().poll(context).is_pending()
        ))
        .await
    );
    drop(queued);
    assert!(!disposed.load(std::sync::atomic::Ordering::SeqCst));
    owner.retire();
    release.send(()).unwrap();
    assert!(matches!(
        in_flight.await.unwrap(),
        Err(RuntimeError::ActorUnavailable)
    ));
    let _replacement = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    assert!(disposed.load(std::sync::atomic::Ordering::SeqCst));
    supervisor.close(&db).unwrap();
}

impl FaultInjector for PanicCommit {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        assert_ne!(
            point,
            FaultPoint::StorageBeforePersist,
            "injected worker panic"
        );
        FaultAction::Continue
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_panic_retires_owner_and_rolls_back_before_restart() {
    let (_scratch, db, supervisor, actor) = fixture();
    let (_owner, old) = registered(&actor).await;
    let update = event("panic", 1, "one", Ydoc::wire().plaintext_insert(0, "x"));
    assert!(matches!(
        old.apply(update.clone(), Arc::new(PanicCommit), 100_000_000)
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    let restarted = supervisor.restart(&db, 3).unwrap();
    let (_new_owner, new) = registered(&restarted).await;
    assert!(matches!(
        old.apply(update.clone(), Arc::new(NoFaults), 100_000_000)
            .await,
        Err(RuntimeError::ActorUnavailable)
    ));
    assert!(
        !ack(new
            .apply(update, Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap())
        .application_replayed
    );
    supervisor.close(&db).unwrap();
}
