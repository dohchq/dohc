//! The workspace actor: a dedicated OS thread owning exactly one storage
//! writer connection, driven by a **tokio** command loop.
//!
//! This is the Rust replacement for the TS engine's process-global write chain
//! and `workspaceActivity` map. State ownership is unambiguous: the
//! connection lives on the worker thread and never crosses it; callers hold
//! clonable [`ActorHandle`]s that only send messages.
//!
//! ## The blocking writer under an async loop (CAL-2)
//!
//! The writer connection is synchronous, blocking rusqlite. It stays on one
//! dedicated OS thread (`std::thread`) — **never** on the async runtime (plan
//! §Workspace actor model: "one writable `rusqlite` connection on a dedicated
//! thread (never blocking the async runtime)"). Commands flow over a bounded
//! [`tokio::sync::mpsc`] channel; the worker consumes them with
//! [`blocking_recv`](tokio::sync::mpsc::Receiver::blocking_recv), so the
//! blocking SQLite work never occupies a runtime worker. Replies come back on
//! [`tokio::sync::oneshot`] channels. The tokio channels are runtime-agnostic
//! for their blocking API, so the the synchronous call sites keep working
//! outside any runtime, while the async methods drive the loop from within one.
//!
//! Lifecycle is explicit — `open → ready → draining → closed` — and `Drop`
//! releases the connection deterministically by joining the worker (no detached
//! task outlives the actor). Cancellation ([`CancellationToken`](tokio_util::sync::CancellationToken)) is checked
//! between bounded units, never inside a transaction.

mod automations;
mod capture;
mod recovery_import;
use crate::supervisor::{ActorOpenMode, PreparedStore};
pub use recovery_import::{
    RecoveryImport, RecoveryImportOutcome, RecoveryImportResult, RecoveryUpdate,
};
mod chats;
mod checked_deletes;
mod collections;
mod history_operations;
mod link_documents;
mod link_rewrites;
pub use history_operations::{HistoryOperation, HistoryUndoResult};
pub use link_documents::{DocumentIsOpen, DocumentResync};
mod journal;
mod live_application;
mod markdown_recovery;
mod materialization;
mod relay;
#[cfg(unix)]
mod retained;
#[cfg(unix)]
pub use retained::{
    RETAINED_COPIES_DELETE_LIMIT, RETAINED_COPIES_LIST_LIMIT, RetainedCandidate, RetainedDeletion,
};
mod search;
mod secrets;
mod versioned;
mod versions;
mod ydoc;

pub use capture::{
    CAPTURE_NEW_FILE_LIVE, CAPTURE_RETIRE_WAITS_FOR_SESSION, CAPTURE_WRITE_WAITS_FOR_SESSION,
    CapturePassSettlement, CapturePlacementPath, MAX_CAPTURE_INGEST_BATCH_BYTES,
    MAX_CAPTURE_INGEST_BATCH_OPS, WorkspaceRootGuard,
};
pub use collections::{CollectionCommitListener, CollectionReconciliation};
pub use dohc_engine_sync::SharingDeclined;
pub use live_application::{
    ActorLiveApplicationHandle, ActorLiveApplicationOwner, OwnedRetirementScope,
};
pub use markdown_recovery::MarkdownRecoveryCandidate;
use markdown_recovery::MarkdownRecoverySignal;
pub use materialization::{PostCommitMaterializeOutcome, SelfWriteRecorder};
pub use relay::{
    RelayConfiguration, RelayOperation, RelayOperationOutcome, ShareViewIdentityRecord,
};
pub use versioned::{
    BinaryWriteExecutionResult, MergeExecutionResult, RollbackExecutionResult,
    TextWriteExecutionResult, WriteConditions,
};
pub use versions::{ActiveVersionSwitch, HistoryPageRead};
pub use ydoc::{
    ArtifactAssetDescriptor, YdocAppend, YdocCloseMaterialization, YdocCloseSessionOutcome,
    YdocOpenState, YdocResyncState, YdocSeedMaterialization, YdocSettleOutcome, YdocSettlement,
};

use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
pub use crate::links::LinkDrainMetrics;
use crate::links::{DrainWorker, SharedMetrics};
use dohc_engine_collab::WriterDocCache;
use dohc_engine_collab::live_update_application::{HeldProofLimit, ReleasedTails};
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError};
use dohc_engine_sync::HeldProofs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::sync_channel as std_sync_channel;
use std::thread::JoinHandle;
use tokio::sync::mpsc::OwnedPermit;
use tokio::sync::{mpsc, oneshot};

/// Bound on the actor's command queue. Backpressure blocks the sender rather
/// than growing an unbounded queue (`plan §Rust policy`: bounded everything).
const COMMAND_QUEUE_CAPACITY: usize = 64;

/// Hears the Group automation claims a workspace's chat writes and relay
/// passes commit, after commit. The host sets it when it opens the workspace.
pub type AutomationClaimListener =
    Arc<dyn Fn(&[dohc_engine_domain::AutomationClaim]) + Send + Sync>;

/// The actor's one place to announce Group automation claims. Every handle
/// shares it, and the latest listener replaces an earlier one.
#[derive(Clone, Default)]
pub(crate) struct ClaimAnnouncer(Arc<std::sync::RwLock<Option<AutomationClaimListener>>>);

impl ClaimAnnouncer {
    pub(crate) fn announce(&self, claims: &[dohc_engine_domain::AutomationClaim]) {
        if claims.is_empty() {
            return;
        }
        let listener = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(listener) = listener {
            listener(claims);
        }
    }
}

/// Physical channel capacity: the data bound plus one slot reserved at spawn
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
    /// An unfinished authored create must recover before another command runs.
    RecoveryRequired,
}

impl LifecycleState {
    /// Reopening must replace an actor that cannot accept more workspace work.
    pub const fn needs_reopen(self) -> bool {
        matches!(self, Self::Closed | Self::RecoveryRequired)
    }

    const fn as_u8(self) -> u8 {
        match self {
            LifecycleState::Opening => 0,
            LifecycleState::Ready => 1,
            LifecycleState::Draining => 2,
            LifecycleState::Closed => 3,
            LifecycleState::RecoveryRequired => 4,
        }
    }

    fn from_u8(value: u8) -> LifecycleState {
        match value {
            0 => LifecycleState::Opening,
            1 => LifecycleState::Ready,
            2 => LifecycleState::Draining,
            4 => LifecycleState::RecoveryRequired,
            _ => LifecycleState::Closed,
        }
    }
}

type ActorWork = Box<dyn FnOnce(&mut EngineStore, &mut WriterDocCache) + Send>;
type RegistrationWork =
    Box<dyn FnOnce(&mut EngineStore, &mut WriterDocCache, &mut live_application::Registry) + Send>;

enum Command {
    Run(ActorWork),
    WakeLinks,
    ConversationLinksRequested,
    /// Work that may release live application registrations in the same step.
    RunWithRegistrations(RegistrationWork),
    LiveApplication(Box<live_application::Request>),
    /// Break the loop and release the connection. Carries no reply: the caller
    /// joins the worker, and the join is the completion signal (so `close`
    /// needs no `blocking_recv`, staying safe to call from a `Drop` that runs
    /// inside an async runtime).
    Close,
}

/// Owns the worker thread and the command sender. Held by the supervisor;
/// callers use [`ActorHandle`]s. Dropping it joins the worker.
pub struct WorkspaceActor {
    markdown_recovery: Arc<MarkdownRecoverySignal>,
    reader_configured: Arc<AtomicBool>,
    identity: EngineDbIdentity,
    store: Arc<StoreLocation>,
    generation: u64,
    mode: ActorOpenMode,
    /// Authoritative open disposition reported by [`EngineStore`]. This is
    /// true only when this actor created a brand-new schema; opening an
    /// existing, migrated, or recovered database always reports false.
    store_freshly_created: bool,
    tx: mpsc::Sender<Command>,
    /// A permit for the `Close` command, reserved at spawn from the dedicated
    /// extra channel slot. `close` consumes it to deliver `Close` in bounded
    /// time — fairly, behind existing FIFO work, without a `try_send` spin and
    /// without blocking in `Drop`.
    close_permit: Option<OwnedPermit<Command>>,
    state: Arc<AtomicU8>,
    worker: Option<JoinHandle<()>>,
    #[cfg(unix)]
    retention: Option<retained::Worker>,
    #[cfg(unix)]
    retention_root: retained::Root,
    claims: ClaimAnnouncer,
    link_metrics: SharedMetrics,
    link_drain_holds: Arc<AtomicU64>,
    link_rewrites: Arc<link_rewrites::RewriteState>,
    current_views: Arc<std::sync::Mutex<dohc_engine_sync::replica_cut::CurrentViewCache>>,
    /// The store's released tails, whose worker validates off the actor.
    released_tails: ReleasedTails,
    /// The store's held-document proofs, which run off the actor.
    held_proofs: HeldProofs,
    pulls: relay::PullPermit,
    pub(crate) link_resolvers: Arc<std::sync::Mutex<crate::links::cache::Cache>>,
}

