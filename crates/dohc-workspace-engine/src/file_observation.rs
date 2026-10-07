use crate::events::EngineEvents;
use crate::lock;
use dohc_engine_files::observation::{
    ObservationChanges, ObservationCursor, ObservationFeed, ObservationWalker,
};
use dohc_engine_files::watch::{WATCH_STARTUP_DEADLINE, WatchMonitor};
use dohc_engine_files::{CancellationToken, FilesError, FilesHandle, NativeWatcher, ScanBounds};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

type DrainRequest = (
    CancellationToken,
    tokio::sync::oneshot::Sender<Result<(), FilesError>>,
);

fn watch_dirty_signal(
    dirty: Arc<AtomicBool>,
    capture: Arc<Mutex<Option<(u64, FilesHandle)>>>,
) -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(move || {
        dirty.store(true, Ordering::Release);
        if let Some((_, files)) = lock(&capture).as_ref() {
            files.notify_overflow();
        }
    })
}

#[derive(Clone)]
pub(crate) struct ObservationHandle {
    requests: std::sync::mpsc::SyncSender<DrainRequest>,
    monitor: WatchMonitor,
}

/// Owns the observation worker and its native watcher through a joinable thread.
/// That thread has its own runtime, so Drop can join even during runtime teardown.
pub(crate) struct FileObservation {
    pub(crate) feed: ObservationFeed,
    events: EngineEvents,
    workspace_id: String,
    pub(crate) files: tokio::sync::watch::Sender<Option<ObservationHandle>>,
    startup_finished: tokio::sync::watch::Sender<bool>,
    capture: Arc<Mutex<Option<(u64, FilesHandle)>>>,
    next_capture: AtomicU64,
    cancel: CancellationToken,
    runtime: tokio::runtime::Handle,
    shutdown_started: AtomicBool,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    wake: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub(crate) struct CaptureWatch {
    binding: Arc<FileObservation>,
    id: u64,
    monitor: WatchMonitor,
}
impl CaptureWatch {
    pub(crate) fn is_unavailable(&self) -> bool {
        self.monitor.is_unavailable()
    }
    pub(crate) fn disruption_count(&self) -> u64 {
        self.monitor.disruption_count()
    }
}
impl Drop for CaptureWatch {
    fn drop(&mut self) {
        let mut slot = lock(&self.binding.capture);
        if slot.as_ref().is_some_and(|(id, _)| *id == self.id) {
            *slot = None;
        }
    }
}

impl FileObservation {
    pub(crate) fn new(events: EngineEvents, workspace_id: String) -> Arc<Self> {
        let binding = Arc::new(Self {
            feed: ObservationFeed::new(),
            events: events.clone(),
            workspace_id: workspace_id.clone(),
            files: tokio::sync::watch::channel(None).0,
            startup_finished: tokio::sync::watch::channel(false).0,
            capture: Arc::new(Mutex::new(None)),
            next_capture: AtomicU64::new(0),
            cancel: CancellationToken::new(),
            runtime: tokio::runtime::Handle::current(),
            shutdown_started: AtomicBool::new(false),
            worker: Mutex::new(None),
            wake: Mutex::new(None),
        });
        let mut wake = binding.feed.subscribe();
        let mut attached = binding.files.subscribe();
        let cancel = binding.cancel.clone();
        *lock(&binding.wake) = Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => break,
                    changed = wake.changed() => { if changed.is_err() { break; } }
                    changed = attached.changed() => { if changed.is_err() { break; } }
                }
                let cursor = wake.borrow_and_update().clone();
                if attached.borrow_and_update().is_some() {
                    events.emit_files_changed(&workspace_id, cursor);
                }
            }
            events.remove_files_wake(&workspace_id, &wake.borrow().generation);
        }));
        binding
    }

    pub(crate) fn start(self: &Arc<Self>, root: PathBuf) -> Result<(), FilesError> {
        let files = self.files.clone();
        let startup_finished = self.startup_finished.clone();
        let cancel = self.cancel.clone();
        let feed = self.feed.clone();
        let capture = Arc::clone(&self.capture);
        let worker = std::thread::Builder::new()
            .name("dohc-file-observation".to_owned())
            .spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    startup_finished.send_replace(true);
                    return;
                };
                let walker = ObservationWalker::new(ScanBounds::default(), feed);
                let mut failures: u32 = 0;
                while !cancel.is_cancelled() {
                    let dirty = Arc::new(AtomicBool::new(true));
                    let started = runtime.block_on(NativeWatcher::start_metadata(
                        root.clone(),
                        watch_dirty_signal(Arc::clone(&dirty), Arc::clone(&capture)),
                    ));
                    if started.is_err() {
                        startup_finished.send_replace(true);
                    }
                    if let Ok(mut watcher) = started {
                        let (tx, rx) = std::sync::mpsc::sync_channel::<DrainRequest>(256);
                        files.send_replace(Some(ObservationHandle {
                            requests: tx,
                            monitor: watcher.monitor(),
                        }));
                        startup_finished.send_replace(true);
                        dirty.swap(false, Ordering::AcqRel);
                        if matches!(walker.observe(&root, &cancel), Ok(true)) {
                            failures = 0;
                            while !cancel.is_cancelled() && !watcher.is_unavailable() {
                                match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                                    Ok((token, reply)) => {
                                        dirty.swap(false, Ordering::AcqRel);
                                        let result =
                                            walker.observe(&root, &token).and_then(|complete| {
                                                if complete {
                                                    Ok(())
                                                } else {
                                                    Err(FilesError::ActorUnavailable)
                                                }
                                            });
                                        if result.is_err() {
                                            dirty.store(true, Ordering::Release);
                                        }
                                        let _ = reply.send(result);
                                    }
                                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                        if dirty.swap(false, Ordering::AcqRel)
                                            && !matches!(walker.observe(&root, &cancel), Ok(true))
                                        {
                                            break;
                                        }
                                    }
                                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                                }
                            }
                        }
                        files.send_replace(None);
                        let _ = watcher.stop();
                    }
                    failures = failures.saturating_add(1);
                    runtime.block_on(async { tokio::select! {
                    () = cancel.cancelled() => {},
                    () = tokio::time::sleep(crate::capture_driver::restart_delay(failures)) => {},
                }});
                }
                files.send_replace(None);
                startup_finished.send_replace(true);
            })
            .map_err(|_| {
                self.startup_finished.send_replace(true);
                FilesError::ActorUnavailable
            })?;
        *lock(&self.worker) = Some(worker);
        Ok(())
    }

    pub(crate) async fn attach_capture(
        self: &Arc<Self>,
        handle: FilesHandle,
        cancel: &CancellationToken,
    ) -> Result<CaptureWatch, FilesError> {
        if cancel.is_cancelled() || self.cancel.is_cancelled() {
            return Err(FilesError::ActorUnavailable);
        }
        let id = self.next_capture.fetch_add(1, Ordering::Relaxed);
        handle.notify_overflow();
        *lock(&self.capture) = Some((id, handle));
        let mut startup_finished = self.startup_finished.subscribe();
        // The first attempt publishes its outcome before the walk or backoff.
        // Later capture restarts use the current watcher without waiting for retries.
        tokio::select! {
            () = cancel.cancelled() => return Err(FilesError::ActorUnavailable),
            () = self.cancel.cancelled() => return Err(FilesError::ActorUnavailable),
            result = tokio::time::timeout(WATCH_STARTUP_DEADLINE, startup_finished.wait_for(|done| *done)) => {
                match result {
                    Ok(Ok(_)) => {},
                    Ok(Err(_)) => return Err(FilesError::ActorUnavailable),
                    Err(_) => return Err(FilesError::WatcherUnavailable {
                        reason: "file-observation startup timed out",
                    }),
                }
            }
        }
        let monitor = self
            .files
            .borrow()
            .as_ref()
            .filter(|handle| !handle.monitor.is_unavailable())
            .map(|handle| handle.monitor.clone())
            .ok_or(FilesError::WatcherUnavailable {
                reason: "file-observation-unavailable",
            })?;
        Ok(CaptureWatch {
            binding: Arc::clone(self),
            id,
            monitor,
        })
    }

    pub(crate) async fn drain(&self, token: CancellationToken) -> Result<(), FilesError> {
        let handle = self
            .files
            .borrow()
            .clone()
            .ok_or(FilesError::ActorUnavailable)?;
        if self.cancel.is_cancelled() || handle.monitor.is_unavailable() {
            return Err(FilesError::ActorUnavailable);
        }
        let (reply, response) = tokio::sync::oneshot::channel();
        handle
            .requests
            .try_send((token.clone(), reply))
            .map_err(|error| match error {
                std::sync::mpsc::TrySendError::Full(_) => FilesError::Overloaded,
                std::sync::mpsc::TrySendError::Disconnected(_) => FilesError::ActorUnavailable,
            })?;
        tokio::select! {
            () = token.cancelled() => Err(FilesError::ActorUnavailable),
            () = self.cancel.cancelled() => Err(FilesError::ActorUnavailable),
            result = response => result.map_err(|_| FilesError::ActorUnavailable)?,
        }
    }

    pub(crate) fn changes_since(&self, cursor: Option<&ObservationCursor>) -> ObservationChanges {
        let mut changes = self.feed.changes_since(cursor);
        changes.ready &= self
            .files
            .borrow()
            .as_ref()
            .is_some_and(|handle| !handle.monitor.is_unavailable())
            && !self.cancel.is_cancelled();
        changes
    }
    pub(crate) fn request_shutdown(&self) {
        self.cancel.cancel();
        if let Some(handle) = self.files.borrow().as_ref() {
            // Wake an idle worker so synchronous teardown does not wait for its poll.
            let (reply, _) = tokio::sync::oneshot::channel();
            let _ = handle.requests.try_send((self.cancel.clone(), reply));
        }
    }
    pub(crate) fn close_synchronously(&self) {
        self.request_shutdown();
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
        if let Some(wake) = lock(&self.wake).take() {
            wake.abort();
        }
        self.events.remove_files_wake(
            &self.workspace_id,
            &self.feed.changes_since(None).cursor.generation,
        );
    }
    pub(crate) fn begin_shutdown(self: &Arc<Self>) -> Option<tokio::task::JoinHandle<()>> {
        self.request_shutdown();
        if self.shutdown_started.swap(true, Ordering::AcqRel) || lock(&self.worker).is_none() {
            return None;
        }
        let binding = Arc::clone(self);
        Some(
            self.runtime
                .spawn_blocking(move || binding.close_synchronously()),
        )
    }
}
impl Drop for FileObservation {
    fn drop(&mut self) {
        self.close_synchronously();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pathless_rescan_reconciles_metadata_and_capture() {
        use dohc_engine_files::{CaptureOp, ReconcileRun};

        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let token = CancellationToken::new();
        let actor = dohc_engine_files::FilesActor::spawn_async(
            root.path().to_owned(),
            ScanBounds::default(),
        )
        .await
        .unwrap();
        let handle = actor.handle();
        let ReconcileRun::Completed(initial) = handle.reconcile(token.clone()).await.unwrap()
        else {
            panic!("initial reconcile did not complete");
        };
        assert!(initial.ops.is_empty());
        let receipt = dohc_engine_files::CaptureApplyResult {
            applied_paths: vec![],
            captured: vec![],
            not_owned_paths: vec![],
            failed_applies: vec![],
            deferred_paths: vec![],
            crashed_after_durable_boundary: None,
            degraded: false,
        };
        handle.acknowledge_capture(initial, receipt).await.unwrap();
        assert!(!handle.stats().await.unwrap().dirty);

        let feed = ObservationFeed::new();
        let walker = ObservationWalker::new(ScanBounds::default(), feed.clone());
        assert!(walker.observe(root.path(), &token).unwrap());
        let cursor = feed.changes_since(None).cursor;
        let dirty = Arc::new(AtomicBool::new(false));
        let capture = Arc::new(Mutex::new(Some((0, handle.clone()))));
        std::fs::write(root.path().join("missed.md"), "lost event details").unwrap();
        assert!(!dirty.load(Ordering::Acquire));
        assert!(!handle.stats().await.unwrap().dirty);
        assert!(feed.changes_since(Some(&cursor)).facts.is_empty());

        dohc_engine_files::watch::notify_settled_rescan_for_harness(
            root.path().to_owned(),
            watch_dirty_signal(Arc::clone(&dirty), capture),
        );
        assert!(dirty.swap(false, Ordering::AcqRel));
        assert!(handle.stats().await.unwrap().dirty);
        assert!(walker.observe(root.path(), &token).unwrap());
        let changes = feed.changes_since(Some(&cursor));
        assert_eq!(changes.facts.len(), 1);
        assert_eq!(changes.facts[0].path, "missed.md");
        let ReconcileRun::Completed(plan) = handle.reconcile_if_dirty(token).await.unwrap() else {
            panic!("rescan did not cause capture reconcile");
        };
        assert!(
            matches!(plan.ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "missed.md")
        );
        tokio::task::spawn_blocking(move || drop(actor))
            .await
            .unwrap();
    }

    async fn wait_until_ready(binding: &FileObservation) {
        let mut attached = binding.files.subscribe();
        let mut wake = binding.feed.subscribe();
        while !binding.changes_since(None).ready {
            tokio::select! {
                changed = attached.changed() => changed.unwrap(),
                changed = wake.changed() => changed.unwrap(),
            }
        }
    }
    #[tokio::test]
    async fn capture_attaches_without_observation_readiness() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let binding = FileObservation::new(EngineEvents::default(), "before-walk".to_owned());
        let mut watcher = NativeWatcher::start_metadata(root.path().to_owned(), Arc::new(|| {}))
            .await
            .unwrap();
        let actor = dohc_engine_files::FilesActor::spawn_async(
            root.path().to_owned(),
            ScanBounds::default(),
        )
        .await
        .unwrap();
        let attaching = Arc::clone(&binding);
        let handle = actor.handle();
        let attach = tokio::spawn(async move {
            attaching
                .attach_capture(handle, &CancellationToken::new())
                .await
        });
        while lock(&binding.capture).is_none() {
            tokio::task::yield_now().await;
        }
        assert!(!attach.is_finished());
        assert!(lock(&binding.capture).is_some());
        let (requests, _rx) = std::sync::mpsc::sync_channel(1);
        binding.files.send_replace(Some(ObservationHandle {
            requests,
            monitor: watcher.monitor(),
        }));
        binding.startup_finished.send_replace(true);
        let registration = attach.await.unwrap().unwrap();
        assert!(!registration.is_unavailable());
        assert!(!binding.changes_since(None).ready);
        drop(registration);
        tokio::task::spawn_blocking(move || {
            drop(actor);
            watcher.stop().unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn capture_fails_without_waiting_for_observation_backoff() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let binding = FileObservation::new(EngineEvents::default(), "unattached".to_owned());
        let actor = dohc_engine_files::FilesActor::spawn_async(
            root.path().to_owned(),
            ScanBounds::default(),
        )
        .await
        .unwrap();
        binding.startup_finished.send_replace(true);
        let started = tokio::time::Instant::now();
        assert!(matches!(
            binding
                .attach_capture(actor.handle(), &CancellationToken::new())
                .await,
            Err(FilesError::WatcherUnavailable { .. })
        ));
        assert_eq!(started.elapsed(), std::time::Duration::ZERO);
        assert!(lock(&binding.capture).is_some());
        tokio::task::spawn_blocking(move || drop(actor))
            .await
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn capture_attachment_bounds_the_first_watcher_start() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let binding = FileObservation::new(EngineEvents::default(), "pending".to_owned());
        let actor = dohc_engine_files::FilesActor::spawn_async(
            root.path().to_owned(),
            ScanBounds::default(),
        )
        .await
        .unwrap();
        let started = tokio::time::Instant::now();
        assert!(matches!(
            binding
                .attach_capture(actor.handle(), &CancellationToken::new())
                .await,
            Err(FilesError::WatcherUnavailable {
                reason: "file-observation startup timed out"
            })
        ));
        assert_eq!(started.elapsed(), WATCH_STARTUP_DEADLINE);
        tokio::task::spawn_blocking(move || drop(actor))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn capture_attachment_cancels_during_the_first_watcher_start() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let binding = FileObservation::new(EngineEvents::default(), "cancelled".to_owned());
        let actor = dohc_engine_files::FilesActor::spawn_async(
            root.path().to_owned(),
            ScanBounds::default(),
        )
        .await
        .unwrap();
        for observation_cancel in [false, true] {
            *lock(&binding.capture) = None;
            let attaching = Arc::clone(&binding);
            let handle = actor.handle();
            let cancel = CancellationToken::new();
            let waiting = cancel.clone();
            let attach =
                tokio::spawn(async move { attaching.attach_capture(handle, &waiting).await });
            while lock(&binding.capture).is_none() {
                tokio::task::yield_now().await;
            }
            assert!(!attach.is_finished());
            if observation_cancel {
                binding.request_shutdown();
            } else {
                cancel.cancel();
            }
            assert!(matches!(
                attach.await.unwrap(),
                Err(FilesError::ActorUnavailable)
            ));
        }
        tokio::task::spawn_blocking(move || drop(actor))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn unattached_drain_fails_immediately() {
        let binding = FileObservation::new(EngineEvents::default(), "unattached".to_owned());
        assert!(binding.drain(CancellationToken::new()).await.is_err());
        assert!(!binding.changes_since(None).ready);
    }
    #[tokio::test]
    async fn shutdown_off_runtime_joins_once() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let binding = FileObservation::new(EngineEvents::default(), "off-runtime".to_owned());
        binding.start(root.path().to_owned()).unwrap();
        wait_until_ready(&binding).await;
        let closing = Arc::clone(&binding);
        let task = std::thread::spawn(move || closing.begin_shutdown())
            .join()
            .unwrap()
            .unwrap();
        task.await.unwrap();
        assert!(binding.begin_shutdown().is_none());
        binding.close_synchronously();
        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn native_dirty_signal_continues_after_capture_detaches() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let binding = FileObservation::new(EngineEvents::default(), "detached".to_owned());
        binding.start(root.path().to_owned()).unwrap();
        wait_until_ready(&binding).await;
        let actor = dohc_engine_files::FilesActor::spawn_async(
            root.path().to_owned(),
            ScanBounds::default(),
        )
        .await
        .unwrap();
        let registration = binding
            .attach_capture(actor.handle(), &CancellationToken::new())
            .await
            .unwrap();
        let cursor = binding.changes_since(None).cursor;
        drop(registration);
        tokio::task::spawn_blocking(move || drop(actor))
            .await
            .unwrap();
        let mut wake = binding.feed.subscribe();
        std::fs::write(root.path().join("after-capture.md"), "still observed").unwrap();
        while binding.changes_since(Some(&cursor)).facts.is_empty() {
            wake.changed().await.unwrap();
        }
        assert_eq!(
            binding.changes_since(Some(&cursor)).facts[0].path,
            "after-capture.md"
        );
        binding.begin_shutdown().unwrap().await.unwrap();
    }

    #[tokio::test]
    async fn drop_joins_watcher_and_releases_root() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let binding = FileObservation::new(EngineEvents::default(), "drop".to_owned());
        binding.start(root.path().to_owned()).unwrap();
        wait_until_ready(&binding).await;
        drop(binding);
        std::fs::remove_dir_all(root.path()).unwrap();
    }
}
