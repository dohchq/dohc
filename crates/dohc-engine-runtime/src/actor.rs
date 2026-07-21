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
use crate::search::{SearchResult, search_workspace};
use dohc_engine_collab::{
    AppendOutcome, CloseOutcome, ContentKind, DocKey, Projection, Regime, Ydoc,
};
use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    BinaryHead, BinaryHeadMeta, CaptureIngest, CaptureIngestBinary, CaptureIngestBinaryResult,
    CaptureManifestSeedEntry, CaptureRetire, CaptureRetireResult, CaptureSecret,
    CaptureSecretRetire, InbandBinary, InbandSecret, InbandText, ListMomentsQuery, MomentPage,
    MomentRecord, ResolveTextConflict, ResolveTextConflictResult, SecretFileStat, SecretFileStore,
    SecretMomentRecord, SecretWriteResult, SnapshotMetadata, SnapshotView, TextConflict,
    TextSnapshot, VersionRecord, VersionedTextStore, WriteResult, WriteText, capture_manifest_seed,
    capture_secret_retire, derive_capture_object_id, enqueue_write, has_secret_state,
    insert_text_conflict_if_absent, list_secret_files_keyless, list_secret_files_keyless_page,
    secret_file_len_keyless, select_snapshot_by_path_in_tx, write_projected_text_in_tx,
};
use dohc_engine_files::{DurabilityPolicy, JobOutcome, StdBackoff, StdReplacer, materialize_one};
use dohc_engine_storage::{
    CompoundWrite, Document, EngineStore, FaultInjector, NoFaults, Preimage, StorageError,
    TxnOutcome, WriteOutcome,
};
use dohc_engine_sync::{
    ApplyOutcome, ConflictApplyResult, ReplicationEnvelope, apply_conflict_envelope,
};
use rusqlite::params;
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

/// Actor-owned snapshot used to establish one daemon Y.Doc session without
/// exposing the store connection to the protocol layer.
#[derive(Debug)]
pub struct YdocOpenState {
    pub key: DocKey,
    pub content_kind: ContentKind,
    pub regime: Regime,
    pub initial_update: Vec<u8>,
    pub lineage_existing: bool,
    pub seed_markdown: Option<String>,
}

/// Result of the single moment+snapshot+materialization settlement path.
#[derive(Debug)]
pub struct YdocSettlement {
    pub moment_id: String,
    pub path: String,
    pub markdown: String,
    pub sha256: String,
    pub projection: Projection,
}

