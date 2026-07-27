//! The session registry: one workspace actor per canonical `engine.db`
//! **file identity**. This is the Rust home of the TS engine's process-global
//! `storeWriteChains` map + `workspaceActivity` registry
//! (`STATE_OWNERSHIP.tsv` row `actor-registry`). Its defining job is dedup by
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

use crate::actor::{ActorHandle, LifecycleState, WorkspaceActor};
use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};

type Registry = HashMap<EngineDbIdentity, Slot>;

/// A registry slot. `Reserving` and `Closing` are both "busy" placeholders held
/// while the lock is released for a blocking spawn or close: a concurrent open
/// of the same identity waits on the condvar rather than forking a second
/// writer while the first is still opening OR still closing.
enum Slot {
    Reserving,
    Closing,
    Active(WorkspaceActor),
}

#[derive(Clone, Copy)]
enum ActorOpenMode {
    ReadWrite,
    ReadOnly,
}

impl Slot {
    /// Whether this slot is a transient placeholder that a waiter must wait out.
    fn is_busy(&self) -> bool {
        matches!(self, Slot::Reserving | Slot::Closing)
    }
}

/// Owns every open workspace actor, keyed by canonical file identity. Dropping
/// the supervisor drops every actor, each of which joins its worker and
/// releases its connection.
pub struct WorkspaceSupervisor {
    registry: Mutex<Registry>,
    ready: Condvar,
}

/// Result of opening a workspace actor. `created_actor` is true only for the
/// caller that installed a newly-spawned actor in the process-wide registry;
/// attachers to an existing live actor receive false.
pub struct SupervisorOpen {
    pub actor: ActorHandle,
    pub created_actor: bool,
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
    /// Close the actor and release its registry marker.
    pub fn finish(mut self) -> Result<(), RuntimeError> {
        let close_result = match self.actor.take() {
            Some(mut actor) => actor.close(),
            None => Ok(()),
        };
        self.clear_marker();
        close_result
    }

    fn clear_marker(&mut self) {
        if self.marker_active {
            self.supervisor
                .clear_markers(std::slice::from_ref(&self.identity));
            self.marker_active = false;
        }
    }
}

