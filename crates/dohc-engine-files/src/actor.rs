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
use crate::capture::CaptureApplyResult;
use crate::diff::ScanManifest;
use crate::error::FilesError;
use crate::reconcile::{ReconcileController, ReconcilePlan, ReconcileRun, ScanGeneration};
use crate::scan::{ScanOutcome, Scanner};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::sync_channel as std_sync_channel;
use std::thread::JoinHandle;
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
    /// Paths parked by the degraded-rescan quarantine. NON-EMPTY means the
    /// controller has stopped self-forcing scans for persistently failing
    /// paths — `reconcile_if_dirty` can return `Converged` while capture has
    /// NOT recovered, so a health consumer must not read converged-with-
    /// quarantine as clean.
    pub quarantined: usize,
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
    Stats {
        reply: oneshot::Sender<FilesStats>,
    },
    AcknowledgeCapture {
        // Boxed: the receipt (plan + result) dwarfs every other command and
        // would otherwise size the whole channel slot.
        receipt: Box<(ReconcilePlan, CaptureApplyResult)>,
        reply: oneshot::Sender<Result<(), FilesError>>,
    },
    Close,
}

/// Owns the worker thread and the command sender. Dropping it joins the worker.
pub struct FilesActor {
    tx: mpsc::Sender<Command>,
    close_permit: Option<OwnedPermit<Command>>,
    state: Arc<AtomicU8>,
    /// A sticky watcher-overflow flag, set by [`FilesHandle::notify_overflow`]
    /// INDEPENDENT of the command channel so a dirty mark can NEVER be lost to
    /// backpressure. The worker folds it into the controller at the top of each
    /// command, before any dirty-clearing capture acknowledgement runs.
    pending_overflow: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl FilesActor {
    /// Spawn the actor's worker thread and build the scanner (which spins up the
    /// bounded hash pool). Blocks until startup completes so a pool-spawn or
    /// bad-root failure propagates synchronously.
    ///
    /// **Must be called OFF the async runtime** (it blocks on a startup
    /// handshake). From within a tokio runtime use [`FilesActor::spawn_async`],
    /// which offloads the blocking startup to a dedicated thread. A debug
    /// assertion catches on-runtime misuse (CAL-2 parity with the runtime
    /// actor's sync-context guard).
    pub fn spawn(root: PathBuf, bounds: ScanBounds) -> Result<Self, FilesError> {
        Self::spawn_with_manifest(root, bounds, None)
    }

    /// Same as [`FilesActor::spawn`], but seeds the reconcile controller from
    /// a manifest recovered from a prior process's committed state (R14
    /// robustness: manifest rehydration across a daemon restart), instead of
    /// [`ReconcileController::new`]'s empty baseline. `None` behaves exactly
    /// like [`FilesActor::spawn`]. See
    /// [`ReconcileController::rehydrated`] for why this still forces a full
    /// reconcile before anything is trusted.
    ///
    /// **Must be called OFF the async runtime** — see [`FilesActor::spawn`].
    pub fn spawn_with_manifest(
        root: PathBuf,
        bounds: ScanBounds,
        rehydrated: Option<(ScanManifest, ScanGeneration)>,
    ) -> Result<Self, FilesError> {
        debug_assert_off_runtime();
        let (tx, rx) = mpsc::channel::<Command>(CHANNEL_CAPACITY);
        // Reserve the dedicated Close slot up front (the channel is empty, so
        // this cannot fail).
        let close_permit = tx.clone().try_reserve_owned().ok();
        let state = Arc::new(AtomicU8::new(LifecycleState::Opening.as_u8()));
        let pending_overflow = Arc::new(AtomicBool::new(false));
        let (startup_tx, startup_rx) = std_sync_channel::<Result<(), FilesError>>(1);

        let worker_state = Arc::clone(&state);
        let worker_overflow = Arc::clone(&pending_overflow);
        let worker = std::thread::Builder::new()
            .name("dohc-files-actor".to_owned())
            .spawn(move || {
                worker_main(
                    root,
                    bounds,
                    rehydrated,
                    rx,
                    worker_state,
                    worker_overflow,
                    startup_tx,
                )
            })
            .map_err(|_| FilesError::PoolUnavailable {
                reason: "could not spawn files actor worker thread",
            })?;

        match startup_rx.recv() {
            Ok(Ok(())) => Ok(FilesActor {
                tx,
                close_permit,
                state,
                pending_overflow,
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

    /// Spawn from WITHIN a tokio runtime: the blocking startup handshake runs on
    /// a dedicated OS thread (off the runtime) and the result is awaited, so no
    /// runtime worker is blocked and [`FilesActor::spawn`]'s off-runtime guard
    /// is respected.
    pub async fn spawn_async(root: PathBuf, bounds: ScanBounds) -> Result<Self, FilesError> {
        Self::spawn_async_with_manifest(root, bounds, None).await
    }

    /// Async, rehydrated counterpart of [`FilesActor::spawn_with_manifest`] —
    /// see that method and [`FilesActor::spawn_async`].
    pub async fn spawn_async_with_manifest(
        root: PathBuf,
        bounds: ScanBounds,
        rehydrated: Option<(ScanManifest, ScanGeneration)>,
    ) -> Result<Self, FilesError> {
        let (tx, rx) = oneshot::channel();
        std::thread::Builder::new()
            .name("dohc-files-spawn".to_owned())
            .spawn(move || {
                let _ = tx.send(FilesActor::spawn_with_manifest(root, bounds, rehydrated));
            })
            .map_err(|_| FilesError::PoolUnavailable {
                reason: "could not spawn files actor startup thread",
            })?;
        rx.await.map_err(|_| FilesError::ActorUnavailable)?
    }

    /// A clonable, message-only handle for issuing commands.
    pub fn handle(&self) -> FilesHandle {
        FilesHandle {
            tx: self.tx.clone(),
            state: Arc::clone(&self.state),
            pending_overflow: Arc::clone(&self.pending_overflow),
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
    pending_overflow: Arc<AtomicBool>,
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

    /// Prepare a full scan + diff against the last acknowledged generation.
    /// Cancellable at between-unit boundaries; capture/ack is separate.
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
    /// Sets a sticky dirty flag INDEPENDENT of the command channel, so the mark
    /// can NEVER be lost to backpressure (unlike a `try_send`, which drops on a
    /// full queue). The worker folds the flag into the controller at the top of
    /// each command, before any dirty-clearing capture acknowledgement, so the forced full
    /// rescan is guaranteed. Infallible and non-blocking.
    pub fn notify_overflow(&self) {
        self.pending_overflow.store(true, Ordering::Release);
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

    /// Serialize a completed apply receipt back through the actor. Only the
    /// receipt's successful paths advance; a stale plan is refused. A crashed
    /// receipt must never be acknowledged.
    pub async fn acknowledge_capture(
        &self,
        plan: ReconcilePlan,
        result: CaptureApplyResult,
    ) -> Result<(), FilesError> {
        if !result.completed() {
            return Err(FilesError::StaleReconcilePlan);
        }
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::AcknowledgeCapture {
                receipt: Box::new((plan, result)),
                reply,
            })
            .await
            .map_err(|_| FilesError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| FilesError::ActorUnavailable)?
    }

    /// Reconcile under a deadline. The whole operation — including waiting for
    /// queue space — is bounded by `deadline`; on expiry the shared `token` is
    /// cancelled (stopping the scan at its next between-unit boundary) and
    /// [`FilesError::DeadlineExceeded`] is returned. A reconcile that already
    /// prepared before the deadline is returned, but no generation advances
    /// until its capture receipt is acknowledged.
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

/// Debug-only guard: [`FilesActor::spawn`] blocks on a startup handshake, which
/// would stall a tokio worker thread. Catch on-runtime misuse cheaply in debug
/// builds (mirrors `dohc-engine-runtime`'s sync-context guard); use
/// [`FilesActor::spawn_async`] from within a runtime.
#[inline]
fn debug_assert_off_runtime() {
    debug_assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "FilesActor::spawn called from within a tokio runtime; use FilesActor::spawn_async"
    );
}

fn worker_main(
    root: PathBuf,
    bounds: ScanBounds,
    rehydrated: Option<(ScanManifest, ScanGeneration)>,
    mut rx: mpsc::Receiver<Command>,
    state: Arc<AtomicU8>,
    pending_overflow: Arc<AtomicBool>,
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
    let mut controller = match rehydrated {
        Some((manifest, generation)) => ReconcileController::rehydrated(manifest, generation),
        None => ReconcileController::new(),
    };

    state.store(LifecycleState::Ready.as_u8(), Ordering::Release);
    if startup_tx.send(Ok(())).is_err() {
        return;
    }
    drop(startup_tx);

    while let Some(cmd) = rx.blocking_recv() {
        // Fold any sticky watcher-overflow signal into the controller BEFORE
        // handling this command, so a dirty mark set during the previous
        // (possibly long) command is never lost — and, critically, is applied
        // before any dirty-clearing capture acknowledgement in THIS command runs. An overflow
        // that arrives DURING a reconcile's scan re-sets the flag and is folded
        // at the next command, so a change is never dropped.
        if pending_overflow.swap(false, Ordering::AcqRel) {
            controller.mark_dirty();
        }
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
            Command::Stats { reply } => {
                let gauge = scanner.pool().gauge();
                let _ = reply.send(FilesStats {
                    quarantined: controller.quarantined_paths().len(),
                    generation: controller.generation(),
                    dirty: controller.is_dirty(),
                    tracked: controller.tracked_len(),
                    max_hash_concurrency: gauge.max_concurrent(),
                    hashed: gauge.hashed(),
                });
            }
            Command::AcknowledgeCapture { receipt, reply } => {
                let (plan, result) = &*receipt;
                let _ = reply.send(controller.acknowledge_capture(plan, result));
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
