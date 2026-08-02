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
    /// The share-boundary refusal that names both versions, because a
    /// recipient reading this needs to see WHICH lineage the relay offered
    /// against the one the share granted. Version ids are bounded
    /// identifiers, not content.
    #[error(
        "replicated {op_kind} is outside the share boundary: \
         the share granted version {granted}, the relay offered version {offered}"
    )]
    ShareVersionMismatch {
        /// The op kind as the boundary admitted it. Both share-view kinds
        /// reach this rule, and a `version.create` refused here reported
        /// itself as a moment — the persisted detail named an operation that
        /// never happened.
        op_kind: String,
        granted: String,
        offered: String,
    },
    /// A served op whose version id is not one the relay could have
    /// issued. A share-boundary refusal, not a generic malformed payload:
    /// dropping this field is exactly how a relay would disarm the version
    /// check, so it is refused rather than applied unchecked.
    ///
    /// The message claims NO scope. This is not the share excluding an op —
    /// the grant may well cover it — and this string is persisted as the
    /// refusal detail and shown on a notice whose copy says exactly that.
    ///
    /// The unit is UTF-16 code units, because that is what the shared rule
    /// measures (`isValidShareVersionId` reads JavaScript's `String.length`),
    /// and saying "characters" would misreport an astral id by half. The
    /// observed length is exact — the boundary holds the whole string — and is
    /// absent only when the payload carried no version id string at all.
    #[error(
        "replicated {op_kind} carries no versionId the relay could have issued: a version id is \
         non-empty, unpadded, and at most {limit} UTF-16 code units; {}",
        match .observed {
            Some(observed) => format!("the relay offered {observed} UTF-16 code units"),
            None => "the relay offered no versionId string".to_owned(),
        }
    )]
    ShareVersionUnusable {
        /// The op kind as the boundary admitted it, for the same reason the
        /// mismatch carries one.
        op_kind: String,
        limit: usize,
        observed: Option<usize>,
    },
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

/// What a share pull does with a refusal the boundary answered with.
///
/// Two lanes ask this — the share-view pull and the shared-channel pull — and
/// neither may decide for itself. A class that reaches a lane's error path
/// does not lose a count: it ABORTS the pull, the cursor never commits, and
/// the same page is fetched again forever with every valid op behind it stuck.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShareDisposition {
    /// Record the refusal, skip the op, keep the page going.
    Skip,
    /// Stop the pull. The failure is local or the response cannot be trusted.
    Abort,
}

impl SyncError {
    /// The skip-or-abort decision, stated ONCE and exhaustively.
    ///
    /// No wildcard arm on purpose. A new variant does not silently inherit
    /// "abort" and wedge a pull — it fails to compile here until its author
    /// decides which it is. That is the whole reason this is a function on the
    /// error rather than a list of classes at each lane: a list can be
    /// forgotten, and forgetting it costs the share, not the count.
    pub(crate) const fn share_disposition(&self) -> ShareDisposition {
        match self {
            // Refusals of the op: the relay served something this boundary
            // will not apply. One such op must not wedge the share.
            SyncError::InvalidInput { .. }
            | SyncError::UnsupportedOperation
            | SyncError::ShareBoundaryViolation
            | SyncError::ShareVersionMismatch { .. }
            | SyncError::ShareVersionUnusable { .. } => ShareDisposition::Skip,
            // Failures of the pull itself. Skipping past a missing blob or a
            // storage fault would report the op as refused when nothing about
            // it was wrong, and would commit the cursor past content that is
            // still coming.
            SyncError::Storage(_)
            | SyncError::SequenceGap
            | SyncError::CoordinateDiverged
            | SyncError::RetryableState { .. }
            | SyncError::BlobInvalid
            | SyncError::BlobTooLarge { .. }
            | SyncError::FaultCrash => ShareDisposition::Abort,
        }
    }

    pub const fn code(&self) -> &'static str {
        match self {
            SyncError::Storage(err) => err.code(),
            SyncError::InvalidInput { .. } => "invalid-input",
            SyncError::SequenceGap | SyncError::CoordinateDiverged => "state-corrupt",
            SyncError::RetryableState { .. } => "retryable-state",
            SyncError::UnsupportedOperation => "invalid-input",
            // The boundary class is "the share does not cover this op". The
            // recipient's copy says so and names the granter, who is the one
            // who can widen a share — so only a SCOPE decision belongs here.
            // A mismatch is one: the grant names one version and the op is on
            // another, which is outside what the share covers however it came
            // to be served.
            SyncError::ShareBoundaryViolation | SyncError::ShareVersionMismatch { .. } => {
                "share-boundary-violation"
            }
            // Not a scope decision: the relay sent a version id that is not
            // one it could have issued. The grant may well cover the update
            // and the granter can repair nothing, so this must not reach the
            // reader as "outside what this share covers — ask them".
            SyncError::ShareVersionUnusable { .. }
            | SyncError::BlobInvalid
            | SyncError::BlobTooLarge { .. } => "invalid-input",
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
