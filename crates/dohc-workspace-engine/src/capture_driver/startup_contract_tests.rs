use super::*;

fn plan_with_ops(ops: Vec<CaptureOp>) -> ReconcileRun {
    ReconcileRun::Completed(ReconcilePlan {
        from_generation: ScanGeneration(0),
        to_generation: ScanGeneration(1),
        ops,
        retained_over_cap: Vec::new(),
        unconfirmed_removed: Vec::new(),
        degraded: false,
        degraded_paths: Vec::new(),
        prepared_from_dirty: true,
        dirty_epoch: 1,
    })
}

fn ingest(index: usize, reason: IngestReason) -> CaptureOp {
    CaptureOp::Ingest {
        path: format!("note-{index}.md"),
        size: 4,
        sha256: "a".repeat(64),
        mtime_ms: 1,
        media_type: "text/markdown",
        reason,
    }
}

fn added_plan(count: usize) -> ReconcileRun {
    plan_with_ops(
        (0..count)
            .map(|index| ingest(index, IngestReason::Added))
            .collect(),
    )
}

#[test]
fn early_import_starts_at_the_named_file_count_boundary() {
    assert!(!is_safe_fresh_import_plan(&added_plan(
        EARLY_IMPORT_MIN_ADDED_FILES - 1
    )));
    assert!(is_safe_fresh_import_plan(&added_plan(
        EARLY_IMPORT_MIN_ADDED_FILES
    )));
    assert!(is_safe_fresh_import_plan(&added_plan(
        EARLY_IMPORT_MIN_ADDED_FILES + 1
    )));
}

#[test]
fn only_a_large_all_added_clean_plan_can_import_early() {
    let changed = (0..EARLY_IMPORT_MIN_ADDED_FILES)
        .map(|index| ingest(index, IngestReason::Changed))
        .collect();
    assert!(!is_safe_fresh_import_plan(&plan_with_ops(changed)));
    assert!(!is_safe_fresh_import_plan(&plan_with_ops(vec![
        CaptureOp::Retire {
            path: "note.md".to_owned(),
        }
    ])));
    assert!(!is_safe_fresh_import_plan(&ReconcileRun::Converged));

    let ReconcileRun::Completed(mut degraded) = added_plan(EARLY_IMPORT_MIN_ADDED_FILES) else {
        unreachable!();
    };
    degraded.degraded = true;
    assert!(!is_safe_fresh_import_plan(&ReconcileRun::Completed(
        degraded
    )));
}

#[test]
fn ready_is_a_one_way_startup_barrier() {
    let status = DriverStatus::default();
    status.set_initial_phase(CapturePhase::Importing);
    status.mark_initial_ready();
    status.mark_initial_degraded();
    let snapshot = status.snapshot();
    assert_eq!(snapshot.phase, CapturePhase::Ready);
    assert!(snapshot.degraded);
}

#[test]
fn a_restarted_layer_cannot_republish_the_startup_import_phase() {
    let status = DriverStatus::default();
    assert!(may_publish_early_import(&status));
    status.mark_initial_degraded();
    assert!(!may_publish_early_import(&status));
    status.set_initial_phase(CapturePhase::Importing);
    assert!(!may_publish_early_import(&status));
    status.mark_initial_ready();
    assert!(!may_publish_early_import(&status));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_first_layer_start_releases_link_drain_in_the_open_workspace() {
    use dohc_engine_storage::{EngineStore, NoFaults};
    use dohc_engine_testkit::ScratchDir;
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.path().join("engine.db");
    let supervisor = dohc_engine_runtime::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let hold = actor.defer_link_drain_for_capture();
    actor
        .capture_ingest(
            dohc_engine_domain::CaptureIngest {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "source.md".into(),
                text: "[[target]]".into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            },
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let events = EngineEvents::default();
    let (open_ready_tx, _) = tokio::sync::watch::channel(false);
    let mut env = RealEnv {
        observation: crate::file_observation::FileObservation::new(events.clone(), "ws".into()),
        root: scratch.path().join("missing-root"),
        initial_links_hold: Some(hold),
        actor,
        lease_releases_seen: 0,
        workspace_id: "ws".into(),
        leases: LeaseRegistry::new(),
        status: Arc::new(DriverStatus::default()),
        author_json: Arc::new(Mutex::new(None)),
        self_writes: SelfWriteSuppression::default(),
        apply_gate: Arc::new(tokio::sync::Mutex::new(())),
        store_freshly_created: true,
        open_ready_tx,
        refresh_epoch: Arc::new(AtomicU64::new(0)),
        events,
        apply_probe: None,
        scan: ScanGauge::default(),
        no_atomic_placement_announced: false,
    };
    assert!(env.start_layer(&CancellationToken::new()).await.is_err());
    assert_eq!(env.status.snapshot().phase, CapturePhase::Degraded);
    assert!(env.initial_links_hold.is_none());
    let observer = EngineStore::open_read_only(&db).unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        while observer.table_row_count("link_pending").unwrap() != 0 {
            poll.tick().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(observer.table_row_count("links").unwrap(), 1);
    drop(observer);
    drop(env);
    tokio::task::spawn_blocking(move || supervisor.close(&db))
        .await
        .unwrap()
        .unwrap();
}
