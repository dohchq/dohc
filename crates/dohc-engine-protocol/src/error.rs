//! Error taxonomy: stable machine error codes with a retryability
//! classification, plus the typed decode/limit errors returned for
//! malformed or oversized input (never panics).

use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable machine error codes. The wire form is the SCREAMING_SNAKE string;
/// codes are append-only once the protocol freezes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// The `hello` auth token did not match the parent-issued token.
    AuthFailed,
    /// The peer speaks a protocol version outside our supported range.
    ProtocolVersionUnsupported,
    /// A frame violated the framing layer (bad magic, unknown type, bad
    /// flags, or a size bound).
    MalformedFrame,
    /// A well-framed envelope violated a wire bound (string, collection,
    /// batch, depth, or integer range).
    LimitExceeded,
    /// A control frame did not decode into a known envelope.
    InvalidEnvelope,
    /// The request method is not known to this engine build.
    MethodNotFound,
    /// The request params failed method-level validation.
    InvalidParams,
    /// The request deadline elapsed before the engine finished.
    DeadlineExceeded,
    /// The request was cancelled by the client or by session teardown.
    Cancelled,
    /// Bounded queues are full; explicit backpressure.
    Overloaded,
    /// The session generation is no longer valid (engine restarted).
    SessionExpired,
    /// The workspace handle does not refer to an open workspace.
    WorkspaceUnavailable,
    /// A relay compare-and-swap precondition failed.
    Conflict,
    /// The relay has a different operation at a locally-owned coordinate.
    OriginDiverged,
    /// The requested share no longer exists or is no longer available.
    ShareUnavailable,
    /// The workspace has no enrolled key envelope.
    KeyEnvelopeMissing,
    /// A newer replication epoch replaced the caller's epoch.
    EpochSuperseded,
    /// The relay does not recognize the caller's replication identity.
    IdentityNotRecognized,
    /// The relay refused an authenticated caller's operation.
    Forbidden,
    /// The share does not permit writes.
    ShareReadOnly,
    /// The operation falls outside the granted share selector.
    ShareOperationRejected,
    /// The request exceeded the relay's payload limit.
    PayloadTooLarge,
    /// The request exceeded the relay's storage or usage quota.
    QuotaExceeded,
    /// Relay pagination claimed more data without advancing.
    RelayNoProgress,
    /// A referenced relay blob does not exist.
    BlobMissing,
    /// A relay log row references a blob that is unavailable.
    BlobReferenceMissing,
    /// Relay blob bytes failed integrity validation.
    BlobInvalid,
    /// The operation requires a replication identity.
    IdentityRequired,
    /// The caller's stream identity does not match the workspace.
    StreamIdentityMismatch,
    /// The relay rejected the claimed operation author.
    AuthorshipMismatch,
    /// The relay cannot safely classify the chat operation.
    UnknownChatOperation,
    /// Relay presence capacity is exhausted.
    PresenceCapacity,
    /// A user attempted to share a workspace with themselves.
    SelfShare,
    /// A share selector resolves ambiguously.
    AmbiguousSelector,
    /// A shared channel selector is invalid.
    InvalidChannel,
    /// The relay endpoint does not permit this HTTP method.
    RelayMethodNotAllowed,
    /// The relay returned a response that violated its wire contract.
    RelayInvalidResponse,
    /// Internal engine failure; details in redacted diagnostics only.
    Internal,
}

