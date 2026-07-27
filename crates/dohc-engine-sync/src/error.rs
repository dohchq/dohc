use dohc_engine_storage::StorageError;

/// Engine-side replication failure taxonomy. Messages never include payloads,
/// content, keys, or bearer credentials.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("invalid replication input: {reason}")]
    InvalidInput { reason: &'static str },
    #[error("replication sequence gap")]
    SequenceGap,
    #[error("replication coordinate contains different content")]
    CoordinateDiverged,
    #[error("replication state is not ready: {reason}")]
    RetryableState { reason: &'static str },
    #[error("operation kind is not owned by this apply surface")]
    UnsupportedOperation,
    #[error("replicated operation is outside the share boundary")]
    ShareBoundaryViolation,
    #[error("referenced blob is missing or invalid")]
    BlobInvalid,
    #[error("injected crash")]
    FaultCrash,
}

impl SyncError {
    pub const fn code(&self) -> &'static str {
        match self {
            SyncError::Storage(err) => err.code(),
            SyncError::InvalidInput { .. } => "invalid-input",
            SyncError::SequenceGap | SyncError::CoordinateDiverged => "state-corrupt",
            SyncError::RetryableState { .. } => "retryable-state",
            SyncError::UnsupportedOperation => "invalid-input",
            SyncError::ShareBoundaryViolation => "share-boundary-violation",
            SyncError::BlobInvalid => "invalid-input",
            SyncError::FaultCrash => "injected-crash",
        }
    }

    pub(crate) fn persist(err: rusqlite::Error) -> Self {
        SyncError::Storage(StorageError::persist_public(err))
    }

    pub(crate) fn corrupt(err: impl std::error::Error + Send + Sync + 'static) -> Self {
        SyncError::Storage(StorageError::corrupt_public(err))
    }
}

pub(crate) fn local_corruption(reason: &'static str) -> SyncError {
    SyncError::Storage(StorageError::corrupt_public(std::io::Error::other(reason)))
}

/// Relay transport errors preserve the TS class-per-condition contract while
/// keeping recovery detail in successful response values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RelayError {
    #[error("relay authorization failed")]
    Unauthorized,
    #[error("relay conflict")]
    Conflict,
    #[error("relay origin diverged")]
    OriginDiverged,
    #[error("relay workspace is unavailable")]
    WorkspaceUnavailable,
    #[error("relay blob is missing")]
    BlobMissing,
    #[error("share is unavailable")]
    ShareUnavailable,
    #[error("relay transport is partitioned")]
    Partitioned,
    #[error("relay response failed validation")]
    InvalidResponse,
    #[error("local sync state failed: {0}")]
    Local(String),
}
