//! Storage error taxonomy. One enum, `thiserror`-derived, with a `code()`
//! accessor returning a byte-identical kebab-case string — the compatibility
//! contract that ported tests assert. Messages are constant
//! and redaction-safe: no paths with user content, no document bodies, no key
//! material.

/// A typed storage failure. `#[non_exhaustive]` because capability shards add
/// variants without a breaking change; every variant maps to a stable
/// `code()` string.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StorageError {
    /// The database was stamped with a schema fingerprint this build does not
    /// recognize (the v1-vs-v2 fence). Never auto-migrated, never
    /// initialized over — the caller must export/reset.
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

    /// A write transaction failed to persist. The transaction rolled back;
    /// observable state is unchanged.
    #[error("write failed to persist")]
    PersistFailed {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// An ordered migration failed to apply, or a previously-applied migration's
    /// recorded checksum does not match this build's definition (a tampered or
    /// incompatible ledger). The migration transaction rolled back; the store is
    /// left at its prior consistent state and never half-migrated.
    #[error("engine migration failed to apply")]
    MigrationFailed {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// The store's ledger holds a migration this build does not define,
    /// completed or not, so a newer build ran it. Refused before any byte of
    /// the file changes; a build that defines every ledger migration opens it.
    #[error("a newer build ran migration {ordinal} ({id}), which this build does not define")]
    MigratedByNewerBuild { ordinal: i64, id: String },

    /// A read-only open met a store whose ledger is valid but misses some of
    /// this build's migrations, as one an older build last opened does. Only
    /// an open that migrates can read it.
    #[error("engine store has migrations this build has not applied")]
    MigrationPending,

    /// A backup operation failed (copy, manifest write, or restore-test). The
    /// only valid source database is never deleted on failure; a partial backup
    /// is left un-manifested and is therefore invalid-by-absence (never counted
    /// as a valid restore point).
    #[error("engine backup failed")]
    BackupFailed {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// The volume is out of space: a preflight found too little, which it
    /// names, or SQLite or the filesystem refused a write for lack of room.
    /// Nothing was half-written, so freeing space and retrying succeeds. The
    /// only valid source is never deleted to make room.
    #[error("the disk is full{}", shortfall_words(*.shortfall))]
    DiskFull { shortfall: Option<SpaceShortfall> },

    /// A filesystem operation was denied by permissions. Distinguished from
    /// corruption and transient locks so recovery does not misclassify an ACL
    /// problem as a corrupt store.
    #[error("permission denied")]
    PermissionDenied {
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// A file was transiently locked (Windows AV/indexer sharing violation, or a
    /// busy SQLite handle) and the bounded retry budget was exhausted. Distinct
    /// from corruption: the store is intact; the operation is retryable and any
    /// pending job is left for startup replay.
    #[error("file is locked (retry budget exhausted)")]
    FileLocked,

    /// A content-addressed blob failed its integrity check on read: the stored
    /// bytes do not hash to the key they were filed under. Fails closed; never
    /// returns corrupt bytes as if valid (integrity on read).
    #[error("blob integrity check failed for {sha256}")]
    BlobIntegrity { sha256: String },

    /// A blob exceeded [`crate::limits::MAX_BLOB_BYTES`].
    #[error("blob {actual} bytes exceeds the blob size limit")]
    BlobTooLarge { actual: usize },
}

/// The free space an operation needed and the space the volume had.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpaceShortfall {
    pub needed: u64,
    pub available: u64,
}

fn shortfall_words(shortfall: Option<SpaceShortfall>) -> String {
    shortfall.map_or_else(String::new, |SpaceShortfall { needed, available }| {
        format!(": need {needed} bytes, {available} available")
    })
}

enum Cause {
    Busy,
    Full,
    Damaged,
}

fn cause(source: &(dyn std::error::Error + 'static)) -> Option<Cause> {
    std::iter::successors(Some(source), |error| error.source()).find_map(|error| {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::StorageFull)
        {
            return Some(Cause::Full);
        }
        match error
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code)?
        {
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                Some(Cause::Busy)
            }
            rusqlite::ErrorCode::DiskFull => Some(Cause::Full),
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
                Some(Cause::Damaged)
            }
            _ => None,
        }
    })
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
            StorageError::PersistFailed { .. } => "persist-failed",
            StorageError::MigrationFailed { .. } => "migration-failed",
            StorageError::MigratedByNewerBuild { .. } => "migrated-by-newer-build",
            StorageError::MigrationPending => "migration-pending",
            StorageError::BackupFailed { .. } => "backup-failed",
            StorageError::DiskFull { .. } => "disk-full",
            StorageError::PermissionDenied { .. } => "permission-denied",
            StorageError::FileLocked => "file-locked",
            StorageError::BlobIntegrity { .. } => "blob-integrity",
            StorageError::BlobTooLarge { .. } => "blob-too-large",
        }
    }

    fn classified(
        source: impl std::error::Error + Send + Sync + 'static,
        otherwise: fn(Option<Box<dyn std::error::Error + Send + Sync>>) -> Self,
    ) -> Self {
        match cause(&source) {
            Some(Cause::Busy) => StorageError::FileLocked,
            Some(Cause::Full) => StorageError::DiskFull { shortfall: None },
            Some(Cause::Damaged) => StorageError::StateCorrupt {
                source: Some(Box::new(source)),
            },
            None => otherwise(Some(Box::new(source))),
        }
    }

    pub(crate) fn migration(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::classified(source, |source| StorageError::MigrationFailed { source })
    }

    pub(crate) fn backup(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::classified(source, |source| StorageError::BackupFailed { source })
    }

    pub(crate) fn classify_io(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::PermissionDenied {
            return StorageError::PermissionDenied {
                source: Some(Box::new(err)),
            };
        }
        StorageError::backup(err)
    }

    /// Whether SQLite refused this operation because the database was busy,
    /// for a caller that keeps the raw `rusqlite::Error`, as the search
    /// index does.
    pub fn is_transient_lock(error: &rusqlite::Error) -> bool {
        matches!(cause(error), Some(Cause::Busy))
    }

    pub(crate) fn corrupt(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::classified(source, |source| StorageError::StateCorrupt { source })
    }

    pub(crate) fn persist(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::classified(source, |source| StorageError::PersistFailed { source })
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
    use rusqlite::ffi;

    fn sqlite(code: i32) -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(ffi::Error::new(code), None)
    }

    #[test]
    fn every_wrapper_names_a_busy_database_a_full_disk_and_a_damaged_file() {
        let wrappers: [fn(rusqlite::Error) -> StorageError; 4] = [
            StorageError::persist,
            StorageError::corrupt,
            StorageError::migration,
            StorageError::backup,
        ];
        for wrap in wrappers {
            assert_eq!(wrap(sqlite(ffi::SQLITE_BUSY)).code(), "file-locked");
            assert_eq!(wrap(sqlite(ffi::SQLITE_LOCKED)).code(), "file-locked");
            assert_eq!(wrap(sqlite(ffi::SQLITE_FULL)).code(), "disk-full");
            assert_eq!(wrap(sqlite(ffi::SQLITE_CORRUPT)).code(), "state-corrupt");
            assert_eq!(wrap(sqlite(ffi::SQLITE_NOTADB)).code(), "state-corrupt");
        }
        assert_eq!(
            StorageError::classify_io(std::io::ErrorKind::StorageFull.into()).code(),
            "disk-full"
        );
        assert_eq!(
            StorageError::migration(rusqlite::Error::InvalidQuery).code(),
            "migration-failed"
        );
        assert_eq!(
            StorageError::backup(rusqlite::Error::InvalidQuery).code(),
            "backup-failed"
        );
        assert_eq!(
            StorageError::persist(sqlite(ffi::SQLITE_IOERR)).code(),
            "persist-failed"
        );
    }
}