/// Daemon-owned sink for identities written by settlement. Recording before
/// the actor replies closes the watcher race between atomic replace and the
/// protocol layer regaining control.
pub trait SelfWriteRecorder: Send + Sync {
    fn record(&self, workspace_id: &str, path: &str, sha256: &str);
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
    BindShadowClone {
        token: String,
        reply: oneshot::Sender<Result<bool, StorageError>>,
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
    VersionedTextWrite {
        input: WriteText,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<WriteResult, RuntimeError>>,
    },
    CaptureIngest {
        input: CaptureIngest,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<WriteResult, RuntimeError>>,
    },
    CaptureIngestBinary {
        input: CaptureIngestBinary,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<CaptureIngestBinaryResult, RuntimeError>>,
    },
    CaptureSecret {
        // Boxed: the plaintext + key payload should not size every command
        // slot, and the key must never be duplicated by channel copies.
        payload: Box<(CaptureSecret, SecretDataKey)>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<SecretWriteResult, RuntimeError>>,
    },
    CaptureSecretRetire {
        input: CaptureSecretRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<SecretMomentRecord>, RuntimeError>>,
    },
    SecretStateExists {
        workspace_id: String,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    CaptureRetire {
        input: CaptureRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<CaptureRetireResult, RuntimeError>>,
    },
    VersionedTextRead {
        workspace_id: String,
        version_id: String,
        path: String,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<TextSnapshot>, RuntimeError>>,
    },
    ListVersions {
        workspace_id: String,
        reply: oneshot::Sender<Result<Vec<VersionRecord>, RuntimeError>>,
    },
    ListSnapshots {
        workspace_id: String,
        version_id: String,
        reply: oneshot::Sender<Result<Vec<SnapshotView>, RuntimeError>>,
    },
    ListSnapshotMetadata {
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<SnapshotMetadata>, RuntimeError>>,
    },
    ListMoments {
        query: Box<ListMomentsQuery>,
        reply: oneshot::Sender<Result<MomentPage, RuntimeError>>,
    },
    GetMoment {
        workspace_id: String,
        moment_id: String,
        reply: oneshot::Sender<Result<Option<MomentRecord>, RuntimeError>>,
    },
    ReadBinary {
        workspace_id: String,
        version_id: String,
        path: String,
        reply: oneshot::Sender<Result<Option<BinaryHead>, RuntimeError>>,
    },
    ReadBinaryMeta {
        workspace_id: String,
        version_id: String,
        path: String,
        reply: oneshot::Sender<Result<Option<BinaryHeadMeta>, RuntimeError>>,
    },
    ReadTextInband {
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
        reply: oneshot::Sender<Result<Option<InbandText>, RuntimeError>>,
    },
    ReadBinaryInband {
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
        reply: oneshot::Sender<Result<Option<InbandBinary>, RuntimeError>>,
    },
    MaterializeSecretInband {
        workspace_id: String,
        version_id: String,
        path: String,
        key: Box<SecretDataKey>,
        cap: usize,
        reply: oneshot::Sender<Result<Option<InbandSecret>, RuntimeError>>,
    },
    ListSecretFiles {
        workspace_id: String,
        version_id: String,
        reply: oneshot::Sender<Result<Vec<SecretFileStat>, RuntimeError>>,
    },
    SecretFileLen {
        workspace_id: String,
        version_id: String,
        path: String,
        reply: oneshot::Sender<Result<Option<i64>, RuntimeError>>,
    },
    ListSecretFilesPage {
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<SecretFileStat>, RuntimeError>>,
    },
    MaterializeSecret {
        workspace_id: String,
        version_id: String,
        path: String,
        key: Box<SecretDataKey>,
        reply: oneshot::Sender<Result<Option<String>, RuntimeError>>,
    },
    ActiveVersionId {
        workspace_id: String,
        reply: oneshot::Sender<Result<String, RuntimeError>>,
    },
    CaptureManifestSeed {
        workspace_id: String,
        version_id: String,
        reply: oneshot::Sender<Result<Vec<CaptureManifestSeedEntry>, RuntimeError>>,
    },
    YdocApply {
        key: DocKey,
        content_kind: ContentKind,
        update: Vec<u8>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<AppendOutcome, RuntimeError>>,
    },
    YdocOpenState {
        workspace_id: String,
        version_id: String,
        path: String,
        content_kind: Option<ContentKind>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<YdocOpenState, RuntimeError>>,
    },
    YdocRecordUpdate {
        key: DocKey,
        content_kind: ContentKind,
        regime: Regime,
        update: Vec<u8>,
        require_empty_lineage: bool,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<AppendOutcome, RuntimeError>>,
    },
    YdocSettle {
        root_dir: PathBuf,
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        session_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<YdocSettlement, RuntimeError>>,
    },
    YdocResync {
        key: DocKey,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Vec<u8>, RuntimeError>>,
    },
    YdocCloseSession {
        key: DocKey,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<CloseOutcome>, RuntimeError>>,
    },
    ConflictList {
        workspace_id: String,
        status: Option<String>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Vec<TextConflict>, RuntimeError>>,
    },
    ConflictOpen {
        conflict: Box<TextConflict>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    ConflictResolve {
        input: ResolveTextConflict,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ResolveTextConflictResult, RuntimeError>>,
    },
    ConflictApplyReplicated {
        envelope: ReplicationEnvelope,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ApplyOutcome<ConflictApplyResult>, RuntimeError>>,
    },
    Search {
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        query: String,
        limit: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Vec<SearchResult>, RuntimeError>>,
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

    /// Capture a text file on the actor's writer, blocking the calling thread.
    pub fn capture_ingest_blocking(
        &self,
        input: CaptureIngest,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureIngest {
                input,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a binary file on the actor's writer, blocking the caller.
    pub fn capture_ingest_binary_blocking(
        &self,
        input: CaptureIngestBinary,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureIngestBinary {
                input,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a secret file on the actor's writer, blocking the caller. The
    /// workspace data key travels with the request (the actor holds no key
    /// state; custody stays at the composition layer).
    pub fn capture_secret_blocking(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<SecretWriteResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureSecret {
                payload: Box::new((input, key)),
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured secret path on the actor's writer, blocking the
    /// caller. Keyless: a delete never decrypts.
    pub fn capture_secret_retire_blocking(
        &self,
        input: CaptureSecretRetire,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureSecretRetire {
                input,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Whether the workspace holds ANY encrypted secret state — the async
    /// variant for RPC handlers (a missing key file over live secret rows
    /// must fail closed, never read as "no secrets").
    pub async fn secret_state_exists(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::SecretStateExists {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Whether the workspace holds ANY encrypted secret state. The capture
    /// layer consults this before ever MINTING a data key: a missing key file
    /// over live secret rows must fail closed, never silently strand the
    /// history under a fresh key.
    pub fn secret_state_exists_blocking(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::SecretStateExists {
                workspace_id,
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured path on the actor's writer, blocking the caller.
    pub fn capture_retire_blocking(
        &self,
        input: CaptureRetire,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureRetire {
                input,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
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

    /// Stamp a fresh shadow database or verify an existing shadow binding on
    /// the actor-owned connection before the workspace can accept writes.
    pub async fn bind_shadow_clone(&self, token: String) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::BindShadowClone { token, reply })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Execute a versioned-text write on the actor's single writer thread.
    pub async fn versioned_text_write(
        &self,
        input: WriteText,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextWrite {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a text file on the actor's single writer thread.
    pub async fn capture_ingest(
        &self,
        input: CaptureIngest,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureIngest {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a binary file on the actor's single writer thread.
    pub async fn capture_ingest_binary(
        &self,
        input: CaptureIngestBinary,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureIngestBinary {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Every version record in the workspace, oldest-first
    /// (`created_at_ms, name, version_id`) — the read behind `versions.list`.
    pub async fn list_versions(
        &self,
        workspace_id: String,
    ) -> Result<Vec<VersionRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListVersions {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn list_snapshots(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<SnapshotView>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSnapshots {
                workspace_id,
                version_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// One page of snapshot METADATA (no body hydration) — the listing read
    /// behind `versionedText.list`.
    pub async fn list_snapshot_metadata(
        &self,
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<Vec<SnapshotMetadata>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSnapshotMetadata {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn list_moments(&self, query: ListMomentsQuery) -> Result<MomentPage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListMoments {
                query: Box::new(query),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn get_moment(
        &self,
        workspace_id: String,
        moment_id: String,
    ) -> Result<Option<MomentRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::GetMoment {
                workspace_id,
                moment_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn read_binary(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<BinaryHead>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinary {
                workspace_id,
                version_id,
                path,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// The binary head's metadata (no bytes) — sized in SQL.
    pub async fn read_binary_meta(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<BinaryHeadMeta>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinaryMeta {
                workspace_id,
                version_id,
                path,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Text head with the body hydrated only under `cap` — one actor turn.
    pub async fn read_text_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
    ) -> Result<Option<InbandText>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadTextInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Binary head with the bytes hydrated only under `cap` — one actor turn.
    pub async fn read_binary_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
    ) -> Result<Option<InbandBinary>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinaryInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Secret materialize with the cap decided in the SAME turn — an
    /// over-cap tip is never decrypted.
    pub async fn materialize_secret_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        key: SecretDataKey,
        cap: usize,
    ) -> Result<Option<InbandSecret>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::MaterializeSecretInband {
                workspace_id,
                version_id,
                path,
                key: Box::new(key),
                cap,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn list_secret_files(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<SecretFileStat>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSecretFiles {
                workspace_id,
                version_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// One secret tip's recorded byte length — keyless, no decrypt.
    pub async fn secret_file_len(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<i64>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::SecretFileLen {
                workspace_id,
                version_id,
                path,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// One page of secret-file tips (metadata only, keyset by path).
    pub async fn list_secret_files_page(
        &self,
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<Vec<SecretFileStat>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSecretFilesPage {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Decrypt one secret tip to UTF-8 plaintext. The KEY comes from the
    /// caller (the daemon loads it from the workspace root), matching the
    /// capture-secret pattern — the actor never holds key custody itself.
    pub async fn materialize_secret(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        key: SecretDataKey,
    ) -> Result<Option<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::MaterializeSecret {
                workspace_id,
                version_id,
                path,
                key: Box::new(key),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// The workspace's ACTIVE version id (falling back to main), read on the
    /// actor thread. The capture driver targets this so captures land in the
    /// version the user is actually on (TS oracle parity).
    pub async fn active_version_id(&self, workspace_id: String) -> Result<String, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ActiveVersionId {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Every captured path with its content identity, for seeding a fresh
    /// files-layer manifest on workspace (re)open (deleted-while-closed
    /// files must retire against the seed, never survive an empty baseline).
    pub async fn capture_manifest_seed(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<CaptureManifestSeedEntry>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureManifestSeed {
                workspace_id,
                version_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a secret file on the actor's single writer thread.
    pub async fn capture_secret(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureSecret {
                payload: Box::new((input, key)),
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured secret path on the actor's single writer thread.
    pub async fn capture_secret_retire(
        &self,
        input: CaptureSecretRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureSecretRetire {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured path on the actor's single writer thread.
    pub async fn capture_retire(
        &self,
        input: CaptureRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureRetire {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Read one versioned text snapshot on the actor-owned connection.
    pub async fn versioned_text_read(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        token: CancellationToken,
    ) -> Result<Option<TextSnapshot>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextRead {
                workspace_id,
                version_id,
                path,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Validate and append one local Y.Doc update. Marker creation and append
    /// are separate bounded transactions with a cancellation point between.
    pub async fn ydoc_apply(
        &self,
        key: DocKey,
        content_kind: ContentKind,
        update: Vec<u8>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AppendOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocApply {
                key,
                content_kind,
                update,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn ydoc_open_state(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        content_kind: Option<ContentKind>,
        token: CancellationToken,
    ) -> Result<YdocOpenState, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocOpenState {
                workspace_id,
                version_id,
                path,
                content_kind,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_record_update(
        &self,
        key: DocKey,
        content_kind: ContentKind,
        regime: Regime,
        update: Vec<u8>,
        require_empty_lineage: bool,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AppendOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocRecordUpdate {
                key,
                content_kind,
                regime,
                update,
                require_empty_lineage,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_settle(
        &self,
        root_dir: PathBuf,
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        session_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<YdocSettlement, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocSettle {
                root_dir,
                key,
                path,
                content_kind,
                session_id,
                self_writes,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn ydoc_resync(
        &self,
        key: DocKey,
        token: CancellationToken,
    ) -> Result<Vec<u8>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocResync { key, token, reply })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn ydoc_close_session(
        &self,
        key: DocKey,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<CloseOutcome>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocCloseSession {
                key,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_list(
        &self,
        workspace_id: String,
        status: Option<String>,
        token: CancellationToken,
    ) -> Result<Vec<TextConflict>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictList {
                workspace_id,
                status,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_open(
        &self,
        conflict: TextConflict,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictOpen {
                conflict: Box::new(conflict),
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_resolve(
        &self,
        input: ResolveTextConflict,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ResolveTextConflictResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictResolve {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_apply_replicated(
        &self,
        envelope: ReplicationEnvelope,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ApplyOutcome<ConflictApplyResult>, RuntimeError> {
        // Keep the complete typed result on the actor boundary: callers need
        // the structured `pending_resolve`, not only its derived boolean view.
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictApplyReplicated {
                envelope,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn search(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        query: String,
        limit: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<Vec<SearchResult>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Search {
                root_dir,
                workspace_id,
                version_id,
                query,
                limit,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
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
        // The deadline bounds the WHOLE operation, including enqueue: under a
        // full command queue `send().await` can block past the deadline, so the
        // wait for queue space is inside the timed select too.
        let deadline_at = tokio::time::Instant::now() + deadline;
        let (reply, reply_rx) = oneshot::channel();

        tokio::select! {
            biased;
            sent = self.tx.send(Command::RunUnits {
                units,
                faults,
                token: token.clone(),
                reply,
            }) => sent.map_err(|_| RuntimeError::ActorUnavailable)?,
            () = tokio::time::sleep_until(deadline_at) => {
                // Never admitted; nothing was cancelled to observe.
                token.cancel();
                return Err(RuntimeError::DeadlineExceeded);
            }
        }

        tokio::select! {
            biased;
            result = reply_rx => result
                .map_err(|_| RuntimeError::ActorUnavailable)?
                .map_err(RuntimeError::Storage),
            () = tokio::time::sleep_until(deadline_at) => {
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
            Command::BindShadowClone { token, reply } => {
                let _ = reply.send(store.bind_shadow_clone_token(&token));
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
            Command::VersionedTextWrite {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    versioned_text_write_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::CaptureIngest {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome = capture_ingest_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::CaptureIngestBinary {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    capture_ingest_binary_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::CaptureSecret {
                payload,
                faults,
                token,
                reply,
            } => {
                let (input, key) = *payload;
                let outcome =
                    capture_secret_on_store(&mut store, &input, &key, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::CaptureSecretRetire {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    capture_secret_retire_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::SecretStateExists {
                workspace_id,
                reply,
            } => {
                let outcome =
                    has_secret_state(&mut store, &workspace_id).map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListVersions {
                workspace_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_versions(&workspace_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListSnapshots {
                workspace_id,
                version_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_snapshots(&workspace_id, &version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListSnapshotMetadata {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_snapshot_metadata(
                        &workspace_id,
                        &version_id,
                        after_path.as_deref(),
                        limit,
                    )
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListMoments { query, reply } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_moments(&query)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::GetMoment {
                workspace_id,
                moment_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .get_moment(&workspace_id, &moment_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinary {
                workspace_id,
                version_id,
                path,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinaryMeta {
                workspace_id,
                version_id,
                path,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary_meta(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadTextInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_text_inband(&workspace_id, &version_id, &path, cap)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinaryInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary_inband(&workspace_id, &version_id, &path, cap)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::MaterializeSecretInband {
                workspace_id,
                version_id,
                path,
                key,
                cap,
                reply,
            } => {
                let outcome = SecretFileStore::new(&mut store, &key)
                    .materialize_secret_file_inband(&workspace_id, &version_id, &path, cap)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListSecretFiles {
                workspace_id,
                version_id,
                reply,
            } => {
                let outcome = list_secret_files_keyless(&store, &workspace_id, &version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::SecretFileLen {
                workspace_id,
                version_id,
                path,
                reply,
            } => {
                let outcome = secret_file_len_keyless(&store, &workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListSecretFilesPage {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            } => {
                let outcome = list_secret_files_keyless_page(
                    &store,
                    &workspace_id,
                    &version_id,
                    after_path.as_deref(),
                    limit,
                )
                .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::MaterializeSecret {
                workspace_id,
                version_id,
                path,
                key,
                reply,
            } => {
                let outcome = SecretFileStore::new(&mut store, &key)
                    .materialize_secret_file(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from)
                    .and_then(|plaintext| match plaintext {
                        None => Ok(None),
                        Some(plaintext) => plaintext.into_utf8().map(Some).map_err(|_| {
                            RuntimeError::from(dohc_engine_domain::DomainError::StateCorrupt {
                                reason: "secret plaintext is not utf-8",
                            })
                        }),
                    });
                let _ = reply.send(outcome);
            }
            Command::ActiveVersionId {
                workspace_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .get_active_version(&workspace_id)
                    .map(|version| version.version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::CaptureManifestSeed {
                workspace_id,
                version_id,
                reply,
            } => {
                let outcome = capture_manifest_seed(&store, &workspace_id, &version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::CaptureRetire {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome = capture_retire_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::VersionedTextRead {
                workspace_id,
                version_id,
                path,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .read_text(&workspace_id, &version_id, &path)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::YdocApply {
                key,
                content_kind,
                update,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = ydoc_apply_on_store(
                    &mut store,
                    &key,
                    content_kind,
                    &update,
                    now_ms,
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocOpenState {
                workspace_id,
                version_id,
                path,
                content_kind,
                token,
                reply,
            } => {
                let outcome = ydoc_open_state_on_store(
                    &mut store,
                    &workspace_id,
                    &version_id,
                    &path,
                    content_kind,
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocRecordUpdate {
                key,
                content_kind,
                regime,
                update,
                require_empty_lineage,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = ydoc_record_update_on_store(
                    &mut store,
                    &key,
                    content_kind,
                    regime,
                    &update,
                    require_empty_lineage,
                    now_ms,
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocSettle {
                root_dir,
                key,
                path,
                content_kind,
                session_id,
                self_writes,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = ydoc_settle_on_store(
                    &mut store,
                    &root_dir,
                    &key,
                    &path,
                    content_kind,
                    &session_id,
                    self_writes.as_ref(),
                    now_ms,
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocResync { key, token, reply } => {
                let outcome = ydoc_resync_on_store(&store, &key, &token);
                let _ = reply.send(outcome);
            }
            Command::YdocCloseSession {
                key,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    ydoc_close_session_on_store(&mut store, &key, now_ms, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::ConflictList {
                workspace_id,
                status,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .list_text_conflicts(&workspace_id, status.as_deref())
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ConflictOpen {
                conflict,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    conflict_open_on_store(&mut store, &conflict, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::ConflictResolve {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .resolve_text_conflict(&input, faults.as_ref())
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ConflictApplyReplicated {
                envelope,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    apply_conflict_envelope(&mut store, &envelope, faults.as_ref())
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::Search {
                root_dir,
                workspace_id,
                version_id,
                query,
                limit,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    store
                        .read_with(|conn| {
                            search_workspace(
                                conn,
                                &root_dir,
                                &workspace_id,
                                &version_id,
                                &query,
                                limit,
                                now_ms,
                            )
                        })
                        .map_err(RuntimeError::from)
                };
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

fn ydoc_apply_on_store(
    store: &mut EngineStore,
    key: &DocKey,
    content_kind: ContentKind,
    update: &[u8],
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<AppendOutcome, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    match dohc_engine_collab::record_local_update_creating_marker(
        store,
        key,
        content_kind,
        Regime::Replicated,
        update,
        faults,
        now_ms,
    )? {
        TxnOutcome::Committed(outcome) => Ok(outcome),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn ydoc_open_state_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    requested_content_kind: Option<ContentKind>,
    token: &CancellationToken,
) -> Result<YdocOpenState, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let head = VersionedTextStore::new(store).read_text(workspace_id, version_id, path)?;
    let object_id = head.as_ref().map_or_else(
        || derive_capture_object_id(workspace_id, version_id, path),
        |snapshot| snapshot.object_id.clone(),
    );
    let key = DocKey::new(workspace_id, version_id, object_id)?;
    // Re-converge BEFORE loading state: an envelope acked-but-deferred while
    // a previous session held the lease is only guaranteed to drain on that
    // session's ydoc.close — workspace.close, stale-handle eviction, and a
    // crash all skip it. The imported replication log is the durable pending
    // queue, and replaying an already-applied row is content-deduped, so
    // draining on every open makes the parked update land on the next use
    // of the doc no matter how the previous session ended.
    if dohc_engine_collab::read_marker(store, &key)?
        .is_some_and(|marker| marker.regime == Regime::Replicated)
    {
        dohc_engine_sync::drain_deferred_ydoc_for_key(store, &key, &NoFaults)?;
    }
    let persisted = dohc_engine_collab::load_persisted(store, &key)?;
    // "Existing" means durable DOC STATE, not a bare marker: a local-only
    // close prunes every CRDT row and leaves head_update_seq == 0
    // (markdown-is-the-artifact). Reporting such a lineage as existing would
    // hand the client an EMPTY doc with no seedMarkdown — its next settle
    // would clobber the settled file. A pruned marker is seed-eligible
    // (the recordUpdate guard checks head_update_seq > 0), so the artifact
    // re-seeds the cache exactly like a first open.
    let lineage_existing = persisted
        .as_ref()
        .is_some_and(|persisted| persisted.marker.head_update_seq > 0);
    let (content_kind, regime, initial_update) = match persisted {
        Some(persisted) => (
            persisted.marker.content_kind,
            persisted.marker.regime,
            persisted.doc.encode_full_state(),
        ),
        None => {
            let doc = Ydoc::wire();
            (
                requested_content_kind.unwrap_or(ContentKind::Richdoc),
                Regime::LocalOnly,
                doc.encode_full_state(),
            )
        }
    };
    Ok(YdocOpenState {
        key,
        content_kind,
        regime,
        initial_update,
        lineage_existing,
        seed_markdown: (!lineage_existing)
            .then(|| head.map(|snapshot| snapshot.text))
            .flatten(),
    })
}

#[allow(clippy::too_many_arguments)]
fn ydoc_record_update_on_store(
    store: &mut EngineStore,
    key: &DocKey,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    require_empty_lineage: bool,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<AppendOutcome, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if require_empty_lineage
        && dohc_engine_collab::read_marker(store, key)?
            .is_some_and(|marker| marker.head_update_seq > 0)
    {
        return Err(dohc_engine_collab::CollabError::SeedOntoExistingLineage.into());
    }
    let parent = store.write_with(faults, |tx| {
        tx.execute(
            "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
             VALUES (?1, ?2, ?3)",
            params![key.workspace_id, key.object_id, now_ms],
        )
        .map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    })?;
    if matches!(parent, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    match dohc_engine_collab::record_local_update_creating_marker(
        store,
        key,
        content_kind,
        regime,
        update,
        faults,
        now_ms,
    )? {
        TxnOutcome::Committed(outcome) => Ok(outcome),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

#[allow(clippy::too_many_arguments)]
fn ydoc_settle_on_store(
    store: &mut EngineStore,
    root_dir: &std::path::Path,
    key: &DocKey,
    path: &str,
    content_kind: ContentKind,
    session_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<YdocSettlement, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    // Refuse to settle a lineage that has no durable state: projecting a
    // fresh doc would be the empty string, and the projected write below
    // would clobber the existing file with it. Mirrors collab settle()'s
    // NoMarker refusal.
    let doc = match dohc_engine_collab::load_persisted(store, key)? {
        Some(persisted) => persisted.doc,
        None => return Err(dohc_engine_collab::CollabError::NoMarker.into()),
    };
    let projection = doc.project(content_kind);
    let projection_for_write = projection.clone();
    let outcome = store.write_with(faults, |tx| {
        let current = select_snapshot_by_path_in_tx(tx, &key.workspace_id, &key.version_id, path)?;
        if current.binary_sha256.is_some() {
            return Err(dohc_engine_domain::DomainError::BinaryHeadNotText);
        }
        // The path may have changed owners since ydoc.open (another write
        // claimed it with a different object). Settling anyway would overwrite
        // the OTHER object's head with this session's stale projection while
        // marking this lineage settled — refuse as a stale target instead.
        if let Some(snapshot) = current.snapshot.as_ref()
            && snapshot.object_id != key.object_id
        {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget);
        }
        let preimage = current
            .snapshot
            .as_ref()
            .map_or(Preimage::Absent, |snapshot| {
                Preimage::Present(snapshot.blob_sha256.clone())
            });
        let previous_moment = current
            .snapshot
            .as_ref()
            .map_or("absent", |snapshot| snapshot.latest_moment_id.as_str());
        let fingerprint = format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}",
            key.workspace_id,
            key.version_id,
            key.object_id,
            path,
            session_id,
            previous_moment,
            projection_for_write.source_state_vector_sha256,
        );
        let moment_id = format!(
            "moment-ydoc-{}",
            dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
        );
        let result = write_projected_text_in_tx(
            tx,
            &WriteText {
                workspace_id: key.workspace_id.clone(),
                version_id: key.version_id.clone(),
                object_id: key.object_id.clone(),
                path: path.to_owned(),
                text: projection_for_write.markdown.clone(),
                moment_id,
                metadata_origin: "ydoc".to_owned(),
                author_json: None,
                now_ms,
                request_id: None,
            },
        )?;
        enqueue_write(tx, &result, preimage, "ydoc")?;
        // The settle marker commits ATOMICALLY with the moment: a crash can
        // never leave a minted settlement moment whose lineage still reads
        // as unsettled (which would force a non-idempotent re-settle — the
        // moment fingerprint includes the per-open session_id).
        //
        // settle_seq namespace: the daemon settle path owns this column and
        // writes moment_order into it; collab settle()'s +1 generation
        // counter is never invoked on daemon-settled lineages (C1 has no
        // collab-settle caller). The close guard reads last_settled_sha only.
        tx.execute(
            "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                result.moment.moment_order,
                result.snapshot.blob_sha256,
                now_ms,
            ],
        )
        .map_err(|error| {
            dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
        })?;
        Ok(result)
    })?;
    let write = match outcome {
        TxnOutcome::Committed(write) => write,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    // NO cancellation checks past this point: the settle marker committed
    // with the moment above, so a Cancelled return here would report failure
    // for a settle the lineage already records — and close(settle:false)
    // could then prune the CRDT with the artifact never materialized or
    // suppressed. Once committed, the settle runs to completion.
    let job_id = format!("ydoc-mat_{}", write.moment.moment_id);
    let job = store.load_materialization_job(&job_id)?.ok_or_else(|| {
        RuntimeError::Domain(dohc_engine_domain::DomainError::StateCorrupt {
            reason: "Y.Doc settle materialization job is missing",
        })
    })?;
    match materialize_one(
        store,
        root_dir,
        &job,
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &StdBackoff,
        now_ms,
        faults,
    )? {
        JobOutcome::Completed | JobOutcome::AlreadyMaterialized => {}
        JobOutcome::Conflict | JobOutcome::Superseded => {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
        }
        JobOutcome::Crashed(_) => return Err(RuntimeError::OperationCrashed),
    }
    self_writes.record(
        &key.workspace_id,
        &write.snapshot.path,
        &write.snapshot.blob_sha256,
    );
    Ok(YdocSettlement {
        moment_id: write.moment.moment_id,
        path: write.snapshot.path,
        markdown: write.snapshot.text,
        sha256: write.snapshot.blob_sha256,
        projection,
    })
}

fn ydoc_resync_on_store(
    store: &EngineStore,
    key: &DocKey,
    token: &CancellationToken,
) -> Result<Vec<u8>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    Ok(match dohc_engine_collab::load_persisted(store, key)? {
        Some(persisted) => persisted.doc.encode_full_state(),
        None => Ydoc::wire().encode_full_state(),
    })
}

fn ydoc_close_session_on_store(
    store: &mut EngineStore,
    key: &DocKey,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<Option<CloseOutcome>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let Some(marker) = dohc_engine_collab::read_marker(store, key)? else {
        return Ok(None);
    };
    let outcome = match dohc_engine_collab::close_session(store, key, false, faults, now_ms)? {
        TxnOutcome::Committed(outcome) => outcome,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    if marker.regime == Regime::Replicated {
        dohc_engine_sync::drain_deferred_ydoc_for_key(store, key, faults)?;
    }
    Ok(Some(outcome))
}

fn versioned_text_write_on_store(
    store: &mut EngineStore,
    input: &WriteText,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<WriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store).ensure_main_version(
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store)
        .write_text(input, faults)
        .map_err(RuntimeError::from)
}

fn capture_ingest_on_store(
    store: &mut EngineStore,
    input: &CaptureIngest,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<WriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store).ensure_main_version(
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store)
        .capture_ingest(input, faults)
        .map_err(RuntimeError::from)
}

fn capture_ingest_binary_on_store(
    store: &mut EngineStore,
    input: &CaptureIngestBinary,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CaptureIngestBinaryResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store).ensure_main_version(
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store)
        .capture_ingest_binary(input, faults)
        .map_err(RuntimeError::from)
}

fn capture_secret_on_store(
    store: &mut EngineStore,
    input: &CaptureSecret,
    key: &SecretDataKey,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<SecretWriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store).ensure_main_version(
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    SecretFileStore::new(store, key)
        .capture_secret(input, faults)
        .map_err(RuntimeError::from)
}

fn capture_secret_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureSecretRetire,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<Option<SecretMomentRecord>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store).ensure_main_version(
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    capture_secret_retire(store, input, faults).map_err(RuntimeError::from)
}

fn capture_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureRetire,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CaptureRetireResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store).ensure_main_version(
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store)
        .capture_retire(input, faults)
        .map_err(RuntimeError::from)
}

fn conflict_open_on_store(
    store: &mut EngineStore,
    conflict: &TextConflict,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<bool, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let inserted = insert_text_conflict_if_absent(tx, conflict)?;
        if inserted {
            tx.execute(
                "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
                 VALUES (?1, 'conflict.open', ?2)",
                params![conflict.conflict_id, conflict.created_at_ms],
            )
            .map_err(|error| {
                dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
            })?;
        }
        Ok::<_, dohc_engine_domain::DomainError>(inserted)
    })?;
    match outcome {
        TxnOutcome::Committed(inserted) => Ok(inserted),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
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
            // A crash fault ends the run at a durable boundary. An
            // after-commit-before-ack crash already durably committed THIS
            // unit, so count it — otherwise `committed` undercounts what the
            // database actually holds and breaks retry/progress accounting.
            WriteOutcome::Crashed { committed: durable } => {
                if durable {
                    committed += 1;
                }
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
