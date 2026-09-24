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
    let mut releases_seen = leases.release_generation();

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

    // With the session still open nothing asks for another scan.
    offer_deferred_after_release(&leases, &mut releases_seen, &files.handle()).await;
    assert!(!files.handle().stats().await.expect("stats").dirty);

    // The session closes without an edit. Nothing on disk changes, and the
    // release alone brings the file back to capture.
    drop(lease);
    offer_deferred_after_release(&leases, &mut releases_seen, &files.handle()).await;
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
