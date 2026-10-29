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

use std::collections::HashMap;
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
    held: Arc<Mutex<HashMap<(String, String), LeaseBinding>>>,
    /// How many leases each scoped workspace has released. Capture defers a
    /// new file a live session holds and offers it again once its
    /// workspace's count moves.
    released: Arc<Mutex<HashMap<String, u64>>>,
}

#[derive(Clone)]
struct LeaseBinding {
    version_id: String,
    claim_id: Option<String>,
    notify_release: bool,
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
        self.acquire_with_notification(key, true)
    }

    /// Acquire exclusion for an engine-internal attempt. Its release does not
    /// wake deferred work: the attempt must finish before its caller returns.
    pub fn acquire_internal(&self, key: &DocKey) -> Result<Lease, CollabError> {
        self.acquire_with_notification(key, false)
    }

    fn acquire_with_notification(
        &self,
        key: &DocKey,
        notify_release: bool,
    ) -> Result<Lease, CollabError> {
        let mut held = self.held.lock().map_err(|_| CollabError::Corrupt {
            reason: "lease registry mutex poisoned".to_string(),
        })?;
        if held.contains_key(&self.object_scope(key)) {
            return Err(CollabError::LeaseHeld);
        }
        held.insert(
            self.object_scope(key),
            LeaseBinding {
                version_id: key.version_id.clone(),
                claim_id: None,
                notify_release,
            },
        );
        Ok(Lease {
            held: self.held.clone(),
            releases: self.released.clone(),
            key: self.object_scope(key),
            released: false,
            notify_release,
        })
    }

    /// Whether a lease for `key`'s object is currently held (any version).
    pub fn is_held(&self, key: &DocKey) -> bool {
        self.held
            .lock()
            .map(|held| held.contains_key(&self.object_scope(key)))
            .unwrap_or(false)
    }

    /// Whether a session lease holds `key`'s object (any version): one whose
    /// release moves [`Self::release_generation`]. An internal attempt's
    /// lease does not count.
    pub fn is_held_by_session(&self, key: &DocKey) -> bool {
        self.held
            .lock()
            .map(|held| {
                held.get(&self.object_scope(key))
                    .is_some_and(|binding| binding.notify_release)
            })
            .unwrap_or(false)
    }

    /// The exact claim the editor currently consumes, scoped to its version.
    /// Missing bindings and poisoned registries cannot authorize history admission.
    pub fn bound_claim(&self, key: &DocKey) -> Option<String> {
        self.held
            .lock()
            .ok()?
            .get(&self.object_scope(key))
            .filter(|binding| binding.version_id == key.version_id)?
            .claim_id
            .clone()
    }

    /// A count that moves when a session lease on `workspace_id` under this
    /// view's root is released. Internal attempts do not move it.
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
    held: Arc<Mutex<HashMap<(String, String), LeaseBinding>>>,
    releases: Arc<Mutex<HashMap<String, u64>>>,
    key: (String, String),
    released: bool,
    notify_release: bool,
}

