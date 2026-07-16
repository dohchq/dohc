//! Reconcile behavior: plan correctness (added/changed/removed → capture ops),
//! the rename shape (remove + add), the watcher dirty-generation state machine
//! (overflow → dirty → full rescan converges), and — the calibration point —
//! cancellation mid-scan leaving consistent, resumable state (no partial
//! capture; dirty stays set so the next scan completes it).

mod common;

use common::Scratch;
use dohc_engine_files::{
    CancellationToken, CaptureOp, IngestReason, ReconcileController, ReconcileRun, ScanBounds,
    Scanner, StubWatchSource, WatchEvent,
};

fn plan(run: ReconcileRun) -> dohc_engine_files::ReconcilePlan {
    match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected Completed, got {other:?}"),
    }
}

fn ingest_paths(plan: &dohc_engine_files::ReconcilePlan, want: IngestReason) -> Vec<&str> {
    plan.ops
        .iter()
        .filter_map(|op| match op {
            CaptureOp::Ingest { path, reason, .. } if *reason == want => Some(path.as_str()),
            _ => None,
        })
        .collect()
}

fn retire_paths(plan: &dohc_engine_files::ReconcilePlan) -> Vec<&str> {
    plan.ops
        .iter()
        .filter_map(|op| match op {
            CaptureOp::Retire { path } => Some(path.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn first_reconcile_ingests_everything_then_converges() {
    let ws = Scratch::new();
    ws.write("a.md", b"alpha\n");
    ws.write("b.md", b"beta\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();
    let token = CancellationToken::new();

    // Baseline: everything is "added".
    let first = plan(
        ctrl.reconcile(&scanner, ws.path(), &token)
            .expect("reconcile"),
    );
    assert_eq!(first.from_generation.0, 0);
    assert_eq!(first.to_generation.0, 1);
    assert!(first.cleared_dirty);
    assert_eq!(ingest_paths(&first, IngestReason::Added), ["a.md", "b.md"]);

    // Nothing changed on disk: a dirty-driven reconcile is a no-op...
    assert!(matches!(
        ctrl.reconcile_if_dirty(&scanner, ws.path(), &token)
            .expect("if-dirty"),
        ReconcileRun::Converged
    ));
    // ...but a forced full reconcile produces an EMPTY plan (converged).
    let second = plan(
        ctrl.reconcile(&scanner, ws.path(), &token)
            .expect("reconcile"),
    );
    assert!(second.is_empty());
    assert_eq!(second.to_generation.0, 2);
}

#[test]
fn reconcile_classifies_added_changed_removed() {
    let ws = Scratch::new();
    ws.write("keep.md", b"same\n");
    ws.write("edit.md", b"before\n");
    ws.write("gone.md", b"bye\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();
    let token = CancellationToken::new();
    let _ = plan(
        ctrl.reconcile(&scanner, ws.path(), &token)
            .expect("baseline"),
    );

    // Mutate the tree: edit one, add one, remove one, keep one.
    ws.write("edit.md", b"after edit\n");
    ws.write("new.md", b"fresh\n");
    ws.remove("gone.md");

    let p = plan(
        ctrl.reconcile(&scanner, ws.path(), &token)
            .expect("reconcile"),
    );
    assert_eq!(ingest_paths(&p, IngestReason::Added), ["new.md"]);
    assert_eq!(ingest_paths(&p, IngestReason::Changed), ["edit.md"]);
    assert_eq!(retire_paths(&p), ["gone.md"]);
}

#[test]
fn rename_looks_like_remove_plus_add() {
    let ws = Scratch::new();
    ws.write("old-name.md", b"portable content\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();
    let token = CancellationToken::new();
    let _ = plan(
        ctrl.reconcile(&scanner, ws.path(), &token)
            .expect("baseline"),
    );

    ws.rename("old-name.md", "new-name.md");

    let p = plan(
        ctrl.reconcile(&scanner, ws.path(), &token)
            .expect("reconcile"),
    );
    // A content-preserving rename is a retire(old) + ingest(new) at this layer.
    assert_eq!(ingest_paths(&p, IngestReason::Added), ["new-name.md"]);
    assert_eq!(retire_paths(&p), ["old-name.md"]);
}

#[test]
fn cancellation_mid_scan_leaves_consistent_resumable_state() {
    let ws = Scratch::new();
    ws.write("a.md", b"alpha\n");
    ws.write("b.md", b"beta\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();

    // A cancelled reconcile (token tripped at a between-unit boundary) commits
    // NOTHING: generation stays 0, dirty stays set, manifest stays empty.
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        ctrl.reconcile(&scanner, ws.path(), &cancelled)
            .expect("reconcile"),
        ReconcileRun::Cancelled
    ));
    assert_eq!(ctrl.generation().0, 0, "no generation advance on cancel");
    assert!(
        ctrl.is_dirty(),
        "dirty preserved so the next scan completes it"
    );
    assert_eq!(ctrl.tracked_len(), 0, "no partial capture");

    // Resume with a live token: the work completes exactly as if the cancel
    // never happened — the baseline is established in full.
    let resumed = plan(
        ctrl.reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("resume"),
    );
    assert_eq!(ctrl.generation().0, 1);
    assert!(!ctrl.is_dirty());
    assert_eq!(
        ingest_paths(&resumed, IngestReason::Added),
        ["a.md", "b.md"]
    );
}

#[test]
fn watcher_overflow_sets_dirty_and_full_rescan_converges() {
    let ws = Scratch::new();
    ws.write("a.md", b"one\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();
    let token = CancellationToken::new();

    // Establish a converged baseline.
    let _ = plan(
        ctrl.reconcile(&scanner, ws.path(), &token)
            .expect("baseline"),
    );
    assert!(!ctrl.is_dirty());

    // A change happens WHILE the watcher is uncertain: an external edit plus an
    // overflow storm. Many events coalesce to one dirty flag but never drop the
    // evidence of the change.
    ws.write("a.md", b"two\n");
    ws.write("b.md", b"added under overflow\n");
    let mut source = StubWatchSource::new(4);
    for _ in 0..20 {
        source.push(WatchEvent::Overflow); // storm → coalesced
    }
    source.push(WatchEvent::Changed {
        path: "a.md".to_owned(),
    });
    let marked = source.drain_into(&mut ctrl);
    assert!(marked && ctrl.is_dirty());

    // The dirty-driven full rescan converges disk and engine.
    let converged = plan(
        ctrl.reconcile_if_dirty(&scanner, ws.path(), &token)
            .expect("if-dirty"),
    );
    assert!(converged.cleared_dirty);
    assert_eq!(ingest_paths(&converged, IngestReason::Added), ["b.md"]);
    assert_eq!(ingest_paths(&converged, IngestReason::Changed), ["a.md"]);
    assert!(
        !ctrl.is_dirty(),
        "a completed rescan clears the dirty generation"
    );

    // A subsequent dirty-driven reconcile is a no-op (already converged).
    assert!(matches!(
        ctrl.reconcile_if_dirty(&scanner, ws.path(), &token)
            .expect("if-dirty"),
        ReconcileRun::Converged
    ));
}

#[test]
fn overflow_during_cancelled_rescan_is_not_lost() {
    // Regression for "coalescing never drops the only evidence of a change":
    // a change marked dirty, then a cancelled rescan, must remain pending.
    let ws = Scratch::new();
    ws.write("a.md", b"one\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();
    let _ = plan(
        ctrl.reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("baseline"),
    );

    ws.write("a.md", b"two\n");
    ctrl.mark_dirty();

    // A cancelled rescan must NOT clear dirty.
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        ctrl.reconcile_if_dirty(&scanner, ws.path(), &cancelled)
            .expect("if-dirty"),
        ReconcileRun::Cancelled
    ));
    assert!(
        ctrl.is_dirty(),
        "cancelled rescan preserves the pending change"
    );

    // The next (live) rescan finally captures the change.
    let p = plan(
        ctrl.reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("if-dirty"),
    );
    assert_eq!(ingest_paths(&p, IngestReason::Changed), ["a.md"]);
}

#[test]
fn diff_bound_trips_when_change_set_too_large() {
    let ws = Scratch::new();
    for i in 0..5 {
        ws.write(&format!("f{i}.md"), b"x");
    }
    let bounds = ScanBounds::builder().max_diff_entries(3).build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let mut ctrl = ReconcileController::new();
    // First reconcile would add 5 files > diff cap of 3 → fail closed.
    let err = ctrl
        .reconcile(&scanner, ws.path(), &CancellationToken::new())
        .expect_err("diff too large");
    assert_eq!(err.code(), "diff-too-large");
}
