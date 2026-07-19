//! FilesActor traces (the CAL-3 tokio-loop calibration signal): scan/reconcile
//! round-trip through the async command loop while the blocking scan/hash work
//! stays on the dedicated worker thread; the injected watcher-overflow signal
//! driving a dirty-generation reconcile; a deadline that trips cleanly; and
//! deterministic close/Drop tearing down the hash pool.

mod common;

use common::Scratch;
use dohc_engine_files::{
    CancellationToken, CaptureError, CaptureOp, CaptureSink, FilesActor, FilesHandle,
    IngestOutcome, IngestReason, LifecycleState, ReconcileRun, ScanBounds, ScanOutcome,
    apply_reconcile_plan,
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

    fn retire(&mut self, _path: &str) -> Result<(), CaptureError> {
        Ok(())
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
    // Racy by nature; the invariant is that WHICHEVER outcome wins, state is
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
async fn deadline_trips_to_typed_error_committing_nothing() {
    let ws = Scratch::new();
    // A single hash worker over enough content that the scan reliably outlasts
    // a 1ms deadline (16 MiB single-threaded SHA-256 ≫ 1ms on any host). This
    // makes the deadline path deterministic without a fault seam.
    let one_mib = vec![b'x'; 1024 * 1024];
    for i in 0..16 {
        ws.write(&format!("big/f{i:02}.bin"), &one_mib);
    }
    let bounds = ScanBounds::builder()
        .hash_workers(std::num::NonZeroUsize::new(1).unwrap())
        .build();
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), bounds)
        .await
        .expect("spawn");
    let handle = actor.handle();

    let token = CancellationToken::new();
    let err = handle
        .reconcile_with_deadline(token, Duration::from_millis(1))
        .await
        .expect_err("deadline must trip");
    assert_eq!(err.code(), "deadline-exceeded");

    // Nothing committed: the deadline cancelled the scan at a between-unit
    // boundary, so the generation never advanced and dirty stays set. (stats()
    // is FIFO-ordered behind the cancelled reconcile, so it observes the
    // settled state.)
    let stats = handle.stats().await.expect("stats");
    assert_eq!(stats.generation.0, 0, "no commit on a deadline trip");
    assert!(stats.dirty);
    assert_eq!(stats.tracked, 0);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overflow_is_never_lost_even_when_the_queue_is_saturated() {
    // Regression for the dirty-mark-at-actor-boundary P2: notify_overflow must
    // set the dirty bit even when the command channel is full — it uses a sticky
    // atomic, not a try_send that could return Overloaded and drop the mark.
    let ws = Scratch::new();
    // Enough content that a single-worker scan occupies the worker while we
    // saturate the queue (no reconcile runs during this window, only the scan).
    let one_mib = vec![b'x'; 1024 * 1024];
    for i in 0..12 {
        ws.write(&format!("big/f{i:02}.bin"), &one_mib);
    }
    let bounds = ScanBounds::builder()
        .hash_workers(std::num::NonZeroUsize::new(1).unwrap())
        .build();
    let actor = FilesActor::spawn_async(ws.path().to_path_buf(), bounds)
        .await
        .expect("spawn");
    let handle = actor.handle();

    // Establish a converged baseline (dirty cleared).
    let baseline = handle
        .reconcile(CancellationToken::new())
        .await
        .expect("baseline");
    acknowledge(&handle, &baseline).await;
    assert!(!handle.stats().await.expect("stats").dirty);

    // Wedge the worker with a long SCAN (not a reconcile — so nothing clears
    // dirty during this window), then saturate the command queue with stats.
    let wedge = {
        let handle = handle.clone();
        tokio::spawn(async move { handle.scan(CancellationToken::new()).await })
    };
    let mut saturators = Vec::new();
    for _ in 0..80u32 {
        let handle = handle.clone();
        saturators.push(tokio::spawn(async move { handle.stats().await }));
    }
    // Give the wedge + saturators time to fill the 64-slot queue.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // notify_overflow returns () and cannot fail — the mark is set regardless of
    // the full queue.
    handle.notify_overflow();

    // Drain everything.
    let _ = wedge.await.expect("join wedge").expect("scan");
    for s in saturators {
        let _ = s.await;
    }

    // The overflow was folded into the controller (no reconcile cleared it), so
    // the actor ends dirty — the mark was NOT lost to backpressure.
    assert!(
        handle.stats().await.expect("stats").dirty,
        "overflow mark lost under queue saturation"
    );
    // And a dirty-driven reconcile now runs a real rescan (not a no-op).
    assert!(matches!(
        handle
            .reconcile_if_dirty(CancellationToken::new())
            .await
            .expect("if-dirty"),
        ReconcileRun::Completed(_)
    ));
}
