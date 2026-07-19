mod common;

use common::Scratch;
use dohc_engine_files::{
    CancellationToken, CaptureError, CaptureOp, CaptureSink, FilesError, IngestOutcome,
    IngestReason, ReconcileController, ReconcileRun, ScanBounds, Scanner, apply_then_ack,
};
use dohc_engine_storage::NoFaults;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
struct IdempotentSink {
    content: BTreeMap<String, String>,
    moments: usize,
    calls: Vec<String>,
    fail: BTreeSet<String>,
    not_owned: BTreeSet<String>,
    /// Report THIS sha for a path instead of the plan's (models a re-reading
    /// sink that captured newer bytes than the scan hashed).
    reread_sha: BTreeMap<String, String>,
}

impl CaptureSink for IdempotentSink {
    fn ingest(
        &mut self,
        path: &str,
        size: u64,
        sha256: &str,
        _media_type: &str,
        _reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        self.calls.push(path.to_owned());
        if self.fail.contains(path) {
            return Err(CaptureError { reason: "injected" });
        }
        if self.not_owned.contains(path) {
            self.content.remove(path);
            return Ok(IngestOutcome::NotOwned);
        }
        let actual = self
            .reread_sha
            .get(path)
            .cloned()
            .unwrap_or_else(|| sha256.to_owned());
        if self.content.get(path) != Some(&actual) {
            self.content.insert(path.to_owned(), actual.clone());
            self.moments += 1;
        }
        Ok(IngestOutcome::Captured {
            size,
            sha256: actual,
        })
    }

    fn retire(&mut self, path: &str) -> Result<(), CaptureError> {
        self.calls.push(path.to_owned());
        if self.fail.contains(path) {
            return Err(CaptureError { reason: "injected" });
        }
        self.content.remove(path);
        Ok(())
    }
}

fn completed(run: ReconcileRun) -> dohc_engine_files::ReconcilePlan {
    match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected completed plan, got {other:?}"),
    }
}

#[test]
fn failed_apply_keeps_prior_manifest_entry_and_continues_the_batch() {
    let ws = Scratch::new();
    ws.write("a.md", b"a");
    ws.write("b.md", b"b");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    let mut sink = IdempotentSink {
        fail: BTreeSet::from(["a.md".to_owned()]),
        ..IdempotentSink::default()
    };
    let result = apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("ack");

    assert_eq!(result.failed_applies, ["a.md"]);
    assert_eq!(
        sink.calls,
        ["a.md", "b.md"],
        "one bad path must not drop the rest"
    );
    assert_eq!(controller.tracked_len(), 1, "only b.md was acknowledged");
    assert!(controller.is_dirty(), "failed path remains retryable");

    sink.fail.clear();
    let retry = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("retry prepare"),
    );
    assert!(matches!(retry.ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "a.md"));
}

#[test]
fn not_owned_ingest_is_acknowledged_but_forgotten_by_the_manifest() {
    let ws = Scratch::new();
    ws.write("owned.md", b"owned");
    ws.write("opted-out.md", b"private");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    let mut sink = IdempotentSink {
        not_owned: BTreeSet::from(["opted-out.md".to_owned()]),
        ..IdempotentSink::default()
    };
    let result = apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("ack");

    assert_eq!(result.applied_paths, ["owned.md"]);
    assert_eq!(result.not_owned_paths, ["opted-out.md"]);
    assert!(result.failed_applies.is_empty());
    assert!(
        !result.degraded,
        "a settled not-owned path is not a failure"
    );
    assert!(
        !controller.is_dirty(),
        "the disposition is settled, not retried"
    );
    assert!(controller.tracks_path("owned.md"));
    assert!(
        !controller.tracks_path("opted-out.md"),
        "a not-owned path must never read as already-captured"
    );

    // Ownership returns (policy widened / content became ownable): the next
    // dirty reconcile must re-emit the ingest because the manifest forgot it.
    sink.not_owned.clear();
    controller.mark_dirty();
    let retry = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("retry prepare"),
    );
    assert!(
        matches!(retry.ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "opted-out.md"),
        "unchanged bytes must re-ingest once ownership returns: {:?}",
        retry.ops
    );
    apply_then_ack(&mut controller, &retry, &mut sink, &NoFaults).expect("retry ack");
    assert!(controller.tracks_path("opted-out.md"));
}

#[test]
fn manifest_records_the_bytes_actually_captured_not_the_scan_hash() {
    let ws = Scratch::new();
    ws.write("raced.md", b"scan-time bytes");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    // The sink re-reads and captures NEWER bytes than the scan hashed.
    let mut sink = IdempotentSink {
        reread_sha: BTreeMap::from([("raced.md".to_owned(), "sha-of-newer-bytes".to_owned())]),
        ..IdempotentSink::default()
    };
    apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("ack");
    assert!(!controller.is_dirty());

    // The disk still holds the scan-time bytes: against a manifest that had
    // recorded the stale scan hash this would diff clean and the newer
    // captured bytes would silently stay authoritative forever.
    controller.mark_dirty();
    let retry = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("retry prepare"),
    );
    assert!(
        matches!(retry.ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "raced.md"),
        "manifest must have recorded the captured hash so the on-disk bytes re-ingest: {:?}",
        retry.ops
    );
}