/// Where an actor's store is: the path it opened by and, once the supervisor
/// hands it over, the folder that path goes through, held open. The actor and
/// every handle to it share one, so the folder stays open while any of them
/// can still reach the store by that path. On a Mac the path names the folder
/// by its ID, and on Linux by this process's descriptor for it, whose number
/// goes to the next file opened once it closes.
pub struct StoreLocation {
    path: std::path::PathBuf,
    prepared: std::sync::OnceLock<PreparedStore>,
}

impl StoreLocation {
    fn new(path: std::path::PathBuf) -> Arc<Self> {
        Arc::new(StoreLocation {
            path,
            prepared: std::sync::OnceLock::new(),
        })
    }

    /// The path the store opened by. Reopening the store by it reaches the
    /// folder the engine checked, as the actor's own connection does.
    pub fn database_path(&self) -> &std::path::Path {
        &self.path
    }

    /// The folder that holds the store, by the same path, where the
    /// workspace's data key lives.
    pub fn folder(&self) -> &std::path::Path {
        store_folder(&self.path)
    }
}

/// A read-only store opened by its location's path. It keeps the location,
/// and so the folder the path goes through, for as long as it lives, after
/// its caller, the actor and every handle have gone.
pub(crate) struct HeldReader {
    store: EngineStore,
    _location: Arc<StoreLocation>,
}

impl HeldReader {
    pub(crate) fn open(location: Arc<StoreLocation>) -> Result<Self, RuntimeError> {
        let store = EngineStore::open_read_only(location.database_path())?;
        #[cfg(test)]
        held_reader_tests::opened(location.database_path(), &store);
        Ok(HeldReader {
            store,
            _location: location,
        })
    }
}

impl std::ops::Deref for HeldReader {
    type Target = EngineStore;

    fn deref(&self) -> &EngineStore {
        &self.store
    }
}

impl std::ops::DerefMut for HeldReader {
    fn deref_mut(&mut self) -> &mut EngineStore {
        &mut self.store
    }
}

impl WorkspaceActor {
    /// This actor, keeping `prepared`, the store's folder, open for as long
    /// as the actor or any handle to it lives.
    pub(crate) fn holding(self, prepared: Option<PreparedStore>) -> Self {
        if let Some(prepared) = prepared {
            let _ = self.store.prepared.set(prepared);
        }
        self
    }

    /// Spawn the actor's worker thread and open the store. Blocks until the
    /// open completes so open errors (including the fingerprint fence)
    /// propagate synchronously. `spawn` is intentionally synchronous — a
    /// workspace open is an infrequent, off-hot-path operation the supervisor
    /// drives without holding its registry lock.
    ///
    /// `work`, when given, counts the store open's SQLite work and then each
    /// command the actor serves, so a caller can tell a long open from a
    /// stuck one. `held_limit` is the daemon's, which the actor's held
    /// proofs share with every other actor's.
    pub(crate) fn spawn(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
        work: Option<Arc<AtomicU64>>,
        held_limit: HeldProofLimit,
    ) -> Result<Self, RuntimeError> {
        Self::spawn_with_mode(
            db_path,
            identity,
            generation,
            now_ms,
            ActorOpenMode::ReadWrite,
            None,
            work,
            held_limit,
        )
    }

    pub(crate) fn spawn_root_bound(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
        root_token: String,
        work: Option<Arc<AtomicU64>>,
        held_limit: HeldProofLimit,
    ) -> Result<Self, RuntimeError> {
        Self::spawn_with_mode(
            db_path,
            identity,
            generation,
            now_ms,
            ActorOpenMode::ReadWrite,
            Some(root_token),
            work,
            held_limit,
        )
    }

    /// Spawn an actor whose store connection is query-only and never runs the
    /// writer open ritual.
    pub(crate) fn spawn_read_only(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        work: Option<Arc<AtomicU64>>,
        held_limit: HeldProofLimit,
    ) -> Result<Self, RuntimeError> {
        Self::spawn_with_mode(
            db_path,
            identity,
            generation,
            0,
            ActorOpenMode::ReadOnly,
            None,
            work,
            held_limit,
        )
    }

