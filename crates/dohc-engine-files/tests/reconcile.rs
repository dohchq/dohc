//! Reconcile behavior: plan correctness (added/changed/removed → capture ops),
//! the rename shape (remove + add), the watcher dirty-generation state machine
//! (overflow → dirty → full rescan converges), and — the calibration point —
//! cancellation mid-scan leaving consistent, resumable state (no partial
//! capture; dirty stays set so the next scan completes it).

mod common;

use common::Scratch;
use dohc_engine_files::{
    AbsenceProbe, CancellationToken, CaptureError, CaptureOp, CaptureSink, IngestReason,
    ReconcileController, ReconcileRun, ScanBounds, ScanIoFaultInjector, ScanIoOperation, Scanner,
    StubWatchSource, WatchEvent, apply_then_ack,
};
use dohc_engine_storage::NoFaults;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;

fn plan(run: ReconcileRun) -> dohc_engine_files::ReconcilePlan {
    match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected Completed, got {other:?}"),
    }
}

struct AcceptAll;

impl CaptureSink for AcceptAll {
    fn ingest(
        &mut self,
        _path: &str,
        _size: u64,
        _sha256: &str,
        _media_type: &str,
        _reason: IngestReason,
    ) -> Result<(), CaptureError> {
        Ok(())
    }

    fn retire(&mut self, _path: &str) -> Result<(), CaptureError> {
        Ok(())
    }
}

fn reconcile_and_apply(
    ctrl: &mut ReconcileController,
    scanner: &Scanner,
    root: &Path,
    token: &CancellationToken,
) -> dohc_engine_files::ReconcilePlan {
    let prepared = plan(ctrl.reconcile(scanner, root, token).expect("reconcile"));
    apply_then_ack(ctrl, &prepared, &mut AcceptAll, &NoFaults).expect("apply/ack");
    prepared
}

fn reconcile_if_dirty_and_apply(
    ctrl: &mut ReconcileController,
    scanner: &Scanner,
    root: &Path,
    token: &CancellationToken,
) -> ReconcileRun {
    let run = ctrl
        .reconcile_if_dirty(scanner, root, token)
        .expect("if-dirty");
    if let ReconcileRun::Completed(prepared) = &run {
        apply_then_ack(ctrl, prepared, &mut AcceptAll, &NoFaults).expect("apply/ack");
    }
    run
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
    let first = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
    assert_eq!(first.from_generation.0, 0);
    assert_eq!(first.to_generation.0, 1);
    assert!(first.prepared_from_dirty);
    assert_eq!(ingest_paths(&first, IngestReason::Added), ["a.md", "b.md"]);

    // Nothing changed on disk: a dirty-driven reconcile is a no-op...
    assert!(matches!(
        reconcile_if_dirty_and_apply(&mut ctrl, &scanner, ws.path(), &token),
        ReconcileRun::Converged
    ));
    // ...but a forced full reconcile produces an EMPTY plan (converged).
    let second = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
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
    let _ = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);

    // Mutate the tree: edit one, add one, remove one, keep one.
    ws.write("edit.md", b"after edit\n");
    ws.write("new.md", b"fresh\n");
    ws.remove("gone.md");

    let p = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
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
    let _ = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);

    ws.rename("old-name.md", "new-name.md");

    let p = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
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
    let resumed = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &CancellationToken::new());
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
    let _ = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
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
    let converged = plan(reconcile_if_dirty_and_apply(
        &mut ctrl,
        &scanner,
        ws.path(),
        &token,
    ));
    assert!(converged.prepared_from_dirty);
    assert_eq!(ingest_paths(&converged, IngestReason::Added), ["b.md"]);
    assert_eq!(ingest_paths(&converged, IngestReason::Changed), ["a.md"]);
    assert!(
        !ctrl.is_dirty(),
        "a completed rescan clears the dirty generation"
    );

    // A subsequent dirty-driven reconcile is a no-op (already converged).
    assert!(matches!(
        reconcile_if_dirty_and_apply(&mut ctrl, &scanner, ws.path(), &token),
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
    let _ = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &CancellationToken::new());

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
    let p = plan(reconcile_if_dirty_and_apply(
        &mut ctrl,
        &scanner,
        ws.path(),
        &CancellationToken::new(),
    ));
    assert_eq!(ingest_paths(&p, IngestReason::Changed), ["a.md"]);
}

