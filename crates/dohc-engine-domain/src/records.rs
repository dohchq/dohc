//! Domain records and operation inputs for the versioning slice.
//!
//! Identity discipline: a [`VersionRecord`] is a named line of history; a
//! [`SnapshotView`]/[`TextSnapshot`]/[`MomentRecord`] carries a STABLE
//! `object_id` that is the
//! durable identity, and a `path` that is only an alias onto it (plan §Target
//! architecture). Ids that carry identity (`version_id`, `object_id`,
//! `moment_id`) are caller-supplied so operation traces are deterministic
//! (`plan §Behavioral oracle and determinism`).

use crate::error::DomainError;

/// Whether a version is the workspace's bootstrap `main` line or a named fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionKind {
    Main,
    Named,
}

impl VersionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            VersionKind::Main => "main",
            VersionKind::Named => "named",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, DomainError> {
        match value {
            "main" => Ok(VersionKind::Main),
            "named" => Ok(VersionKind::Named),
            _ => Err(DomainError::StateCorrupt {
                reason: "unknown version kind",
            }),
        }
    }
}

/// The kind of mutation a moment records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MomentOp {
    Write,
    Delete,
    Rename,
}

impl MomentOp {
    pub const fn as_str(self) -> &'static str {
        match self {
            MomentOp::Write => "write",
            MomentOp::Delete => "delete",
            MomentOp::Rename => "rename",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, DomainError> {
        match value {
            "write" => Ok(MomentOp::Write),
            "delete" => Ok(MomentOp::Delete),
            "rename" => Ok(MomentOp::Rename),
            _ => Err(DomainError::StateCorrupt {
                reason: "unknown moment operation",
            }),
        }
    }
}

/// A version row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRecord {
    pub workspace_id: String,
    pub version_id: String,
    pub kind: VersionKind,
    pub name: String,
    pub created_at_ms: i64,
    pub fork_version_id: Option<String>,
    pub fork_moment_id: Option<String>,
}

/// The materialized current state of a text object within a version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextSnapshot {
    pub workspace_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub text: String,
    pub blob_sha256: String,
    pub updated_at_ms: i64,
    pub latest_moment_id: String,
    pub metadata_origin: String,
}

/// The content exposed by a snapshot display view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotContent {
    Text { text: String },
    Binary { sha256: String },
}

/// One snapshot's METADATA — everything a listing needs, with no body
/// hydration (text is sized in SQL, never copied out).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotMetadata {
    pub object_id: String,
    pub path: String,
    /// Byte length of a TEXT head; None for binary heads (their length
    /// comes with `versionedBinary.read`'s metadata).
    pub text_byte_length: Option<i64>,
    pub updated_at_ms: i64,
    pub latest_moment_id: String,
    pub metadata_origin: String,
    /// "text" | "binary" (the stored discriminant).
    pub content_kind: String,
    pub binary_sha256: Option<String>,
}

/// The materialized current state of an object within a version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotView {
    pub workspace_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub content: SnapshotContent,
    pub updated_at_ms: i64,
    pub latest_moment_id: String,
    pub metadata_origin: String,
}

/// The durable snapshot head for either text or binary content.
///
/// `TextSnapshot` remains the compatibility view exposed by the text APIs;
/// storage and conflict paths use this record so a binary head is never
/// mistaken for an absent text snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SnapshotRecord {
    pub workspace_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub text: String,
    pub blob_sha256: Option<String>,
    pub content_kind: String,
    pub binary_sha256: Option<String>,
    pub updated_at_ms: i64,
    pub latest_moment_id: String,
    pub metadata_origin: String,
}

/// The binary head at a path: identity plus the blob bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryHead {
    pub object_id: String,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

/// A binary head's metadata without its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryHeadMeta {
    pub object_id: String,
    pub sha256: String,
    pub byte_length: i64,
}

/// Stable file-object identity, independent of any version-local path alias.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileObjectRecord {
    pub workspace_id: String,
    pub object_id: String,
    pub created_at_ms: i64,
}

