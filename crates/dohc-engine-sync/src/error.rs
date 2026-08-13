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
    #[error(
        "Y.Doc projection exceeds {constraint}: limit {limit_bytes} bytes, observed at least {actual_bytes} bytes"
    )]
    ProjectionTooLarge {
        constraint: &'static str,
        actual_bytes: usize,
        limit_bytes: usize,
    },
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
            | SyncError::ShareVersionUnusable { .. }
            | SyncError::ProjectionTooLarge { .. } => ShareDisposition::Skip,
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
            SyncError::ProjectionTooLarge { .. } => "projection-too-large",
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

/// The refusal code for a shared blob over this recipient's content-kind
/// ceiling.
///
/// Deliberately not the generic code. This is the one replay refusal a person
/// can act on: the bytes are authentically the granter's file, so no repair at
/// the relay helps, but the granter making the file smaller and sharing it
/// again arrives as a NEW op at a later cursor. The recipient's notice reads
/// this code to say so (`apps/desktop/src/renderer/shareSkipNotice.ts`). Under
/// the generic code it told the reader nothing could be done, which is the one
/// thing that is not true here — and the cursor had already committed past the
/// file.
pub(crate) const SHARE_BLOB_OVER_CEILING_CODE: &str = "share-blob-over-ceiling";

/// What a replay refusal reports when nobody can act on it: the op describes
/// its own content wrongly, and no repair anywhere makes it replayable.
pub(crate) const GENERIC_REPLAY_REFUSAL_CODE: &str = "invalid-input";

