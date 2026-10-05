//! Native watcher lifecycle plus the injectable event vocabulary.
//!
//! `notify` and the debounce state live on one dedicated OS thread. The actor's
//! blocking scan/command loop is never run from an OS callback. Every settled
//! burst (including a backend error/overflow) reduces to the actor's sticky
//! [`FilesHandle::notify_overflow`](crate::FilesHandle::notify_overflow) bit;
//! the dirty-generation model then performs a full bounded rescan.
//!
//! Ordinary events strictly below `.dohc/engine` do not enter the debounce
//! queue: both capture and observation exclude that subtree. Policy files and
//! ancestor changes still trigger a rescan, as do errors and uncertain events.
//! Symlink notifications are likewise harmless: the scanner uses
//! lstat and never descends through a symlink, so only real in-root content can
//! reach a capture plan.

use crate::reconcile::ReconcileController;
use crate::{CancellationToken, FilesError, FilesHandle, ReconcileRun};
use notify::event::{
    AccessKind, AccessMode, CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind,
    RenameMode,
};
use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// How often the idle watcher thread verifies the watched root is still the
/// same directory object the OS watch was attached to. Deleting the watched
/// root produces NO error callback on either real backend we ship on -- not
/// the Windows `ReadDirectoryChangesW` path, and not Linux inotify (which
/// reports the removal as ordinary `DELETE_SELF` events and then quietly drops
/// its own watch). The watch simply goes dead, with no error, ever. Worse, a
/// delete-then-recreate of the root (restore-from-backup, unzip-over,
/// sync-client folder replace) leaves a directory at the path but the OS watch
/// still bound to the DELETED object, so existence alone cannot tell the two
/// apart. The check therefore compares the bound directory OBJECT -- see
/// [`WatchedRoot`] -- and is cheap (one `stat`, once per interval, only while
/// otherwise idle).
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
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushReason {
    HardDeadline,
    Settle,
}

#[derive(Default)]
struct WatchState {
    disruptions: AtomicU64,
    unavailable: AtomicBool,
    hard_deadline_flushes: AtomicU64,
    settle_flushes: AtomicU64,
}

