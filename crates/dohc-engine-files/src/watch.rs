//! Native watcher lifecycle plus the injectable event vocabulary.
//!
//! `notify` and the debounce state live on one dedicated OS thread. The actor's
//! blocking scan/command loop is never run from an OS callback. Every settled
//! burst (including a backend error/overflow) reduces to the actor's sticky
//! [`FilesHandle::notify_overflow`](crate::FilesHandle::notify_overflow) bit;
//! the dirty-generation model then performs a full bounded rescan.
//!
//! Ordinary events strictly below `.dohc/engine` do not enter the debounce
//! queue, except `secret.key`: restoring it must retry secret capture. Data
//! scans exclude that subtree. Policy files and ancestor changes still trigger
//! a rescan, as do errors and uncertain events.
//! Symlink notifications are harmless: the scanner uses lstat and never
//! descends through a symlink, so only real in-root content can reach a
//! capture plan.

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
const OTHER_COMPUTERS_READ_INTERVAL: Duration = Duration::from_secs(10);

#[cfg(windows)]
fn other_computers_write_to(root: &Path) -> bool {
    use std::path::Prefix;
    let network = |path: &Path| {
        matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::VerbatimUNC(..) | Prefix::UNC(..))
        )
    };
    std::fs::canonicalize(root).is_ok_and(|path| network(&path))
}

#[cfg(target_os = "linux")]
fn other_computers_write_to(root: &Path) -> bool {
    const SHARED_FILESYSTEMS: [u32; 12] = [
        0x6969,
        0x517b,
        0xff53_4d42,
        0xfe53_4d42,
        0x0102_1997,
        0x6573_5546,
        0x00c3_6400,
        0x5346_414f,
        0x6b41_4653,
        0x786f_4256,
        0x7c7c_6673,
        0x0bd0_0bd0,
    ];
    rustix::fs::statfs(root).is_ok_and(|stat| SHARED_FILESYSTEMS.contains(&(stat.f_type as u32)))
}

