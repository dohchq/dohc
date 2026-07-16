//! The workspace actor: a dedicated OS thread owning exactly one storage
//! writer connection, driven by a bounded command channel.
//!
//! This is the Rust replacement for the TS engine's process-global write chain
//! and `workspaceActivity` map (`STATE_OWNERSHIP.tsv` rows `chain-store-writes`,
//! `registry-workspace-activity`, `actor-registry`). State ownership is
//! unambiguous: the connection lives on the worker thread and never crosses it;
//! callers hold clonable [`ActorHandle`]s that only send messages
//! (`PORTING.md` §5, §14). Lifecycle is explicit — `open → ready → draining →
//! closed` — and `Drop` releases the connection deterministically by joining
//! the worker (no detached task outlives the actor).

use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
use dohc_engine_storage::{
    CompoundWrite, Document, EngineStore, FaultInjector, StorageError, WriteOutcome,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::JoinHandle;

/// Bound on the actor's command queue. Backpressure blocks the sender rather
/// than growing an unbounded queue (`plan §Rust policy`: bounded everything).
const COMMAND_QUEUE_CAPACITY: usize = 64;

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

enum Command {
    Write {
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
        reply: SyncSender<Result<WriteOutcome, StorageError>>,
    },
    Read {
        doc_id: String,
        reply: SyncSender<Result<Option<Document>, StorageError>>,
    },
    Snapshot {
        reply: SyncSender<Result<StoreSnapshot, StorageError>>,
    },
    Close {
        reply: SyncSender<()>,
    },
}

/// Owns the worker thread and the command sender. Held by the supervisor;
/// callers use [`ActorHandle`]s. Dropping it joins the worker.
pub struct WorkspaceActor {
    identity: EngineDbIdentity,
    generation: u64,
    tx: SyncSender<Command>,
    state: Arc<AtomicU8>,
    worker: Option<JoinHandle<()>>,
}

impl WorkspaceActor {
    /// Spawn the actor's worker thread and open the store. Blocks until the
    /// open completes so open errors (including the fingerprint fence)
    /// propagate synchronously.
    pub(crate) fn spawn(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
    ) -> Result<Self, RuntimeError> {
        let (tx, rx) = sync_channel::<Command>(COMMAND_QUEUE_CAPACITY);
        let state = Arc::new(AtomicU8::new(LifecycleState::Opening.as_u8()));
        let (startup_tx, startup_rx) = sync_channel::<Result<(), StorageError>>(1);

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
    pub fn close(&mut self) -> Result<(), RuntimeError> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        let (reply_tx, reply_rx) = sync_channel::<()>(1);
        // Blocking send: waits for queue space the worker frees by consuming,
        // so Close is always delivered unless the worker is already gone.
        if self.tx.send(Command::Close { reply: reply_tx }).is_ok() {
            let _ = reply_rx.recv();
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
    tx: SyncSender<Command>,
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

    /// Issue a compound write through the actor's single writer.
    pub fn write(
        &self,
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteOutcome, RuntimeError> {
        let (reply, reply_rx) = sync_channel(1);
        self.tx
            .send(Command::Write {
                write,
                faults,
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Read a document by id.
    pub fn read(&self, doc_id: &str) -> Result<Option<Document>, RuntimeError> {
        let (reply, reply_rx) = sync_channel(1);
        self.tx
            .send(Command::Read {
                doc_id: doc_id.to_owned(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Snapshot the store's row counts.
    pub fn snapshot(&self) -> Result<StoreSnapshot, RuntimeError> {
        let (reply, reply_rx) = sync_channel(1);
        self.tx
            .send(Command::Snapshot { reply })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }
}

fn worker_main(
    db_path: PathBuf,
    now_ms: i64,
    rx: Receiver<Command>,
    state: Arc<AtomicU8>,
    startup_tx: SyncSender<Result<(), StorageError>>,
) {
    let mut store = match EngineStore::open(&db_path, now_ms) {
        Ok(store) => store,
        Err(err) => {
            let _ = startup_tx.send(Err(err));
            return;
        }
    };
    // Publish Ready *before* acking the open, so a caller that observes the
    // successful open also observes Ready (the channel recv synchronizes-with
    // this store).
    state.store(LifecycleState::Ready.as_u8(), Ordering::Release);
    if startup_tx.send(Ok(())).is_err() {
        // The spawner unwound before the actor was built; nothing to serve.
        // `store` drops here, releasing the connection.
        return;
    }
    drop(startup_tx);

    while let Ok(cmd) = rx.recv() {
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
            Command::Close { reply } => {
                // FIFO ordering means every command enqueued before Close has
                // already been served; there is nothing left to drain.
                state.store(LifecycleState::Draining.as_u8(), Ordering::Release);
                let _ = reply.send(());
                break;
            }
        }
    }

    // Release the connection first, then publish Closed — a reader observing
    // Closed is guaranteed the writer handle is gone.
    drop(store);
    state.store(LifecycleState::Closed.as_u8(), Ordering::Release);
}

fn snapshot(store: &EngineStore) -> Result<StoreSnapshot, StorageError> {
    Ok(StoreSnapshot {
        documents: store.document_count()?,
        journal_entries: store.journal_len()?,
        request_ledger: store.request_ledger_len()?,
        migration_ledger: store.migration_ledger_len()?,
    })
}
