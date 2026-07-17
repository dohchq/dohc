//! Native watcher lifecycle plus the injectable event vocabulary.
//!
//! `notify` and the debounce state live on one dedicated OS thread. The actor's
//! blocking scan/command loop is never run from an OS callback. Every settled
//! burst (including a backend error/overflow) reduces to the actor's sticky
//! [`FilesHandle::notify_overflow`](crate::FilesHandle::notify_overflow) bit;
//! the dirty-generation model then performs a full bounded rescan.
//!
//! No watcher-side floor filter is needed. A `.dohc/engine/engine.db-wal`
//! notification may mark dirty, but the rescan excludes it through
//! [`crate::floor`], producing an empty diff rather than a self-generated
//! capture loop. Symlink notifications are likewise harmless: the scanner uses
//! lstat and never descends through a symlink, so only real in-root content can
//! reach a capture plan.

use crate::reconcile::ReconcileController;
use crate::{CancellationToken, FilesError, FilesHandle, ReconcileRun};
use notify::{RecursiveMode, Watcher};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Quiet period after the newest event before one coalesced dirty signal.
pub const WATCH_SETTLE: Duration = Duration::from_millis(500);
/// Hard deadline from the first event in a continuous burst (TS: settle * 8).
pub const WATCH_HARD_DEADLINE: Duration = Duration::from_secs(4);
/// Bound on raw callback/control messages before further events coalesce into
/// the already-queued evidence that the generation is dirty.
pub const WATCH_EVENT_QUEUE_CAPACITY: usize = 256;
/// Bound on how long [`NativeWatcher::start`] waits for the dedicated watcher
/// thread to attach the OS watch before giving up. `notify` offers no
/// cancellable attach primitive, so a startup that never signals ready would
/// otherwise hang the caller (a workspace open) forever.
pub const WATCH_STARTUP_DEADLINE: Duration = Duration::from_secs(5);
/// Bounded retry count for re-attaching the OS watch after the backend
/// reports an error (including the watched root itself being replaced).
const WATCH_REATTACH_ATTEMPTS: usize = 3;
/// Backoff between reattach attempts, run inline on the dedicated watcher OS
/// thread (never the async runtime).
const WATCH_REATTACH_BACKOFF: Duration = Duration::from_millis(200);
/// How often the idle watcher thread verifies the watched root still exists
/// as a directory. On at least one real backend (observed: the Windows
/// `ReadDirectoryChangesW` path), deleting the watched root produces NO
/// error callback at all -- the watch simply goes silently dead, with no
/// event, no error, no further notifications, ever. Backend-error re-attach
/// alone cannot catch that case, so this is a small, bounded, independent
/// liveness check: cheap (`symlink_metadata`, once per interval, only while
/// otherwise idle), and it is what actually catches "watched root replaced"
/// on the platforms where the callback stays silent.
const WATCH_ROOT_HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// A watcher event. Both kinds mark the generation dirty in CAL-3 (a full
/// rescan supersedes any per-path delta), so the modeled property is
/// coalescing-without-drop, not per-path routing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// The native watcher overflowed or dropped events — uncertainty. This is
    /// the canonical dirty-generation trigger.
    Overflow,
    /// A specific path changed. Modeled for completeness.
    Changed { path: String },
}

/// Apply one event to a controller: any event marks the generation dirty. Never
/// drops evidence — the controller's dirty flag stays set until a completed
/// reconcile clears it.
pub fn apply_event(controller: &mut ReconcileController, _event: &WatchEvent) {
    controller.mark_dirty();
}

/// An injectable stub event source: a bounded queue a test loads with events,
/// then drains into a controller. Stands in for the real native watcher.
#[derive(Debug, Default)]
pub struct StubWatchSource {
    queue: VecDeque<WatchEvent>,
    capacity: usize,
}

