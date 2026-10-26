mod common;

use common::Scratch;
use dohc_engine_files::{
    BatchIngestResult, CancellationToken, CaptureError, CaptureOp, CaptureSink, FilesError,
    ImportPriority, IngestOutcome, IngestReason, ReconcileController, ReconcileRun,
    RespelledRetire, Respelling, RetireOutcome, ScanBounds, Scanner,
    apply_reconcile_plan_cancellable, apply_then_ack,
};
use dohc_engine_storage::NoFaults;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

#[derive(Default)]
struct IdempotentSink {
    content: BTreeMap<String, String>,
    moments: usize,
    calls: Vec<String>,
    fail: BTreeSet<String>,
    not_owned: BTreeSet<String>,
    deferred: BTreeSet<String>,
    /// Paths whose file is gone when the sink reads it for an ingest, and
    /// whose record a live session holds.
    gone_and_held: BTreeSet<String>,
    /// Report this sha for a path instead of the plan's (models a re-reading
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
        if self.deferred.contains(path) {
            return Ok(IngestOutcome::Deferred);
        }
        if self.gone_and_held.contains(path) {
            return Ok(IngestOutcome::RetireDeferred);
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

    fn retire(&mut self, path: &str) -> Result<RetireOutcome, CaptureError> {
        self.calls.push(path.to_owned());
        if self.fail.contains(path) {
            return Err(CaptureError { reason: "injected" });
        }
        if self.deferred.contains(path) {
            return Ok(RetireOutcome::Deferred);
        }
        self.content.remove(path);
        Ok(RetireOutcome::Retired)
    }
}

#[derive(Default)]
struct TwoAtATimeSink(IdempotentSink);

impl CaptureSink for TwoAtATimeSink {
    fn ingest(
        &mut self,
        path: &str,
        size: u64,
        sha256: &str,
        media_type: &str,
        reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        self.0.ingest(path, size, sha256, media_type, reason)
    }

    fn retire(&mut self, path: &str) -> Result<RetireOutcome, CaptureError> {
        self.0.retire(path)
    }

    fn ingest_batch(&mut self, ops: &[CaptureOp]) -> Option<BatchIngestResult> {
        if ops.len() < 2 || ops.iter().any(|op| !matches!(op, CaptureOp::Ingest { .. })) {
            return None;
        }
        let outcomes = ops[..2]
            .iter()
            .map(|op| match op {
                CaptureOp::Ingest {
                    path,
                    size,
                    sha256,
                    media_type,
                    reason,
                    ..
                } => self.0.ingest(path, *size, sha256, media_type, *reason),
                CaptureOp::Retire { .. } => unreachable!("batch prefix was checked"),
            })
            .collect();
        Some(BatchIngestResult::Committed(outcomes))
    }
}

struct ReportingBatchSink {
    reported: Option<BatchIngestResult>,
    ordinary_calls: Vec<String>,
}

impl CaptureSink for ReportingBatchSink {
    fn ingest(
        &mut self,
        path: &str,
        size: u64,
        sha256: &str,
        _media_type: &str,
        _reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        self.ordinary_calls.push(path.to_owned());
        Ok(IngestOutcome::Captured {
            size,
            sha256: sha256.to_owned(),
        })
    }

    fn retire(&mut self, path: &str) -> Result<RetireOutcome, CaptureError> {
        self.ordinary_calls.push(path.to_owned());
        Ok(RetireOutcome::Retired)
    }

    fn ingest_batch(&mut self, _ops: &[CaptureOp]) -> Option<BatchIngestResult> {
        self.reported.take()
    }
}

fn completed(run: ReconcileRun) -> dohc_engine_files::ReconcilePlan {
    match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected completed plan, got {other:?}"),
    }
}