impl WatchState {
    fn record_flush(&self, reason: FlushReason) {
        let counter = match reason {
            FlushReason::HardDeadline => &self.hard_deadline_flushes,
            FlushReason::Settle => &self.settle_flushes,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Debounce {
    // First event and the quiet-period deadline for the current burst.
    burst: Option<(Instant, Instant)>,
}

impl Debounce {
    fn next_deadline(&self) -> Option<Instant> {
        self.burst
            .map(|(first, settle)| settle.min(first + WATCH_HARD_DEADLINE))
    }

    /// Returns true when this event completes a burst at its hard deadline.
    fn event(&mut self, now: Instant) -> bool {
        if let Some((first, _)) = self.burst {
            if now.saturating_duration_since(first) >= WATCH_HARD_DEADLINE {
                self.burst = None;
                return true;
            }
            self.burst = Some((first, now + WATCH_SETTLE));
        } else {
            self.burst = Some((now, now + WATCH_SETTLE));
        }
        false
    }

    fn flush(&mut self) -> bool {
        self.burst.take().is_some()
    }

    fn timeout(&mut self, now: Instant) -> Option<FlushReason> {
        let (first, settle) = self.burst?;
        let hard_deadline = first + WATCH_HARD_DEADLINE;
        if now < settle.min(hard_deadline) {
            return None;
        }
        self.burst = None;
        // Classify by the deadline that won, even if this thread woke late.
        Some(if hard_deadline <= settle {
            FlushReason::HardDeadline
        } else {
            FlushReason::Settle
        })
    }
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
    state: Arc<WatchState>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct WatchMonitor(Arc<WatchState>);
impl WatchMonitor {
    pub fn is_unavailable(&self) -> bool {
        self.0.unavailable.load(Ordering::Acquire)
    }
    pub fn disruption_count(&self) -> u64 {
        self.0.disruptions.load(Ordering::Acquire)
    }
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
        Self::start_within(root, handle, token, WATCH_STARTUP_DEADLINE).await
    }

    /// [`Self::start`] with a caller-chosen attach deadline, for tests that
    /// must not fail on a slow attach under load.
    pub async fn start_within(
        root: PathBuf,
        handle: FilesHandle,
        token: CancellationToken,
        startup_deadline: Duration,
    ) -> Result<WatchStart, FilesError> {
        Self::attach(root, handle, token, startup_deadline).await
    }

    pub async fn start_metadata(
        root: PathBuf,
        dirty: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<NativeWatcher, FilesError> {
        let (message_tx, message_rx) = mpsc::sync_channel(WATCH_EVENT_QUEUE_CAPACITY);
        let stop_tx = message_tx.clone();
        let state = Arc::new(WatchState::default());
        let thread_state = Arc::clone(&state);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let worker = std::thread::Builder::new()
            .name("dohc-native-watcher".to_owned())
            .spawn(move || {
                watcher_thread(root, dirty, message_rx, message_tx, thread_state, ready_tx)
            })
            .map_err(|_| FilesError::WatcherUnavailable {
                reason: "could not spawn watcher thread",
            })?;
        let watcher = Self {
            stop_tx,
            state,
            worker: Some(worker),
        };
        // The metadata owner runs on a dedicated thread and retains the native
        // join handle even on startup failure. Its Drop must release the root.
        match tokio::time::timeout(WATCH_STARTUP_DEADLINE, ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => return Err(error),
            Ok(Err(_)) => {
                return Err(FilesError::WatcherUnavailable {
                    reason: "watcher thread ended during startup",
                });
            }
            Err(_) => {
                return Err(FilesError::WatcherUnavailable {
                    reason: "native watcher startup timed out",
                });
            }
        }
        Ok(watcher)
    }

    pub fn monitor(&self) -> WatchMonitor {
        WatchMonitor(Arc::clone(&self.state))
    }

    async fn attach(
        root: PathBuf,
        handle: FilesHandle,
        token: CancellationToken,
        startup_deadline: Duration,
    ) -> Result<WatchStart, FilesError> {
        let (message_tx, message_rx) = mpsc::sync_channel(WATCH_EVENT_QUEUE_CAPACITY);
        let stop_tx = message_tx.clone();
        let state = Arc::new(WatchState::default());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let thread_handle = handle.clone();
        let thread_state = Arc::clone(&state);
        let worker = std::thread::Builder::new()
            .name("dohc-native-watcher".to_owned())
            .spawn(move || {
                watcher_thread(
                    root,
                    Arc::new(move || thread_handle.notify_overflow()),
                    message_rx,
                    message_tx,
                    thread_state,
                    ready_tx,
                );
            })
            .map_err(|_| FilesError::WatcherUnavailable {
                reason: "could not spawn watcher thread",
            })?;
        let mut watcher = NativeWatcher {
            stop_tx,
            state,
            worker: Some(worker),
        };
        if let Err(err) = await_ready_with_deadline(
            startup_deadline,
            ready_rx,
            &mut watcher.worker,
            &watcher.stop_tx,
            &watcher.state.unavailable,
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
        let initial = handle.reconcile_if_dirty(token).await;
        let initial_reconcile = match initial {
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
        self.state.unavailable.store(true, Ordering::Release);
        let _ = self.stop_tx.send(ThreadMessage::Stop);
        worker.join().map_err(|_| FilesError::WatcherUnavailable {
            reason: "watcher thread panicked",
        })
    }

    /// Monotone count of watch disruptions since startup: each notify
    /// backend error and each root-identity mismatch increments it, even when
    /// the subsequent re-attach succeeds. A supervisor edge-triggers by
    /// comparing counts — a bool here could only ever be reported once per
    /// watcher, silently swallowing every later disruption on the same live
    /// watch.
    pub fn disruption_count(&self) -> u64 {
        self.state.disruptions.load(Ordering::Acquire)
    }

    /// Number of bursts flushed at the hard deadline since startup.
    pub fn hard_deadline_flush_count(&self) -> u64 {
        self.state.hard_deadline_flushes.load(Ordering::Relaxed)
    }

    /// Number of bursts flushed after the quiet period since startup.
    /// Shutdown flushes are excluded from both deadline counters.
    pub fn settle_flush_count(&self) -> u64 {
        self.state.settle_flushes.load(Ordering::Relaxed)
    }

    /// Whether the OS watch is genuinely, permanently lost: either the
    /// watcher's bounded re-attach retries were exhausted after a backend
    /// error, or startup itself timed out. A caller observing this should
    /// restart the watcher (and, transitively, the workspace it backs)
    /// rather than continue relying on a dead watch. Distinct from
    /// [`NativeWatcher::disruption_count`], which keeps counting even when
    /// re-attach succeeds.
    ///
    /// The PRODUCTION consumer is the capture driver's supervision loop
    /// (`capture_driver.rs`): it polls this every tick, and a lost watch
    /// drops the files layer and rebuilds it on the escalating backoff
    /// schedule — closing the silent-dead-watch class this flag exists for.
    pub fn is_unavailable(&self) -> bool {
        self.state.unavailable.load(Ordering::Acquire)
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
    stop_tx: &SyncSender<ThreadMessage>,
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
            // would risk hanging this caller too. Signal Stop (so if/when the
            // thread does reach its command loop it exits immediately -- it
            // also self-exits via the dropped `ready` receiver before the
            // loop), then detach the join onto a background reaper: this
            // caller gets a bounded, observable failure now, and the worker is
            // still eventually reclaimed, rather than a synchronous hang OR a
            // silently forgotten thread that keeps running.
            let _ = stop_tx.send(ThreadMessage::Stop);
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

fn engine_storage_event(root: &Path, event: &notify::Event) -> bool {
    let ordinary = match event.kind {
        EventKind::Access(AccessKind::Any | AccessKind::Read)
        | EventKind::Create(CreateKind::Any | CreateKind::File | CreateKind::Folder)
        | EventKind::Modify(ModifyKind::Any)
        | EventKind::Modify(ModifyKind::Data(
            DataChange::Any | DataChange::Size | DataChange::Content,
        ))
        | EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::Any
            | MetadataKind::AccessTime
            | MetadataKind::WriteTime
            | MetadataKind::Permissions
            | MetadataKind::Ownership
            | MetadataKind::Extended,
        ))
        | EventKind::Modify(ModifyKind::Name(
            RenameMode::Any | RenameMode::From | RenameMode::To | RenameMode::Both,
        ))
        | EventKind::Remove(RemoveKind::Any | RemoveKind::File | RemoveKind::Folder) => true,
        EventKind::Access(AccessKind::Open(mode) | AccessKind::Close(mode)) => {
            mode != AccessMode::Other
        }
        _ => false,
    };
    if !ordinary || event.need_rescan() || event.paths.is_empty() || !root.is_absolute() {
        return false;
    }
    event.paths.iter().all(|path| {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        let mut components = relative.components();
        for expected in [crate::floor::ENGINE_STORAGE_SEGMENT, "engine"] {
            let Some(Component::Normal(name)) = components.next() else {
                return false;
            };
            let Some(name) = name.to_str() else {
                return false;
            };
            if crate::floor::normalize_segment(name) != expected {
                return false;
            }
        }
        let Some(Component::Normal(name)) = components.next() else {
            return false;
        };
        name.to_str().is_some()
            && components.all(
                |component| matches!(component, Component::Normal(name) if name.to_str().is_some()),
            )
    })
}

fn event_callback(
    root: PathBuf,
    dirty: Arc<dyn Fn() + Send + Sync>,
    tx: SyncSender<ThreadMessage>,
    state: Arc<WatchState>,
    backend_error: Arc<AtomicBool>,
) -> impl FnMut(Result<notify::Event, notify::Error>) + Send {
    move |event| {
        if event
            .as_ref()
            .is_ok_and(|event| engine_storage_event(&root, event))
        {
            return;
        }
        if event.is_err() {
            state.disruptions.fetch_add(1, Ordering::AcqRel);
            backend_error.store(true, Ordering::Release);
            dirty();
        }
        // A full queue already contains evidence of a relevant change.
        let _ = tx.try_send(ThreadMessage::Event);
    }
}

fn watcher_thread(
    root: PathBuf,
    dirty: Arc<dyn Fn() + Send + Sync>,
    rx: Receiver<ThreadMessage>,
    callback_tx: SyncSender<ThreadMessage>,
    state: Arc<WatchState>,
    ready: tokio::sync::oneshot::Sender<Result<(), FilesError>>,
) {
    let config = notify::Config::default().with_follow_symlinks(false);
    let unavailable = &state.unavailable;
    // Sticky, NON-DROPPABLE backend-error signal. The bounded `callback_tx`
    // event queue can drop a `try_send` under load, so a re-attach request
    // must not ride on it: a dropped `Event` merely loses a wake (the health
    // poll still fires within the interval), but a dropped re-attach request
    // would leave a genuinely-dead watch un-reattached. This flag is set by
    // the callback and consumed by the main loop each iteration.
    let backend_error_pending = Arc::new(AtomicBool::new(false));
    let mut watcher = match notify::RecommendedWatcher::new(
        event_callback(
            root.clone(),
            Arc::clone(&dirty),
            callback_tx,
            Arc::clone(&state),
            Arc::clone(&backend_error_pending),
        ),
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
    // Bind to the exact directory object before attaching, so the health poll
    // can detect a delete-then-recreate that existence alone would miss.
    // Binding first is deliberate: a swap landing between these two lines
    // leaves the bound object different from what the path now names, and the
    // poll resolves that with a re-attach. Binding afterwards would record the
    // new object while the watch still sat on the old one -- a dead watch the
    // poll could never see.
    let mut watched_root = WatchedRoot::bind(&root);
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        let _ = ready.send(Err(FilesError::WatcherUnavailable {
            reason: "workspace root could not be watched",
        }));
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }

    let mut debounce = Debounce::default();
    loop {
        // Consume the non-droppable backend-error signal first, so a re-attach
        // request set by the callback is never lost to a full event queue.
        // During a burst we wake on each event; while idle the health poll
        // wakes us within the interval -- so this fires within one interval
        // even if every `Event` `try_send` was dropped under load.
        if backend_error_pending.swap(false, Ordering::AcqRel)
            && !unavailable.load(Ordering::Acquire)
        {
            watched_root = WatchedRoot::bind(&root);
            attempt_reattach(&mut watcher, &root, unavailable);
        }
        let message = match debounce.next_deadline() {
            Some(next) => match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(reason) = debounce.timeout(Instant::now()) {
                        dirty();
                        state.record_flush(reason);
                    }
                    None
                }
                Err(RecvTimeoutError::Disconnected) => break,
            },
            // Idle: no burst in progress. Wake periodically (rather than
            // blocking on `rx.recv()` forever) to independently verify the
            // watched root is still the same directory object the watch was
            // bound to -- see `WATCH_ROOT_HEALTH_POLL_INTERVAL`.
            None => match rx.recv_timeout(WATCH_ROOT_HEALTH_POLL_INTERVAL) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => {
                    if !unavailable.load(Ordering::Acquire) && !watched_root.still_bound(&root) {
                        state.disruptions.fetch_add(1, Ordering::AcqRel);
                        dirty();
                        // Rebind to the new directory object (so we don't
                        // reattach every poll forever), then reattach -- same
                        // bind-before-attach ordering as startup, and it also
                        // releases the pin on the object we just lost. On
                        // exhaustion `unavailable` is set and this branch stops
                        // running entirely.
                        watched_root = WatchedRoot::bind(&root);
                        attempt_reattach(&mut watcher, &root, unavailable);
                    }
                    None
                }
                Err(RecvTimeoutError::Disconnected) => break,
            },
        };
        match message {
            Some(ThreadMessage::Event) => {
                if debounce.event(Instant::now()) {
                    // A ready queued event must not postpone the hard bound:
                    // publish the whole burst even when the queue never drains.
                    dirty();
                    state.record_flush(FlushReason::HardDeadline);
                }
            }
            Some(ThreadMessage::Stop) => {
                // Final-flush parity: pending evidence is published before the
                // thread exits; join guarantees it cannot publish afterward.
                if debounce.flush() {
                    dirty();
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
/// inotify and `ReadDirectoryChangesW`): retry `watch()` on the same owned
/// `notify::Watcher` a fixed number of times with a small backoff, run
/// inline on this dedicated watcher OS thread (never the async runtime, and
/// never unbounded — a dead watch must not spin this thread forever).
///
/// On success, further events resume flowing normally; the disruption stays
/// counted in [`NativeWatcher::disruption_count`] (a real disruption did
/// happen), but [`NativeWatcher::is_unavailable`] stays false. On exhaustion, the watch is
/// treated as permanently lost: `unavailable` is set so a supervisor can
/// observe it and restart the watcher/workspace instead of silently running
/// with a dead watch forever.
fn attempt_reattach(
    watcher: &mut notify::RecommendedWatcher,
    root: &Path,
    unavailable: &AtomicBool,
) {
    // Drop any stale watch first. On a delete-then-recreate the backend may
    // still hold a path-keyed watch bound to the DELETED directory object, so
    // a bare `watch()` can be a no-op that never re-points at the new inode;
    // an explicit unwatch (ignored if there is nothing to drop) forces a
    // genuine rebind. Harmless on the backend-error path too.
    let _ = watcher.unwatch(root);
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

/// The directory object the OS watch is bound to: its file identity, plus --
/// on Unix -- an open handle that PINS it.
///
/// Recorded identity alone is not sound on Linux, because inode numbers are
/// RECYCLED. On ext4 an `rmdir` immediately followed by `mkdir` at the same
/// path hands the new directory the very same `(st_dev, st_ino)` the deleted
/// one had (measured here: every iteration), and `file_id`'s own documentation
/// warns that "IDs may be re-used". Comparing a number recorded at attach time
/// against a freshly read one is then a use-after-free of an identifier: it
/// answers "same directory object" for a root that was replaced. Since inotify
/// watches INODES rather than paths, the watch stays bound to the dead object
/// forever -- no event, no error, `disruption_count` still 0 and
/// `is_unavailable` still false -- which is exactly the silent-dead-watch this
/// check exists to prevent.
///
/// Holding the directory open closes that hole: the kernel cannot free, and so
/// cannot recycle, an inode that is still referenced, so a recreated root is
/// guaranteed a different number and the comparison becomes sound. Only the
/// root directory's own inode is pinned (not its contents), and the pin is
/// released the moment we rebind. The handle is Unix-only: on Windows an open
/// directory handle would block the very `rmdir` this is meant to observe, and
/// NTFS file IDs are not recycled this way.
struct WatchedRoot {
    /// `None` (unreadable) forces the next poll to treat the root as changed
    /// and re-attach, rather than silently skipping the check.
    identity: Option<file_id::FileId>,
    /// Unix inode pin; see the type docs. Its lifetime is the guarantee, so it
    /// is deliberately never read after construction.
    #[cfg(unix)]
    _pin: Option<std::fs::File>,
}

impl WatchedRoot {
    /// Bind to whatever directory object `root` names right now.
    #[cfg(unix)]
    fn bind(root: &Path) -> Self {
        use std::os::unix::fs::MetadataExt;
        // Read the identity through the pinned handle rather than with a
        // second path lookup, so the recorded identity always describes the
        // object actually held open.
        let pin = std::fs::File::open(root).ok();
        let identity = pin
            .as_ref()
            .and_then(|dir| dir.metadata().ok())
            .map(|meta| file_id::FileId::new_inode(meta.dev(), meta.ino()));
        WatchedRoot {
            identity,
            _pin: pin,
        }
    }

    /// Bind to whatever directory object `root` names right now.
    #[cfg(not(unix))]
    fn bind(root: &Path) -> Self {
        WatchedRoot {
            identity: file_id::get_file_id(root).ok(),
        }
    }

    /// Whether `root` still resolves to the bound directory object -- not mere
    /// existence, which cannot distinguish the original directory from a
    /// delete-then-recreate that leaves the OS watch pointing at a dead
    /// object. Any ambiguity (the root is unreadable now, or was unreadable
    /// when bound) counts as not bound, so it feeds a re-attach attempt rather
    /// than a silent skip.
    fn still_bound(&self, root: &Path) -> bool {
        match (self.identity, file_id::get_file_id(root).ok()) {
            (Some(bound), Some(current)) => bound == current,
            _ => false,
        }
    }
}

#[cfg(test)]
mod callback_tests {
    use super::*;
    use crate::{
        CaptureError, CaptureOp, CaptureSink, FilesActor, IngestOutcome, IngestReason, ScanBounds,
        apply_reconcile_plan,
    };
    use dohc_engine_storage::NoFaults;
    use dohc_test_scratch::ScratchDir;
    use notify::event::Flag;

    fn deliver_messages(
        messages: &Receiver<ThreadMessage>,
        debounce: &mut Debounce,
        now: Instant,
        dirty: &dyn Fn(),
    ) -> usize {
        let mut delivered = 0;
        for message in messages.try_iter() {
            assert!(matches!(message, ThreadMessage::Event));
            delivered += 1;
            if debounce.event(now) {
                dirty();
            }
        }
        delivered
    }

    fn flush_due(debounce: &mut Debounce, now: Instant, dirty: &dyn Fn()) -> bool {
        if debounce.timeout(now).is_some() {
            dirty();
            true
        } else {
            false
        }
    }

    struct Callback {
        send: Box<dyn FnMut(Result<notify::Event, notify::Error>) + Send>,
        messages: Receiver<ThreadMessage>,
        dirty_calls: Arc<AtomicU64>,
        state: Arc<WatchState>,
        backend_error: Arc<AtomicBool>,
    }

    impl Callback {
        fn new(root: &Path, capacity: usize) -> Self {
            let (tx, messages) = mpsc::sync_channel(capacity);
            let dirty_calls = Arc::new(AtomicU64::new(0));
            let calls = Arc::clone(&dirty_calls);
            let state = Arc::new(WatchState::default());
            let backend_error = Arc::new(AtomicBool::new(false));
            Self {
                send: Box::new(event_callback(
                    root.to_path_buf(),
                    Arc::new(move || {
                        calls.fetch_add(1, Ordering::AcqRel);
                    }),
                    tx,
                    Arc::clone(&state),
                    Arc::clone(&backend_error),
                )),
                messages,
                dirty_calls,
                state,
                backend_error,
            }
        }

        fn expect_queued(&mut self, event: notify::Event) {
            (self.send)(Ok(event.clone()));
            assert!(
                matches!(self.messages.try_recv(), Ok(ThreadMessage::Event)),
                "event was dropped: {event:?}"
            );
            self.expect_quiet();
        }

        fn expect_quiet(&self) {
            assert!(matches!(
                self.messages.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            assert_eq!(self.dirty_calls.load(Ordering::Acquire), 0);
            assert_eq!(self.state.disruptions.load(Ordering::Acquire), 0);
            assert!(!self.backend_error.load(Ordering::Acquire));
        }
    }

    #[test]
    fn ordinary_engine_descendant_events_never_queue_or_mark_dirty() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        for kind in [
            EventKind::Access(AccessKind::Read),
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
            EventKind::Create(CreateKind::Any),
            EventKind::Create(CreateKind::Folder),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime)),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            EventKind::Remove(RemoveKind::Any),
            EventKind::Remove(RemoveKind::File),
        ] {
            (callback.send)(Ok(notify::Event::new(kind)
                .add_path(root.join(".dohc/engine/engine.db-wal"))
                .add_path(root.join(".dohc/engine/blobs/new"))));
            callback.expect_quiet();
        }
    }

    #[test]
    fn unknown_kinds_empty_paths_and_rescan_flags_still_queue() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        for kind in [
            EventKind::Any,
            EventKind::Other,
            EventKind::Access(AccessKind::Other),
            EventKind::Access(AccessKind::Open(AccessMode::Other)),
            EventKind::Create(CreateKind::Other),
            EventKind::Modify(ModifyKind::Other),
            EventKind::Modify(ModifyKind::Data(DataChange::Other)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Other)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Other)),
            EventKind::Remove(RemoveKind::Other),
        ] {
            callback.expect_queued(
                notify::Event::new(kind).add_path(root.join(".dohc/engine/engine.db")),
            );
        }
        callback.expect_queued(notify::Event::new(EventKind::Modify(ModifyKind::Any)));
        callback.expect_queued(
            notify::Event::new(EventKind::Modify(ModifyKind::Any))
                .add_path(root.join(".dohc/engine/engine.db"))
                .set_flag(Flag::Rescan),
        );
    }

    #[test]
    fn ancestors_policies_content_and_unproven_paths_still_queue() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        for path in [
            root.path().to_path_buf(),
            root.join(".dohc"),
            root.join(".dohc/engine"),
            root.join(".dohc/files.toml"),
            root.join(".dohc/visibility.toml"),
            root.join(".dohc/engine-backup/engine.db"),
            root.join(".dohc/engine/../files.toml"),
            root.join("nested/.dohc/engine/engine.db"),
            root.join("notes/a.md"),
            root.join("data.sqlite-wal"),
            root.join("notes.md.job.conflict"),
            root.path()
                .with_file_name("other-workspace")
                .join(".dohc/engine/engine.db"),
            PathBuf::from(".dohc/engine/engine.db"),
        ] {
            for kind in [
                EventKind::Create(CreateKind::Any),
                EventKind::Modify(ModifyKind::Any),
                EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions)),
                EventKind::Remove(RemoveKind::Any),
            ] {
                callback.expect_queued(notify::Event::new(kind).add_path(path.clone()));
            }
        }
        let mut relative_root = Callback::new(Path::new("workspace"), 1);
        relative_root.expect_queued(
            notify::Event::new(EventKind::Modify(ModifyKind::Any))
                .add_path(PathBuf::from("workspace/.dohc/engine/engine.db")),
        );
    }

    #[test]
    fn mixed_renames_and_atomic_policy_replacements_still_queue() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        let internal = root.join(".dohc/engine/staged");
        for destination in [
            root.join("notes/a.md"),
            root.join(".dohc/files.toml"),
            root.join(".dohc/visibility.toml"),
        ] {
            for paths in [
                [internal.clone(), destination.clone()],
                [destination.clone(), internal.clone()],
            ] {
                let mut event =
                    notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)));
                event.paths.extend(paths);
                callback.expect_queued(event);
            }
            for mode in [RenameMode::From, RenameMode::To] {
                callback.expect_queued(
                    notify::Event::new(EventKind::Modify(ModifyKind::Name(mode)))
                        .add_path(destination.clone()),
                );
            }
        }
    }

    #[test]
    fn engine_path_matching_uses_the_current_floor() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        for path in [".DOHC/ENGINE/engine.db", ".do\u{200b}hc/engine/engine.db"] {
            (callback.send)(Ok(
                notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join(path))
            ));
            callback.expect_quiet();
        }
        let aliased = notify::Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(root.join(".dohc./engine /engine.db"));
        #[cfg(windows)]
        {
            (callback.send)(Ok(aliased));
            callback.expect_quiet();
        }
        #[cfg(not(windows))]
        callback.expect_queued(aliased);
    }

    #[test]
    fn backend_errors_keep_sticky_dirty_and_reattach_evidence_when_queue_is_full() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        (callback.send)(Ok(
            notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("a.md"))
        ));
        (callback.send)(Err(
            notify::Error::generic("backend error").add_path(root.join(".dohc/engine/engine.db"))
        ));
        assert_eq!(callback.dirty_calls.load(Ordering::Acquire), 1);
        assert_eq!(callback.state.disruptions.load(Ordering::Acquire), 1);
        assert!(callback.backend_error.load(Ordering::Acquire));
        assert!(matches!(
            callback.messages.try_recv(),
            Ok(ThreadMessage::Event)
        ));
        assert!(matches!(
            callback.messages.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn internal_noise_does_not_clear_or_delay_a_content_burst() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        let mut debounce = Debounce::default();
        let first = Instant::now();
        let calls = Arc::clone(&callback.dirty_calls);
        let dirty = move || {
            calls.fetch_add(1, Ordering::AcqRel);
        };
        (callback.send)(Ok(
            notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("a.md"))
        ));
        assert_eq!(
            deliver_messages(&callback.messages, &mut debounce, first, &dirty),
            1
        );
        for _ in 0..WATCH_EVENT_QUEUE_CAPACITY * 2 {
            (callback.send)(Ok(notify::Event::new(EventKind::Modify(ModifyKind::Any))
                .add_path(root.join(".dohc/engine/engine.db-wal"))));
            assert_eq!(
                deliver_messages(
                    &callback.messages,
                    &mut debounce,
                    first + WATCH_SETTLE / 2,
                    &dirty,
                ),
                0
            );
        }
        callback.expect_quiet();
        assert_eq!(debounce.next_deadline(), Some(first + WATCH_SETTLE));
        assert!(flush_due(&mut debounce, first + WATCH_SETTLE, &dirty));
        assert_eq!(callback.dirty_calls.load(Ordering::Acquire), 1);
    }

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

    async fn acknowledge(handle: &FilesHandle) -> Vec<CaptureOp> {
        let ReconcileRun::Completed(plan) = handle
            .reconcile_if_dirty(CancellationToken::new())
            .await
            .unwrap()
        else {
            panic!("expected completed reconcile");
        };
        let applied = apply_reconcile_plan(&plan, &mut AcceptAll, &NoFaults);
        let ops = plan.ops.clone();
        handle.acknowledge_capture(plan, applied).await.unwrap();
        ops
    }

    #[tokio::test]
    async fn internal_callbacks_skip_scanner_work_and_content_edits_still_reconcile() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let actor = FilesActor::spawn_async(root.path().to_owned(), ScanBounds::default())
            .await
            .unwrap();
        let handle = actor.handle();
        assert!(acknowledge(&handle).await.is_empty());
        let baseline = handle.stats().await.unwrap();
        assert!(!baseline.dirty);
        assert_eq!(baseline.generation.0, 1);
        assert_eq!(baseline.hashed, 0);
        let (tx, messages) = mpsc::sync_channel(1);
        let dirty_handle = handle.clone();
        let dirty: Arc<dyn Fn() + Send + Sync> = Arc::new(move || dirty_handle.notify_overflow());
        let mut callback = event_callback(
            root.path().to_owned(),
            Arc::clone(&dirty),
            tx,
            Arc::new(WatchState::default()),
            Arc::new(AtomicBool::new(false)),
        );
        let internal = root.join(".dohc/engine/engine.db-wal");
        std::fs::create_dir_all(internal.parent().unwrap()).unwrap();
        let mut debounce = Debounce::default();
        let first = Instant::now();
        for sequence in 0..WATCH_EVENT_QUEUE_CAPACITY * 2 {
            std::fs::write(&internal, sequence.to_le_bytes()).unwrap();
            callback(Ok(
                notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(internal.clone())
            ));
            assert_eq!(
                deliver_messages(&messages, &mut debounce, first, &*dirty),
                0
            );
        }
        assert_eq!(debounce.next_deadline(), None);
        assert!(!flush_due(
            &mut debounce,
            first + WATCH_HARD_DEADLINE,
            &*dirty,
        ));
        assert!(matches!(
            messages.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            handle.reconcile_if_dirty(cancelled).await.unwrap(),
            ReconcileRun::Converged,
        ));
        let after_internal = handle.stats().await.unwrap();
        assert_eq!(after_internal, baseline);

        let content = root.join("a.md");
        for (kind, bytes) in [
            (
                EventKind::Create(CreateKind::File),
                Some(b"created".as_slice()),
            ),
            (
                EventKind::Modify(ModifyKind::Any),
                Some(b"edited content".as_slice()),
            ),
            (EventKind::Remove(RemoveKind::File), None),
        ] {
            if let Some(bytes) = bytes {
                std::fs::write(&content, bytes).unwrap();
            } else {
                std::fs::remove_file(&content).unwrap();
            }
            callback(Ok(notify::Event::new(kind).add_path(content.clone())));
            let event_at = Instant::now();
            assert_eq!(
                deliver_messages(&messages, &mut debounce, event_at, &*dirty),
                1
            );
            assert!(!handle.stats().await.unwrap().dirty);
            assert!(flush_due(&mut debounce, event_at + WATCH_SETTLE, &*dirty,));
            let ops = acknowledge(&handle).await;
            match bytes {
                Some(_) => assert!(
                    matches!(ops.as_slice(), [CaptureOp::Ingest { path, .. }] if path == "a.md")
                ),
                None => assert!(
                    matches!(ops.as_slice(), [CaptureOp::Retire { path }] if path == "a.md")
                ),
            }
        }
        let after_content = handle.stats().await.unwrap();
        assert!(!after_content.dirty);
        assert_eq!(after_content.generation.0, baseline.generation.0 + 3);
        assert_eq!(after_content.hashed, baseline.hashed + 2);
        assert_eq!(after_content.tracked, 0);
    }
}

