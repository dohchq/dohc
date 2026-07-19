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
    /// True when the write replayed a previously-recorded request (exactly-once).
    pub deduped: bool,
}

/// The result of a successful [`crate::VersionedTextStore::delete_text_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteResult {
    pub object: FileObjectRecord,
    pub before: TextSnapshot,
    pub moment: MomentRecord,
}

/// The result of a successful [`crate::VersionedTextStore::rename_text_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameResult {
    pub object: FileObjectRecord,
    pub before: TextSnapshot,
    pub after: TextSnapshot,
    pub moment: MomentRecord,
}
