use super::*;
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use std::sync::atomic::AtomicUsize;

const WORKSPACE_ID: &str = "ws-capture-batch-retry";

struct Fixture {
    writer: rusqlite::Connection,
    reader: Arc<Mutex<Option<rusqlite::Connection>>>,
    files: FilesActorCloseGuard,
    actor: ActorHandle,
    supervisor: WorkspaceSupervisor,
    db: PathBuf,
    scratch: ScratchDir,
}

impl Fixture {
    async fn new() -> Self {
        let scratch = ScratchDir::new().unwrap();
        let root = scratch.path();
        std::fs::write(root.join("a.md"), "alpha").unwrap();
        std::fs::write(root.join("b.md"), "bravo").unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
            .unwrap();
        drop(store);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let files = FilesActor::spawn_async(root.to_path_buf(), ScanBounds::default())
            .await
            .unwrap();
        let writer = rusqlite::Connection::open(&db).unwrap();
        writer
            .execute_batch(
                "PRAGMA wal_autocheckpoint=0; CREATE TABLE capture_retry_load(body BLOB)",
            )
            .unwrap();
        let reader = rusqlite::Connection::open(&db).unwrap();
        reader
            .execute_batch("BEGIN; SELECT count(*) FROM capture_retry_load")
            .unwrap();
        writer
            .execute_batch("INSERT INTO capture_retry_load VALUES(zeroblob(28*1024*1024))")
            .unwrap();
        let frames: i64 = writer
            .query_row("PRAGMA wal_checkpoint(NOOP)", [], |row| row.get(1))
            .unwrap();
        assert!(
            frames > 6000,
            "the real write gate must refuse this fixture"
        );
        Self {
            scratch,
            supervisor,
            db,
            actor,
            files: FilesActorCloseGuard::new(files),
            reader: Arc::new(Mutex::new(Some(reader))),
            writer,
        }
    }

    fn context<'a>(
        &'a self,
        leases: &'a LeaseRegistry,
        status: &'a Arc<DriverStatus>,
        self_writes: &'a SelfWriteSuppression,
        probe: Option<CaptureApplyProbe>,
    ) -> ApplyRunContext<'a> {
        ApplyRunContext {
            root: self.scratch.path(),
            actor: &self.actor,
            workspace_id: WORKSPACE_ID,
            leases,
            status,
            self_writes,
            author_json: None,
            provenance: CaptureProvenance::default(),
            events: EngineEvents::default(),
            apply_probe: probe,
            import_priority: None,
        }
    }

    async fn run(&self) -> RootBoundRun {
        let run = self
            .files
            .handle()
            .reconcile_if_dirty(CancellationToken::new())
            .await
            .unwrap();
        RootBoundRun {
            captured_root: bind_capture_root(self.scratch.path()).unwrap(),
            run,
        }
    }

    async fn close(self) {
        if let Some(reader) = self.reader.lock().unwrap().take() {
            if !reader.is_autocommit() {
                reader.execute_batch("ROLLBACK").unwrap();
            }
        }
        drop(self.writer);
        self.files.close().await;
        drop(self.actor);
        self.supervisor.close(&self.db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_cancel_reaches_a_sink_already_waiting_on_store_busy() {
    let fixture = Fixture::new().await;
    let run = fixture.run().await;
    let cancel = CancellationToken::new();
    let in_wait = cancel.clone();
    let waits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&waits);
    let probe = CaptureApplyProbe {
        capture_batch_wait: Some(Arc::new(move |_| {
            assert_eq!(
                observed.fetch_add(1, Ordering::Relaxed),
                0,
                "apply cancellation must stop the sink before its second wait"
            );
            in_wait.cancel();
        })),
        ..Default::default()
    };
    let leases = LeaseRegistry::new();
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let outcome = apply_bound_run_with_handle(
        fixture.context(&leases, &status, &self_writes, Some(probe)),
        &fixture.files.handle(),
        run,
        &cancel,
    )
    .await;
    let observed_waits = waits.load(Ordering::Relaxed);
    let observer = rusqlite::Connection::open(&fixture.db).unwrap();
    let captured: i64 = observer
        .query_row(
            "SELECT count(*) FROM path_aliases WHERE workspace_id=?1",
            [WORKSPACE_ID],
            |row| row.get(0),
        )
        .unwrap();
    let dirty = fixture.files.handle().stats().await.unwrap().dirty;
    drop(observer);
    fixture.close().await;
    assert!(!outcome.clean);
    assert!(status.degraded());
    assert_eq!(observed_waits, 1);
    assert_eq!(
        captured, 0,
        "cancellation must not commit either added file"
    );
    assert!(dirty);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watcher_dirty_during_batch_wait_survives_the_driver_acknowledgement() {
    let fixture = Fixture::new().await;
    let run = fixture.run().await;
    let watcher = fixture.files.handle();
    let changed_root = fixture.scratch.path().to_path_buf();
    let reader = Arc::clone(&fixture.reader);
    let waits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&waits);
    let probe = CaptureApplyProbe {
        capture_batch_wait: Some(Arc::new(move |_| {
            if observed.fetch_add(1, Ordering::Relaxed) == 0 {
                std::fs::write(changed_root.join("a.md"), "newer disk edit").unwrap();
                // This becomes mark_dirty before the driver's receipt acknowledgement.
                watcher.request_rescan();
                reader
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .execute_batch("ROLLBACK")
                    .unwrap();
            }
        })),
        ..Default::default()
    };
    let leases = LeaseRegistry::new();
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let outcome = apply_bound_run_with_handle(
        fixture.context(&leases, &status, &self_writes, Some(probe)),
        &fixture.files.handle(),
        run,
        &CancellationToken::new(),
    )
    .await;
    assert!(waits.load(Ordering::Relaxed) > 0);
    assert!(outcome.clean, "busy recovery must leave no failed receipt");
    assert!(!status.degraded());
    assert!(
        fixture.files.handle().stats().await.unwrap().dirty,
        "acknowledging old bytes must preserve the newer watcher epoch"
    );
    let next = fixture.run().await;
    let ReconcileRun::Completed(plan) = &next.run else {
        panic!("watcher mark must offer the disk edit");
    };
    assert_eq!(plan.ops.len(), 1);
    assert_eq!(plan.ops[0].path(), "a.md");
    assert!(
        apply_bound_run_with_handle(
            fixture.context(&leases, &status, &self_writes, None),
            &fixture.files.handle(),
            next,
            &CancellationToken::new(),
        )
        .await
        .clean
    );
    let mut store = EngineStore::open(&fixture.db, 2).unwrap();
    let snapshot = VersionedTextStore::new(&mut store)
        .read_text(WORKSPACE_ID, "main", "a.md")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.text, "newer disk edit");
    assert!(!fixture.files.handle().stats().await.unwrap().dirty);
    drop(store);
    fixture.close().await;
}