    pub(crate) fn spawn_passive(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
        root_token: Option<String>,
        work: Option<Arc<AtomicU64>>,
        held_limit: HeldProofLimit,
    ) -> Result<Self, RuntimeError> {
        Self::spawn_with_mode(
            db_path,
            identity,
            generation,
            now_ms,
            ActorOpenMode::Passive,
            root_token,
            work,
            held_limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_with_mode(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
        mode: ActorOpenMode,
        root_token: Option<String>,
        work: Option<Arc<AtomicU64>>,
        held_limit: HeldProofLimit,
    ) -> Result<Self, RuntimeError> {
        let writer_lock = if matches!(mode, ActorOpenMode::ReadOnly) {
            let file = std::fs::File::open(&db_path).map_err(|error| RuntimeError::Identity {
                reason: "could not inspect workspace database links",
                source: Some(error),
            })?;
            require_single_database_link(&file)?;
            None
        } else {
            let lock = acquire_writer_lock(&db_path)?;
            require_single_database_link(&lock)?;
            Some(lock)
        };
        let (tx, rx) = mpsc::channel::<Command>(CHANNEL_CAPACITY);
        // Reserve the dedicated Close slot up front (the channel is empty, so
        // this cannot fail); `close` sends through it without contending with
        // data producers on tokio's fair waiter queue.
        let close_permit = tx.clone().try_reserve_owned().ok();
        let state = Arc::new(AtomicU8::new(LifecycleState::Opening.as_u8()));
        // Startup handshake uses a std channel: `spawn` runs in a synchronous
        // context, so the open result must not depend on a tokio runtime.
        let (startup_tx, startup_rx) = std_sync_channel::<Result<bool, StorageError>>(1);

        let link_metrics = SharedMetrics::default();
        let worker_metrics = Arc::clone(&link_metrics);
        let link_drain_holds = Arc::new(AtomicU64::new(0));
        let worker_link_drain_holds = Arc::clone(&link_drain_holds);
        let store = StoreLocation::new(db_path.clone());
        let worker_state = Arc::clone(&state);
        let released_tails = ReleasedTails::default();
        let worker_tails = released_tails.clone();
        let markdown_recovery = Arc::new(MarkdownRecoverySignal::default());
        let worker_markdown_recovery = markdown_recovery.clone();
        let worker = std::thread::Builder::new()
            .name("dohc-engine-actor".to_owned())
            .spawn(move || {
                worker_main(
                    db_path,
                    now_ms,
                    mode,
                    root_token,
                    rx,
                    worker_state,
                    worker_metrics,
                    worker_link_drain_holds,
                    startup_tx,
                    writer_lock,
                    work,
                    worker_tails,
                    worker_markdown_recovery,
                )
            })
            .map_err(RuntimeError::ThreadSpawn)?;

        match startup_rx.recv() {
            Ok(Ok(store_freshly_created)) => {
                #[allow(unused_mut)]
                let mut actor = WorkspaceActor {
                    markdown_recovery,
                    reader_configured: Arc::default(),
                    identity,
                    store,
                    generation,
                    mode,
                    store_freshly_created,
                    tx,
                    close_permit,
                    state,
                    worker: Some(worker),
                    #[cfg(unix)]
                    retention: None,
                    #[cfg(unix)]
                    retention_root: retained::Root::default(),
                    claims: ClaimAnnouncer::default(),
                    link_metrics,
                    link_drain_holds,
                    link_rewrites: Arc::default(),
                    current_views: Arc::default(),
                    released_tails,
                    held_proofs: HeldProofs::new(held_limit),
                    pulls: relay::PullPermit::default(),
                    link_resolvers: Arc::default(),
                };
                #[cfg(unix)]
                if matches!(mode, ActorOpenMode::ReadWrite) {
                    actor.retention = Some(retained::Worker::spawn(
                        actor.handle(),
                        actor.retention_root.clone(),
                    )?);
                }
                Ok(actor)
            }
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
            markdown_recovery: self.markdown_recovery.clone(),
            reader_configured: Arc::clone(&self.reader_configured),
            identity: self.identity.clone(),
            store: Arc::clone(&self.store),
            tx: self.tx.clone(),
            state: Arc::clone(&self.state),
            claims: self.claims.clone(),
            #[cfg(unix)]
            retained_root: self.retention_root.clone(),
            link_metrics: Arc::clone(&self.link_metrics),
            link_drain_holds: Arc::clone(&self.link_drain_holds),
            link_rewrites: Arc::clone(&self.link_rewrites),
            current_views: Arc::clone(&self.current_views),
            released_tails: self.released_tails.clone(),
            held_proofs: self.held_proofs.clone(),
            pulls: self.pulls.clone(),
            link_resolvers: Arc::clone(&self.link_resolvers),
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

    pub(crate) fn open_mode(&self) -> ActorOpenMode {
        self.mode
    }

    /// Whether this actor's store open created a brand-new database schema.
    pub fn store_was_freshly_created(&self) -> bool {
        self.store_freshly_created
    }

    /// The store's held-document proofs, whose readers its close waits for.
    pub(crate) fn held_proofs(&self) -> HeldProofs {
        self.held_proofs.clone()
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
    /// caller before close (same contract as the storage writer).
    ///
    /// A held proof's reader still open, or opening, past the close bound,
    /// ten seconds from when held proofs start closing, fails close with
    /// [`RuntimeError::StoreInUse`] once the writer is gone, and so does
    /// every later close until that reader closes: a caller that replaces or
    /// deletes the store's files must not touch them first. The supervisor
    /// keeps the store's entry draining meanwhile.
    pub fn close(&mut self) -> Result<(), RuntimeError> {
        let Some(worker) = self.worker.take() else {
            return if self.held_proofs.drained() {
                Ok(())
            } else {
                Err(RuntimeError::StoreInUse)
            };
        };
        #[cfg(unix)]
        if let Some(retention) = &mut self.retention {
            retention.stop();
            // Finish an in-flight changed read while the writer can still commit it.
            retention.join();
        }
        // Validation stops here, off the actor, and its connection closes
        // before the store's files can be replaced. A request waiting on it
        // fails as unavailable.
        self.released_tails.close();
        // So do held proofs, and no reader starts opening once this begins.
        // One left running past the bound closes its reader at its next
        // check; the writer still closes, and close then fails.
        let drained = self.held_proofs.close();
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
        self.link_resolvers.lock().unwrap().close();
        let joined = worker.join();
        if !drained {
            eprintln!(
                "engine: a held document read still has its workspace database open after close"
            );
            return Err(RuntimeError::StoreInUse);
        }
        match joined {
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

/// A clonable handle to a [`WorkspaceActor`]. The worker also owns its shared
/// current view projection cache.
#[derive(Clone)]
pub struct ActorHandle {
    markdown_recovery: Arc<MarkdownRecoverySignal>,
    reader_configured: Arc<AtomicBool>,
    #[cfg(unix)]
    retained_root: retained::Root,
    identity: EngineDbIdentity,
    store: Arc<StoreLocation>,
    tx: mpsc::Sender<Command>,
    state: Arc<AtomicU8>,
    claims: ClaimAnnouncer,
    link_metrics: SharedMetrics,
    link_drain_holds: Arc<AtomicU64>,
    link_rewrites: Arc<link_rewrites::RewriteState>,
    current_views: Arc<std::sync::Mutex<dohc_engine_sync::replica_cut::CurrentViewCache>>,
    released_tails: ReleasedTails,
    held_proofs: HeldProofs,
    pulls: relay::PullPermit,
    pub(crate) link_resolvers: Arc<std::sync::Mutex<crate::links::cache::Cache>>,
}

/// Keeps derived link writes behind capture, including its queued commands.
/// Dropping the last hold wakes an idle actor without polling.
#[must_use]
pub struct LinkDrainHold {
    holds: Arc<AtomicU64>,
    tx: mpsc::Sender<Command>,
}
impl Drop for LinkDrainHold {
    fn drop(&mut self) {
        if self.holds.fetch_sub(1, Ordering::AcqRel) == 1 {
            // A full queue already has foreground work to wake the actor.
            let _ = self.tx.try_send(Command::WakeLinks);
        }
    }
}

fn pending_reader_preparation<R>(
    result: &Result<R, RuntimeError>,
) -> Option<dohc_engine_collab::markdown_write_safety::PendingPreparation> {
    match result {
        Err(RuntimeError::Sync(dohc_engine_sync::SyncError::MarkdownReaderPending(pending)))
        | Err(RuntimeError::Collab(dohc_engine_collab::CollabError::MarkdownReaderPending(
            pending,
        )))
        | Err(RuntimeError::LiveApplication(
            dohc_engine_collab::live_update_application::ApplicationError::Collab(
                dohc_engine_collab::CollabError::MarkdownReaderPending(pending),
            ),
        )) => Some(
            dohc_engine_collab::markdown_write_safety::PendingPreparation::Reader(pending.clone()),
        ),
        Err(RuntimeError::Sync(dohc_engine_sync::SyncError::MarkdownWitnessCheckPending {
            key,
            path,
            pending,
        }))
        | Err(RuntimeError::Collab(
            dohc_engine_collab::CollabError::MarkdownWitnessCheckPending { key, path, pending },
        ))
        | Err(RuntimeError::LiveApplication(
            dohc_engine_collab::live_update_application::ApplicationError::Collab(
                dohc_engine_collab::CollabError::MarkdownWitnessCheckPending { key, path, pending },
            ),
        )) => Some(
            dohc_engine_collab::markdown_write_safety::PendingPreparation::Witness {
                key: key.clone(),
                path: path.clone(),
                pending: pending.clone(),
            },
        ),
        _ => None,
    }
}

fn wait_for_reader<R>(
    result: &Result<R, RuntimeError>,
    attempt: usize,
    recovery: Arc<MarkdownRecoverySignal>,
) -> impl std::future::Future<Output = bool> + Send + 'static {
    let pending = pending_reader_preparation(result);
    async move {
        let Some(pending) = pending else {
            return false;
        };
        recovery.wake.notify_one();
        if attempt < 2 {
            pending.resolve().await;
            true
        } else {
            tokio::spawn(async move {
                pending.resolve().await;
                recovery.request();
            });
            false
        }
    }
}

impl ActorHandle {
    pub async fn configure_reader_resolver(
        &self,
        resolver: std::sync::Arc<dohc_engine_collab::reader_resolver::ReaderResolver>,
    ) -> Result<(), RuntimeError> {
        let configured = Arc::clone(&self.reader_configured);
        self.run(move |_, cache| {
            cache.reader_resolver = Some(resolver);
            configured.store(true, Ordering::Release);
            Ok(())
        })
        .await?;
        self.request_markdown_recovery();
        Ok(())
    }

    async fn run_with_reader_retry<R: Send + 'static>(
        &self,
        work: impl Fn(&mut EngineStore, &mut WriterDocCache) -> Result<R, RuntimeError>
        + Send
        + Sync
        + 'static,
    ) -> Result<R, RuntimeError> {
        let work = Arc::new(work);
        for attempt in 0..=2 {
            let work = work.clone();
            let result = self.run(move |store, cache| work(store, cache)).await;
            if !wait_for_reader(&result, attempt, self.markdown_recovery.clone()).await {
                if result.is_ok() {
                    self.markdown_recovery.wake.notify_one();
                }
                return result;
            }
        }
        unreachable!()
    }
    pub(crate) async fn request_conversation_links(&self) -> Result<(), RuntimeError> {
        self.tx
            .send(Command::ConversationLinksRequested)
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)
    }

    pub fn hold_link_drain(&self) -> LinkDrainHold {
        self.link_drain_holds.fetch_add(1, Ordering::AcqRel);
        LinkDrainHold {
            holds: Arc::clone(&self.link_drain_holds),
            tx: self.tx.clone(),
        }
    }

    #[cfg(feature = "fault-injection")]
    pub async fn commit_count_for_harness(&self) -> Result<u64, RuntimeError> {
        self.run(|store, _| Ok(store.commit_count_for_harness()))
            .await
    }

    /// Run `hook` on the actor's own connection, for measurements that
    /// attribute its statements.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn on_connection(&self, hook: fn(&rusqlite::Connection)) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                hook(conn);
                Ok(())
            })
        })
        .await
    }

