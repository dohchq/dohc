//! The session registry: one workspace actor per canonical `engine.db`
//! **file identity**. This is the Rust home of the TS engine's process-global
//! `storeWriteChains` map + `workspaceActivity` registry. Its defining job
//! is dedup by
//! file identity so two aliased paths to one database — case-alias, symlink,
//! junction, or hard link — resolve to one actor, and therefore one writer
//! connection, never two.
//!
//! Concurrency: the registry lock is **never held across the blocking actor
//! spawn**. An open reserves its identity slot under the lock, releases the
//! lock, performs the (potentially slow) open, then re-acquires to finalize —
//! so `actor_count()` / `close()` stay responsive while another workspace is
//! opening. Concurrent opens of the *same* identity serialize on a reservation
//! and share the resulting actor.

use crate::actor::{ActorHandle, WorkspaceActor};
use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
use dohc_engine_collab::live_update_application::HeldProofLimit;
use dohc_engine_sync::HeldProofs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};

type Registry = HashMap<EngineDbIdentity, Slot>;

/// A registry slot. `Reserving` and `Closing` are both "busy" placeholders held
/// while the lock is released for a blocking spawn or close: a concurrent open
/// of the same identity waits on the condvar rather than forking a second
/// writer while the first is still opening OR still closing.
enum Slot {
    Reserving,
    Closing,
    Active(Box<WorkspaceActor>),
    /// The actor closed with a held proof's reader still open past the
    /// close bound. Until its readers drain, closing the store answers
    /// [`RuntimeError::StoreInUse`] and so does opening or restarting it, so
    /// nothing replaces its files or starts a successor under that reader;
    /// the first of them to find the readers drained removes the slot.
    Draining(HeldProofs),
}

#[derive(Clone, Copy)]
pub(crate) enum ActorOpenMode {
    ReadWrite,
    Passive,
    ReadOnly,
}

impl Slot {
    /// Whether this slot is a transient placeholder that a waiter must wait out.
    fn is_busy(&self) -> bool {
        matches!(self, Slot::Reserving | Slot::Closing)
    }
}

/// Settle a draining slot for `identity` before anything else uses it: one
/// whose readers drained goes, and one still draining refuses as the store
/// in use.
fn settle_draining(
    registry: &mut Registry,
    identity: &EngineDbIdentity,
) -> Result<(), RuntimeError> {
    match registry.get(identity) {
        Some(Slot::Draining(proofs)) if proofs.drained() => {
            registry.remove(identity);
            Ok(())
        }
        Some(Slot::Draining(_)) => Err(RuntimeError::StoreInUse),
        _ => Ok(()),
    }
}

/// Owns every open workspace actor, keyed by canonical file identity. Dropping
/// the supervisor drops every actor, each of which joins its worker and
/// releases its connection.
pub struct WorkspaceSupervisor {
    registry: Mutex<Registry>,
    ready: Condvar,
    /// How many held proofs its actors run at once, and the memory they and
    /// their results keep, shared by every actor it spawns.
    held_proofs: HeldProofLimit,
}

/// Result of opening a workspace actor. `created_actor` is true only for the
/// caller that installed a newly-spawned actor in the process-wide registry;
/// attachers to an existing live actor receive false.
pub struct SupervisorOpen {
    pub actor: ActorHandle,
    pub created_actor: bool,
    /// Authoritative database disposition from `EngineStore::open`.
    pub store_freshly_created: bool,
}

/// An actor removed from the registry while its `Closing` marker remains held.
/// Dropping the operation finishes the close before releasing the marker.
pub struct WorkspaceClose<'a> {
    supervisor: &'a WorkspaceSupervisor,
    identity: EngineDbIdentity,
    actor: Option<WorkspaceActor>,
    marker_active: bool,
}

impl WorkspaceClose<'_> {
    /// Close the actor and release its registry marker. When a held proof's
    /// reader outlives the close bound, the marker becomes the store's
    /// draining slot instead, and this answers [`RuntimeError::StoreInUse`].
    pub fn finish(mut self) -> Result<(), RuntimeError> {
        let close_result = match self.actor.take() {
            Some(actor) => self.close(actor),
            None => Ok(()),
        };
        self.clear_marker();
        close_result
    }

    fn close(&mut self, mut actor: WorkspaceActor) -> Result<(), RuntimeError> {
        let closed = actor.close();
        if matches!(closed, Err(RuntimeError::StoreInUse)) && self.marker_active {
            self.supervisor
                .release_markers(&[], [(self.identity.clone(), actor.held_proofs())]);
            self.marker_active = false;
        }
        closed
    }

    fn clear_marker(&mut self) {
        if self.marker_active {
            self.supervisor
                .release_markers(std::slice::from_ref(&self.identity), []);
            self.marker_active = false;
        }
    }
}

impl Drop for WorkspaceClose<'_> {
    fn drop(&mut self) {
        if let Some(actor) = self.actor.take() {
            let _ = self.close(actor);
        }
        self.clear_marker();
    }
}

impl Default for WorkspaceSupervisor {
    fn default() -> Self {
        WorkspaceSupervisor::new()
    }
}

impl WorkspaceSupervisor {
    /// A fresh, empty supervisor. Prefer [`WorkspaceSupervisor::global`] in
    /// production so per-file uniqueness holds process-wide; construct isolated
    /// instances in tests.
    pub fn new() -> Self {
        WorkspaceSupervisor {
            registry: Mutex::new(HashMap::new()),
            ready: Condvar::new(),
            held_proofs: HeldProofLimit::default(),
        }
    }

