use super::*;
use dohc_engine_collab::DocKey;
use dohc_engine_domain::derive_capture_object_id;
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

const WORKSPACE_ID: &str = "ws-live-session-deferral";
const NEW_FILE: &str = "notes/new.md";
const NOTE: &str = "notes/note.md";
const SEED: &str = "Before.\n";
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
        layer_rules: None,
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

// A file capture recorded is deleted outside dohc while its document is open.
// The session still holds the head and refuses every save over the missing
// file, so capture leaves the head alone. Capture is waiting, not failing, so
// it stays clean. The release alone brings the delete back.
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
        &harness.actor,
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

/// The status of the version switch's write job for `path`.
fn switch_write_status(db: &Path, path: &str) -> String {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT status FROM materialization_jobs \
             WHERE workspace_id = ?1 AND target_path = ?2 AND operation = 'write' \
             AND job_id GLOB 'version-switch-mat_*'",
            [WORKSPACE_ID, path],
            |row| row.get(0),
        )
        .expect("read the switch write job")
}

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restored_secret_key_retries_quarantined_capture_without_content_changes() {
    let harness = Harness::new();
    let secret = harness.root.join(".env");
    std::fs::write(&secret, "TOKEN=original").expect("secret artifact");
    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .expect("files actor"),
    );
    assert!(harness.capture(&files.handle()).await);
    // Capture keeps the key beside the store's database. In a workspace that is
    // `.dohc/engine` under the root; this harness keeps the store elsewhere.
    let key = harness.db.with_file_name("secret.key");
    let staged_key = key.with_file_name("restored-key.tmp");
    std::fs::rename(&key, &staged_key).expect("park original key outside its known location");
    std::fs::write(&secret, "TOKEN=changed").expect("external secret edit");
    files.handle().request_rescan();
    for _ in 0..3 {
        assert!(!harness.capture(&files.handle()).await);
    }
    let parked = files.handle().stats().await.expect("parked stats");
    assert_eq!(
        (parked.quarantined, parked.deferred, parked.dirty),
        (1, 0, false)
    );
    assert!(
        !key.exists(),
        "capture must not mint over encrypted history"
    );

    // Deliver only the restored key through the callback queue and debounce.
    // OS backends can also emit ancestor-directory events for the rename,
    // which would hide a dropped key event. No lease or content event fires.
    std::fs::rename(&staged_key, &key).expect("atomic key restore");
    dohc_engine_files::watch::notify_settled_change_for_harness(
        harness.root.clone(),
        harness
            .root
            .join(dohc_engine_crypto::SECRET_KEY_FILE_RELATIVE),
        &files.handle(),
    );
    let noticed = files.handle().stats().await.expect("callback stats").dirty;
    if !noticed {
        files.close().await;
        harness.close();
        panic!("key restore never reached callback/debounce rescan");
    }
    assert!(harness.capture(&files.handle()).await);
    let recovered = files.handle().stats().await.expect("recovered stats");
    assert_eq!(
        (recovered.quarantined, recovered.deferred, recovered.dirty),
        (0, 0, false)
    );
    let mut store = dohc_engine_storage::EngineStore::open(&harness.db, 1).expect("store observer");
    let loaded_key = dohc_engine_crypto::load_key_file(key.parent().expect("store folder"))
        .expect("load restored key")
        .expect("original key restored");
    let captured = dohc_engine_domain::SecretFileStore::new(&mut store, &loaded_key)
        .materialize_secret_file(WORKSPACE_ID, "main", ".env")
        .expect("decrypt captured secret")
        .expect("secret tip");
    assert_eq!(captured, "TOKEN=changed".into());
    assert_eq!(
        std::fs::read(&secret).expect("intact secret"),
        captured.as_bytes()
    );
    drop(store);
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

