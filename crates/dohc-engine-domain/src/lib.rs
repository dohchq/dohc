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
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, AgentRunRecord, AgentUnreadThreadRow, BookmarkMode,
    BookmarkTargetKind, CHAT_THREAD_HEADER_MESSAGE_ID, ChannelOpeningMessage, ChannelThreadSummary,
    ChatActorKind, ChatAgentReadState, ChatAttachment, ChatBookmark, ChatBookmarkTransition,
    ChatChannel, ChatChannelKind, ChatChannelSummary, ChatDecision, ChatDecisionState,
    ChatFeedItem, ChatFeedPage, ChatFeedReadState, ChatFileMention, ChatFollow, ChatMention,
    ChatMessage, ChatMessagePage, ChatProjectionFileAccess, ChatReaction, ChatReactionState,
    ChatThread, ChatThreadProjection, ChatThreadReadState, CreateFileThread, DispatchClaim,
    DispatchRecord, DispatchRecovery, FeedCoordinateResolution, FeedCursorValue, FollowState,
    FollowTargetKind, FollowTargetResolution, GENERAL_CHANNEL_NAME, GENERAL_CHANNEL_WIRE_ID,
    LINKED_CHAT_PROJECTION_KIND, LinkedChatStore, LocalAttachmentInput, MAX_FILE_MENTION_RESULTS,
    MAX_MESSAGE_BODY_BYTES, MAX_MESSAGE_PAGE, MentionCursor, PENDING_CHAT_WORKSPACE_EXISTS_SQL,
    PendingBookmarkRow, PendingChatRefusal, ResolveDecision, RunRecordLink, SaveBookmark,
    SendMessage, SetFollow, SetReaction, StartChannelThread, ThreadDispatchPause,
    ThreadMessageResolution, attachment_id_for, base32_lowercase_no_padding, bookmark_id_for,
    channel_slug_for_name, decode_feed_cursor, encode_feed_cursor, feed_coordinate_visible,
    has_projection_control_char, index_message_mentions_in_tx, is_js_trim_ws,
    is_reaction_emoji_verbatim, linked_chat_projection_path, normalize_author_user_id,
    normalize_body, normalize_channel_name, normalize_display_name, normalize_feed_identity,
    normalize_reaction_author_id, normalize_replicated_chat_id, parse_mention_handles,
    reaction_id_for, render_chat_thread_projection, replay_pending_chat_coordinates_for_change,
    replay_ready_pending_chat_coordinates, resolve_feed_coordinate, resolve_follow_target,
    resolve_thread_message, thread_has_message, validate_follow_target,
};
pub use conflicts::{
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution,
    ConflictRowUpdate, ConflictStatus, ResolveConflictKind, ResolveTextConflict,
    ResolveTextConflictResult, TextConflict, WriteBinaryFile, binary_delete_job_id,
    binary_rename_delete_job_id, binary_rename_write_job_id, enqueue_binary_delete,
    enqueue_binary_rename, enqueue_delete, enqueue_write, insert_text_conflict_if_absent,
    live_state_matches_conflict_current, load_text_conflict_in_tx, select_snapshot_by_path_in_tx,
    update_text_conflict_row, write_binary_file_in_tx,
};
pub use error::DomainError;
pub use merge::{
    CompareTextFileVersions, ComparisonStatus, MAX_MERGE_LINES, MarkdownMergeResult,
    MergeTextFileFromVersion, MergeTextFileResult, MergeUnchangedReason, VersionFileChange,
    VersionFileChangeEntry, VersionFileChangePage, VersionFileChangeStatus,
    VersionedTextComparison, comparison_status, file_states_equal, merge_markdown,
};
pub use normalize::NormalizedState;
pub use records::{
    ApplySecretFileFromVersion, BinaryBlobRead, BinaryHead, BinaryHeadMeta, BinaryWriteResult,
    CaptureIngest, CaptureIngestBinary, CaptureIngestBinaryResult, CaptureRetire,
    CaptureRetireResult, CreateNamedVersion, DeleteResult, DeleteTextFile, FileObjectRecord,
    InbandBinary, InbandSecret, InbandText, ListMomentsQuery, MomentOp, MomentPage, MomentRecord,
    RenameResult, RenameTextFile, RollbackTextFileMutation, SnapshotContent, SnapshotMetadata,
    SnapshotView, TextSnapshot, VersionKind, VersionRecord, WriteBinary, WriteResult, WriteText,
};
pub use secrets::{
    CaptureSecret, CaptureSecretRetire, SecretCompareEntry, SecretComparePage, SecretDelete,
    SecretDiskIntent, SecretFileStat, SecretFileStore, SecretMomentPage, SecretMomentRecord,
    SecretOp, SecretRestoreResult, SecretWrite, SecretWriteResult, apply_secret_file_from_version,
    capture_secret_retire, compare_secret_files_page_keyless, delete_secret_file_keyless,
    derive_capture_secret_moment_id, derive_capture_secret_retire_moment_id, fork_version_keyless,
    get_secret_moment_keyless, has_secret_state, list_secret_files_keyless,
    list_secret_files_keyless_page, list_secret_moments_keyless, list_secret_moments_page_keyless,
    restore_secret_file_verbatim, restore_secret_file_verbatim_with_metadata,
    secret_file_len_keyless,
};
pub use store::{
    CaptureManifestSeedEntry, INBAND_CONTENT_CAP_BYTES, MAX_CAPTURE_BINARY_FILE_BYTES,
    MAX_TEXT_BYTES, SECRET_SEED_SENTINEL_SHA, VersionedTextStore, capture_manifest_seed,
    delete_text_in_tx, derive_capture_moment_id, derive_capture_object_id,
    derive_capture_retire_moment_id, object_has_live_alias, validate_addressable_plaintext_path,
    validate_delete_input, validate_write_input, write_binary_in_tx, write_projected_text_in_tx,
    write_text_in_tx,
};

// Re-export the storage surface a domain caller needs on the common path.
pub use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};

/// The secret domain's ciphertext shape and plaintext/ciphertext size cap.
/// Re-exported so replication appliers bind to the SAME values the local
/// seal/open and secret write paths use instead of restating them.
pub use dohc_engine_crypto::aead::{MAX_SECRET_FILE_BYTES, SECRET_IV_BYTES, SECRET_TAG_BYTES};