    /// Run `sql` in a write of the actor's own, admitted as every write is,
    /// for tests that grow the store's WAL.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn write_for_test(&self, sql: &'static str) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            store.write_with(&dohc_engine_storage::NoFaults, |tx| {
                tx.execute_batch(sql).map_err(StorageError::persist_public)
            })?;
            Ok(())
        })
        .await
    }

    /// The released tails the actor decides synced rows on, for tests that
    /// hold or count its validations.
    #[doc(hidden)]
    pub fn released_tails(&self) -> ReleasedTails {
        self.released_tails.clone()
    }

    /// The held-document proofs the actor admits, for tests that hold them.
    #[doc(hidden)]
    pub fn held_proofs(&self) -> HeldProofs {
        self.held_proofs.clone()
    }

    /// Completes once a pull has found another holding the store's pull
    /// permit and waits for it.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn pull_waiting(&self) {
        self.pulls.waited.notified().await;
    }

    /// How many checkpoint requests the store's background worker has
    /// finished, for tests that wait for the next.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn checkpoints_completed_for_test(&self) -> Result<u64, RuntimeError> {
        self.run(|store, _| Ok(store.checkpoint_completed_for_test()))
            .await
    }

    /// Completes once the store's background worker finished a checkpoint
    /// request after the `before`th, which it must within a minute.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn wait_for_checkpoint_completion_for_test(
        &self,
        before: u64,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            store.wait_for_checkpoint_completion_for_test(before);
            Ok(())
        })
        .await
    }

    /// Completes once the actor's worker has exited, however it ended: its
    /// lifecycle is closed and its commands go nowhere.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn worker_exited(&self) {
        self.tx.closed().await;
    }

    /// Engine diagnostics for the derived index; no store read or drain.
    pub fn link_drain_metrics(&self) -> LinkDrainMetrics {
        self.link_metrics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Hear every Group automation claim this workspace's chat writes and
    /// relay passes commit. The latest listener replaces an earlier one.
    pub fn listen_for_automation_claims(&self, listener: AutomationClaimListener) {
        *self
            .claims
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(listener);
    }

    pub async fn replica_current_view(
        &self,
        workspace: String,
        request: dohc_engine_sync::replica_cut::CurrentViewRequest,
    ) -> Result<dohc_engine_sync::replica_cut::ReplicaCurrentView, RuntimeError> {
        let cache = Arc::clone(&self.current_views);
        self.run(move |store, _| {
            Ok(dohc_engine_sync::replica_cut::collect_current_view_cached(
                store,
                &workspace,
                &request,
                &mut cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            )?)
        })
        .await
    }

    pub async fn replica_frontiers(
        &self,
        workspace: String,
    ) -> Result<dohc_engine_storage::replica::ReplicaFrontiers, RuntimeError> {
        self.run(move |store, _| {
            store.read_with(|conn| {
                Ok(dohc_engine_storage::replica::read_frontiers(
                    conn, &workspace,
                )?)
            })
        })
        .await
    }

    pub async fn apply_replica_page(
        &self,
        workspace: String,
        after: i64,
        epoch_log_floor: i64,
        rows: Vec<dohc_engine_collab::live_update_application::passive::ReplicaJournalRow>,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<dohc_engine_collab::live_update_application::passive::ReplicaPageResult, RuntimeError>
    {
        self.run(move |store, cache| {
            let _reservation = reservation;
            let result = dohc_engine_collab::live_update_application::passive::apply_page(
                store,
                &workspace,
                after,
                epoch_log_floor,
                &rows,
                &dohc_engine_storage::NoFaults,
            );
            cache.clear();
            Ok(result?)
        })
        .await
    }

    pub(crate) async fn run<R: Send + 'static>(
        &self,
        work: impl FnOnce(&mut EngineStore, &mut WriterDocCache) -> Result<R, RuntimeError>
        + Send
        + 'static,
    ) -> Result<R, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Run(Box::new(move |store, cache| {
                let outcome = work(store, cache);
                let _ = reply.send(drained(store, outcome));
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    async fn run_with_registrations<R: Send + 'static>(
        &self,
        work: impl FnOnce(
            &mut EngineStore,
            &mut WriterDocCache,
            &mut live_application::Registry,
        ) -> Result<R, RuntimeError>
        + Send
        + 'static,
    ) -> Result<R, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::RunWithRegistrations(Box::new(
                move |store, cache, registrations| {
                    let outcome = work(store, cache, registrations);
                    let _ = reply.send(drained(store, outcome));
                },
            )))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    fn run_blocking<R: Send + 'static>(
        &self,
        work: impl FnOnce(&mut EngineStore, &mut WriterDocCache) -> Result<R, RuntimeError>
        + Send
        + 'static,
    ) -> Result<R, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::Run(Box::new(move |store, cache| {
                let outcome = work(store, cache);
                let _ = reply.send(drained(store, outcome));
            })))
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// The canonical identity of the actor this handle addresses.
    pub fn identity(&self) -> &EngineDbIdentity {
        &self.identity
    }

    /// The path the store opened by. Reopening the store by it reaches the
    /// folder the engine checked, as the actor's own connection does. Hold
    /// this handle, or its [`Self::location`], while using the path.
    pub fn database_path(&self) -> &std::path::Path {
        self.store.database_path()
    }

    /// The folder that holds the store, by the same path, where the
    /// workspace's data key lives.
    pub fn store_folder(&self) -> &std::path::Path {
        self.store.folder()
    }

    /// Where the store is. Keep it, rather than a copy of its path, for work
    /// that may outlive this handle: it keeps the store's folder open.
    pub fn location(&self) -> Arc<StoreLocation> {
        Arc::clone(&self.store)
    }

    /// The actor's current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    /// Recovery copies in this workspace, read on its store actor.
    pub async fn kept_materialization_files(
        &self,
        workspace_id: String,
        root: std::path::PathBuf,
    ) -> Result<Vec<(String, String)>, RuntimeError> {
        self.run(move |store, _| {
            let mut files = Vec::new();
            for row in store.list_kept_displacements(&workspace_id)? {
                let dir = store
                    .staging_location(&row.job_id)?
                    .unwrap_or_else(|| ".dohc/engine/displaced".into());
                let path = format!("{dir}/{}", row.displaced_name);
                let (_, reached) = dohc_engine_files::materialize::stored_path(
                    store.database_path(),
                    &root,
                    std::path::Path::new(&path),
                );
                if std::fs::symlink_metadata(reached).is_ok() {
                    files.push((row.target_path, path));
                }
            }
            Ok(files)
        })
        .await
    }

    // --- Async API (drives the tokio loop from within a runtime) ---

    /// Stamp a fresh database with its root's binding token, or verify an
    /// existing binding, on the actor-owned connection before the workspace
    /// can accept writes.
    pub async fn bind_root(
        &self,
        token: String,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            store
                .bind_root_token(&token, faults.as_ref())
                .map_err(RuntimeError::Storage)
        })
        .await
    }

    /// Whether this store already records a workspace other than `workspace_id`.
    pub async fn holds_other_workspace(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM versioned_workspaces WHERE workspace_id <> ?1)",
                        rusqlite::params![workspace_id],
                        |row| row.get(0),
                    )
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)
                })
                .map_err(RuntimeError::Storage)
        })
        .await
    }
}

/// Debug-only guard: the synchronous `*_blocking` API uses
/// `blocking_send`/`blocking_recv`, which panic inside a tokio runtime (the
/// product runs on tokio). Catch the misuse cheaply in debug builds with a
/// clear message instead of an opaque tokio panic in production; use the async
/// API from within a runtime.
#[inline]
fn debug_assert_sync_context() {
    debug_assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "synchronous ActorHandle API called from within a tokio runtime; use the async API"
    );
}

