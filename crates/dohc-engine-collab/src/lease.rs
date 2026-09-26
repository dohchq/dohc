//! Per-document leases: opening a durable Y.Doc obtains an exclusive lease so a
//! second open of the same lineage is refused rather than forking two writers
//! into it (mirrors the TS driver's `globalLiveYDocReservations`). The store's
//! single owned connection already enforces one writer per `engine.db`; the
//! lease adds the finer-grained per-lineage exclusion the co-editing lifecycle
//! needs, and releases deterministically on `Drop` (never stranded "live" on a
//! panic or an early return during a failed open).
//!
//! **Scope: PROCESS-LOCAL, per-registry.** Exclusion holds only within one
//! [`LeaseRegistry`] in one process — two independent registries (or two
//! processes) can each grant a lease for the same [`DocKey`], exactly like the
//! TS `globalLiveYDocReservations` (a per-process module-global set). CROSS-
//! PROCESS exclusion is not this type's job: it rides the store's single owned
//! writer connection (one writer per `engine.db`) plus the durable base-once
//! re-check in `claim_base`. Pass one registry per process to the code that
//! opens sessions.
//!
//! If the internal mutex is ever poisoned (a thread panicked while holding it),
//! [`LeaseRegistry::acquire`] fails closed (no lease is granted) rather than
//! risk double-granting.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::error::CollabError;
use crate::DocKey;

/// An in-process registry of held document leases. Cheap to clone (shares the
/// held set); pass one clone per actor that opens sessions.
///
/// Reservation is per (workspace, OBJECT) — not per version: forks copy the
/// same object id into new versions, and two live canonical editors for one
/// object (main + fork) would journal divergent CRDT lineages that both
/// settle to the same workspace path. One object, one live session.
#[derive(Clone, Default)]
pub struct LeaseRegistry {
    /// Root-path scope prefixed onto the workspace component of every key.
    /// One process-wide registry serves every open root (multi-service
    /// exclusion on the same root), but two roots can carry the same
    /// workspace id and the same derived object id (two clones of one
    /// workspace) — unscoped keys would refuse the second root's open as
    /// ydoc-session-busy against a lease in a different engine DB. The
    /// default instance has an empty scope; per-root users hold a
    /// [`Self::scoped`] view sharing the same held-set.
    scope: String,
    held: Arc<Mutex<HashSet<(String, String)>>>,
    /// How many leases each scoped workspace has released. Capture defers a
    /// new file a live session holds and offers it again once its
    /// workspace's count moves.
    released: Arc<Mutex<HashMap<String, u64>>>,
}

impl LeaseRegistry {
    /// A fresh empty registry.
    pub fn new() -> Self {
        LeaseRegistry::default()
    }

    /// A view over the same shared held-set whose keys carry the workspace
    /// root, so identical (workspace, object) pairs under different roots
    /// cannot exclude each other.
    pub fn scoped(&self, root: &std::path::Path) -> LeaseRegistry {
        LeaseRegistry {
            scope: root.to_string_lossy().into_owned(),
            held: Arc::clone(&self.held),
            released: Arc::clone(&self.released),
        }
    }

    fn object_scope(&self, key: &DocKey) -> (String, String) {
        (
            self.workspace_scope(&key.workspace_id),
            key.object_id.clone(),
        )
    }

    fn workspace_scope(&self, workspace_id: &str) -> String {
        // NUL never appears in a path or workspace id — an unambiguous join.
        format!("{}{}{}", self.scope, char::from(0), workspace_id)
    }

    /// Acquire an exclusive lease for `key`. Fails with [`CollabError::LeaseHeld`]
    /// if another live lease for the same lineage is outstanding.
    pub fn acquire(&self, key: &DocKey) -> Result<Lease, CollabError> {
        let mut held = self.held.lock().map_err(|_| CollabError::Corrupt {
            reason: "lease registry mutex poisoned".to_string(),
        })?;
        if !held.insert(self.object_scope(key)) {
            return Err(CollabError::LeaseHeld);
        }
        Ok(Lease {
            held: self.held.clone(),
            releases: self.released.clone(),
            key: self.object_scope(key),
            released: false,
        })
    }

    /// Whether a lease for `key`'s object is currently held (any version).
    pub fn is_held(&self, key: &DocKey) -> bool {
        self.held
            .lock()
            .map(|held| held.contains(&self.object_scope(key)))
            .unwrap_or(false)
    }

    /// A count that moves every time a lease on `workspace_id` under this
    /// view's root is released.
    pub fn release_generation(&self, workspace_id: &str) -> u64 {
        self.released
            .lock()
            .ok()
            .and_then(|released| released.get(&self.workspace_scope(workspace_id)).copied())
            .unwrap_or(0)
    }
}

/// An RAII lease guard. Dropping it releases the lease deterministically.
pub struct Lease {
    held: Arc<Mutex<HashSet<(String, String)>>>,
    releases: Arc<Mutex<HashMap<String, u64>>>,
    key: (String, String),
    released: bool,
}

impl Lease {
    /// The leased (workspace, object) scope.
    pub fn scope(&self) -> (&str, &str) {
        (&self.key.0, &self.key.1)
    }

    /// Release the lease early (idempotent; `Drop` also releases).
    pub fn release(mut self) {
        self.release_inner();
    }

    fn release_inner(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        if let Ok(mut held) = self.held.lock() {
            held.remove(&self.key);
        }
        if let Ok(mut releases) = self.releases.lock() {
            let count = releases.entry(self.key.0.clone()).or_default();
            *count = count.wrapping_add(1);
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.release_inner();
    }
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease").field("key", &self.key).finish()
    }
}
