//! The session registry: one workspace actor per canonical `engine.db`
//! identity. This is the Rust home of the TS engine's process-global
//! `storeWriteChains` map + `workspaceActivity` registry
//! (`STATE_OWNERSHIP.tsv` row `actor-registry`). Its defining job is dedup by
//! **file identity**: two aliased paths to the same database resolve to one
//! actor — and therefore one writer connection — never two.

use crate::actor::{ActorHandle, WorkspaceActor};
use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// Owns every open workspace actor, keyed by canonical identity. Dropping the
/// supervisor drops every actor, each of which joins its worker and releases
/// its connection.
#[derive(Default)]
pub struct WorkspaceSupervisor {
    actors: Mutex<HashMap<EngineDbIdentity, WorkspaceActor>>,
}

impl WorkspaceSupervisor {
    /// A fresh, empty supervisor.
    pub fn new() -> Self {
        WorkspaceSupervisor::default()
    }

    /// Open (or attach to) the workspace whose database is at `db_path`.
    ///
    /// The parent directory is created if missing, the path is resolved to a
    /// canonical identity, and — if an actor for that identity already exists —
    /// its handle is returned without opening a second connection. This is the
    /// alias-convergence contract.
    pub fn open(&self, db_path: &Path, now_ms: i64) -> Result<ActorHandle, RuntimeError> {
        ensure_parent_dir(db_path)?;
        let identity = EngineDbIdentity::resolve(db_path)?;

        // The lock is held across the blocking store open. For CAL-1 this
        // serializes opens of *different* workspaces; the actor model makes
        // that a throughput note, not a correctness one, and concurrent
        // multi-workspace open is out of this slice's scope.
        let mut actors = lock(&self.actors);
        if let Some(actor) = actors.get(&identity) {
            return Ok(actor.handle());
        }
        let actor = WorkspaceActor::spawn(db_path.to_path_buf(), identity.clone(), 1, now_ms)?;
        let handle = actor.handle();
        actors.insert(identity, actor);
        Ok(handle)
    }

    /// Close and reopen the actor for `db_path`, incrementing its session
    /// generation. The old connection is fully released before the new one
    /// opens (a single writer at all times — required on Windows, where an
    /// open handle blocks reopen/delete).
    pub fn restart(&self, db_path: &Path, now_ms: i64) -> Result<ActorHandle, RuntimeError> {
        ensure_parent_dir(db_path)?;
        let identity = EngineDbIdentity::resolve(db_path)?;

        let mut actors = lock(&self.actors);
        let next_generation = match actors.remove(&identity) {
            Some(mut actor) => {
                let generation = actor.generation();
                actor.close()?;
                generation.saturating_add(1)
            }
            None => 1,
        };
        let actor = WorkspaceActor::spawn(
            db_path.to_path_buf(),
            identity.clone(),
            next_generation,
            now_ms,
        )?;
        let handle = actor.handle();
        actors.insert(identity, actor);
        Ok(handle)
    }

    /// Close the actor for `db_path`, if open. Returns whether one was closed.
    pub fn close(&self, db_path: &Path) -> Result<bool, RuntimeError> {
        let identity = EngineDbIdentity::resolve(db_path)?;
        let removed = {
            let mut actors = lock(&self.actors);
            actors.remove(&identity)
        };
        match removed {
            Some(mut actor) => {
                actor.close()?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Close every open actor.
    pub fn close_all(&self) -> Result<(), RuntimeError> {
        let drained: Vec<WorkspaceActor> = {
            let mut actors = lock(&self.actors);
            actors.drain().map(|(_, actor)| actor).collect()
        };
        let mut first_err = None;
        for mut actor in drained {
            if let Err(err) = actor.close() {
                first_err.get_or_insert(err);
            }
        }
        match first_err {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    /// Number of currently open actors.
    pub fn actor_count(&self) -> usize {
        lock(&self.actors).len()
    }

    /// The session generation of the actor for `db_path`, if open.
    pub fn generation_of(&self, db_path: &Path) -> Result<Option<u64>, RuntimeError> {
        let identity = EngineDbIdentity::resolve(db_path)?;
        Ok(lock(&self.actors)
            .get(&identity)
            .map(WorkspaceActor::generation))
    }
}

fn ensure_parent_dir(db_path: &Path) -> Result<(), RuntimeError> {
    let parent = db_path.parent().ok_or(RuntimeError::Identity {
        reason: "engine.db path has no parent directory",
        source: None,
    })?;
    std::fs::create_dir_all(parent).map_err(|err| RuntimeError::Identity {
        reason: "could not create engine.db parent directory",
        source: Some(err),
    })
}

/// Recover the guard even if a prior holder panicked: a poisoned registry lock
/// carries no invariant we cannot re-establish (the map is plain data).
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}
