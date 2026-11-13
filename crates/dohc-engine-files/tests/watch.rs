use crate::common;

use common::Scratch;
use dohc_engine_files::{
    CancellationToken, CaptureError, CaptureOp, CaptureSink, FilesHandle, IngestOutcome,
    IngestReason, NativeWatcher, ReconcileRun, RetireOutcome, ScanBounds, apply_reconcile_plan,
};
use dohc_engine_storage::NoFaults;

use std::time::{Duration, Instant};

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

/// R14 F1 regression: delete-then-recreate the watched root inside the health
/// poll window. The recreated directory exists (so an existence-only check
/// would see a healthy directory and do nothing), but the OS watch is still
/// bound to the DELETED object -- so a file created in the new root would be
/// silently missed forever. The identity-based health check must catch the
/// swap, reattach to the new directory, and surface the change (either as a
/// dirty generation, or as `is_unavailable` if reattach cannot recover).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_root_delete_recreate_race_is_not_silently_missed() {
    let ws = Scratch::new();
    let root = ws.path().to_path_buf();
    let actor = dohc_engine_files::FilesActor::spawn_async(root.clone(), ScanBounds::default())
        .await
        .expect("actor");
    let handle = actor.handle();
    let ready = NativeWatcher::start(root.clone(), handle.clone(), CancellationToken::new())
        .await
        .expect("watch start");
    let mut watcher = ready.watcher;
    apply_and_ack(&handle, ready.initial_reconcile).await;
    assert!(!handle.stats().await.expect("stats").dirty);

    // Delete then immediately recreate the root as a new directory object --
    // the race the reviewer identified (403us on Windows, always winnable).
    std::fs::remove_dir_all(&root).expect("delete root");
    std::fs::create_dir(&root).expect("recreate root");

    wait_dirty(&handle).await;

    // Prove the reattached watch is live on the new directory (not the dead
    // object): after clearing dirty, a fresh write into the recreated root
    // must produce new dirty evidence.
    let run = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("reconcile after swap");
    apply_and_ack(&handle, run).await;
    assert!(!handle.stats().await.expect("clean after swap").dirty);

    ws.write("after-recreate.md", b"must be seen by the reattached watch");
    wait_dirty(&handle).await;
    let deleted = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("reconcile new file");
    let plan = apply_and_ack(&handle, deleted).await;
    assert!(
        plan.ops
            .iter()
            .any(|op| matches!(op, CaptureOp::Ingest { path, .. } if path == "after-recreate.md")),
        "the file created in the recreated root was not captured -- the watch is silently dead"
    );

    watcher.stop().expect("stop");
}
