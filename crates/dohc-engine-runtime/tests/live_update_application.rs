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
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes: bytes,
    }
}
fn ack(
    result: ApplicationResult,
) -> dohc_engine_collab::live_update_application::LiveUpdateHostApplicationAck {
    match result {
        ApplicationResult::Applied(value, _) => value,
        other => panic!("expected ACK: {other:?}"),
    }
}
struct Crash(FaultPoint);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ack_read_uses_current_actor_registration_and_retains_original_sequence() {
    use dohc_engine_collab::live_update_application::LiveApplicationAckIdentity;
    let (_scratch, _db, _supervisor, actor) = fixture();
    let (owner, handle) = registered(&actor).await;
    let source = Ydoc::wire();
    let update = event("ack-one", 1, "one", source.plaintext_insert(0, "one"));
    let identity = LiveApplicationAckIdentity {
        delivery_id: "ack-one".into(),
        update_digest: update.metadata.accepted.receipt.update_digest.clone(),
    };
    assert!(handle.read_ack(identity.clone()).await.unwrap().is_none());
    let mut expected = ack(handle
        .apply(update, Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    expected.application_replayed = true;
    handle
        .apply(
            event("ack-two", 2, "one", source.plaintext_insert(3, " two")),
            Arc::new(NoFaults),
            100_000_000,
        )
        .await
        .unwrap();
    assert_eq!(
        handle.read_ack(identity.clone()).await.unwrap(),
        Some(expected.clone())
    );
    let foreign = owner
        .register("relay-A".into(), coordinate("connection"), binding("two"))
        .await
        .unwrap();
    assert!(foreign.read_ack(identity.clone()).await.is_err());
    owner.retire();
    assert!(handle.read_ack(identity.clone()).await.is_err());
    let (_replacement, fresh) = registered(&actor).await;
    assert_eq!(fresh.read_ack(identity).await.unwrap(), Some(expected));
}
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
            // A failed fold leaves the committed update in place, so the
            // delivery is acknowledged and compaction retries later.
            let applied = ack(handle
                .apply(update.clone(), faults, 100_000_000)
                .await
                .unwrap());
            assert!(!applied.application_replayed);
            assert_eq!(applied.local_ydoc_sequence, cursor);
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
        if point == FaultPoint::StorageAfterCommitBeforeAck
            && let Some(entered) = self.entered.lock().unwrap().take()
        {
            entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
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
        None,
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
async fn markdown_hold_accepted_prefix_survives_restart_without_publishing_a_private_owner_tail() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use dohc_engine_collab::live_update_application::*;
    use dohc_engine_collab::markdown_write_obligations::{self as obligations, Kind};
    use dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let source = data["source"].as_str().unwrap();
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
    for name in ["dohcLineageEpoch", "dohcMarkdownSourceReader"] {
        wire.get_or_insert_map("meta")
            .remove(&mut wire.transact_mut(), name);
    }
    let doc = Ydoc::wire();
    doc.apply(
        &wire
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default()),
    )
    .unwrap();
    let key = DocKey::new("workspace", "main", "one").unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "one".into(),
                path: "one.md".into(),
                text: source.into(),
                moment_id: "source".into(),
                request_id: None,
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        3,
    )
    .unwrap();
    let claim = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    let binding = LiveObjectBinding {
        lineage_claim_id: claim.clone(),
        restore_fence_generation: 0,
        ..binding("one")
    };
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET path='one.md' WHERE object_id='one'", [])
            .map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO ydoc_owner_base_sources(workspace_id,version_id,object_id,lineage_claim_id,\
            path,source_moment_id,source_blob_sha256,source_byte_length) VALUES('workspace','main','one',\
            ?1,'one.md','source',?2,?3)", rusqlite::params![claim,hex_sha256(source.as_bytes()),source.len() as i64])
            .map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,\
            main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,\
            baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,\
            covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,\
            max_pending_bytes,max_pending_age_ms) VALUES('relay-A','adoption','workspace','main','one',?1,?2,\
            'source',?3,?4,0,0,?3,?3,0,0,0,'null','{\"hostId\":\"host\",\"hostEpoch\":2,\"instanceId\":\"instance\",\"connectionId\":\"connection\"}',1000000,1000000)",
            rusqlite::params![claim,serde_json::to_string(&binding).unwrap(),hex_sha256(source.as_bytes()),source.len() as i64])
            .map_err(StorageError::persist_public)?;
        tx.execute(dohc_engine_collab::live_update_application::owner_activations::ACTIVATE_ADOPTION,
                    rusqlite::params!["relay-A", "adoption", None::<String>]).map_err(StorageError::persist_public)?;
        dohc_engine_collab::live_update_application::initialize_adopted_history_for_test(tx, "relay-A", &binding)
            .map_err(StorageError::persist_public)
    }).unwrap();
    drop(store);
    std::fs::write(root.path().join("one.md"), source).unwrap();
    let modified = std::fs::metadata(root.path().join("one.md"))
        .unwrap()
        .modified()
        .unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let mut actor = supervisor.open(&db, 4).unwrap().actor;
    let mut terminal = None;
    let mut accepted_sequence = 0;
    let mut event_to_replay = None;
    for restart in [false, true] {
        actor
            .configure_reader_resolver(Arc::new(
                dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                    dohc_engine_reader::Reader::new(Some(markdown_witness_reader(&root))),
                )),
            ))
            .await
            .unwrap();
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let handle = owner
            .register("relay-A".into(), coordinate("connection"), binding.clone())
            .await
            .unwrap();
        if !restart {
            let bytes = doc.richdoc_append_paragraph("Accepted visitor prefix");
            let mut admitted = event("visitor", 1, "one", bytes);
            admitted.metadata.accepted.binding = binding.clone();
            let applied = ack(handle
                .apply(admitted.clone(), Arc::new(NoFaults), 100_000_000)
                .await
                .unwrap());
            accepted_sequence = applied.local_ydoc_sequence;
            terminal = Some(admitted.metadata.accepted.receipt.clone());
            event_to_replay = Some(admitted);
            actor
                .ydoc_record_update(
                    key.clone(),
                    "one.md".into(),
                    ContentKind::Richdoc,
                    Regime::Replicated,
                    doc.richdoc_append_paragraph("Private owner tail"),
                    None,
                    None,
                    Some(claim.clone()),
                    false,
                    None,
                    Some("private-tail".into()),
                    5,
                    Arc::new(NoFaults),
                    tokio_util::sync::CancellationToken::new(),
                    None,
                )
                .await
                .unwrap();
        }
        let pending = handle
            .settle(
                terminal.clone(),
                100,
                root.path().to_owned(),
                10,
                Arc::new(NoFaults),
                tokio_util::sync::CancellationToken::new(),
                AdmittedNativeHistoryReconstruction {
                    policy: NativeHistoryReconstruction {
                        working_reserve_bytes: 8 * 1024 * 1024,
                    },
                    reservation: Arc::new(()),
                },
            )
            .await;
        assert!(matches!(
            pending,
            Err(RuntimeError::MarkdownWriteHeld { .. })
        ));
        assert_eq!(
            std::fs::read_to_string(root.path().join("one.md")).unwrap(),
            source
        );
        assert_eq!(
            std::fs::metadata(root.path().join("one.md"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        let replay = ack(handle
            .apply(
                event_to_replay.clone().unwrap(),
                Arc::new(NoFaults),
                100_000_000,
            )
            .await
            .unwrap());
        assert!(replay.application_replayed);
        assert_eq!(replay.local_ydoc_sequence, accepted_sequence);
        {
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(store.table_row_count("moments").unwrap(), 1);
            assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 0);
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 0);
            assert_eq!(
                store
                    .table_row_count("live_device_update_applications")
                    .unwrap(),
                1
            );
            let head: String = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT blob_sha256 FROM snapshots WHERE object_id='one'",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(head, hex_sha256(source.as_bytes()));
            let persisted = dohc_engine_collab::load_persisted(&store, &key)
                .unwrap()
                .unwrap();
            assert!(persisted.marker.head_update_seq > accepted_sequence);
            let body = persisted.doc.project(ContentKind::Richdoc).unwrap().content;
            assert!(
                body.contains("Accepted visitor prefix") && body.contains("Private owner tail")
            );
            let owed = store
                .read_with(|conn| obligations::pending_in(conn, "workspace"))
                .unwrap();
            assert_eq!(owed.len(), 1);
            assert_eq!(owed[0].kind, Kind::AuditedSettle);
        }
        if restart {
            let grant = Arc::new(MarkdownConversionConsent::new(
                key.clone(),
                "owner-session".into(),
                Some(claim.clone()),
                None,
                hex_sha256(source.as_bytes()),
                Some(hex_sha256(source.as_bytes())),
            ));
            let saved = handle
                .settle_with_consent(
                    terminal.clone(),
                    100,
                    root.path().to_owned(),
                    11,
                    Arc::new(NoFaults),
                    tokio_util::sync::CancellationToken::new(),
                    AdmittedNativeHistoryReconstruction {
                        policy: NativeHistoryReconstruction {
                            working_reserve_bytes: 8 * 1024 * 1024,
                        },
                        reservation: Arc::new(()),
                    },
                    Some(grant.clone()),
                )
                .await
                .unwrap();
            assert!(grant.is_consumed() && saved.materialized);
            assert_eq!(saved.terminal_cursor, 1);
            let file = std::fs::read_to_string(root.path().join("one.md")).unwrap();
            assert!(file.contains("Accepted visitor prefix"));
            assert!(!file.contains("Private owner tail"));
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(store.table_row_count("live_device_settlements").unwrap(), 1);
            let body = dohc_engine_collab::load_persisted(&store, &key)
                .unwrap()
                .unwrap()
                .doc
                .project(ContentKind::Richdoc)
                .unwrap()
                .content;
            assert!(body.contains("Private owner tail"));
            let covered_sequence: i64 = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT local_ydoc_sequence FROM live_device_settlements",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(covered_sequence, accepted_sequence);
            let owed = store
                .read_with(|conn| obligations::pending_in(conn, "workspace"))
                .unwrap();
            assert_eq!(
                owed.iter()
                    .filter(|row| row.kind == Kind::WitnessRefresh)
                    .count(),
                1
            );
            let held = owed
                .iter()
                .find(|row| row.kind == Kind::AuditedSettle)
                .unwrap();
            let retry: obligations::AuditedRetry =
                serde_json::from_value(held.retry_inputs.clone()).unwrap();
            assert!(
                !store.read_with(|conn| retry.covered_in(conn)).unwrap(),
                "the accepted prefix cannot acknowledge the held private tail"
            );
        }
        owner.retire();
        supervisor.close(&db).unwrap();
        if !restart {
            actor = supervisor.open(&db, 20).unwrap().actor;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_hold_accepted_prefix_settles_full_intervals_with_interleaved_private_owner_edits()
{
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use dohc_engine_collab::live_update_application::*;
    use dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let source = data["source"].as_str().unwrap();
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
    for name in ["dohcLineageEpoch", "dohcMarkdownSourceReader"] {
        wire.get_or_insert_map("meta")
            .remove(&mut wire.transact_mut(), name);
    }
    let doc = Ydoc::wire();
    doc.apply(
        &wire
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default()),
    )
    .unwrap();
    let key = DocKey::new("workspace", "main", "one").unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "one".into(),
                path: "one.md".into(),
                text: source.into(),
                moment_id: "source".into(),
                request_id: None,
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        3,
    )
    .unwrap();
    let claim = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    let binding = LiveObjectBinding {
        lineage_claim_id: claim.clone(),
        restore_fence_generation: 0,
        ..binding("one")
    };
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET path='one.md' WHERE object_id='one'", [])
            .map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO ydoc_owner_base_sources(workspace_id,version_id,object_id,lineage_claim_id,\
            path,source_moment_id,source_blob_sha256,source_byte_length) VALUES('workspace','main','one',\
            ?1,'one.md','source',?2,?3)", rusqlite::params![claim,hex_sha256(source.as_bytes()),source.len() as i64])
            .map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,\
            main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,\
            baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,\
            covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,\
            max_pending_bytes,max_pending_age_ms) VALUES('relay-A','adoption','workspace','main','one',?1,?2,\
            'source',?3,?4,0,0,?3,?3,0,0,0,'null','{\"hostId\":\"host\",\"hostEpoch\":2,\"instanceId\":\"instance\",\"connectionId\":\"connection\"}',1000000,1000000)",
            rusqlite::params![claim,serde_json::to_string(&binding).unwrap(),hex_sha256(source.as_bytes()),source.len() as i64])
            .map_err(StorageError::persist_public)?;
        tx.execute(dohc_engine_collab::live_update_application::owner_activations::ACTIVATE_ADOPTION,
                    rusqlite::params!["relay-A", "adoption", None::<String>]).map_err(StorageError::persist_public)?;
        dohc_engine_collab::live_update_application::initialize_adopted_history_for_test(tx, "relay-A", &binding)
            .map_err(StorageError::persist_public)
    }).unwrap();
    drop(store);
    std::fs::write(root.path().join("one.md"), source).unwrap();

    const LIMIT: usize = 2;
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    actor
        .configure_reader_resolver(Arc::new(
            dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(markdown_witness_reader(&root))),
            )),
        ))
        .await
        .unwrap();
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register("relay-A".into(), coordinate("connection"), binding.clone())
        .await
        .unwrap();
    let reconstruction = || AdmittedNativeHistoryReconstruction {
        policy: NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        reservation: Arc::new(()),
    };
    let mut terminal = None;
    for cursor in 1..=2 {
        let mut accepted = event(
            &format!("accepted-{cursor}"),
            cursor,
            "one",
            doc.richdoc_append_paragraph(&format!("Accepted visitor {cursor}")),
        );
        accepted.metadata.accepted.binding = binding.clone();
        let applied = ack(handle
            .apply_with_reservation(
                accepted.clone(),
                Arc::new(NoFaults),
                None,
                100_000_000,
                Some(LIMIT),
            )
            .await
            .unwrap());
        assert_eq!(applied.local_ydoc_sequence, if cursor == 1 { 1 } else { 3 });
        terminal = Some(accepted.metadata.accepted.receipt);
        if cursor == 1 {
            let private = Ydoc::wire();
            private.apply(&doc.encode_full_state()).unwrap();
            actor
                .ydoc_record_update(
                    key.clone(),
                    "one.md".into(),
                    ContentKind::Richdoc,
                    Regime::Replicated,
                    private.richdoc_append_paragraph("Private owner boundary"),
                    None,
                    None,
                    Some(claim.clone()),
                    false,
                    None,
                    Some("private-boundary".into()),
                    5,
                    Arc::new(NoFaults),
                    tokio_util::sync::CancellationToken::new(),
                    None,
                )
                .await
                .unwrap();
        }
    }
    let held = handle
        .settle(
            terminal.clone(),
            LIMIT,
            root.path().to_owned(),
            10,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            reconstruction(),
        )
        .await;
    assert!(
        matches!(held, Err(RuntimeError::MarkdownWriteHeld { .. })),
        "{held:?}"
    );
    let consent = Arc::new(MarkdownConversionConsent::new(
        key.clone(),
        "owner-session".into(),
        Some(claim.clone()),
        None,
        hex_sha256(source.as_bytes()),
        Some(hex_sha256(source.as_bytes())),
    ));
    let first = handle
        .settle_with_consent(
            terminal.clone(),
            LIMIT,
            root.path().to_owned(),
            11,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            reconstruction(),
            Some(consent),
        )
        .await
        .unwrap();
    assert_eq!(first.terminal_cursor, 2);
    assert_eq!(first.local_ydoc_sequence, 1);

    for round in 0..3 {
        let first_cursor = 3 + round * LIMIT as i64;
        for cursor in first_cursor..first_cursor + LIMIT as i64 {
            let mut accepted = event(
                &format!("accepted-{cursor}"),
                cursor,
                "one",
                doc.richdoc_append_paragraph(&format!("Accepted visitor {cursor}")),
            );
            accepted.metadata.accepted.binding = binding.clone();
            ack(handle
                .apply_with_reservation(
                    accepted.clone(),
                    Arc::new(NoFaults),
                    None,
                    100_000_000,
                    Some(LIMIT),
                )
                .await
                .unwrap());
            terminal = Some(accepted.metadata.accepted.receipt);
        }
        let mut blocked = event(
            &format!("blocked-{round}"),
            first_cursor + LIMIT as i64,
            "one",
            Ydoc::wire().encode_full_state(),
        );
        blocked.metadata.accepted.binding = binding.clone();
        assert!(matches!(
            handle
                .apply_with_reservation(blocked, Arc::new(NoFaults), None, 100_000_000, Some(LIMIT))
                .await
                .unwrap(),
            ApplicationResult::Pending(ApplicationPending::SettlementRequired)
        ));
        let saved = handle
            .settle(
                terminal.clone(),
                LIMIT,
                root.path().to_owned(),
                20 + round,
                Arc::new(NoFaults),
                tokio_util::sync::CancellationToken::new(),
                reconstruction(),
            )
            .await
            .unwrap_or_else(|error| panic!("full interval {round}: {error:?}"));
        assert_eq!(saved.application_count, LIMIT);
        assert_eq!(saved.terminal_cursor, first_cursor + LIMIT as i64 - 1);
        assert_eq!(
            saved.local_ydoc_sequence, 1,
            "the pending owner sequence stays uncovered"
        );
        assert!(saved.materialized);
        let file = std::fs::read_to_string(root.path().join("one.md")).unwrap();
        assert!(file.contains(&format!("Accepted visitor {}", saved.terminal_cursor)));
        assert!(!file.contains("Private owner boundary"));
        let store = EngineStore::open_read_only(&db).unwrap();
        let persisted = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        assert!(
            persisted
                .doc
                .project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains("Private owner boundary")
        );
        let covered: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT MAX(local_ydoc_sequence) FROM live_device_settlements",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(covered, 1);
    }
    owner.retire();
    supervisor.close(&db).unwrap();
}