    /// The process-global supervisor. The sidecar is one process with one
    /// session registry; routing every open through this instance is what makes
    /// "one writer per physical `engine.db`" a process-wide guarantee rather
    /// than a per-instance one.
    pub fn global() -> &'static WorkspaceSupervisor {
        static GLOBAL: OnceLock<WorkspaceSupervisor> = OnceLock::new();
        GLOBAL.get_or_init(WorkspaceSupervisor::new)
    }

    /// Open (or attach to) the workspace whose database is at `db_path`.
    ///
    /// The parent directory is created if missing, the path is resolved to a
    /// file identity (creating an empty database file if needed), and — if a
    /// live actor for that identity already exists — its handle is returned
    /// without opening a second connection. A dead actor (its worker panicked)
    /// is evicted and re-opened, unless a held proof's reader keeps its store
    /// past the close bound: the store then drains, and this answers
    /// [`RuntimeError::StoreInUse`].
    pub fn open(&self, db_path: &Path, now_ms: i64) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, now_ms, ActorOpenMode::ReadWrite, None, None)
    }

    /// Persist a fresh store's root binding with its initial schema.
    pub fn open_root_bound(
        &self,
        db_path: &Path,
        now_ms: i64,
        token: &str,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, now_ms, ActorOpenMode::ReadWrite, Some(token), work)
    }

    /// [`Self::open`], counting into `work`, when given, the SQLite work of
    /// the store open (migrations and the integrity check) and then each
    /// command the new actor serves. An open that attaches to a live actor
    /// counts nothing.
    pub fn open_counting(
        &self,
        db_path: &Path,
        now_ms: i64,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, now_ms, ActorOpenMode::ReadWrite, None, work)
    }

    /// Open an existing workspace through a read-only store connection. This
    /// path never creates the parent, the database, or migration state.
    pub fn open_read_only(&self, db_path: &Path) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, 0, ActorOpenMode::ReadOnly, None, None)
    }

    /// [`Self::open_read_only`], counting into `work` like
    /// [`Self::open_counting`].
    pub fn open_read_only_counting(
        &self,
        db_path: &Path,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, 0, ActorOpenMode::ReadOnly, None, work)
    }

    /// Open a writable passive store without local origination or file jobs.
    pub fn open_passive_root_bound(
        &self,
        db_path: &Path,
        now_ms: i64,
        token: &str,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, now_ms, ActorOpenMode::Passive, Some(token), work)
    }

    fn open_with_mode(
        &self,
        db_path: &Path,
        now_ms: i64,
        mode: ActorOpenMode,
        root_token: Option<&str>,
        work: Option<Arc<AtomicU64>>,
    ) -> Result<SupervisorOpen, RuntimeError> {
        let prepared = match mode {
            ActorOpenMode::ReadWrite | ActorOpenMode::Passive => Some(prepare_store(db_path)?),
            ActorOpenMode::ReadOnly => None,
        };
        let store_path = prepared.as_ref().map_or(db_path, |prepared| &prepared.path);
        let mut dead: Option<WorkspaceActor> = None;
        let identity;
        {
            let mut guard = lock(&self.registry);
            identity = match mode {
                ActorOpenMode::ReadWrite | ActorOpenMode::Passive => {
                    EngineDbIdentity::resolve_or_create(store_path)?
                }
                ActorOpenMode::ReadOnly => EngineDbIdentity::of_existing(store_path)?,
            };
            loop {
                let action = match guard.get(&identity) {
                    Some(Slot::Active(actor)) => {
                        if actor.lifecycle().needs_reopen() {
                            Action::Evict
                        } else {
                            Action::Return
                        }
                    }
                    Some(Slot::Reserving | Slot::Closing) => Action::Wait,
                    Some(Slot::Draining(_)) => Action::Settle,
                    None => Action::Reserve,
                };
                match action {
                    Action::Settle => {
                        settle_draining(&mut guard, &identity)?;
                        continue;
                    }
                    Action::Return => {
                        if let Some(Slot::Active(actor)) = guard.get(&identity) {
                            if matches!(mode, ActorOpenMode::Passive)
                                != matches!(actor.open_mode(), ActorOpenMode::Passive)
                            {
                                return Err(RuntimeError::Storage(
                                    dohc_engine_storage::StorageError::InvalidInput {
                                        reason: "engine store role mismatch",
                                    },
                                ));
                            }
                            return Ok(SupervisorOpen {
                                actor: actor.handle(),
                                created_actor: false,
                                store_freshly_created: actor.store_was_freshly_created(),
                            });
                        }
                        continue; // slot changed under us; re-evaluate
                    }
                    Action::Evict => {
                        if let Some(Slot::Active(actor)) = guard.remove(&identity) {
                            dead = Some(*actor);
                        }
                        guard.insert(identity.clone(), Slot::Reserving);
                        break;
                    }
                    Action::Wait => {
                        guard = wait(&self.ready, guard);
                        continue;
                    }
                    Action::Reserve => {
                        guard.insert(identity.clone(), Slot::Reserving);
                        break;
                    }
                }
            }
        }
        // Close the evicted actor outside the lock. Its held proofs run on
        // threads of their own, so its worker's end stopped none of them: a
        // reader past the close bound keeps the store, and the reservation
        // becomes the draining slot.
        if let Some(mut dead) = dead {
            if let Err(RuntimeError::StoreInUse) = dead.close() {
                self.release_markers(&[], [(identity, dead.held_proofs())]);
                return Err(RuntimeError::StoreInUse);
            }
        }

        let held_limit = self.held_proofs.clone();
        let store_path = store_path.to_path_buf();
        let spawned = match mode {
            ActorOpenMode::ReadWrite => {
                if let Some(token) = root_token {
                    WorkspaceActor::spawn_root_bound(
                        store_path,
                        identity.clone(),
                        1,
                        now_ms,
                        token.to_owned(),
                        work,
                        held_limit,
                    )
                } else {
                    WorkspaceActor::spawn(store_path, identity.clone(), 1, now_ms, work, held_limit)
                }
            }
            ActorOpenMode::Passive => WorkspaceActor::spawn_passive(
                store_path,
                identity.clone(),
                1,
                now_ms,
                root_token.map(str::to_owned),
                work,
                held_limit,
            ),
            ActorOpenMode::ReadOnly => {
                WorkspaceActor::spawn_read_only(store_path, identity.clone(), 1, work, held_limit)
            }
        };
        let spawned = spawned.map(|actor| actor.holding(prepared));
        let store_freshly_created = spawned
            .as_ref()
            .is_ok_and(WorkspaceActor::store_was_freshly_created);
        self.finalize_reservation(identity, spawned)
            .map(|actor| SupervisorOpen {
                actor,
                created_actor: true,
                store_freshly_created,
            })
    }

    /// Close and reopen the actor for `db_path`, incrementing its session
    /// generation. Generation continuity is preserved even if the predecessor's
    /// worker panicked (a dead predecessor is treated as already-closed).
    /// While a held proof's reader keeps the store in use, from an earlier
    /// close or this one, no successor starts: the store drains and this
    /// answers [`RuntimeError::StoreInUse`].
    pub fn restart(&self, db_path: &Path, now_ms: i64) -> Result<ActorHandle, RuntimeError> {
        let prepared = prepare_store(db_path)?;

        let (old, next_generation, mode, identity) = {
            let mut guard = lock(&self.registry);
            let identity = EngineDbIdentity::resolve_or_create(&prepared.path)?;
            // Wait out any in-flight reservation/close for this identity.
            while guard.get(&identity).is_some_and(Slot::is_busy) {
                guard = wait(&self.ready, guard);
            }
            settle_draining(&mut guard, &identity)?;
            let old = guard.remove(&identity);
            let next_generation = match &old {
                Some(Slot::Active(actor)) => actor.generation().saturating_add(1),
                _ => 1,
            };
            let mode = match &old {
                Some(Slot::Active(actor)) => actor.open_mode(),
                _ => ActorOpenMode::ReadWrite,
            };
            guard.insert(identity.clone(), Slot::Reserving);
            (old, next_generation, mode, identity)
        };

        // Close the predecessor outside the lock; a WorkerPanicked from a dead
        // predecessor is expected here, not an error. A held proof's reader
        // past the close bound is: the reservation becomes the draining slot.
        if let Some(Slot::Active(mut actor)) = old {
            if let Err(RuntimeError::StoreInUse) = actor.close() {
                self.release_markers(&[], [(identity, actor.held_proofs())]);
                return Err(RuntimeError::StoreInUse);
            }
        }

        let spawned = WorkspaceActor::spawn_with_mode(
            prepared.path.clone(),
            identity.clone(),
            next_generation,
            now_ms,
            mode,
            None,
            None,
            self.held_proofs.clone(),
        );
        let spawned = spawned.map(|actor| actor.holding(Some(prepared)));
        self.finalize_reservation(identity, spawned)
    }

    /// Remove the actor for `db_path` and synchronously mark its slot `Closing`.
    ///
    /// The returned operation owns the actor and marker. It may be moved to a
    /// blocking task; dropping it still closes the actor before waking waiters.
    /// A store still draining from an earlier close answers
    /// [`RuntimeError::StoreInUse`]; one that drained has nothing to close.
    pub fn begin_close(&self, db_path: &Path) -> Result<Option<WorkspaceClose<'_>>, RuntimeError> {
        let Some(identity) = EngineDbIdentity::resolve_existing_opt(db_path)? else {
            return Ok(None);
        };
        self.begin_close_identity(&identity)
    }

    /// [`Self::begin_close`] for the actor keyed by `identity`, as its handle
    /// carries it, whatever the workspace's path names now.
    pub fn begin_close_identity(
        &self,
        identity: &EngineDbIdentity,
    ) -> Result<Option<WorkspaceClose<'_>>, RuntimeError> {
        let identity = identity.clone();
        let actor = {
            let mut guard = lock(&self.registry);
            while guard.get(&identity).is_some_and(Slot::is_busy) {
                guard = wait(&self.ready, guard);
            }
            settle_draining(&mut guard, &identity)?;
            match guard.remove(&identity) {
                Some(Slot::Active(actor)) => {
                    guard.insert(identity.clone(), Slot::Closing);
                    *actor
                }
                _ => return Ok(None),
            }
        };
        Ok(Some(WorkspaceClose {
            supervisor: self,
            identity,
            actor: Some(actor),
            marker_active: true,
        }))
    }

    /// Close the actor for `db_path`, if open. Returns whether one was closed.
    pub fn close(&self, db_path: &Path) -> Result<bool, RuntimeError> {
        let Some(closing) = self.begin_close(db_path)? else {
            return Ok(false);
        };
        closing.finish().map(|()| true)
    }

    /// [`Self::close`] for the actor keyed by `identity`.
    pub fn close_identity(&self, identity: &EngineDbIdentity) -> Result<bool, RuntimeError> {
        let Some(closing) = self.begin_close_identity(identity)? else {
            return Ok(false);
        };
        closing.finish().map(|()| true)
    }

    /// Close every open actor. A store still draining from an earlier
    /// close, or left draining by this one, answers
    /// [`RuntimeError::StoreInUse`]; drained ones go.
    pub fn close_all(&self) -> Result<(), RuntimeError> {
        let mut first_err = None;
        let mut closing = Vec::new();
        let actors: Vec<(EngineDbIdentity, WorkspaceActor)> = {
            let mut guard = lock(&self.registry);
            let keys: Vec<EngineDbIdentity> = guard
                .iter()
                .filter(|(_, slot)| matches!(slot, Slot::Active(_) | Slot::Draining(_)))
                .map(|(identity, _)| identity.clone())
                .collect();
            let mut actors = Vec::new();
            for identity in keys {
                if let Err(err) = settle_draining(&mut guard, &identity) {
                    first_err.get_or_insert(err);
                    continue;
                }
                if let Some(Slot::Active(actor)) = guard.remove(&identity) {
                    guard.insert(identity.clone(), Slot::Closing);
                    closing.push(identity.clone());
                    actors.push((identity, *actor));
                }
            }
            actors
        };
        let mut draining = Vec::new();
        for (identity, mut actor) in actors {
            if let Err(err) = actor.close() {
                if matches!(err, RuntimeError::StoreInUse) {
                    draining.push((identity, actor.held_proofs()));
                }
                first_err.get_or_insert(err);
            }
        }
        self.release_markers(&closing, draining);
        match first_err {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    /// Under one lock, remove the markers of `closed`, then mark each store
    /// of `draining` draining with its held proofs, whose readers kept its
    /// actor's close from completing, in place of any marker it had; wake
    /// any threads waiting on them.
    fn release_markers(
        &self,
        closed: &[EngineDbIdentity],
        draining: impl IntoIterator<Item = (EngineDbIdentity, HeldProofs)>,
    ) {
        let mut guard = lock(&self.registry);
        for identity in closed {
            guard.remove(identity);
        }
        for (identity, proofs) in draining {
            guard.insert(identity, Slot::Draining(proofs));
        }
        self.ready.notify_all();
    }

    /// Number of currently open (live) actors.
    pub fn actor_count(&self) -> usize {
        lock(&self.registry)
            .values()
            .filter(|slot| matches!(slot, Slot::Active(_)))
            .count()
    }

    /// The session generation of the live actor for `db_path`, if open.
    pub fn generation_of(&self, db_path: &Path) -> Result<Option<u64>, RuntimeError> {
        let Some(identity) = EngineDbIdentity::resolve_existing_opt(db_path)? else {
            return Ok(None);
        };
        let guard = lock(&self.registry);
        Ok(match guard.get(&identity) {
            Some(Slot::Active(actor)) => Some(actor.generation()),
            _ => None,
        })
    }

    /// Replace a reservation with the spawned actor (or clear it on failure),
    /// waking any threads waiting on the same identity.
    fn finalize_reservation(
        &self,
        identity: EngineDbIdentity,
        spawned: Result<WorkspaceActor, RuntimeError>,
    ) -> Result<ActorHandle, RuntimeError> {
        let mut guard = lock(&self.registry);
        let result = match spawned {
            Ok(actor) => {
                let handle = actor.handle();
                guard.insert(identity, Slot::Active(Box::new(actor)));
                Ok(handle)
            }
            Err(err) => {
                guard.remove(&identity);
                Err(err)
            }
        };
        self.ready.notify_all();
        result
    }
}

/// The next step the open loop should take (computed without holding a borrow
/// into the map across a mutation).
enum Action {
    Return,
    Evict,
    Wait,
    Reserve,
    /// Remove a drained slot, or refuse while it drains.
    Settle,
}

/// A store [`prepare_store`] made ready: the path SQLite opens it by and, on
/// a Mac and Linux, the folder that path goes through.
pub(crate) struct PreparedStore {
    pub(crate) path: PathBuf,
    #[cfg(any(target_vendor = "apple", target_os = "linux"))]
    _folder: std::os::fd::OwnedFd,
}

/// Create the store's folder and keep it and the store private before
/// SQLite opens anything there.
fn prepare_store(db_path: &Path) -> Result<PreparedStore, RuntimeError> {
    let (Some(parent), Some(name)) = (db_path.parent(), db_path.file_name()) else {
        return Err(RuntimeError::Identity {
            reason: "engine.db path has no parent directory",
            source: None,
        });
    };
    // Owner-only on Unix, so other users cannot reach the store. Windows has
    // no mode; ACLs govern access there. On macOS a mode does not limit an ACL
    // entry, so each open also removes any the folder has. A refusal for a
    // volume that keeps them, or for what is at a path, reaches the wire by
    // its own code. `shown` is the folder's path as a refusal names it.
    #[cfg(target_vendor = "apple")]
    let (folder, shown) = {
        let (base, relative) = checked_from(parent);
        (
            dohc_macos_files::ensure_private_dir(base, relative),
            relative,
        )
    };
    // Linux opens each folder without following a link, refuses another
    // user's, and holds the store's folder open.
    #[cfg(target_os = "linux")]
    let (folder, shown) = {
        let (base, relative) = checked_from(parent);
        (
            dohc_linux_files::held::private_dir(base, relative),
            relative,
        )
    };
    #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
    let (folder, shown) = {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        let folder = builder
            .create(parent)
            .and_then(|()| open_store_folder(parent));
        (folder, parent)
    };
    #[cfg_attr(not(unix), allow(clippy::let_unit_value))]
    let folder = folder.map_err(|err| RuntimeError::Identity {
        reason: "could not create engine.db parent directory",
        source: Some(err),
    })?;
    // On Linux, SQLite opens the store and creates its journals through the
    // descriptor held for the folder checked here, so a folder put at its
    // name since then is not reached. Without that path the open is refused
    // before any store file is made.
    #[cfg(target_os = "linux")]
    let held = dohc_linux_files::held::held_path(std::os::fd::AsFd::as_fd(&folder), shown)
        .map_err(|err| RuntimeError::Identity {
            reason: "could not keep the engine store private",
            source: Some(err),
        })?;
    #[cfg(unix)]
    {
        #[cfg(target_vendor = "apple")]
        let local = dohc_macos_files::is_local(std::os::fd::AsFd::as_fd(&folder));
        #[cfg(not(target_vendor = "apple"))]
        let local = Ok(true);
        local
            .and_then(|local| restrict_store_files(&folder, shown, name, local))
            .map_err(|err| RuntimeError::Identity {
                reason: "could not keep the engine store private",
                source: Some(err),
            })?;
    }
    // On a Mac, SQLite opens the store and creates its journals through the
    // folder checked here, so a folder put at its name since then is not
    // reached. A network volume, and one that ignores owners, keep the plain
    // path: a mode keeps no other user out there. Any other volume that can't
    // reach the folder by its ID is refused.
    #[cfg(target_vendor = "apple")]
    {
        let by_id =
            dohc_macos_files::path_by_id(&folder, shown).map_err(|err| RuntimeError::Identity {
                reason: "could not keep the engine store private",
                source: Some(err),
            })?;
        Ok(PreparedStore {
            path: by_id.map_or_else(|| db_path.to_owned(), |dir| dir.join(name)),
            _folder: folder,
        })
    }
    #[cfg(target_os = "linux")]
    {
        Ok(PreparedStore {
            path: held.join(name),
            _folder: folder,
        })
    }
    #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
    {
        let _ = (folder, shown, name);
        Ok(PreparedStore {
            path: db_path.to_owned(),
        })
    }
}

/// The folder the store's folder is checked from, and the store's folder
/// below it. In a workspace, `.dohc` is checked as well as the folder.
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
fn checked_from(parent: &Path) -> (&Path, &Path) {
    let depth = if parent.ends_with(".dohc/engine") {
        2
    } else {
        1
    };
    let base = parent.ancestors().nth(depth).unwrap_or(Path::new(""));
    let relative = parent.strip_prefix(base).unwrap_or(parent);
    let base = if base.as_os_str().is_empty() {
        Path::new(".")
    } else {
        base
    };
    (base, relative)
}

#[cfg(all(unix, not(any(target_vendor = "apple", target_os = "linux"))))]
fn open_store_folder(parent: &Path) -> std::io::Result<std::os::fd::OwnedFd> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    Ok(rustix::fs::open(parent, flags, Mode::empty())?)
}

