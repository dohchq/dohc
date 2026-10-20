//! FilesActor traces (the CAL-3 tokio-loop calibration signal): scan/reconcile
//! round-trip through the async command loop while the blocking scan/hash work
//! stays on the dedicated worker thread; the injected watcher-overflow signal
//! driving a dirty-generation reconcile; a deadline that trips cleanly; and
//! deterministic close/Drop tearing down the hash pool.

mod common;

use common::Scratch;
use dohc_engine_files::{
    CancellationToken, CaptureError, CaptureOp, CaptureSink, FilesActor, FilesHandle,
    IngestOutcome, IngestReason, LifecycleState, ReconcileRun, RetireOutcome, ScanBounds,
    ScanOutcome, apply_reconcile_plan,
};
use dohc_engine_storage::NoFaults;
use std::time::Duration;

struct AcceptAll;

impl CaptureSink for AcceptAll {
    fn ingest(
        &mut self,
        _path: &str,
        size: u64,
        sha256: &str,
        _media_type: &str,
        _reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        Ok(IngestOutcome::Captured {
            size,
            sha256: sha256.to_owned(),
        })
    }

    fn retire(&mut self, _path: &str) -> Result<RetireOutcome, CaptureError> {
        Ok(RetireOutcome::Retired)
    }
}