impl ErrorCode {
    /// Stable string form (identical to the wire form).
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorCode::AuthFailed => "AUTH_FAILED",
            ErrorCode::ProtocolVersionUnsupported => "PROTOCOL_VERSION_UNSUPPORTED",
            ErrorCode::MalformedFrame => "MALFORMED_FRAME",
            ErrorCode::LimitExceeded => "LIMIT_EXCEEDED",
            ErrorCode::InvalidEnvelope => "INVALID_ENVELOPE",
            ErrorCode::MethodNotFound => "METHOD_NOT_FOUND",
            ErrorCode::InvalidParams => "INVALID_PARAMS",
            ErrorCode::DeadlineExceeded => "DEADLINE_EXCEEDED",
            ErrorCode::Cancelled => "CANCELLED",
            ErrorCode::Overloaded => "OVERLOADED",
            ErrorCode::SessionExpired => "SESSION_EXPIRED",
            ErrorCode::WorkspaceUnavailable => "WORKSPACE_UNAVAILABLE",
            ErrorCode::Conflict => "CONFLICT",
            ErrorCode::OriginDiverged => "ORIGIN_DIVERGED",
            ErrorCode::ShareUnavailable => "SHARE_UNAVAILABLE",
            ErrorCode::KeyEnvelopeMissing => "KEY_ENVELOPE_MISSING",
            ErrorCode::EpochSuperseded => "EPOCH_SUPERSEDED",
            ErrorCode::IdentityNotRecognized => "IDENTITY_NOT_RECOGNIZED",
            ErrorCode::Forbidden => "FORBIDDEN",
            ErrorCode::ShareReadOnly => "SHARE_READ_ONLY",
            ErrorCode::ShareOperationRejected => "SHARE_OPERATION_REJECTED",
            ErrorCode::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            ErrorCode::QuotaExceeded => "QUOTA_EXCEEDED",
            ErrorCode::RelayNoProgress => "RELAY_NO_PROGRESS",
            ErrorCode::BlobMissing => "BLOB_MISSING",
            ErrorCode::BlobReferenceMissing => "BLOB_REFERENCE_MISSING",
            ErrorCode::BlobInvalid => "BLOB_INVALID",
            ErrorCode::IdentityRequired => "IDENTITY_REQUIRED",
            ErrorCode::StreamIdentityMismatch => "STREAM_IDENTITY_MISMATCH",
            ErrorCode::AuthorshipMismatch => "AUTHORSHIP_MISMATCH",
            ErrorCode::UnknownChatOperation => "UNKNOWN_CHAT_OPERATION",
            ErrorCode::PresenceCapacity => "PRESENCE_CAPACITY",
            ErrorCode::SelfShare => "SELF_SHARE",
            ErrorCode::AmbiguousSelector => "AMBIGUOUS_SELECTOR",
            ErrorCode::InvalidChannel => "INVALID_CHANNEL",
            ErrorCode::RelayMethodNotAllowed => "RELAY_METHOD_NOT_ALLOWED",
            ErrorCode::RelayInvalidResponse => "RELAY_INVALID_RESPONSE",
            ErrorCode::Internal => "INTERNAL",
        }
    }

    /// Default retryability classification for this code. A response may
    /// override it (e.g. `INTERNAL` after a definitely-not-committed write
    /// can be `afterBackoff`), but the default is what generated clients use.
    pub const fn default_retryability(self) -> Retryability {
        match self {
            ErrorCode::AuthFailed
            | ErrorCode::ProtocolVersionUnsupported
            | ErrorCode::MalformedFrame
            | ErrorCode::LimitExceeded
            | ErrorCode::InvalidEnvelope
            | ErrorCode::MethodNotFound
            | ErrorCode::InvalidParams
            | ErrorCode::Conflict
            | ErrorCode::OriginDiverged
            | ErrorCode::ShareUnavailable
            | ErrorCode::KeyEnvelopeMissing
            | ErrorCode::EpochSuperseded
            | ErrorCode::IdentityNotRecognized
            | ErrorCode::Forbidden
            | ErrorCode::ShareReadOnly
            | ErrorCode::ShareOperationRejected
            | ErrorCode::PayloadTooLarge
            | ErrorCode::QuotaExceeded
            | ErrorCode::RelayNoProgress
            | ErrorCode::BlobMissing
            | ErrorCode::BlobReferenceMissing
            | ErrorCode::BlobInvalid
            | ErrorCode::IdentityRequired
            | ErrorCode::StreamIdentityMismatch
            | ErrorCode::AuthorshipMismatch
            | ErrorCode::UnknownChatOperation
            | ErrorCode::PresenceCapacity
            | ErrorCode::SelfShare
            | ErrorCode::AmbiguousSelector
            | ErrorCode::InvalidChannel
            | ErrorCode::RelayMethodNotAllowed
            | ErrorCode::RelayInvalidResponse
            | ErrorCode::Cancelled => Retryability::No,
            // Safe to retry only because retryable mutations carry
            // idempotency keys; the engine deduplicates on replay.
            ErrorCode::DeadlineExceeded => Retryability::AfterBackoff,
            ErrorCode::Overloaded => Retryability::AfterBackoff,
            ErrorCode::SessionExpired | ErrorCode::WorkspaceUnavailable => {
                Retryability::AfterReconnect
            }
            ErrorCode::Internal => Retryability::No,
        }
    }
}

/// How a generated client may retry a failed request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub enum Retryability {
    /// Do not retry.
    No,
    /// Retry immediately (same session).
    Immediate,
    /// Retry with backoff (same session); pair with an idempotency key.
    AfterBackoff,
    /// Re-handshake (new session generation, re-open handles), then retry.
    AfterReconnect,
}

