use super::*;
use crate::capture_sink::bound_sink_params;
use dohc_engine_files::CaptureSink;
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_testkit::ScratchDir;

const WORKSPACE_ID: &str = "ws-root-bound-run";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn seeded_deletes_survive_an_over_cap_policy_hold_and_recovery() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    for path in ["big.md", "gone.md", ".env"] {
        std::fs::write(root.join(path), b"captured content").expect("write captured file");
    }
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let seed_actor = actor.clone();
    let seed_root = root.clone();
    std::thread::spawn(move || {
        let mut sink = StoreCaptureSink::new(bound_sink_params(
            seed_actor,
            WORKSPACE_ID,
            "main",
            seed_root,
            1,
        ));
        for path in ["big.md", "gone.md", ".env"] {
            assert!(matches!(
                sink.ingest(path, 0, "advisory-sha", "text/plain", IngestReason::Added)
                    .expect("seed captured head"),
                dohc_engine_files::IngestOutcome::Captured { .. }
            ));
        }
    })
    .join()
    .expect("workspace seed thread");

    let bounds = ScanBounds::builder().max_file_bytes(64).build();
    std::fs::write(root.join("big.md"), [b'x'; 65]).expect("grow beyond scan cap");
    let policy_path = root.join(".dohc/files.toml");
    let policy = b"[[rule]]\npath = \"**\"\ntracked = false\n";
    std::fs::write(&policy_path, policy).expect("narrow all ordinary files");
    let fingerprint = policy_fingerprint(&root);
    assert!(fingerprint.is_some());
    let (manifest, generation) = manifest_seed(&root, &actor, WORKSPACE_ID)
        .await
        .expect("captured-state seed")
        .into_scan_seed()
        .expect("existing captured entries");
    for path in ["big.md", "gone.md"] {
        let entry = manifest.get(path).expect("narrowed identity stays seeded");
        assert_eq!(entry.sha256, NARROWED_SEED_SENTINEL_SHA);
        assert_eq!(entry.mtime_ms, 0);
    }
    assert_ne!(
        manifest
            .get(".env")
            .expect("secret identity stays seeded")
            .sha256,
        NARROWED_SEED_SENTINEL_SHA,
        "the secret floor cannot be narrowed by policy"
    );
    std::fs::remove_file(root.join("gone.md")).expect("delete after seed and before scan");

    let leases = LeaseRegistry::new();
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let events = EngineEvents::default();
    let mut notices = events.subscribe();
    let mut seed = Some((manifest, generation));
    for recovery in [false, true] {
        if recovery {
            std::fs::remove_dir(&policy_path).expect("remove unreadable policy");
            std::fs::write(&policy_path, policy).expect("restore narrowing policy");
            assert_eq!(policy_fingerprint(&root), fingerprint);
            seed = manifest_seed(&root, &actor, WORKSPACE_ID)
                .await
                .expect("recovery seed")
                .into_scan_seed();
        }
        let files = FilesActor::spawn_async_with_manifest(root.clone(), bounds, seed.take())
            .await
            .expect("seeded files actor");
        let files = FilesActorCloseGuard::new(files);
        let captured_root = Arc::new(CapturedRoot::bind(&root).expect("bind capture root"));
        let run = files
            .handle()
            .reconcile(CancellationToken::new())
            .await
            .expect("scan");
        let ReconcileRun::Completed(plan) = &run else {
            panic!("a seeded scan must produce a plan");
        };
        assert_eq!(plan.retained_over_cap, ["big.md"]);
        assert!(!plan.ops.iter().any(|op| op.path() == "big.md"));
        assert!(
            plan.ops.iter().any(|op| matches!(op,
                CaptureOp::Ingest { path, .. } if path == ".env"
            )),
            "secret seed entries re-offer through their own sentinel"
        );
        let ordinary_ops: Vec<_> = plan.ops.iter().filter(|op| op.path() != ".env").collect();
        if recovery {
            assert!(
                ordinary_ops.is_empty(),
                "the confirmed delete was already acknowledged"
            );
        } else {
            assert_eq!(
                ordinary_ops,
                [&CaptureOp::Retire {
                    path: "gone.md".to_owned()
                }]
            );
            std::fs::remove_file(&policy_path).expect("remove readable policy");
            std::fs::create_dir(&policy_path).expect("make policy unreadable before apply");
        }
        let clean = apply_bound_run_with_handle(
            ApplyRunContext {
                root: &root,
                actor: &actor,
                workspace_id: WORKSPACE_ID,
                leases: &leases,
                status: &status,
                self_writes: &self_writes,
                author_json: None,
                provenance: CaptureProvenance {
                    summary: Some("Reconciled offline edits".to_owned()),
                    correlation_id: Some("policy-recovery-pass".to_owned()),
                },
                events: events.clone(),
                apply_probe: None,
            },
            &files.handle(),
            RootBoundRun { captured_root, run },
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(clean, recovery);
        assert!(
            actor
                .versioned_text_read(
                    WORKSPACE_ID.to_owned(),
                    "main".to_owned(),
                    "gone.md".to_owned(),
                    CancellationToken::new()
                )
                .await
                .expect("read confirmed delete")
                .is_none(),
            "confirmed deletion is independent of policy availability"
        );
        let head = actor
            .versioned_text_read(
                WORKSPACE_ID.to_owned(),
                "main".to_owned(),
                "big.md".to_owned(),
                CancellationToken::new(),
            )
            .await
            .expect("read over-cap head");
        if recovery {
            assert!(
                head.is_none(),
                "the over-cap loop must retire the narrowed head"
            );
            let notice = notices.try_recv().expect("policy retirement event");
            assert_eq!(notice.name, CAPTURE_MOMENT_RECORDED_EVENT);
            assert_eq!(notice.payload["notOwnedCount"], serde_json::json!(1));
        } else {
            assert_eq!(head.expect("held head survives").text, "captured content");
            assert!(status.degraded());
            assert!(
                status.take_policy_hold(),
                "the over-cap hold must arm recovery"
            );
            assert!(
                files
                    .handle()
                    .stats()
                    .await
                    .expect("held files stats")
                    .dirty
            );
            while notices.try_recv().is_ok() {}
        }
        files.close().await;
    }
    supervisor.close(&db).expect("close actor");
    let connection = rusqlite::Connection::open(&db).expect("open store observer");
    let (summary, correlation): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT metadata_summary, metadata_correlation_id FROM moments
         WHERE workspace_id = ?1 AND path = 'big.md' ORDER BY moment_order DESC LIMIT 1",
            [WORKSPACE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("policy retire metadata");
    assert_eq!(summary.as_deref(), Some("Stopped tracking by policy"));
    assert_eq!(correlation.as_deref(), Some("policy-recovery-pass"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepared_and_converged_runs_refuse_a_replacement_workspace_root() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().join("workspace");
    let moved_root = capture_scratch.path().join("workspace-moved");
    std::fs::create_dir(&root).expect("create capture root");
    std::fs::write(root.join("seed.md"), b"seed workspace content").expect("write seed content");
    std::fs::write(root.join("plan.md"), b"original workspace content")
        .expect("write original content");

    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine database path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let seed_actor = actor.clone();
    let seed_root = root.clone();
    std::thread::spawn(move || {
        StoreCaptureSink::new(bound_sink_params(
            seed_actor,
            WORKSPACE_ID,
            "main",
            seed_root,
            1,
        ))
        .ingest(
            "seed.md",
            0,
            "advisory-sha",
            "text/markdown",
            IngestReason::Added,
        )
        .expect("seed workspace");
    })
    .join()
    .expect("workspace seed thread");
    let files = FilesActor::spawn_async(root.clone(), ScanBounds::default())
        .await
        .expect("files actor");
    let files = FilesActorCloseGuard::new(files);
    let captured_root = Arc::new(CapturedRoot::bind(&root).expect("bind plan root"));
    let converged_root = Arc::clone(&captured_root);
    let run = files
        .handle()
        .reconcile(CancellationToken::new())
        .await
        .expect("prepare reconcile plan");
    assert!(matches!(&run, ReconcileRun::Completed(plan) if !plan.ops.is_empty()));

    std::fs::rename(&root, &moved_root).expect("move planned workspace root");
    std::fs::create_dir(&root).expect("install replacement workspace root");
    std::fs::write(root.join("plan.md"), b"replacement workspace content")
        .expect("write replacement content");

    let leases = LeaseRegistry::new();
    let status = Arc::new(DriverStatus::default());
    let self_writes = SelfWriteSuppression::default();
    let clean = apply_bound_run_with_handle(
        ApplyRunContext {
            root: &root,
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
        RootBoundRun { captured_root, run },
        &CancellationToken::new(),
    )
    .await;

    assert!(!clean, "a plan cannot adopt a replacement directory");
    assert!(
        files.handle().stats().await.expect("files stats").dirty,
        "the refused plan stays dirty for a fresh scan"
    );

    status.request_collection_reconcile();
    let converged_clean = apply_bound_run_with_handle(
        ApplyRunContext {
            root: &root,
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
            captured_root: converged_root,
            run: ReconcileRun::Converged,
        },
        &CancellationToken::new(),
    )
    .await;
    assert!(
        !converged_clean,
        "pending collection work must carry the same root identity"
    );
    assert!(
        status.collection_reconcile_pending(),
        "a refused collection reconcile stays pending"
    );

    files.close().await;
    supervisor.close(&db).expect("close actor");
    let connection = rusqlite::Connection::open(&db).expect("open store observer");
    let moments = connection
        .query_row(
            "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND path = 'plan.md'",
            [WORKSPACE_ID],
            |row| row.get::<_, i64>(0),
        )
        .expect("count captured moments");
    assert_eq!(moments, 0, "replacement bytes must never enter the store");

    std::fs::remove_dir_all(&root).expect("remove replacement workspace root");
    std::fs::rename(&moved_root, &root).expect("restore planned workspace root");
}