impl RelayError {
    /// The machine code a share-view pull records when it SKIPS a served op
    /// because of this failure, or `None` when the pull must abort instead.
    ///
    /// `SyncError::share_disposition` answers this question for the boundary,
    /// which refuses an op before replay. This answers it for the REPLAY,
    /// where the failures come back from the transport.
    ///
    /// ONE question decides it: **can this op ever succeed?**
    ///
    /// - PERMANENT — no. The op will be refused identically forever, so the
    ///   cursor must move past it or the share freezes on it. Skipping loses
    ///   nothing that was ever going to arrive.
    /// - REPAIRABLE — yes, once someone fixes the thing that is wrong. The
    ///   cursor must NOT move past it: advancing would drop content that was
    ///   still coming, and nothing would bring it back.
    /// - PENDING — yes, once the sender finishes. `BlobMissing`. Same
    ///   disposition as repairable, named apart because the fix is a normal
    ///   step rather than a failure.
    ///
    /// Only the permanent class is skipped. That is what keeps this change
    /// from trading a frozen share for silently dropped data: an op the
    /// recipient could still receive is never advanced past.
    ///
    /// The code travels with the decision instead of coming from a total
    /// `RelayError::code`. `map_relay_code` in the runtime crate already owns
    /// the wire code for every relay failure, and a second total mapping here
    /// would be a second naming authority for the same thing.
    ///
    /// No wildcard arm, for the reason the boundary's twin has none: a new
    /// variant must answer the question rather than inherit an answer.
    pub(crate) const fn share_replay_refusal_code(&self) -> Option<&'static str> {
        match self {
            // PERMANENT. These bytes hashed to the sha the op named, so they
            // ARE the granter's file, and it is over a ceiling this recipient
            // enforces on every ingest. Asking again returns the same file and
            // the same refusal, forever.
            //
            // Advancing is not merely safe here, it is REQUIRED for the only
            // repair there is. A granter who re-shares the file under the
            // ceiling produces a NEW op at a LATER cursor. Holding the cursor
            // on the oversized op would keep that replacement from ever
            // arriving — the repair would be unreachable by construction.
            //
            // It is also the one permanent class with a person who can act, so
            // it carries its own code rather than the generic one.
            RelayError::ShareBlobOverCeiling { .. } => Some(SHARE_BLOB_OVER_CEILING_CODE),
            // PERMANENT. The op describes its own content wrongly, or names a
            // path this recipient's store door will never accept. No blob the
            // relay could serve makes either replayable, and nobody can repair
            // it, so it keeps the generic code.
            RelayError::ShareOpInvalid { .. } => Some(GENERIC_REPLAY_REFUSAL_CODE),
            // REPAIRABLE. The relay served a body that is not the one this op
            // named. The op is fine; the relay's copy is wrong. Fix the blob
            // and this same op applies — so the cursor must not pass it. This
            // is `BlobMissing`'s claim in a different tense.
            RelayError::BlobInvalid
            // REPAIRABLE for the same reason, and easy to mistake for the
            // permanent class above. This is raised on bytes NOBODY has
            // authenticated: a transport that stopped at its own read bound
            // (`blob_body_overflow`, which cannot even report an exact size),
            // or an oversized body served for the wrong blob. The op may name
            // a perfectly small file, so skipping past it would drop content
            // the relay can still serve correctly.
            | RelayError::BlobTooLarge { .. }
            // PENDING, and the reason to keep reading: the relay does not have
            // the blob YET and the sender can still upload it.
            | RelayError::BlobMissing
            | RelayError::BlobReferenceMissing
            | RelayError::Unauthorized
            | RelayError::BadRequest
            | RelayError::Conflict
            | RelayError::OriginDiverged
            | RelayError::NoProgress
            | RelayError::WorkspaceUnavailable
            | RelayError::KeyEnvelopeMissing
            | RelayError::ShareUnavailable
            | RelayError::EpochSuperseded
            | RelayError::IdentityNotRecognized
            | RelayError::IdentityRequired
            | RelayError::StreamIdentityMismatch
            | RelayError::AuthorshipMismatch
            | RelayError::UnknownChatOperation
            | RelayError::ShareReadOnly
            | RelayError::ShareOperationRejected
            | RelayError::PayloadTooLarge
            | RelayError::PresenceCapacity
            | RelayError::QuotaExceeded
            | RelayError::SelfShare
            | RelayError::AmbiguousSelector
            | RelayError::InvalidChannel
            | RelayError::MethodNotAllowed
            | RelayError::Forbidden
            | RelayError::ServerInternal
            | RelayError::UnknownServerCode(_)
            | RelayError::HttpStatus(_)
            | RelayError::Partitioned
            | RelayError::InvalidResponse
            // TRANSIENT, and therefore never skipped: the op says nothing
            // wrong, the store was simply busy. Advancing the cursor past it
            // would drop content the next pull would have applied.
            | RelayError::StoreBusy
            | RelayError::Local(_) => None,
        }
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
    /// The granter's file, AUTHENTICATED against the sha256 its op named, is
    /// larger than the ceiling this recipient enforces for that content kind.
    ///
    /// Deliberately not `BlobTooLarge`. That one is raised on bytes nobody has
    /// checked — a transport that stopped at its own read bound, or a body the
    /// relay served for the wrong blob — so it says nothing about the file the
    /// op actually names, and the op may well succeed once the relay serves
    /// the right body. This one is measured on bytes already proven to be the
    /// granter's, so no repair anywhere makes them fit.
    #[error(
        "shared blob exceeds {constraint}: limit {limit_bytes} bytes, observed {observed_bytes} bytes"
    )]
    ShareBlobOverCeiling {
        constraint: &'static str,
        limit_bytes: usize,
        observed_bytes: usize,
    },
    /// A served share op this recipient can never replay: a blob reference
    /// that is not a sha256, a body that is authentically the one the op
    /// named and still not the kind the op claimed, or a path the store door
    /// refuses.
    ///
    /// Deliberately NOT `BlobInvalid`. That one means the relay served a body
    /// which is not the one the op asked for — repairable at the relay, and
    /// the same op succeeds once it is. This one means the op itself is
    /// unusable, so no repair anywhere makes it replayable. The two classes
    /// were one variant, and one variant cannot hold two dispositions.
    #[error("share op is not replayable: {reason}")]
    ShareOpInvalid { reason: &'static str },
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
    /// The engine's own database was busy while a relay operation used it.
    ///
    /// Typed rather than folded into `Local`, which carries a code STRING: the
    /// busy store's one answer is decided on the storage variant everywhere
    /// else (`store_busy` in the workspace-engine crate), and a route that
    /// re-derived it from `Local("file-locked")` would be reading a code that
    /// two different conditions produce. Keeping it typed is what makes the
    /// relay route give the same answer as every other route (#658).
    #[error("engine store is busy")]
    StoreBusy,
    #[error("local sync state failed: {0}")]
    Local(String),
}