/// A history moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MomentRecord {
    pub moment_order: i64,
    pub moment_id: String,
    pub version_id: String,
    pub object_id: String,
    pub path: String,
    pub recorded_at_ms: i64,
    pub operation: MomentOp,
    pub after_content_kind: String,
    pub after_blob_sha256: Option<String>,
    pub after_binary_sha256: Option<String>,
    /// `true` when a concrete rollback preimage was recorded. This represents
    /// TS `before_present = 2`; `false` covers both no preimage and legacy-unset.
    pub before_present: bool,
    pub before_blob_sha256: Option<String>,
    pub before_content_kind: String,
    pub before_binary_sha256: Option<String>,
    /// The moment that produced the concrete `before` snapshot, or `None` when
    /// this mutation had no preimage (a first write / legacy row).
    pub before_latest_moment_id: Option<String>,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    /// A non-NULL marker in the DB → a peer-divergence record, excluded from
    /// 'latest moment' fork-point selection (`PORTING.md` §1). `false` = a
    /// materialized moment.
    pub sync_record_only: bool,
    /// HYDRATED payload fields (TS `momentSelectSql` parity): the after/
    /// before TEXT bodies (None for binary, absent, or OVER-CAP sides —
    /// bodies above the 48 KiB in-band cap are never loaded out of SQL;
    /// the byte lengths always are) and the COALESCEd text/binary byte
    /// lengths. The oracle's richer
    /// payload-provenance columns (payload_before_*, before-snapshot
    /// identity fields) are NOT in the Rust schema — a recorded pre-R15
    /// schema obligation.
    pub after_text: Option<String>,
    pub after_byte_length: Option<i64>,
    pub before_text: Option<String>,
    pub before_byte_length: Option<i64>,
}

/// A keyset page of moments (newest first). Mirrors the inventory contract for
/// `versions-list-moments`: a `limit + 1` probe drives `next_before_moment_order`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MomentPage {
    pub moments: Vec<MomentRecord>,
    /// The cursor to pass as `before_moment_order` for the next page, or `None`
    /// when this page is the last.
    pub next_before_moment_order: Option<i64>,
    /// The highest `moment_order` under the same filter (ignoring the cursor),
    /// or `None` when no moment matches.
    pub latest_moment_order: Option<i64>,
}

/// Inputs to [`crate::VersionedTextStore::list_moments`].
#[derive(Debug, Clone)]
pub struct ListMomentsQuery {
    pub workspace_id: String,
    pub version_id: Option<String>,
    pub object_id: Option<String>,
    /// Page size (`> 0`). The store probes `limit + 1` to detect a next page.
    pub limit: i64,
    /// Exclusive upper bound on `moment_order` (the previous page's cursor).
    pub before_moment_order: Option<i64>,
}

/// Inputs to [`crate::VersionedTextStore::write_text`].
#[derive(Debug, Clone)]
pub struct WriteText {
    pub workspace_id: String,
    pub version_id: String,
    /// The object id to mint if `path` is not yet aliased in this version; when
    /// the path already resolves to an object, the write updates that object in
    /// place and this field is ignored.
    pub object_id: String,
    pub path: String,
    pub text: String,
    /// The (unique-per-workspace) id to pin on the new moment.
    pub moment_id: String,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
    /// Optional idempotency key: a same-payload retry replays exactly-once.
    pub request_id: Option<String>,
}

/// Inputs to [`crate::VersionedTextStore::capture_ingest`].
#[derive(Debug, Clone)]
pub struct CaptureIngest {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub text: String,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
    pub request_id: Option<String>,
    /// Whether this write may overwrite a head written by a DIFFERENT origin
    /// (an RPC write, a replication apply). Capture sets it only when it
    /// OBSERVED the disk transition (`IngestReason::Changed`) — a genuine
    /// user edit is authoritative for file content. On first sight of a path
    /// (`Added`, e.g. after a fresh/reset manifest) capture cannot tell a
    /// user edit from stale disk bytes, so it must NOT claim a foreign head
    /// and silently revert that writer.
    pub claim_foreign_head: bool,
}