#[allow(
    clippy::too_many_arguments,
    reason = "worker startup owns store configuration, channels, lifecycle, and the writer lock"
)]
fn worker_main(
    db_path: PathBuf,
    now_ms: i64,
    mode: ActorOpenMode,
    root_token: Option<String>,
    mut rx: mpsc::Receiver<Command>,
    state: Arc<AtomicU8>,
    link_metrics: SharedMetrics,
    link_drain_holds: Arc<AtomicU64>,
    startup_tx: std::sync::mpsc::SyncSender<Result<bool, StorageError>>,
    writer_lock: Option<WriterLock>,
    work_count: Option<Arc<AtomicU64>>,
    released_tails: ReleasedTails,
    markdown_recovery: Arc<MarkdownRecoverySignal>,
) {
    // Publish Closed on any exit — normal return OR a panic unwind (e.g. a
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
    // Drop SQLite first, then its owner lock, then publish Closed, including unwind.
    let _writer_lock = writer_lock;

    let mut store = match if matches!(mode, ActorOpenMode::Passive) {
        EngineStore::open_passive(&db_path, now_ms, root_token.as_deref(), work_count.clone())
    } else if matches!(mode, ActorOpenMode::ReadOnly) {
        EngineStore::open_read_only_counting(&db_path, work_count.clone()).and_then(|store| {
            if store.is_passive() {
                Err(dohc_engine_storage::StorageError::InvalidInput {
                    reason: "engine store role mismatch",
                })
            } else {
                Ok(store)
            }
        })
    } else {
        EngineStore::open_for_actor(&db_path, now_ms, root_token.as_deref(), work_count.clone())
    } {
        Ok(store) => store,
        Err(err) => {
            let _ = startup_tx.send(Err(err));
            return;
        }
    };
    let store_freshly_created = store.was_freshly_created();
    // The open that asked for counting owns the counter. The actor keeps only
    // a weak reference, so counting ends with that open, whether it succeeds,
    // fails, or is cancelled. Until then the connection counts its SQLite work
    // too, which covers one long startup command. Counting is best effort: a
    // failure to install the handler costs progress, not the open.
    // Consumed, not shadowed: a shadowed strong reference would live on.
    let mut work_count = work_count.map(|work| Arc::downgrade(&work));
    if let Some(work) = &work_count {
        let _ = store.count_work(Some(work.clone()));
    }
    // Publish Ready *before* acking the open, so a caller that observes the
    // successful open also observes Ready. The same handshake carries the
    // store's authoritative freshness disposition; no caller infers it from
    // file existence or actor-registry ownership.
    #[cfg(test)]
    {
        let mut metrics = link_metrics.lock().unwrap();
        metrics.worker_starts_at_publication = Some(metrics.worker_starts);
        metrics.actor_batches_at_publication = Some(metrics.actor_batches);
    }
    state.store(LifecycleState::Ready.as_u8(), Ordering::Release);
    if startup_tx.send(Ok(store_freshly_created)).is_err() {
        // The spawner unwound before the actor was built; nothing to serve.
        return;
    }
    drop(startup_tx);

    // The writer thread's cache of live Y.Docs (PR1 of the doc-cache design):
    // serves the replay-parity gate base on the LOCAL append path only. It
    // lives and dies with this thread — exactly the single-writer scope its
    // validity proof (`doc_cache.rs`, CACHE-VALID) assumes.
    let mut doc_cache = WriterDocCache::with_released_tails(released_tails);
    let mut live_applications = live_application::Registry::default();

    // Blocking recv on the tokio channel keeps the SQLite work on this
    // dedicated thread, off the async runtime. `blocking_recv` returns `None`
    // once every sender is dropped.
    // Publish before link startup, then let queued foreground commands win.
    // An idle reopened store must also resume its durable drain without a
    // foreground request; link-drain holds still postpone startup and slices.
    let mut conversation_links_requested = false;
    let mut links_started = false;
    let mut links = None;
    let mut timer = None;
    loop {
        // Serve a queued foreground command before each background slice.
        // The timer runtime ends before synchronous commands execute.
        let cmd = match rx.try_recv() {
            Ok(cmd) => Some(cmd),
            Err(mpsc::error::TryRecvError::Disconnected) => break,
            Err(mpsc::error::TryRecvError::Empty) => {
                if !links_started
                    && matches!(mode, ActorOpenMode::ReadWrite)
                    && link_drain_holds.load(Ordering::Acquire) == 0
                {
                    links_started = true;
                    timer = tokio::runtime::Builder::new_current_thread()
                        .enable_time()
                        .build()
                        .ok();
                    #[cfg(test)]
                    if timer.is_some() {
                        link_metrics.lock().unwrap().timer_starts += 1;
                    }
                    match DrainWorker::new(Arc::clone(&link_metrics)) {
                        Ok(worker) => {
                            links = Some(worker);
                        }
                        Err(_) => eprintln!("links parser could not start; pending work retained"),
                    }
                }
                #[cfg(test)]
                {
                    // Count after startup so observing this slot also observes
                    // whether the hold prevented worker and timer creation.
                    link_metrics.lock().unwrap().idle_slots += 1;
                }
                let conversation_delay = if conversation_links_requested
                    && matches!(mode, ActorOpenMode::ReadWrite)
                    && link_drain_holds.load(Ordering::Acquire) == 0
                {
                    match crate::conversation_links::tick_delay(&mut store) {
                        Ok(delay) => delay,
                        Err(error) => {
                            eprintln!("conversation links repair retained: {error}");
                            std::time::Duration::from_millis(250)
                        }
                    }
                } else {
                    std::time::Duration::MAX
                };
                match (&mut links, &timer) {
                    (Some(worker), Some(timer))
                        if link_drain_holds.load(Ordering::Acquire) == 0 =>
                    {
                        #[cfg(feature = "fault-injection")]
                        let mut phase = dohc_engine_storage::capture_phase::Phase::new(
                            "actor_background_slice",
                            None,
                            0,
                            true,
                        );
                        #[cfg(feature = "fault-injection")]
                        phase.field("link_drain_holds", link_drain_holds.load(Ordering::Acquire));
                        let delay = worker.tick(&mut store).min(conversation_delay);
                        #[cfg(feature = "fault-injection")]
                        {
                            phase.finish("completed");
                            drop(phase);
                        }
                        let parser_pending = worker.waiting_for_parser();
                        if delay == std::time::Duration::MAX && !parser_pending {
                            rx.blocking_recv()
                        } else {
                            if delay.is_zero() {
                                continue;
                            }
                            timer.block_on(async {
                                tokio::select! {
                                    biased;
                                    cmd = rx.recv() => cmd,
                                    () = worker.parser_finished(), if parser_pending => None,
                                    () = async { tokio::time::sleep(delay).await },
                                        if delay != std::time::Duration::MAX => None,
                                }
                            })
                        }
                    }
                    _ if conversation_delay.is_zero() => continue,
                    (_, Some(timer)) if conversation_delay != std::time::Duration::MAX => {
                        timer.block_on(wait_for_conversation_retry(&mut rx, conversation_delay))
                    }
                    _ => rx.blocking_recv(),
                }
            }
        };
        let Some(cmd) = cmd else {
            if rx.is_closed() {
                break;
            }
            continue;
        };
        // Counted as each command starts, so its caller sees the count by the
        // time its reply arrives.
        if let Some(work) = &work_count {
            match work.upgrade() {
                Some(work) => {
                    work.fetch_add(1, Ordering::Relaxed);
                }
                None => {
                    let _ = store.count_work(None);
                    work_count = None;
                }
            }
        }
        let changes_before = store
            .read_with(|conn| Ok::<_, StorageError>(conn.total_changes()))
            .unwrap_or(0);
        match cmd {
            Command::Run(work) => work(&mut store, &mut doc_cache),
            Command::WakeLinks => {}
            Command::ConversationLinksRequested => conversation_links_requested = true,
            Command::RunWithRegistrations(work) => {
                work(&mut store, &mut doc_cache, &mut live_applications);
            }
            Command::LiveApplication(request) => {
                request.execute(&mut live_applications, &mut store, &mut doc_cache);
            }
            Command::Close => {
                // FIFO ordering means every command enqueued before Close has
                // already been served; there is nothing left to drain.
                state.store(LifecycleState::Draining.as_u8(), Ordering::Release);
                break;
            }
        }
        let changes_after = store
            .read_with(|conn| Ok::<_, StorageError>(conn.total_changes()))
            .unwrap_or(0);
        if changes_after != changes_before {
            markdown_recovery.wake.notify_one();
        }
        store.request_checkpoint();
        if state.load(Ordering::Acquire) == LifecycleState::RecoveryRequired.as_u8() {
            break;
        }
    }

    // Normal exit: drop the connection explicitly, then the `_closed_guard`
    // publishes Closed as it falls out of scope (same ordering the guard
    // guarantees on a panic unwind).
    drop(links);
    drop(store);
}

async fn wait_for_conversation_retry(
    rx: &mut mpsc::Receiver<Command>,
    delay: std::time::Duration,
) -> Option<Command> {
    tokio::select! { biased; cmd = rx.recv() => cmd, () = tokio::time::sleep(delay) => None }
}

