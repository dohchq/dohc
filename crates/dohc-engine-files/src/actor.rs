//! The files actor: a dedicated OS thread owning the scanner (and therefore the
//! bounded hash pool) and the reconcile controller, driven by a **tokio**
//! command loop — the same actor model CAL-2 established for the storage writer
//! (`crates/dohc-engine-runtime/src/actor.rs`).
//!
//! The scan/hash/reconcile work is blocking; it stays on ONE dedicated thread
//! (`std::thread`), never on the async runtime (`PORTING.md` §14). Commands flow
//! over a bounded [`tokio::sync::mpsc`] channel; the worker consumes them with
//! [`blocking_recv`](tokio::sync::mpsc::Receiver::blocking_recv). Replies come
//! back on [`tokio::sync::oneshot`] channels. Cancellation
//! ([`CancellationToken`]) is checked BETWEEN bounded units inside the scan,
//! never mid-file. Lifecycle is explicit — `opening → ready → draining →
//! closed` — and `Drop` joins the worker (no detached thread, deterministic
//! release), tearing the hash pool down with it.

use crate::bounds::ScanBounds;
use crate::error::FilesError;
use crate::reconcile::{ReconcileController, ReconcileRun, ScanGeneration};
use crate::scan::{ScanOutcome, Scanner};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::sync_channel as std_sync_channel;
use std::thread::JoinHandle;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{self, OwnedPermit};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Bound on the actor's command queue (`plan §Rust policy`: bounded everything).
const COMMAND_QUEUE_CAPACITY: usize = 64;

/// Physical capacity: the data bound plus one reserved slot for `Close`, so
/// shutdown always has a home and never spins or starves (the CAL-2 pattern).
const CHANNEL_CAPACITY: usize = COMMAND_QUEUE_CAPACITY + 1;

/// The actor lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Opening,
    Ready,
    Draining,
    Closed,
}

impl LifecycleState {
    const fn as_u8(self) -> u8 {
        match self {
            LifecycleState::Opening => 0,
            LifecycleState::Ready => 1,
            LifecycleState::Draining => 2,
            LifecycleState::Closed => 3,
        }
    }

    fn from_u8(value: u8) -> LifecycleState {
        match value {
            0 => LifecycleState::Opening,
            1 => LifecycleState::Ready,
            2 => LifecycleState::Draining,
            _ => LifecycleState::Closed,
        }
    }
}

/// A cheap snapshot of the actor's reconcile + pool state, for assertions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FilesStats {
    pub generation: ScanGeneration,
    pub dirty: bool,
    pub tracked: usize,
    /// Peak observed hash concurrency — a test asserts this never exceeds the
    /// configured pool size (the bound proof).
    pub max_hash_concurrency: usize,
    pub hashed: usize,
}

enum Command {
    Scan {
        token: CancellationToken,
        reply: oneshot::Sender<Result<ScanOutcome, FilesError>>,
    },
    Reconcile {
        token: CancellationToken,
        reply: oneshot::Sender<Result<ReconcileRun, FilesError>>,
    },
    ReconcileIfDirty {
        token: CancellationToken,
        reply: oneshot::Sender<Result<ReconcileRun, FilesError>>,
    },
    /// The injected watcher-overflow signal. Fire-and-forget: marking dirty is
    /// pure in-memory bookkeeping with no failure mode to report.
    MarkDirty,
    Stats {
        reply: oneshot::Sender<FilesStats>,
    },
    Close,
}

/// Owns the worker thread and the command sender. Dropping it joins the worker.
pub struct FilesActor {
    tx: mpsc::Sender<Command>,
    close_permit: Option<OwnedPermit<Command>>,
    state: Arc<AtomicU8>,
    worker: Option<JoinHandle<()>>,
}