#[cfg(target_os = "macos")]
fn other_computers_write_to(root: &Path) -> bool {
    const MNT_LOCAL: u32 = 0x1000;
    rustix::fs::statfs(root).is_ok_and(|stat| stat.f_flags & MNT_LOCAL == 0)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn other_computers_write_to(_root: &Path) -> bool {
    false
}

fn timed_read_interval(root: &Path) -> Option<Duration> {
    other_computers_write_to(root).then_some(OTHER_COMPUTERS_READ_INTERVAL)
}

/// A watcher event. Both kinds mark the generation dirty (a full
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
    timed_reads: AtomicU64,
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
        Self::start_thread(WATCH_STARTUP_DEADLINE, move |rx, tx, state, ready| {
            let timed_read = timed_read_interval(&root);
            watcher_thread(root, dirty, rx, tx, state, ready, timed_read);
        })
        .await
    }

    async fn start_thread(
        startup_deadline: Duration,
        run: impl FnOnce(
            Receiver<ThreadMessage>,
            SyncSender<ThreadMessage>,
            Arc<WatchState>,
            tokio::sync::oneshot::Sender<Result<(), FilesError>>,
        ) + Send
        + 'static,
    ) -> Result<NativeWatcher, FilesError> {
        let (message_tx, message_rx) = mpsc::sync_channel(WATCH_EVENT_QUEUE_CAPACITY);
        let stop_tx = message_tx.clone();
        let state = Arc::new(WatchState::default());
        let thread_state = Arc::clone(&state);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let worker = std::thread::Builder::new()
            .name("dohc-native-watcher".to_owned())
            .spawn(move || run(message_rx, message_tx, thread_state, ready_tx))
            .map_err(|_| FilesError::WatcherUnavailable {
                reason: "could not spawn watcher thread",
            })?;
        let mut watcher = Self {
            stop_tx,
            state,
            worker: Some(worker),
        };
        await_ready_with_deadline(
            startup_deadline,
            ready_rx,
            &mut watcher.worker,
            &watcher.stop_tx,
            &watcher.state.unavailable,
        )
        .await?;
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
        let thread_handle = handle.clone();
        let mut watcher = Self::start_thread(startup_deadline, move |rx, tx, state, ready| {
            let timed_read = timed_read_interval(&root);
            watcher_thread(
                root,
                Arc::new(move || thread_handle.notify_overflow()),
                rx,
                tx,
                state,
                ready,
                timed_read,
            );
        })
        .await?;
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

    /// Number of times the folder was read again on the timer, with no
    /// event, because other computers write to it.
    pub fn timed_read_count(&self) -> u64 {
        self.state.timed_reads.load(Ordering::Relaxed)
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
    mut ready_rx: tokio::sync::oneshot::Receiver<Result<(), FilesError>>,
    worker: &mut Option<JoinHandle<()>>,
    stop_tx: &SyncSender<ThreadMessage>,
    unavailable: &AtomicBool,
) -> Result<(), FilesError> {
    let answer = match tokio::time::timeout(deadline, &mut ready_rx).await {
        Ok(answer) => Some(answer),
        Err(_) => {
            ready_rx.close();
            ready_rx.try_recv().ok().map(Ok)
        }
    };
    match answer {
        Some(Ok(Ok(()))) => Ok(()),
        Some(Ok(Err(err))) => Err(err),
        Some(Err(_)) => Err(FilesError::WatcherUnavailable {
            reason: "watcher thread ended during startup",
        }),
        None => {
            // The worker has not signaled readiness within the deadline.
            // `notify`'s attach call is not cancellable, so it may genuinely
            // be stuck in a native OS call; synchronously joining it here
            // would risk hanging this caller too. Signal Stop (so if/when the
            // thread does reach its command loop it exits immediately -- it
            // also self-exits via the closed `ready` receiver before the
            // loop), then detach the join onto a background reaper: this
            // caller gets a bounded, observable failure now, and the worker is
            // still eventually reclaimed, rather than a synchronous hang OR a
            // silently forgotten thread that keeps running.
            let _ = stop_tx.try_send(ThreadMessage::Stop);
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
        let Some(name) = name.to_str() else {
            return false;
        };
        if components.clone().next().is_none()
            && crate::floor::normalize_segment(name) == "secret.key"
        {
            return false;
        }
        components.all(
            |component| matches!(component, Component::Normal(name) if name.to_str().is_some()),
        )
    })
}

/// Whether an event says only that something was opened or read.
///
/// Linux reports every open, and a scan opens each folder it walks. If an
/// open counted as a change, every scan would ask for the next one, for as
/// long as the workspace stays open. A write, a new name and a removal each
/// arrive as their own event.
fn reads_only(event: &notify::Event) -> bool {
    !event.need_rescan()
        && matches!(
            event.kind,
            EventKind::Access(
                AccessKind::Open(_) | AccessKind::Read | AccessKind::Close(AccessMode::Read)
            )
        )
}

/// Whether an error may mean the watch on the root is gone.
///
/// A folder below the root that the backend cannot read is reported with its
/// own path while the watch on everything else keeps working. Attaching again
/// would meet the same folder and report it again, without end. Reaching the
/// limit on watches names a folder too, but the rest of the tree goes unwatched.
/// The callback remembers each unreadable folder and attaches again once a
/// change names it or a folder above it, because only a new watch reaches
/// inside it.
fn watch_lost(root: &Path, error: &notify::Error) -> bool {
    matches!(error.kind, notify::ErrorKind::MaxFilesWatch)
        || error.paths.is_empty()
        || error
            .paths
            .iter()
            .any(|path| path == root || !path.starts_with(root))
}

fn event_callback(
    root: PathBuf,
    dirty: Arc<dyn Fn() + Send + Sync>,
    tx: SyncSender<ThreadMessage>,
    state: Arc<WatchState>,
    backend_error: Arc<AtomicBool>,
) -> impl FnMut(Result<notify::Event, notify::Error>) + Send {
    let mut unreadable: Vec<PathBuf> = Vec::new();
    move |event| {
        if event
            .as_ref()
            .is_ok_and(|event| reads_only(event) || engine_storage_event(&root, event))
        {
            return;
        }
        let attach_again = match &event {
            Err(error) if watch_lost(&root, error) => true,
            Err(error) => {
                for path in &error.paths {
                    if !unreadable.contains(path) {
                        unreadable.push(path.clone());
                    }
                }
                false
            }
            Ok(event) => event
                .paths
                .iter()
                .any(|path| unreadable.iter().any(|folder| folder.starts_with(path))),
        };
        if attach_again {
            unreadable.clear();
            state.disruptions.fetch_add(1, Ordering::AcqRel);
            backend_error.store(true, Ordering::Release);
            dirty();
        }
        // A full queue already contains evidence of a relevant change.
        let _ = tx.try_send(ThreadMessage::Event);
    }
}

/// Inject one path change through the callback and settle it without an OS
/// backend or wall-clock wait. Available only with the test fault seam.
#[cfg(feature = "fault-injection")]
#[doc(hidden)]
pub fn notify_settled_change_for_harness(root: PathBuf, path: PathBuf, handle: &FilesHandle) {
    let (tx, rx) = mpsc::sync_channel(1);
    let dirty_handle = handle.clone();
    let dirty: Arc<dyn Fn() + Send + Sync> = Arc::new(move || dirty_handle.notify_overflow());
    let mut callback = event_callback(
        root,
        Arc::clone(&dirty),
        tx,
        Arc::new(WatchState::default()),
        Arc::new(AtomicBool::new(false)),
    );
    callback(Ok(
        notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(path)
    ));
    let mut debounce = Debounce::default();
    let now = Instant::now();
    for message in rx.try_iter() {
        if matches!(message, ThreadMessage::Event) && debounce.event(now) {
            dirty();
        }
    }
    if debounce.timeout(now + WATCH_SETTLE).is_some() {
        dirty();
    }
}

fn watcher_thread(
    root: PathBuf,
    dirty: Arc<dyn Fn() + Send + Sync>,
    rx: Receiver<ThreadMessage>,
    callback_tx: SyncSender<ThreadMessage>,
    state: Arc<WatchState>,
    ready: tokio::sync::oneshot::Sender<Result<(), FilesError>>,
    timed_read: Option<Duration>,
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
    let mut next_timed_read = timed_read.map(|interval| Instant::now() + interval);
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
            attempt_reattach(&mut watcher, &root, unavailable, &*dirty);
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
            None => match rx.recv_timeout(next_timed_read.map_or(
                WATCH_ROOT_HEALTH_POLL_INTERVAL,
                |at| {
                    at.saturating_duration_since(Instant::now())
                        .min(WATCH_ROOT_HEALTH_POLL_INTERVAL)
                },
            )) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => {
                    if let (Some(interval), Some(at)) = (timed_read, next_timed_read)
                        && Instant::now() >= at
                    {
                        state.timed_reads.fetch_add(1, Ordering::Relaxed);
                        dirty();
                        next_timed_read = Some(Instant::now() + interval);
                    }
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
                        attempt_reattach(&mut watcher, &root, unavailable, &*dirty);
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

fn attempt_reattach(
    watcher: &mut notify::RecommendedWatcher,
    root: &Path,
    unavailable: &AtomicBool,
    dirty: &dyn Fn(),
) {
    // Drop any stale watch first. On a delete-then-recreate the backend may
    // still hold a path-keyed watch bound to the DELETED directory object, so
    // a bare `watch()` can be a no-op that never re-points at the new inode;
    // an explicit unwatch (ignored if there is nothing to drop) forces a
    // genuine rebind. Harmless on the backend-error path too.
    let _ = watcher.unwatch(root);
    let attached = (0..WATCH_REATTACH_ATTEMPTS).any(|attempt| {
        if attempt > 0 {
            std::thread::sleep(WATCH_REATTACH_BACKOFF);
        }
        watcher.watch(root, RecursiveMode::Recursive).is_ok()
    });
    if !attached {
        unavailable.store(true, Ordering::Release);
    }
    // Reported last, in both cases. A change made while no watch was attached
    // raised no event, so a scan must follow the new watch. And whoever waits
    // on this watcher must look again to find a lost watch unavailable.
    dirty();
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

    use dohc_test_scratch::ScratchDir;

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
    fn an_open_or_a_read_never_queues_and_a_finished_write_does() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        for path in ["notes", "notes/a.md", ".dohc/engine/secret.key"] {
            for kind in [
                EventKind::Access(AccessKind::Open(AccessMode::Any)),
                EventKind::Access(AccessKind::Open(AccessMode::Read)),
                EventKind::Access(AccessKind::Read),
                EventKind::Access(AccessKind::Close(AccessMode::Read)),
            ] {
                (callback.send)(Ok(notify::Event::new(kind).add_path(root.join(path))));
                callback.expect_quiet();
            }
        }
        callback.expect_queued(
            notify::Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write)))
                .add_path(root.join("notes/a.md")),
        );
        // An open that carries the backend's own doubt still asks for a scan.
        callback.expect_queued(
            notify::Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any)))
                .add_path(root.join("notes"))
                .set_flag(notify::event::Flag::Rescan),
        );
    }

    #[test]
    fn secret_key_restores_and_permission_repairs_still_queue() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        let paths = [
            ".dohc/engine/secret.key",
            ".DOHC/ENGINE/SECRET.KEY",
            ".do\u{200b}hc/engine/sec\u{200b}ret.key",
            #[cfg(windows)]
            ".dohc./engine /secret.key. ",
        ];
        for path in paths {
            for kind in [
                EventKind::Create(CreateKind::File),
                EventKind::Modify(ModifyKind::Any),
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions)),
            ] {
                callback.expect_queued(notify::Event::new(kind).add_path(root.join(path)));
            }
        }
        for path in [
            ".dohc/engine/secret.key.tmp",
            ".dohc/engine/secret.key-backup",
            ".dohc/engine/secret.key/child",
            ".dohc/engine/keys/secret.key",
        ] {
            (callback.send)(Ok(
                notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join(path))
            ));
            callback.expect_quiet();
        }
    }

    #[test]
    fn a_reattach_reports_once_after_the_watch_is_back_or_given_up() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut watcher = notify::RecommendedWatcher::new(
            |_: Result<notify::Event, notify::Error>| {},
            notify::Config::default(),
        )
        .unwrap();
        // The report's hearer finds the watch attached again, or unavailable.
        for (watched, gives_up) in [
            (root.path().to_path_buf(), false),
            (root.join("gone"), true),
        ] {
            let unavailable = AtomicBool::new(false);
            let reports = AtomicU64::new(0);
            attempt_reattach(&mut watcher, &watched, &unavailable, &|| {
                assert_eq!(unavailable.load(Ordering::Acquire), gives_up);
                reports.fetch_add(1, Ordering::AcqRel);
            });
            assert_eq!(reports.load(Ordering::Acquire), 1);
            assert_eq!(unavailable.load(Ordering::Acquire), gives_up);
        }
    }

    #[test]
    fn backend_errors_keep_sticky_dirty_and_reattach_evidence_when_queue_is_full() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        (callback.send)(Ok(
            notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("a.md"))
        ));
        (callback.send)(Err(
            notify::Error::generic("backend error").add_path(root.path().to_path_buf())
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
    fn an_error_for_a_folder_below_the_root_is_a_change_not_a_lost_watch() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 1);
        (callback.send)(Err(notify::Error::io(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        ))
        .add_path(root.join("locked"))));
        assert!(matches!(
            callback.messages.try_recv(),
            Ok(ThreadMessage::Event)
        ));
        callback.expect_quiet();
    }

    #[test]
    fn a_change_above_an_unreadable_folder_attaches_the_watch_again_once() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        let mut callback = Callback::new(root.path(), 4);
        (callback.send)(Err(notify::Error::io(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        ))
        .add_path(root.join("parent").join("locked"))));
        let _ = callback.messages.try_recv();
        callback.expect_queued(
            notify::Event::new(EventKind::Modify(ModifyKind::Any))
                .add_path(root.join("open").join("note.md")),
        );
        let unlocked = notify::Event::new(EventKind::Modify(ModifyKind::Metadata(
            notify::event::MetadataKind::Permissions,
        )))
        .add_path(root.join("parent"));
        (callback.send)(Ok(unlocked.clone()));
        assert!(callback.backend_error.swap(false, Ordering::AcqRel));
        assert_eq!(callback.state.disruptions.load(Ordering::Acquire), 1);
        (callback.send)(Ok(unlocked));
        assert!(!callback.backend_error.load(Ordering::Acquire));
        assert_eq!(callback.state.disruptions.load(Ordering::Acquire), 1);
    }

    #[test]
    fn errors_without_a_path_or_at_the_watch_limit_are_lost_watches() {
        let root = ScratchDir::new_named("watch-callback").unwrap();
        for error in [
            notify::Error::generic("backend error"),
            notify::Error::new(notify::ErrorKind::MaxFilesWatch).add_path(root.join("deep")),
        ] {
            let mut callback = Callback::new(root.path(), 1);
            (callback.send)(Err(error));
            assert!(callback.backend_error.load(Ordering::Acquire));
            assert_eq!(callback.state.disruptions.load(Ordering::Acquire), 1);
        }
    }
}

