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

    /// An ordered migration failed to apply, or a previously-applied migration's
    /// recorded checksum does not match this build's definition (a tampered or
    /// incompatible ledger). The migration transaction rolled back; the store is
    /// left at its prior consistent state and never half-migrated.
    #[error("engine migration failed to apply")]
    MigrationFailed {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// A backup operation failed (copy, manifest write, or restore-test). The
    /// only valid source database is never deleted on failure; a partial backup
    /// is left un-manifested and is therefore invalid-by-absence (never counted
    /// as a valid restore point).
    #[error("engine backup failed")]
    BackupFailed {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// A destructive/space-consuming operation was refused because the target
    /// volume lacks the preflighted free space. Fails closed BEFORE touching the
    /// only valid source (`plan §Backups`: never delete the only valid source on
    /// disk-full).
    #[error("insufficient free space: need {needed} bytes, {available} available")]
    DiskFull { needed: u64, available: u64 },

    /// A filesystem operation was denied by permissions. Distinguished from
    /// corruption and transient locks so recovery does not misclassify an ACL
    /// problem as a corrupt store (`plan §Corruption behavior`).
    #[error("permission denied")]
    PermissionDenied {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// A file was transiently locked (Windows AV/indexer sharing violation, or a
    /// busy SQLite handle) and the bounded retry budget was exhausted. Distinct
    /// from corruption: the store is intact; the operation is retryable and any
    /// pending job is left for startup replay (`LANGUAGE_SEMANTICS_MATRIX` 7.7,
    /// `TEST_ORACLE` `env.sharing-violation-transient`).
    #[error("file is locked (retry budget exhausted)")]
    FileLocked,

    /// A content-addressed blob failed its integrity check on read: the stored
    /// bytes do not hash to the key they were filed under. Fails closed; never
    /// returns corrupt bytes as if valid (`plan §blobs`, integrity on read).
    #[error("blob integrity check failed for {sha256}")]
    BlobIntegrity { sha256: String },

    /// A blob exceeded [`crate::limits::MAX_BLOB_BYTES`].
    #[error("blob {actual} bytes exceeds the blob size limit")]
    BlobTooLarge { actual: usize },
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
            StorageError::MigrationFailed { .. } => "migration-failed",
            StorageError::BackupFailed { .. } => "backup-failed",
            StorageError::DiskFull { .. } => "disk-full",
            StorageError::PermissionDenied { .. } => "permission-denied",
            StorageError::FileLocked => "file-locked",
            StorageError::BlobIntegrity { .. } => "blob-integrity",
            StorageError::BlobTooLarge { .. } => "blob-too-large",
        }
    }

    /// Wrap an unexpected error as `migration-failed` with the source attached.
    ///
    /// A busy database did not fail to migrate. Every shipped migration is
    /// transactional (`MigrationKind`), so contention rolls the whole step
    /// back — body, `user_version` stamp, integrity result and ledger row
    /// together — leaving the store exactly as it was and the work still to
    /// do. `migration-failed` is what a store nobody should reopen answers;
    /// this one should simply be opened again.
    ///
    /// A retry is genuinely collected here: the open ladder in
    /// `engineWorkspaceSessions` waits and re-sends any `afterBackoff`
    /// refusal of `workspace.open`, which is the call this failure aborts.
    pub(crate) fn migration(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        if Self::is_busy(&source) {
            return StorageError::FileLocked;
        }
        StorageError::MigrationFailed {
            source: Some(Box::new(source)),
        }
    }

    /// Wrap an unexpected error as `backup-failed` with the source attached.
    ///
    /// `VACUUM INTO` meeting a busy database says nothing about the store's
    /// health, and `backup-failed` routes to the diagnostics that treat a
    /// backup failure as evidence about the store. The transient lock is
    /// classified `CorruptionKind::TransientLock` instead, which is the
    /// difference between "try again" and "this store is suspect".
    pub(crate) fn backup(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        if Self::is_busy(&source) {
            return StorageError::FileLocked;
        }
        StorageError::BackupFailed {
            source: Some(Box::new(source)),
        }
    }

    /// Classify a raw [`std::io::Error`] from a filesystem step into the
    /// recovery taxonomy (`plan §Corruption behavior`: distinguish permission,
    /// disk-full, transient lock from corruption). Anything unrecognized becomes
    /// `backup-failed`/caller-mapped rather than silently swallowed.
    pub(crate) fn classify_io(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match err.kind() {
            ErrorKind::PermissionDenied => StorageError::PermissionDenied {
                source: Some(Box::new(err)),
            },
            // `StorageFull` is nightly-only as a variant; disk-full also arrives
            // as raw OS errors, so callers preflight explicitly. Treat an
            // out-of-space raw error conservatively as backup-failed here.
            _ => StorageError::backup(err),
        }
    }

    /// Whether SQLite refused this operation because the database was BUSY,
    /// rather than because anything is wrong with it.
    ///
    /// `SQLITE_BUSY` is another connection holding a lock this one needs;
    /// `SQLITE_LOCKED` is the same conflict inside one connection. Both are
    /// raised only after `ENGINE_SQLITE_BUSY_TIMEOUT_MS` of waiting, so
    /// reaching here already means the store's own retry budget is spent —
    /// which is exactly what [`StorageError::FileLocked`] describes.
    ///
    /// Recognized HERE because this is the last boundary that still holds the
    /// typed `rusqlite::Error`. Above it the error is a boxed source and the
    /// result code is unreadable, which is why every busy database used to
    /// reach callers as `persist-failed` or `state-corrupt` — both terminal,
    /// both wrong about a condition that clears by waiting (#658).
    /// The same question for a caller holding a RAW `rusqlite::Error`.
    ///
    /// `SearchError::Storage` keeps the rusqlite failure rather than wrapping
    /// it in this taxonomy, so it never reaches the constructors below and
    /// would answer a busy index maintenance as a terminal search failure.
    pub fn is_transient_lock(error: &rusqlite::Error) -> bool {
        Self::is_busy(error)
    }

    fn is_busy(source: &(dyn std::error::Error + 'static)) -> bool {
        source
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code)
            .is_some_and(|code| {
                matches!(
                    code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                )
            })
    }

    /// Wrap an unexpected error as `state-corrupt` with the source attached —
    /// the catch-all conversion at the open/validate boundary.
    ///
    /// A busy database is not corruption, and calling it corruption is the
    /// louder of the two mistakes: it sends a transient lock to the recovery
    /// path that quarantines a store.
    pub(crate) fn corrupt(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        if Self::is_busy(&source) {
            return StorageError::FileLocked;
        }
        StorageError::StateCorrupt {
            source: Some(Box::new(source)),
        }
    }

    /// Wrap an unexpected error as `persist-failed` with the source attached.
    ///
    /// A busy database did not fail to persist; it has not tried yet.
    pub(crate) fn persist(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        if Self::is_busy(&source) {
            return StorageError::FileLocked;
        }
        StorageError::PersistFailed {
            source: Some(Box::new(source)),
        }
    }

    /// Public `state-corrupt` constructor for downstream crates that compose
    /// SQL against the [`crate::EngineStore::read_with`] seam and must map their
    /// own low-level failures into this taxonomy (the enum is
    /// `#[non_exhaustive]`, so a variant cannot be built directly off-crate).
    pub fn corrupt_public(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        StorageError::corrupt(source)
    }

    /// Public `persist-failed` constructor for downstream crates writing SQL
    /// through the [`crate::EngineStore::write_with`] seam.
    pub fn persist_public(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        StorageError::persist(source)
    }
}

