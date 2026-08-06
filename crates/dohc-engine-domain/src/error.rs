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

    /// A secret-surface version reference is invalid. This is distinct from
    /// the text domain's `VersionNotFound` compatibility code.
    #[error("secret version reference is invalid")]
    InvalidVersion,

    /// An object id resolved to a different workspace than the caller named.
    #[error("object belongs to a different workspace")]
    WorkspaceMismatch,

    /// `create_named_version` was asked for a name already taken in this
    /// workspace.
    #[error("a version with that name already exists")]
    VersionNameConflict,

    /// A named version must be non-empty and have no surrounding whitespace.
    #[error("version name is invalid")]
    InvalidVersionName,

    /// A generated/caller-supplied durable id already exists.
    #[error("generated id already exists")]
    DuplicateId,

    /// A caller-supplied `moment_id` is already present in this workspace
    /// (moment ids are unique per workspace; a duplicate would collide history).
    #[error("moment id already exists in this workspace")]
    DuplicateMomentId,

    /// The requested text path (or rollback mutation at that path) does not
    /// exist in the named version.
    #[error("text file not found")]
    FileNotFound,

    /// The path resolves to a live BINARY head, so a text-only read surface
    /// must not serve it. Fails closed rather than projecting the binary head as
    /// an empty text document (which would invite a silent overwrite). Distinct
    /// from `FileNotFound` — the head exists, it just is not text.
    #[error("content at path is a binary head, not text")]
    BinaryHeadNotText,
    /// A binary read hit a TEXT head — the caller asked the wrong question.
    #[error("content at path is a text head, not binary")]
    TextHeadNotBinary,

    /// The path current head was not written by capture, so a disk-driven
    /// capture write must not overwrite or retire it (it may legitimately
    /// have no disk counterpart). A settled refusal, never a retry.
    #[error("capture does not own this path current head")]
    CaptureNotOwned,

    /// A rename/rollback restore path is already occupied by another object.
    #[error("target path already exists")]
    TargetPathExists,

    /// The source version is not a named fork of the target, or its durable
    /// fork-base snapshot set is missing.
    #[error("durable fork base not found")]
    ForkBaseNotFound,

    /// The requested conflict row does not exist in this workspace.
    #[error("text conflict not found")]
    ConflictNotFound,

    /// The live target no longer exactly matches the conflict's recorded head.
    #[error("text conflict target is stale")]
    ConflictStaleTarget,

    /// The text payload failed validation (over the byte cap).
    #[error("invalid text: {reason}")]
    InvalidText { reason: &'static str },

    /// A payload exceeded a measured byte ceiling. Carries the constraint,
    /// the configured limit, and the observed usage, so the refusal names
    /// what an agent needs in order to adapt (AGENTS.md: show agents the
    /// limits they hit).
    #[error(
        "payload exceeds {constraint}: limit {limit_bytes} bytes, observed {observed_bytes} bytes"
    )]
    PayloadTooLarge {
        constraint: &'static str,
        limit_bytes: usize,
        observed_bytes: usize,
    },

    /// The path failed validation (empty, or a reserved/secret path).
    #[error("invalid path: {reason}")]
    InvalidPath { reason: &'static str },

    /// A caller routed an ordinary/ignored path into the encrypted secret
    /// store. The floor is fail-closed in both directions: plaintext storage
    /// rejects secret paths, and secret storage rejects every non-secret path.
    #[error("path is not secret-classified")]
    NotSecretPath,

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

    /// A chat-domain failure carrying the TS `LinkedChatStoreError` stable code
    /// verbatim (`linkedChatStore.ts`). One variant keeps the large chat
    /// code-space (`invalid-channel-name`, `channel-exists`, `message-not-found`,
    /// `read-state-revision-mismatch`, `invalid-follow-target`,
    /// `invalid-bookmark-target`, …) on the compatibility surface without a
    /// per-code enum explosion; `code()` returns the embedded string so ported
    /// tests that switch on `.code` stay byte-identical.
    #[error("chat error [{code}]: {reason}")]
    Chat {
        code: &'static str,
        reason: &'static str,
    },
}

impl DomainError {
    /// The stable kebab-case machine code.
    pub fn code(&self) -> &'static str {
        match self {
            DomainError::Storage(err) => err.code(),
            DomainError::WorkspaceNotFound => "workspace-not-found",
            DomainError::VersionNotFound => "version-not-found",
            DomainError::InvalidVersion => "invalid-version",
            DomainError::WorkspaceMismatch => "workspace-mismatch",
            DomainError::VersionNameConflict => "version-name-conflict",
            DomainError::InvalidVersionName => "invalid-version-name",
            DomainError::DuplicateId => "duplicate-id",
            DomainError::DuplicateMomentId => "duplicate-moment-id",
            DomainError::FileNotFound => "file-not-found",
            DomainError::BinaryHeadNotText => "binary-head-not-text",
            DomainError::TextHeadNotBinary => "text-head-not-binary",
            DomainError::CaptureNotOwned => "capture-not-owned",
            DomainError::TargetPathExists => "target-path-exists",
            DomainError::ForkBaseNotFound => "fork-base-not-found",
            DomainError::ConflictNotFound => "conflict-not-found",
            DomainError::ConflictStaleTarget => "conflict-stale-target",
            DomainError::InvalidText { .. } => "invalid-text",
            DomainError::PayloadTooLarge { .. } => "payload-too-large",
            DomainError::InvalidPath { .. } => "invalid-path",
            DomainError::NotSecretPath => "not-secret-path",
            DomainError::InvalidInput { .. } => "invalid-input",
            DomainError::IdempotencyKeyReuseMismatch => "idempotency-key-reuse-mismatch",
            DomainError::StateCorrupt { .. } => "state-corrupt",
            // Delegates to the crypto taxonomy: `decrypt-failed`, `key-corrupt`,
            // `invalid-text`, `invalid-input`, `unwrap-failed`.
            DomainError::Crypto(err) => err.code(),
            DomainError::SecretMomentNotFound => "moment-not-found",
            DomainError::Chat { code, .. } => code,
        }
    }

    /// Construct a chat-domain error with a TS-parity stable code.
    pub(crate) fn chat(code: &'static str, reason: &'static str) -> Self {
        DomainError::Chat { code, reason }
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
