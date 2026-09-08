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