#[cfg(not(unix))]
fn open_store_folder(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Give the store `name` in `folder`, and any journal beside it, mode 0600
/// and, on a Mac, no ACL entries, and create a missing store with mode 0600
/// so SQLite gives its journals that mode too. A mode and an ACL belong to
/// the file, not its name, so a hard link another user made while the
/// store's folder was open to them reads nothing afterwards. A link at any of
/// these names, or anything but a file, is refused on every volume. On a
/// Mac, so is a file another user owns on a local volume, before its ACL or
/// mode changes. The files are never opened for reading or writing: closing
/// such a descriptor would drop the locks SQLite holds on them. On a volume
/// that is not `local`, such as a network share, nothing is created or
/// changed: its modes, owners and ACLs are its server's. A refusal names the
/// file under `shown`, the folder's path.
#[cfg(unix)]
fn restrict_store_files(
    folder: &std::os::fd::OwnedFd,
    shown: &Path,
    name: &std::ffi::OsStr,
    local: bool,
) -> std::io::Result<()> {
    restrict_store_files_with(folder, shown, name, local, None, |_| {})
}

/// [`restrict_store_files`], with seams for the user the files must belong
/// to on a Mac, `None` for the folder's owner, which the caller has made
/// sure is this process's user, and for the moment just before each change
/// of mode.
#[cfg(unix)]
fn restrict_store_files_with(
    folder: &std::os::fd::OwnedFd,
    shown: &Path,
    name: &std::ffi::OsStr,
    local: bool,
    owner: Option<u32>,
    before_chmod: impl Fn(&std::ffi::OsStr),
) -> std::io::Result<()> {
    use rustix::fs::{AtFlags, FileType, Mode, OFlags};
    #[cfg(target_vendor = "apple")]
    let owner = match owner {
        Some(owner) => owner,
        None => rustix::fs::fstat(folder)?.st_uid,
    };
    #[cfg(not(target_vendor = "apple"))]
    let _ = owner;
    if local {
        let create = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW;
        match rustix::fs::openat(
            folder,
            name,
            create | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        ) {
            Ok(_) | Err(rustix::io::Errno::EXIST) => {}
            Err(err) => return Err(err.into()),
        }
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut file = name.to_owned();
        file.push(suffix);
        let stat = match rustix::fs::statat(folder, &file, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(rustix::io::Errno::NOENT) => continue,
            Err(err) => return Err(err.into()),
        };
        let kind = FileType::from_raw_mode(stat.st_mode);
        if kind != FileType::RegularFile {
            return Err(not_a_store_file(shown.join(&file), kind));
        }
        if !local {
            continue;
        }
        #[cfg(target_vendor = "apple")]
        if stat.st_uid != owner {
            return Err(std::io::Error::other(dohc_macos_files::NotPrivate {
                path: shown.join(&file),
                reason: dohc_macos_files::NotPrivateReason::OtherOwner,
            }));
        }
        #[cfg(target_vendor = "apple")]
        dohc_macos_files::remove_acl_entries_in(folder, shown, &file)?;
        if stat.st_mode & 0o077 != 0 {
            before_chmod(&file);
            // A journal another process removed since the check needs nothing.
            match chmod_private(folder, &file) {
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                changed => changed?,
            }
        }
    }
    Ok(())
}

/// The refusal of the store file at `path`, which is a link or not a file.
/// On a Mac it names the file and why, which the desktop shows.
#[cfg(target_vendor = "apple")]
fn not_a_store_file(path: std::path::PathBuf, kind: rustix::fs::FileType) -> std::io::Error {
    use dohc_macos_files::NotPrivateReason;
    let reason = if kind == rustix::fs::FileType::Symlink {
        NotPrivateReason::Link
    } else {
        NotPrivateReason::NotFile
    };
    std::io::Error::other(dohc_macos_files::NotPrivate { path, reason })
}

#[cfg(all(unix, not(target_vendor = "apple")))]
fn not_a_store_file(_path: std::path::PathBuf, _kind: rustix::fs::FileType) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "an engine store file is a link or not a file",
    )
}

