//! dohc engine domain — CAL-2 calibration slice.
//!
//! The versioning domain: stable object identity, versioned text write/read,
//! moment history with keyset pagination, text delete/rename/rollback,
//! named-version fork, and restore (set-active-version), built ON the CAL-1
//! storage core
//! (`dohc-engine-storage`) rather than around it. Storage owns the connection,
//! the open ritual, the single-transaction boundary, and the crash-injection
//! fault seam; this crate owns what a version, a moment, a fork, and a restore
//! *mean* (`plan §Target architecture`: `dohc-engine-domain` = version/merge
//! semantics; `dohc-engine-storage` = SQLite ownership + transactions).
//!
//! - **Compound commits.** Every mutation and its replication-journal entry (and
//!   idempotency-ledger row) commit in ONE transaction via
//!   [`dohc_engine_storage::EngineStore::write_with`] (`PORTING.md` §9).
//! - **Identity, not paths.** [`records::SnapshotView`]/[`records::TextSnapshot`]/
//!   [`records::MomentRecord`] carry a stable `object_id`; a `path` is an alias
//!   onto it.
//! - **History as keyset pages.** [`VersionedTextStore::list_moments`] returns a
//!   `limit + 1` probe page with a `next_before_moment_order` cursor.
//! - **Restore preserves both sides.** [`VersionedTextStore::set_active_version`]
//!   moves the active pointer without destroying any version's rows.
//! - **Differential surface.** [`normalize::NormalizedState`] is a deterministic
//!   projection of the version graph, moment order, active version, and
//!   snapshot blob hashes for the TS-vs-Rust comparison.
//!
//! The crate is dormant: nothing here is reachable from product code.

#![forbid(unsafe_code)]

pub mod chats;
pub mod conflicts;
pub mod error;
pub mod merge;
pub mod normalize;
pub mod records;
pub mod secrets;
pub mod store;

pub use chats::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, BookmarkMode, BookmarkTargetKind, ChatActorKind,
    ChatBookmark, ChatBookmarkTransition, ChatChannel, ChatChannelKind, ChatFeedItem, ChatFeedPage,
    ChatFollow, ChatMessage, ChatMessagePage, ChatThread, ChatThreadReadState, DispatchClaim,
    FeedCursorValue, FollowState, FollowTargetKind, GENERAL_CHANNEL_NAME, GENERAL_CHANNEL_WIRE_ID,
    LINKED_CHAT_PROJECTION_KIND, LinkedChatStore, MAX_MESSAGE_BODY_BYTES, MAX_MESSAGE_PAGE,
    SaveBookmark, SendMessage, SetFollow, StartChannelThread, channel_slug_for_name,
    decode_feed_cursor, encode_feed_cursor, linked_chat_projection_path,
};
pub use conflicts::{
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution,
    ConflictRowUpdate, ConflictStatus, ResolveConflictKind, ResolveTextConflict,
    ResolveTextConflictResult, TextConflict, WriteBinaryFile, enqueue_delete, enqueue_write,
    insert_text_conflict_if_absent, live_state_matches_conflict_current, load_text_conflict_in_tx,
    update_text_conflict_row, write_binary_file_in_tx,
};
pub use error::DomainError;
pub use merge::{
    CompareTextFileVersions, ComparisonStatus, MAX_MERGE_LINES, MarkdownMergeResult,
    MergeTextFileFromVersion, MergeTextFileResult, MergeUnchangedReason, VersionFileChange,
    VersionFileChangeStatus, VersionedTextComparison, comparison_status, file_states_equal,
    merge_markdown,
};
pub use normalize::NormalizedState;
pub use records::{
    BinaryHead, CaptureIngest, CaptureIngestBinary, CaptureIngestBinaryResult, CaptureRetire,
    CaptureRetireResult, CreateNamedVersion, DeleteResult, DeleteTextFile, FileObjectRecord,
    ListMomentsQuery, MomentOp, MomentPage, MomentRecord, RenameResult, RenameTextFile,
    RollbackTextFileMutation, SnapshotContent, SnapshotView, TextSnapshot, VersionKind,
    VersionRecord, WriteResult, WriteText,
};
pub use secrets::{
    CaptureSecret, CaptureSecretRetire, SecretDelete, SecretDiskIntent, SecretFileStat,
    SecretFileStore, SecretMomentRecord, SecretOp, SecretWrite, SecretWriteResult,
    capture_secret_retire, delete_secret_file_keyless, derive_capture_secret_moment_id,
    derive_capture_secret_retire_moment_id, has_secret_state, list_secret_files_keyless,
};
pub use store::{
    CaptureManifestSeedEntry, MAX_CAPTURE_BINARY_FILE_BYTES, MAX_TEXT_BYTES,
    SECRET_SEED_SENTINEL_SHA, VersionedTextStore, capture_manifest_seed, delete_text_in_tx,
    derive_capture_moment_id, derive_capture_object_id, derive_capture_retire_moment_id,
    validate_delete_input, validate_write_input, write_text_in_tx,
};

// Re-export the storage surface a domain caller needs on the common path.
pub use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};
