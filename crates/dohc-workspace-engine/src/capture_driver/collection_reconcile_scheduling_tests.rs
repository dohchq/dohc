use super::*;
use crate::capture_sink::bound_sink_params;
use dohc_engine_collab::{ContentKind, DocKey, Ydoc};
use dohc_engine_files::NativeWatcher;
use dohc_engine_files::{CaptureApplyResult, CaptureSink, CapturedIngest};
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

const WORKSPACE_ID: &str = "ws-idle-collection-reconcile";

fn plan_with(op: CaptureOp) -> ReconcilePlan {
    ReconcilePlan {
        from_generation: ScanGeneration(0),
        to_generation: ScanGeneration(1),
        ops: vec![op],
        retained_unread: Vec::new(),
        unconfirmed_removed: Vec::new(),
        respelled_retires: Default::default(),
        degraded: false,
        degraded_paths: Vec::new(),
        prepared_from_dirty: true,
        dirty_epoch: 1,
    }
}

fn ingest(path: &str, reason: IngestReason) -> CaptureOp {
    CaptureOp::Ingest {
        path: path.to_owned(),
        size: 1,
        sha256: "advisory-sha".to_owned(),
        mtime_ms: 0,
        media_type: "text/markdown",
        reason,
    }
}

async fn wait_for_watcher_dirty(files: &FilesHandle) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if files.stats().await.expect("watcher stats").dirty {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "native watcher did not mark the collection edit dirty"
        );
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }
}

/// Capture and adoption commits queue link indexing, which the actor drains
/// in the background. Wait for the drain to finish so a later write check
/// sees only the pass under test.
async fn wait_for_link_drain(observer: &rusqlite::Connection) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let drained: bool = observer
            .query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM link_pending) \
                   AND NOT EXISTS(SELECT 1 FROM link_gc) \
                   AND NOT EXISTS(SELECT 1 FROM link_index_state WHERE seed_phase <> 'ready')",
                [],
                |row| row.get(0),
            )
            .expect("link drain state");
        if drained {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the link drain did not finish after setup"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn seed_plain_richdoc_lineage(actor: &ActorHandle, path: &str, markdown: &str) {
    let state = actor
        .ydoc_open_state(
            WORKSPACE_ID.to_owned(),
            wall_now_ms(),
            false,
            None,
            "main".to_owned(),
            path.to_owned(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
        .expect("open absent rich-document lineage");
    assert!(
        !state.lineage_existing,
        "test fixture starts without lineage"
    );

    // These scheduling tests use a plain paragraph fixture. Production
    // adoption seeds through the desktop's shared Markdown importer.
    let doc = Ydoc::wire();
    doc.apply(&state.initial_update)
        .expect("apply initial rich-document state");
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
        .expect("seed plain rich-document fixture");
    actor
        .ydoc_record_update(
            state.key,
            path.to_owned(),
            ContentKind::Richdoc,
            state.regime,
            doc.encode_full_state(),
            None,
            None,
            state.lineage_claim_id,
            true,
            state.owner_seed_source,
            None,
            wall_now_ms(),
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record rich-document seed");
}

fn seed_collection_capture(actor: &ActorHandle, root: &Path, paths: &[&str]) {
    let seed_actor = actor.clone();
    let seed_root = root.to_path_buf();
    let paths = paths
        .iter()
        .map(|path| (*path).to_owned())
        .collect::<Vec<_>>();
    std::thread::spawn(move || {
        let mut sink = StoreCaptureSink::new(bound_sink_params(
            seed_actor,
            WORKSPACE_ID,
            "main",
            seed_root,
            2,
        ));
        for path in paths {
            sink.ingest(
                &path,
                0,
                "advisory-sha",
                "text/markdown",
                IngestReason::Added,
            )
            .unwrap_or_else(|_| panic!("capture {path}"));
        }
    })
    .join()
    .expect("collection seed thread");
}

fn collection_apply_context<'a>(
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

#[test]
fn collection_reconcile_predicate_tracks_only_detection_and_membership_changes() {
    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), b"name: Tasks\n")
        .expect("collection schema");

    assert!(collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("collection.yaml", IngestReason::Changed)),
    ));
    assert!(collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("tasks/collection.yaml", IngestReason::Changed)),
    ));
    assert!(collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("tasks/alpha.md", IngestReason::Added)),
    ));
    assert!(collection_reconcile_required(
        scratch.path(),
        &plan_with(CaptureOp::Retire {
            path: "tasks/alpha.md".to_owned(),
        }),
    ));
    assert!(!collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("tasks/alpha.md", IngestReason::Changed)),
    ));
    assert!(!collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("notes/alpha.md", IngestReason::Added)),
    ));
    assert!(!collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("root.md", IngestReason::Added)),
    ));
}

#[test]
fn collection_reconcile_predicate_matches_the_markdown_extension_case_insensitively() {
    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), b"name: Tasks\n")
        .expect("collection schema");

    // The watcher path: adding NOTE.MD to a live collection must schedule
    // the reconciliation that adopts it, exactly like note.md.
    assert!(collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("tasks/NOTE.MD", IngestReason::Added)),
    ));
    assert!(collection_reconcile_required(
        scratch.path(),
        &plan_with(CaptureOp::Retire {
            path: "tasks/NOTE.MD".to_owned(),
        }),
    ));
    assert!(!collection_reconcile_required(
        scratch.path(),
        &plan_with(ingest("notes/NOTE.MD", IngestReason::Added)),
    ));
}

