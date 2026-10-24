use super::*;
use dohc_engine_collab::DocKey;
use dohc_engine_domain::derive_capture_object_id;
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

const WORKSPACE_ID: &str = "ws-live-session-deferral";
const NEW_FILE: &str = "notes/new.md";
const NOTE: &str = "notes/note.md";
const KEPT: &str = "notes/kept.md";
const SEED: &str = "Before.\n";
const TYPING: &str = "Typed while held.\n";
const OUTSIDE: &str = "Changed outside the editor.\n";
const FOREIGN: &str = "Another program created this file.\n";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_link_retry_capture_does_not_reenter_a_version_fences_session_gate() {
    use dohc_engine_collab::{ContentKind, LocalAppend, Regime, WriterDocCache, Ydoc};
    use dohc_engine_domain::{RenameTextFile, VersionedTextStore};
    use std::time::Duration;
    let harness = Harness::new();
    let before = "[[old]]\n";
    let outside = "agent prose [[old]]\n";
    std::fs::write(harness.root.join(NEW_FILE), before).unwrap();
    std::fs::write(harness.root.join("old.md"), "target\n").unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    let key = harness.key(&derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE));
    let lease = harness.leases.acquire(&key).unwrap();
    let seed_key = key.clone();
    let operation = "dohc-operation:outside-fence";
    {
        let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 1).unwrap();
        let head = VersionedTextStore::new(&mut store)
            .read_text(WORKSPACE_ID, "main", NEW_FILE)
            .unwrap()
            .unwrap();
        let doc = Ydoc::wire();
        let seed = doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, before)
            .unwrap();
        dohc_engine_collab::ensure_marker(
            &mut store,
            &seed_key,
            ContentKind::Richdoc,
            Regime::LocalOnly,
            &NoFaults,
            3,
        )
        .unwrap();
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &seed_key,
            &seed,
            LocalAppend {
                is_seed: true,
                seed_source_sha256: Some(&head.blob_sha256),
                ..Default::default()
            },
            &NoFaults,
            3,
            |_, _, _| Ok(()),
        )
        .unwrap();
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: WORKSPACE_ID.into(),
                    version_id: "main".into(),
                    from_path: "old.md".into(),
                    to_path: "renamed.md".into(),
                    moment_id: "outside-fence-rename".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some(operation.into()),
                    author_json: None,
                    now_ms: 4,
                },
                &NoFaults,
            )
            .unwrap();
    }
    std::fs::rename(harness.root.join("old.md"), harness.root.join("renamed.md")).unwrap();
    std::fs::write(harness.root.join(NEW_FILE), outside).unwrap();
    let capture = Arc::new(tokio::sync::Mutex::new(()));
    let sessions = Arc::new(tokio::sync::Mutex::new(()));
    let leases = harness.leases.clone();
    let first = harness
        .actor
        .history_rewrite_links(
            WORKSPACE_ID.into(),
            operation.into(),
            "outside-fence-pass".into(),
            None,
            harness.root.clone(),
            harness.leases.clone(),
            [capture.clone(), sessions.clone()],
            Arc::new(NoFaults),
            (
                Arc::new(move |key| leases.is_held_by_session(key)),
                Arc::new(|_| {}),
            ),
            Arc::new(()),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first["unchecked"], serde_json::json!([NEW_FILE]));
    drop(lease);
    let capture_guard = capture.lock().await;
    let session_guard = sessions.lock().await;
    tokio::time::timeout(
        Duration::from_secs(30),
        reconcile_full_for_switch(
            &harness.root,
            &harness.actor,
            WORKSPACE_ID,
            &harness.leases,
            &harness.status,
            &harness.self_writes,
            None,
            None,
            CaptureProvenance::default(),
            EngineEvents::default(),
            CancellationToken::new(),
        ),
    )
    .await
    .expect("capture must only offer a retry while the version fence holds session_ops")
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(harness.root.join(NEW_FILE)).unwrap(),
        outside
    );
    drop(session_guard);
    drop(capture_guard);
    harness
        .actor
        .retry_pending_link_rewrites(WORKSPACE_ID)
        .await;
    let recorded = harness
        .actor
        .versioned_text_read(
            WORKSPACE_ID.into(),
            "main".into(),
            NEW_FILE.into(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recorded.text, "agent prose [[renamed]]\n");
    files.close().await;
    harness.close();
}

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
        import_priority: None,
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
    .await
    .clean;
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
    offer_unrecorded_after_release(&leases, WORKSPACE_ID, &mut releases_seen, &files.handle())
        .await;
    assert!(!files.handle().stats().await.expect("stats").dirty);

    // The session closes without an edit. Nothing on disk changes, and the
    // release alone brings the file back to capture.
    drop(lease);
    offer_unrecorded_after_release(&leases, WORKSPACE_ID, &mut releases_seen, &files.handle())
        .await;
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
    .await
    .clean;
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

/// Fields drop in order: a failed assertion closes the actor, and with it the
/// database, before the scratch trees are removed.
struct Harness {
    root: PathBuf,
    db: PathBuf,
    supervisor: WorkspaceSupervisor,
    actor: ActorHandle,
    leases: LeaseRegistry,
    status: Arc<DriverStatus>,
    self_writes: SelfWriteSuppression,
    author_json: Option<String>,
    _store_scratch: ScratchDir,
    _capture_scratch: ScratchDir,
}

fn seed_held_richdoc(harness: &Harness) -> String {
    use dohc_engine_collab::{
        ContentKind, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
    };
    let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 1).unwrap();
    let input = dohc_engine_domain::CaptureIngest {
        workspace_id: WORKSPACE_ID.into(),
        version_id: "main".into(),
        path: NEW_FILE.into(),
        text: "Before.\n".into(),
        metadata_origin: "capture".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 2,
        request_id: None,
        claim_foreign_head: false,
    };
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .unwrap();
    let head = dohc_engine_domain::VersionedTextStore::new(&mut store)
        .capture_ingest(&input, &NoFaults)
        .unwrap()
        .snapshot;
    let key = harness.key(&head.object_id);
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &input.text)
        .unwrap();
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut WriterDocCache::new(),
        &key,
        &doc.encode_full_state(),
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some(NEW_FILE),
                content_kind: ContentKind::Richdoc,
                regime: Regime::LocalOnly,
            }),
            is_seed: true,
            seed_source_sha256: Some(&head.blob_sha256),
            ..Default::default()
        },
        &NoFaults,
        3,
        |_tx, _outcome, _sha| Ok(()),
    )
    .unwrap();
    drop(store);
    head.object_id
}