/// Give `name` in `folder` mode 0600. On a Mac this never follows a link at
/// the name. Linux has no such call, so there a link put at the name since
/// the caller's check is followed; only a user who can write the store's
/// folder could put one there.
#[cfg(unix)]
fn chmod_private(folder: &std::os::fd::OwnedFd, name: &std::ffi::OsStr) -> std::io::Result<()> {
    use rustix::fs::{AtFlags, Mode};
    #[cfg(target_vendor = "apple")]
    let flags = AtFlags::SYMLINK_NOFOLLOW;
    #[cfg(not(target_vendor = "apple"))]
    let flags = AtFlags::empty();
    Ok(rustix::fs::chmodat(
        folder,
        name,
        Mode::RUSR | Mode::WUSR,
        flags,
    )?)
}

/// Recover the guard even if a prior holder panicked: a poisoned registry lock
/// carries no invariant we cannot re-establish (the map is plain data).
fn lock(mutex: &Mutex<Registry>) -> MutexGuard<'_, Registry> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Wait on the condvar, recovering from a poisoned lock the same way.
fn wait<'a>(cv: &Condvar, guard: MutexGuard<'a, Registry>) -> MutexGuard<'a, Registry> {
    cv.wait(guard).unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
mod tests {
    use super::WorkspaceSupervisor;
    use dohc_engine_testkit::ScratchDir;
    #[cfg(target_vendor = "apple")]
    use dohc_macos_files::NotPrivateReason;

