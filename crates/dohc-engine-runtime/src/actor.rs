//! The workspace actor: a dedicated OS thread owning exactly one storage
//! writer connection, driven by a **tokio** command loop.
//!
//! This is the Rust replacement for the TS engine's process-global write chain
//! and `workspaceActivity` map (`STATE_OWNERSHIP.tsv` rows `chain-store-writes`,
//! `registry-workspace-activity`, `actor-registry`). State ownership is
//! unambiguous: the connection lives on the worker thread and never crosses it;
//! callers hold clonable [`ActorHandle`]s that only send messages
//! (`PORTING.md` §5, §14).
//!
//! ## The blocking writer under an async loop (CAL-2)
//!
//! The writer connection is synchronous, blocking rusqlite. It stays on ONE
//! dedicated OS thread (`std::thread`) — **never** on the async runtime (plan
//! §Workspace actor model: "one writable `rusqlite` connection on a dedicated
//! thread (never blocking the async runtime)"). Commands flow over a bounded
//! [`tokio::sync::mpsc`] channel; the worker consumes them with
//! [`blocking_recv`](tokio::sync::mpsc::Receiver::blocking_recv), so the
//! blocking SQLite work never occupies a runtime worker. Replies come back on
//! [`tokio::sync::oneshot`] channels. The tokio channels are runtime-agnostic
//! for their blocking API, so the CAL-1 synchronous call sites keep working
//! outside any runtime, while the async methods drive the loop from within one.
//!
//! Lifecycle is explicit — `open → ready → draining → closed` — and `Drop`
//! releases the connection deterministically by joining the worker (no detached
//! task outlives the actor). Cancellation ([`CancellationToken`]) is checked
//! BETWEEN bounded units, never inside a transaction (`PORTING.md` §12).

use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
use dohc_engine_storage::{
    CompoundWrite, Document, EngineStore, FaultInjector, StorageError, WriteOutcome,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::sync_channel as std_sync_channel;
use std::thread::JoinHandle;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{self, OwnedPermit};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Bound on the actor's command queue. Backpressure blocks the sender rather
/// than growing an unbounded queue (`plan §Rust policy`: bounded everything).
const COMMAND_QUEUE_CAPACITY: usize = 64;

/// Physical channel capacity: the data bound plus ONE slot reserved at spawn
/// for the `Close` command (see [`WorkspaceActor::close`]). Reserving keeps the
/// usable data capacity at exactly [`COMMAND_QUEUE_CAPACITY`] while guaranteeing
/// `Close` always has a home, so shutdown never spins or starves.
const CHANNEL_CAPACITY: usize = COMMAND_QUEUE_CAPACITY + 1;

/// The actor lifecycle, observable via [`ActorHandle::lifecycle`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    /// The worker thread is opening the store (transient; before the first
    /// command is served).
    Opening,
    /// The store is open and serving commands.
    Ready,
    /// A close was requested; the worker is finishing and will not accept new
    /// work.
    Draining,
    /// The worker has exited and the connection has been released.
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

/// A cheap, comparable snapshot of the store's row counts — enough for
/// durability/convergence assertions without exposing the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreSnapshot {
    pub documents: i64,
    pub journal_entries: i64,
    pub request_ledger: i64,
    pub migration_ledger: i64,
}

/// The outcome of a cancellable multi-unit run ([`ActorHandle::run_units`]).
/// `committed` is the number of units that reached a durable commit; `cancelled`
/// reports whether the run stopped early at a between-unit cancellation point.
/// The store always holds exactly the committed prefix — cancellation never
/// tears a unit (`PORTING.md` §12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnitsOutcome {
    pub committed: usize,
    pub cancelled: bool,
}

enum Command {
    Write {
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
        reply: oneshot::Sender<Result<WriteOutcome, StorageError>>,
    },
    Read {
        doc_id: String,
        reply: oneshot::Sender<Result<Option<Document>, StorageError>>,
    },
    Snapshot {
        reply: oneshot::Sender<Result<StoreSnapshot, StorageError>>,
    },
    /// A long operation: a sequence of bounded units (one compound write each,
    /// one transaction each). The worker checks `token` BEFORE each unit and
    /// stops cooperatively at that between-unit boundary.
    RunUnits {
        units: Vec<CompoundWrite>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<UnitsOutcome, StorageError>>,
    },
    /// Break the loop and release the connection. Carries no reply: the caller
    /// joins the worker, and the join is the completion signal (so `close`
    /// needs no `blocking_recv`, staying safe to call from a `Drop` that runs
    /// inside an async runtime).
    Close,
}