/// A driver over `root` with a started layer, its first run applied.
async fn started_env(
    root: &Path,
    actor: &ActorHandle,
    leases: &LeaseRegistry,
    carried: Option<Arc<CarriedPass>>,
) -> (RealEnv, FilesLayer) {
    use std::sync::atomic::AtomicU64;
    let events = EngineEvents::default();
    let (open_ready_tx, _) = tokio::sync::watch::channel(true);
    let status = Arc::new(DriverStatus::default());
    status.mark_initial_ready();
    let mut env = RealEnv {
        observation: crate::file_observation::FileObservation::new(
            events.clone(),
            WORKSPACE_ID.into(),
        ),
        root: root.to_path_buf(),
        initial_links_hold: None,
        actor: actor.clone(),
        lease_releases_seen: leases.release_generation(WORKSPACE_ID),
        workspace_id: WORKSPACE_ID.into(),
        leases: leases.clone(),
        status,
        author_json: Arc::new(Mutex::new(None)),
        self_writes: SelfWriteSuppression::default(),
        apply_gate: Arc::new(tokio::sync::Mutex::new(())),
        store_freshly_created: false,
        open_ready_tx,
        refresh_epoch: Arc::new(AtomicU64::new(0)),
        events,
        apply_probe: None,
        scan: ScanGauge::default(),
        import_priority: Arc::new(ImportPriority::new(|| {})),
        no_atomic_placement_announced: false,
        first_import: None,
        carried,
        rules: None,
        quarantine_retry_at: None,
    };
    let cancel = CancellationToken::new();
    env.observation
        .start(env.root.clone())
        .expect("observation");
    let (layer, initial) = FilesLayer::start_with_fingerprint(
        &env.root,
        &cancel,
        None,
        policy_fingerprint(&env.root),
        0,
        &env.scan,
        &env.observation,
    )
    .await
    .expect("layer");
    let applied = apply_run(env.apply_context(), &layer.files.handle(), initial, &cancel).await;
    after_pass(&mut env.carried, &mut env.rules, &applied);
    (env, layer)
}

/// Tick until the layer converges. A watcher event from the first scan may
/// cost one more clean pass first.
async fn tick_until_converged(env: &mut RealEnv, layer: &FilesLayer) {
    let cancel = CancellationToken::new();
    for _ in 0..10 {
        match env.tick(layer, &cancel).await {
            TickIo::Converged => return,
            TickIo::Applied { clean: true } => {}
            other => panic!("expected a clean tick, got {other:?}"),
        }
    }
    panic!("the layer never converged");
}

