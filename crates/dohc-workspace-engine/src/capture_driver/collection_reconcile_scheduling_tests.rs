use super::*;
use crate::capture_sink::bound_sink_params;
use dohc_engine_collab::{ContentKind, DocKey, Ydoc};
use dohc_engine_files::{CaptureApplyResult, CaptureSink, CapturedIngest};
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

const WORKSPACE_ID: &str = "ws-idle-collection-reconcile";

fn plan_with(op: CaptureOp) -> ReconcilePlan {
    ReconcilePlan {
        from_generation: ScanGeneration(0),
        to_generation: ScanGeneration(1),
        ops: vec![op],
        retained_over_cap: Vec::new(),
        unconfirmed_removed: Vec::new(),
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

    let files = FilesActor::spawn_async(scratch.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    status.request_collection_reconcile();
    let first_root = bind_capture_root(scratch.path()).expect("bind first run root");
    let first_clean = apply_bound_run_with_handle(
        collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
        &files.handle(),
        RootBoundRun {
            captured_root: first_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await;
    assert!(!first_clean, "the held lease makes this pass retryable");
    assert!(
        status.collection_reconcile_pending(),
        "a held lease must leave another collection pass scheduled"
    );
    assert_eq!(
        std::fs::read_to_string(collection_dir.join("alpha.md"))
            .expect("read lease-blocked record"),
        "Alpha task\n"
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
    .await;
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

    let files = FilesActor::spawn_async(scratch.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    status.request_collection_reconcile();
    let first_root = bind_capture_root(scratch.path()).expect("bind first run root");
    let first_clean = apply_bound_run_with_handle(
        collection_apply_context(scratch.path(), &actor, &leases, &status, &self_writes),
        &files.handle(),
        RootBoundRun {
            captured_root: first_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await;
    assert!(!first_clean, "the held lease keeps its retry scheduled");
    assert!(status.collection_reconcile_pending());
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
    .await;
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
            sink.reconcile_collections()
                .expect("bind pending collection record")
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
                leases: adopt_leases,
                self_writes: adopt_self_writes,
                ..bound_sink_params(adopt_actor, WORKSPACE_ID, "main", adopt_root, 3)
            })
            .reconcile_collections()
            .expect("adopt shared-imported record"),
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
                crashed_after_durable_boundary: None,
                degraded: false,
            },
        )
        .await
        .expect("acknowledge the already-captured adopted-file baseline");

    std::fs::write(&record_path, b"Alpha task").expect("strip adopted record id");
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
            },
            &handle,
            RootBoundRun {
                captured_root: changed_root,
                run: ReconcileRun::Completed(changed_plan),
            },
            &CancellationToken::new(),
        )
        .await,
        "the changed record capture settles cleanly"
    );
    let restored = std::fs::read_to_string(&record_path).expect("read restored record");

    watcher.stop().expect("stop watcher");
    files.close().await;
    supervisor.close(&db).expect("close actor");

    assert_eq!(
        restored, adopted,
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
            sink.reconcile_collections()
                .expect("exclude malformed collection record")
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
            },
            &handle,
            RootBoundRun {
                captured_root: changed_root,
                run: ReconcileRun::Completed(changed_plan),
            },
            &CancellationToken::new(),
        )
        .await,
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
            },
            &handle,
            RootBoundRun {
                captured_root: converged_root,
                run: ReconcileRun::Converged,
            },
            &CancellationToken::new(),
        )
        .await,
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
        sink.reconcile_collections().expect("bind pending record");
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
        .reconcile_collections()
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
        },
        &files.handle(),
        RootBoundRun {
            captured_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await;
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
        },
        &files.handle(),
        RootBoundRun {
            captured_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await;
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
