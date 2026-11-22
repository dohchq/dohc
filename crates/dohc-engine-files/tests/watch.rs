use crate::common;

#[cfg(target_vendor = "apple")]
use common::FatVolume;
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

/// Linux reports each open of a watched file or folder, and a scan opens every
/// folder it walks. A scan that marked the workspace dirty would start the
/// next scan, without end.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_a_workspace_as_a_scan_does_leaves_it_clean() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    let ws = Scratch::new();
    for folder in 0..8 {
        ws.write(&format!("notes/{folder}/note.md"), b"a note");
    }
    let dirty = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&dirty);
    let mut watcher = NativeWatcher::start_metadata(
        ws.path().to_path_buf(),
        Arc::new(move || {
            counted.fetch_add(1, Ordering::AcqRel);
        }),
    )
    .await
    .expect("watch start");

    fn read_all(folder: &std::path::Path) {
        for entry in std::fs::read_dir(folder).expect("read folder") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                read_all(&path);
            } else {
                std::fs::read(&path).expect("read file");
            }
        }
    }
    read_all(ws.path());
    // The watcher reports a burst once it has been quiet for WATCH_SETTLE, so
    // three of those is long enough for a report of the reads to arrive.
    tokio::time::sleep(dohc_engine_files::watch::WATCH_SETTLE * 3).await;
    assert_eq!(
        dirty.load(Ordering::Acquire),
        0,
        "reading marked the workspace dirty"
    );

    // The same watcher still reports a write.
    ws.write("notes/0/new.md", b"new");
    let deadline = Instant::now() + Duration::from_secs(5);
    while dirty.load(Ordering::Acquire) == 0 {
        assert!(Instant::now() < deadline, "the write was not reported");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    watcher.stop().expect("stop");
}

/// Delete-then-recreate the watched root inside the health
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