async fn fix2_repaired_hold_with_relay_job(first_sight: bool) {
    let harness = Harness::new();
    let outside = format!("{} too deep\n", "> ".repeat(121));
    let object_id = seed_held_richdoc(&harness);
    std::fs::write(harness.root.join(NEW_FILE), &outside).unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(
        harness
            .actor
            .capture_file_holds(WORKSPACE_ID.into())
            .await
            .unwrap()
            .len(),
        1
    );
    harness
        .actor
        .versioned_text_write(
            dohc_engine_domain::WriteText {
                workspace_id: WORKSPACE_ID.into(),
                version_id: "main".into(),
                object_id,
                path: NEW_FILE.into(),
                text: "Remote edit.\n".into(),
                moment_id: "fix2-remote-edit".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    harness
        .actor
        .materialize_relay_page(
            WORKSPACE_ID.into(),
            harness.root.clone(),
            vec![dohc_engine_sync::MomentMaterializationChange {
                version_id: "main".into(),
                path: NEW_FILE.into(),
                operation: "write",
                content_kind: "text",
            }],
            Arc::new(harness.self_writes.clone()),
            5,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let observer = rusqlite::Connection::open(&harness.db).unwrap();
    let job_id: String = observer
        .query_row(
            "SELECT job_id FROM materialization_jobs WHERE status='pending' AND target_path=?1",
            [NEW_FILE],
            |r| r.get(0),
        )
        .unwrap();
    assert!(job_id.starts_with("version-switch-mat_"));
    assert_eq!(
        std::fs::read_to_string(harness.root.join(NEW_FILE)).unwrap(),
        outside
    );
    std::fs::write(harness.root.join(NEW_FILE), "Repaired outside.\n").unwrap();
    let fresh = if first_sight {
        Some(FilesActorCloseGuard::new(
            FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
                .await
                .unwrap(),
        ))
    } else {
        None
    };
    let active_files = if let Some(fresh) = &fresh {
        fresh.handle()
    } else {
        files.handle().request_rescan();
        files.handle()
    };
    let clean = harness.capture(&active_files).await;
    let degraded = harness.status.degraded();
    let job_status: String = observer
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id=?1",
            [&job_id],
            |r| r.get(0),
        )
        .unwrap();
    let disk = std::fs::read_to_string(harness.root.join(NEW_FILE)).unwrap();
    let recorded_sha: String = observer
        .query_row(
            "SELECT blob_sha256 FROM snapshots WHERE workspace_id=?1 AND path=?2",
            [WORKSPACE_ID, NEW_FILE],
            |row| row.get(0),
        )
        .unwrap();
    let notices = std::fs::read_dir(harness.root.join("notes"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(".conflict"))
        .collect::<Vec<_>>();
    assert!(
        harness
            .actor
            .capture_file_holds(WORKSPACE_ID.into())
            .await
            .unwrap()
            .is_empty()
    );
    let history_shas: Vec<String> = observer
        .prepare("SELECT after_blob_sha256 FROM moments WHERE workspace_id=?1 AND path=?2 AND operation='write'")
        .unwrap()
        .query_map([WORKSPACE_ID, NEW_FILE], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    drop(observer);
    let notice_bytes = notices
        .iter()
        .map(|p| std::fs::read_to_string(p).unwrap())
        .collect::<Vec<_>>();
    if let Some(fresh) = fresh {
        fresh.close().await;
    }
    files.close().await;
    harness.close();
    assert!(
        clean && !degraded,
        "a file outcome degraded capture: clean={clean}, degraded={degraded}, status={job_status}"
    );
    assert_eq!(disk, "Repaired outside.\n");
    if first_sight {
        assert_eq!(
            recorded_sha,
            dohc_engine_storage::hex_sha256(b"Remote edit.\n")
        );
        assert_eq!(job_status, "conflict");
        assert_eq!(notices.len(), 1, "ordinary file conflict notice artifact");
        assert_eq!(notice_bytes[0], "Remote edit.\n");
    } else {
        assert_eq!(
            recorded_sha,
            dohc_engine_storage::hex_sha256(b"Repaired outside.\n")
        );
        assert_eq!(job_status, "conflict");
        assert_eq!(notices.len(), 1, "parked remote edit stays visible");
        assert_eq!(notice_bytes[0], "Remote edit.\n");
        for text in ["Remote edit.\n", "Repaired outside.\n"] {
            assert!(
                history_shas.contains(&dohc_engine_storage::hex_sha256(text.as_bytes())),
                "History must retain {text:?}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix4_unheld_capture_settles_stale_relay_without_conflict_copy() {
    let harness = Harness::new();
    let object_id = seed_held_richdoc(&harness);
    std::fs::write(harness.root.join(NEW_FILE), SEED).unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    harness
        .actor
        .versioned_text_write(
            dohc_engine_domain::WriteText {
                workspace_id: WORKSPACE_ID.into(),
                version_id: "main".into(),
                object_id,
                path: NEW_FILE.into(),
                text: "Remote edit.\n".into(),
                moment_id: "fix4-remote-edit".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    harness
        .actor
        .materialize_relay_page(
            WORKSPACE_ID.into(),
            harness.root.clone(),
            vec![dohc_engine_sync::MomentMaterializationChange {
                version_id: "main".into(),
                path: NEW_FILE.into(),
                operation: "write",
                content_kind: "text",
            }],
            Arc::new(harness.self_writes.clone()),
            5,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let observer = rusqlite::Connection::open(&harness.db).unwrap();
    let job_id: String = observer
        .query_row(
            "SELECT job_id FROM materialization_jobs WHERE target_path=?1 AND job_id LIKE 'version-switch-mat_%'",
            [NEW_FILE],
            |r| r.get(0),
        )
        .unwrap();
    // Requeue the real relay intent to model a failed placement without an OS lock.
    observer
        .execute(
            "UPDATE materialization_jobs SET status='pending' WHERE job_id=?1",
            [&job_id],
        )
        .unwrap();
    assert!(
        harness
            .actor
            .capture_file_holds(WORKSPACE_ID.into())
            .await
            .unwrap()
            .is_empty()
    );
    std::fs::write(harness.root.join(NEW_FILE), "Saved outside.\n").unwrap();
    files.handle().request_rescan();
    let clean = harness.capture(&files.handle()).await;
    let degraded = harness.status.degraded();
    let job_status: String = observer
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id=?1",
            [&job_id],
            |r| r.get(0),
        )
        .unwrap();
    let disk = std::fs::read_to_string(harness.root.join(NEW_FILE)).unwrap();
    let notices = std::fs::read_dir(harness.root.join("notes"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(".conflict"))
        .collect::<Vec<_>>();
    drop(observer);
    files.close().await;
    harness.close();
    assert!(clean && !degraded, "clean={clean}, degraded={degraded}");
    assert_eq!(disk, "Saved outside.\n");
    assert!(
        notices.is_empty(),
        "an unheld stale job must settle without a conflict copy: {notices:?}"
    );
    assert_eq!(job_status, "complete");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix3_repaired_hold_keeps_stale_relay_as_visible_conflict() {
    fix2_repaired_hold_with_relay_job(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix2_first_sight_hold_drains_real_relay_conflict_without_degrading() {
    fix2_repaired_hold_with_relay_job(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix3_real_delete_recreate_hold_delete_and_recreate_normally() {
    let harness = Harness::new();
    seed_held_richdoc(&harness);
    std::fs::write(harness.root.join(NEW_FILE), SEED).unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 4).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .delete_text_file(
            &dohc_engine_domain::DeleteTextFile {
                workspace_id: WORKSPACE_ID.into(),
                version_id: "main".into(),
                path: NEW_FILE.into(),
                moment_id: "fix3-real-delete".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
            },
            &NoFaults,
        )
        .unwrap();
    drop(store);
    std::fs::remove_file(harness.root.join(NEW_FILE)).unwrap();
    assert!(!harness.root.join(NEW_FILE).exists());
    assert_eq!(head_count(&harness.db, NEW_FILE), 0);
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    std::fs::write(
        harness.root.join(NEW_FILE),
        format!("{} too deep\n", "> ".repeat(121)),
    )
    .unwrap();
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(
        harness
            .actor
            .capture_file_holds(WORKSPACE_ID.into())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(head_count(&harness.db, NEW_FILE), 0);
    std::fs::remove_file(harness.root.join(NEW_FILE)).unwrap();
    files.handle().request_rescan();
    let clean = harness.capture(&files.handle()).await;
    let degraded = harness.status.degraded();
    let holds = harness
        .actor
        .capture_file_holds(WORKSPACE_ID.into())
        .await
        .unwrap();
    let quarantined = files.handle().stats().await.unwrap().quarantined;
    // Close even on the baseline failure, before asserting the expected result.
    if !clean || degraded || !holds.is_empty() || quarantined != 0 {
        files.close().await;
        harness.close();
        panic!(
            "delete of recreated hold failed: clean={clean}, degraded={degraded}, holds={holds:?}, quarantined={quarantined}"
        );
    }
    std::fs::write(harness.root.join(NEW_FILE), "Recreated normally.\n").unwrap();
    files.handle().request_rescan();
    let clean = harness.capture(&files.handle()).await;
    let degraded = harness.status.degraded();
    let recorded = harness
        .actor
        .versioned_text_read(
            WORKSPACE_ID.into(),
            "main".into(),
            NEW_FILE.into(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    let holds = harness
        .actor
        .capture_file_holds(WORKSPACE_ID.into())
        .await
        .unwrap();
    files.close().await;
    harness.close();
    assert!(clean && !degraded);
    assert!(holds.is_empty());
    assert_eq!(recorded.text, "Recreated normally.\n");
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
            root,
            db,
            supervisor,
            actor,
            leases: LeaseRegistry::new(),
            status: Arc::new(DriverStatus::default()),
            self_writes: SelfWriteSuppression::default(),
            author_json: None,
            _store_scratch: store_scratch,
            _capture_scratch: capture_scratch,
        }
    }

    fn key(&self, object_id: &str) -> DocKey {
        DocKey::new(WORKSPACE_ID, "main", object_id).expect("document key")
    }

    async fn capture(&self, files: &FilesHandle) -> bool {
        let run = reconcile_if_dirty_bound(&self.root, files, CancellationToken::new())
            .await
            .expect("reconcile");
        let mut context = apply_context(
            &self.root,
            &self.actor,
            &self.leases,
            &self.status,
            &self.self_writes,
        );
        context.author_json = self.author_json.clone();
        apply_run(context, files, run, &CancellationToken::new())
            .await
            .clean
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
// it. Capture leaves the outside bytes on disk and waits for lease release.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_recorded_file_changed_on_disk_defers_without_degrading() {
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
        harness.capture(&files.handle()).await,
        "the change waits without failing capture"
    );
    assert!(!harness.status.degraded());
    assert_eq!(files.handle().stats().await.expect("stats").deferred, 1);
    assert_eq!(harness.status.deferred_writes(), vec![path]);

    files.close().await;
    harness.close();
}

// dohc#2342. A file capture recorded is deleted outside dohc while its
// document is open. The session still holds the head and refuses every save
// over the missing file, so capture leaves the head alone. Capture is waiting,
// not failing, so it stays clean. The release alone brings the delete back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_file_a_live_session_holds_is_retired_once_released() {
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
    let lease = harness
        .leases
        .acquire(&harness.key(&object_id))
        .expect("a person opens the file");
    let mut releases_seen = harness.leases.release_generation(WORKSPACE_ID);

    std::fs::remove_file(harness.root.join(path)).expect("deleted outside dohc");
    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the held delete is not a failed capture"
    );
    assert!(!harness.status.degraded());
    let stats = files.handle().stats().await.expect("stats");
    assert_eq!((stats.deferred, stats.quarantined), (1, 0));
    assert!(
        !stats.dirty,
        "the layer is quiescent while the session lasts"
    );
    assert_eq!(
        head_count(&harness.db, path),
        1,
        "the session still holds it"
    );

    drop(lease);
    offer_unrecorded_after_release(
        &harness.leases,
        WORKSPACE_ID,
        &mut releases_seen,
        &files.handle(),
    )
    .await;
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(head_count(&harness.db, path), 0, "retired once released");
    assert_eq!(files.handle().stats().await.expect("stats").deferred, 0);

    files.close().await;
    harness.close();
}

// The same wait when the delete lands between the scan and the apply: capture
// planned to record a change to the held file and finds it gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_file_deleted_between_scan_and_apply_is_retired_once_released() {
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
    let lease = harness
        .leases
        .acquire(&harness.key(&object_id))
        .expect("a person opens the file");
    let mut releases_seen = harness.leases.release_generation(WORKSPACE_ID);

    std::fs::write(harness.root.join(path), "Changed outside.\n").expect("outside write");
    files.handle().request_rescan();
    let run = reconcile_if_dirty_bound(&harness.root, &files.handle(), CancellationToken::new())
        .await
        .expect("scan");
    assert!(
        matches!(&run.run, ReconcileRun::Completed(plan)
            if matches!(plan.ops.as_slice(), [CaptureOp::Ingest { .. }])),
        "the scan plans to record the change"
    );
    std::fs::remove_file(harness.root.join(path)).expect("deleted before the apply");
    let clean = apply_bound_run_with_handle(
        apply_context(
            &harness.root,
            &harness.actor,
            &harness.leases,
            &harness.status,
            &harness.self_writes,
        ),
        &files.handle(),
        run,
        &CancellationToken::new(),
    )
    .await
    .clean;
    assert!(clean, "the held delete is not a failed capture");
    assert!(!harness.status.degraded());
    let stats = files.handle().stats().await.expect("stats");
    assert_eq!((stats.deferred, stats.quarantined), (1, 0));
    assert_eq!(
        head_count(&harness.db, path),
        1,
        "the session still holds it"
    );

    drop(lease);
    offer_unrecorded_after_release(
        &harness.leases,
        WORKSPACE_ID,
        &mut releases_seen,
        &files.handle(),
    )
    .await;
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(head_count(&harness.db, path), 0, "retired once released");

    files.close().await;
    harness.close();
}

// An engine-internal attempt's lease wakes nothing when it ends, so a retire
// it blocks stays an ordinary failure that capture retries.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_file_an_internal_attempt_holds_fails_and_is_retried() {
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
    let internal = harness
        .leases
        .acquire_internal(&harness.key(&object_id))
        .expect("an internal attempt holds the file");

    std::fs::remove_file(harness.root.join(path)).expect("deleted outside dohc");
    files.handle().request_rescan();
    assert!(!harness.capture(&files.handle()).await);
    assert!(harness.status.degraded());
    let stats = files.handle().stats().await.expect("stats");
    assert_eq!(stats.deferred, 0);
    assert!(stats.dirty, "capture retries the retire");
    assert_eq!(head_count(&harness.db, path), 1);

    drop(internal);
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(head_count(&harness.db, path), 0, "the retry retires it");

    files.close().await;
    harness.close();
}

// The held file carried typing the engine admitted but never settled. Once
// the session lets go, the same capture pass records the outside edit as the
// file, keeps the typing as an ordinary sibling, and writes that sibling to
// disk. Its own write must not come back as an outside edit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsettled_typing_on_a_held_file_is_kept_beside_the_outside_edit() {
    let harness = Harness::new();
    let path = "notes/existing.md";
    let typed = "Before.\nTyped while held.\n";
    let outside = "Changed outside the editor.\n";
    std::fs::write(harness.root.join(path), "Before.\n").expect("existing file");
    let files = FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    assert!(
        harness.capture(&files.handle()).await,
        "the file is captured first"
    );

    let key = seed_unsettled_typing(&harness, path, "Before.\n", "Typed while held.\n");

    let lease = harness
        .leases
        .acquire(&key)
        .expect("a person has the file open");
    std::fs::write(harness.root.join(path), outside).expect("outside write");
    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the held file waits without failing capture"
    );

    drop(lease);
    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the released file is captured"
    );
    assert_eq!(head_text(&harness.db, path), outside);
    let sibling = recovered_sibling_on_disk(&harness.root, "notes", "existing");
    assert_eq!(
        std::fs::read_to_string(harness.root.join(&sibling)).expect("sibling on disk"),
        typed,
        "the whole typed text is on disk"
    );
    assert_eq!(head_origin(&harness.db, &sibling), "ydoc");
    assert_eq!(moment_count(&harness.db, &sibling), 1);

    // The pass wrote the sibling itself: the next scan leaves it alone.
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(
        moment_count(&harness.db, &sibling),
        1,
        "the engine's own write is not captured back"
    );
    assert_eq!(head_origin(&harness.db, &sibling), "ydoc");
    assert_eq!(head_text(&harness.db, path), outside);

    files.close().await;
    harness.close();
}

fn head_text(db: &Path, path: &str) -> String {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
             WHERE s.workspace_id = ?1 AND s.path = ?2",
            [WORKSPACE_ID, path],
            |row| row.get(0),
        )
        .expect("read head text")
}

fn moment_count(db: &Path, path: &str) -> i64 {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND path = ?2",
            [WORKSPACE_ID, path],
            |row| row.get(0),
        )
        .expect("count moments")
}

/// The one `<stem> (recovered …).md` file in `<root>/<dir>`, workspace-relative.
fn recovered_sibling_on_disk(root: &Path, dir: &str, stem: &str) -> String {
    let prefix = format!("{stem} (recovered ");
    let names: Vec<String> = std::fs::read_dir(root.join(dir))
        .expect("read the directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.starts_with(&prefix) && name.ends_with(".md"))
        .collect();
    assert_eq!(names.len(), 1, "exactly one recovered sibling: {names:?}");
    format!("{dir}/{}", names[0])
}

/// Open `path`'s captured head as a live document the way the editor does,
/// seed it from the head, then admit `typing` the session never settles.
/// Returns the document's key.
fn seed_unsettled_typing(harness: &Harness, path: &str, seed: &str, typing: &str) -> DocKey {
    use dohc_engine_collab::{
        ContentKind, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
    };
    use dohc_engine_domain::VersionedTextStore;
    use dohc_engine_storage::EngineStore;

    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", path);
    let key = harness.key(&object_id);
    let mut store = EngineStore::open(&harness.db, 1).expect("open store");
    let head = VersionedTextStore::new(&mut store)
        .read_text(WORKSPACE_ID, "main", path)
        .expect("read head")
        .expect("captured head");
    let mut cache = WriterDocCache::new();
    let doc = Ydoc::wire();
    let marker = MarkerCreation {
        path: Some(path),
        content_kind: ContentKind::Plaintext,
        regime: Regime::LocalOnly,
    };
    let seed_update = doc.plaintext_insert(0, seed);
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut cache,
        &key,
        &seed_update,
        LocalAppend {
            marker: Some(marker),
            is_seed: true,
            seed_source_sha256: Some(&head.blob_sha256),
            ..Default::default()
        },
        &NoFaults,
        2,
        |_tx, _outcome, _sha| Ok(()),
    )
    .expect("seed the lineage from the file");
    let typing_update = doc.plaintext_insert(seed.encode_utf16().count() as u32, typing);
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut cache,
        &key,
        &typing_update,
        LocalAppend {
            marker: Some(marker),
            ..Default::default()
        },
        &NoFaults,
        3,
        |_tx, _outcome, _sha| Ok(()),
    )
    .expect("admit typing the session never settles");
    assert_eq!(doc.plaintext_string(), format!("{seed}{typing}"));
    key
}

fn head_correlation(db: &Path, path: &str) -> Option<String> {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT m.metadata_correlation_id FROM snapshots s \
             JOIN moments m ON m.workspace_id = s.workspace_id \
                           AND m.moment_id = s.latest_moment_id \
             WHERE s.workspace_id = ?1 AND s.path = ?2",
            [WORKSPACE_ID, path],
            |row| row.get(0),
        )
        .expect("read head correlation")
}

/// Every `<stem> (recovered …)` head in `main`, by path.
fn recovered_heads(db: &Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(db).expect("open database observer");
    let mut statement = conn
        .prepare(
            "SELECT path FROM snapshots WHERE workspace_id = ?1 AND version_id = 'main' \
             AND path LIKE '% (recovered %' ORDER BY path",
        )
        .expect("prepare recovered heads");
    let rows = statement
        .query_map([WORKSPACE_ID], |row| row.get(0))
        .expect("read recovered heads");
    rows.collect::<Result<Vec<String>, _>>()
        .expect("recovered heads")
}

/// The newest write job aimed at `path`, with its status.
fn write_job(db: &Path, path: &str) -> (String, String) {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT job_id, status FROM materialization_jobs \
             WHERE workspace_id = ?1 AND target_path = ?2 AND operation = 'write' \
             ORDER BY target_generation DESC LIMIT 1",
            [WORKSPACE_ID, path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read the write job")
}

/// A recovered copy whose chosen name another program took before the copy
/// reached disk, and the write the materializer refused for it.
struct Collision {
    copy: String,
    job: String,
}

/// Capture records the file; a session admits typing it never settles; the
/// file is written outside dohc, and capture folds the lineage, keeping the
/// typing as a recovered copy with a pending write. Another program then
/// creates a file at the copy's name, so the materializer refuses that write.
/// The files manifest has never held the copy's name.
async fn stage_refused_recovery(harness: &Harness, files: &FilesHandle) -> Collision {
    use dohc_engine_domain::CaptureIngest;

    std::fs::write(harness.root.join(NOTE), SEED).expect("existing file");
    assert!(harness.capture(files).await, "the file is captured first");
    seed_unsettled_typing(harness, NOTE, SEED, TYPING);
    std::fs::write(harness.root.join(NOTE), OUTSIDE).expect("outside write");
    harness
        .actor
        .capture_ingest(
            CaptureIngest {
                workspace_id: WORKSPACE_ID.into(),
                version_id: "main".into(),
                path: NOTE.into(),
                text: OUTSIDE.into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
                claim_foreign_head: true,
            },
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture the outside write");
    let mut heads = recovered_heads(&harness.db);
    assert_eq!(heads.len(), 1, "exactly one copy: {heads:?}");
    let copy = heads.remove(0);
    assert_eq!(head_text(&harness.db, &copy), format!("{SEED}{TYPING}"));
    let (job, status) = write_job(&harness.db, &copy);
    assert_eq!(status, "pending");

    std::fs::write(harness.root.join(&copy), FOREIGN).expect("foreign file");
    let placed = harness
        .actor
        .materialize_replay_selected_for_fence(
            harness.root.clone(),
            WORKSPACE_ID.to_owned(),
            Arc::new(harness.self_writes.scoped(&harness.root)),
            vec![job.clone()],
            5,
        )
        .await;
    assert!(
        matches!(
            placed,
            Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 })
        ),
        "the write is refused, not forced: {placed:?}"
    );
    assert_eq!(write_job(&harness.db, &copy).1, "conflict");
    assert_eq!(
        std::fs::read_to_string(harness.root.join(&copy)).expect("occupant"),
        FOREIGN
    );
    Collision { copy, job }
}

// A recovered copy's chosen name was taken on disk before the copy was
// placed, so the materializer refused its write. The files manifest has
// never held that name: the next scan sees the other program's file for the
// first time, and first sight claims no head another origin wrote. The store
// knows this head was never placed, so an ordinary pass records the
// occupant, moves the copy to the next free name and writes it, with no
// further edit, manual claim or restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_first_sight_occupant_of_a_recovered_name_is_recorded_and_the_copy_moves() {
    let harness = Harness::new();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .expect("files actor"),
    );
    let collision = stage_refused_recovery(&harness, &files.handle()).await;

    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the pass records the occupant and moves the copy"
    );
    assert!(!harness.status.degraded());
    let stats = files.handle().stats().await.expect("stats");
    assert_eq!((stats.deferred, stats.quarantined), (0, 0));
    assert_eq!(
        std::fs::read_to_string(harness.root.join(&collision.copy)).expect("occupant"),
        FOREIGN,
        "the other program's file stays"
    );
    assert_eq!(head_origin(&harness.db, &collision.copy), "capture");
    assert_eq!(head_text(&harness.db, &collision.copy), FOREIGN);
    assert_eq!(
        write_job(&harness.db, &collision.copy),
        (collision.job.clone(), "cancelled".to_owned()),
        "the refused write is superseded by the moved copy"
    );
    let heads = recovered_heads(&harness.db);
    assert_eq!(heads.len(), 2, "the occupant and the moved copy: {heads:?}");
    let moved = heads
        .iter()
        .find(|path| **path != collision.copy)
        .expect("the copy takes the next free name");
    assert_eq!(
        std::fs::read_to_string(harness.root.join(moved)).expect("moved copy on disk"),
        format!("{SEED}{TYPING}"),
        "the whole typed text is on disk beside the occupant"
    );
    assert_eq!(head_text(&harness.db, moved), format!("{SEED}{TYPING}"));
    assert_eq!(head_origin(&harness.db, moved), "ydoc");
    assert!(
        head_correlation(&harness.db, moved)
            .is_some_and(|correlation| correlation.starts_with("ydoc-local-recovery:v1:")),
        "the moved copy keeps its local-recovery correlation"
    );
    assert_eq!(moment_count(&harness.db, moved), 1);
    assert_eq!(write_job(&harness.db, moved).1, "complete");
    assert_eq!(head_text(&harness.db, NOTE), OUTSIDE);

    // Nothing changes on disk: later passes add no copy and record nothing.
    for _ in 0..2 {
        files.handle().request_rescan();
        assert!(harness.capture(&files.handle()).await);
    }
    assert!(!harness.status.degraded());
    assert_eq!(recovered_heads(&harness.db), heads);
    assert_eq!(moment_count(&harness.db, moved), 1);
    assert_eq!(
        moment_count(&harness.db, &collision.copy),
        2,
        "the copy's moment and the occupant's, and no more"
    );
    assert_eq!(head_origin(&harness.db, moved), "ydoc");
    assert_eq!(
        std::fs::read_to_string(harness.root.join(&collision.copy)).expect("occupant"),
        FOREIGN
    );

    files.close().await;
    harness.close();
}

/// How a person removes the recovered copy before capture sees its occupant.
#[derive(Clone, Copy)]
enum Removal {
    Delete,
    Rename,
}

// A person deletes or renames the recovered copy before capture sees the
// other program's file at its name. That name is then an ordinary new file:
// the pass records the occupant as its own object and does not rebuild the
// copy where it was.
async fn a_removed_copy_leaves_its_occupant_an_ordinary_new_file(removal: Removal) {
    use dohc_engine_domain::{DeleteTextFile, RenameTextFile};

    let harness = Harness::new();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .expect("files actor"),
    );
    let collision = stage_refused_recovery(&harness, &files.handle()).await;
    match removal {
        Removal::Delete => {
            harness
                .actor
                .versioned_text_delete(
                    DeleteTextFile {
                        workspace_id: WORKSPACE_ID.to_owned(),
                        version_id: "main".to_owned(),
                        path: collision.copy.clone(),
                        moment_id: "moment-removed".to_owned(),
                        request_id: None,
                        metadata_origin: "api".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 6,
                    },
                    harness.root.clone(),
                    Arc::new(harness.self_writes.scoped(&harness.root)),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .expect("the person deletes the copy");
        }
        Removal::Rename => {
            harness
                .actor
                .versioned_text_rename(
                    RenameTextFile {
                        workspace_id: WORKSPACE_ID.to_owned(),
                        version_id: "main".to_owned(),
                        from_path: collision.copy.clone(),
                        to_path: KEPT.to_owned(),
                        moment_id: "moment-removed".to_owned(),
                        request_id: None,
                        metadata_origin: "api".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 6,
                    },
                    harness.root.clone(),
                    Arc::new(harness.self_writes.scoped(&harness.root)),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .expect("the person renames the copy");
        }
    }

    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the occupant is an ordinary new file"
    );
    assert!(!harness.status.degraded());
    assert_eq!(
        std::fs::read_to_string(harness.root.join(&collision.copy)).expect("occupant"),
        FOREIGN,
        "the other program's file stays"
    );
    assert_eq!(head_origin(&harness.db, &collision.copy), "capture");
    assert_eq!(head_text(&harness.db, &collision.copy), FOREIGN);
    assert_eq!(
        recovered_heads(&harness.db),
        vec![collision.copy.clone()],
        "the copy is not rebuilt where it was"
    );
    assert_eq!(
        recovered_sibling_on_disk(&harness.root, "notes", "note"),
        collision.copy
    );
    if let Removal::Rename = removal {
        assert_eq!(head_text(&harness.db, KEPT), format!("{SEED}{TYPING}"));
        assert_eq!(head_origin(&harness.db, KEPT), "api");
    }

    files.close().await;
    harness.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_recovered_copy_leaves_its_occupant_an_ordinary_new_file() {
    a_removed_copy_leaves_its_occupant_an_ordinary_new_file(Removal::Delete).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renamed_recovered_copy_leaves_its_occupant_an_ordinary_new_file() {
    a_removed_copy_leaves_its_occupant_an_ordinary_new_file(Removal::Rename).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unrepresentable_replicated_record_never_enters_the_deferred_count() {
    use dohc_engine_collab::{
        ContentKind, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
    };
    use dohc_engine_domain::{CaptureIngest, VersionedTextStore};
    use dohc_engine_storage::EngineStore;

    let harness = Harness::new();
    let path = "tasks/empty.md";
    let mut store = EngineStore::open(&harness.db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
        .unwrap();
    let mut cache = WriterDocCache::new();
    std::fs::create_dir_all(harness.root.join("tasks")).unwrap();
    for (path, text) in [
        (
            "tasks/collection.yaml",
            "fields:\n  Title:\n    type: text\n",
        ),
        (path, ""),
    ] {
        std::fs::write(harness.root.join(path), text).unwrap();
        VersionedTextStore::new(&mut store)
            .capture_ingest(
                &CaptureIngest {
                    workspace_id: WORKSPACE_ID.into(),
                    version_id: "main".into(),
                    path: path.into(),
                    text: text.into(),
                    metadata_origin: "capture".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                    claim_foreign_head: false,
                },
                &NoFaults,
            )
            .unwrap();
    }
    let head = VersionedTextStore::new(&mut store)
        .read_text(WORKSPACE_ID, "main", path)
        .unwrap()
        .unwrap();
    let key = harness.key(&head.object_id);
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "")
        .unwrap();
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut cache,
        &key,
        &doc.encode_full_state(),
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some(path),
                content_kind: ContentKind::Richdoc,
                regime: Regime::LocalOnly,
            }),
            seed_source_sha256: Some(&head.blob_sha256),
            ..Default::default()
        },
        &NoFaults,
        3,
        |_tx, _outcome, _sha| Ok(()),
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, WORKSPACE_ID, "main").unwrap();
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                 VALUES (?1,'seed-origin',0,'ydoc.update',?2,4,0)",
                rusqlite::params![
                    WORKSPACE_ID,
                    serde_json::json!({"versionId":"main","objectId":key.object_id}).to_string()
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    drop(store);
    std::fs::write(
        harness.root.join(path),
        format!("{} too deep\n", "> ".repeat(121)),
    )
    .unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    assert!(!harness.status.degraded());
    assert_eq!(files.handle().stats().await.unwrap().deferred, 0);
    let switch = || {
        reconcile_full_for_switch(
            &harness.root,
            &harness.actor,
            WORKSPACE_ID,
            &harness.leases,
            &harness.status,
            &harness.self_writes,
            None,
            None,
            CaptureProvenance::default(),
            EngineEvents::default(),
            CancellationToken::new(),
        )
    };
    assert!(switch().await.is_ok(), "an isolated hold permits switching");
    std::fs::write(harness.root.join(path), "Completed\n").unwrap();
    assert!(
        switch().await.is_ok(),
        "a representable change recovers version reconciliation"
    );
    files.close().await;
    harness.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual capture cost measurement"]
async fn capture_file_hold_capture_and_idle_cost() {
    for count in [0, 100] {
        let harness = Harness::new();
        let outside = format!("{} too deep\n", "> ".repeat(121));
        let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 1).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
            .unwrap();
        for index in 0..100 {
            let path = format!("notes/held-{index:03}.md");
            let input = dohc_engine_domain::CaptureIngest {
                workspace_id: WORKSPACE_ID.into(),
                version_id: "main".into(),
                path: path.clone(),
                text: SEED.into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            };
            let head = dohc_engine_domain::VersionedTextStore::new(&mut store)
                .capture_ingest(&input, &NoFaults)
                .unwrap()
                .snapshot;
            let key = harness.key(&head.object_id);
            let doc = dohc_engine_collab::Ydoc::wire();
            doc.rewrite_content_to_markdown_preserving_source(
                dohc_engine_collab::ContentKind::Richdoc,
                SEED,
            )
            .unwrap();
            dohc_engine_collab::record_local_update(
                &mut store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &key,
                &doc.encode_full_state(),
                dohc_engine_collab::LocalAppend {
                    marker: Some(dohc_engine_collab::MarkerCreation {
                        path: Some(&path),
                        content_kind: dohc_engine_collab::ContentKind::Richdoc,
                        regime: dohc_engine_collab::Regime::LocalOnly,
                    }),
                    is_seed: true,
                    seed_source_sha256: Some(&head.blob_sha256),
                    ..Default::default()
                },
                &NoFaults,
                3,
                |_tx, _outcome, _sha| Ok(()),
            )
            .unwrap();
            std::fs::write(
                harness.root.join(&path),
                if count == 0 { SEED } else { &outside },
            )
            .unwrap();
        }
        drop(store);
        let seed = manifest_seed(&harness.root, &harness.actor, WORKSPACE_ID, None)
            .await
            .unwrap();
        let files = FilesActorCloseGuard::new(
            FilesActor::spawn_async_with_manifest(
                harness.root.clone(),
                ScanBounds::default(),
                seed.into_scan_seed(),
            )
            .await
            .unwrap(),
        );
        assert!(harness.capture(&files.handle()).await);
        let held_count: i64 = rusqlite::Connection::open(&harness.db)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM capture_file_holds WHERE workspace_id=?1",
                [WORKSPACE_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(held_count, count as i64);
        let mut capture = Vec::new();
        let mut idle = Vec::new();
        let mut phases = Vec::new();
        for sample in 0..33 {
            std::fs::write(
                harness.root.join("notes/sibling.txt"),
                format!("Sibling {sample}.\n"),
            )
            .unwrap();
            files.handle().request_rescan();
            let start = std::time::Instant::now();
            let run =
                reconcile_if_dirty_bound(&harness.root, &files.handle(), CancellationToken::new())
                    .await
                    .unwrap();
            let scan_ms = start.elapsed().as_secs_f64() * 1000.0;
            let apply_start = std::time::Instant::now();
            assert!(
                apply_bound_run_with_handle(
                    apply_context(
                        &harness.root,
                        &harness.actor,
                        &harness.leases,
                        &harness.status,
                        &harness.self_writes
                    ),
                    &files.handle(),
                    run,
                    &CancellationToken::new()
                )
                .await
                .clean
            );
            let apply_ms = apply_start.elapsed().as_secs_f64() * 1000.0;
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let start = std::time::Instant::now();
            assert!(harness.capture(&files.handle()).await);
            let idle_elapsed = start.elapsed().as_secs_f64() * 1000.0;
            if sample >= 3 {
                capture.push(elapsed);
                idle.push(idle_elapsed);
                phases.push((scan_ms, apply_ms));
            }
        }
        println!("capture_phases held_files={count} scan_apply_ms={phases:?}");
        let attempts: i64 = rusqlite::Connection::open(&harness.db)
            .unwrap()
            .query_row("SELECT COALESCE(SUM(attempt_count),0) FROM capture_file_holds WHERE workspace_id=?1", [WORKSPACE_ID], |row| row.get(0))
            .unwrap();
        assert_eq!(
            attempts, count as i64,
            "unchanged holds must not retry during measurement"
        );
        println!(
            "capture_attempts held_files={count} attempts_before={count} attempts_after={attempts}"
        );
        for (name, mut samples) in [("capture_pass", capture), ("idle_capture_tick", idle)] {
            println!("{name}_samples held_files={count} ms={samples:?}");
            samples.sort_by(f64::total_cmp);
            println!(
                "{name} held_files={count} files=101 warmups=3 samples=30 median_ms={:.6} p95_ms={:.6}",
                (samples[14] + samples[15]) / 2.0,
                samples[28]
            );
        }
        files.close().await;
        harness.close();
    }
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

// A recorded file's head is deleted, and a file at the same path is created
// and opened before capture's next scan. Capture still has the old file in
// its manifest, so it sees a change, not a new file; the store has no head,
// and the session's settle creates one. That is deferred like a new file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_changed_file_whose_head_was_deleted_is_deferred_while_held() {
    let harness = Harness::new();
    std::fs::write(harness.root.join(NEW_FILE), "First file.\n").expect("first file");
    let files = FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    assert!(
        harness.capture(&files.handle()).await,
        "the first file is captured"
    );
    assert_eq!(head_count(&harness.db, NEW_FILE), 1);

    harness
        .actor
        .versioned_text_delete(
            dohc_engine_domain::DeleteTextFile {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: "main".to_owned(),
                path: NEW_FILE.to_owned(),
                moment_id: "moment-deleted".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
            },
            harness.root.clone(),
            Arc::new(harness.self_writes.scoped(&harness.root)),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the head is deleted");
    assert_eq!(head_count(&harness.db, NEW_FILE), 0);
    std::fs::write(harness.root.join(NEW_FILE), "").expect("second file, new and empty");
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
    let lease = harness
        .leases
        .acquire(&harness.key(&object_id))
        .expect("a person opens the second file");

    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the held file is not a failed capture"
    );
    assert!(!harness.status.degraded());
    let stats = files.handle().stats().await.expect("stats");
    assert_eq!((stats.deferred, stats.quarantined), (1, 0));
    assert_eq!(
        head_count(&harness.db, NEW_FILE),
        0,
        "the session, not capture, records it"
    );

    // An agent writes the first file's bytes back before the editor saves.
    // They match what capture once recorded at the path, but nothing records
    // them now, so capture defers them.
    std::fs::write(harness.root.join(NEW_FILE), "First file.\n").expect("outside write");
    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the write waits without failing capture"
    );
    assert!(!harness.status.degraded());
    assert_eq!(files.handle().stats().await.expect("stats").deferred, 1);
    assert_eq!(head_count(&harness.db, NEW_FILE), 0);

    drop(lease);
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(
        head_count(&harness.db, NEW_FILE),
        1,
        "captured once released"
    );

    files.close().await;
    harness.close();
}

// A person creates a file and opens it, and capture defers it. Before the
// editor's first settle, an agent writes text to the file. The session would
// refuse those bytes when it settles. Capture waits cleanly and records them
// with the agent as author once the editor lets go.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outside_write_to_a_held_new_file_defers_until_recorded() {
    let mut harness = Harness::new();
    std::fs::write(harness.root.join(NEW_FILE), "").expect("new file");
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
    let lease = harness
        .leases
        .acquire(&harness.key(&object_id))
        .expect("the editor holds the new file");
    let files = FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    assert!(
        harness.capture(&files.handle()).await,
        "the empty new file is deferred"
    );
    assert_eq!(files.handle().stats().await.expect("stats").deferred, 1);

    let author = r#"[{"kind":"agent","agentId":"e2e-agent","onBehalfOf":"local"}]"#;
    harness.author_json = Some(author.to_owned());
    std::fs::write(harness.root.join(NEW_FILE), "Written by the agent.\n").expect("outside write");
    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "the write waits without failing capture"
    );
    assert!(!harness.status.degraded());
    assert_eq!(files.handle().stats().await.expect("stats").deferred, 1);
    assert_eq!(head_count(&harness.db, NEW_FILE), 0);

    harness.author_json = None;
    drop(lease);
    files.handle().request_rescan();
    assert!(
        harness.capture(&files.handle()).await,
        "captured once the editor lets go"
    );
    let recorded: (String, Option<String>) = rusqlite::Connection::open(&harness.db)
        .expect("open database observer")
        .query_row(
            "SELECT s.path, m.author_json FROM snapshots s \
             JOIN moments m ON m.moment_id = s.latest_moment_id \
             WHERE s.workspace_id = ?1 AND s.path = ?2",
            [WORKSPACE_ID, NEW_FILE],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the write's head and moment");
    assert_eq!(recorded, (NEW_FILE.to_owned(), Some(author.to_owned())));

    files.close().await;
    harness.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_reconcile_on_another_file_keeps_live_deferred_writes() {
    let harness = Harness::new();
    std::fs::write(harness.root.join(NOTE), SEED).unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    std::fs::write(harness.root.join("notes/other.md"), "Other.\n").unwrap();
    files.handle().request_rescan();
    let run = reconcile_if_dirty_bound(&harness.root, &files.handle(), CancellationToken::new())
        .await
        .unwrap();
    let mut context = apply_context(
        &harness.root,
        &harness.actor,
        &harness.leases,
        &harness.status,
        &harness.self_writes,
    );
    let operation = "dohc-operation:unrelated";
    context.provenance.correlation_id = Some(operation.into());
    assert!(
        apply_bound_run_with_handle(context, &files.handle(), run, &CancellationToken::new())
            .await
            .clean
    );
    let object = derive_capture_object_id(WORKSPACE_ID, "main", NOTE);
    let _lease = harness.leases.acquire(&harness.key(&object)).unwrap();
    std::fs::write(harness.root.join(NOTE), OUTSIDE).unwrap();
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(harness.status.deferred_writes(), vec![NOTE]);
    let excluded = std::collections::HashSet::new();
    reconcile_full_for_switch(
        &harness.root,
        &harness.actor,
        WORKSPACE_ID,
        &harness.leases,
        &harness.status,
        &harness.self_writes,
        None,
        Some((operation, &excluded)),
        CaptureProvenance::default(),
        EngineEvents::default(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        harness.status.deferred_writes(),
        vec![NOTE],
        "undo's partial scan must not replace the live list"
    );
    files.close().await;
    harness.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deferred_write_author_follows_the_observed_bytes_not_the_next_run() {
    for recorded in [false, true] {
        for changed in [false, true] {
            let mut harness = Harness::new();
            std::fs::write(harness.root.join(NEW_FILE), SEED).unwrap();
            let files = FilesActorCloseGuard::new(
                FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
                    .await
                    .unwrap(),
            );
            if recorded {
                assert!(harness.capture(&files.handle()).await);
            }
            let object = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
            let lease = harness.leases.acquire(&harness.key(&object)).unwrap();
            let first = r#"[{"kind":"agent","agentId":"first","onBehalfOf":"local"}]"#;
            let next = r#"[{"kind":"agent","agentId":"next","onBehalfOf":"local"}]"#;
            harness.author_json = Some(first.into());
            std::fs::write(harness.root.join(NEW_FILE), OUTSIDE).unwrap();
            files.handle().request_rescan();
            assert!(harness.capture(&files.handle()).await);
            harness.author_json = Some(next.into());
            if changed {
                std::fs::write(harness.root.join(NEW_FILE), FOREIGN).unwrap();
            }
            std::fs::write(harness.root.join("notes/other.md"), "Other.\n").unwrap();
            files.handle().request_rescan();
            assert!(harness.capture(&files.handle()).await);
            harness.author_json = None;
            drop(lease);
            files.handle().request_rescan();
            assert!(harness.capture(&files.handle()).await);
            let observer = rusqlite::Connection::open(&harness.db).unwrap();
            for (path, author) in [
                (NEW_FILE, if changed { next } else { first }),
                ("notes/other.md", next),
            ] {
                let actual: Option<String> = observer.query_row(
                    "SELECT m.author_json FROM snapshots s JOIN moments m ON m.moment_id=s.latest_moment_id WHERE s.workspace_id=?1 AND s.path=?2",
                    [WORKSPACE_ID, path], |row| row.get(0)).unwrap();
                assert_eq!(
                    actual.as_deref(),
                    Some(author),
                    "recorded={recorded}, changed={changed}, path={path}"
                );
            }
            assert_eq!(
                head_text(&harness.db, NEW_FILE),
                if changed { FOREIGN } else { OUTSIDE }
            );
            assert!(harness.status.deferred_writes().is_empty());
            drop(observer);
            files.close().await;
            harness.close();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_scan_keeps_a_deferred_writes_author_until_release() {
    for (recorded, unconfirmed_removed) in [(false, false), (true, false), (true, true)] {
        let mut harness = Harness::new();
        std::fs::write(harness.root.join(NEW_FILE), SEED).unwrap();
        let files = FilesActorCloseGuard::new(
            FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
                .await
                .unwrap(),
        );
        if recorded {
            assert!(harness.capture(&files.handle()).await);
        }
        let object = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
        let lease = harness.leases.acquire(&harness.key(&object)).unwrap();
        let author = r#"[{"kind":"agent","agentId":"first","onBehalfOf":"local"}]"#;
        harness.author_json = Some(author.into());
        std::fs::write(harness.root.join(NEW_FILE), OUTSIDE).unwrap();
        files.handle().request_rescan();
        assert!(harness.capture(&files.handle()).await);
        harness.author_json = None;

        files.handle().request_rescan();
        let mut run =
            reconcile_if_dirty_bound(&harness.root, &files.handle(), CancellationToken::new())
                .await
                .unwrap();
        let ReconcileRun::Completed(plan) = &mut run.run else {
            panic!("the waiting write requires another observation");
        };
        // Model a scan read failure without relying on platform permissions.
        // Unconfirmed removals also appear in degraded_paths.
        plan.ops.clear();
        plan.degraded = true;
        plan.degraded_paths.push(NEW_FILE.into());
        if unconfirmed_removed {
            plan.unconfirmed_removed.push(NEW_FILE.into());
        }
        assert!(
            !apply_run(
                apply_context(
                    &harness.root,
                    &harness.actor,
                    &harness.leases,
                    &harness.status,
                    &harness.self_writes,
                ),
                &files.handle(),
                run,
                &CancellationToken::new(),
            )
            .await
            .clean
        );

        drop(lease);
        files.handle().request_rescan();
        assert!(harness.capture(&files.handle()).await);
        let observer = rusqlite::Connection::open(&harness.db).unwrap();
        let actual: Option<String> = observer.query_row(
            "SELECT m.author_json FROM snapshots s JOIN moments m ON m.moment_id=s.latest_moment_id WHERE s.workspace_id=?1 AND s.path=?2",
            [WORKSPACE_ID, NEW_FILE], |row| row.get(0)).unwrap();
        assert_eq!(
            actual.as_deref(),
            Some(author),
            "recorded={recorded}, unconfirmed_removed={unconfirmed_removed}"
        );
        assert_eq!(head_text(&harness.db, NEW_FILE), OUTSIDE);
        assert!(harness.status.deferred_writes().is_empty());
        drop(observer);
        files.close().await;
        harness.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unrecorded_file_an_internal_attempt_holds_fails_and_retries() {
    let harness = Harness::new();
    std::fs::write(harness.root.join(NEW_FILE), OUTSIDE).unwrap();
    let object = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
    let lease = harness
        .leases
        .acquire_internal(&harness.key(&object))
        .unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(!harness.capture(&files.handle()).await);
    assert!(harness.status.deferred_writes().is_empty());
    assert_eq!(head_count(&harness.db, NEW_FILE), 0);
    assert_eq!(files.handle().stats().await.unwrap().deferred, 0);
    drop(lease);
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(head_text(&harness.db, NEW_FILE), OUTSIDE);
    files.close().await;
    harness.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual capture cost measurement"]
async fn fix1_no_hold_capture_and_idle_cost() {
    for count in [0] {
        let harness = Harness::new();
        let outside = format!("{} too deep\n", "> ".repeat(121));
        let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 1).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
            .unwrap();
        for index in 0..100 {
            let path = format!("notes/held-{index:03}.md");
            let input = dohc_engine_domain::CaptureIngest {
                workspace_id: WORKSPACE_ID.into(),
                version_id: "main".into(),
                path: path.clone(),
                text: SEED.into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            };
            let head = dohc_engine_domain::VersionedTextStore::new(&mut store)
                .capture_ingest(&input, &NoFaults)
                .unwrap()
                .snapshot;
            let key = harness.key(&head.object_id);
            let doc = dohc_engine_collab::Ydoc::wire();
            doc.rewrite_content_to_markdown_preserving_source(
                dohc_engine_collab::ContentKind::Richdoc,
                SEED,
            )
            .unwrap();
            dohc_engine_collab::record_local_update(
                &mut store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &key,
                &doc.encode_full_state(),
                dohc_engine_collab::LocalAppend {
                    marker: Some(dohc_engine_collab::MarkerCreation {
                        path: Some(&path),
                        content_kind: dohc_engine_collab::ContentKind::Richdoc,
                        regime: dohc_engine_collab::Regime::LocalOnly,
                    }),
                    is_seed: true,
                    seed_source_sha256: Some(&head.blob_sha256),
                    ..Default::default()
                },
                &NoFaults,
                3,
                |_tx, _outcome, _sha| Ok(()),
            )
            .unwrap();
            std::fs::write(
                harness.root.join(&path),
                if count == 0 { SEED } else { &outside },
            )
            .unwrap();
        }
        drop(store);
        let seed = manifest_seed(&harness.root, &harness.actor, WORKSPACE_ID, None)
            .await
            .unwrap();
        let files = FilesActorCloseGuard::new(
            FilesActor::spawn_async_with_manifest(
                harness.root.clone(),
                ScanBounds::default(),
                seed.into_scan_seed(),
            )
            .await
            .unwrap(),
        );
        assert!(harness.capture(&files.handle()).await);
        let mut capture = Vec::new();
        let mut idle = Vec::new();
        for sample in 0..33 {
            std::fs::write(
                harness.root.join("notes/sibling.txt"),
                format!("Sibling {sample}.\n"),
            )
            .unwrap();
            files.handle().request_rescan();
            let start = std::time::Instant::now();
            assert!(harness.capture(&files.handle()).await);
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let start = std::time::Instant::now();
            assert!(harness.capture(&files.handle()).await);
            let idle_elapsed = start.elapsed().as_secs_f64() * 1000.0;
            if sample >= 3 {
                capture.push(elapsed);
                idle.push(idle_elapsed);
            }
        }
        for (name, mut samples) in [("capture_pass", capture), ("idle_capture_tick", idle)] {
            println!("{name}_samples held_files={count} ms={samples:?}");
            samples.sort_by(f64::total_cmp);
            println!(
                "{name} held_files={count} files=101 warmups=3 samples=30 median_ms={:.6} p95_ms={:.6}",
                (samples[14] + samples[15]) / 2.0,
                samples[28]
            );
        }
        files.close().await;
        harness.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual placement replay cost measurement"]
async fn fix1_no_hold_placement_replay_cost() {
    let mut samples = Vec::new();
    for sample in 0..33 {
        let harness = Harness::new();
        let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 1).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                let text = "Replay content.\n";
                let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    rusqlite::params![sha, text.len() as i64, text],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                for index in 0..100 {
                    dohc_engine_storage::enqueue_job(
                        tx,
                        &dohc_engine_storage::MaterializationJobSpec {
                            job_id: format!("replay-{index}"),
                            workspace_id: WORKSPACE_ID.into(),
                            target_path: format!("notes/replay-{index}.txt"),
                            content_sha256: sha.clone(),
                            preimage: dohc_engine_storage::Preimage::Absent,
                            target_generation: index + 1,
                            now_ms: 2,
                        },
                    )?;
                }
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .unwrap();
        drop(store);
        let start = std::time::Instant::now();
        assert_eq!(
            harness
                .actor
                .materialize_replay_pending(harness.root.clone(), WORKSPACE_ID.into(), 3)
                .await
                .unwrap(),
            100
        );
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if sample >= 3 {
            samples.push(elapsed);
        }
        harness.close();
    }
    println!("placement_replay_samples jobs=100 ms={samples:?}");
    samples.sort_by(f64::total_cmp);
    println!(
        "placement_replay held_files=0 jobs=100 warmups=3 samples=30 median_ms={:.6} p95_ms={:.6}",
        (samples[14] + samples[15]) / 2.0,
        samples[28]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lease_release_reoffers_deferred_outside_writes() {
    let harness = Harness::new();
    std::fs::write(harness.root.join(NEW_FILE), "Written outside the editor.\n").unwrap();
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NEW_FILE);
    let lease = harness.leases.acquire(&harness.key(&object_id)).unwrap();
    let files = FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
        .await
        .unwrap();
    let files = FilesActorCloseGuard::new(files);
    for _ in 0..dohc_engine_files::DEGRADED_RESCAN_BACKOFF {
        assert!(harness.capture(&files.handle()).await);
    }
    let parked = files.handle().stats().await.unwrap();
    assert!(!parked.dirty);
    assert_eq!((parked.deferred, parked.quarantined), (1, 0));
    assert!(!harness.status.degraded());
    assert_eq!(harness.status.deferred_writes(), vec![NEW_FILE]);
    let mut releases_seen = harness.leases.release_generation(WORKSPACE_ID);
    drop(lease);
    offer_unrecorded_after_release(
        &harness.leases,
        WORKSPACE_ID,
        &mut releases_seen,
        &files.handle(),
    )
    .await;
    let offered = files.handle().stats().await.unwrap().dirty;
    let clean = harness.capture(&files.handle()).await;
    let captured = head_count(&harness.db, NEW_FILE);
    let recovered = files.handle().stats().await.unwrap();
    files.close().await;
    harness.close();
    assert!(offered, "releasing the lease must wake its deferred write");
    assert!(clean);
    assert_eq!(captured, 1);
    assert_eq!((recovered.deferred, recovered.quarantined), (0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_outside_write_is_captured_once_after_session_release() {
    recorded_outside_write_after_release(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_captures_a_deferred_outside_write_once() {
    recorded_outside_write_after_release(true).await;
}

// #2413 will publish link-rewrite jobs through this same placement boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn placement_against_a_deferred_writes_old_base_conflicts_without_overwriting() {
    let harness = Harness::new();
    std::fs::write(harness.root.join(NOTE), SEED).unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NOTE);
    let lease = harness.leases.acquire(&harness.key(&object_id)).unwrap();
    std::fs::write(harness.root.join(NOTE), OUTSIDE).unwrap();
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(harness.status.deferred_writes(), vec![NOTE]);
    assert_eq!(
        dohc_engine_files::materialize::write_precondition_sha256(&harness.root, NOTE).unwrap(),
        Some(dohc_engine_storage::hex_sha256(OUTSIDE.as_bytes()))
    );
    let rewritten = "Rewritten document from the old base.\n";
    let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 1).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            let sha = dohc_engine_storage::hex_sha256(rewritten.as_bytes());
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                rusqlite::params![sha, rewritten.len() as i64, rewritten],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            dohc_engine_storage::enqueue_job(
                tx,
                &dohc_engine_storage::MaterializationJobSpec {
                    job_id: "deferred-preimage-placement".into(),
                    workspace_id: WORKSPACE_ID.into(),
                    target_path: NOTE.into(),
                    content_sha256: sha,
                    preimage: dohc_engine_storage::Preimage::Present(
                        dohc_engine_storage::hex_sha256(SEED.as_bytes()),
                    ),
                    target_generation: 1000,
                    now_ms: 2,
                },
            )?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    drop(store);
    harness
        .actor
        .materialize_replay_pending(harness.root.clone(), WORKSPACE_ID.into(), 3)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(harness.root.join(NOTE)).unwrap(),
        OUTSIDE
    );
    let observer = rusqlite::Connection::open(&harness.db).unwrap();
    let status: String = observer
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id='deferred-preimage-placement'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "conflict");
    let conflicts: Vec<_> = std::fs::read_dir(harness.root.join("notes"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.to_string_lossy().ends_with(".conflict"))
        .collect();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(std::fs::read_to_string(&conflicts[0]).unwrap(), rewritten);
    drop(observer);
    drop(lease);
    files.close().await;
    harness.close();
}

async fn recorded_outside_write_after_release(restart: bool) {
    let harness = Harness::new();
    std::fs::write(harness.root.join(NOTE), SEED).unwrap();
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .unwrap(),
    );
    assert!(harness.capture(&files.handle()).await);
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NOTE);
    let lease = harness.leases.acquire(&harness.key(&object_id)).unwrap();
    std::fs::write(harness.root.join(NOTE), OUTSIDE).unwrap();
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert!(!harness.status.degraded());
    assert_eq!(harness.status.deferred_writes(), vec![NOTE]);
    let stats = files.handle().stats().await.unwrap();
    assert_eq!((stats.deferred, stats.quarantined), (1, 0));
    let mut releases_seen = harness.leases.release_generation(WORKSPACE_ID);
    drop(lease); // Both an orderly close and a crashed session release the lease.
    if restart {
        files.close().await;
        harness.supervisor.close(&harness.db).unwrap();
        let actor = harness.supervisor.open(&harness.db, 1).unwrap().actor;
        let leases = LeaseRegistry::new();
        let files = FilesActorCloseGuard::new(
            FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
                .await
                .unwrap(),
        );
        let run =
            reconcile_if_dirty_bound(&harness.root, &files.handle(), CancellationToken::new())
                .await
                .unwrap();
        assert!(
            apply_run(
                apply_context(
                    &harness.root,
                    &actor,
                    &leases,
                    &harness.status,
                    &harness.self_writes
                ),
                &files.handle(),
                run,
                &CancellationToken::new(),
            )
            .await
            .clean
        );
        files.close().await;
    } else {
        offer_unrecorded_after_release(
            &harness.leases,
            WORKSPACE_ID,
            &mut releases_seen,
            &files.handle(),
        )
        .await;
        assert!(files.handle().stats().await.unwrap().dirty);
        assert!(harness.capture(&files.handle()).await);
        files.handle().request_rescan();
        assert!(harness.capture(&files.handle()).await);
        files.close().await;
    }
    assert!(harness.status.deferred_writes().is_empty());
    let observer = rusqlite::Connection::open(&harness.db).unwrap();
    let texts: Vec<String> = observer.prepare(
        "SELECT after_blob_sha256 FROM moments WHERE workspace_id=?1 AND path=?2 ORDER BY moment_order"
    ).unwrap().query_map([WORKSPACE_ID, NOTE], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(
        texts,
        vec![
            dohc_engine_storage::hex_sha256(SEED.as_bytes()),
            dohc_engine_storage::hex_sha256(OUTSIDE.as_bytes())
        ]
    );
    assert_eq!(
        std::fs::read_to_string(harness.root.join(NOTE)).unwrap(),
        OUTSIDE
    );
    drop(observer);
    harness.close();
}

// A rename that changes only case reaches peers as a retire of the old
// spelling and an ingest of the new one, and a peer whose disk ignores case
// must receive them in that order: written first, `Notes.md` would be the
// file the later retire of `notes.md` deletes. While an editor holds
// `notes.md` open its retire waits, so the ingest of `Notes.md` waits with
// it. Skips where the disk keeps case apart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_respelled_file_waits_for_its_open_old_spelling_to_retire() {
    respelled_file_waits_for_its_lease(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quarantined_respell_is_ingested_once_after_the_old_spellings_lease_releases() {
    respelled_file_waits_for_its_lease(true).await;
}

async fn respelled_file_waits_for_its_lease(quarantine: bool) {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    std::fs::write(root.join("notes.md"), SEED).expect("write file");
    if !root.join("NOTES.md").exists() {
        eprintln!("SKIP: this disk keeps case apart");
        return;
    }
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let leases = LeaseRegistry::new();
    let files = FilesActor::spawn_async(root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let mut releases_seen = leases.release_generation(WORKSPACE_ID);
    let pass = || async {
        let run = reconcile_if_dirty_bound(&root, &files.handle(), CancellationToken::new())
            .await
            .expect("reconcile");
        apply_bound_run_with_handle(
            apply_context(&root, &actor, &leases, &status, &self_writes),
            &files.handle(),
            run,
            &CancellationToken::new(),
        )
        .await;
    };
    pass().await;
    assert_eq!(head_count(&db, "notes.md"), 1);

    let key = DocKey::new(
        WORKSPACE_ID,
        "main",
        derive_capture_object_id(WORKSPACE_ID, "main", "notes.md"),
    )
    .expect("old spelling key");
    let lease = leases.acquire(&key).expect("an editor holds notes.md");
    std::fs::rename(root.join("notes.md"), root.join("Notes.md")).expect("respell");
    files.handle().request_rescan();
    pass().await;
    if quarantine {
        for _ in 1..dohc_engine_files::DEGRADED_RESCAN_BACKOFF {
            pass().await;
        }
        let parked = files.handle().stats().await.expect("parked stats");
        assert!(!parked.dirty);
        assert_eq!((parked.deferred, parked.quarantined), (0, 2));
    }
    assert_eq!(
        head_count(&db, "notes.md"),
        1,
        "the open file is not retired"
    );
    assert_eq!(head_count(&db, "Notes.md"), 0, "the new spelling waits");

    drop(lease);
    offer_unrecorded_after_release(&leases, WORKSPACE_ID, &mut releases_seen, &files.handle())
        .await;
    assert!(files.handle().stats().await.expect("offered stats").dirty);
    pass().await;
    assert_eq!(head_count(&db, "notes.md"), 0);
    assert_eq!(head_count(&db, "Notes.md"), 1);
    let recovered = files.handle().stats().await.expect("recovered stats");
    assert_eq!((recovered.deferred, recovered.quarantined), (0, 0));
    files.handle().request_rescan();
    pass().await;
    let moments: Vec<(String, String)> = rusqlite::Connection::open(&db)
        .expect("open database observer")
        .prepare(
            "SELECT path, operation FROM moments WHERE workspace_id = ?1 ORDER BY moment_order",
        )
        .expect("prepare")
        .query_map([WORKSPACE_ID], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("moments")
        .collect::<Result<_, _>>()
        .expect("moments");
    let respelled: Vec<_> = moments
        .iter()
        .skip(1)
        .map(|(path, operation)| (path.as_str(), operation.as_str()))
        .collect();
    assert_eq!(
        respelled,
        [("notes.md", "delete"), ("Notes.md", "write")],
        "{moments:?}"
    );

    files.close().await;
    supervisor.close(&db).expect("close actor");
}

// A file a peer synced has a head capture does not own, so its absence never
// retires it. A respell is not an absence: the file is still there under the
// new spelling. Renamed only by case, the synced head retires at its old
// spelling and the new spelling is captured, so peers keep one file instead
// of two heads that share it. Skips where the disk keeps case apart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_respelled_synced_file_leaves_one_head() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    std::fs::write(root.join("notes.md"), SEED).expect("write file");
    if !root.join("NOTES.md").exists() {
        eprintln!("SKIP: this disk keeps case apart");
        return;
    }
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine database path");
    {
        let mut store = dohc_engine_storage::EngineStore::open(&db, 1).expect("open store");
        let mut versions = dohc_engine_domain::VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version(WORKSPACE_ID, "main", 1, &NoFaults)
            .expect("main version");
        versions
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: WORKSPACE_ID.into(),
                    version_id: "main".into(),
                    object_id: "synced".into(),
                    path: "notes.md".into(),
                    text: SEED.into(),
                    moment_id: "synced-write".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("synced head");
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let leases = LeaseRegistry::new();
    let files = FilesActor::spawn_async(root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let pass = || async {
        let run = reconcile_if_dirty_bound(&root, &files.handle(), CancellationToken::new())
            .await
            .expect("reconcile");
        apply_bound_run_with_handle(
            apply_context(&root, &actor, &leases, &status, &self_writes),
            &files.handle(),
            run,
            &CancellationToken::new(),
        )
        .await;
    };
    pass().await;
    assert_eq!(head_count(&db, "notes.md"), 1);

    std::fs::rename(root.join("notes.md"), root.join("Notes.md")).expect("respell");
    files.handle().request_rescan();
    pass().await;
    assert_eq!(head_count(&db, "notes.md"), 0, "the synced head retires");
    assert_eq!(head_count(&db, "Notes.md"), 1);
    let moments: Vec<(String, String)> = rusqlite::Connection::open(&db)
        .expect("open database observer")
        .prepare(
            "SELECT path, operation FROM moments WHERE workspace_id = ?1 ORDER BY moment_order",
        )
        .expect("prepare")
        .query_map([WORKSPACE_ID], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("moments")
        .collect::<Result<_, _>>()
        .expect("moments");
    let respelled: Vec<_> = moments
        .iter()
        .skip(1)
        .map(|(path, operation)| (path.as_str(), operation.as_str()))
        .collect();
    assert_eq!(
        respelled,
        [("notes.md", "delete"), ("Notes.md", "write")],
        "{moments:?}"
    );

    files.close().await;
    supervisor.close(&db).expect("close actor");
}

// A folder renamed only by case is not a proven respell, so its files keep
// their old handling: the old spellings stay tracked and peers receive no
// delete, even once an editor that held one of them lets go. A delete after
// the new spelling's write would remove the file at a peer whose disk
// ignores case. Skips where the disk keeps case apart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_respelled_folder_sends_no_delete_after_its_write() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    std::fs::create_dir(root.join("Drafts")).expect("folder");
    std::fs::write(root.join("Drafts/plan.md"), SEED).expect("write file");
    if !root.join("DRAFTS/plan.md").exists() {
        eprintln!("SKIP: this disk keeps case apart");
        return;
    }
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let leases = LeaseRegistry::new();
    let files = FilesActor::spawn_async(root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let mut releases_seen = leases.release_generation(WORKSPACE_ID);
    let pass = || async {
        let run = reconcile_if_dirty_bound(&root, &files.handle(), CancellationToken::new())
            .await
            .expect("reconcile");
        apply_bound_run_with_handle(
            apply_context(&root, &actor, &leases, &status, &self_writes),
            &files.handle(),
            run,
            &CancellationToken::new(),
        )
        .await;
    };
    pass().await;
    assert_eq!(head_count(&db, "Drafts/plan.md"), 1);

    let key = DocKey::new(
        WORKSPACE_ID,
        "main",
        derive_capture_object_id(WORKSPACE_ID, "main", "Drafts/plan.md"),
    )
    .expect("old spelling key");
    let lease = leases
        .acquire(&key)
        .expect("an editor holds Drafts/plan.md");
    std::fs::rename(root.join("Drafts"), root.join("drafts")).expect("respell folder");
    files.handle().request_rescan();
    pass().await;
    drop(lease);
    offer_unrecorded_after_release(&leases, WORKSPACE_ID, &mut releases_seen, &files.handle())
        .await;
    files.handle().request_rescan();
    pass().await;
    let deletes: Vec<String> = rusqlite::Connection::open(&db)
        .expect("open database observer")
        .prepare("SELECT path FROM moments WHERE workspace_id = ?1 AND operation = 'delete'")
        .expect("prepare")
        .query_map([WORKSPACE_ID], |row| row.get(0))
        .expect("moments")
        .collect::<Result<_, _>>()
        .expect("moments");
    assert_eq!(deletes, Vec::<String>::new());

    files.close().await;
    supervisor.close(&db).expect("close actor");
}