impl FilesActor {
    /// Spawn the actor's worker thread and build the scanner (which spins up the
    /// bounded hash pool). Blocks until startup completes so a pool-spawn or
    /// bad-root failure propagates synchronously.
    pub fn spawn(root: PathBuf, bounds: ScanBounds) -> Result<Self, FilesError> {
        let (tx, rx) = mpsc::channel::<Command>(CHANNEL_CAPACITY);
        // Reserve the dedicated Close slot up front (the channel is empty, so
        // this cannot fail).
        let close_permit = tx.clone().try_reserve_owned().ok();
        let state = Arc::new(AtomicU8::new(LifecycleState::Opening.as_u8()));
        let (startup_tx, startup_rx) = std_sync_channel::<Result<(), FilesError>>(1);

        let worker_state = Arc::clone(&state);
        let worker = std::thread::Builder::new()
            .name("dohc-files-actor".to_owned())
            .spawn(move || worker_main(root, bounds, rx, worker_state, startup_tx))
            .map_err(|_| FilesError::PoolUnavailable {
                reason: "could not spawn files actor worker thread",
            })?;

        match startup_rx.recv() {
            Ok(Ok(())) => Ok(FilesActor {
                tx,
                close_permit,
                state,
                worker: Some(worker),
            }),
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                let _ = worker.join();
                Err(FilesError::ActorUnavailable)
            }
        }
    }

    /// A clonable, message-only handle for issuing commands.
    pub fn handle(&self) -> FilesHandle {
        FilesHandle {
            tx: self.tx.clone(),
            state: Arc::clone(&self.state),
        }
    }

    /// The current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    /// Orderly close: drain queued work, stop accepting new commands, tear down
    /// the hash pool, and join the worker. Idempotent. `Close` is delivered
    /// through the reserved slot (fair, FIFO, no spin, safe from an async
    /// `Drop`); the subsequent `join` blocks the calling thread until the worker
    /// exits.
    pub fn close(&mut self) -> Result<(), FilesError> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        match self.close_permit.take() {
            Some(permit) => {
                permit.send(Command::Close);
            }
            None => {
                let _ = self.tx.try_send(Command::Close);
            }
        }
        match worker.join() {
            Ok(()) => Ok(()),
            Err(_) => Err(FilesError::ActorUnavailable),
        }
    }
}

impl Drop for FilesActor {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// A clonable, message-only handle to a [`FilesActor`].
#[derive(Clone)]
pub struct FilesHandle {
    tx: mpsc::Sender<Command>,
    state: Arc<AtomicU8>,
}

impl FilesHandle {
    /// The actor's current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    /// Scan the workspace, cancellable via `token`.
    pub async fn scan(&self, token: CancellationToken) -> Result<ScanOutcome, FilesError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Scan { token, reply })
            .await
            .map_err(|_| FilesError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| FilesError::ActorUnavailable)?
    }

    /// Reconcile: full scan + diff against the last committed generation +
    /// commit the plan. Cancellable at between-unit boundaries.
    pub async fn reconcile(&self, token: CancellationToken) -> Result<ReconcileRun, FilesError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Reconcile { token, reply })
            .await
            .map_err(|_| FilesError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| FilesError::ActorUnavailable)?
    }

    /// Reconcile only if a dirty generation is pending.
    pub async fn reconcile_if_dirty(
        &self,
        token: CancellationToken,
    ) -> Result<ReconcileRun, FilesError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReconcileIfDirty { token, reply })
            .await
            .map_err(|_| FilesError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| FilesError::ActorUnavailable)?
    }

    /// Notify the actor of a watcher overflow — the injected event source hook.
    /// Sets the dirty generation, forcing the next reconcile to do a full
    /// rescan. Fails fast with [`FilesError::Overloaded`] if the bounded queue
    /// is full (backpressure), never blocking the caller unboundedly.
    pub fn notify_overflow(&self) -> Result<(), FilesError> {
        match self.tx.try_send(Command::MarkDirty) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(FilesError::Overloaded),
            Err(TrySendError::Closed(_)) => Err(FilesError::ActorUnavailable),
        }
    }

    /// Snapshot reconcile + pool state.
    pub async fn stats(&self) -> Result<FilesStats, FilesError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Stats { reply })
            .await
            .map_err(|_| FilesError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| FilesError::ActorUnavailable)
    }

    /// Reconcile under a deadline. The whole operation — including waiting for
    /// queue space — is bounded by `deadline`; on expiry the shared `token` is
    /// cancelled (stopping the scan at its next between-unit boundary) and
    /// [`FilesError::DeadlineExceeded`] is returned. A reconcile that already
    /// committed before the deadline stays committed (exactly-once advance).
    pub async fn reconcile_with_deadline(
        &self,
        token: CancellationToken,
        deadline: std::time::Duration,
    ) -> Result<ReconcileRun, FilesError> {
        let deadline_at = tokio::time::Instant::now() + deadline;
        let (reply, reply_rx) = oneshot::channel();

        tokio::select! {
            biased;
            sent = self.tx.send(Command::Reconcile { token: token.clone(), reply }) =>
                sent.map_err(|_| FilesError::ActorUnavailable)?,
            () = tokio::time::sleep_until(deadline_at) => {
                token.cancel();
                return Err(FilesError::DeadlineExceeded);
            }
        }

        tokio::select! {
            biased;
            result = reply_rx => result.map_err(|_| FilesError::ActorUnavailable)?,
            () = tokio::time::sleep_until(deadline_at) => {
                token.cancel();
                Err(FilesError::DeadlineExceeded)
            }
        }
    }
}

