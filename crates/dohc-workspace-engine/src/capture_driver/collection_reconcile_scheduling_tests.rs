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
        layer_rules: None,
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
                layer_rules: None,
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
                layer_rules: None,
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
