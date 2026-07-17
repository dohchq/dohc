mod common;

use common::Scratch;
use dohc_engine_files::{
    CancellationToken, CaptureError, CaptureOp, CaptureSink, FilesHandle, IngestReason,
    NativeWatcher, ReconcileRun, ScanBounds, WATCH_HARD_DEADLINE, WATCH_SETTLE,
    apply_reconcile_plan,
};
use dohc_engine_storage::NoFaults;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

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

async fn apply_and_ack(
    handle: &FilesHandle,
    run: ReconcileRun,
) -> dohc_engine_files::ReconcilePlan {
    let plan = match run {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected completed reconcile, got {other:?}"),
    };
    let result = apply_reconcile_plan(&plan, &mut AcceptAll, &NoFaults);
    handle
        .acknowledge_capture(plan.clone(), result)
        .await
        .expect("ack capture");
    plan
}

async fn wait_dirty(handle: &FilesHandle) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if handle.stats().await.expect("stats").dirty {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "native watcher did not mark dirty in time"
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_watcher_create_and_delete_drive_dirty_reconcile_without_dropping_evidence() {
    let ws = Scratch::new();
    let actor =
        dohc_engine_files::FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
            .await
            .expect("actor");
    let handle = actor.handle();
    let ready = NativeWatcher::start(
        ws.path().to_path_buf(),
        handle.clone(),
        CancellationToken::new(),
    )
    .await
    .expect("watch start");
    let mut watcher = ready.watcher;
    apply_and_ack(&handle, ready.initial_reconcile).await;
    assert!(!handle.stats().await.expect("stats").dirty);

    ws.write("created.md", b"created");
    wait_dirty(&handle).await;
    let created = apply_and_ack(
        &handle,
        handle
            .reconcile_if_dirty(CancellationToken::new())
            .await
            .expect("create reconcile"),
    )
    .await;
    assert!(
        matches!(created.ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "created.md")
    );

    ws.remove("created.md");
    wait_dirty(&handle).await;
    let deleted = apply_and_ack(
        &handle,
        handle
            .reconcile_if_dirty(CancellationToken::new())
            .await
            .expect("delete reconcile"),
    )
    .await;
    assert!(matches!(deleted.ops.as_slice(), [CaptureOp::Retire { path }] if path == "created.md"));
    watcher.stop().expect("stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_watcher_stop_joins_and_no_notification_arrives_after_return() {
    let ws = Scratch::new();
    let actor =
        dohc_engine_files::FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
            .await
            .expect("actor");
    let handle = actor.handle();
    let ready = NativeWatcher::start(
        ws.path().to_path_buf(),
        handle.clone(),
        CancellationToken::new(),
    )
    .await
    .expect("watch start");
    let mut watcher = ready.watcher;
    apply_and_ack(&handle, ready.initial_reconcile).await;
    watcher.stop().expect("joined stop");

    ws.write("after-stop.md", b"must not notify");
    tokio::time::sleep(WATCH_SETTLE + Duration::from_millis(200)).await;
    assert!(!handle.stats().await.expect("stats").dirty);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuous_event_stream_still_flushes_at_the_hard_deadline() {
    let ws = Scratch::new();
    let actor =
        dohc_engine_files::FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
            .await
            .expect("actor");
    let handle = actor.handle();
    let ready = NativeWatcher::start(
        ws.path().to_path_buf(),
        handle.clone(),
        CancellationToken::new(),
    )
    .await
    .expect("watch start");
    let mut watcher = ready.watcher;
    apply_and_ack(&handle, ready.initial_reconcile).await;

    // Let startup-side filesystem noise settle, then establish a clean point
    // before beginning the intentionally never-quiet stream.
    tokio::time::sleep(WATCH_SETTLE + Duration::from_millis(200)).await;
    if handle.stats().await.expect("startup stats").dirty {
        let run = handle
            .reconcile_if_dirty(CancellationToken::new())
            .await
            .expect("startup reconcile");
        apply_and_ack(&handle, run).await;
    }
    assert!(!handle.stats().await.expect("clean stats").dirty);

    let stop_writes = Arc::new(AtomicBool::new(false));
    let writer_stop = Arc::clone(&stop_writes);
    let storm_path = ws.path().join("storm.md");
    let started = Instant::now();
    let writer = std::thread::spawn(move || {
        let mut sequence = 0_u64;
        while !writer_stop.load(Ordering::Acquire) {
            std::fs::write(&storm_path, sequence.to_le_bytes()).expect("storm write");
            sequence = sequence.saturating_add(1);
            std::thread::sleep(WATCH_SETTLE / 10);
        }
    });

    let latest_allowed = started + WATCH_HARD_DEADLINE + Duration::from_secs(1);
    let flushed_in_time = loop {
        if handle.stats().await.expect("storm stats").dirty {
            break true;
        }
        if Instant::now() >= latest_allowed {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    stop_writes.store(true, Ordering::Release);
    writer.join().expect("join storm writer");
    watcher.stop().expect("stop watcher");

    assert!(
        flushed_in_time,
        "continuous events did not flush within the hard-deadline bound"
    );
}

/// R14 robustness, end-to-end against the real backend: deleting the watched
/// root out from under the watcher. Empirically (this repo's Windows
/// evidence machine), the `notify` backend does NOT surface an error
/// callback when the watched root itself disappears -- no error, no event,
/// ever, again. Backend-error re-attach alone cannot catch this; the
/// watcher's independent periodic root-health check is what must.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_watcher_marks_unavailable_after_the_watched_root_is_deleted() {
    let ws = Scratch::new();
    let actor =
        dohc_engine_files::FilesActor::spawn_async(ws.path().to_path_buf(), ScanBounds::default())
            .await
            .expect("actor");
    let handle = actor.handle();
    let ready = NativeWatcher::start(
        ws.path().to_path_buf(),
        handle.clone(),
        CancellationToken::new(),
    )
    .await
    .expect("watch start");
    let mut watcher = ready.watcher;
    apply_and_ack(&handle, ready.initial_reconcile).await;
    assert!(!watcher.is_degraded());
    assert!(!watcher.is_unavailable());

    std::fs::remove_dir_all(ws.path()).expect("delete the watched root out from under the watch");

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if watcher.is_unavailable() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "watcher never surfaced unavailable after its root was deleted"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        watcher.is_degraded(),
        "a genuinely lost watch must also be sticky-degraded"
    );
    watcher.stop().expect("stop");
}
