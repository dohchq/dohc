use super::*;
use dohc_engine_collab::DocKey;
use dohc_engine_domain::derive_capture_object_id;
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

const WORKSPACE_ID: &str = "ws-live-session-deferral";
const NEW_FILE: &str = "notes/new.md";

fn apply_context<'a>(
    root: &'a Path,
    actor: &'a ActorHandle,
    leases: &'a LeaseRegistry,
    status: &'a Arc<DriverStatus>,
    self_writes: &'a SelfWriteSuppression,
) -> ApplyRunContext<'a> {
    ApplyRunContext {
        root,
        actor,
        workspace_id: WORKSPACE_ID,
        leases,
        status,
        self_writes,
        author_json: None,
        provenance: CaptureProvenance::default(),
        events: EngineEvents::default(),
        apply_probe: None,
    }
}

fn head_count(db: &Path, path: &str) -> i64 {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 AND path = ?2",
            [WORKSPACE_ID, path],
            |row| row.get(0),
        )
        .expect("count heads")
}

// A person creates a file and opens it before capture sees it: the editor's
// session holds the new document's lease, and the store refuses to capture a
// leased path. That refusal used to fail the run, degrade the capture layer,
// and quarantine the path for as long as the document stayed open, so every
// flush answered unsettled and History, search, and chat lookups refused.
async fn capture_with_a_live_session_on_a_new_file(files_on_disk: &[&str]) {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    std::fs::create_dir_all(root.join("notes")).expect("notes directory");
    for path in files_on_disk {
        let bytes: &[u8] = if *path == NEW_FILE {
            b""
        } else {
            b"Already here.\n"
        };
        std::fs::write(root.join(path), bytes).expect("write file");
    }
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let leases = LeaseRegistry::new();
    let key = DocKey::new(
        WORKSPACE_ID,
        "main",
        derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE),
    )
    .expect("new file key");
    let lease = leases
        .acquire(&key)
        .expect("the editor's session holds the new file");
    let files = FilesActor::spawn_async(root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let mut releases_seen = leases.release_generation(WORKSPACE_ID);

    let run = reconcile_if_dirty_bound(&root, &files.handle(), CancellationToken::new())
        .await
        .expect("first reconcile");
    let clean = apply_bound_run_with_handle(
        apply_context(&root, &actor, &leases, &status, &self_writes),
        &files.handle(),
        run,
        &CancellationToken::new(),
    )
    .await;
    assert!(
        clean,
        "a path the live session holds is not a failed capture"
    );
    assert!(!status.degraded());
    let stats = files.handle().stats().await.expect("stats");
    assert_eq!(stats.deferred, 1);
    assert_eq!(stats.quarantined, 0);
    assert!(
        !stats.dirty,
        "the layer is quiescent while the session lasts"
    );
    assert_eq!(
        head_count(&db, NEW_FILE),
        0,
        "the session, not capture, records the file"
    );
    for path in files_on_disk.iter().filter(|path| **path != NEW_FILE) {
        assert_eq!(
            head_count(&db, path),
            1,
            "{path} is captured in the same run"
        );
    }

    // With the session still open nothing asks for another scan, and a
    // session closing in another workspace does not either.
    let elsewhere = DocKey::new("another-workspace", "main", "object").expect("other key");
    drop(
        leases
            .acquire(&elsewhere)
            .expect("another workspace's session"),
    );
    offer_deferred_after_release(&leases, WORKSPACE_ID, &mut releases_seen, &files.handle()).await;
    assert!(!files.handle().stats().await.expect("stats").dirty);

    // The session closes without an edit. Nothing on disk changes, and the
    // release alone brings the file back to capture.
    drop(lease);
    offer_deferred_after_release(&leases, WORKSPACE_ID, &mut releases_seen, &files.handle()).await;
    let run = reconcile_if_dirty_bound(&root, &files.handle(), CancellationToken::new())
        .await
        .expect("reconcile after release");
    assert!(
        matches!(run.run, ReconcileRun::Completed(_)),
        "the release asked for a rescan"
    );
    let clean = apply_bound_run_with_handle(
        apply_context(&root, &actor, &leases, &status, &self_writes),
        &files.handle(),
        run,
        &CancellationToken::new(),
    )
    .await;
    assert!(clean);
    assert_eq!(files.handle().stats().await.expect("stats").deferred, 0);
    assert_eq!(
        head_count(&db, NEW_FILE),
        1,
        "the new file is captured once released"
    );

    files.close().await;
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_a_live_session_holds_is_deferred_without_degrading_capture() {
    capture_with_a_live_session_on_a_new_file(&[NEW_FILE]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batched_first_scan_defers_only_the_held_file() {
    capture_with_a_live_session_on_a_new_file(&[NEW_FILE, "notes/other.md", "notes/third.md"])
        .await;
}

fn head_origin(db: &Path, path: &str) -> String {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT metadata_origin FROM snapshots WHERE workspace_id = ?1 AND path = ?2",
            [WORKSPACE_ID, path],
            |row| row.get(0),
        )
        .expect("read head origin")
}

struct Harness {
    _store_scratch: ScratchDir,
    _capture_scratch: ScratchDir,
    root: PathBuf,
    db: PathBuf,
    supervisor: WorkspaceSupervisor,
    actor: ActorHandle,
    leases: LeaseRegistry,
    status: Arc<DriverStatus>,
    self_writes: SelfWriteSuppression,
}

impl Harness {
    fn new() -> Self {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).expect("notes directory");
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine database path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        Harness {
            _store_scratch: store_scratch,
            _capture_scratch: capture_scratch,
            root,
            db,
            supervisor,
            actor,
            leases: LeaseRegistry::new(),
            status: Arc::new(DriverStatus::default()),
            self_writes: SelfWriteSuppression::default(),
        }
    }

    fn key(&self, object_id: &str) -> DocKey {
        DocKey::new(WORKSPACE_ID, "main", object_id).expect("document key")
    }

    async fn capture(&self, files: &FilesHandle) -> bool {
        let run = reconcile_if_dirty_bound(&self.root, files, CancellationToken::new())
            .await
            .expect("reconcile");
        apply_bound_run_with_handle(
            apply_context(
                &self.root,
                &self.actor,
                &self.leases,
                &self.status,
                &self.self_writes,
            ),
            files,
            run,
            &CancellationToken::new(),
        )
        .await
    }

    fn close(self) {
        self.supervisor.close(&self.db).expect("close actor");
    }
}

// Once the new file's session settles, the store has a head another route
// wrote. Capture seeing the file for the first time would not overwrite that
// head anyway, so the session holding it does not refuse the capture.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_head_capture_would_not_overwrite_is_tracked_without_degrading() {
    let harness = Harness::new();
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
    harness
        .actor
        .versioned_text_write(
            dohc_engine_domain::WriteText {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.clone(),
                path: NEW_FILE.to_owned(),
                text: "Settled by the session.\n".to_owned(),
                moment_id: "moment-settled".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the session's settle writes the head");
    std::fs::write(harness.root.join(NEW_FILE), "Settled by the session.\n").expect("artifact");
    let _lease = harness
        .leases
        .acquire(&harness.key(&object_id))
        .expect("the editor still holds the file");
    let files = FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);

    assert!(harness.capture(&files.handle()).await);
    assert!(!harness.status.degraded());
    let stats = files.handle().stats().await.expect("stats");
    assert_eq!((stats.deferred, stats.quarantined), (0, 0));
    assert_eq!(
        head_origin(&harness.db, NEW_FILE),
        "ydoc",
        "capture left the head alone"
    );

    files.close().await;
    harness.close();
}

// A file capture already recorded changes on disk while a live session holds
// it: nothing records that text, so capture stays unsettled instead of
// reporting the file captured.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_recorded_file_changed_on_disk_keeps_capture_unsettled() {
    let harness = Harness::new();
    let path = "notes/existing.md";
    std::fs::write(harness.root.join(path), "Before.\n").expect("existing file");
    let files = FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    assert!(
        harness.capture(&files.handle()).await,
        "the file is captured first"
    );
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", path);
    let _lease = harness
        .leases
        .acquire(&harness.key(&object_id))
        .expect("a person opens the file");

    std::fs::write(harness.root.join(path), "Changed outside the editor.\n")
        .expect("outside write");
    files.handle().request_rescan();
    assert!(
        !harness.capture(&files.handle()).await,
        "the change is not recorded"
    );
    assert!(harness.status.degraded());
    assert_eq!(files.handle().stats().await.expect("stats").deferred, 0);

    files.close().await;
    harness.close();
}

// A version switch or fork captures the whole workspace first. A new file an
// editor still holds is not recorded, so the switch must not go ahead.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_switch_refuses_while_a_new_file_is_held_unrecorded() {
    let harness = Harness::new();
    std::fs::write(harness.root.join(NEW_FILE), "").expect("new file");
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
    let lease = harness
        .leases
        .acquire(&harness.key(&object_id))
        .expect("the editor holds the new file");
    let switch = || {
        reconcile_full_for_switch(
            &harness.root,
            &harness.actor,
            WORKSPACE_ID,
            &harness.leases,
            &harness.status,
            &harness.self_writes,
            None,
            CaptureProvenance::default(),
            EngineEvents::default(),
            CancellationToken::new(),
        )
    };
    assert!(matches!(
        switch().await,
        Err(SwitchReconcileError::ApplyFailed)
    ));
    drop(lease);
    assert!(
        switch().await.is_ok(),
        "the switch goes ahead once the file is recorded"
    );
    assert_eq!(head_count(&harness.db, NEW_FILE), 1);
    harness.close();
}