    /// A workspace folder whose ACL passes read and search to everyone must
    /// not pass them to the engine's folder or its store (#2207).
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_new_store_takes_none_of_its_workspace_folders_acl() {
        let acl_lines = |path: &std::path::Path| {
            let listing = std::process::Command::new("/bin/ls")
                .arg("-led")
                .arg(path)
                .output()
                .unwrap();
            assert!(listing.status.success());
            String::from_utf8(listing.stdout).unwrap().lines().count() - 1
        };
        let scratch = ScratchDir::new().unwrap();
        let added = std::process::Command::new("/bin/chmod")
            .args([
                "+a",
                "group:everyone allow read,execute,file_inherit,directory_inherit",
            ])
            .arg(scratch.path())
            .status()
            .unwrap();
        assert!(added.success());
        let db = scratch.path().join(".dohc/engine/engine.db");
        let supervisor = WorkspaceSupervisor::new();
        supervisor.open(&db, 0).unwrap();
        let engine = db.parent().unwrap();
        let mut created = vec![scratch.path().join(".dohc"), engine.to_path_buf()];
        created.extend(
            std::fs::read_dir(engine)
                .unwrap()
                .map(|e| e.unwrap().path()),
        );
        assert!(created.contains(&db));
        for path in &created {
            assert_eq!(acl_lines(path), 0, "{}", path.display());
        }
        supervisor.close(&db).unwrap();
    }