/// Pay the drain that barrier flushes left owed before a result leaves the
/// actor, so the files a command projected are as durable at its reply as a
/// drain per file made them. The drain does not sync the WAL: the command's
/// NORMAL commits are no more durable than before. A drain that fails stays
/// owed, so the next reply drains again even when its command flushed
/// nothing. The work's own error comes first; a failed drain turns a success
/// into an I/O error.
fn drained<R>(store: &EngineStore, outcome: Result<R, RuntimeError>) -> Result<R, RuntimeError> {
    let drain = store.drain_flushes().map_err(|error| {
        RuntimeError::Materialize(dohc_engine_files::MaterializeError::Io {
            path: shown_path(store.database_path())
                .to_string_lossy()
                .into_owned(),
            kind: error.kind(),
            raw_os_error: error.raw_os_error(),
            // macOS checks privacy when a path opens, and the drain uses a
            // folder the store opened earlier.
            privacy_denied: false,
        })
    });
    outcome.and_then(|value| drain.map(|()| value))
}

/// The store's path as a person can read it. On Linux it goes through the
/// held folder's current name, not this process's descriptor for it.
fn shown_path(path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(target_os = "linux")]
    if let (Some(folder), Some(name)) = (path.parent(), path.file_name())
        && let Ok(current) = dohc_linux_files::held::path_by_name(folder)
    {
        return current.join(name);
    }
    path.to_owned()
}

#[cfg(any(windows, target_vendor = "apple"))]
type WriterLock = file_guard::FileGuard<Box<std::fs::File>>;
#[cfg(not(any(windows, target_vendor = "apple")))]
type WriterLock = std::fs::File;

fn require_single_database_link(file: &std::fs::File) -> Result<(), RuntimeError> {
    #[cfg(windows)]
    let count = winapi_util::file::information(file).map(|info| info.number_of_links());
    #[cfg(unix)]
    let count = {
        use std::os::unix::fs::MetadataExt;
        file.metadata().map(|metadata| metadata.nlink())
    };
    let count = count.map_err(|error| RuntimeError::Identity {
        reason: "could not inspect workspace database links",
        source: Some(error),
    })?;
    // SQLite's WAL name follows the opened path. A second hard link can miss
    // acknowledged writes left in the first path's WAL after a process crash.
    if count != 1 {
        return Err(RuntimeError::WorkspaceHardlinked);
    }
    Ok(())
}

/// The folder that holds the store at `database_path`, by the path the store
/// opened by, where the workspace's data key lives.
pub(crate) fn store_folder(database_path: &std::path::Path) -> &std::path::Path {
    database_path.parent().unwrap_or(std::path::Path::new(""))
}

fn acquire_writer_lock(db_path: &std::path::Path) -> Result<WriterLock, RuntimeError> {
    // Lock the physical database: hard links can have different canonical paths.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(db_path)
        .map_err(|error| RuntimeError::Identity {
            reason: "could not open workspace writer lock",
            source: Some(error),
        })?;
    #[cfg(any(windows, target_vendor = "apple"))]
    {
        // One byte beyond SQLite's maximum database size and its locking bytes.
        // Windows LockFileEx and Darwin OFD locks survive unrelated file closes.
        const OWNER_LOCK_OFFSET: usize = 1usize << 48;
        file_guard::try_lock(
            Box::new(file),
            file_guard::Lock::Exclusive,
            OWNER_LOCK_OFFSET,
            1,
        )
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::WouldBlock => RuntimeError::WorkspaceOwned,
            _ => RuntimeError::Identity {
                reason: "could not acquire workspace writer lock",
                source: Some(error),
            },
        })
    }
    #[cfg(not(any(windows, target_vendor = "apple")))]
    {
        // Linux local flock locks do not overlap SQLite's POSIX record locks.
        fs4::FileExt::try_lock(&file).map_err(|error| match error {
            fs4::TryLockError::WouldBlock => RuntimeError::WorkspaceOwned,
            fs4::TryLockError::Error(error) => RuntimeError::Identity {
                reason: "could not acquire workspace writer lock",
                source: Some(error),
            },
        })?;
        Ok(file)
    }
}

#[cfg(test)]
#[path = "actor/reader_tests.rs"]
mod reader_tests;

#[cfg(test)]
mod held_reader_tests {
    use super::*;
    use dohc_engine_testkit::{ScratchDir, engine_db_path};

    type Hook = Box<dyn FnOnce(&EngineStore) + Send>;

    fn hooks() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, Hook>> {
        static HOOKS: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<PathBuf, Hook>>,
        > = std::sync::OnceLock::new();
        HOOKS.get_or_init(Default::default)
    }

    /// Run the hook a test set for the next reader of `path`, once it opens.
    pub(super) fn opened(path: &std::path::Path, store: &EngineStore) {
        let hook = hooks().lock().unwrap().remove(path);
        if let Some(hook) = hook {
            hook(store);
        }
    }

    /// A History reader keeps the store's folder after the future that
    /// started it is dropped, its handle is gone and its actor has closed,
    /// and reads through it until it finishes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reader_keeps_the_store_folder_after_its_caller_and_actor_go() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let location = Arc::downgrade(&actor.location());
        let held = actor.database_path().to_path_buf();
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (read_tx, read_rx) = std::sync::mpsc::channel();
        let hook: Hook = Box::new(move |store| {
            opened_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            let read = store.read_with(|conn| {
                conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
                    row.get::<_, i64>(0)
                })
            });
            read_tx.send(read.is_ok_and(|tables| tables > 0)).unwrap();
        });
        hooks().lock().unwrap().insert(held.clone(), hook);
        let call = tokio::spawn({
            let (actor, root) = (actor.clone(), scratch.path().to_path_buf());
            async move {
                actor
                    .history_undo_pending_publication(
                        "workspace".into(),
                        "operation".into(),
                        root,
                        crate::CancellationToken::new(),
                    )
                    .await
            }
        });
        tokio::task::spawn_blocking(move || opened_rx.recv())
            .await
            .unwrap()
            .unwrap();
        call.abort();
        assert!(call.await.unwrap_err().is_cancelled());
        drop(actor);
        assert!(supervisor.close(&db).unwrap());
        assert!(location.upgrade().is_some(), "the reader let the folder go");
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            let (by_held, by_name) = (
                std::fs::metadata(&held).unwrap(),
                std::fs::metadata(&db).unwrap(),
            );
            assert_eq!(
                (by_held.dev(), by_held.ino()),
                (by_name.dev(), by_name.ino())
            );
        }
        release_tx.send(()).unwrap();
        let read = tokio::task::spawn_blocking(move || read_rx.recv());
        assert!(read.await.unwrap().unwrap(), "the reader could not read");
    }
}

#[cfg(test)]
mod saturation_tests {
    use super::*;
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use std::future::{Future, poll_fn};
    use std::sync::atomic::AtomicUsize;
    use std::task::Poll;
    use std::time::{Duration, Instant};
    use tokio::sync::Semaphore;

    // Prepare the real command channel and holds before worker_main publishes.
    // This removes the race between spawn returning and its first idle slot.
    fn spawn_prequeued_actor(
        db: &std::path::Path,
        prepare: impl FnOnce(&ActorHandle),
    ) -> WorkspaceActor {
        let identity = EngineDbIdentity::resolve_or_create(db).unwrap();
        let writer_lock = acquire_writer_lock(db).unwrap();
        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        let state = Arc::new(AtomicU8::new(LifecycleState::Opening.as_u8()));
        let metrics = SharedMetrics::default();
        let holds = Arc::new(AtomicU64::new(0));
        let mut actor = WorkspaceActor {
            markdown_recovery: Arc::default(),
            reader_configured: Arc::default(),
            identity,
            store: StoreLocation::new(db.to_path_buf()),
            generation: 1,
            mode: ActorOpenMode::ReadWrite,
            store_freshly_created: false,
            close_permit: Some(tx.clone().try_reserve_owned().unwrap()),
            tx,
            state,
            worker: None,
            #[cfg(unix)]
            retention: None,
            #[cfg(unix)]
            retention_root: retained::Root::default(),
            claims: ClaimAnnouncer::default(),
            link_metrics: metrics,
            link_drain_holds: holds,
            current_views: Arc::default(),
            released_tails: ReleasedTails::default(),
            held_proofs: HeldProofs::new(HeldProofLimit::default()),
            pulls: relay::PullPermit::default(),
            link_resolvers: Arc::default(),
            link_rewrites: Arc::default(),
        };
        prepare(&actor.handle());
        let (startup_tx, startup_rx) = std_sync_channel(1);
        let db = db.to_owned();
        let state = Arc::clone(&actor.state);
        let metrics = Arc::clone(&actor.link_metrics);
        let holds = Arc::clone(&actor.link_drain_holds);
        let markdown_recovery = actor.markdown_recovery.clone();
        actor.worker = Some(std::thread::spawn(move || {
            worker_main(
                db,
                2,
                ActorOpenMode::ReadWrite,
                None,
                rx,
                state,
                metrics,
                holds,
                startup_tx,
                Some(writer_lock),
                None,
                ReleasedTails::default(),
                markdown_recovery,
            );
        }));
        actor.store_freshly_created = startup_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(!actor.store_freshly_created, "exercise a reopened store");
        actor
    }

