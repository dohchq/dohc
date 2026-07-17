//! The collab layer's typed error taxonomy. Every fallible boundary returns a
//! `CollabError`; no `unwrap`/`expect`/`panic` in non-test code. `.code()`
//! yields a stable machine-readable string for test assertions and the future
//! protocol surface, mirroring `StorageError::code`.

use dohc_engine_storage::StorageError;

/// Errors from the durable Y.Doc layer.
#[derive(Debug, thiserror::Error)]
pub enum CollabError {
    /// An update failed to decode/apply (truncated or malformed). The doc is
    /// state-unchanged and the bytes are NEVER journaled (binding constraint 5).
    #[error("malformed Y.Doc update: {reason}")]
    MalformedUpdate { reason: String },

    /// An empty update — rejected before any blob put / journal.
    #[error("empty Y.Doc update")]
    EmptyUpdate,

    /// An update exceeds the per-update byte cap; a single oversized op is
    /// malformed (an editor must batch/chunk below the cap) and would be
    /// rejected by every replicating peer on hydrate.
    #[error("Y.Doc update is {actual} bytes, over the {max}-byte cap")]
    UpdateTooLarge { actual: usize, max: usize },

    /// An identifier (`workspace_id`/`version_id`/`object_id`/`origin_id`) is
    /// empty or over the length bound.
    #[error("invalid identifier: {reason}")]
    InvalidIdentifier { reason: &'static str },

    /// A replicated lineage already has its single base; a second base is
    /// rejected (base-once). The caller must resume the existing lineage.
    #[error("replicated lineage already has a base (base-once)")]
    BaseAlreadyClaimed,

    /// A lease for this doc key is already held by another open session
    /// (single-writer per document).
    #[error("a lease for this document is already held")]
    LeaseHeld,

    /// No marker row exists for this doc key (the object is not Y.Doc-driven).
    #[error("no Y.Doc marker for this document key")]
    NoMarker,

    /// The persisted lineage is structurally inconsistent (e.g. a referenced
    /// blob is missing, or a snapshot fails to reconstruct).
    #[error("corrupt Y.Doc lineage: {reason}")]
    Corrupt { reason: String },

    /// A storage-layer failure (blob put, transaction, migration, …).
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl CollabError {
    /// A stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            CollabError::MalformedUpdate { .. } => "malformed-update",
            CollabError::EmptyUpdate => "empty-update",
            CollabError::UpdateTooLarge { .. } => "update-too-large",
            CollabError::InvalidIdentifier { .. } => "invalid-identifier",
            CollabError::BaseAlreadyClaimed => "base-already-claimed",
            CollabError::LeaseHeld => "lease-held",
            CollabError::NoMarker => "no-marker",
            CollabError::Corrupt { .. } => "corrupt-lineage",
            CollabError::Storage(_) => "storage",
        }
    }
}