    /// A folder put at `.dohc/engine` after the engine checked the real one
    /// gets neither the store nor its journals. They open in the checked
    /// folder, wherever it has moved (#2375).
    #[cfg(any(target_vendor = "apple", target_os = "linux"))]
    #[test]
    fn a_store_opens_in_the_folder_the_engine_checked() {
        let scratch = ScratchDir::new().unwrap();
        let db = scratch.path().join(".dohc/engine/engine.db");
        let prepared = super::prepare_store(&db).unwrap();
        let engine = db.parent().unwrap();
        let moved = scratch.path().join(".dohc/moved");
        std::fs::rename(engine, &moved).unwrap();
        std::fs::create_dir(engine).unwrap();
        let path = prepared.path.clone();
        let identity = crate::identity::EngineDbIdentity::resolve_or_create(&path).unwrap();
        let actor =
            crate::actor::WorkspaceActor::spawn(path, identity, 1, 0, None, Default::default())
                .unwrap()
                .holding(Some(prepared));
        assert_eq!(std::fs::read_dir(engine).unwrap().count(), 0);
        for file in ["engine.db", "engine.db-wal", "engine.db-shm"] {
            assert!(moved.join(file).exists(), "{file}");
        }
        drop(actor);
    }

    /// Where the engine can't reach its checked folder through the descriptor
    /// it holds, as without `/proc`, the open is refused, naming the folder,
    /// and nothing is made in it.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_store_whose_folder_cannot_be_held_is_refused_before_anything_is_written() {
        use dohc_linux_files::held::{not_held, test_support::with_fds};
        let scratch = ScratchDir::new().unwrap();
        let db = scratch.path().join(".dohc/engine/engine.db");
        let supervisor = WorkspaceSupervisor::new();
        let refused = with_fds(&scratch.path().join("no-fds"), || supervisor.open(&db, 0));
        let err = match refused {
            Err(crate::RuntimeError::Identity {
                source: Some(err), ..
            }) => err,
            Err(other) => panic!("{other:?}"),
            Ok(_) => panic!("the store opened by its name"),
        };
        let refused = not_held(&err).expect("a typed refusal");
        assert_eq!(refused.path, std::path::Path::new(".dohc/engine"));
        assert_eq!(supervisor.actor_count(), 0);
        let engine = db.parent().unwrap();
        let left: Vec<_> = std::fs::read_dir(engine)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[cfg(unix)]
    fn mode(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o7777
    }

    #[cfg(unix)]
    fn with_suffix(path: &std::path::Path, suffix: &str) -> std::path::PathBuf {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        name.into()
    }