#[cfg(test)]
mod tests {
    use super::StorageError;

    /// The classifier serves every SQLite-specific wrapper, not just the two
    /// on the read/write path.
    ///
    /// A busy database met during a MIGRATION was boxed as
    /// `migration-failed` — the code a store nobody should reopen answers —
    /// and during a backup as `backup-failed`, which the diagnostics read as
    /// evidence about the store's health. Both are the same transient
    /// contention and both are retryable: every shipped migration is
    /// transactional, so contention rolls the whole step back and leaves the
    /// store exactly as it was.
    ///
    /// MUTATION: drop the `is_busy` check from `migration` or from `backup`
    /// -> that wrapper reports its terminal code for a condition that clears
    /// by waiting.
    #[test]
    fn every_sqlite_wrapper_tells_a_busy_database_apart() {
        let busy = || {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(5), // SQLITE_BUSY
                Some("database is locked".to_owned()),
            )
        };
        // The two on the read/write path, which the contention test exercises
        // end to end but only through `persist`.
        assert_eq!(StorageError::persist(busy()).code(), "file-locked");
        assert_eq!(StorageError::corrupt(busy()).code(), "file-locked");
        assert_eq!(StorageError::migration(busy()).code(), "file-locked");

        let locked = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(6), // SQLITE_LOCKED
            Some("database table is locked".to_owned()),
        );
        assert_eq!(StorageError::backup(locked).code(), "file-locked");

        // Narrowness: an ordinary failure keeps its own terminal code, so the
        // recognizer cannot turn every wrapper into a retry.
        assert_eq!(
            StorageError::migration(rusqlite::Error::InvalidQuery).code(),
            "migration-failed"
        );
        assert_eq!(
            StorageError::backup(rusqlite::Error::InvalidQuery).code(),
            "backup-failed"
        );
    }
}