fn worker_main(
    root: PathBuf,
    bounds: ScanBounds,
    mut rx: mpsc::Receiver<Command>,
    state: Arc<AtomicU8>,
    startup_tx: std::sync::mpsc::SyncSender<Result<(), FilesError>>,
) {
    // Publish Closed on ANY exit (declared before the scanner so the scanner —
    // and its hash pool — drops first, then this guard publishes Closed).
    struct ClosedGuard(Arc<AtomicU8>);
    impl Drop for ClosedGuard {
        fn drop(&mut self) {
            self.0
                .store(LifecycleState::Closed.as_u8(), Ordering::Release);
        }
    }
    let _closed_guard = ClosedGuard(Arc::clone(&state));

    let scanner = match Scanner::new(bounds) {
        Ok(scanner) => scanner,
        Err(err) => {
            let _ = startup_tx.send(Err(err));
            return;
        }
    };
    let mut controller = ReconcileController::new();

    state.store(LifecycleState::Ready.as_u8(), Ordering::Release);
    if startup_tx.send(Ok(())).is_err() {
        return;
    }
    drop(startup_tx);

    while let Some(cmd) = rx.blocking_recv() {
        match cmd {
            Command::Scan { token, reply } => {
                let _ = reply.send(scanner.scan(&root, &token));
            }
            Command::Reconcile { token, reply } => {
                let _ = reply.send(controller.reconcile(&scanner, &root, &token));
            }
            Command::ReconcileIfDirty { token, reply } => {
                let _ = reply.send(controller.reconcile_if_dirty(&scanner, &root, &token));
            }
            Command::MarkDirty => {
                controller.mark_dirty();
            }
            Command::Stats { reply } => {
                let gauge = scanner.pool().gauge();
                let _ = reply.send(FilesStats {
                    generation: controller.generation(),
                    dirty: controller.is_dirty(),
                    tracked: controller.tracked_len(),
                    max_hash_concurrency: gauge.max_concurrent(),
                    hashed: gauge.hashed(),
                });
            }
            Command::Close => {
                state.store(LifecycleState::Draining.as_u8(), Ordering::Release);
                break;
            }
        }
    }

    // Drop the scanner (and its hash pool) explicitly before the guard publishes
    // Closed.
    drop(scanner);
    drop(controller);
}