    /// A store an earlier build left 0644 with the ACL entry its folder
    /// passed on, and a hard link another user made while that folder was
    /// open to them, reads as its owner's alone under both names after the
    /// next open, and so do its journals. Once the link is gone, it opens.
    #[cfg(unix)]
    #[test]
    fn an_open_keeps_an_old_store_private_under_every_name() {
        use std::os::unix::fs::PermissionsExt;
        #[cfg(target_vendor = "apple")]
        let has_entries = |path: &std::path::Path| {
            let listing = std::process::Command::new("/bin/ls")
                .arg("-led")
                .arg(path)
                .output()
                .unwrap();
            String::from_utf8(listing.stdout).unwrap().lines().count() > 1
        };
        let scratch = ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        supervisor.open(&db, 0).unwrap();
        supervisor.close(&db).unwrap();
        let linked = scratch.path().join("kept-by-another-user");
        std::fs::hard_link(&db, &linked).unwrap();
        let files = [
            db.clone(),
            with_suffix(&db, "-wal"),
            with_suffix(&db, "-shm"),
        ];
        for file in files.iter().filter(|file| file.exists()) {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o644)).unwrap();
            #[cfg(target_vendor = "apple")]
            {
                let added = std::process::Command::new("/bin/chmod")
                    .args(["+ai", "group:everyone allow read"])
                    .arg(file)
                    .status()
                    .unwrap();
                assert!(added.success());
                assert!(has_entries(file));
            }
        }
        // The engine refuses a hard-linked store, after making it private.
        assert!(matches!(
            supervisor.open(&db, 0),
            Err(crate::RuntimeError::WorkspaceHardlinked)
        ));
        for file in files.iter().chain([&linked]).filter(|file| file.exists()) {
            assert_eq!(mode(file), 0o600, "{}", file.display());
            #[cfg(target_vendor = "apple")]
            assert!(!has_entries(file), "{}", file.display());
        }
        std::fs::remove_file(&linked).unwrap();
        supervisor.open(&db, 0).unwrap();
        supervisor.close(&db).unwrap();
    }

    /// A new store starts at mode 0600, so SQLite gives its journals 0600
    /// too.
    #[cfg(unix)]
    #[test]
    fn a_new_store_and_its_journals_are_private_from_the_first_open() {
        let scratch = ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        supervisor.open(&db, 0).unwrap();
        let wal = with_suffix(&db, "-wal");
        assert!(wal.exists());
        for file in [db.clone(), wal, with_suffix(&db, "-shm")] {
            assert_eq!(mode(&file), 0o600, "{}", file.display());
        }
        supervisor.close(&db).unwrap();
    }

    /// A folder holding `engine.db` at 0644 and an empty `-wal` at 0644,
    /// and that folder open for reading.
    #[cfg(unix)]
    fn old_store(scratch: &ScratchDir) -> (std::path::PathBuf, std::os::fd::OwnedFd) {
        use std::os::unix::fs::PermissionsExt;
        let folder = scratch.path().join("engine");
        std::fs::create_dir(&folder).unwrap();
        let db = folder.join("engine.db");
        for file in [db.clone(), with_suffix(&db, "-wal")] {
            std::fs::write(&file, b"").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let open = std::os::fd::OwnedFd::from(std::fs::File::open(&folder).unwrap());
        (db, open)
    }

    /// On a network volume a link at a store file is still refused, and
    /// otherwise nothing is created or changed.
    #[cfg(unix)]
    #[test]
    fn on_a_network_volume_links_are_refused_and_nothing_changes() {
        let scratch = ScratchDir::new().unwrap();
        let (db, folder) = old_store(&scratch);
        let name = db.file_name().unwrap();
        let wal = with_suffix(&db, "-wal");
        std::fs::remove_file(&wal).unwrap();
        std::os::unix::fs::symlink(scratch.path().join("elsewhere"), &wal).unwrap();
        let shown = std::path::Path::new("engine");
        let err = super::restrict_store_files(&folder, shown, name, false).unwrap_err();
        #[cfg(target_vendor = "apple")]
        assert_eq!(
            dohc_macos_files::not_private(&err),
            Some(&dohc_macos_files::NotPrivate {
                path: "engine/engine.db-wal".into(),
                reason: dohc_macos_files::NotPrivateReason::Link,
            })
        );
        #[cfg(not(target_vendor = "apple"))]
        let _ = err;
        std::fs::remove_file(&wal).unwrap();
        super::restrict_store_files(&folder, shown, name, false).unwrap();
        assert_eq!(mode(&db), 0o644);
        std::fs::remove_file(&db).unwrap();
        super::restrict_store_files(&folder, shown, name, false).unwrap();
        assert!(!db.exists(), "a store is created on a network volume");
    }

    /// A store file another user owns on a local volume, as `sudo` can leave
    /// one, is refused by name before its ACL or mode changes. Making one
    /// needs root, so the seam expects another owner instead. A network
    /// volume's owners are its server's, so there it passes unchanged.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_store_file_another_user_owns_is_refused_and_left_alone() {
        use std::os::unix::fs::MetadataExt;
        let scratch = ScratchDir::new().unwrap();
        let (db, folder) = old_store(&scratch);
        let name = db.file_name().unwrap();
        let shown = std::path::Path::new(".dohc/engine");
        let other = Some(std::fs::metadata(&db).unwrap().uid() + 1);
        let changed = |_: &std::ffi::OsStr| panic!("changed another user's store file");
        let err = super::restrict_store_files_with(&folder, shown, name, true, other, changed)
            .unwrap_err();
        assert_eq!(
            dohc_macos_files::not_private(&err),
            Some(&dohc_macos_files::NotPrivate {
                path: ".dohc/engine/engine.db".into(),
                reason: NotPrivateReason::OtherOwner,
            })
        );
        assert_eq!(mode(&db), 0o644);
        super::restrict_store_files_with(&folder, shown, name, false, other, changed).unwrap();
        assert_eq!(mode(&db), 0o644);
    }

    /// A journal another process removes between the check and the mode
    /// change needs nothing.
    #[cfg(unix)]
    #[test]
    fn a_journal_removed_before_its_mode_change_is_skipped() {
        let scratch = ScratchDir::new().unwrap();
        let (db, folder) = old_store(&scratch);
        let wal = with_suffix(&db, "-wal");
        let remove = |name: &std::ffi::OsStr| {
            if name.to_string_lossy().ends_with("-wal") {
                std::fs::remove_file(&wal).unwrap();
            }
        };
        let shown = std::path::Path::new("engine");
        let name = db.file_name().unwrap();
        super::restrict_store_files_with(&folder, shown, name, true, None, remove).unwrap();
        assert_eq!(mode(&db), 0o600);
    }

    /// A journal swapped for a link after it was checked is not followed: the
    /// mode change lands on the link, never on the file it names.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_link_swapped_in_before_the_mode_change_is_not_followed() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = ScratchDir::new().unwrap();
        let folder = scratch.path().join("engine");
        std::fs::create_dir(&folder).unwrap();
        let db = folder.join("engine.db");
        let wal = with_suffix(&db, "-wal");
        std::fs::write(&wal, b"").unwrap();
        std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o644)).unwrap();
        let unrelated = scratch.path().join("unrelated");
        std::fs::write(&unrelated, b"mine").unwrap();
        std::fs::set_permissions(&unrelated, std::fs::Permissions::from_mode(0o644)).unwrap();
        let swap = |name: &std::ffi::OsStr| {
            if name.to_string_lossy().ends_with("-wal") {
                std::fs::remove_file(&wal).unwrap();
                std::os::unix::fs::symlink(&unrelated, &wal).unwrap();
            }
        };
        let open = std::os::fd::OwnedFd::from(std::fs::File::open(&folder).unwrap());
        let shown = std::path::Path::new("engine");
        let name = db.file_name().unwrap();
        super::restrict_store_files_with(&open, shown, name, true, None, swap).unwrap();
        assert_eq!(mode(&unrelated), 0o644);
        assert_eq!(mode(&db), 0o600, "the missing store is created private");
    }

    /// A link at the store or at a journal is refused before SQLite opens
    /// anything, and the file it names is left as it was.
    #[cfg(unix)]
    #[test]
    fn a_link_at_a_store_file_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        supervisor.open(&db, 0).unwrap();
        supervisor.close(&db).unwrap();
        let unrelated = scratch.path().join("unrelated");
        std::fs::write(&unrelated, b"mine").unwrap();
        std::fs::set_permissions(&unrelated, std::fs::Permissions::from_mode(0o644)).unwrap();
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(with_suffix(&db, suffix));
        }
        let wal = with_suffix(&db, "-wal");
        std::os::unix::fs::symlink(&unrelated, &wal).unwrap();
        let refused = supervisor.open(&db, 0).err();
        #[cfg(target_vendor = "apple")]
        assert_eq!(
            not_private(refused),
            (".dohc/engine/engine.db-wal".into(), NotPrivateReason::Link)
        );
        #[cfg(not(target_vendor = "apple"))]
        assert!(refused.is_some());
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"mine");
        assert_eq!(mode(&unrelated), 0o644);

        std::fs::remove_file(&wal).unwrap();
        let real = scratch.path().join("real.db");
        std::fs::rename(&db, &real).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&real, &db).unwrap();
        let refused = supervisor.open(&db, 0).err();
        #[cfg(target_vendor = "apple")]
        assert_eq!(
            not_private(refused),
            (".dohc/engine/engine.db".into(), NotPrivateReason::Link)
        );
        #[cfg(not(target_vendor = "apple"))]
        assert!(refused.is_some());
        assert_eq!(mode(&real), 0o644);

        // A folder where a journal belongs is not a file.
        std::fs::remove_file(&db).unwrap();
        std::fs::rename(&real, &db).unwrap();
        std::fs::create_dir(&wal).unwrap();
        let refused = supervisor.open(&db, 0).err();
        #[cfg(target_vendor = "apple")]
        assert_eq!(
            not_private(refused),
            (
                ".dohc/engine/engine.db-wal".into(),
                NotPrivateReason::NotFile
            )
        );
        #[cfg(not(target_vendor = "apple"))]
        assert!(refused.is_some());
    }

    /// The path and reason a refused open names.
    #[cfg(target_vendor = "apple")]
    fn not_private(refused: Option<crate::RuntimeError>) -> (std::path::PathBuf, NotPrivateReason) {
        match refused {
            Some(crate::RuntimeError::Identity {
                source: Some(err), ..
            }) => {
                let refused = dohc_macos_files::not_private(&err);
                let refused = refused.unwrap_or_else(|| panic!("{err}"));
                (refused.path.clone(), refused.reason)
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn independent_supervisors_refuse_a_second_writer_then_allow_reopen() {
        let scratch = ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let first = WorkspaceSupervisor::new();
        let second = WorkspaceSupervisor::new();
        assert!(first.open(&db, 0).unwrap().created_actor);
        assert!(!first.open(&db, 0).unwrap().created_actor);
        assert!(matches!(
            second.open(&db, 0),
            Err(crate::RuntimeError::WorkspaceOwned)
        ));
        first.close(&db).unwrap();
        assert!(second.open(&db, 0).unwrap().created_actor);
        second.close(&db).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_counted_open_counts_the_store_open_then_each_command() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let work = Arc::new(AtomicU64::new(0));
        let opened = supervisor
            .open_counting(&db, 1, Some(Arc::clone(&work)))
            .expect("counted open");
        let after_open = work.load(Ordering::Relaxed);
        assert!(after_open > 0, "the store open's migrations count");
        assert_eq!(
            Arc::strong_count(&work),
            1,
            "the actor holds the counter weakly, so it ends with its owner"
        );
        opened
            .actor
            .ydoc_cache_stats_for_test()
            .await
            .expect("one command");
        assert!(work.load(Ordering::Relaxed) > after_open);
        let released = Arc::downgrade(&work);
        drop(work);
        opened
            .actor
            .ydoc_cache_stats_for_test()
            .await
            .expect("a command after the owner is gone");
        assert!(released.upgrade().is_none());
        supervisor.close(&db).expect("close");
    }

    #[test]
    fn a_counted_root_bound_open_persists_its_initial_token() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let work = Arc::new(AtomicU64::new(0));
        let opened = supervisor
            .open_root_bound(&db, 1, "initial-root", Some(Arc::clone(&work)))
            .expect("counted root-bound open");
        assert!(opened.store_freshly_created);
        assert!(work.load(Ordering::Relaxed) > 0);
        drop(opened);
        supervisor.close(&db).expect("close fresh actor");
        assert_eq!(Arc::strong_count(&work), 1);

        let store = dohc_engine_storage::EngineStore::open_read_only(&db).expect("reopen store");
        let token: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT token FROM shadow_clone WHERE rowid_guard = 1",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("initial token is already durable without a later bind");
        assert_eq!(token, "initial-root");
    }

    #[test]
    fn open_reports_actor_ownership_and_store_disposition() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();

        let first = supervisor.open(&db, 1).expect("first open");
        assert!(first.created_actor);
        assert!(first.store_freshly_created);

        let attached = supervisor.open(&db, 2).expect("attach to active actor");
        assert!(!attached.created_actor);
        assert!(attached.store_freshly_created);
        drop((first, attached));

        supervisor.close(&db).expect("close fresh actor");
        let reopened = supervisor.open(&db, 3).expect("reopen existing store");
        assert!(reopened.created_actor);
        assert!(!reopened.store_freshly_created);
        drop(reopened);
        supervisor.close(&db).expect("close reopened actor");
    }
}