#[test]
fn capture_ignores_reserved_case_variants() {
    for name in [
        ".DOHC",
        ".Dohc",
        ".dohc",
        ".do‍hc",
        ".GIT",
        "NODE_MODULES",
        "GIT~1",
        "NODE_M~1",
        "DOHC~1",
    ] {
        let ws = Scratch::new();
        ws.write(&format!("{name}/engine/private.md"), b"private");
        ws.write(&format!("nested/{name}/private.md"), b"private");
        ws.write("my-dohc/notes.md", b"ordinary");
        ws.write(".ＤＯＨＣ/notes.md", b"ordinary");
        let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
        let mut controller = ReconcileController::new();
        let plan = completed(
            controller
                .reconcile(&scanner, ws.path(), &CancellationToken::new())
                .expect("scan"),
        );
        let mut sink = IdempotentSink::default();
        apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("capture");
        assert_eq!(
            sink.calls,
            [".ＤＯＨＣ/notes.md", "my-dohc/notes.md"],
            "{name}"
        );
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
fn deferred_ingest_stays_unrecorded_without_degrading_and_returns_on_a_rescan() {
    let ws = Scratch::new();
    ws.write("open.md", b"");
    ws.write("b.md", b"b");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    let mut sink = IdempotentSink {
        deferred: BTreeSet::from(["open.md".to_owned()]),
        ..IdempotentSink::default()
    };
    let result = apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("ack");

    assert_eq!(result.deferred_paths, ["open.md"]);
    assert!(result.failed_applies.is_empty());
    assert!(!result.degraded, "a live session's path is not a failure");
    assert_eq!(controller.tracked_len(), 1, "only b.md was recorded");
    assert_eq!(controller.deferred_paths(), ["open.md"]);
    assert!(controller.quarantined_paths().is_empty());
    assert!(
        !controller.is_dirty(),
        "a deferred path must not keep the layer rescanning while the session lasts"
    );

    // A requested rescan offers the path again, and once the session lets go
    // it is captured and no longer deferred.
    controller.mark_dirty();
    sink.deferred.clear();
    let retry = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("retry prepare"),
    );
    assert!(matches!(retry.ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "open.md"));
    apply_then_ack(&mut controller, &retry, &mut sink, &NoFaults).expect("ack retry");
    assert_eq!(controller.tracked_len(), 2);
    assert!(controller.deferred_paths().is_empty());
}

#[test]
fn deferred_retire_keeps_the_path_without_degrading_and_retires_on_a_rescan() {
    let ws = Scratch::new();
    ws.write("open.md", b"open");
    ws.write("b.md", b"b");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let mut sink = IdempotentSink::default();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("capture");

    ws.remove("open.md");
    ws.remove("b.md");
    sink.deferred.insert("open.md".to_owned());
    controller.mark_dirty();
    let plan = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare deletes"),
    );
    let result = apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("ack");

    assert_eq!(result.deferred_paths, ["open.md"]);
    assert_eq!(result.deferred_retires, ["open.md"]);
    assert!(result.failed_applies.is_empty());
    assert!(!result.degraded, "a live session's path is not a failure");
    assert!(sink.content.contains_key("open.md"), "the record stays");
    assert_eq!(controller.tracked_len(), 1, "only b.md was retired");
    assert_eq!(controller.deferred_paths(), ["open.md"]);
    assert!(
        !controller.is_dirty(),
        "a deferred path must not keep the layer rescanning while the session lasts"
    );

    // Once the session lets go, a requested rescan retires the path.
    controller.mark_dirty();
    sink.deferred.clear();
    let retry = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("retry prepare"),
    );
    assert!(matches!(retry.ops.as_slice(), [CaptureOp::Retire { path }] if path == "open.md"));
    apply_then_ack(&mut controller, &retry, &mut sink, &NoFaults).expect("ack retry");
    assert!(sink.content.is_empty());
    assert_eq!(controller.tracked_len(), 0);
    assert!(controller.deferred_paths().is_empty());
}

// A change was planned, but the file was gone when the sink read it and a
// live session holds its record. The entry stays so a later scan retires it.
#[test]
fn an_ingest_whose_held_file_is_gone_keeps_the_path_for_a_retire() {
    let ws = Scratch::new();
    ws.write("open.md", b"before");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let mut sink = IdempotentSink::default();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("capture");

    ws.write("open.md", b"changed");
    controller.mark_dirty();
    let plan = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare change"),
    );
    assert!(matches!(plan.ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "open.md"));
    ws.remove("open.md");
    sink.gone_and_held.insert("open.md".to_owned());
    let result = apply_then_ack(&mut controller, &plan, &mut sink, &NoFaults).expect("ack");

    assert_eq!(result.deferred_paths, ["open.md"]);
    assert_eq!(result.deferred_retires, ["open.md"]);
    assert!(result.failed_applies.is_empty());
    assert!(!result.degraded, "a live session's path is not a failure");
    assert_eq!(controller.tracked_len(), 1, "the entry stays");
    assert_eq!(controller.deferred_paths(), ["open.md"]);
    assert!(!controller.is_dirty());

    controller.mark_dirty();
    let retry = completed(
        controller
            .reconcile_if_dirty(&scanner, ws.path(), &CancellationToken::new())
            .expect("retry prepare"),
    );
    assert!(matches!(retry.ops.as_slice(), [CaptureOp::Retire { path }] if path == "open.md"));
}

