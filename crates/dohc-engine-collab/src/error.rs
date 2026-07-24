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

    /// The update is valid Yjs v1 data, but one of its structural edit
    /// boundaries lands inside a multi-unit Unicode scalar. Yjs can represent
    /// that UTF-16 boundary while Rust strings cannot, so replay would diverge.
    #[error("Y.Doc replay parity violation: {reason}")]
    ReplayParityViolation { reason: String },

    /// An empty update — rejected before any blob put / journal.
    #[error("empty Y.Doc update")]
    EmptyUpdate,

    /// An update exceeds the per-update byte cap; a single oversized op is
    /// malformed (an editor must batch/chunk below the cap) and would be
    /// rejected by every replicating peer on hydrate.
    #[error("Y.Doc update is {actual} bytes, over the {max}-byte cap")]
    UpdateTooLarge { actual: usize, max: usize },

    /// Markdown projection exceeded its materialization cap. This is checked
    /// while rendering so hostile content cannot amplify a small Y.Doc into a
    /// much larger temporary allocation before the boundary rejects it.
    #[error("Y.Doc projection is at least {actual} bytes, over the {max}-byte cap")]
    ProjectionTooLarge { actual: usize, max: usize },

    /// Remote XML exceeded a structural projection bound before recursive
    /// descent or content-derived collection allocation.
    #[error("Y.Doc projection exceeds the {max_depth}-deep/{max_nodes}-node structural cap")]
    ProjectionTooComplex { max_depth: usize, max_nodes: usize },

    /// An identifier (`workspace_id`/`version_id`/`object_id`/`origin_id`) is
    /// empty or over the length bound.
    #[error("invalid identifier: {reason}")]
    InvalidIdentifier { reason: &'static str },

    /// The caller tried to append through a projection kind different from the
    /// kind that already owns this durable lineage.
    #[error("Y.Doc content kind does not match the existing lineage")]
    ContentKindMismatch,

    /// A replicated lineage already has its single base; a second base is
    /// rejected (base-once). The caller must resume the existing lineage.
    #[error("replicated lineage already has a base (base-once)")]
    BaseAlreadyClaimed,

    /// An incoming base-state envelope carries DIFFERENT bytes than the
    /// already-claimed base: acking it would silently drop a divergent
    /// lineage while the relay cursor advances past it.
    #[error("incoming base state diverges from the claimed base")]
    BaseStateDiverged,

    /// A lease for this doc key is already held by another open session
    /// (single-writer per document).
    #[error("a lease for this document is already held")]
    LeaseHeld,

    /// No marker row exists for this doc key (the object is not Y.Doc-driven).
    #[error("no Y.Doc marker for this document key")]
    NoMarker,
    /// The reconstructed doc still holds unintegrated remote updates (a
    /// missing cross-origin dependency): settling would record an
    /// incomplete projection as the settled artifact.
    #[error("the Y.Doc has unintegrated remote updates (missing dependency)")]
    MissingDependencies,

    /// An absent path's deterministic derived object id is still live at
    /// another alias (the file was renamed away): reusing it would graft a
    /// new document onto the renamed file's lineage, and open-time cannot
    /// reserve capture's order-disambiguated id pre-commit. The path becomes
    /// creatable again once a capture/local write mints the disambiguated
    /// object (write caps over the wire are RPC-D scope).
    #[error("the derived object id is live at another alias; write the file first")]
    ObjectAliasCollision,

    /// A session opened an absent lineage, but another writer established a
    /// durable update head before that session could record its seed.
    #[error("cannot seed onto an existing Y.Doc lineage")]
    SeedOntoExistingLineage,

    /// A local-only close would prune CRDT state whose edits no durable settle
    /// covers (the current head is not reflected in the materialized markdown).
    /// Settle first — markdown-is-the-artifact requires the artifact to exist
    /// before the cache is discarded.
    #[error("local-only close would discard unsettled edits; settle before closing")]
    UnsettledClose,

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
            CollabError::ReplayParityViolation { .. } => "replay-parity-violation",
            CollabError::EmptyUpdate => "empty-update",
            CollabError::UpdateTooLarge { .. } => "update-too-large",
            CollabError::ProjectionTooLarge { .. } => "projection-too-large",
            CollabError::ProjectionTooComplex { .. } => "projection-too-complex",
            CollabError::InvalidIdentifier { .. } => "invalid-identifier",
            CollabError::ContentKindMismatch => "content-kind-mismatch",
            CollabError::BaseAlreadyClaimed => "base-already-claimed",
            CollabError::BaseStateDiverged => "base-state-diverged",
            CollabError::LeaseHeld => "lease-held",
            CollabError::NoMarker => "no-marker",
            CollabError::MissingDependencies => "ydoc-missing-remote-dependencies",
            CollabError::ObjectAliasCollision => "object-alias-collision",
            CollabError::SeedOntoExistingLineage => "seed-onto-existing-lineage",
            CollabError::UnsettledClose => "unsettled-close",
            CollabError::Corrupt { .. } => "corrupt-lineage",
            CollabError::Storage(_) => "storage",
        }
    }
}
