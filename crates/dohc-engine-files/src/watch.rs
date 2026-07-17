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
use std::path::PathBuf;
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
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let thread_handle = handle.clone();
        let worker = std::thread::Builder::new()
            .name("dohc-native-watcher".to_owned())
            .spawn(move || watcher_thread(root, thread_handle, message_rx, message_tx, ready_tx))
            .map_err(|_| FilesError::WatcherUnavailable {
                reason: "could not spawn watcher thread",
            })?;
        let mut watcher = NativeWatcher {
            stop_tx,
            worker: Some(worker),
        };
        match ready_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                let _ = watcher.stop();
                return Err(err);
            }
            Err(_) => {
                let _ = watcher.stop();
                return Err(FilesError::WatcherUnavailable {
                    reason: "watcher thread ended during startup",
                });
            }
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
}

impl Drop for NativeWatcher {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn watcher_thread(
    root: PathBuf,
    handle: FilesHandle,
    rx: Receiver<ThreadMessage>,
    callback_tx: SyncSender<ThreadMessage>,
    ready: tokio::sync::oneshot::Sender<Result<(), FilesError>>,
) {
    let config = notify::Config::default().with_follow_symlinks(false);
    let mut watcher = match notify::RecommendedWatcher::new(
        move |_event| {
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
            _ => match rx.recv() {
                Ok(message) => Some(message),
                Err(_) => break,
            },
        };
        match message {
            Some(ThreadMessage::Event) => {
                let now = Instant::now();
                first_event.get_or_insert(now);
                settle_at = Some(now + WATCH_SETTLE);
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
