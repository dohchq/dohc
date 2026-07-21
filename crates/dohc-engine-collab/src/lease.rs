//! Per-document leases: opening a durable Y.Doc obtains an exclusive lease so a
//! second open of the same lineage is refused rather than forking two writers
//! into it (mirrors the TS driver's `globalLiveYDocReservations`). The store's
//! single owned connection already enforces one writer per `engine.db`; the
//! lease adds the finer-grained per-lineage exclusion the co-editing lifecycle
//! needs, and releases DETERMINISTICALLY on `Drop` (never stranded "live" on a
//! panic or an early return during a failed open).
//!
//! **Scope: PROCESS-LOCAL, per-registry.** Exclusion holds only within one
//! [`LeaseRegistry`] in one process — two independent registries (or two
//! processes) can each grant a lease for the same [`DocKey`], exactly like the
//! TS `globalLiveYDocReservations` (a per-process module-global set). CROSS-
//! PROCESS exclusion is NOT this type's job: it rides the store's single owned
//! writer connection (one writer per `engine.db`) plus the durable base-once
//! re-check in `claim_base`. Pass ONE registry per process to the code that
//! opens sessions.
//!
//! If the internal mutex is ever poisoned (a thread panicked while holding it),
//! [`LeaseRegistry::acquire`] fails closed (no lease is granted) rather than
//! risk double-granting.

use std::collections::HashSet;
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
    held: Arc<Mutex<HashSet<(String, String)>>>,
}

fn object_scope(key: &DocKey) -> (String, String) {
    (key.workspace_id.clone(), key.object_id.clone())
}

impl LeaseRegistry {
    /// A fresh empty registry.
    pub fn new() -> Self {
        LeaseRegistry::default()
    }

    /// Acquire an exclusive lease for `key`. Fails with [`CollabError::LeaseHeld`]
    /// if another live lease for the same lineage is outstanding.
    pub fn acquire(&self, key: &DocKey) -> Result<Lease, CollabError> {
        let mut held = self.held.lock().map_err(|_| CollabError::Corrupt {
            reason: "lease registry mutex poisoned".to_string(),
        })?;
        if !held.insert(object_scope(key)) {
            return Err(CollabError::LeaseHeld);
        }
        Ok(Lease {
            held: self.held.clone(),
            key: object_scope(key),
            released: false,
        })
    }

    /// Whether a lease for `key`'s object is currently held (any version).
    pub fn is_held(&self, key: &DocKey) -> bool {
        self.held
            .lock()
            .map(|held| held.contains(&object_scope(key)))
            .unwrap_or(false)
    }
}

/// An RAII lease guard. Dropping it releases the lease deterministically.
pub struct Lease {
    held: Arc<Mutex<HashSet<(String, String)>>>,
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