fn markdown_witness_reader(root: &ScratchDir) -> dohc_engine_reader::Config {
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = serde_json::json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", "\"witness-unsafe\"");
    let bundle = root.path().join("reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = serde_json::json!([]);
    let manifest_path = root.path().join("reader-manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_back_replays_predecessor_settlement_and_settles_later_edits() {
    use dohc_engine_collab::live_update_application::{
        AdmittedNativeHistoryReconstruction, NativeHistoryReconstruction, RetainedPrefix,
        RetainedPrefixBody,
    };
    use dohc_engine_domain::{RenameTextFile, VersionedTextStore, WriteText};

    #[derive(Clone, Copy)]
    enum Mode {
        LocalRoundTrip,
        LocalMultiHop,
        SyncedExact,
        SyncedEquivalentSettlement,
        PreUpgradePersistedEquivalentSettlement,
    }

    for mode in [
        Mode::LocalRoundTrip,
        Mode::LocalMultiHop,
        Mode::SyncedExact,
        Mode::SyncedEquivalentSettlement,
        Mode::PreUpgradePersistedEquivalentSettlement,
    ] {
        let root = ScratchDir::new().unwrap();
        let db = engine_db_path(&root).unwrap();
        let source = "# Initial\n";
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .unwrap();
        let key = DocKey::new("workspace", "main", "one").unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 1, &NoFaults)
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "one".into(),
                    path: "one.md".into(),
                    text: source.into(),
                    moment_id: "source".into(),
                    request_id: None,
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &doc.encode_full_state(),
            &NoFaults,
            3,
        )
        .unwrap();
        let claim = dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .lineage_claim_id
            .unwrap();
        let binding = LiveObjectBinding {
            lineage_claim_id: claim.clone(),
            restore_fence_generation: 0,
            ..binding("one")
        };
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path='one.md' WHERE object_id='one'", [])
                    .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO ydoc_owner_base_sources(workspace_id,version_id,object_id,\
                     lineage_claim_id,path,source_moment_id,source_blob_sha256,source_byte_length) \
                     VALUES('workspace','main','one',?1,'one.md','source',?2,?3)",
                    rusqlite::params![claim, hex_sha256(source.as_bytes()), source.len() as i64],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,\
                     workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,\
                     source_moment_id,source_digest,source_byte_length,\
                     baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,\
                     coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,\
                     terminal_receipt_json,host_coordinate_json,max_pending_bytes,\
                     max_pending_age_ms) VALUES('relay-A','adoption','workspace','main','one',?1,\
                     ?2,'source',?3,?4,0,0,?3,?3,0,0,0,'null',\
                     '{\"hostId\":\"host\",\"hostEpoch\":2,\"instanceId\":\"instance\",\
                     \"connectionId\":\"connection\"}',1000000,1000000)",
                    rusqlite::params![
                        claim,
                        serde_json::to_string(&binding).unwrap(),
                        hex_sha256(source.as_bytes()),
                        source.len() as i64,
                    ],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    dohc_engine_collab::live_update_application::owner_activations::ACTIVATE_ADOPTION,
                    rusqlite::params!["relay-A", "adoption", None::<String>],
                )
                .map_err(StorageError::persist_public)?;
                dohc_engine_collab::live_update_application::initialize_adopted_history_for_test(
                    tx, "relay-A", &binding,
                )
                .map_err(StorageError::persist_public)
            })
            .unwrap();
        drop(store);
        std::fs::write(root.path().join("one.md"), source).unwrap();

        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 4).unwrap().actor;
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let handle = owner
            .register("relay-A".into(), coordinate("connection"), binding.clone())
            .await
            .unwrap();
        let reconstruction = || AdmittedNativeHistoryReconstruction {
            policy: NativeHistoryReconstruction {
                working_reserve_bytes: 8 * 1024 * 1024,
            },
            reservation: Arc::new(()),
        };

        let mut first_event = event(
            "edit-1",
            1,
            "one",
            doc.richdoc_append_paragraph("Before stop"),
        );
        first_event.metadata.accepted.binding = binding.clone();
        ack(handle
            .apply(first_event.clone(), Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap());
        let first_terminal = first_event.metadata.accepted.receipt.clone();
        let first = handle
            .settle(
                Some(first_terminal.clone()),
                16,
                root.path().to_owned(),
                10,
                Arc::new(NoFaults),
                tokio_util::sync::CancellationToken::new(),
                reconstruction(),
            )
            .await
            .unwrap();
        assert!(first.materialized);
        owner.retire();
        supervisor.close(&db).unwrap();

        let settled_text = std::fs::read_to_string(root.path().join("one.md")).unwrap();
        let settled_sha = hex_sha256(settled_text.as_bytes());
        assert_eq!(settled_sha, first.markdown_digest);

        let mut store = EngineStore::open(&db, 20).unwrap();
        let history_evidence_digest: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT evidence_digest FROM live_accepted_updates WHERE journal_cursor=1",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let boundary = RetainedPrefixBody {
            terminal_receipt: Some(first_terminal.clone()),
            event_count: 1,
            history_evidence_digest: history_evidence_digest.clone(),
        };
        let prefix = RetainedPrefix {
            terminal_receipt: Some(first_terminal.clone()),
            event_count: 1,
            history_evidence_digest,
            predecessor_activation_id: "adoption".into(),
        };
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "DELETE FROM live_device_application_bindings WHERE object_id='one'",
                    [],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "UPDATE live_owner_activations SET released_at_ms=19,\
                     released_restore_generation=0,released_accepted_cursor=1,\
                     carried_manifest_json='[]',released_boundary_json=?1 \
                     WHERE activation_id='adoption'",
                    [serde_json::to_string(&boundary).unwrap()],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let local_rename =
            |store: &mut EngineStore, from: &str, to: &str, moment_id: &str, now: i64| {
                VersionedTextStore::new(store)
                    .rename_text_file_with(
                        &RenameTextFile {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            from_path: from.into(),
                            to_path: to.into(),
                            moment_id: moment_id.into(),
                            request_id: None,
                            metadata_origin: "user".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: now,
                        },
                        &NoFaults,
                        |tx, _| {
                            tx.execute("UPDATE ydoc_docs SET path=?1 WHERE object_id='one'", [to])
                                .map_err(StorageError::persist_public)?;
                            Ok(())
                        },
                    )
                    .unwrap();
            };
        let synced_rename = |store: &mut EngineStore,
                             seq: i64,
                             from: &str,
                             to: &str,
                             moment_id: &str,
                             before_moment: &str| {
            let envelope = dohc_engine_sync::ReplicationEnvelope {
                workspace_id: "workspace".into(),
                origin_id: "desktop".into(),
                origin_seq: seq,
                relay_seq: Some(seq),
                op_kind: "moment.append".into(),
                payload: serde_json::json!({
                    "momentId": moment_id,
                    "versionId": "main",
                    "objectId": "one",
                    "objectCreatedAtMs": 1,
                    "path": to,
                    "recordedAtMs": 20 + seq,
                    "operation": "rename",
                    "payloadBeforeBlobSha256": settled_sha,
                    "payloadBeforePath": from,
                    "payloadAfterBlobSha256": settled_sha,
                    "payloadAfterPath": to,
                    "metadata": {"origin": "sync"},
                    "beforePresent": "present",
                    "beforeObjectId": "one",
                    "beforeVersionId": "main",
                    "beforePath": from,
                    "beforeBlobSha256": settled_sha,
                    "beforeContentKind": "text",
                    "beforeUpdatedAtMs": 10,
                    "beforeLatestMomentId": before_moment,
                    "beforeMetadata": {"origin": "sync"}
                }),
                recorded_at_ms: 20 + seq,
                settlement_admission: None,
                admitted_author_snapshot: None,
            };
            let outcome = dohc_engine_sync::apply_moment_envelope(
                store,
                &envelope,
                &NoFaults,
                &dohc_engine_sync::NoLiveLeases,
                &dohc_engine_collab::live_update_application::ReleasedTails::uncached(),
            )
            .unwrap();
            assert!(
                matches!(
                    outcome.primary,
                    dohc_engine_sync::ApplyDisposition::Applied(0)
                ),
                "{outcome:?}"
            );
        };

        let expected_head_moment = match mode {
            Mode::LocalRoundTrip => {
                local_rename(&mut store, "one.md", "moved.md", "rename-1", 21);
                local_rename(&mut store, "moved.md", "one.md", "rename-2", 22);
                "rename-2"
            }
            Mode::LocalMultiHop => {
                local_rename(&mut store, "one.md", "moved.md", "rename-1", 21);
                local_rename(&mut store, "moved.md", "third.md", "rename-2", 22);
                local_rename(&mut store, "third.md", "one.md", "rename-3", 23);
                "rename-3"
            }
            Mode::SyncedExact => {
                synced_rename(
                    &mut store,
                    0,
                    "one.md",
                    "moved.md",
                    "rename-1",
                    &first.moment_id,
                );
                synced_rename(&mut store, 1, "moved.md", "one.md", "rename-2", "rename-1");
                "rename-2"
            }
            Mode::SyncedEquivalentSettlement => {
                let desktop_settlement = format!("moment-ydoc-{}", "e".repeat(64));
                assert_ne!(desktop_settlement, first.moment_id);
                synced_rename(
                    &mut store,
                    0,
                    "one.md",
                    "moved.md",
                    "rename-1",
                    &desktop_settlement,
                );
                synced_rename(&mut store, 1, "moved.md", "one.md", "rename-2", "rename-1");
                "rename-2"
            }
            Mode::PreUpgradePersistedEquivalentSettlement => {
                let desktop_settlement = format!("moment-ydoc-{}", "e".repeat(64));
                assert_ne!(desktop_settlement, first.moment_id);
                synced_rename(
                    &mut store,
                    0,
                    "one.md",
                    "moved.md",
                    "rename-1",
                    &first.moment_id,
                );
                synced_rename(&mut store, 1, "moved.md", "one.md", "rename-2", "rename-1");
                store
                    .write_with(&NoFaults, |tx| {
                        tx.execute(
                            "UPDATE moments SET before_latest_moment_id=?1 WHERE moment_id='rename-1'",
                            [&desktop_settlement],
                        )
                        .map_err(StorageError::persist_public)?;
                        Ok::<_, StorageError>(())
                    })
                    .unwrap();
                "rename-2"
            }
        };
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_owner_base_sources SET source_moment_id=?1,\
                     source_blob_sha256=?2,source_byte_length=?3 WHERE object_id='one'",
                    rusqlite::params![expected_head_moment, settled_sha, settled_text.len() as i64],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO live_owner_activations(relay_database_namespace,activation_id,\
                     workspace_id,main_version_id,object_id,lineage_claim_id,origin_adoption_id,\
                     predecessor_activation_id,binding_json,source_moment_id,source_digest,\
                     source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,\
                     host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,\
                     local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,\
                     max_pending_age_ms,boundary_json) VALUES('relay-A','resumed','workspace',\
                     'main','one',?1,'adoption','adoption',?2,?3,?4,?5,0,0,\
                     '{\"hostId\":\"host\",\"hostEpoch\":2,\"instanceId\":\"instance\",\
                     \"connectionId\":\"connection-2\"}',?4,?4,0,1,1,?6,1000000,1000000,?7)",
                    rusqlite::params![
                        claim,
                        serde_json::to_string(&binding).unwrap(),
                        expected_head_moment,
                        settled_sha,
                        settled_text.len() as i64,
                        serde_json::to_string(&first_terminal).unwrap(),
                        serde_json::to_string(&prefix).unwrap(),
                    ],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let moments_before_replay: i64 = store
            .read_with(|conn| conn.query_row("SELECT count(*) FROM moments", [], |r| r.get(0)))
            .unwrap();
        let settlements_before_replay: i64 = store
            .read_with(|conn| {
                conn.query_row("SELECT count(*) FROM live_device_settlements", [], |r| {
                    r.get(0)
                })
            })
            .unwrap();
        drop(store);

        let actor = supervisor.open(&db, 30).unwrap().actor;
        let owner = actor
            .live_application_owner("workspace".into())
            .await
            .unwrap();
        let handle = owner
            .register(
                "relay-A".into(),
                coordinate("connection-2"),
                binding.clone(),
            )
            .await
            .unwrap();

        let replayed = handle
            .settle(
                Some(first_terminal.clone()),
                16,
                root.path().to_owned(),
                31,
                Arc::new(NoFaults),
                tokio_util::sync::CancellationToken::new(),
                reconstruction(),
            )
            .await
            .unwrap();
        assert_eq!(replayed.settlement_id, first.settlement_id);
        assert_eq!(replayed.moment_id, first.moment_id);
        assert_eq!(replayed.markdown_digest, first.markdown_digest);
        assert_eq!(replayed.terminal_cursor, 1);
        assert!(replayed.materialized);

        let store = EngineStore::open_read_only(&db).unwrap();
        let (head_moment, moment_count, settlement_count): (String, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT latest_moment_id FROM snapshots WHERE path='one.md'",
                        [],
                        |r| r.get(0),
                    )?,
                    conn.query_row("SELECT count(*) FROM moments", [], |r| r.get(0))?,
                    conn.query_row("SELECT count(*) FROM live_device_settlements", [], |r| {
                        r.get(0)
                    })?,
                ))
            })
            .unwrap();
        assert_eq!(head_moment, expected_head_moment);
        assert_eq!(moment_count, moments_before_replay);
        assert_eq!(settlement_count, settlements_before_replay);
        drop(store);

        let mut same_text = event(
            "edit-2-same-text",
            2,
            "one",
            Ydoc::wire().encode_full_state(),
        );
        same_text.metadata.accepted.binding = binding.clone();
        ack(handle
            .apply(same_text.clone(), Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap());
        let second = handle
            .settle(
                Some(same_text.metadata.accepted.receipt.clone()),
                16,
                root.path().to_owned(),
                32,
                Arc::new(NoFaults),
                tokio_util::sync::CancellationToken::new(),
                reconstruction(),
            )
            .await
            .unwrap();
        assert_eq!(second.previous_cursor, 1);
        assert_eq!(second.terminal_cursor, 2);
        assert_ne!(second.moment_id, expected_head_moment);
        let store = EngineStore::open_read_only(&db).unwrap();
        let second_op: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT operation FROM moments WHERE moment_id=?1",
                    [&second.moment_id],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(second_op, "write");
        drop(store);

        let mut changed = event(
            "edit-3-changed",
            3,
            "one",
            doc.richdoc_append_paragraph("After resume"),
        );
        changed.metadata.accepted.binding = binding.clone();
        ack(handle
            .apply(changed.clone(), Arc::new(NoFaults), 100_000_000)
            .await
            .unwrap());
        let third = handle
            .settle(
                Some(changed.metadata.accepted.receipt.clone()),
                16,
                root.path().to_owned(),
                33,
                Arc::new(NoFaults),
                tokio_util::sync::CancellationToken::new(),
                reconstruction(),
            )
            .await
            .unwrap();
        assert_eq!(third.previous_cursor, 2);
        assert_eq!(third.terminal_cursor, 3);
        assert!(third.materialized);
        assert!(
            std::fs::read_to_string(root.path().join("one.md"))
                .unwrap()
                .contains("After resume")
        );
        owner.retire();
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resumed_owner_settles_and_edits_directly_at_renamed_path() {
    use dohc_engine_collab::live_update_application::*;
    use dohc_engine_domain::{RenameTextFile, VersionedTextStore, WriteText};

    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Before stop")
        .unwrap();
    let source_owned = doc.project(ContentKind::Richdoc).unwrap().content;
    let source = source_owned.as_str();
    let key = DocKey::new("workspace", "main", "one").unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "one".into(),
                path: "one.md".into(),
                text: source.into(),
                moment_id: "source".into(),
                request_id: None,
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        3,
    )
    .unwrap();
    let claim = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    let original_binding = LiveObjectBinding {
        lineage_claim_id: claim.clone(),
        restore_fence_generation: 0,
        ..binding("one")
    };
    let moved_binding = LiveObjectBinding {
        current_path: "moved.md".into(),
        selector_paths: vec!["moved.md".into()],
        ..original_binding.clone()
    };
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET path='one.md' WHERE object_id='one'",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO ydoc_owner_base_sources(workspace_id,version_id,object_id,\
                 lineage_claim_id,path,source_moment_id,source_blob_sha256,source_byte_length) \
                 VALUES('workspace','main','one',?1,'one.md','source',?2,?3)",
                rusqlite::params![claim, hex_sha256(source.as_bytes()), source.len() as i64],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,\
                 workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,\
                 source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,\
                 baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,\
                 local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,\
                 max_pending_bytes,max_pending_age_ms) VALUES('relay-A','adoption','workspace',\
                 'main','one',?1,?2,'source',?3,?4,0,0,?3,?3,0,0,0,'null',\
                 '{\"hostId\":\"host\",\"hostEpoch\":2,\"instanceId\":\"instance\",\
                 \"connectionId\":\"connection\"}',1000000,1000000)",
                rusqlite::params![
                    claim,
                    serde_json::to_string(&original_binding).unwrap(),
                    hex_sha256(source.as_bytes()),
                    source.len() as i64,
                ],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                dohc_engine_collab::live_update_application::owner_activations::ACTIVATE_ADOPTION,
                rusqlite::params!["relay-A", "adoption", None::<String>],
            )
            .map_err(StorageError::persist_public)?;
            dohc_engine_collab::live_update_application::initialize_adopted_history_for_test(
                tx,
                "relay-A",
                &original_binding,
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap();
    drop(store);
    std::fs::write(root.path().join("one.md"), source).unwrap();

    let supervisor = WorkspaceSupervisor::new();
    let reconstruction = || AdmittedNativeHistoryReconstruction {
        policy: NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        reservation: Arc::new(()),
    };
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register(
            "relay-A".into(),
            coordinate("connection"),
            original_binding.clone(),
        )
        .await
        .unwrap();
    let mut first_edit = event(
        "edit-1",
        1,
        "one",
        doc.richdoc_append_paragraph("First edit before stop"),
    );
    first_edit.metadata.accepted.binding = original_binding.clone();
    ack(handle
        .apply(first_edit.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    let first_terminal = first_edit.metadata.accepted.receipt.clone();
    let first = handle
        .settle(
            Some(first_terminal.clone()),
            16,
            root.path().to_owned(),
            10,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    assert!(first.materialized);
    owner.retire();
    supervisor.close(&db).unwrap();

    let settled_text = std::fs::read_to_string(root.path().join("one.md")).unwrap();
    let settled_sha = hex_sha256(settled_text.as_bytes());
    std::fs::rename(root.path().join("one.md"), root.path().join("moved.md")).unwrap();
    let mut store = EngineStore::open(&db, 20).unwrap();
    let history_evidence_digest: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT evidence_digest FROM live_accepted_updates \
                 WHERE workspace_id='workspace' AND object_id='one' AND journal_cursor=1",
                [],
                |r| r.get::<_, String>(0),
            )
        })
        .unwrap();
    let boundary = RetainedPrefixBody {
        terminal_receipt: Some(first_terminal.clone()),
        event_count: 1,
        history_evidence_digest: history_evidence_digest.clone(),
    };
    let prefix = RetainedPrefix {
        terminal_receipt: Some(first_terminal.clone()),
        event_count: 1,
        history_evidence_digest,
        predecessor_activation_id: "adoption".into(),
    };
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM live_device_application_bindings WHERE object_id='one'",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "UPDATE live_owner_activations SET released_at_ms=19,\
                 released_restore_generation=0,released_accepted_cursor=1,\
                 carried_manifest_json='[]',released_boundary_json=?1 \
                 WHERE activation_id='adoption'",
                [serde_json::to_string(&boundary).unwrap()],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    VersionedTextStore::new(&mut store)
        .rename_text_file_with(
            &RenameTextFile {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                from_path: "one.md".into(),
                to_path: "moved.md".into(),
                moment_id: "rename-1".into(),
                request_id: None,
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 21,
            },
            &NoFaults,
            |tx, _| {
                tx.execute(
                    "UPDATE ydoc_docs SET path='moved.md' WHERE object_id='one'",
                    [],
                )
                .map_err(StorageError::persist_public)?;
                Ok(())
            },
        )
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_owner_base_sources SET path='moved.md',source_moment_id='rename-1',\
                 source_blob_sha256=?1,source_byte_length=?2 WHERE object_id='one'",
                rusqlite::params![settled_sha, settled_text.len() as i64],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO live_owner_activations(relay_database_namespace,activation_id,\
                 workspace_id,main_version_id,object_id,lineage_claim_id,origin_adoption_id,\
                 predecessor_activation_id,binding_json,source_moment_id,source_digest,\
                 source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,\
                 host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,\
                 local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,\
                 max_pending_age_ms,boundary_json) VALUES('relay-A','resumed','workspace',\
                 'main','one',?1,'adoption','adoption',?2,'rename-1',?3,?4,0,0,\
                 '{\"hostId\":\"host\",\"hostEpoch\":2,\"instanceId\":\"instance\",\
                 \"connectionId\":\"connection-2\"}',?3,?3,0,1,1,?5,1000000,1000000,?6)",
                rusqlite::params![
                    claim,
                    serde_json::to_string(&moved_binding).unwrap(),
                    settled_sha,
                    settled_text.len() as i64,
                    serde_json::to_string(&first_terminal).unwrap(),
                    serde_json::to_string(&prefix).unwrap(),
                ],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    drop(store);

    let actor = supervisor.open(&db, 30).unwrap().actor;
    let owner = actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let handle = owner
        .register(
            "relay-A".into(),
            coordinate("connection-2"),
            moved_binding.clone(),
        )
        .await
        .unwrap();

    let replayed = handle
        .settle(
            Some(first_terminal.clone()),
            16,
            root.path().to_owned(),
            31,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    assert_eq!(replayed.settlement_id, first.settlement_id);
    assert_eq!(replayed.moment_id, first.moment_id);
    assert_eq!(replayed.terminal_cursor, 1);

    let mut second_edit = event(
        "edit-2",
        2,
        "one",
        doc.richdoc_append_paragraph("First edit after move"),
    );
    second_edit.metadata.accepted.binding = moved_binding.clone();
    ack(handle
        .apply(second_edit.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    let second = handle
        .settle(
            Some(second_edit.metadata.accepted.receipt.clone()),
            16,
            root.path().to_owned(),
            32,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    assert_eq!(second.previous_cursor, 1);
    assert_eq!(second.terminal_cursor, 2);
    assert!(second.materialized);
    let moved_text = std::fs::read_to_string(root.path().join("moved.md")).unwrap();
    assert!(moved_text.contains("First edit before stop"));
    assert!(moved_text.contains("First edit after move"));

    let mut third_edit = event(
        "edit-3",
        3,
        "one",
        doc.richdoc_append_paragraph("Second edit after move"),
    );
    third_edit.metadata.accepted.binding = moved_binding.clone();
    ack(handle
        .apply(third_edit.clone(), Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap());
    let third = handle
        .settle(
            Some(third_edit.metadata.accepted.receipt.clone()),
            16,
            root.path().to_owned(),
            33,
            Arc::new(NoFaults),
            tokio_util::sync::CancellationToken::new(),
            reconstruction(),
        )
        .await
        .unwrap();
    assert_eq!(third.previous_cursor, 2);
    assert_eq!(third.terminal_cursor, 3);
    assert!(
        std::fs::read_to_string(root.path().join("moved.md"))
            .unwrap()
            .contains("Second edit after move")
    );
    owner.retire();
    supervisor.close(&db).unwrap();
}
