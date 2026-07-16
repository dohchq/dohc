//! Versioning-domain error taxonomy. One `thiserror` enum with a stable
//! kebab-case `code()` — the compatibility surface ported tests assert
//! (`PORTING.md` §4). Storage failures are wrapped so the underlying
//! `state-corrupt`/fingerprint code stays reachable.

use dohc_engine_crypto::CryptoError;
use dohc_engine_storage::StorageError;

/// A typed versioning-domain failure. `#[non_exhaustive]`: later shards add
/// variants (merge/conflict/secret) without a breaking change.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum DomainError {
    /// A storage-layer failure (open, fingerprint fence, txn begin/commit, or a
    /// low-level SQL error mapped from the domain's own statements).
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),

    /// The referenced workspace has no `versioned_workspaces` row — the
    /// versioning bootstrap (`ensure_main_version`) has not run.
    #[error("versioned workspace not found")]
    WorkspaceNotFound,

    /// The referenced version id does not exist in this workspace (fails closed;
    /// history/read/restore never invent a version — `TEST_ORACLE.md` §1).
    #[error("version not found")]
    VersionNotFound,

    /// An object id resolved to a different workspace than the caller named.
    #[error("object belongs to a different workspace")]
    WorkspaceMismatch,

    /// `create_named_version` was asked for a name already taken in this
    /// workspace.
    #[error("a version with that name already exists")]
    VersionNameConflict,

    /// A caller-supplied `moment_id` is already present in this workspace
    /// (moment ids are unique per workspace; a duplicate would collide history).
    #[error("moment id already exists in this workspace")]
    DuplicateMomentId,

    /// The text payload failed validation (over the byte cap).
    #[error("invalid text: {reason}")]
    InvalidText { reason: &'static str },

    /// The path failed validation (empty, or a reserved/secret path).
    #[error("invalid path: {reason}")]
    InvalidPath { reason: &'static str },

    /// A caller-supplied value failed validation (empty identifier, bad limit).
    #[error("invalid input: {reason}")]
    InvalidInput { reason: &'static str },

    /// A retry reused an idempotency key with a *different* payload than the
    /// originally recorded request. Fails closed rather than replaying a stale
    /// result (mirrors the storage core's exactly-once guard).
    #[error("idempotency key was reused with a different payload")]
    IdempotencyKeyReuseMismatch,

    /// A durable row violated an internal invariant (e.g. a snapshot points at
    /// a missing blob). Fails closed; never auto-repairs.
    #[error("engine store is corrupt: {reason}")]
    StateCorrupt { reason: &'static str },

    /// A secret-file crypto failure (AEAD open failed — wrong key, tampered
    /// ciphertext/tag, or AAD mismatch; a malformed key; or an invalid base64
    /// field on the replication path). Fails closed; the message is content-free.
    #[error("secret crypto error: {0}")]
    Crypto(#[from] CryptoError),

    /// A secret moment id was not found (restore/get on an unknown moment).
    #[error("protected history moment not found")]
    SecretMomentNotFound,
}

impl DomainError {
    /// The stable kebab-case machine code.
    pub fn code(&self) -> &'static str {
        match self {
            DomainError::Storage(err) => err.code(),
            DomainError::WorkspaceNotFound => "workspace-not-found",
            DomainError::VersionNotFound => "version-not-found",
            DomainError::WorkspaceMismatch => "workspace-mismatch",
            DomainError::VersionNameConflict => "version-name-conflict",
            DomainError::DuplicateMomentId => "duplicate-moment-id",
            DomainError::InvalidText { .. } => "invalid-text",
            DomainError::InvalidPath { .. } => "invalid-path",
            DomainError::InvalidInput { .. } => "invalid-input",
            DomainError::IdempotencyKeyReuseMismatch => "idempotency-key-reuse-mismatch",
            DomainError::StateCorrupt { .. } => "state-corrupt",
            // Delegates to the crypto taxonomy: `decrypt-failed`, `key-corrupt`,
            // `invalid-text`, `invalid-input`, `unwrap-failed`.
            DomainError::Crypto(err) => err.code(),
            DomainError::SecretMomentNotFound => "moment-not-found",
        }
    }

    /// Wrap a low-level `rusqlite` failure as a storage `state-corrupt` (read
    /// paths) — an unexpected SQL error inside a validated store is corruption.
    pub(crate) fn sql_corrupt(err: rusqlite::Error) -> Self {
        DomainError::Storage(StorageError::corrupt_public(err))
    }

    /// Wrap a low-level `rusqlite` failure as `persist-failed` (write paths).
    pub(crate) fn sql_persist(err: rusqlite::Error) -> Self {
        DomainError::Storage(StorageError::persist_public(err))
    }
}