    #[tokio::test]
    async fn conversation_retry_wakes_without_a_parser_and_keeps_command_priority() {
        let (tx, mut rx) = mpsc::channel(2);
        tx.send(Command::WakeLinks).await.unwrap();
        assert!(matches!(
            wait_for_conversation_retry(&mut rx, Duration::ZERO).await,
            Some(Command::WakeLinks)
        ));
        assert!(
            wait_for_conversation_retry(&mut rx, Duration::ZERO)
                .await
                .is_none()
        );
    }

    #[test]
    fn commands_queued_at_publication_finish_before_link_worker_and_timer_start() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        drop(EngineStore::open(&db, 1).unwrap());
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let mut actor = spawn_prequeued_actor(&db, |handle| {
            for command in 0..3 {
                let metrics = Arc::clone(&handle.link_metrics);
                let state = Arc::clone(&handle.state);
                let completed = completed_tx.clone();
                handle
                    .tx
                    .try_send(Command::Run(Box::new(move |store, _| {
                        assert_eq!(state.load(Ordering::Acquire), LifecycleState::Ready.as_u8());
                        let migrations = store
                            .read_with(|conn| {
                                conn.query_row(
                                    "SELECT COUNT(*) FROM engine_migrations",
                                    [],
                                    |row| row.get::<_, i64>(0),
                                )
                            })
                            .unwrap();
                        assert!(migrations > 0);
                        let metrics = metrics.lock().unwrap();
                        completed
                            .send((command, metrics.worker_starts, metrics.timer_starts))
                            .unwrap();
                    })))
                    .unwrap();
            }
        });
        let completed: Vec<_> = (0..3)
            .map(|_| completed_rx.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        actor.close().unwrap();
        assert_eq!(completed, [(0, 0, 0), (1, 0, 0), (2, 0, 0)]);
    }

    #[tokio::test]
    async fn link_drain_hold_before_first_idle_slot_postpones_startup_until_release() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        drop(EngineStore::open(&db, 1).unwrap());
        let mut hold = None;
        let mut actor = spawn_prequeued_actor(&db, |handle| {
            hold = Some(handle.hold_link_drain());
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if actor.handle().link_drain_metrics().idle_slots > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("actor reaches an idle slot while the hold is active");
        // Commands still run while held, after publication returns to the caller.
        for _ in 0..2 {
            actor
                .handle()
                .run(|_, _| Ok(()))
                .await
                .expect("foreground command while held");
            let metrics = actor.handle().link_drain_metrics();
            assert_eq!(
                metrics.worker_starts, 0,
                "hold must postpone parser startup"
            );
            assert_eq!(metrics.timer_starts, 0, "hold must postpone timer startup");
        }
        drop(hold.take());
        // Drop wakes the empty queue. No foreground request drives startup.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let metrics = actor.handle().link_drain_metrics();
                if metrics.worker_starts == 1 && metrics.timer_starts == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the next idle slot starts links after the last hold drops");
        actor.close().unwrap();
    }

    /// A reply waits for the drain its command's barriers left owed. A failed
    /// drain fails that reply and stays owed, so the next reply drains even
    /// when its command flushed nothing. A command that fails after a flush
    /// still drains before its error goes back, and its error comes first.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn every_reply_pays_the_drain_its_command_left_owed() {
        use dohc_engine_storage::FlushKind::{Barrier, Drain};
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        drop(EngineStore::open(&db, 1).unwrap());
        let note = scratch.join("note.md");
        std::fs::write(&note, b"projected").unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 2).unwrap().actor;
        let flush = move |store: &EngineStore| {
            store
                .flush_before_commits(&std::fs::File::open(&note).unwrap())
                .unwrap();
        };
        let trace = || {
            actor.run(|store, _| {
                Ok(store
                    .take_flush_trace()
                    .into_iter()
                    .map(|event| event.kind)
                    .collect::<Vec<_>>())
            })
        };

        let once = flush.clone();
        actor
            .run(move |store, _| {
                once(store);
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(trace().await.unwrap(), [Barrier, Drain]);

        let failing = flush.clone();
        let refused = actor
            .run(move |store, _| {
                failing(store);
                store.fail_next_drain();
                Ok(())
            })
            .await;
        assert!(
            matches!(&refused, Err(RuntimeError::Materialize(error)) if error.code() == "materialize-io"),
            "{refused:?}"
        );
        actor.run(|_, _| Ok(())).await.expect("the retry drains");
        assert_eq!(
            trace().await.unwrap(),
            [Barrier, Drain],
            "a retry that flushes nothing pays the failed drain"
        );

        let failed = flush.clone();
        let error = actor
            .run(move |store, _| {
                failed(store);
                Err::<(), _>(RuntimeError::Cancelled)
            })
            .await;
        assert!(matches!(error, Err(RuntimeError::Cancelled)), "{error:?}");
        assert_eq!(trace().await.unwrap(), [Barrier, Drain]);

        let both = flush.clone();
        let error = actor
            .run(move |store, _| {
                both(store);
                store.fail_next_drain();
                Err::<(), _>(RuntimeError::Cancelled)
            })
            .await;
        assert!(
            matches!(error, Err(RuntimeError::Cancelled)),
            "the work's error wins: {error:?}"
        );
        assert_eq!(trace().await.unwrap(), [Barrier], "the drain stays owed");
        // That reply flushed nothing and still paid the owed drain.
        assert_eq!(trace().await.unwrap(), [Drain]);
        supervisor.close(&db).unwrap();
    }

    /// The drain runs on the database's folder as the store opened it. A
    /// workspace renamed, or renamed and replaced by a new folder, while a
    /// drain is owed still drains the original folder, and later replies keep
    /// working.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn a_moved_workspace_still_drains_the_folder_its_store_opened() {
        use dohc_engine_storage::FlushKind::{Barrier, Drain};
        use std::os::unix::fs::MetadataExt;
        for replace in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let root = scratch.join("workspace");
            let moved = scratch.join("moved");
            std::fs::create_dir_all(root.join(".dohc/engine")).unwrap();
            let db = root.join(".dohc/engine/engine.db");
            drop(EngineStore::open(&db, 1).unwrap());
            std::fs::write(root.join("note.md"), b"projected").unwrap();
            let engine = std::fs::metadata(root.join(".dohc/engine")).unwrap();
            let supervisor = crate::WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 2).unwrap().actor;
            let trace = || {
                actor.run(|store, _| {
                    Ok(store
                        .take_flush_trace()
                        .into_iter()
                        .map(|event| (event.kind, event.device, event.inode))
                        .collect::<Vec<_>>())
                })
            };
            let original = (Drain, engine.dev(), engine.ino());

            let (from, to) = (root.clone(), moved.clone());
            actor
                .run(move |store, _| {
                    let note = std::fs::File::open(from.join("note.md")).unwrap();
                    store.flush_before_commits(&note).unwrap();
                    std::fs::rename(&from, &to).unwrap();
                    if replace {
                        std::fs::create_dir_all(from.join(".dohc/engine")).unwrap();
                    }
                    Ok(())
                })
                .await
                .expect("the reply drains the folder the store opened");
            let drained = trace().await.unwrap();
            assert_eq!(drained.len(), 2, "{drained:?}");
            assert_eq!(drained[0].0, Barrier);
            assert_eq!(drained[1], original, "replace={replace}");