impl Lease {
    /// Bind the lease to the claim the session consumes after open or resync.
    pub fn bind_claim(&self, claim_id: Option<&str>) -> Result<(), CollabError> {
        let mut held = self.held.lock().map_err(|_| CollabError::Corrupt {
            reason: "lease registry mutex poisoned".to_owned(),
        })?;
        let binding = held
            .get_mut(&self.key)
            .ok_or_else(|| CollabError::Corrupt {
                reason: "document lease is missing".to_owned(),
            })?;
        binding.claim_id = claim_id.map(ToOwned::to_owned);
        Ok(())
    }

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
        if !self.notify_release {
            return;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_session_lease_counts_as_held_by_a_session() {
        let registry = LeaseRegistry::new();
        let key = DocKey::new("ws", "main", "object").unwrap();
        let fork = DocKey::new("ws", "fork", "object").unwrap();
        assert!(!registry.is_held_by_session(&key));
        let internal = registry.acquire_internal(&key).unwrap();
        assert!(registry.is_held(&key));
        assert!(!registry.is_held_by_session(&key));
        drop(internal);
        let session = registry.acquire(&key).unwrap();
        assert!(
            registry.is_held_by_session(&fork),
            "any version of the object"
        );
        drop(session);
        assert!(!registry.is_held_by_session(&key));
    }

    #[test]
    fn internal_attempts_preserve_a_sessions_bound_claim_and_release_generation() {
        let registry = LeaseRegistry::new();
        let key = DocKey::new("ws", "main", "object").unwrap();
        let fork = DocKey::new("ws", "fork", "object").unwrap();
        let lease = registry.acquire(&key).unwrap();
        lease.bind_claim(Some("predecessor")).unwrap();
        for attempt in [&key, &fork] {
            assert!(matches!(
                registry.acquire_internal(attempt),
                Err(CollabError::LeaseHeld)
            ));
            assert_eq!(registry.bound_claim(&key).as_deref(), Some("predecessor"));
        }
        lease.bind_claim(Some("successor")).unwrap();
        assert_eq!(registry.bound_claim(&key).as_deref(), Some("successor"));
        assert_eq!(registry.release_generation("ws"), 0);
        drop(lease);
        assert_eq!(registry.bound_claim(&key), None);
        assert_eq!(registry.release_generation("ws"), 1);
        drop(registry.acquire_internal(&key).unwrap());
        assert_eq!(registry.bound_claim(&key), None);
        assert_eq!(registry.release_generation("ws"), 1);
    }

    #[test]
    fn binding_updates_do_not_bypass_or_notify_an_internal_guard() {
        let registry = LeaseRegistry::new();
        let key = DocKey::new("ws", "main", "object").unwrap();
        let fork = DocKey::new("ws", "fork", "object").unwrap();
        let sibling = DocKey::new("ws", "main", "sibling").unwrap();
        let internal = registry.acquire_internal(&key).unwrap();
        let session = registry.acquire(&sibling).unwrap();
        for claim in [Some("predecessor"), Some("successor"), None] {
            session.bind_claim(claim).unwrap();
            assert_eq!(registry.bound_claim(&sibling).as_deref(), claim);
            assert_eq!(registry.bound_claim(&key), None);
            assert!(registry.is_held(&key));
            for attempt in [&key, &fork] {
                assert!(matches!(
                    registry.acquire(attempt),
                    Err(CollabError::LeaseHeld)
                ));
            }
            assert_eq!(registry.release_generation("ws"), 0);
        }
        session.bind_claim(Some("sibling-session")).unwrap();
        drop(internal);
        assert!(!registry.is_held(&key));
        assert_eq!(
            registry.bound_claim(&sibling).as_deref(),
            Some("sibling-session")
        );
        assert_eq!(registry.release_generation("ws"), 0);
        let reopened = registry.acquire(&key).unwrap();
        reopened.bind_claim(Some("new-session")).unwrap();
        assert_eq!(registry.bound_claim(&key).as_deref(), Some("new-session"));
    }

    #[test]
    fn bound_claim_follows_the_session_and_is_scoped_to_root_and_version() {
        let registry = LeaseRegistry::new();
        let first = registry.scoped(std::path::Path::new("first"));
        let second = registry.scoped(std::path::Path::new("second"));
        let key = DocKey::new("ws", "main", "object").unwrap();
        let fork = DocKey::new("ws", "fork", "object").unwrap();
        let lease = first.acquire(&key).unwrap();
        assert_eq!(first.bound_claim(&key), None);
        lease.bind_claim(Some("predecessor")).unwrap();
        assert_eq!(first.bound_claim(&key).as_deref(), Some("predecessor"));
        assert_eq!(first.bound_claim(&fork), None);
        assert_eq!(second.bound_claim(&key), None);
        lease.bind_claim(Some("successor")).unwrap();
        assert_eq!(first.bound_claim(&key).as_deref(), Some("successor"));
        drop(lease);
        assert_eq!(first.bound_claim(&key), None);
        let _lease = first.acquire(&key).unwrap();
        assert_eq!(first.bound_claim(&key), None);
    }
}