/// A folder the watcher cannot read is reported as an error that names it,
/// while the watch on the rest of the workspace keeps working. Taking that
/// error for a lost watch attaches again, meets the same folder, and attaches
/// again, rescanning each time. Once the folder can be read, changes inside it
/// must be reported too.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_folder_is_not_taken_for_a_lost_watch() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    let ws = Scratch::new();
    ws.write("locked/note.md", b"a note");
    let locked = ws.path().join("locked");
    let mode = |bits| std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(bits));
    mode(0o000).expect("lock the folder");
    if std::fs::read_dir(&locked).is_ok() {
        mode(0o755).expect("unlock the folder");
        eprintln!("SKIP: this user can read a folder with mode 000");
        return;
    }
    let dirty = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&dirty);
    let mut watcher = NativeWatcher::start_metadata(
        ws.path().to_path_buf(),
        Arc::new(move || {
            counted.fetch_add(1, Ordering::AcqRel);
        }),
    )
    .await
    .expect("watch start");

    tokio::time::sleep(dohc_engine_files::watch::WATCH_SETTLE * 3).await;
    assert_eq!(
        watcher.disruption_count(),
        0,
        "the watch was attached again {} times and marked dirty {} times",
        watcher.disruption_count(),
        dirty.load(Ordering::Acquire)
    );

    let before = dirty.load(Ordering::Acquire);
    ws.write("after.md", b"after");
    let deadline = Instant::now() + Duration::from_secs(5);
    while dirty.load(Ordering::Acquire) == before {
        assert!(Instant::now() < deadline, "the write was not reported");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    mode(0o755).expect("unlock the folder");
    tokio::time::sleep(dohc_engine_files::watch::WATCH_SETTLE * 3).await;
    let before = dirty.load(Ordering::Acquire);
    ws.write("locked/later.md", b"later");
    let deadline = Instant::now() + Duration::from_secs(5);
    while dirty.load(Ordering::Acquire) == before {
        assert!(
            Instant::now() < deadline,
            "a write inside the folder was not reported after it became readable"
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    watcher.stop().expect("stop");
}

/// A FAT32 volume stores a name that is not UTF-8 percent-encoded but reports
/// its raw bytes to FSEvents. A panic in the FSEvents callback cannot unwind
/// through CoreServices and aborts the engine, so the watcher must keep
/// reporting changes after such a name.
#[cfg(target_vendor = "apple")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_watcher_survives_a_name_that_is_not_utf8() {
    use std::os::unix::ffi::OsStrExt;
    let scratch = Scratch::new();
    let Some(volume) = FatVolume::attach(scratch.path()) else {
        eprintln!("SKIP: hdiutil could not attach a FAT32 image here");
        return;
    };
    let root = volume.mount.join("ws");
    std::fs::create_dir(&root).expect("workspace on the FAT32 volume");
    let actor = dohc_engine_files::FilesActor::spawn_async(root.clone(), ScanBounds::default())
        .await
        .expect("actor");
    let handle = actor.handle();
    let ready = NativeWatcher::start(root.clone(), handle.clone(), CancellationToken::new())
        .await
        .expect("watch start");
    let mut watcher = ready.watcher;
    apply_and_ack(&handle, ready.initial_reconcile).await;

    std::fs::write(root.join(std::ffi::OsStr::from_bytes(b"\xff.md")), b"raw")
        .expect("FAT32 takes a name that is not UTF-8");
    wait_dirty(&handle).await;
    let run = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("reconcile the raw-byte name");
    apply_and_ack(&handle, run).await;

    std::fs::write(root.join("after.md"), b"after").expect("ordinary file");
    wait_dirty(&handle).await;
    let run = handle
        .reconcile_if_dirty(CancellationToken::new())
        .await
        .expect("reconcile the ordinary file");
    let plan = apply_and_ack(&handle, run).await;
    assert!(
        plan.ops
            .iter()
            .any(|op| matches!(op, CaptureOp::Ingest { path, .. } if path == "after.md")),
        "{:?}",
        plan.ops
    );
    watcher.stop().expect("stop");
    drop(actor);
}

/// When a burst of changes overflows the `ReadDirectoryChangesW` buffer,
/// Windows drops their details and completes the next read with zero bytes or
/// `ERROR_NOTIFY_ENUM_DIR`. The backend must report that as a rescan, which the
/// engine takes as a change like any other.
#[cfg(windows)]
#[test]
fn windows_overflow_is_reported_as_a_rescan() {
    use notify::{RecursiveMode, Watcher};
    use std::sync::mpsc;

    let scratch = Scratch::new();
    let (events_tx, events) = mpsc::channel();
    let (held_tx, held) = mpsc::channel();
    let (release_tx, release) = mpsc::channel::<()>();
    let mut hold = Some((held_tx, release));
    let mut watcher = notify::RecommendedWatcher::new(
        move |event: notify::Result<notify::Event>| {
            // Hold the backend's thread on the first event, so the burst below
            // overflows the buffer before the backend reads it again.
            if let Some((held_tx, release)) = hold.take() {
                let _ = held_tx.send(());
                let _ = release.recv();
            }
            let _ = events_tx.send(event);
        },
        notify::Config::default(),
    )
    .expect("watcher");
    watcher
        .watch(scratch.path(), RecursiveMode::Recursive)
        .expect("watch");

    std::fs::write(scratch.path().join("first.md"), b"first").expect("first change");
    held.recv_timeout(Duration::from_secs(10))
        .expect("the first change reached the handler");
    // Each entry takes about 140 bytes, so 2000 files overflow the 64 KiB buffer.
    let pad = "x".repeat(48);
    for i in 0..2000 {
        std::fs::write(scratch.path().join(format!("burst-{i:04}-{pad}.md")), b"")
            .expect("burst file");
    }
    drop(release_tx);

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(event)) if event.need_rescan() => break,
            Ok(_) => {}
            Err(_) => panic!("the overflow was never reported as a rescan"),
        }
    }
}
