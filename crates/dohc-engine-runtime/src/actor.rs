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
mod chats;
mod collections;
mod journal;
mod live_application;
mod materialization;
mod relay;
mod search;
mod secrets;
mod versioned;
mod versions;
mod ydoc;

pub use capture::{
    MAX_CAPTURE_INGEST_BATCH_BYTES, MAX_CAPTURE_INGEST_BATCH_OPS, WorkspaceRootGuard,
};
pub use dohc_engine_sync::SharingDeclined;
pub use live_application::{ActorLiveApplicationHandle, ActorLiveApplicationOwner};
pub use materialization::{PostCommitMaterializeOutcome, SelfWriteRecorder};
pub use relay::{
    RelayConfiguration, RelayOperation, RelayOperationOutcome, ShareViewIdentityRecord,
};
pub use versioned::{BinaryWriteExecutionResult, MergeExecutionResult, RollbackExecutionResult};
pub use versions::{ActiveVersionSwitch, HistoryPageRead};
pub use ydoc::{
    ArtifactAssetDescriptor, YdocAppend, YdocCloseSessionOutcome, YdocOpenState, YdocResyncState,
    YdocSeedMaterialization, YdocSettleOutcome, YdocSettlement,
};

use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
use dohc_engine_collab::WriterDocCache;
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::sync_channel as std_sync_channel;
use std::thread::JoinHandle;
use tokio::sync::mpsc::OwnedPermit;
use tokio::sync::{mpsc, oneshot};

/// Bound on the actor's command queue. Backpressure blocks the sender rather
/// than growing an unbounded queue (`plan §Rust policy`: bounded everything).
const COMMAND_QUEUE_CAPACITY: usize = 64;

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

type ActorWork = Box<dyn FnOnce(&mut EngineStore, &mut WriterDocCache) + Send>;

enum Command {
    Run(ActorWork),
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
    identity: EngineDbIdentity,
    generation: u64,
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
        Self::spawn_with_mode(db_path, identity, generation, now_ms, false)
    }

    /// Spawn an actor whose store connection is query-only and never runs the
    /// writer open ritual.
    pub(crate) fn spawn_read_only(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
    ) -> Result<Self, RuntimeError> {
        Self::spawn_with_mode(db_path, identity, generation, 0, true)
    }

    fn spawn_with_mode(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
        read_only: bool,
    ) -> Result<Self, RuntimeError> {
        let writer_lock = if read_only {
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

        let worker_state = Arc::clone(&state);
        let worker = std::thread::Builder::new()
            .name("dohc-engine-actor".to_owned())
            .spawn(move || {
                worker_main(
                    db_path,
                    now_ms,
                    read_only,
                    rx,
                    worker_state,
                    startup_tx,
                    writer_lock,
                )
            })
            .map_err(RuntimeError::ThreadSpawn)?;

        match startup_rx.recv() {
            Ok(Ok(store_freshly_created)) => Ok(WorkspaceActor {
                identity,
                generation,
                store_freshly_created,
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

    /// Whether this actor's store open created a brand-new database schema.
    pub fn store_was_freshly_created(&self) -> bool {
        self.store_freshly_created
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
    async fn run<R: Send + 'static>(
        &self,
        work: impl FnOnce(&mut EngineStore, &mut WriterDocCache) -> Result<R, RuntimeError>
        + Send
        + 'static,
    ) -> Result<R, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Run(Box::new(move |store, cache| {
                let outcome = work(store, cache);
                let _ = reply.send(outcome);
            })))
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
                let _ = reply.send(outcome);
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

    /// The actor's current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
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

fn worker_main(
    db_path: PathBuf,
    now_ms: i64,
    read_only: bool,
    mut rx: mpsc::Receiver<Command>,
    state: Arc<AtomicU8>,
    startup_tx: std::sync::mpsc::SyncSender<Result<bool, StorageError>>,
    writer_lock: Option<WriterLock>,
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

    let mut store = match if read_only {
        EngineStore::open_read_only(&db_path)
    } else {
        EngineStore::open(&db_path, now_ms)
    } {
        Ok(store) => store,
        Err(err) => {
            let _ = startup_tx.send(Err(err));
            return;
        }
    };
    let store_freshly_created = store.was_freshly_created();
    // Publish Ready *before* acking the open, so a caller that observes the
    // successful open also observes Ready. The same handshake carries the
    // store's authoritative freshness disposition; no caller infers it from
    // file existence or actor-registry ownership.
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
    let mut doc_cache = WriterDocCache::new();
    let mut live_applications = live_application::Registry::default();

    // Blocking recv on the tokio channel keeps the SQLite work on this
    // dedicated thread, off the async runtime. `blocking_recv` returns `None`
    // once every sender is dropped.
    while let Some(cmd) = rx.blocking_recv() {
        match cmd {
            Command::Run(work) => work(&mut store, &mut doc_cache),
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
    }

    // Normal exit: drop the connection explicitly, then the `_closed_guard`
    // publishes Closed as it falls out of scope (same ordering the guard
    // guarantees on a panic unwind).
    drop(store);
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
mod saturation_tests {
    use super::*;
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use std::future::{Future, poll_fn};
    use std::sync::atomic::AtomicUsize;
    use std::task::Poll;
    use std::time::{Duration, Instant};
    use tokio::sync::Semaphore;

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
            WorkspaceActor::spawn_read_only(alias, identity, 1),
            Err(RuntimeError::WorkspaceHardlinked)
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn close_returns_promptly_under_sustained_submission() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("database path");
        let identity = EngineDbIdentity::resolve_or_create(&db).expect("identity");
        let mut actor = WorkspaceActor::spawn(db, identity, 1, 1).expect("spawn");
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