/// R14 robustness coverage: bounded re-attach and the startup deadline.
/// [`attempt_reattach`] and [`await_ready_with_deadline`] are exercised
/// directly (white-box) here because deterministically forcing a real
/// `notify` backend to hang, specifically, is not practical in a fast unit
/// test; the end-to-end wiring (a deleted watched root eventually surfacing
/// as [`NativeWatcher::is_unavailable`]) is covered separately in
/// `tests/watch.rs` against the real backend.
#[cfg(test)]
mod tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;
    use std::time::Instant;

    #[test]
    fn continuous_events_flush_at_exactly_the_hard_deadline() {
        let mut debounce = Debounce::default();
        let start = Instant::now();
        let interval = WATCH_SETTLE / 10;
        assert_eq!(debounce.next_deadline(), None);

        // Repeat to prove that flushing resets the next burst's hard deadline.
        for first in [start, start + WATCH_HARD_DEADLINE + interval] {
            let hard_deadline = first + WATCH_HARD_DEADLINE;
            let mut now = first;
            while now < hard_deadline {
                assert!(!debounce.event(now), "flushed before the hard deadline");
                assert_eq!(
                    debounce.next_deadline(),
                    Some((now + WATCH_SETTLE).min(hard_deadline))
                );
                now += interval;
            }
            assert!(!debounce.event(hard_deadline - Duration::from_nanos(1)));
            assert_eq!(debounce.next_deadline(), Some(hard_deadline));
            assert!(debounce.event(hard_deadline));
            assert_eq!(debounce.next_deadline(), None);
            assert!(!debounce.flush());
        }
    }

    #[test]
    fn quiet_burst_flushes_at_the_settle_deadline() {
        let mut debounce = Debounce::default();
        let first = Instant::now();
        assert!(!debounce.event(first));
        assert_eq!(debounce.next_deadline(), Some(first + WATCH_SETTLE));
        assert_eq!(
            debounce.timeout(first + WATCH_SETTLE - Duration::from_nanos(1)),
            None
        );
        assert_eq!(
            debounce.timeout(first + WATCH_SETTLE),
            Some(FlushReason::Settle)
        );
        assert_eq!(debounce.next_deadline(), None);
        assert_eq!(debounce.timeout(first + WATCH_SETTLE), None);
    }

    #[test]
    fn timeout_reports_the_deadline_that_won_even_when_woken_late() {
        let first = Instant::now();
        let mut debounce = Debounce::default();
        debounce.event(first);
        assert_eq!(
            debounce.timeout(first + WATCH_HARD_DEADLINE),
            Some(FlushReason::Settle)
        );

        debounce.event(first);
        debounce.event(first + WATCH_HARD_DEADLINE - WATCH_SETTLE / 2);
        assert_eq!(
            debounce.timeout(first + WATCH_HARD_DEADLINE),
            Some(FlushReason::HardDeadline)
        );
        assert_eq!(debounce.timeout(first + WATCH_HARD_DEADLINE), None);
    }

    /// A fresh, existing, watchable temp directory (removed on drop).
    struct TempRoot(ScratchDir);

    impl TempRoot {
        fn new() -> Self {
            TempRoot(ScratchDir::new_named("r14-watch").expect("create temp root"))
        }
    }

    fn silent_watcher() -> notify::RecommendedWatcher {
        let config = notify::Config::default().with_follow_symlinks(false);
        notify::RecommendedWatcher::new(|_event: Result<notify::Event, notify::Error>| {}, config)
            .expect("notify backend available in test environment")
    }

    /// The defect [`WatchedRoot`]'s pin exists for: on ext4, `rmdir` followed
    /// by `mkdir` at the same path is handed the same inode number, so an
    /// unpinned identity comparison answers "still the same directory object"
    /// for a root that was replaced -- leaving inotify bound to the dead one,
    /// with no error and no event, forever.
    #[test]
    fn a_recreated_root_is_never_reported_as_the_object_the_watch_is_bound_to() {
        let root = TempRoot::new();
        let bound = WatchedRoot::bind(&root.0);
        assert!(
            bound.still_bound(&root.0),
            "an untouched root must stay bound, or the poll would reattach forever"
        );

        std::fs::remove_dir_all(&root.0).expect("delete root");
        std::fs::create_dir(&root.0).expect("recreate root");

        assert!(
            !bound.still_bound(&root.0),
            "a recreated root must not be mistaken for the directory object the watch is bound to"
        );
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
        let (stop_tx, _stop_rx) = mpsc::sync_channel::<ThreadMessage>(1);
        let unavailable = AtomicBool::new(false);

        let result = await_ready_with_deadline(
            Duration::from_secs(5),
            ready_rx,
            &mut worker,
            &stop_tx,
            &unavailable,
        )
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
        // A live receiver so the belt-and-suspenders Stop send has somewhere
        // to land (its buffer) rather than erroring.
        let (stop_tx, _stop_rx) = mpsc::sync_channel::<ThreadMessage>(1);
        let unavailable = AtomicBool::new(false);

        let started = Instant::now();
        let result = await_ready_with_deadline(
            Duration::from_millis(20),
            ready_rx,
            &mut worker,
            &stop_tx,
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