impl StubWatchSource {
    /// A stub source bounded to `capacity` queued events. Pushing beyond the
    /// bound is itself modeled as an overflow (the newest event is coalesced
    /// into an `Overflow`, never silently dropped).
    pub fn new(capacity: usize) -> Self {
        StubWatchSource {
            queue: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    /// Push an event. If the bounded queue is full, the queue is collapsed to a
    /// single `Overflow` — coalescing under pressure, never dropping the
    /// evidence that *something* changed.
    pub fn push(&mut self, event: WatchEvent) {
        if self.queue.len() >= self.capacity {
            self.queue.clear();
            self.queue.push_back(WatchEvent::Overflow);
            return;
        }
        self.queue.push_back(event);
    }

    /// Number of queued events.
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// Whether the source is empty.
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Drain every queued event into the controller, marking it dirty if any
    /// event was present. Returns whether the controller was marked dirty.
    pub fn drain_into(&mut self, controller: &mut ReconcileController) -> bool {
        let had_events = !self.queue.is_empty();
        for event in self.queue.drain(..) {
            apply_event(controller, &event);
        }
        had_events
    }
}

enum ThreadMessage {
    Event,
    /// The notify backend reported an error on its callback thread. Distinct
    /// from `Event` so the watcher thread's main loop can attempt a bounded
    /// re-attach without perturbing the settle/hard-deadline event timers.
    BackendError,
    Stop,
}

/// A started native watcher plus the initial serialized reconcile result. The
/// watcher is already attached before the scan begins, so changes racing the
/// initial scan leave a subsequent sticky dirty signal rather than disappearing
/// between "scan" and "watch".
pub struct WatchStart {
    pub watcher: NativeWatcher,
    pub initial_reconcile: ReconcileRun,
}

/// Owns the native watch/debounce thread. [`NativeWatcher::stop`] joins it, so
/// no notification can arrive after stop returns.
pub struct NativeWatcher {
    stop_tx: SyncSender<ThreadMessage>,
    degraded: Arc<AtomicBool>,
    unavailable: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl NativeWatcher {
    /// Attach the recursive OS watch, wait until it is ready, then serialize an
    /// initial full reconcile through the files actor. The returned plan still
    /// requires the normal capture apply/ack phase.
    pub async fn start(
        root: PathBuf,
        handle: FilesHandle,
        token: CancellationToken,
    ) -> Result<WatchStart, FilesError> {
        let (message_tx, message_rx) = mpsc::sync_channel(WATCH_EVENT_QUEUE_CAPACITY);
        let stop_tx = message_tx.clone();
        let degraded = Arc::new(AtomicBool::new(false));
        let unavailable = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let thread_handle = handle.clone();
        let thread_degraded = Arc::clone(&degraded);
        let thread_unavailable = Arc::clone(&unavailable);
        let worker = std::thread::Builder::new()
            .name("dohc-native-watcher".to_owned())
            .spawn(move || {
                watcher_thread(
                    root,
                    thread_handle,
                    message_rx,
                    message_tx,
                    thread_degraded,
                    thread_unavailable,
                    ready_tx,
                );
            })
            .map_err(|_| FilesError::WatcherUnavailable {
                reason: "could not spawn watcher thread",
            })?;
        let mut watcher = NativeWatcher {
            stop_tx,
            degraded,
            unavailable,
            worker: Some(worker),
        };
        if let Err(err) = await_ready_with_deadline(
            WATCH_STARTUP_DEADLINE,
            ready_rx,
            &mut watcher.worker,
            &watcher.unavailable,
        )
        .await
        {
            // Safe and fast on every branch: the two "thread already ended"
            // cases join a thread that is already finishing, and the timeout
            // case already detached `worker` (it is `None`), so `stop()` is a
            // no-op there.
            let _ = watcher.stop();
            return Err(err);
        }
        let initial_reconcile = match handle.reconcile_if_dirty(token).await {
            Ok(run) => run,
            Err(err) => {
                let _ = watcher.stop();
                return Err(err);
            }
        };
        Ok(WatchStart {
            watcher,
            initial_reconcile,
        })
    }

    /// Stop accepting events, flush one pending burst before shutdown, drop the
    /// OS watch, and join the thread. Idempotent.
    pub fn stop(&mut self) -> Result<(), FilesError> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        let _ = self.stop_tx.send(ThreadMessage::Stop);
        worker.join().map_err(|_| FilesError::WatcherUnavailable {
            reason: "watcher thread panicked",
        })
    }

    /// Whether the notify backend has reported an error since startup. Sticky
    /// so a supervisor can observe watcher loss even after a rescan completes.
    /// Set alongside [`NativeWatcher::is_unavailable`] on every backend error;
    /// unlike that flag, it stays true even after a successful re-attach.
    pub fn is_degraded(&self) -> bool {
        self.degraded.load(Ordering::Acquire)
    }

    /// Whether the OS watch is genuinely, permanently lost: either the
    /// watcher's bounded re-attach retries were exhausted after a backend
    /// error, or startup itself timed out. A caller observing this should
    /// restart the watcher (and, transitively, the workspace it backs)
    /// rather than continue relying on a dead watch. Distinct from
    /// [`NativeWatcher::is_degraded`], which stays set even after a
    /// successful re-attach.
    pub fn is_unavailable(&self) -> bool {
        self.unavailable.load(Ordering::Acquire)
    }
}

impl Drop for NativeWatcher {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Wait for the watcher thread's startup handshake, bounded by `deadline`.
/// Factored out of [`NativeWatcher::start`] so the bounded-wait/detach-and-
/// reap behavior is directly unit-testable against a fake `ready` channel and
/// a fake worker, without a real `notify` backend.
async fn await_ready_with_deadline(
    deadline: Duration,
    ready_rx: tokio::sync::oneshot::Receiver<Result<(), FilesError>>,
    worker: &mut Option<JoinHandle<()>>,
    unavailable: &AtomicBool,
) -> Result<(), FilesError> {
    match tokio::time::timeout(deadline, ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err(FilesError::WatcherUnavailable {
            reason: "watcher thread ended during startup",
        }),
        Err(_) => {
            // The worker has not signaled readiness within the deadline.
            // `notify`'s attach call is not cancellable, so it may genuinely
            // be stuck in a native OS call; synchronously joining it here
            // would risk hanging this caller too. Detach the join onto a
            // background reaper thread instead: this caller gets a bounded,
            // observable failure now, and the worker is still eventually
            // reclaimed if/when the OS call returns, rather than a
            // synchronous hang OR a silently forgotten thread.
            if let Some(worker) = worker.take() {
                let _ = std::thread::Builder::new()
                    .name("dohc-native-watcher-startup-reaper".to_owned())
                    .spawn(move || {
                        let _ = worker.join();
                    });
            }
            unavailable.store(true, Ordering::Release);
            Err(FilesError::WatcherUnavailable {
                reason: "native watcher startup timed out",
            })
        }
    }
}

fn watcher_thread(
    root: PathBuf,
    handle: FilesHandle,
    rx: Receiver<ThreadMessage>,
    callback_tx: SyncSender<ThreadMessage>,
    degraded: Arc<AtomicBool>,
    unavailable: Arc<AtomicBool>,
    ready: tokio::sync::oneshot::Sender<Result<(), FilesError>>,
) {
    let config = notify::Config::default().with_follow_symlinks(false);
    let callback_handle = handle.clone();
    let error_callback_tx = callback_tx.clone();
    let loop_degraded = Arc::clone(&degraded);
    let mut watcher = match notify::RecommendedWatcher::new(
        move |event: Result<notify::Event, notify::Error>| {
            if event.is_err() {
                degraded.store(true, Ordering::Release);
                callback_handle.notify_overflow();
                // Ask the watcher thread's main loop to attempt a bounded
                // re-attach (it owns the `notify::Watcher`, not this
                // callback). A full queue already contains abundant evidence
                // of a change, so a coalesced signal here is never lost work.
                let _ = error_callback_tx.try_send(ThreadMessage::BackendError);
            }
            // A full queue already contains abundant evidence of a change, so
            // further callbacks coalesce without allocating unbounded memory.
            let _ = callback_tx.try_send(ThreadMessage::Event);
        },
        config,
    ) {
        Ok(watcher) => watcher,
        Err(_) => {
            let _ = ready.send(Err(FilesError::WatcherUnavailable {
                reason: "native watcher backend could not be created",
            }));
            return;
        }
    };
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        let _ = ready.send(Err(FilesError::WatcherUnavailable {
            reason: "workspace root could not be watched",
        }));
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }

    let mut first_event: Option<Instant> = None;
    let mut settle_at: Option<Instant> = None;
    loop {
        let message = match (first_event, settle_at) {
            (Some(first), Some(settle)) => {
                let deadline = first + WATCH_HARD_DEADLINE;
                let next = settle.min(deadline);
                match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => {
                        handle.notify_overflow();
                        first_event = None;
                        settle_at = None;
                        None
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            // Idle: no burst in progress. Wake periodically (rather than
            // blocking on `rx.recv()` forever) to independently verify the
            // watched root still exists -- see `WATCH_ROOT_HEALTH_POLL_INTERVAL`.
            _ => match rx.recv_timeout(WATCH_ROOT_HEALTH_POLL_INTERVAL) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => {
                    if !unavailable.load(Ordering::Acquire) && !root_is_healthy(&root) {
                        loop_degraded.store(true, Ordering::Release);
                        handle.notify_overflow();
                        attempt_reattach(&mut watcher, &root, &unavailable);
                    }
                    None
                }
                Err(RecvTimeoutError::Disconnected) => break,
            },
        };
        match message {
            Some(ThreadMessage::Event) => {
                let now = Instant::now();
                if first_event.is_some_and(|first| {
                    now.saturating_duration_since(first) >= WATCH_HARD_DEADLINE
                }) {
                    // A ready queued event must not postpone the hard bound:
                    // publish the whole burst even when the queue never drains.
                    handle.notify_overflow();
                    first_event = None;
                    settle_at = None;
                } else {
                    first_event.get_or_insert(now);
                    settle_at = Some(now + WATCH_SETTLE);
                }
            }
            Some(ThreadMessage::BackendError) => {
                if !unavailable.load(Ordering::Acquire) {
                    attempt_reattach(&mut watcher, &root, &unavailable);
                }
            }
            Some(ThreadMessage::Stop) => {
                // Final-flush parity: pending evidence is published before the
                // thread exits; join guarantees it cannot publish afterward.
                if first_event.is_some() {
                    handle.notify_overflow();
                }
                break;
            }
            None => {}
        }
    }
    drop(watcher);
}

/// Bounded re-attach after the backend reports an error (including the
/// watched root itself being deleted or replaced, a real case on both
/// inotify and `ReadDirectoryChangesW`): retry `watch()` on the SAME owned
/// `notify::Watcher` a fixed number of times with a small backoff, run
/// inline on this dedicated watcher OS thread (never the async runtime, and
/// never unbounded — a dead watch must not spin this thread forever).
///
/// On success, further events resume flowing normally; [`NativeWatcher::
/// is_degraded`] stays sticky-true (a real disruption did happen), but
/// [`NativeWatcher::is_unavailable`] stays false. On exhaustion, the watch is
/// treated as permanently lost: `unavailable` is set so a supervisor can
/// observe it and restart the watcher/workspace instead of silently running
/// with a dead watch forever.
fn attempt_reattach(
    watcher: &mut notify::RecommendedWatcher,
    root: &Path,
    unavailable: &AtomicBool,
) {
    for attempt in 0..WATCH_REATTACH_ATTEMPTS {
        if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
            return;
        }
        if attempt + 1 < WATCH_REATTACH_ATTEMPTS {
            std::thread::sleep(WATCH_REATTACH_BACKOFF);
        }
    }
    unavailable.store(true, Ordering::Release);
}

/// Whether `root` still exists as a directory (lstat, matching this crate's
/// never-follow-into-a-symlink convention elsewhere -- `scan.rs`,
/// `reconcile.rs`'s `StdAbsenceProbe`). Any error (not found, permission
/// denied, or anything else) is treated as unhealthy: this feeds a
/// re-attach attempt, never a silent skip.
fn root_is_healthy(root: &Path) -> bool {
    std::fs::symlink_metadata(root)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

/// R14 robustness coverage: bounded re-attach and the startup deadline.
/// [`attempt_reattach`] and [`await_ready_with_deadline`] are exercised
/// directly (white-box) here because deterministically forcing a REAL
/// `notify` backend to hang, specifically, is not practical in a fast unit
/// test; the end-to-end wiring (a deleted watched root eventually surfacing
/// as [`NativeWatcher::is_unavailable`]) is covered separately in
/// `tests/watch.rs` against the real backend.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::time::Instant;

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    /// A fresh, existing, watchable temp directory (removed on drop).
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "dohc-r14-watch-{}-{}",
                std::process::id(),
                UNIQUE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).expect("create temp root");
            TempRoot(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn silent_watcher() -> notify::RecommendedWatcher {
        let config = notify::Config::default().with_follow_symlinks(false);
        notify::RecommendedWatcher::new(|_event: Result<notify::Event, notify::Error>| {}, config)
            .expect("notify backend available in test environment")
    }

    #[test]
    fn reattach_succeeds_immediately_against_a_watchable_root() {
        let root = TempRoot::new();
        let mut watcher = silent_watcher();
        let unavailable = AtomicBool::new(false);

        attempt_reattach(&mut watcher, &root.0, &unavailable);

        assert!(
            !unavailable.load(Ordering::Acquire),
            "a successful re-attach must not mark the watch unavailable"
        );
    }

    #[test]
    fn reattach_exhausts_bounded_retries_against_an_unwatchable_root() {
        let bogus_root =
            std::env::temp_dir().join("dohc-r14-watch-reattach-bogus-path-does-not-exist");
        let _ = std::fs::remove_dir_all(&bogus_root);
        let mut watcher = silent_watcher();
        let unavailable = AtomicBool::new(false);

        let started = Instant::now();
        attempt_reattach(&mut watcher, &bogus_root, &unavailable);
        let elapsed = started.elapsed();

        assert!(
            unavailable.load(Ordering::Acquire),
            "exhausting the bounded retries must mark the watch unavailable"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "bounded re-attach retries must not run long/unbounded: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn startup_within_deadline_reports_ready_without_touching_unavailable() {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let _ = ready_tx.send(Ok(()));
        let mut worker: Option<JoinHandle<()>> = Some(std::thread::spawn(|| {}));
        let unavailable = AtomicBool::new(false);

        let result =
            await_ready_with_deadline(Duration::from_secs(5), ready_rx, &mut worker, &unavailable)
                .await;

        assert!(result.is_ok());
        assert!(!unavailable.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn startup_timeout_detaches_the_worker_instead_of_blocking_on_it() {
        // The sender is deliberately leaked (never sent, never dropped) to
        // simulate a worker thread stuck inside a native OS call that never
        // signals readiness.
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), FilesError>>();
        std::mem::forget(ready_tx);
        let mut worker: Option<JoinHandle<()>> = Some(std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(500));
        }));
        let unavailable = AtomicBool::new(false);

        let started = Instant::now();
        let result = await_ready_with_deadline(
            Duration::from_millis(20),
            ready_rx,
            &mut worker,
            &unavailable,
        )
        .await;
        let elapsed = started.elapsed();

        assert!(
            result.is_err(),
            "a startup timeout must surface as an error"
        );
        assert!(
            unavailable.load(Ordering::Acquire),
            "a startup timeout must mark the watch unavailable"
        );
        assert!(
            worker.is_none(),
            "the worker handle must be detached (reaped in the background), not kept for a synchronous join"
        );
        assert!(
            elapsed < Duration::from_millis(400),
            "the startup deadline must not block on the slow worker thread: {elapsed:?}"
        );
    }
}