#[test]
fn uncertain_batch_prefix_stays_failed_and_the_suffix_continues() {
    let ws = Scratch::new();
    ws.write("a.md", b"a");
    ws.write("b.md", b"b");
    ws.write("c.md", b"c");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    let mut sink = ReportingBatchSink {
        reported: Some(BatchIngestResult::Uncertain { attempted: 2 }),
        ordinary_calls: Vec::new(),
    };

    let result = apply_reconcile_plan_cancellable(
        &plan,
        &mut sink,
        &NoFaults,
        &CancellationToken::new(),
        None,
    );

    assert_eq!(result.failed_applies, ["a.md", "b.md"]);
    assert_eq!(result.applied_paths, ["c.md"]);
    assert_eq!(sink.ordinary_calls, ["c.md"]);
    assert!(result.crashed_after_durable_boundary.is_none());
}

#[test]
fn invalid_batch_prefix_reports_fail_closed_without_ordinary_apply() {
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

    for reported in [
        BatchIngestResult::Uncertain { attempted: 0 },
        BatchIngestResult::Committed(vec![
            Ok(IngestOutcome::NotOwned),
            Ok(IngestOutcome::NotOwned),
            Ok(IngestOutcome::NotOwned),
        ]),
    ] {
        let mut sink = ReportingBatchSink {
            reported: Some(reported),
            ordinary_calls: Vec::new(),
        };
        let result = apply_reconcile_plan_cancellable(
            &plan,
            &mut sink,
            &NoFaults,
            &CancellationToken::new(),
            None,
        );
        assert_eq!(result.failed_applies, ["a.md", "b.md"]);
        assert!(result.applied_paths.is_empty());
        assert!(sink.ordinary_calls.is_empty());
    }
}

#[test]
fn batch_prefix_that_contains_a_retire_is_rejected() {
    let ws = Scratch::new();
    ws.write("a.md", b"a");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let baseline = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("baseline prepare"),
    );
    apply_then_ack(
        &mut controller,
        &baseline,
        &mut IdempotentSink::default(),
        &NoFaults,
    )
    .expect("baseline ack");
    ws.remove("a.md");
    let plan = completed(
        controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("retire prepare"),
    );
    assert!(matches!(plan.ops.as_slice(), [CaptureOp::Retire { .. }]));
    let mut sink = ReportingBatchSink {
        reported: Some(BatchIngestResult::Committed(vec![Ok(
            IngestOutcome::NotOwned,
        )])),
        ordinary_calls: Vec::new(),
    };

    let result = apply_reconcile_plan_cancellable(
        &plan,
        &mut sink,
        &NoFaults,
        &CancellationToken::new(),
        None,
    );

    assert_eq!(result.failed_applies, ["a.md"]);
    assert!(result.applied_paths.is_empty());
    assert!(sink.ordinary_calls.is_empty());
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
    // The sink re-reads and captures newer bytes than the scan hashed.
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
    assert_eq!(
        crashed.crashed_after_durable_boundary.as_deref(),
        Some("a.md")
    );
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

#[cfg(feature = "fault-injection")]
#[test]
fn batch_crash_seam_fires_once_after_the_committed_prefix() {
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::ScriptedFaults;

    let ws = Scratch::new();
    ws.write("a.md", b"alpha");
    ws.write("b.md", b"bravo");
    ws.write("c.md", b"charlie");
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut first_controller = ReconcileController::new();
    let first_plan = completed(
        first_controller
            .reconcile(&scanner, ws.path(), &CancellationToken::new())
            .expect("prepare"),
    );
    let faults = ScriptedFaults::crash_at(FaultPoint::CaptureAfterOpApplyBeforeAck);
    let mut sink = TwoAtATimeSink::default();
    let crashed = apply_then_ack(
        &mut first_controller,
        &first_plan,
        &mut sink,
        faults.as_ref(),
    )
    .expect("simulated crash result");

    assert_eq!(
        crashed.crashed_after_durable_boundary.as_deref(),
        Some("b.md"),
        "the seam labels the last path in the committed batch, not its first outcome"
    );
    assert_eq!(sink.0.moments, 2, "one two-path batch committed");
    assert_eq!(sink.0.calls, ["a.md", "b.md"]);
    assert_eq!(
        first_controller.generation().0,
        0,
        "no ack crossed the seam"
    );

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
        sink.0.moments, 3,
        "replay dedupes the committed prefix and appends only the remaining path"
    );
    assert_eq!(restarted.tracked_len(), 3);
    assert!(!restarted.is_dirty());
}