/// Owns the worker thread and the command sender. Held by the supervisor;
/// callers use [`ActorHandle`]s. Dropping it joins the worker.
pub struct WorkspaceActor {
    identity: EngineDbIdentity,
    generation: u64,
    tx: mpsc::Sender<Command>,
    /// A permit for the `Close` command, reserved at spawn from the dedicated
    /// extra channel slot. `close` consumes it to deliver `Close` in bounded
    /// time — fairly, behind existing FIFO work, without a `try_send` spin and
    /// without blocking in `Drop`.
    close_permit: Option<OwnedPermit<Command>>,
    state: Arc<AtomicU8>,
    worker: Option<JoinHandle<()>>,
}

impl WorkspaceActor {
    /// Spawn the actor's worker thread and open the store. Blocks until the
    /// open completes so open errors (including the fingerprint fence)
    /// propagate synchronously. `spawn` is intentionally synchronous — a
    /// workspace open is an infrequent, off-hot-path operation the supervisor
    /// drives without holding its registry lock.
    pub(crate) fn spawn(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
    ) -> Result<Self, RuntimeError> {
        let (tx, rx) = mpsc::channel::<Command>(CHANNEL_CAPACITY);
        // Reserve the dedicated Close slot up front (the channel is empty, so
        // this cannot fail); `close` sends through it without contending with
        // data producers on tokio's fair waiter queue.
        let close_permit = tx.clone().try_reserve_owned().ok();
        let state = Arc::new(AtomicU8::new(LifecycleState::Opening.as_u8()));
        // Startup handshake uses a std channel: `spawn` runs in a synchronous
        // context, so the open result must not depend on a tokio runtime.
        let (startup_tx, startup_rx) = std_sync_channel::<Result<(), StorageError>>(1);

        let worker_state = Arc::clone(&state);
        let worker = std::thread::Builder::new()
            .name("dohc-engine-actor".to_owned())
            .spawn(move || worker_main(db_path, now_ms, rx, worker_state, startup_tx))
            .map_err(RuntimeError::ThreadSpawn)?;

        match startup_rx.recv() {
            Ok(Ok(())) => Ok(WorkspaceActor {
                identity,
                generation,
                tx,
                close_permit,
                state,
                worker: Some(worker),
            }),
            Ok(Err(storage_err)) => {
                let _ = worker.join();
                Err(RuntimeError::Storage(storage_err))
            }
            Err(_) => {
                let _ = worker.join();
                Err(RuntimeError::WorkerPanicked)
            }
        }
    }

    /// A clonable handle for issuing commands.
    pub fn handle(&self) -> ActorHandle {
        ActorHandle {
            identity: self.identity.clone(),
            tx: self.tx.clone(),
            state: Arc::clone(&self.state),
        }
    }

    /// The canonical identity this actor is keyed by.
    pub fn identity(&self) -> &EngineDbIdentity {
        &self.identity
    }

    /// The session generation (incremented on restart).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    /// Orderly close: drain queued work, stop accepting new commands, release
    /// the connection, and join the worker. Idempotent.
    ///
    /// `Close` is delivered through the slot reserved at spawn, so it lands in
    /// bounded time behind existing FIFO work — no `try_send` spin and no
    /// starvation under sustained concurrent submission (tokio's fair waiter
    /// queue can never crowd it out). Sending through the reserved permit does
    /// not block or await, so `close` is safe to call from a `Drop` that runs
    /// inside an async runtime.
    ///
    /// The subsequent `worker.join()` **does block the calling thread** until
    /// the worker drains and exits. From an async runtime that briefly parks the
    /// executor thread; a future `close_async` could yield instead (noted for a
    /// later shard). A worker wedged inside a fault gate must be released by the
    /// caller before close (same contract as CAL-1).
    pub fn close(&mut self) -> Result<(), RuntimeError> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        match self.close_permit.take() {
            // Reserved slot: instant, fair, FIFO-respecting delivery.
            Some(permit) => {
                permit.send(Command::Close);
            }
            // No reserved permit (only if a prior close already consumed it, or
            // the impossible spawn-time reservation failure): best-effort. A
            // Closed error means the worker is already gone — nothing to do.
            None => {
                let _ = self.tx.try_send(Command::Close);
            }
        }
        match worker.join() {
            Ok(()) => Ok(()),
            Err(_) => Err(RuntimeError::WorkerPanicked),
        }
    }
}