/// Bounded re-attach and the startup deadline.
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

    /// A fresh, existing, watchable temp directory (removed on drop).
    struct TempRoot(ScratchDir);

    impl TempRoot {
        fn new() -> Self {
            TempRoot(ScratchDir::new_named("r14-watch").expect("create temp root"))
        }
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

    #[tokio::test]
    async fn a_start_returns_on_time_while_the_watcher_thread_stays_stuck() {
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let started = Instant::now();
        let result = NativeWatcher::start_thread(
            Duration::from_millis(500),
            move |_rx, tx, _state, _ready| {
                while tx.try_send(ThreadMessage::Event).is_ok() {}
                let _ = release_rx.recv_timeout(Duration::from_secs(5));
            },
        )
        .await;
        let elapsed = started.elapsed();
        let _ = release_tx.send(());
        assert!(
            matches!(
                result,
                Err(FilesError::WatcherUnavailable {
                    reason: "native watcher startup timed out"
                })
            ),
            "a stuck start must fail with its timeout"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "the start must not wait for the stuck watcher thread: {elapsed:?}"
        );
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

    fn start_counting(
        root: PathBuf,
        timed_read: Option<Duration>,
    ) -> (
        impl std::future::Future<Output = Result<NativeWatcher, FilesError>>,
        mpsc::Receiver<()>,
    ) {
        let (reads_tx, reads_rx) = mpsc::channel();
        let reads_tx = std::sync::Mutex::new(reads_tx);
        let dirty: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = reads_tx.lock().map(|tx| tx.send(()));
        });
        let started =
            NativeWatcher::start_thread(WATCH_STARTUP_DEADLINE, move |rx, tx, state, ready| {
                watcher_thread(root, dirty, rx, tx, state, ready, timed_read);
            });
        (started, reads_rx)
    }

    #[tokio::test]
    async fn a_folder_other_computers_write_is_read_again_with_no_event() {
        let root = dohc_test_scratch::ScratchDir::new().unwrap();
        let (started, reads) =
            start_counting(root.path().to_owned(), Some(Duration::from_millis(50)));
        let mut watcher = started.await.unwrap();
        while watcher.timed_read_count() < 3 {
            reads
                .recv_timeout(Duration::from_secs(5))
                .expect("the folder is read again on the timer");
        }
        watcher.stop().unwrap();
    }

    /// A change in the folder still reads it, through its event. Across two
    /// health polls after that, nothing reads it on the timer.
    #[tokio::test]
    async fn a_folder_only_this_computer_writes_is_never_read_on_a_timer() {
        let root = dohc_test_scratch::ScratchDir::new().unwrap();
        assert_eq!(timed_read_interval(root.path()), None);
        let (started, reads) = start_counting(root.path().to_owned(), None);
        let mut watcher = started.await.unwrap();
        std::fs::write(root.path().join("notes.md"), b"notes").unwrap();
        reads
            .recv_timeout(Duration::from_secs(5))
            .expect("the change is read");
        let quiet_until = Instant::now() + WATCH_ROOT_HEALTH_POLL_INTERVAL * 2;
        while reads
            .recv_timeout(quiet_until.saturating_duration_since(Instant::now()))
            .is_ok()
        {}
        watcher.stop().unwrap();
        assert_eq!(watcher.timed_read_count(), 0);
    }
}