#[test]
fn size_cap_grow_retains_never_retires_the_false_delete_regression() {
    // P1 REGRESSION: a previously-tracked file edited PAST the size cap must be
    // RETAINED (still on disk, last-known-good kept), never classified `removed`
    // and Retired — that would forget live user data.
    use dohc_engine_files::OverCapPolicy;
    let ws = Scratch::new();
    ws.write("doc.md", b"small\n"); // 6 bytes, under an 8-byte cap
    let bounds = ScanBounds::builder()
        .max_file_bytes(8)
        .over_cap(OverCapPolicy::Skip)
        .build();
    let scanner = Scanner::new(bounds).expect("scanner");
    let mut ctrl = ReconcileController::new();
    let token = CancellationToken::new();

    let base = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
    assert_eq!(ingest_paths(&base, IngestReason::Added), ["doc.md"]);
    assert_eq!(ctrl.tracked_len(), 1);

    // Grow it past the cap.
    ws.write("doc.md", b"now this content is definitely over the cap\n");
    let grown = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
    assert!(
        retire_paths(&grown).is_empty(),
        "an over-cap-grow of a present file must NEVER be retired (the false-delete)"
    );
    assert!(ingest_paths(&grown, IngestReason::Added).is_empty());
    assert!(ingest_paths(&grown, IngestReason::Changed).is_empty());
    assert_eq!(
        grown.retained_over_cap,
        ["doc.md"],
        "distinct retain disposition"
    );
    // Still tracked at last-known-good (not dropped from the manifest).
    assert_eq!(ctrl.tracked_len(), 1);

    // Shrink back under the cap with new content → detected as a normal change.
    ws.write("doc.md", b"tiny\n");
    let shrunk = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
    assert_eq!(ingest_paths(&shrunk, IngestReason::Changed), ["doc.md"]);
    assert!(retire_paths(&shrunk).is_empty());
    assert!(shrunk.retained_over_cap.is_empty());
}

#[test]
fn genuinely_deleted_over_cap_absent_file_is_still_removed() {
    // The complement of the P1 fix: a file that is truly gone from BOTH the
    // tracked and skipped sets is still `removed`.
    let ws = Scratch::new();
    ws.write("gone.md", b"here\n");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();
    let token = CancellationToken::new();
    let _ = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);

    ws.remove("gone.md");
    let p = reconcile_and_apply(&mut ctrl, &scanner, ws.path(), &token);
    assert_eq!(retire_paths(&p), ["gone.md"]);
    assert!(p.retained_over_cap.is_empty());
    assert_eq!(ctrl.tracked_len(), 0);
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

struct PermissionDeniedAt {
    path: &'static str,
}

impl ScanIoFaultInjector for PermissionDeniedAt {
    fn error_kind(&self, path: &str, operation: ScanIoOperation) -> Option<ErrorKind> {
        (path == self.path && operation == ScanIoOperation::Metadata)
            .then_some(ErrorKind::PermissionDenied)
    }
}

#[test]
fn unreadable_path_degrades_but_other_paths_capture_and_it_is_never_retired() {
    let ws = Scratch::new();
    ws.write("locked.md", b"prior protected content");
    ws.write("stable.md", b"stable");
    let normal = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut ctrl = ReconcileController::new();
    reconcile_and_apply(&mut ctrl, &normal, ws.path(), &CancellationToken::new());
    assert_eq!(ctrl.tracked_len(), 2);

    ws.write("new.md", b"independent new content");
    let degraded_scanner = Scanner::new_with_io_faults(
        ScanBounds::default(),
        Arc::new(PermissionDeniedAt { path: "locked.md" }),
    )
    .expect("faulted scanner");
    ctrl.mark_dirty();
    let prepared = plan(
        ctrl.reconcile_if_dirty(&degraded_scanner, ws.path(), &CancellationToken::new())
            .expect("tolerant reconcile"),
    );
    assert!(prepared.degraded);
    assert_eq!(prepared.unconfirmed_removed, ["locked.md"]);
    assert!(
        retire_paths(&prepared).is_empty(),
        "unreadable is never delete evidence"
    );
    assert_eq!(ingest_paths(&prepared, IngestReason::Added), ["new.md"]);
    apply_then_ack(&mut ctrl, &prepared, &mut AcceptAll, &NoFaults).expect("apply safe paths");
    assert_eq!(
        ctrl.tracked_len(),
        3,
        "last-known-good locked entry is retained"
    );
    assert!(ctrl.is_dirty(), "degraded pass stays retryable");
}

struct ReappearedProbe;

impl AbsenceProbe for ReappearedProbe {
    fn confirms_absent(&self, _absolute_path: &Path) -> bool {
        false
    }
}

#[test]
fn retire_requires_final_lstat_confirm_and_toctou_reappearance_is_retained() {
    let ws = Scratch::new();
    ws.write("gone.md", b"gone");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut confirmed = ReconcileController::new();
    reconcile_and_apply(
        &mut confirmed,
        &scanner,
        ws.path(),
        &CancellationToken::new(),
    );
    ws.remove("gone.md");
    let confirmed_plan = plan(
        confirmed
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("confirmed reconcile"),
    );
    assert_eq!(retire_paths(&confirmed_plan), ["gone.md"]);

    let ws_race = Scratch::new();
    ws_race.write("race.md", b"prior");
    let mut raced = ReconcileController::new();
    reconcile_and_apply(
        &mut raced,
        &scanner,
        ws_race.path(),
        &CancellationToken::new(),
    );
    ws_race.remove("race.md");
    let raced_plan = plan(
        raced
            .reconcile_with_absence_probe(
                &scanner,
                ws_race.path(),
                &CancellationToken::new(),
                &ReappearedProbe,
            )
            .expect("raced reconcile"),
    );
    assert!(retire_paths(&raced_plan).is_empty());
    assert_eq!(raced_plan.unconfirmed_removed, ["race.md"]);
    assert!(raced_plan.degraded);
}