#[test]
fn previously_captured_path_that_turns_not_owned_is_dropped_from_the_manifest() {
    let ws = Scratch::new();
    ws.write("was-owned.md", b"v1");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let baseline = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("baseline prepare"),
    );
    let mut sink = IdempotentSink::default();
    apply_then_ack(&mut controller, &baseline, &mut sink, &NoFaults).expect("baseline ack");
    assert!(controller.tracks_path("was-owned.md"));

    ws.write("was-owned.md", b"v2");
    sink.not_owned.insert("was-owned.md".to_owned());
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("ack");
    assert!(
        !controller.tracks_path("was-owned.md"),
        "the stale captured entry must not survive a not-owned disposition"
    );
    assert!(!controller.is_dirty());
}

#[test]
fn stale_retire_plan_is_refused_before_any_op_reaches_the_sink() {
    let ws = Scratch::new();
    ws.write("p.md", b"live");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let baseline = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("baseline prepare"),
    );
    let mut sink = IdempotentSink::default();
    apply_then_ack(&mut controller, &baseline, &mut sink, &NoFaults).expect("baseline ack");

    ws.remove("p.md");
    let stale_retire = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("retire prepare"),
    );
    assert!(matches!(
        stale_retire.ops.as_slice(),
        [CaptureOp::Retire { path }] if path == "p.md"
    ));

    sink.fail.insert("p.md".to_owned());
    apply_then_ack(&mut controller, &stale_retire, &mut sink, &NoFaults)
        .expect("failed retire is acknowledged without dropping manifest state");
    ws.write("p.md", b"live");
    sink.fail.clear();
    let intervening = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("intervening prepare"),
    );
    assert!(intervening.is_empty());
    apply_then_ack(&mut controller, &intervening, &mut sink, &NoFaults).expect("intervening ack");

    sink.calls.clear();
    let err = apply_then_ack(&mut controller, &stale_retire, &mut sink, &NoFaults)
        .expect_err("stale destructive plan must fail before apply");
    assert!(matches!(err, FilesError::StaleReconcilePlan));
    assert!(
        sink.calls.is_empty(),
        "stale retire must never reach the sink"
    );
    assert!(controller.tracks_path("p.md"));
    assert_eq!(controller.tracked_len(), 1);
    assert!(!controller.is_dirty());
}

#[test]
fn second_reconcile_is_refused_while_a_plan_is_outstanding() {
    let ws = Scratch::new();
    ws.write("a.md", b"a");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("first prepare"),
    );

    let err = controller
        .reconcile(&scanner, ws.path(), &CancellationToken::new())
        .expect_err("a second live plan must not be handed out");
    assert!(matches!(err, FilesError::StaleReconcilePlan));

    apply_then_ack(
        &mut controller,
        &plan,
        &mut IdempotentSink::default(),
        &NoFaults,
    )
    .expect("original plan remains acknowledgeable");
}

#[cfg(feature = "fault-injection")]
#[test]
fn crash_after_op_apply_before_ack_restarts_without_lost_or_double_applied_capture() {
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::ScriptedFaults;

    let ws = Scratch::new();
    ws.write("a.md", b"captured once");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut first_controller = ReconcileController::new();
    let first_plan = completed(
        first_controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    let faults = ScriptedFaults::crash_at(FaultPoint::CaptureAfterOpApplyBeforeAck);
    let mut sink = IdempotentSink::default();
    let crashed = apply_then_ack(
        &mut first_controller,
        &first_plan,
        &mut sink,
        faults.as_ref(),
    )
    .expect("simulated crash result");
    assert_eq!(crashed.crashed_after_apply.as_deref(), Some("a.md"));
    assert_eq!(sink.moments, 1, "domain transaction committed once");
    assert_eq!(
        first_controller.generation().0,
        0,
        "no ack crossed the seam"
    );

    // Restart: controllers intentionally start dirty. Reapplying is harmless
    // because the sink models the domain's content-equality idempotency.
    let mut restarted = ReconcileController::new();
    let retry_plan = completed(
        restarted
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("restart prepare"),
    );
    let retried = apply_then_ack(&mut restarted, &retry_plan, &mut sink, &NoFaults)
        .expect("restart apply/ack");
    assert!(retried.failed_applies.is_empty());
    assert_eq!(
        sink.moments, 1,
        "redundant replay must not double-journal history"
    );
    assert_eq!(restarted.tracked_len(), 1);
    assert!(!restarted.is_dirty());
}