impl Drop for WorkspaceActor {
    fn drop(&mut self) {
        // Deterministic release: never leave the worker thread (and its
        // connection) detached.
        let _ = self.close();
    }
}

/// A clonable, message-only handle to a [`WorkspaceActor`]. Holds no state of
/// its own beyond the sender and the shared lifecycle flag.
#[derive(Clone)]
pub struct ActorHandle {
    identity: EngineDbIdentity,
    tx: mpsc::Sender<Command>,
    state: Arc<AtomicU8>,
}

impl ActorHandle {
    /// The canonical identity of the actor this handle addresses.
    pub fn identity(&self) -> &EngineDbIdentity {
        &self.identity
    }

    /// The actor's current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    // --- Synchronous API (CAL-1 call sites; must be used OUTSIDE a runtime) ---

    /// Issue a compound write through the actor's single writer, blocking the
    /// calling thread for the result. For synchronous callers that are not on a
    /// tokio runtime; the async loop is unaffected.
    pub fn write(
        &self,
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteOutcome, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::Write {
                write,
                faults,
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Enqueue a compound write WITHOUT waiting for its result, failing fast
    /// with [`RuntimeError::Overloaded`] if the bounded queue is full. This is
    /// the observable-backpressure path (the protocol's `OVERLOADED`). The
    /// result is not delivered to the caller.
    pub fn try_submit_write(
        &self,
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<(), RuntimeError> {
        // A single-slot reply channel is created and immediately dropped; the
        // worker's later `reply.send` fails harmlessly.
        let (reply, _reply_rx) = oneshot::channel();
        match self.tx.try_send(Command::Write {
            write,
            faults,
            reply,
        }) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(RuntimeError::Overloaded),
            Err(TrySendError::Closed(_)) => Err(RuntimeError::ActorUnavailable),
        }
    }

    /// Read a document by id, blocking the calling thread.
    pub fn read(&self, doc_id: &str) -> Result<Option<Document>, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::Read {
                doc_id: doc_id.to_owned(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Snapshot the store's row counts, blocking the calling thread.
    pub fn snapshot(&self) -> Result<StoreSnapshot, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::Snapshot { reply })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    // --- Async API (drives the tokio loop from within a runtime) ---

    /// Async compound write. Awaits queue space (bounded backpressure) and the
    /// worker's reply.
    pub async fn write_async(
        &self,
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Write {
                write,
                faults,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Async read.
    pub async fn read_async(&self, doc_id: &str) -> Result<Option<Document>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Read {
                doc_id: doc_id.to_owned(),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Run a long operation as a sequence of bounded units, cancellable at each
    /// between-unit boundary via `token`. Returns how many units committed.
    ///
    /// The worker checks the token BEFORE each unit's transaction; once a
    /// unit's `BEGIN IMMEDIATE` starts it always runs to COMMIT/ROLLBACK
    /// (`PORTING.md` §12) — cancellation never tears a unit, so the store holds
    /// exactly the committed prefix.
    pub async fn run_units(
        &self,
        units: Vec<CompoundWrite>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<UnitsOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::RunUnits {
                units,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Run a long operation under a deadline. The units execute on the writer
    /// thread; if `deadline` elapses first, the shared `token` is cancelled
    /// (stopping the run at the next between-unit boundary) and
    /// [`RuntimeError::DeadlineExceeded`] is returned. Work already committed
    /// before the deadline stays durable — exactly-once ack semantics
    /// (`PORTING.md` §12).
    pub async fn run_units_with_deadline(
        &self,
        units: Vec<CompoundWrite>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        deadline: std::time::Duration,
    ) -> Result<UnitsOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::RunUnits {
                units,
                faults,
                token: token.clone(),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;

        tokio::select! {
            biased;
            result = reply_rx => result
                .map_err(|_| RuntimeError::ActorUnavailable)?
                .map_err(RuntimeError::Storage),
            () = tokio::time::sleep(deadline) => {
                // Deadline first: ask the run to stop at its next between-unit
                // boundary. The in-flight unit (if any) still finishes durably.
                token.cancel();
                Err(RuntimeError::DeadlineExceeded)
            }
        }
    }
}

/// Debug-only guard: the synchronous `write`/`read`/`snapshot` API uses
/// `blocking_send`/`blocking_recv`, which PANIC inside a tokio runtime (the
/// product runs on tokio). Catch the misuse cheaply in debug builds with a
/// clear message instead of an opaque tokio panic in production; use the async
/// API from within a runtime.
#[inline]
fn debug_assert_sync_context() {
    debug_assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "synchronous ActorHandle API called from within a tokio runtime; use the async API (write_async/read_async/run_units)"
    );
}

fn worker_main(
    db_path: PathBuf,
    now_ms: i64,
    mut rx: mpsc::Receiver<Command>,
    state: Arc<AtomicU8>,
    startup_tx: std::sync::mpsc::SyncSender<Result<(), StorageError>>,
) {
    // Publish Closed on ANY exit — normal return OR a panic unwind (e.g. a
    // panicking fault injector). Declared before `store` so `store` (and its
    // connection) drops first, then this guard publishes Closed: a reader that
    // observes Closed is guaranteed the writer handle is already gone.
    struct ClosedGuard(Arc<AtomicU8>);
    impl Drop for ClosedGuard {
        fn drop(&mut self) {
            self.0
                .store(LifecycleState::Closed.as_u8(), Ordering::Release);
        }
    }
    let _closed_guard = ClosedGuard(Arc::clone(&state));

    let mut store = match EngineStore::open(&db_path, now_ms) {
        Ok(store) => store,
        Err(err) => {
            let _ = startup_tx.send(Err(err));
            return;
        }
    };
    // Publish Ready *before* acking the open, so a caller that observes the
    // successful open also observes Ready.
    state.store(LifecycleState::Ready.as_u8(), Ordering::Release);
    if startup_tx.send(Ok(())).is_err() {
        // The spawner unwound before the actor was built; nothing to serve.
        return;
    }
    drop(startup_tx);

    // Blocking recv on the tokio channel keeps the SQLite work on THIS
    // dedicated thread, off the async runtime. `blocking_recv` returns `None`
    // once every sender is dropped.
    while let Some(cmd) = rx.blocking_recv() {
        match cmd {
            Command::Write {
                write,
                faults,
                reply,
            } => {
                let outcome = store.commit_compound(&write, faults.as_ref());
                let _ = reply.send(outcome);
            }
            Command::Read { doc_id, reply } => {
                let _ = reply.send(store.read_document(&doc_id));
            }
            Command::Snapshot { reply } => {
                let _ = reply.send(snapshot(&store));
            }
            Command::RunUnits {
                units,
                faults,
                token,
                reply,
            } => {
                let outcome = run_units(&mut store, units, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::Close => {
                // FIFO ordering means every command enqueued before Close has
                // already been served; there is nothing left to drain.
                state.store(LifecycleState::Draining.as_u8(), Ordering::Release);
                break;
            }
        }
    }

    // Normal exit: drop the connection explicitly, then the `_closed_guard`
    // publishes Closed as it falls out of scope (same ordering the guard
    // guarantees on a panic unwind).
    drop(store);
}

/// Execute a run of bounded units, checking `token` BETWEEN units. Each unit is
/// one compound write (one transaction). Stops early and reports `cancelled` if
/// the token trips at a boundary; a storage error aborts the run and surfaces.
fn run_units(
    store: &mut EngineStore,
    units: Vec<CompoundWrite>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<UnitsOutcome, StorageError> {
    let mut committed = 0usize;
    for unit in units {
        // Cancellation point is BETWEEN units, before the next transaction.
        if token.is_cancelled() {
            return Ok(UnitsOutcome {
                committed,
                cancelled: true,
            });
        }
        match store.commit_compound(&unit, faults)? {
            WriteOutcome::Acked { .. } => committed += 1,
            // A crash fault mid-unit ends the run at a durable boundary.
            WriteOutcome::Crashed { .. } => {
                return Ok(UnitsOutcome {
                    committed,
                    cancelled: token.is_cancelled(),
                });
            }
        }
    }
    Ok(UnitsOutcome {
        committed,
        cancelled: false,
    })
}

fn snapshot(store: &EngineStore) -> Result<StoreSnapshot, StorageError> {
    Ok(StoreSnapshot {
        documents: store.document_count()?,
        journal_entries: store.journal_len()?,
        request_ledger: store.request_ledger_len()?,
        migration_ledger: store.migration_ledger_len()?,
    })
}
