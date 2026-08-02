use dohc_engine_storage::StorageError;

/// How much of an oversized blob the refusing layer actually measured. Ingest
/// holds the whole body and reports an exact size. A transport that stops
/// reading at its own bound never learns the full size, and reports the floor
/// it proved rather than inventing a total.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservedBytes {
    Exact(usize),
    AtLeast(usize),
}

impl std::fmt::Display for ObservedBytes {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObservedBytes::Exact(bytes) => write!(formatter, "{bytes} bytes"),
            ObservedBytes::AtLeast(bytes) => write!(formatter, "at least {bytes} bytes"),
        }
    }
}

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
    #[error(
        "blob exceeds {constraint}: limit {limit_bytes} bytes, observed {observed_bytes} bytes"
    )]
    BlobTooLarge {
        constraint: &'static str,
        limit_bytes: usize,
        observed_bytes: usize,
    },
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
            SyncError::BlobInvalid | SyncError::BlobTooLarge { .. } => "invalid-input",
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
    #[error("relay request was malformed")]
    BadRequest,
    #[error("relay conflict")]
    Conflict,
    #[error("relay origin diverged")]
    OriginDiverged,
    #[error("relay pagination made no progress")]
    NoProgress,
    #[error("relay workspace is unavailable")]
    WorkspaceUnavailable,
    #[error("relay blob is missing")]
    BlobMissing,
    #[error("relay log references a missing blob")]
    BlobReferenceMissing,
    #[error("relay blob content failed integrity validation")]
    BlobInvalid,
    #[error("relay blob exceeds {constraint}: limit {limit_bytes} bytes, observed {observed}")]
    BlobTooLarge {
        constraint: &'static str,
        limit_bytes: usize,
        observed: ObservedBytes,
    },
    #[error("relay key envelope is missing")]
    KeyEnvelopeMissing,
    #[error("share is unavailable")]
    ShareUnavailable,
    #[error("replication epoch was superseded")]
    EpochSuperseded,
    #[error("replication identity is not recognized")]
    IdentityNotRecognized,
    #[error("replication identity is required")]
    IdentityRequired,
    #[error("replication stream identity does not match")]
    StreamIdentityMismatch,
    #[error("relay authorship check failed")]
    AuthorshipMismatch,
    #[error("relay cannot verify this chat operation")]
    UnknownChatOperation,
    #[error("share is read-only")]
    ShareReadOnly,
    #[error("operation is outside the shared channel")]
    ShareOperationRejected,
    #[error("relay payload is too large")]
    PayloadTooLarge,
    #[error("relay presence capacity was exceeded")]
    PresenceCapacity,
    #[error("relay quota was exceeded")]
    QuotaExceeded,
    #[error("self-sharing is not allowed")]
    SelfShare,
    #[error("share selector is ambiguous")]
    AmbiguousSelector,
    #[error("share channel is invalid")]
    InvalidChannel,
    #[error("relay method is not allowed")]
    MethodNotAllowed,
    #[error("relay forbids this request")]
    Forbidden,
    #[error("relay returned an internal error")]
    ServerInternal,
    #[error("relay returned unknown error code {0}")]
    UnknownServerCode(String),
    #[error("relay returned HTTP status {0}")]
    HttpStatus(u16),
    #[error("relay transport is partitioned")]
    Partitioned,
    #[error("relay response failed validation")]
    InvalidResponse,
    #[error("local sync state failed: {0}")]
    Local(String),
}