/// The wire error payload carried by an `error` envelope.
///
/// `message` must be redaction-safe: no paths, no document content, no
/// secrets, no tokens. Construct via [`WireError::new`] and keep messages to
/// static, code-like descriptions; anything dynamic belongs in structured
/// redacted diagnostics, not here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct WireError {
    pub code: ErrorCode,
    pub message: String,
    pub retry: Retryability,
}

impl WireError {
    /// Build an error with the code's default retryability.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        WireError {
            code,
            message: message.into(),
            retry: code.default_retryability(),
        }
    }
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for WireError {}

/// Which bound a value violated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitKind {
    FrameBytes,
    BlobChunkBytes,
    StringBytes,
    CollectionLen,
    BatchLen,
    JsonDepth,
    IntegerRange,
}

/// A typed bound violation: which limit, on which field, actual vs max.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitViolation {
    pub limit: LimitKind,
    pub field: &'static str,
    pub actual: u64,
    pub max: u64,
}

impl fmt::Display for LimitViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:?} exceeded on {}: {} > {}",
            self.limit, self.field, self.actual, self.max
        )
    }
}

impl std::error::Error for LimitViolation {}

/// Typed failure at the framing layer. Any of these is fatal for the
/// connection (framing has no resynchronization points).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameDecodeError {
    /// Header bytes present but not sliceable (unreachable in practice;
    /// kept so parsing never needs a panic path).
    TruncatedHeader,
    /// First four bytes were not `b"DOP1"`.
    BadMagic([u8; 4]),
    /// Frame type byte is not a known frame type.
    UnknownFrameType(u8),
    /// Flag bits set that this frame type does not define.
    UnsupportedFlags { frame_type: u8, flags: u8 },
    /// Reserved header bytes were non-zero.
    NonZeroReserved,
    /// Control payload length exceeds `max_frame_bytes`.
    ControlFrameTooLarge { len: u32, max: u32 },
    /// Blob chunk payload shorter than its stream-id prefix.
    BlobChunkMissingStreamId { len: u32 },
    /// Blob chunk bytes exceed `max_blob_chunk_bytes`.
    BlobChunkTooLarge { len: u32, max: u32 },
    /// Blob chunk stream id exceeds the JS-safe wire-integer bound
    /// (`MAX_WIRE_INTEGER`), so it could never match a `blobStart.streamId`.
    BlobStreamIdTooLarge { stream_id: u64 },
}

impl fmt::Display for FrameDecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameDecodeError::TruncatedHeader => write!(f, "truncated frame header"),
            FrameDecodeError::BadMagic(magic) => write!(f, "bad frame magic {magic:02x?}"),
            FrameDecodeError::UnknownFrameType(kind) => write!(f, "unknown frame type {kind}"),
            FrameDecodeError::UnsupportedFlags { frame_type, flags } => {
                write!(
                    f,
                    "unsupported flags {flags:#010b} for frame type {frame_type}"
                )
            }
            FrameDecodeError::NonZeroReserved => write!(f, "non-zero reserved header bytes"),
            FrameDecodeError::ControlFrameTooLarge { len, max } => {
                write!(f, "control frame payload {len} exceeds max {max}")
            }
            FrameDecodeError::BlobChunkMissingStreamId { len } => {
                write!(f, "blob chunk payload {len} shorter than stream id")
            }
            FrameDecodeError::BlobChunkTooLarge { len, max } => {
                write!(f, "blob chunk payload {len} exceeds max {max}")
            }
            FrameDecodeError::BlobStreamIdTooLarge { stream_id } => {
                write!(
                    f,
                    "blob chunk stream id {stream_id} exceeds the wire-integer bound"
                )
            }
        }
    }
}

impl std::error::Error for FrameDecodeError {}

/// Typed failure decoding a control-frame payload into an [`crate::Envelope`].
#[derive(Debug, Clone, PartialEq)]
pub enum EnvelopeDecodeError {
    /// Not valid JSON / not a known envelope shape. Carries only the parser
    /// position, never input content (redaction-safe).
    Json { line: usize, column: usize },
    /// Well-formed JSON that violates a wire bound.
    Limit(LimitViolation),
}

impl fmt::Display for EnvelopeDecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnvelopeDecodeError::Json { line, column } => {
                write!(f, "invalid envelope JSON at {line}:{column}")
            }
            EnvelopeDecodeError::Limit(violation) => violation.fmt(f),
        }
    }
}

impl std::error::Error for EnvelopeDecodeError {}

impl From<LimitViolation> for EnvelopeDecodeError {
    fn from(violation: LimitViolation) -> Self {
        EnvelopeDecodeError::Limit(violation)
    }
}
