//! Storage error taxonomy. One enum, `thiserror`-derived, with a `code()`
//! accessor returning a byte-identical kebab-case string — the compatibility
//! contract that ported tests assert (`PORTING.md` §4). Messages are constant
//! and redaction-safe: no paths with user content, no document bodies, no key
//! material.

use crate::limits::MAX_DOCUMENT_BODY_BYTES;

/// A typed storage failure. `#[non_exhaustive]` because capability shards add
/// variants without a breaking change; every variant maps to a stable
/// `code()` string.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StorageError {
    /// The database was stamped with a schema fingerprint this build does not
    /// recognize (the v1-vs-v2 fence). Never auto-migrated, never
    /// initialized over — the caller must export/reset (`plan §Day-one Rust
    /// schema`).
    #[error("engine database schema version {found} is not supported (expected {expected})")]
    UnsupportedFingerprint { found: i64, expected: i64 },

    /// An existing file is not an empty database and is not a recognized v2
    /// store, so initialization refuses to write over it (product invariant:
    /// never auto-create an empty replacement over foreign/corrupt data).
    #[error("refusing to initialize the engine schema over a non-empty foreign database")]
    ForeignDatabase,

    /// The store is structurally corrupt: an expected table is missing, an
    /// invariant-violating row was read, or an unexpected SQLite failure
    /// occurred inside an open/validate path. Fails closed; never auto-repairs
    /// (mirror of `versionedTextStore.ts:544-550`).
    #[error("engine store is corrupt")]
    StateCorrupt {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// A caller-supplied value failed validation (empty or over-long
    /// identifier, etc.).
    #[error("invalid input: {reason}")]
    InvalidInput { reason: &'static str },

    /// The document body exceeded [`MAX_DOCUMENT_BODY_BYTES`].
    #[error("document body {actual} bytes exceeds the {MAX_DOCUMENT_BODY_BYTES}-byte limit")]
    DocumentTooLarge { actual: usize },

    /// A write transaction failed to persist. The transaction rolled back;
    /// observable state is unchanged.
    #[error("write failed to persist")]
    PersistFailed {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// A retry reused an idempotency key with a *different* payload than the
    /// originally recorded request. Replaying would either drop the new write
    /// or return a stale result, so the store fails closed instead of guessing
    /// (a same-payload retry stays exactly-once).
    #[error("idempotency key was reused with a different payload")]
    IdempotencyKeyReuseMismatch,
}

impl StorageError {
    /// The stable kebab-case machine code. This is the compatibility surface
    /// (tests assert it); the `Display` message is best-effort human text.
    pub const fn code(&self) -> &'static str {
        match self {
            StorageError::UnsupportedFingerprint { .. } => "unsupported-fingerprint",
            StorageError::ForeignDatabase => "foreign-database",
            StorageError::StateCorrupt { .. } => "state-corrupt",
            StorageError::InvalidInput { .. } => "invalid-input",
            StorageError::DocumentTooLarge { .. } => "document-too-large",
            StorageError::PersistFailed { .. } => "persist-failed",
            StorageError::IdempotencyKeyReuseMismatch => "idempotency-key-reuse-mismatch",
        }
    }

    /// Wrap an unexpected error as `state-corrupt` with the source attached —
    /// the catch-all conversion at the open/validate boundary.
    pub(crate) fn corrupt(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        StorageError::StateCorrupt {
            source: Some(Box::new(source)),
        }
    }

    /// Wrap an unexpected error as `persist-failed` with the source attached.
    pub(crate) fn persist(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        StorageError::PersistFailed {
            source: Some(Box::new(source)),
        }
    }
}