            let note = moved.join("note.md");
            actor
                .run(move |store, _| {
                    let note = std::fs::File::open(&note).unwrap();
                    store.flush_before_commits(&note).unwrap();
                    Ok(())
                })
                .await
                .expect("later replies still drain");
            assert_eq!(trace().await.unwrap()[1], original);
            supervisor
                .close(&moved.join(".dohc/engine/engine.db"))
                .unwrap();
        }
    }

    /// smbfs drains a regular file but refuses `F_FULLFSYNC` on a folder. A
    /// store whose folder refuses the trial drain at open takes no barriers:
    /// every file drains at once, no drain is owed, and replies keep
    /// succeeding, reads included.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn a_folder_that_refuses_a_drain_turns_barriers_off() {
        use dohc_engine_storage::FlushKind::Full;
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        drop(EngineStore::open(&db, 1).unwrap());
        dohc_engine_storage::refuse_folder_flushes(db.parent().unwrap()).unwrap();
        let note = scratch.join("note.md");
        std::fs::write(&note, b"projected").unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 2).unwrap().actor;
        for _ in 0..2 {
            let file = note.clone();
            let kinds = actor
                .run(move |store, _| {
                    store
                        .flush_before_commits(&std::fs::File::open(&file).unwrap())
                        .unwrap();
                    Ok(store
                        .take_flush_trace()
                        .into_iter()
                        .map(|event| event.kind)
                        .collect::<Vec<_>>())
                })
                .await
                .expect("a reply after a flush succeeds");
            assert_eq!(kinds, [Full]);
            actor
                .run(|_, _| Ok(()))
                .await
                .expect("a reply that flushed nothing succeeds");
        }
        supervisor.close(&db).unwrap();
    }

    #[tokio::test]
    async fn reopened_actor_publishes_before_link_work_and_resumes_while_idle() {
        use dohc_engine_domain::VersionedTextStore;
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &dohc_engine_storage::NoFaults)
            .unwrap();
        drop(store);
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 2).unwrap().actor;
        assert_eq!(
            actor.state.load(Ordering::Acquire),
            LifecycleState::Ready.as_u8()
        );
        {
            let metrics = actor.link_metrics.lock().unwrap();
            assert_eq!(
                metrics.worker_starts_at_publication,
                Some(0),
                "no link startup before publication"
            );
            assert_eq!(
                metrics.actor_batches_at_publication,
                Some(0),
                "no link writes before publication"
            );
        }
        // No actor command follows open: a reader observes autonomous resume.
        let reader =
            rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let ready: bool = reader.query_row(
                    "SELECT seed_phase='ready' FROM link_index_state WHERE workspace_id='ws' AND version_id='main'",
                    [], |r| r.get(0),
                ).unwrap();
                if ready { break; }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }).await.unwrap();
        drop(reader);
        supervisor.close(&db).unwrap();
    }

    #[test]
    fn passive_store_restart_without_active_slot_fails_closed() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        supervisor
            .open_passive_root_bound(&db, 1, "passive-root", None)
            .unwrap();
        supervisor.close(&db).unwrap();
        assert!(
            supervisor.restart(&db, 2).is_err(),
            "restart without a passive mode must fail closed"
        );
    }

    #[tokio::test]
    async fn passive_store_supervisor_restart_still_refuses_origination() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        supervisor
            .open_passive_root_bound(&db, 1, "passive-root", None)
            .unwrap();
        let actor = supervisor.restart(&db, 2).unwrap();
        let refused = actor
            .run(|store, _cache| {
                Ok(dohc_engine_sync::create_claim_identity(
                    store,
                    "ws",
                    "local",
                    "epoch",
                    "stream",
                    2,
                    &dohc_engine_storage::NoFaults,
                )
                .is_err())
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while actor.link_drain_metrics().idle_slots == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("passive actor reaches an idle slot before close");
        supervisor.close(&db).unwrap();
        assert!(refused, "a restart must keep local origination disabled");
        assert_eq!(
            actor.link_drain_metrics().worker_starts,
            0,
            "passive actors must never create a DrainWorker, even without queued work"
        );
        assert_eq!(
            actor.link_drain_metrics().actor_batches,
            0,
            "passive actors must never run the link drain"
        );
    }

    #[test]
    fn writer_lock_survives_sqlite_descriptor_close_and_hard_link_aliases() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("database path");
        EngineDbIdentity::resolve_or_create(&db).expect("identity");
        let alias = db.with_file_name("alias.db");
        std::fs::hard_link(&db, &alias).expect("hard link");
        let owner = acquire_writer_lock(&db).expect("owner");
        // Both a SQLite connection and an independent File open/close must
        // leave the owner's lock intact. POSIX process locks fail this test.
        drop(EngineStore::open(&db, 1).expect("SQLite opens under owner lock"));
        drop(EngineStore::open_read_only(&db).expect("read-only SQLite opens"));
        drop(std::fs::File::open(&alias).expect("independent descriptor"));
        assert!(matches!(
            acquire_writer_lock(&alias),
            Err(RuntimeError::WorkspaceOwned)
        ));
        drop(owner);
        drop(acquire_writer_lock(&alias).expect("release permits alias owner"));
    }

    #[test]
    fn a_new_read_only_actor_refuses_a_hardlinked_database() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("database path");
        drop(EngineStore::open(&db, 1).expect("database"));
        let alias = db.with_file_name("alias.db");
        std::fs::hard_link(&db, &alias).expect("hard link");
        let identity = EngineDbIdentity::of_existing(&alias).expect("identity");
        assert!(matches!(
            WorkspaceActor::spawn_read_only(alias, identity, 1, None, HeldProofLimit::default()),
            Err(RuntimeError::WorkspaceHardlinked)
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn close_returns_promptly_under_sustained_submission() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("database path");
        let identity = EngineDbIdentity::resolve_or_create(&db).expect("identity");
        let mut actor = WorkspaceActor::spawn(db, identity, 1, 1, None, HeldProofLimit::default())
            .expect("spawn");
        assert!(actor.close_permit.is_some());
        let handle = actor.handle();
        let (entered, entered_rx) = oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let mut worker = {
            let handle = handle.clone();
            tokio::spawn(async move {
                handle
                    .run(move |_, _| {
                        let _ = entered.send(());
                        let _ = release_rx.recv();
                        Ok(())
                    })
                    .await
            })
        };
        entered_rx.await.expect("worker entered gate");

        let completed = Arc::new(AtomicUsize::new(0));
        for _ in 0..COMMAND_QUEUE_CAPACITY {
            let completed = Arc::clone(&completed);
            assert!(
                handle
                    .tx
                    .try_send(Command::Run(Box::new(move |_, _| {
                        completed.fetch_add(1, Ordering::SeqCst);
                    })))
                    .is_ok()
            );
        }
        assert!(matches!(
            handle.tx.try_send(Command::Run(Box::new(|_, _| {}))),
            Err(mpsc::error::TrySendError::Full(_))
        ));

        let parked = Arc::new(Semaphore::new(0));
        let mut producers = Vec::new();
        for _ in 0..16 {
            let handle = handle.clone();
            let parked = Arc::clone(&parked);
            producers.push(tokio::spawn(async move {
                let mut first = Box::pin(handle.run(|_, _| Ok(())));
                let pending = poll_fn(|cx| Poll::Ready(first.as_mut().poll(cx).is_pending())).await;
                parked.add_permits(1);
                assert!(pending, "full send must park");
                if first.await.is_err() {
                    return;
                }
                while handle.run(|_, _| Ok(())).await.is_ok() {}
            }));
        }
        parked
            .acquire_many(16)
            .await
            .expect("all producers parked")
            .forget();
        assert_eq!(completed.load(Ordering::SeqCst), 0);

        let started = Instant::now();
        let (closing, closing_rx) = oneshot::channel();
        let mut close = tokio::task::spawn_blocking(move || {
            let _ = closing.send(());
            actor.close()
        });
        closing_rx.await.expect("close thread started");
        // This observes the close caller, not Close admission. Keep producers
        // running as the worker resumes so a fair-send starvation can recur.
        release.send(()).expect("release worker");
        let finished = tokio::time::timeout(Duration::from_secs(5), async {
            (&mut close).await.expect("join close").expect("close");
            (&mut worker)
                .await
                .expect("join worker call")
                .expect("worker call");
            for producer in &mut producers {
                producer.await.expect("producer exited");
            }
        })
        .await;
        if finished.is_err() {
            // Stop the load before reporting starvation so blocked close can exit.
            for producer in &producers {
                producer.abort();
            }
        }
        finished.expect("close and producers must finish within five seconds");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "close starved under sustained submission"
        );
        assert_eq!(completed.load(Ordering::SeqCst), COMMAND_QUEUE_CAPACITY);
        assert_eq!(handle.lifecycle(), LifecycleState::Closed);
    }
}
