//! dohc engine domain: what a version, moment, fork, and restore mean.
//!
//! The versioning domain: stable object identity, versioned text write/read,
//! moment history with keyset pagination, text delete/rename/rollback,
//! named-version fork, and restore (set-active-version), built on the storage
//! core
//! (`dohc-engine-storage`) rather than around it. Storage owns the connection,
//! the open ritual, the single-transaction boundary, and the crash-injection
//! fault seam; this crate owns what a version, a moment, a fork, and a restore
//! *mean* (`plan §Target architecture`: `dohc-engine-domain` = version/merge
//! semantics; `dohc-engine-storage` = SQLite ownership + transactions).
//!
//! - **Compound commits.** Every mutation and its idempotency-ledger row commit
//!   in one transaction via [`dohc_engine_storage::EngineStore::write_with`].
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

#![forbid(unsafe_code)]

pub mod automations;
pub mod chats;
pub mod collections;
pub mod conflicts;
pub mod error;
pub mod merge;
pub mod normalize;
pub mod records;
pub mod secrets;
pub mod store;

pub use automations::{
    AUTOMATION_CHAIN_DEPTH_CAP, AUTOMATION_CHAIN_STOPPED, AUTOMATION_CLAIM_HISTORY_LIMIT,
    AUTOMATION_GROUP_COVERAGE_MS, AUTOMATION_GROUP_FUTURE_MS, AUTOMATION_ID_NAMESPACE,
    AUTOMATION_PRESS_RETENTION_MS, AUTOMATION_RECLAIM_EXHAUSTED, AutomationChange,
    AutomationChangeKind, AutomationClaim, AutomationClaimAttempt, AutomationClaimState,
    AutomationFactValue, AutomationFailure, AutomationFieldFact, AutomationFieldFacts,
    AutomationGroupHandover, AutomationGroupHandoverAutomation, AutomationGroupMessage,
    AutomationGroupRelayRecord, AutomationGroupRelease, AutomationGroupSubscription,
    AutomationGroupWatch, AutomationGroupWatched, AutomationPress, AutomationPressed,
    AutomationRetry, AutomationRunNow, AutomationScheduleClaim, AutomationScheduleClaimed,
    AutomationScheduleMark, AutomationSettle, AutomationSubscription, AutomationTrigger,
    MAX_AUTOMATION_ERROR_BYTES, MAX_AUTOMATION_FIELD_FACTS_BYTES,
    MAX_AUTOMATION_GROUP_HANDOVER_AUTOMATIONS, MAX_AUTOMATION_GROUP_HANDOVER_MESSAGES,
    MAX_AUTOMATION_GROUP_SUBSCRIPTIONS, MAX_AUTOMATION_SCHEDULE_RUNS,
    MAX_AUTOMATION_SUBSCRIPTION_FIELDS, claim_automation_run_now, claim_automation_schedule,
    claim_automation_triggers_in_tx, claim_group_message_in_tx, claim_next_pending_automation,
    claim_record_lifecycle_in_tx, collection_automation_path, list_automation_claims,
    list_automation_failures, list_automation_schedule_marks, list_running_automation_attempts,
    press_automation, reclaim_running_automations, release_automation_claim,
    release_automation_groups, retry_automation_claim, settle_automation_claim,
    subscribe_automation, subscribe_automation_in_tx, unsubscribe_automation,
    watch_automation_groups,
};
pub use chats::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, AgentRunRecord, AgentUnreadThreadRow, BookmarkMode,
    BookmarkTargetKind, CHAT_THREAD_HEADER_MESSAGE_ID, ChannelGroup, ChannelOpeningMessage,
    ChannelThreadSummary, ChatActorKind, ChatAgentReadState, ChatAttachment, ChatBookmark,
    ChatBookmarkTransition, ChatChannel, ChatChannelKind, ChatChannelSummary, ChatChannelType,
    ChatDecision, ChatDecisionState, ChatFeedItem, ChatFeedPage, ChatFeedReadState,
    ChatFileMention, ChatFollow, ChatMention, ChatMessage, ChatMessageAutomation, ChatMessagePage,
    ChatProjectionFileAccess, ChatReaction, ChatReactionState, ChatThread, ChatThreadLane,
    ChatThreadProjection, ChatThreadReadState, CreateFileThread, DispatchClaim, DispatchRecord,
    DispatchRecovery, FeedCoordinateResolution, FeedCursorValue, FollowState, FollowTargetKind,
    FollowTargetResolution, GENERAL_CHANNEL_NAME, GENERAL_CHANNEL_WIRE_ID,
    LINKED_CHAT_PROJECTION_KIND, LinkedChatStore, LocalAttachmentInput, MAX_FILE_MENTION_RESULTS,
    MAX_MESSAGE_BODY_BYTES, MAX_MESSAGE_PAGE, MentionCursor, PENDING_CHAT_WORKSPACE_EXISTS_SQL,
    PendingBookmarkRow, PendingChatRefusal, PendingChatReplay, ResolveDecision, RunRecordLink,
    SaveBookmark, SendMessage, SetFollow, SetReaction, StartChannelThread, ThreadDispatchPause,
    ThreadMessageResolution, UnreadFileThread, attachment_id_for, base32_lowercase_no_padding,
    bookmark_id_for, bump_chat_conversation_revision, channel_slug_for_name, decode_feed_cursor,
    decode_poll_options, encode_feed_cursor, encode_poll_options, feed_coordinate_visible,
    has_projection_control_char, index_message_mentions_in_tx, is_js_trim_ws,
    is_reaction_emoji_verbatim, linked_chat_projection_path, normalize_agent_owner_name,
    normalize_author_user_id, normalize_body, normalize_channel_group, normalize_channel_name,
    normalize_display_name, normalize_feed_identity, normalize_poll_options,
    normalize_reaction_author_id, normalize_replicated_chat_id, parse_mention_handles,
    reaction_id_for, render_chat_thread_projection, replay_pending_chat_coordinates_for_change,
    replay_ready_pending_chat_coordinates, resolve_feed_coordinate, resolve_follow_target,
    resolve_thread_message, thread_has_message, validate_follow_target,
};
pub use collections::{
    COLLECTION_SCHEMA_FILENAME, ChangeActorKind, ChangeAttribution, CollectionAdoptionCandidate,
    CollectionDetails, CollectionFieldChangeFact, CollectionFieldHistoryEntry, CollectionFieldType,
    CollectionFieldValue, CollectionFilter, CollectionFilterOperator, CollectionHistoryValue,
    CollectionIndexedValue, CollectionIndexedValueValidation, CollectionListPage,
    CollectionPendingAdoption, CollectionPendingAdoptionCursor, CollectionPendingAdoptionPage,
    CollectionQuery, CollectionQueryCursor, CollectionQueryCursorValue, CollectionQueryResult,
    CollectionReconcileResult, CollectionRecord, CollectionRecordApplyFacts,
    CollectionRecordDetails, CollectionRecordGroup, CollectionRecordLifecycle,
    CollectionRecordLifecycleKind, CollectionRelationCleanupCandidate, CollectionResolvedRelation,
    CollectionSchema, CollectionSchemaParseResult, CollectionSchemaReason,
    CollectionSchemaReasonCode, CollectionSchemaStatus, CollectionSort, CollectionSummary,
    DEFAULT_COLLECTION_QUERY_LIMIT, FieldDefinition, FieldValueReason, FieldValueReasonCode,
    FieldValueValidation, MAX_CHANGE_ATTRIBUTION_DEPTH, MAX_COLLECTION_FIELD_VALUE_DEPTH,
    MAX_COLLECTION_HISTORY_LIMIT, MAX_COLLECTION_QUERY_LIMIT, MAX_COLLECTION_QUERY_SORTS,
    MAX_FIELD_FACT_VALUE_BYTES, MAX_FIELD_FACT_VALUE_DEPTH, RECORD_ID_FRONTMATTER_KEY,
    RECORD_ID_PREFIX, RECORD_ID_RANDOM_BASE32_LENGTH, ViewDefinition, ViewKind, ViewSort,
    ViewSortDirection, agent_author_depth, collection_record_id_mismatch_in_tx,
    collection_record_markdown_with_id, collection_value_exceeds_depth,
    decline_oversized_collection_adoption_in_tx, delete_collection_adoption_binding_in_tx,
    field_fact_value, get_collection, get_collection_record,
    index_collection_frontmatter_apply_in_tx, index_collection_record_text_in_tx,
    is_collection_record_bound_in_tx, is_record_id, list_collections,
    list_pending_collection_adoptions, mint_record_id, moment_author_attribution,
    moment_author_json, parse_collection_schema, query_collection_records,
    reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
    synchronize_collection_frontmatter_index_in_tx, validate_field_value,
};
pub use conflicts::{
    BINARY_COMBINED_TEXT_REFUSAL, BinaryResolveWrite, CONFLICT_METADATA_BUDGET_BYTES,
    CONFLICT_ROW_CONSTRAINT, CONFLICT_ROW_STRUCTURAL_HEADROOM_BYTES, ConflictChoice,
    ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution,
    ConflictRowUpdate, ConflictStatus, ResolveConflictKind, ResolveTextConflict,
    ResolveTextConflictResult, TEXT_CONFLICT_QUERY_LIMIT, TextConflict, WriteBinaryFile,
    binary_delete_job_id, binary_rename_delete_job_id, binary_rename_write_job_id,
    conflict_state_preimage, enqueue_binary_delete, enqueue_binary_rename, enqueue_delete,
    enqueue_write, insert_text_conflict_if_absent, live_state_matches_conflict_current,
    load_text_conflict_in_tx, select_snapshot_by_path_in_tx, update_text_conflict_row,
    write_binary_file_in_tx,
};
pub use error::DomainError;
pub use merge::{
    BinaryMergeWrite, CompareTextFileVersions, ComparisonSide, ComparisonStatus, MAX_MERGE_LINES,
    MarkdownMergeResult, MergeTextFileFromVersion, MergeTextFileResult, MergeUnchangedReason,
    VersionFileChange, VersionFileChangeEntry, VersionFileChangePage, VersionFileChangeStatus,
    VersionedTextComparison, comparison_sides_equal, comparison_status, file_states_equal,
    merge_markdown,
};
pub use normalize::NormalizedState;
pub use records::{
    ApplySecretFileFromVersion, BinaryBlobRead, BinaryHead, BinaryWriteResult, CaptureIngest,
    CaptureIngestBinary, CaptureIngestBinaryResult, CaptureRetire, CaptureRetireResult,
    CreateNamedVersion, DeleteResult, DeleteTextFile, FileObjectRecord, InbandBinary, InbandSecret,
    InbandText, ListMomentsQuery, MomentOp, MomentPage, MomentRecord, RenameResult, RenameTextFile,
    RollbackTextFileMutation, SnapshotContent, SnapshotMetadata, SnapshotView, TextBlobRead,
    TextSnapshot, VersionKind, VersionRecord, WriteBinary, WriteResult, WriteText,
};
pub use secrets::{
    CaptureSecret, CaptureSecretRetire, SecretCompareEntry, SecretComparePage, SecretDelete,
    SecretDiskIntent, SecretFileStat, SecretFileStore, SecretMomentPage, SecretMomentRecord,
    SecretOp, SecretRestoreResult, SecretWrite, SecretWriteResult,
    apply_secret_file_from_version_with, capture_secret_retire_with,
    compare_secret_files_page_keyless, delete_secret_file_keyless_with,
    derive_capture_secret_moment_id, derive_capture_secret_retire_moment_id,
    fork_version_keyless_with, get_secret_moment_keyless, has_secret_state,
    list_secret_files_keyless, list_secret_files_keyless_page,
    list_secret_moments_in_time_window_keyless, list_secret_moments_keyless,
    list_secret_moments_page_keyless, restore_secret_file_verbatim_with_metadata_and_after,
    secret_file_len_keyless,
};
pub use store::{
    CaptureIngestBatchContext, CaptureManifestSeedEntry, INBAND_CONTENT_CAP_BYTES,
    MAX_AUTHOR_FIELD_BYTES, MAX_AUTHOR_JSON_BYTES, MAX_CAPTURE_BINARY_FILE_BYTES,
    MAX_METADATA_FIELD_BYTES, MAX_TEXT_BYTES, ProjectedWriteText, SECRET_SEED_SENTINEL_SHA,
    VersionedTextStore, binary_rollback_job_identity, capture_ingest_binary_in_tx,
    capture_ingest_binary_with_admission_in_tx, capture_ingest_in_batch_with_admission_in_tx,
    capture_ingest_in_tx, capture_ingest_with_admission_in_tx, capture_manifest_seed,
    capture_retire_in_tx, decode_binary_rollback_job_identity, delete_text_in_tx,
    delete_text_in_tx_checked, derive_capture_moment_id, derive_capture_object_id,
    derive_capture_retire_moment_id, ensure_main_version_in_tx, normalize_tracked_workspace_path,
    object_has_live_alias, rollback_compensating_moment_id, validate_addressable_plaintext_path,
    validate_delete_input, validate_plaintext_storable_path, validate_write_input,
    write_binary_in_tx, write_history_text_in_tx, write_projected_text_in_tx, write_text_in_tx,
};

// Re-export the storage surface a domain caller needs on the common path.
pub use dohc_engine_storage::{EngineStore, FaultInjector, NoFaults, StorageError, TxnOutcome};

/// The secret domain's ciphertext shape and plaintext/ciphertext size cap.
/// Re-exported so replication appliers bind to the same values the local
/// seal/open and secret write paths use instead of restating them.
pub use dohc_engine_crypto::aead::{MAX_SECRET_FILE_BYTES, SECRET_IV_BYTES, SECRET_TAG_BYTES};