async fn acknowledge(handle: &FilesHandle, run: &ReconcileRun) {
    if let ReconcileRun::Completed(plan) = run {
        let result = apply_reconcile_plan(plan, &mut AcceptAll, &NoFaults);
        handle
            .acknowledge_capture(plan.clone(), result)
            .await
            .expect("ack capture");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actor_scans_through_the_async_loop() {
    let ws = Scratch::new();
    ws.write("notes/a.md", b"# A\n");
    ws.write("b.txt", b"beta");
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();
    assert_eq!(handle.lifecycle(), LifecycleState::Ready);

    let listing = match handle.scan(CancellationToken::new()).await.expect("scan") {
        ScanOutcome::Completed(listing) => listing,
        ScanOutcome::Cancelled => panic!("unexpected cancel"),
    };
    let paths: Vec<_> = listing.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["b.txt", "notes/a.md"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actor_reconcile_advances_generation_and_reports_stats() {
    let ws = Scratch::new();
    ws.write("a.md", b"alpha\n");
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();

    let run = handle
        .reconcile(CancellationToken::new())
        .await
        .expect("reconcile");
    let plan = match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected Completed, got {other:?}"),
    };
    let result = apply_reconcile_plan(&plan, &mut AcceptAll, &NoFaults);
    handle
        .acknowledge_capture(plan.clone(), result)
        .await
        .expect("ack");
    assert_eq!(plan.to_generation.0, 1);
    assert!(matches!(plan.ops.first(), Some(CaptureOp::Ingest { .. })));

    let stats = handle.stats().await.expect("stats");
    assert_eq!(stats.generation.0, 1);
    assert!(!stats.dirty);
    assert_eq!(stats.tracked, 1);
    // The bound holds through the actor too.
    assert!(stats.max_hash_concurrency <= ScanBounds::default().hash_workers());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn injected_overflow_marks_dirty_then_reconcile_converges() {
    let ws = Scratch::new();
    ws.write("a.md", b"one\n");
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();

    // Establish a converged baseline.
    let baseline = handle
        .reconcile(CancellationToken::new())
        .await
        .expect("baseline");
    acknowledge(&handle, &baseline).await;
    assert!(!handle.stats().await.expect("stats").dirty);

    // Inject a watcher-overflow signal (the stubbed event source) after an edit.
    ws.write("a.md", b"two\n");
    handle.notify_overflow();
    // The signal is async bookkeeping; observe it via stats (ordered behind it
    // on the same FIFO queue).
    assert!(handle.stats().await.expect("stats").dirty);

    let run = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("if-dirty");
    let plan = match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected Completed, got {other:?}"),
    };
    acknowledge(&handle, &ReconcileRun::Completed(plan.clone())).await;
    assert!(plan.prepared_from_dirty);
    assert!(!handle.stats().await.expect("stats").dirty);

    // Converged: a second dirty-driven reconcile is a no-op.
    assert!(matches!(
        handle
            .reconcile_if_dirty(CancellationToken::new())
            .await
            .expect("if-dirty"),
        ReconcileRun::Converged
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overflow_between_prepare_and_ack_is_not_cleared_by_the_older_receipt() {
    let ws = Scratch::new();
    ws.write("a.md", b"one");
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();
    let run = handle
        .reconcile(CancellationToken::new())
        .await
        .expect("prepare");
    let plan = match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected plan, got {other:?}"),
    };
    let result = apply_reconcile_plan(&plan, &mut AcceptAll, &NoFaults);

    // A real watcher callback can land while the downstream sink is applying.
    // The ack command folds this newer epoch first and must not clear it.
    handle.notify_overflow();
    handle
        .acknowledge_capture(plan, result)
        .await
        .expect("ack older plan");
    assert!(handle.stats().await.expect("stats").dirty);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_cancel_leaves_a_consistent_actor_state() {
    // Racy by nature; the invariant is that whichever outcome wins, state is
    // consistent: Cancelled ⇒ generation unchanged + dirty; Completed ⇒
    // generation advanced + not dirty.
    let ws = Scratch::new();
    for i in 0..40 {
        ws.write(&format!("f{i:03}.md"), format!("body-{i}\n").as_bytes());
    }
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();

    let token = CancellationToken::new();
    let run = {
        let handle = handle.clone();
        let token = token.clone();
        tokio::spawn(async move { handle.reconcile(token).await })
    };
    token.cancel();
    let outcome = run.await.expect("join").expect("reconcile");

    acknowledge(&handle, &outcome).await;

    let stats = handle.stats().await.expect("stats");
    match outcome {
        ReconcileRun::Cancelled => {
            assert_eq!(stats.generation.0, 0);
            assert!(stats.dirty);
            assert_eq!(stats.tracked, 0);
        }
        ReconcileRun::Completed(plan) => {
            assert_eq!(plan.to_generation.0, 1);
            assert_eq!(stats.generation.0, 1);
            assert!(!stats.dirty);
        }
        ReconcileRun::Converged => panic!("first reconcile is never a no-op"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_deadline_leaves_work_resumable() {
    let ws = Scratch::new();
    ws.write("a.md", b"alpha\n");
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();

    let token = CancellationToken::new();
    let err = handle
        .reconcile_with_deadline(token.clone(), Duration::ZERO)
        .await
        .expect_err("deadline must trip");
    assert_eq!(err.code(), "deadline-exceeded");
    assert!(token.is_cancelled());

    // An expired deadline leaves the work unchanged and dirty; the retry completes.
    let stats = handle.stats().await.expect("stats");
    assert_eq!(stats.generation.0, 0, "no commit on an expired deadline");
    assert!(stats.dirty);
    assert_eq!(stats.tracked, 0);
    assert_eq!(stats.hashed, 0, "no scan on an expired deadline");

    let retry = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("retry");
    let ReconcileRun::Completed(plan) = retry else {
        panic!("deadline leaves the work resumable");
    };
    assert_eq!(plan.ops.len(), 1);
    assert_eq!(plan.ops[0].path(), "a.md");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_is_deterministic_and_idempotent() {
    let ws = Scratch::new();
    ws.write("a.md", b"alpha\n");
    let mut actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();
    let _ = handle
        .reconcile(CancellationToken::new())
        .await
        .expect("reconcile");

    // Close joins the worker (and tears down the hash pool) on a blocking
    // thread; idempotent.
    tokio::task::spawn_blocking(move || {
        actor.close().expect("close");
        actor.close().expect("idempotent close");
        assert_eq!(actor.lifecycle(), LifecycleState::Closed);
    })
    .await
    .expect("join close");

    // The handle now observes the actor gone.
    assert!(handle.scan(CancellationToken::new()).await.is_err());
    assert_eq!(handle.lifecycle(), LifecycleState::Closed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ack_rejects_an_applied_ingest_without_captured_identity() {
    use dohc_engine_files::FilesError;

    let ws = Scratch::new();
    ws.write("a.md", b"alpha");
    let mut actor = FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
        .await
        .expect("spawn");
    let handle = actor.handle();
    let run = handle
        .reconcile(CancellationToken::new())
        .await
        .expect("reconcile");
    let ReconcileRun::Completed(plan) = run else {
        panic!("expected completed plan");
    };
    let mut result = apply_reconcile_plan(&plan, &mut AcceptAll, &NoFaults);
    // A hand-built (or corrupted) receipt claiming an applied ingest without
    // its captured identity must fail closed: recording the scan-time hash
    // would recreate the rapid-write lost-capture bug.
    result.captured.clear();
    let err = handle
        .acknowledge_capture(plan, result)
        .await
        .expect_err("malformed receipt must be refused");
    assert!(matches!(err, FilesError::InvalidCaptureReceipt { .. }));

    actor.close().expect("close");
}