#[cfg(feature = "fault-injection")]
#[test]
fn uncertain_batch_prefix_does_not_poll_the_post_commit_crash_seam() {
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::ScriptedFaults;

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
    let faults = ScriptedFaults::crash_at(FaultPoint::CaptureAfterOpApplyBeforeAck);
    let mut sink = ReportingBatchSink {
        reported: Some(BatchIngestResult::Uncertain { attempted: 2 }),
        ordinary_calls: Vec::new(),
    };

    let result = apply_reconcile_plan_cancellable(
        &plan,
        &mut sink,
        faults.as_ref(),
        &CancellationToken::new(),
        None,
    );

    assert_eq!(result.failed_applies, ["a.md", "b.md"]);
    assert!(result.crashed_after_durable_boundary.is_none());
    assert!(!faults.fired());
    assert!(sink.ordinary_calls.is_empty());
}

fn ingest(path: &str) -> CaptureOp {
    CaptureOp::Ingest {
        path: path.to_owned(),
        size: 1,
        sha256: "a".repeat(64),
        mtime_ms: 0,
        media_type: "text/markdown",
        reason: IngestReason::Added,
    }
}

fn plan_of(
    ops: Vec<CaptureOp>,
    unconfirmed_removed: &[&str],
    respelled_retires: &[(&str, &str)],
) -> dohc_engine_files::ReconcilePlan {
    dohc_engine_files::ReconcilePlan {
        from_generation: dohc_engine_files::ScanGeneration(0),
        to_generation: dohc_engine_files::ScanGeneration(1),
        ops,
        retained_unread: Vec::new(),
        unconfirmed_removed: unconfirmed_removed
            .iter()
            .map(|path| (*path).to_owned())
            .collect(),
        respelled_retires: respelled_retires
            .iter()
            .map(|(path, to)| {
                (
                    (*path).to_owned(),
                    Respelling {
                        path: (*to).to_owned(),
                        sha256: "a".repeat(64),
                    },
                )
            })
            .collect(),
        degraded: !unconfirmed_removed.is_empty(),
        degraded_paths: Vec::new(),
        prepared_from_dirty: false,
        dirty_epoch: 0,
    }
}

fn retire(path: &str) -> CaptureOp {
    CaptureOp::Retire {
        path: path.to_owned(),
    }
}

/// A sink whose respelled retires wait for the paths in `waits`, as one does
/// while an editor has the file open.
#[derive(Default)]
struct WaitingSink {
    inner: TwoAtATimeSink,
    waits: BTreeSet<String>,
}

impl CaptureSink for WaitingSink {
    fn ingest(
        &mut self,
        path: &str,
        size: u64,
        sha256: &str,
        media_type: &str,
        reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        self.inner.ingest(path, size, sha256, media_type, reason)
    }

    fn retire(&mut self, path: &str) -> Result<RetireOutcome, CaptureError> {
        self.inner.retire(path)
    }

    fn retire_respelled(
        &mut self,
        path: &str,
        _to: &Respelling,
    ) -> Result<RespelledRetire, CaptureError> {
        if self.waits.contains(path) {
            self.inner.0.calls.push(path.to_owned());
            return Ok(RespelledRetire::Waits);
        }
        self.retire(path).map(RespelledRetire::from)
    }

    fn ingest_batch(&mut self, ops: &[CaptureOp]) -> Option<BatchIngestResult> {
        self.inner.ingest_batch(ops)
    }
}

fn apply(
    plan: &dohc_engine_files::ReconcilePlan,
    sink: &mut dyn CaptureSink,
) -> dohc_engine_files::CaptureApplyResult {
    apply_reconcile_plan_cancellable(plan, sink, &NoFaults, &CancellationToken::new(), None)
}

/// A peer must receive a respelled path's retire before its ingest, or a
/// disk that ignores case deletes the new file. When the retire of
/// `notes.md` must wait, here because an editor has it open, the ingest of
/// `Notes.md` waits for a later pass; other paths go on.
#[test]
fn an_ingest_waits_for_the_waiting_retire_of_its_old_spelling() {
    let plan = plan_of(
        vec![
            retire("notes.md"),
            ingest("a.md"),
            ingest("b.md"),
            ingest("Notes.md"),
            ingest("other.md"),
            ingest("z.md"),
        ],
        &[],
        &[("notes.md", "Notes.md")],
    );
    let mut sink = WaitingSink {
        waits: ["notes.md".to_owned()].into(),
        ..WaitingSink::default()
    };
    let result = apply(&plan, &mut sink);
    assert_eq!(
        sink.inner.0.calls,
        ["notes.md", "a.md", "b.md", "other.md", "z.md"]
    );
    assert_eq!(result.failed_applies, ["notes.md", "Notes.md"]);
}