fn moment_label(db: &Path, path: &str) -> (Option<String>, Option<String>) {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT metadata_summary, metadata_correlation_id FROM moments \
             WHERE workspace_id = ?1 AND path = ?2 ORDER BY moment_order DESC LIMIT 1",
            [WORKSPACE_ID, path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the file's moment")
}

async fn close_env(env: RealEnv, layer: FilesLayer, supervisor: WorkspaceSupervisor, db: PathBuf) {
    layer.stop().await;
    drop(env);
    tokio::task::spawn_blocking(move || supervisor.close(&db))
        .await
        .expect("join")
        .expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_the_first_pass_under_changed_rules_left_keeps_its_label() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    std::fs::create_dir_all(root.join("notes")).expect("notes directory");
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
    let (mut env, layer) = started_env(&root, &actor, &leases, None).await;
    env.rules = Some(Arc::new(PolicyState::Unavailable));

    std::fs::write(root.join("notes/first.md"), b"text").expect("write file");
    std::fs::write(root.join(NEW_FILE), b"text").expect("write file");
    layer.files.handle().request_rescan();
    assert!(matches!(
        env.tick(&layer, &CancellationToken::new()).await,
        TickIo::Applied { .. }
    ));
    let (summary, group) = moment_label(&db, "notes/first.md");
    assert_eq!(summary.as_deref(), Some(RESCAN_SUMMARY));
    assert!(
        group
            .as_deref()
            .is_some_and(|group| group.starts_with("reconcile"))
    );
    assert_eq!(
        layer.files.handle().stats().await.expect("stats").deferred,
        1
    );

    tick_until_converged(&mut env, &layer).await;
    drop(lease);
    assert_eq!(
        env.tick(&layer, &CancellationToken::new()).await,
        TickIo::Applied { clean: true }
    );
    assert_eq!(
        moment_label(&db, NEW_FILE),
        (Some(RESCAN_SUMMARY.to_owned()), group),
        "the held file records with the rescan that found it"
    );
    assert!(env.carried.is_none(), "the release recorded the file");
    close_env(env, layer, supervisor, db).await;
}

/// The sha256 of `version`'s head at `path`.
fn head_sha256(db: &Path, version: &str, path: &str) -> String {
    rusqlite::Connection::open(db)
        .expect("open database observer")
        .query_row(
            "SELECT blob_sha256 FROM snapshots \
             WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
            [WORKSPACE_ID, version, path],
            |row| row.get(0),
        )
        .expect("read the head")
}

// A switch that fails before replacing a file leaves the previous version's
// bytes on disk, and capture refuses them for the active version. The refusal
// must still track those bytes, so a later edit arrives as a change that
// claims the active head instead of a new file capture skips.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_after_a_switch_write_waits_is_recorded() {
    const MAIN: &str = "Main's note.\n";
    const FEATURE: &str = "Feature's note.\n";
    const EDITED: &str = "Edited after the switch failed.\n";
    let harness = Harness::new();
    let actor = &harness.actor;
    actor
        .ensure_main_version(
            WORKSPACE_ID.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    let object_id = derive_capture_object_id(WORKSPACE_ID, "main", NOTE);
    let write = |version: &str, text: &str, moment: &str, now_ms| dohc_engine_domain::WriteText {
        workspace_id: WORKSPACE_ID.to_owned(),
        version_id: version.to_owned(),
        object_id: object_id.clone(),
        path: NOTE.to_owned(),
        text: text.to_owned(),
        moment_id: moment.to_owned(),
        metadata_origin: "ydoc".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    };
    actor
        .versioned_text_write(
            write("main", MAIN, "moment-main", 2),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main's note");
    actor
        .create_named_version(
            dohc_engine_domain::CreateNamedVersion {
                workspace_id: WORKSPACE_ID.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 3,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
    actor
        .versioned_text_write(
            write("feature", FEATURE, "moment-feature", 4),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature's note");
    std::fs::write(harness.root.join(NOTE), MAIN).expect("main's file");
    let faults = dohc_engine_testkit::ScriptedFaults::crash_at(
        dohc_engine_storage::FaultPoint::MaterializeAfterJobCommit,
    );
    actor
        .set_active_version(
            dohc_engine_runtime::ActiveVersionSwitch {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: "feature".to_owned(),
                root_dir: harness.root.clone(),
                self_writes: Arc::new(harness.self_writes.scoped(&harness.root)),
                now_ms: 5,
            },
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the switch fails before its write");
    assert!(faults.fired());
    assert_eq!(switch_write_status(&harness.db, NOTE), "pending");

    let files = FilesActorCloseGuard::new(
        FilesActor::spawn_async(harness.root.clone(), ScanBounds::default())
            .await
            .expect("files actor"),
    );
    assert!(harness.capture(&files.handle()).await, "the wait is clean");
    assert_eq!(
        head_sha256(&harness.db, "feature", NOTE),
        dohc_engine_storage::hex_sha256(FEATURE.as_bytes()),
        "main's bytes stay out of the feature version"
    );

    std::fs::write(harness.root.join(NOTE), EDITED).expect("edit");
    files.handle().request_rescan();
    assert!(harness.capture(&files.handle()).await);
    assert_eq!(
        head_sha256(&harness.db, "feature", NOTE),
        dohc_engine_storage::hex_sha256(EDITED.as_bytes()),
        "the edit is recorded"
    );

    files.close().await;
    harness.close();
}