#[test]
fn collection_reconcile_request_take_preserves_a_concurrent_request() {
    let status = DriverStatus::default();
    assert!(!status.collection_reconcile_pending());
    status.request_collection_reconcile();
    assert!(status.collection_reconcile_pending());
    assert!(status.take_collection_reconcile_request());
    assert!(!status.collection_reconcile_pending());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lease_blocked_collection_adoption_retries_after_release_without_a_file_change() {
    held_collection_idle_ticks(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lease_blocked_collection_with_pending_sibling_does_not_reconcile_on_idle_ticks() {
    held_collection_idle_ticks(true).await;
}

async fn held_collection_idle_ticks(pending_sibling: bool) {
    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), b"name: Tasks\n")
        .expect("collection schema");
    std::fs::write(collection_dir.join("alpha.md"), b"Alpha task\n").expect("collection record");

    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    seed_collection_capture(
        &actor,
        scratch.path(),
        &["tasks/collection.yaml", "tasks/alpha.md"],
    );

    let object_id = rusqlite::Connection::open(&db)
        .expect("open database observer")
        .query_row(
            "SELECT object_id FROM path_aliases \
             WHERE workspace_id = ?1 AND version_id = 'main' \
               AND path = 'tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| row.get::<_, String>(0),
        )
        .expect("captured record object id");
    seed_plain_richdoc_lineage(&actor, "tasks/alpha.md", "Alpha task\n").await;
    let leases = LeaseRegistry::new();
    let key = DocKey::new(WORKSPACE_ID, "main", &object_id).expect("record key");
    let lease = leases.acquire(&key).expect("hold record lease");

    let seed = manifest_seed(scratch.path(), &actor, WORKSPACE_ID, None)
        .await
        .unwrap()
        .into_scan_seed();
    let files = FilesActor::spawn_async_with_manifest(
        scratch.path().to_path_buf(),
        ScanBounds::default(),
        seed,
    )
    .await
    .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    status.request_collection_reconcile();
    let first_run =
        reconcile_if_dirty_bound(scratch.path(), &files.handle(), CancellationToken::new())
            .await
            .expect("capture recorded files while adoption is held");
    assert!(
        matches!(first_run.run, ReconcileRun::Completed(_)),
        "the first pass must exercise the completed-plan path"
    );
    let first_clean = apply_bound_run_with_handle(
        collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
        &files.handle(),
        first_run,
        &CancellationToken::new(),
    )
    .await
    .clean;
    assert!(
        first_clean,
        "recorded content with a deferred adoption is settled"
    );
    assert!(
        !status.degraded(),
        "waiting on a session is not degraded capture"
    );
    if pending_sibling {
        let sibling = collection_dir.join("beta.md");
        std::fs::write(&sibling, "Beta task\n").unwrap();
        seed_collection_capture(&actor, scratch.path(), &["tasks/beta.md"]);
        seed_plain_richdoc_lineage(&actor, "tasks/beta.md", "Beta task\n").await;
        // The captured seed and lineage agree, but disk changed before adoption.
        // This candidate takes its lease, then stays deferred on the stale target.
        std::fs::write(&sibling, "Uncaptured sibling change\n").unwrap();
        status.request_collection_reconcile();
        assert!(
            apply_bound_run_with_handle(
                collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
                &files.handle(),
                RootBoundRun {
                    captured_root: bind_capture_root(scratch.path()).unwrap(),
                    run: ReconcileRun::Converged
                },
                &CancellationToken::new(),
            )
            .await
            .clean
        );
        let state: String = rusqlite::Connection::open(&db)
            .unwrap()
            .query_row(
                "SELECT adoption_state FROM collection_records WHERE file_path='tasks/beta.md'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            state.starts_with("deferred-conflict"),
            "the sibling must remain pending: {state}"
        );
        assert!(
            !std::fs::read_to_string(&sibling)
                .unwrap()
                .contains("id: rec_")
        );
    }
    let observer = rusqlite::Connection::open(&db).expect("idle reconcile observer");
    wait_for_link_drain(&observer).await;
    let data_version = || {
        observer
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    let mut reconciles = 0;
    let mut unsettled = 0;
    for _ in 0..120 {
        let before = data_version();
        let clean = apply_bound_run_with_handle(
            collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
            &files.handle(),
            RootBoundRun {
                captured_root: bind_capture_root(scratch.path()).unwrap(),
                run: ReconcileRun::Converged,
            },
            &CancellationToken::new(),
        )
        .await
        .clean;
        unsettled += usize::from(!clean);
        reconciles += usize::from(data_version() != before);
    }
    println!("held lease: {reconciles} reconciles / 120 idle ticks (one minute at 2 Hz)");
    assert_eq!(
        reconciles, 0,
        "a held lease must not repeatedly reconcile without a release or explicit request"
    );
    assert_eq!(unsettled, 0, "idle ticks stay settled");
    assert!(!status.collection_reconcile_pending());
    if pending_sibling {
        drop(lease);
        files.close().await;
        supervisor.close(&db).expect("close actor");
        return;
    }
    status.request_collection_reconcile();
    let before = data_version();
    assert!(
        apply_bound_run_with_handle(
            collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
            &files.handle(),
            RootBoundRun {
                captured_root: bind_capture_root(scratch.path()).unwrap(),
                run: ReconcileRun::Converged
            },
            &CancellationToken::new(),
        )
        .await
        .clean
    );
    assert_ne!(
        data_version(),
        before,
        "an explicit request retries even with the same held lease"
    );
    drop(lease);
    let released_at = std::time::Instant::now();
    let second_run =
        reconcile_if_dirty_bound(scratch.path(), &files.handle(), CancellationToken::new())
            .await
            .expect("retry capture after release");
    let second_clean = apply_bound_run_with_handle(
        collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
        &files.handle(),
        second_run,
        &CancellationToken::new(),
    )
    .await
    .clean;
    println!("release-to-adoption: {:?}", released_at.elapsed());
    assert!(second_clean, "the scheduled retry adopts after release");
    assert!(!status.collection_reconcile_pending());
    assert!(
        std::fs::read_to_string(collection_dir.join("alpha.md"))
            .expect("read adopted record")
            .contains("id: rec_")
    );
    let adoption_state = rusqlite::Connection::open(&db)
        .expect("open adopted-state observer")
        .query_row(
            "SELECT adoption_state FROM collection_records \
             WHERE workspace_id = ?1 AND version_id = 'main' \
               AND file_path = 'tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| row.get::<_, String>(0),
        )
        .expect("adopted collection record");
    assert_eq!(adoption_state, "adopted");

    files.close().await;
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lease_blocked_collection_candidate_does_not_starve_other_adoptions() {
    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), b"name: Tasks\n")
        .expect("collection schema");
    std::fs::write(collection_dir.join("alpha.md"), b"Alpha task\n")
        .expect("first collection record");
    std::fs::write(collection_dir.join("beta.md"), b"Beta task\n")
        .expect("second collection record");

    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    seed_collection_capture(
        &actor,
        scratch.path(),
        &["tasks/collection.yaml", "tasks/alpha.md", "tasks/beta.md"],
    );

    let object_id = rusqlite::Connection::open(&db)
        .expect("open database observer")
        .query_row(
            "SELECT object_id FROM path_aliases \
             WHERE workspace_id = ?1 AND version_id = 'main' \
               AND path = 'tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| row.get::<_, String>(0),
        )
        .expect("first captured record object id");
    seed_plain_richdoc_lineage(&actor, "tasks/alpha.md", "Alpha task\n").await;
    seed_plain_richdoc_lineage(&actor, "tasks/beta.md", "Beta task\n").await;
    let leases = LeaseRegistry::new();
    let key = DocKey::new(WORKSPACE_ID, "main", &object_id).expect("first record key");
    let lease = leases.acquire(&key).expect("hold first record lease");

    let bindings: i64 = rusqlite::Connection::open(&db).unwrap().query_row(
        "SELECT COUNT(*) FROM collection_records WHERE workspace_id=?1 AND file_path='tasks/beta.md'", [WORKSPACE_ID], |row| row.get(0)).unwrap();
    assert_eq!(
        bindings, 0,
        "the sibling must bind and claim in this reconciliation"
    );
    {
        let mut store = dohc_engine_storage::EngineStore::open(&db, 3).unwrap();
        dohc_engine_domain::subscribe_automation(
            &mut store,
            WORKSPACE_ID,
            &dohc_engine_domain::AutomationSubscription {
                automation_id: "collection:tasks#watch".to_owned(),
                prefix: "tasks".to_owned(),
                kinds: vec![dohc_engine_domain::AutomationChangeKind::Added],
                fields: None,
            },
            1,
            &NoFaults,
        )
        .unwrap();
    }
    let events = EngineEvents::default();
    let mut notices = events.subscribe();
    let files = FilesActor::spawn_async(scratch.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    status.request_collection_reconcile();
    let first_root = bind_capture_root(scratch.path()).expect("bind first run root");
    let first_clean = apply_bound_run_with_handle(
        ApplyRunContext {
            events,
            ..collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes)
        },
        &files.handle(),
        RootBoundRun {
            captured_root: first_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await
    .clean;
    assert!(
        first_clean,
        "a deferred adoption does not fail a converged pass"
    );
    assert!(!status.degraded());

    assert_eq!(
        std::fs::read_to_string(collection_dir.join("alpha.md"))
            .expect("read lease-blocked record"),
        "Alpha task\n"
    );
    let beta_after_first =
        std::fs::read_to_string(collection_dir.join("beta.md")).expect("read second record");
    assert!(
        beta_after_first.contains("id: rec_"),
        "an unrelated candidate must adopt in the same pass"
    );
    let (alpha_state, beta_state) = rusqlite::Connection::open(&db)
        .expect("open first-pass state observer")
        .query_row(
            "SELECT \
                MAX(CASE WHEN file_path = 'tasks/alpha.md' THEN adoption_state END), \
                MAX(CASE WHEN file_path = 'tasks/beta.md' THEN adoption_state END) \
             FROM collection_records \
             WHERE workspace_id = ?1 AND version_id = 'main'",
            [WORKSPACE_ID],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("first-pass adoption states");
    assert_eq!(alpha_state, "pending-lossless");
    assert_eq!(beta_state, "adopted");

    let mut emitted = Vec::new();
    while let Ok(notice) = notices.try_recv() {
        emitted.push(notice);
    }
    let beta_record_id: String = rusqlite::Connection::open(&db).unwrap().query_row(
        "SELECT record_id FROM collection_records WHERE workspace_id=?1 AND file_path='tasks/beta.md'", [WORKSPACE_ID], |row| row.get(0)).unwrap();
    let claims: i64 = rusqlite::Connection::open(&db).unwrap().query_row(
        "SELECT COUNT(*) FROM automation_claims WHERE workspace_id=?1 AND record_id=?2 AND change_kind='added'", rusqlite::params![WORKSPACE_ID, beta_record_id], |row| row.get(0)).unwrap();
    assert_eq!(
        claims, 1,
        "the sibling lifecycle claim must already be committed"
    );
    let capture_emitted = emitted.iter().any(|notice| {
        notice.name == CAPTURE_MOMENT_RECORDED_EVENT
            && notice.payload["paths"]
                .as_array()
                .is_some_and(|paths| paths.iter().any(|path| path == "tasks/beta.md"))
    });
    let claim_emitted = emitted.iter().any(|notice| {
        notice.name == crate::events::AUTOMATION_CLAIMED_EVENT
            && notice.payload["recordId"] == beta_record_id
    });
    assert!(
        capture_emitted && claim_emitted,
        "committed sibling events: capture={capture_emitted}, automation={claim_emitted}: {emitted:?}"
    );

    drop(lease);
    let second_root = bind_capture_root(scratch.path()).expect("bind second run root");
    let second_clean = apply_bound_run_with_handle(
        collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
        &files.handle(),
        RootBoundRun {
            captured_root: second_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await
    .clean;
    assert!(second_clean, "the scheduled retry adopts after release");
    assert!(!status.collection_reconcile_pending());
    assert!(
        std::fs::read_to_string(collection_dir.join("alpha.md"))
            .expect("read adopted first record")
            .contains("id: rec_")
    );
    assert_eq!(
        std::fs::read_to_string(collection_dir.join("beta.md"))
            .expect("read adopted second record"),
        beta_after_first,
        "the retry must not rewrite the already-adopted candidate"
    );

    files.close().await;
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watcher_edit_stripping_adopted_record_id_reasserts_the_binding() {
    assert_changed_record_reconciles(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watcher_record_change_retries_deferred_adoption_with_matching_id() {
    assert_changed_record_reconciles(true).await;
}

async fn assert_changed_record_reconciles(deferred_same_id: bool) {
    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    let record_path = collection_dir.join("alpha.md");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");

    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let leases = LeaseRegistry::new();
    let self_writes = SelfWriteSuppression::default();
    std::fs::write(collection_dir.join("collection.yaml"), b"name: Tasks\n")
        .expect("collection schema");
    std::fs::write(&record_path, b"Alpha task").expect("collection record");
    let seed_actor = actor.clone();
    let seed_root = scratch.path().to_path_buf();
    let seed_leases = leases.clone();
    let seed_self_writes = self_writes.clone();
    std::thread::spawn(move || {
        let mut sink = StoreCaptureSink::new(StoreCaptureSinkParams {
            cancel: dohc_engine_files::CancellationToken::new(),
            leases: seed_leases,
            self_writes: seed_self_writes,
            ..bound_sink_params(seed_actor, WORKSPACE_ID, "main", seed_root, 2)
        });
        for path in ["tasks/collection.yaml", "tasks/alpha.md"] {
            sink.ingest(
                path,
                0,
                "advisory-sha",
                "text/markdown",
                IngestReason::Added,
            )
            .unwrap_or_else(|_| panic!("capture {path}"));
        }
        assert!(
            sink.reconcile_collections_observed(None)
                .expect("bind pending collection record")
                .changed_paths
                .is_empty()
        );
    })
    .join()
    .expect("collection capture setup thread");
    seed_plain_richdoc_lineage(&actor, "tasks/alpha.md", "Alpha task").await;
    let adopt_actor = actor.clone();
    let adopt_root = scratch.path().to_path_buf();
    let adopt_leases = leases.clone();
    let adopt_self_writes = self_writes.clone();
    std::thread::spawn(move || {
        assert_eq!(
            StoreCaptureSink::new(StoreCaptureSinkParams {
                cancel: dohc_engine_files::CancellationToken::new(),
                leases: adopt_leases,
                self_writes: adopt_self_writes,
                ..bound_sink_params(adopt_actor, WORKSPACE_ID, "main", adopt_root, 3)
            })
            .reconcile_collections_observed(None)
            .expect("adopt shared-imported record")
            .changed_paths,
            ["tasks/alpha.md"]
        );
    })
    .join()
    .expect("collection adoption setup thread");
    let record_id = rusqlite::Connection::open(&db)
        .expect("open binding observer")
        .query_row(
            "SELECT record_id FROM collection_records \
             WHERE workspace_id = ?1 AND version_id = 'main' \
               AND file_path = 'tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| row.get::<_, String>(0),
        )
        .expect("adopted record binding");
    let adopted = std::fs::read_to_string(&record_path).expect("read adopted record");
    assert!(adopted.contains(&format!("id: {record_id}")));

    let files = FilesActor::spawn_async(scratch.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let handle = files.handle();
    let ready = NativeWatcher::start(
        scratch.path().to_path_buf(),
        handle.clone(),
        CancellationToken::new(),
    )
    .await
    .expect("watcher start");
    let mut watcher = ready.watcher;
    let status = Arc::new(DriverStatus::default());

    let ReconcileRun::Completed(baseline_plan) = ready.initial_reconcile else {
        panic!("the watcher must prepare its adopted-file baseline");
    };
    assert!(!baseline_plan.degraded);
    let captured = baseline_plan
        .ops
        .iter()
        .filter_map(|op| match op {
            CaptureOp::Ingest {
                path, size, sha256, ..
            } => Some(CapturedIngest {
                path: path.clone(),
                size: *size,
                sha256: sha256.clone(),
            }),
            CaptureOp::Retire { .. } => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(captured.len(), baseline_plan.ops.len());
    handle
        .acknowledge_capture(
            baseline_plan.clone(),
            CaptureApplyResult {
                applied_paths: baseline_plan
                    .ops
                    .iter()
                    .map(|op| op.path().to_owned())
                    .collect(),
                captured,
                not_owned_paths: Vec::new(),
                failed_applies: Vec::new(),
                deferred_paths: Vec::new(),
                deferred_retires: Vec::new(),
                deferred_writes: Vec::new(),
                held_observations: Vec::new(),
                crashed_after_durable_boundary: None,
                degraded: false,
            },
        )
        .await
        .expect("acknowledge the already-captured adopted-file baseline");

    let expected = if deferred_same_id {
        rusqlite::Connection::open(&db).unwrap().execute(
            "UPDATE collection_records SET adoption_state='deferred-conflict' WHERE file_path='tasks/alpha.md'", []).unwrap();
        let changed = adopted.replace("Alpha task", "Changed task");
        std::fs::write(&record_path, &changed).unwrap();
        changed
    } else {
        std::fs::write(&record_path, b"Alpha task").expect("strip adopted record id");
        adopted
    };
    wait_for_watcher_dirty(&handle).await;
    let changed_root = bind_capture_root(scratch.path()).expect("bind changed run root");
    let changed = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("reconcile stripped id");
    let ReconcileRun::Completed(changed_plan) = changed else {
        panic!("the watcher edit must produce a completed capture plan");
    };
    assert!(
        changed_plan.ops.iter().any(|op| matches!(
            op,
            CaptureOp::Ingest {
                path,
                reason: IngestReason::Changed,
                ..
            } if path == "tasks/alpha.md"
        )),
        "stripping the id must travel through the ordinary Changed path"
    );
    assert!(
        apply_bound_run_with_handle(
            ApplyRunContext {
                root: scratch.path(),
                actor: &actor,
                workspace_id: WORKSPACE_ID,
                leases: &leases,
                status: &status,
                self_writes: &self_writes,
                author_json: None,
                provenance: CaptureProvenance::default(),
                events: EngineEvents::default(),
                apply_probe: None,
                import_priority: None,
            },
            &handle,
            RootBoundRun {
                captured_root: changed_root,
                run: ReconcileRun::Completed(changed_plan),
            },
            &CancellationToken::new(),
        )
        .await
        .clean,
        "the changed record capture settles cleanly"
    );
    let restored = std::fs::read_to_string(&record_path).expect("read restored record");
    let state: String = rusqlite::Connection::open(&db)
        .unwrap()
        .query_row(
            "SELECT adoption_state FROM collection_records WHERE file_path='tasks/alpha.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        state, "adopted",
        "a Changed record must finish its deferred adoption"
    );

    watcher.stop().expect("stop watcher");
    files.close().await;
    supervisor.close(&db).expect("close actor");

    assert_eq!(
        restored, expected,
        "the established binding must reassert its id after an ordinary edit strips it"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watcher_repairing_malformed_collection_record_adopts_and_indexes_it() {
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const MALFORMED: &str = concat!(
        "---\n",
        "id: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "title: [\n",
        "---\n",
        "\n",
        "Body\n",
    );
    const REPAIRED: &str = concat!(
        "---\n",
        "id: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        "title: Repaired\n",
        "---\n",
        "\n",
        "Body\n",
    );

    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    let record_path = collection_dir.join("alpha.md");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(
        collection_dir.join("collection.yaml"),
        b"fields:\n  title:\n    type: text\n",
    )
    .expect("collection schema");
    std::fs::write(&record_path, MALFORMED).expect("malformed collection record");

    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let leases = LeaseRegistry::new();
    let self_writes = SelfWriteSuppression::default();
    let seed_actor = actor.clone();
    let seed_root = scratch.path().to_path_buf();
    std::thread::spawn(move || {
        let mut sink = StoreCaptureSink::new(bound_sink_params(
            seed_actor,
            WORKSPACE_ID,
            "main",
            seed_root,
            2,
        ));
        for path in ["tasks/collection.yaml", "tasks/alpha.md"] {
            sink.ingest(
                path,
                0,
                "advisory-sha",
                "text/markdown",
                IngestReason::Added,
            )
            .unwrap_or_else(|_| panic!("capture {path}"));
        }
        assert!(
            sink.reconcile_collections_observed(None)
                .expect("exclude malformed collection record")
                .changed_paths
                .is_empty()
        );
    })
    .join()
    .expect("malformed collection capture setup thread");
    let binding_count = rusqlite::Connection::open(&db)
        .expect("open binding observer")
        .query_row(
            "SELECT COUNT(*) FROM collection_records \
             WHERE workspace_id = ?1 AND version_id = 'main' \
               AND file_path = 'tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| row.get::<_, i64>(0),
        )
        .expect("count malformed record bindings");
    assert_eq!(binding_count, 0, "malformed Markdown starts unbound");

    let files = FilesActor::spawn_async(scratch.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let handle = files.handle();
    let ready = NativeWatcher::start(
        scratch.path().to_path_buf(),
        handle.clone(),
        CancellationToken::new(),
    )
    .await
    .expect("watcher start");
    let mut watcher = ready.watcher;
    let status = Arc::new(DriverStatus::default());

    let ReconcileRun::Completed(baseline_plan) = ready.initial_reconcile else {
        panic!("the watcher must prepare its malformed-file baseline");
    };
    assert!(!baseline_plan.degraded);
    let captured = baseline_plan
        .ops
        .iter()
        .filter_map(|op| match op {
            CaptureOp::Ingest {
                path, size, sha256, ..
            } => Some(CapturedIngest {
                path: path.clone(),
                size: *size,
                sha256: sha256.clone(),
            }),
            CaptureOp::Retire { .. } => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(captured.len(), baseline_plan.ops.len());
    handle
        .acknowledge_capture(
            baseline_plan.clone(),
            CaptureApplyResult {
                applied_paths: baseline_plan
                    .ops
                    .iter()
                    .map(|op| op.path().to_owned())
                    .collect(),
                captured,
                not_owned_paths: Vec::new(),
                failed_applies: Vec::new(),
                deferred_paths: Vec::new(),
                deferred_retires: Vec::new(),
                deferred_writes: Vec::new(),
                held_observations: Vec::new(),
                crashed_after_durable_boundary: None,
                degraded: false,
            },
        )
        .await
        .expect("acknowledge the already-captured malformed-file baseline");

    std::fs::write(&record_path, REPAIRED).expect("repair collection record frontmatter");
    wait_for_watcher_dirty(&handle).await;
    let changed_root = bind_capture_root(scratch.path()).expect("bind changed run root");
    let changed = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("reconcile repaired frontmatter");
    let ReconcileRun::Completed(changed_plan) = changed else {
        panic!("the watcher repair must produce a completed capture plan");
    };
    assert!(
        changed_plan.ops.iter().any(|op| matches!(
            op,
            CaptureOp::Ingest {
                path,
                reason: IngestReason::Changed,
                ..
            } if path == "tasks/alpha.md"
        )),
        "repairing malformed frontmatter must travel through the Changed path"
    );
    assert!(
        apply_bound_run_with_handle(
            ApplyRunContext {
                root: scratch.path(),
                actor: &actor,
                workspace_id: WORKSPACE_ID,
                leases: &leases,
                status: &status,
                self_writes: &self_writes,
                author_json: None,
                provenance: CaptureProvenance::default(),
                events: EngineEvents::default(),
                apply_probe: None,
                import_priority: None,
            },
            &handle,
            RootBoundRun {
                captured_root: changed_root,
                run: ReconcileRun::Completed(changed_plan),
            },
            &CancellationToken::new(),
        )
        .await
        .clean,
        "the repaired collection record capture settles cleanly"
    );
    let pending = rusqlite::Connection::open(&db)
        .expect("open pending record observer")
        .query_row(
            "SELECT record_id,adoption_state,index_initialized FROM collection_records \
             WHERE workspace_id=?1 AND version_id='main' \
               AND file_path='tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .expect("load repaired pending record");
    assert_eq!(
        pending,
        (RECORD_ID.to_owned(), "pending".to_owned(), true),
        "the Changed watcher pass must bind and index the repaired record"
    );

    // The desktop imports pending collection records into canonical
    // rich-document lineage, then asks capture to reconcile again.
    seed_plain_richdoc_lineage(&actor, "tasks/alpha.md", REPAIRED).await;
    status.request_collection_reconcile();
    let converged_root = bind_capture_root(scratch.path()).expect("bind converged run root");
    assert!(
        apply_bound_run_with_handle(
            ApplyRunContext {
                root: scratch.path(),
                actor: &actor,
                workspace_id: WORKSPACE_ID,
                leases: &leases,
                status: &status,
                self_writes: &self_writes,
                author_json: None,
                provenance: CaptureProvenance::default(),
                events: EngineEvents::default(),
                apply_probe: None,
                import_priority: None,
            },
            &handle,
            RootBoundRun {
                captured_root: converged_root,
                run: ReconcileRun::Converged,
            },
            &CancellationToken::new(),
        )
        .await
        .clean,
        "the imported repaired record adopts cleanly"
    );
    let indexed = rusqlite::Connection::open(&db)
        .expect("open indexed record observer")
        .query_row(
            "SELECT r.record_id,r.adoption_state,r.index_initialized,f.value_json \
             FROM collection_records r \
             JOIN collection_record_fields f ON f.workspace_id=r.workspace_id \
               AND f.version_id=r.version_id AND f.record_id=r.record_id \
             WHERE r.workspace_id=?1 AND r.version_id='main' \
               AND r.file_path='tasks/alpha.md' AND f.field_name='title'",
            [WORKSPACE_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .expect("load adopted indexed record");

    watcher.stop().expect("stop watcher");
    files.close().await;
    supervisor.close(&db).expect("close actor");

    assert_eq!(
        indexed,
        (
            RECORD_ID.to_owned(),
            "adopted".to_owned(),
            true,
            "\"Repaired\"".to_owned(),
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_converged_watcher_scan_does_not_rewrite_collection_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(collection_dir.join("collection.yaml"), b"name: Tasks\n")
        .expect("collection schema");
    std::fs::write(collection_dir.join("alpha.md"), b"Alpha task\n").expect("collection record");

    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let seed_actor = actor.clone();
    let seed_root = scratch.path().to_path_buf();
    std::thread::spawn(move || {
        let mut sink = StoreCaptureSink::new(bound_sink_params(
            seed_actor,
            WORKSPACE_ID,
            "main",
            seed_root,
            2,
        ));
        for path in ["tasks/collection.yaml", "tasks/alpha.md"] {
            sink.ingest(
                path,
                0,
                "advisory-sha",
                "text/markdown",
                IngestReason::Added,
            )
            .unwrap_or_else(|_| panic!("capture {path}"));
        }
        sink.reconcile_collections_observed(None)
            .expect("bind pending record");
    })
    .join()
    .expect("collection seed thread");
    seed_plain_richdoc_lineage(&actor, "tasks/alpha.md", "Alpha task\n").await;
    let adopt_actor = actor.clone();
    let adopt_root = scratch.path().to_path_buf();
    std::thread::spawn(move || {
        StoreCaptureSink::new(bound_sink_params(
            adopt_actor,
            WORKSPACE_ID,
            "main",
            adopt_root,
            3,
        ))
        .reconcile_collections_observed(None)
        .expect("adopt seeded record");
    })
    .join()
    .expect("collection adoption thread");

    let observer = rusqlite::Connection::open(&db).expect("open database observer");
    let adoption_state = observer
        .query_row(
            "SELECT adoption_state FROM collection_records \
             WHERE workspace_id = ?1 AND version_id = 'main' \
               AND file_path = 'tasks/alpha.md'",
            [WORKSPACE_ID],
            |row| row.get::<_, String>(0),
        )
        .expect("collection adoption state");
    assert_eq!(adoption_state, "adopted");
    let data_version = |connection: &rusqlite::Connection| {
        connection
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .expect("database version")
    };
    wait_for_link_drain(&observer).await;
    let before = data_version(&observer);

    let files = FilesActor::spawn_async(scratch.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let leases = LeaseRegistry::new();
    let captured_root = bind_capture_root(scratch.path()).expect("bind converged run root");
    let clean = apply_bound_run_with_handle(
        ApplyRunContext {
            root: scratch.path(),
            actor: &actor,
            workspace_id: WORKSPACE_ID,
            leases: &leases,
            status: &status,
            self_writes: &self_writes,
            author_json: None,
            provenance: CaptureProvenance::default(),
            events: EngineEvents::default(),
            apply_probe: None,
            import_priority: None,
        },
        &files.handle(),
        RootBoundRun {
            captured_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await
    .clean;
    assert!(clean, "an idle converged pass stays healthy");
    assert_eq!(
        data_version(&observer),
        before,
        "an idle converged pass must not schedule collection writes"
    );

    files.close().await;
    supervisor.close(&db).expect("close actor");
}

// The collection reconcile commits its adoptions before the recovery
// repair runs. An unrelated repair failure in the same converged tick must
// not drop the committed paths from the capture event, or the renderer
// stays stale on state the engine already holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_recovery_repair_still_announces_committed_adoptions() {
    let scratch = ScratchDir::new().expect("scratch");
    let collection_dir = scratch.path().join("tasks");
    std::fs::create_dir_all(&collection_dir).expect("collection directory");
    std::fs::write(
        collection_dir.join("collection.yaml"),
        b"name: Tasks
",
    )
    .expect("collection schema");
    std::fs::write(
        collection_dir.join("alpha.md"),
        b"Alpha task
",
    )
    .expect("collection record");

    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    seed_collection_capture(
        &actor,
        scratch.path(),
        &["tasks/collection.yaml", "tasks/alpha.md"],
    );
    seed_plain_richdoc_lineage(
        &actor,
        "tasks/alpha.md",
        "Alpha task
",
    )
    .await;

    // An unrelated conflicted recovery whose decision carries an object id
    // no DocKey accepts (a control byte): the repair pass fails after the
    // collection reconcile above has committed its adoption.
    let sha = "a".repeat(64);
    rusqlite::Connection::open(&db)
        .expect("open database seeder")
        .execute_batch(&format!(
            "INSERT INTO binary_blobs (sha256,byte_length,bytes)                  VALUES ('{sha}',1,X'00');
             INSERT INTO ydoc_recovery_decisions (                      workspace_id,origin_id,origin_seq,version_id,object_id,original_path,                      incoming_content_kind,incoming_update_blob_sha256,                      incoming_lineage_claim_id,incoming_is_base_state,losing_claim_id,                      recovered_path,recovery_collision_ordinal,recovery_object_id,                      recovery_moment_id,recorded_at_ms                  ) VALUES (                      '{WORKSPACE_ID}','origin-broken',0,'main','bad'||char(10)||'object',                      'doc.md','plaintext','{sha}','{sha}',1,'{sha}',                      'doc.recovered.md','0','recovery-object','recovery-moment',1                  );
             INSERT INTO materialization_jobs                      (job_id,target_path,content_sha256,preimage_present,                       target_generation,status,created_at_ms)                  VALUES ('sync-mat_recovery-moment','doc.recovered.md','{sha}',0,1,'conflict',1);"
        ))
        .expect("seed broken recovery decision");

    let files = FilesActor::spawn_async(scratch.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let leases = LeaseRegistry::new();
    status.request_collection_reconcile();
    let events = EngineEvents::default();
    let mut notices = events.subscribe();
    let captured_root = bind_capture_root(scratch.path()).expect("bind run root");
    let clean = apply_bound_run_with_handle(
        ApplyRunContext {
            root: scratch.path(),
            actor: &actor,
            workspace_id: WORKSPACE_ID,
            leases: &leases,
            status: &status,
            self_writes: &self_writes,
            author_json: None,
            provenance: CaptureProvenance::default(),
            events,
            apply_probe: None,
            import_priority: None,
        },
        &files.handle(),
        RootBoundRun {
            captured_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await
    .clean;
    assert!(!clean, "the failed repair keeps the tick degraded");
    assert!(
        std::fs::read_to_string(collection_dir.join("alpha.md"))
            .expect("read adopted record")
            .contains("id: rec_"),
        "the adoption committed before the repair failed"
    );
    let notice = notices
        .try_recv()
        .expect("the committed adoption paths reach the renderer despite the failed repair");
    assert_eq!(notice.name, CAPTURE_MOMENT_RECORDED_EVENT);
    assert_eq!(notice.payload["workspaceId"], WORKSPACE_ID);
    assert!(
        notice.payload["paths"]
            .as_array()
            .is_some_and(|paths| paths.iter().any(|path| path == "tasks/alpha.md")),
        "the event carries the adopted path: {:?}",
        notice.payload
    );

    files.close().await;
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn write_gate_refused_collection_reconcile_waits_for_backfill_and_flushes_cleanly() {
    refused_collection_flush(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn persistent_collection_refusal_answers_degraded_and_releases_apply_gate() {
    refused_collection_flush(true).await;
}

async fn refused_collection_flush(persistent: bool) {
    let scratch = ScratchDir::new().unwrap();
    let root = scratch.path();
    let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    // Bind an ordinary captured file so startup has a workspace and version.
    std::fs::write(root.join("note.md"), "note\n").unwrap();
    seed_collection_capture(&actor, root, &["note.md"]);
    let events = EngineEvents::default();
    let observation =
        crate::file_observation::FileObservation::new(events.clone(), WORKSPACE_ID.into());
    observation.start(root.to_path_buf()).unwrap();
    let probe = CaptureApplyProbe::default();
    let apply_gate: ApplyGate = Arc::new(tokio::sync::Mutex::new(()));
    let driver = CaptureDriver::spawn(CaptureDriverSpawnParams {
        observation: Arc::clone(&observation),
        root: root.to_path_buf(),
        actor: actor.clone(),
        workspace_id: WORKSPACE_ID.into(),
        leases: LeaseRegistry::new(),
        self_writes: SelfWriteSuppression::default(),
        apply_gate: Arc::clone(&apply_gate),
        store_freshly_created: false,
        initial_author_json: None,
        events,
        apply_probe: Some(probe.clone()),
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        driver.wait_for_open_ready(),
    )
    .await
    .unwrap();
    assert!(!driver.status().degraded());
    let writer = rusqlite::Connection::open(&db).unwrap();
    writer
        .execute_batch("PRAGMA wal_autocheckpoint=0; CREATE TABLE refused_capture_load(body BLOB)")
        .unwrap();
    let reader = rusqlite::Connection::open(&db).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM refused_capture_load")
        .unwrap();
    writer
        .execute(
            "INSERT INTO refused_capture_load VALUES (?1)",
            [vec![42_u8; 28 * 1024 * 1024]],
        )
        .unwrap();
    let frames: i64 = writer
        .query_row("PRAGMA wal_checkpoint(NOOP)", [], |r| r.get(1))
        .unwrap();
    assert!(frames > 6000);
    driver.status().request_collection_reconcile();
    let (reply, outcome) = tokio::sync::oneshot::channel();
    driver.flush_sender().send(reply).await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        probe.reconcile_refused.notified(),
    )
    .await
    .expect("driver must encounter the write gate");
    assert!(
        !driver.status().degraded(),
        "brief busy capture must not fail an import"
    );
    if persistent {
        // Queue behind the refused tick, before its retry budget expires.
        let gate = tokio::time::timeout(std::time::Duration::from_secs(60), apply_gate.lock())
            .await
            .expect("the bounded retry must release the apply gate");
        drop(gate);
        let flushed = tokio::time::timeout(std::time::Duration::from_secs(60), outcome)
            .await
            .expect("persistent failure must answer the flush")
            .unwrap();
        assert!(!flushed.settled && flushed.degraded, "{flushed:?}");
        assert!(driver.status().collection_reconcile_pending());
        // Keep the reader pinned through shutdown: it never clears the refusal.
        let stopped = driver.begin_shutdown().unwrap();
        stopped.await.unwrap();
        if let Some(shutdown) = observation.begin_shutdown() {
            shutdown.await.unwrap();
        }
        drop(reader);
        drop(writer);
        drop(actor);
        supervisor.close(&db).unwrap();
        return;
    }
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    drop(writer);
    let flushed = tokio::time::timeout(std::time::Duration::from_secs(60), outcome)
        .await
        .unwrap()
        .unwrap();
    assert!(
        flushed.settled && flushed.running && !flushed.degraded,
        "{flushed:?}"
    );
    driver.begin_shutdown().unwrap().await.unwrap();
    if let Some(shutdown) = observation.begin_shutdown() {
        shutdown.await.unwrap();
    }
    drop(actor);
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn committed_adoption_and_claims_are_announced_before_a_sibling_busy_retry() {
    let scratch = ScratchDir::new().unwrap();
    let root = scratch.path();
    std::fs::create_dir(root.join("tasks")).unwrap();
    std::fs::write(root.join("tasks/collection.yaml"), "name: Tasks\n").unwrap();
    std::fs::write(root.join("tasks/alpha.md"), "Alpha\n").unwrap();
    std::fs::write(root.join("tasks/beta.md"), "Beta\n").unwrap();
    let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    seed_collection_capture(
        &actor,
        root,
        &["tasks/collection.yaml", "tasks/alpha.md", "tasks/beta.md"],
    );
    seed_plain_richdoc_lineage(&actor, "tasks/alpha.md", "Alpha\n").await;
    seed_plain_richdoc_lineage(&actor, "tasks/beta.md", "Beta\n").await;
    actor
        .automation_subscribe(
            WORKSPACE_ID.into(),
            dohc_engine_domain::AutomationSubscription {
                automation_id: "collection:tasks#watch".into(),
                prefix: "tasks".into(),
                kinds: vec![dohc_engine_domain::AutomationChangeKind::Added],
                fields: None,
            },
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let pinned = Arc::new(Mutex::new(
        None::<(rusqlite::Connection, rusqlite::Connection)>,
    ));
    let once = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let listener_db = db.clone();
    let listener_pin = Arc::clone(&pinned);
    let probe = CaptureApplyProbe {
        collection_committed: Some(Arc::new(move |step| {
            if step.changed_paths.is_empty() || once.swap(true, Ordering::AcqRel) {
                return;
            }
            assert_eq!(step.changed_paths, ["tasks/alpha.md"]);
            let writer = rusqlite::Connection::open(&listener_db).unwrap();
            writer
                .execute_batch(
                    "PRAGMA wal_autocheckpoint=0; CREATE TABLE partial_reconcile_load(body BLOB)",
                )
                .unwrap();
            let reader = rusqlite::Connection::open(&listener_db).unwrap();
            reader
                .execute_batch("BEGIN; SELECT * FROM partial_reconcile_load")
                .unwrap();
            writer
                .execute(
                    "INSERT INTO partial_reconcile_load VALUES (?1)",
                    [vec![42_u8; 28 * 1024 * 1024]],
                )
                .unwrap();
            let frames: i64 = writer
                .query_row("PRAGMA wal_checkpoint(NOOP)", [], |r| r.get(1))
                .unwrap();
            assert!(frames > 6000);
            *listener_pin.lock().unwrap() = Some((reader, writer));
        })),
        ..Default::default()
    };
    let events = EngineEvents::default();
    let mut notices = events.subscribe();
    let observation =
        crate::file_observation::FileObservation::new(events.clone(), WORKSPACE_ID.into());
    observation.start(root.to_path_buf()).unwrap();
    let driver = CaptureDriver::spawn(CaptureDriverSpawnParams {
        observation: Arc::clone(&observation),
        root: root.to_path_buf(),
        actor: actor.clone(),
        workspace_id: WORKSPACE_ID.into(),
        leases: LeaseRegistry::new(),
        self_writes: SelfWriteSuppression::default(),
        apply_gate: Arc::new(tokio::sync::Mutex::new(())),
        store_freshly_created: false,
        initial_author_json: None,
        events,
        apply_probe: Some(probe.clone()),
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        probe.reconcile_refused.notified(),
    )
    .await
    .expect("B must be refused after A commits");
    assert!(
        std::fs::read_to_string(root.join("tasks/alpha.md"))
            .unwrap()
            .contains("id: rec_")
    );
    assert!(
        !std::fs::read_to_string(root.join("tasks/beta.md"))
            .unwrap()
            .contains("id: rec_")
    );
    let mut recorded = Vec::new();
    let mut moments = Vec::new();
    let mut claims = Vec::new();
    let drain_notices =
        |notices: &mut tokio::sync::mpsc::Receiver<crate::events::EngineEventNotice>,
         recorded: &mut Vec<String>,
         moments: &mut Vec<serde_json::Value>,
         claims: &mut Vec<serde_json::Value>| {
            while let Ok(notice) = notices.try_recv() {
                if notice.name == CAPTURE_MOMENT_RECORDED_EVENT {
                    recorded.extend(
                        notice.payload["paths"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|p| p.as_str().unwrap().to_owned()),
                    );
                    moments.push(notice.payload);
                } else if notice.name == crate::AUTOMATION_CLAIMED_EVENT {
                    claims.push(notice.payload);
                }
            }
        };
    drain_notices(&mut notices, &mut recorded, &mut moments, &mut claims);
    assert_eq!(
        recorded,
        ["tasks/alpha.md"],
        "A reaches the renderer before B can complete"
    );
    assert_eq!(moments.len(), 1, "the refused pass emits one event");
    assert_eq!(moments[0]["appliedCount"], 1);
    assert_eq!(
        claims.len(),
        2,
        "both committed lifecycle claims must already be announced"
    );
    let (reader, writer) = pinned.lock().unwrap().take().unwrap();
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    drop(writer);
    // Capture can report the adoption self-writes again as repaint notifications.
    // Wait for B's announcement instead of counting those later capture passes.
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let notice = notices
                .recv()
                .await
                .expect("capture event stream stays open");
            if notice.name == crate::AUTOMATION_CLAIMED_EVENT {
                claims.push(notice.payload);
            } else if notice.name == CAPTURE_MOMENT_RECORDED_EVENT
                && notice.payload["paths"]
                    .as_array()
                    .is_some_and(|paths| paths.iter().any(|path| path == "tasks/beta.md"))
            {
                assert_eq!(
                    notice.payload["paths"],
                    serde_json::json!(["tasks/beta.md"]),
                    "the retry announces only B; a capture repaint is not its announcement"
                );
                break;
            }
        }
        driver.wait_for_open_ready().await;
    })
    .await
    .expect("B's retry must announce its adoption and finish startup");
    let (reply, outcome) = tokio::sync::oneshot::channel();
    driver.flush_sender().send(reply).await.unwrap();
    let flushed = tokio::time::timeout(std::time::Duration::from_secs(60), outcome)
        .await
        .unwrap()
        .unwrap();
    assert!(flushed.settled && !flushed.degraded, "{flushed:?}");
    drain_notices(&mut notices, &mut recorded, &mut moments, &mut claims);
    assert_eq!(claims.len(), 2, "retry must not announce claims twice");
    assert!(
        std::fs::read_to_string(root.join("tasks/beta.md"))
            .unwrap()
            .contains("id: rec_")
    );
    driver.begin_shutdown().unwrap().await.unwrap();
    if let Some(shutdown) = observation.begin_shutdown() {
        shutdown.await.unwrap();
    }
    drop(actor);
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_collection_pass_announces_many_adoptions_in_one_event() {
    let scratch = ScratchDir::new().unwrap();
    let root = scratch.path();
    std::fs::create_dir(root.join("tasks")).unwrap();
    std::fs::write(root.join("tasks/collection.yaml"), "name: Tasks\n").unwrap();
    // Below the wire excerpt limit: check every adopted path, not just the count.
    let paths = (0..20)
        .map(|i| format!("tasks/record-{i:02}.md"))
        .collect::<Vec<_>>();
    for path in &paths {
        std::fs::write(root.join(path), "Task\n").unwrap();
    }
    let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let mut captured = vec!["tasks/collection.yaml"];
    captured.extend(paths.iter().map(String::as_str));
    seed_collection_capture(&actor, root, &captured);
    for path in &paths {
        seed_plain_richdoc_lineage(&actor, path, "Task\n").await;
    }
    let events = EngineEvents::default();
    let mut notices = events.subscribe();
    let files = FilesActor::spawn_async(root.to_path_buf(), ScanBounds::default())
        .await
        .unwrap();
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let leases = LeaseRegistry::new();
    let self_writes = SelfWriteSuppression::default();
    status.request_collection_reconcile();
    let outcome = apply_bound_run_with_handle(
        ApplyRunContext {
            events,
            ..collection_apply_context(root, &actor, &leases, &status, &self_writes)
        },
        &files.handle(),
        RootBoundRun {
            captured_root: bind_capture_root(root).unwrap(),
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await;
    assert!(outcome.clean);
    let notice = notices
        .try_recv()
        .expect("one batched adoption announcement");
    assert_eq!(notice.name, CAPTURE_MOMENT_RECORDED_EVENT);
    assert_eq!(notice.payload["appliedCount"], paths.len());
    let mut announced = notice.payload["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    announced.sort();
    assert_eq!(announced, paths);
    assert!(
        notices.try_recv().is_err(),
        "a pass emits only one moment event"
    );
    for path in &paths {
        assert!(
            std::fs::read_to_string(root.join(path))
                .unwrap()
                .contains("id: rec_")
        );
    }
    files.close().await;
    drop(actor);
    supervisor.close(&db).unwrap();
}