/// Where the disk cannot prove the stored spelling, the old spelling's
/// removal stays unconfirmed every pass. The new spelling is
/// captured as it is without the respell fix, never held back for good.
#[test]
fn an_unproven_respell_never_holds_back_an_ingest() {
    let plan = plan_of(vec![ingest("Notes.md")], &["notes.md"], &[]);
    let mut sink = WaitingSink::default();
    let result = apply(&plan, &mut sink);
    assert_eq!(sink.inner.0.calls, ["Notes.md"]);
    assert_eq!(result.applied_paths, ["Notes.md"]);
}

/// A retire that fails for good does not starve the new spelling either:
/// only a retire that waits holds it back.
#[test]
fn a_failed_respelled_retire_never_holds_back_an_ingest() {
    let plan = plan_of(
        vec![retire("notes.md"), ingest("Notes.md")],
        &[],
        &[("notes.md", "Notes.md")],
    );
    let mut sink = WaitingSink::default();
    sink.inner.0.fail.insert("notes.md".to_owned());
    let result = apply(&plan, &mut sink);
    assert_eq!(sink.inner.0.calls, ["notes.md", "Notes.md"]);
    assert_eq!(result.failed_applies, ["notes.md"]);
    assert_eq!(result.applied_paths, ["Notes.md"]);
}

/// A request made while a batch commits sends that path next, alone, ahead
/// of the lexically earlier remainder. Every durable unit wakes the caller.
#[test]
fn a_requested_path_is_captured_alone_before_the_rest_of_a_new_file_import() {
    let plan = plan_of(
        ["a.md", "b.md", "c.md", "d.md", "e.md", "z.md"]
            .into_iter()
            .map(ingest)
            .collect(),
        &[],
        &[],
    );
    let priority: Arc<OnceLock<Arc<ImportPriority>>> = Arc::new(OnceLock::new());
    let commits = Arc::new(AtomicUsize::new(0));
    let requester = Arc::clone(&priority);
    let counter = Arc::clone(&commits);
    let import = Arc::new(ImportPriority::new(move || {
        if counter.fetch_add(1, Ordering::SeqCst) == 0 {
            requester.get().expect("priority installed").request("z.md");
        }
    }));
    assert!(priority.set(Arc::clone(&import)).is_ok());
    let mut sink = TwoAtATimeSink::default();

    let result = apply_reconcile_plan_cancellable(
        &plan,
        &mut sink,
        &NoFaults,
        &CancellationToken::new(),
        Some(&import),
    );

    assert_eq!(
        sink.0.calls,
        ["a.md", "b.md", "z.md", "c.md", "d.md", "e.md"]
    );
    // a+b, z alone, c+d, then e alone once the batch has one op left.
    assert_eq!(commits.load(Ordering::SeqCst), 4);
    assert!(result.failed_applies.is_empty());
    let mut applied = result.applied_paths.clone();
    applied.sort();
    assert_eq!(applied, ["a.md", "b.md", "c.md", "d.md", "e.md", "z.md"]);
}

/// A plan with retires keeps its order: a respelled path's retire must still
/// run before its new spelling's ingest. A request for a path the plan does
/// not hold changes nothing.
#[test]
fn a_request_never_reorders_a_plan_with_retires() {
    let plan = plan_of(
        vec![retire("notes.md"), ingest("Notes.md"), ingest("a.md")],
        &[],
        &[("notes.md", "Notes.md")],
    );
    let import = ImportPriority::new(|| {});
    import.request("a.md");
    let mut sink = WaitingSink::default();
    let result = apply_reconcile_plan_cancellable(
        &plan,
        &mut sink,
        &NoFaults,
        &CancellationToken::new(),
        Some(&import),
    );
    assert_eq!(sink.inner.0.calls, ["notes.md", "Notes.md", "a.md"]);
    assert!(result.failed_applies.is_empty());

    let plan = plan_of(vec![ingest("a.md"), ingest("b.md")], &[], &[]);
    let import = ImportPriority::new(|| {});
    import.request("missing.md");
    let mut sink = TwoAtATimeSink::default();
    apply_reconcile_plan_cancellable(
        &plan,
        &mut sink,
        &NoFaults,
        &CancellationToken::new(),
        Some(&import),
    );
    assert_eq!(sink.0.calls, ["a.md", "b.md"]);
}