/// Inputs to [`crate::VersionedTextStore::capture_ingest_binary`]: the
/// autonomous BINARY capture-write primitive. Ids are derived internally via
/// the same length-framed scheme as text capture; the bytes are persisted as
/// a BINHEAD binary head with NO materialization job (they came FROM disk).
#[derive(Debug, Clone)]
pub struct CaptureIngestBinary {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub bytes: Vec<u8>,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
    pub request_id: Option<String>,
    /// See [`CaptureIngest::claim_foreign_head`].
    pub claim_foreign_head: bool,
}

/// Result of [`crate::VersionedTextStore::capture_ingest_binary`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureIngestBinaryResult {
    pub object_id: String,
    pub moment_id: String,
    pub moment_order: i64,
    /// Lowercase-hex sha256 of the persisted bytes.
    pub binary_sha256: String,
    /// Content-equality no-op: the head already held exactly these bytes.
    pub deduped: bool,
}

/// Inputs to [`crate::VersionedTextStore::capture_retire`].
#[derive(Debug, Clone)]
pub struct CaptureRetire {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub now_ms: i64,
    pub request_id: Option<String>,
    /// Retire ONLY when the current head is text. The plaintext capture sink
    /// sets this on its binary-deferral path so it can clear a stale TEXT
    /// head without ever deleting a live binary head it does not own (binary
    /// heads exist via mirrored resolve / the binary capture path). A binary
    /// head under this flag is a no-op, not an error.
    pub only_if_text_head: bool,
    /// Retire ONLY when the current head was itself written by CAPTURE. The
    /// capture sink sets this so a head that arrived by another route (an
    /// RPC versionedText.write, a replication apply) — which may legitimately
    /// have no disk counterpart — can never be deleted by a disk-driven
    /// retire. A foreign-origin head is a no-op, not an error.
    pub only_if_capture_origin: bool,
}

/// Inputs to [`crate::VersionedTextStore::delete_text_file`].
#[derive(Debug, Clone)]
pub struct DeleteTextFile {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub moment_id: String,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
}

/// Inputs to [`crate::VersionedTextStore::rename_text_file`].
#[derive(Debug, Clone)]
pub struct RenameTextFile {
    pub workspace_id: String,
    pub version_id: String,
    pub from_path: String,
    pub to_path: String,
    pub moment_id: String,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
}

/// Inputs to [`crate::VersionedTextStore::rollback_text_file_mutation`].
#[derive(Debug, Clone)]
pub struct RollbackTextFileMutation {
    pub workspace_id: String,
    pub version_id: String,
    pub path: String,
    pub mutation_moment_id: String,
    pub legacy_before_text: Option<String>,
}

/// Inputs to [`crate::VersionedTextStore::create_named_version`].
#[derive(Debug, Clone)]
pub struct CreateNamedVersion {
    pub workspace_id: String,
    pub new_version_id: String,
    pub name: String,
    pub from_version_id: String,
    pub now_ms: i64,
    /// Optional idempotency key for exactly-once fork creation.
    pub request_id: Option<String>,
}

/// The result of a successful [`crate::VersionedTextStore::write_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteResult {
    pub snapshot: TextSnapshot,
    pub moment: MomentRecord,
    /// True when no new moment was needed (request replay or equal content).
    pub deduped: bool,
}

/// The result of a successful [`crate::VersionedTextStore::delete_text_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteResult {
    pub object: FileObjectRecord,
    pub before: TextSnapshot,
    pub moment: MomentRecord,
}

/// The result of [`crate::VersionedTextStore::capture_retire`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureRetireResult {
    /// The canonical delete result, or `None` when the path was not present.
    pub retired: Option<DeleteResult>,
    /// True when a committed request or an already-absent path was replayed.
    pub deduped: bool,
}

/// The result of a successful [`crate::VersionedTextStore::rename_text_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameResult {
    pub object: FileObjectRecord,
    pub before: TextSnapshot,
    pub after: TextSnapshot,
    pub moment: MomentRecord,
}