impl Drop for WorkspaceClose<'_> {
    fn drop(&mut self) {
        if let Some(mut actor) = self.actor.take() {
            let _ = actor.close();
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
    /// is evicted and re-opened.
    pub fn open(&self, db_path: &Path, now_ms: i64) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, now_ms, ActorOpenMode::ReadWrite)
    }

    /// Open an existing workspace through a read-only store connection. This
    /// path never creates the parent, the database, or migration state.
    pub fn open_read_only(&self, db_path: &Path) -> Result<SupervisorOpen, RuntimeError> {
        self.open_with_mode(db_path, 0, ActorOpenMode::ReadOnly)
    }

    fn open_with_mode(
        &self,
        db_path: &Path,
        now_ms: i64,
        mode: ActorOpenMode,
    ) -> Result<SupervisorOpen, RuntimeError> {
        if matches!(mode, ActorOpenMode::ReadWrite) {
            ensure_parent_dir(db_path)?;
        }
        let mut dead: Option<WorkspaceActor> = None;
        let identity;
        {
            let mut guard = lock(&self.registry);
            identity = match mode {
                ActorOpenMode::ReadWrite => EngineDbIdentity::resolve_or_create(db_path)?,
                ActorOpenMode::ReadOnly => EngineDbIdentity::of_existing(db_path)?,
            };
            loop {
                let action = match guard.get(&identity) {
                    Some(Slot::Active(actor)) => {
                        if actor.lifecycle() == LifecycleState::Closed {
                            Action::Evict
                        } else {
                            Action::Return
                        }
                    }
                    Some(Slot::Reserving | Slot::Closing) => Action::Wait,
                    None => Action::Reserve,
                };
                match action {
                    Action::Return => {
                        if let Some(Slot::Active(actor)) = guard.get(&identity) {
                            return Ok(SupervisorOpen {
                                actor: actor.handle(),
                                created_actor: false,
                            });
                        }
                        continue; // slot changed under us; re-evaluate
                    }
                    Action::Evict => {
                        if let Some(Slot::Active(actor)) = guard.remove(&identity) {
                            dead = Some(actor);
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
        // Release the evicted actor's worker outside the lock.
        drop(dead);

        let spawned = match mode {
            ActorOpenMode::ReadWrite => {
                WorkspaceActor::spawn(db_path.to_path_buf(), identity.clone(), 1, now_ms)
            }
            ActorOpenMode::ReadOnly => {
                WorkspaceActor::spawn_read_only(db_path.to_path_buf(), identity.clone(), 1)
            }
        };
        self.finalize_reservation(identity, spawned)
            .map(|actor| SupervisorOpen {
                actor,
                created_actor: true,
            })
    }

    /// Close and reopen the actor for `db_path`, incrementing its session
    /// generation. Generation continuity is preserved even if the predecessor's
    /// worker panicked (a dead predecessor is treated as already-closed).
    pub fn restart(&self, db_path: &Path, now_ms: i64) -> Result<ActorHandle, RuntimeError> {
        ensure_parent_dir(db_path)?;

        let (old, next_generation, identity) = {
            let mut guard = lock(&self.registry);
            let identity = EngineDbIdentity::resolve_or_create(db_path)?;
            // Wait out any in-flight reservation/close for this identity.
            while guard.get(&identity).is_some_and(Slot::is_busy) {
                guard = wait(&self.ready, guard);
            }
            let old = guard.remove(&identity);
            let next_generation = match &old {
                Some(Slot::Active(actor)) => actor.generation().saturating_add(1),
                _ => 1,
            };
            guard.insert(identity.clone(), Slot::Reserving);
            (old, next_generation, identity)
        };

        // Close the predecessor outside the lock; a WorkerPanicked from a dead
        // predecessor is expected here, not an error.
        if let Some(Slot::Active(mut actor)) = old {
            let _ = actor.close();
        }

        let spawned = WorkspaceActor::spawn(
            db_path.to_path_buf(),
            identity.clone(),
            next_generation,
            now_ms,
        );
        self.finalize_reservation(identity, spawned)
    }

    /// Remove the actor for `db_path` and synchronously mark its slot `Closing`.
    ///
    /// The returned operation owns the actor and marker. It may be moved to a
    /// blocking task; dropping it still closes the actor before waking waiters.
    pub fn begin_close(&self, db_path: &Path) -> Result<Option<WorkspaceClose<'_>>, RuntimeError> {
        let Some(identity) = EngineDbIdentity::resolve_existing_opt(db_path)? else {
            return Ok(None);
        };
        let actor = {
            let mut guard = lock(&self.registry);
            while guard.get(&identity).is_some_and(Slot::is_busy) {
                guard = wait(&self.ready, guard);
            }
            match guard.remove(&identity) {
                Some(Slot::Active(actor)) => {
                    guard.insert(identity.clone(), Slot::Closing);
                    Some(actor)
                }
                _ => None,
            }
        };
        let Some(actor) = actor else {
            return Ok(None);
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

    /// Close every open actor.
    pub fn close_all(&self) -> Result<(), RuntimeError> {
        let mut closing = Vec::new();
        let drained: Vec<WorkspaceActor> = {
            let mut guard = lock(&self.registry);
            let active_keys: Vec<EngineDbIdentity> = guard
                .iter()
                .filter(|(_, slot)| matches!(slot, Slot::Active(_)))
                .map(|(identity, _)| identity.clone())
                .collect();
            active_keys
                .into_iter()
                .filter_map(|identity| match guard.remove(&identity) {
                    Some(Slot::Active(actor)) => {
                        guard.insert(identity.clone(), Slot::Closing);
                        closing.push(identity);
                        Some(actor)
                    }
                    _ => None,
                })
                .collect()
        };
        let mut first_err = None;
        for mut actor in drained {
            if let Err(err) = actor.close() {
                first_err.get_or_insert(err);
            }
        }
        self.clear_markers(&closing);
        match first_err {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    /// Remove `Closing` markers and wake any threads waiting on those
    /// identities.
    fn clear_markers(&self, identities: &[EngineDbIdentity]) {
        let mut guard = lock(&self.registry);
        for identity in identities {
            guard.remove(identity);
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
                guard.insert(identity, Slot::Active(actor));
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
}

fn ensure_parent_dir(db_path: &Path) -> Result<(), RuntimeError> {
    let parent = db_path.parent().ok_or(RuntimeError::Identity {
        reason: "engine.db path has no parent directory",
        source: None,
    })?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    // Owner-only on Unix (matches the TS engine's `.dohc/engine` 0o700 so a
    // world-searchable directory never exposes workspace contents); a no-op on
    // Windows, where ACLs govern access.
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(parent)
        .map_err(|err| RuntimeError::Identity {
            reason: "could not create engine.db parent directory",
            source: Some(err),
        })
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
