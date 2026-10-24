//! The ordered, idempotent, crash-recoverable migration ledger and runner.
//!
//! [`BASELINE_MIGRATIONS`] is the frozen list. The baseline (ordinal 0)
//! assembles the whole schema and stamps `user_version = 2`. A later schema
//! change appends a new migration with the next ordinal and flows through the
//! same runner.
//!
//! Before the runner, the open ritual refuses a store whose ledger holds a
//! migration this list does not define, completed or not: a newer build ran
//! it.
//!
//! The runner walks the list in order. A migration whose completed ledger row
//! matches this build's checksum is skipped; a completed row with a different
//! checksum fails closed; a missing row is applied. Body, `user_version`
//! stamp, integrity result, and ledger row commit in one transaction, so a
//! crash mid-apply rolls back to the prior consistent state and the next open
//! re-runs from the ledger.

use crate::error::StorageError;
use crate::faults::{FaultInjector, FaultPoint};
use crate::limits::{ENGINE_BUILD, ENGINE_SCHEMA_VERSION, ENGINE_STORAGE_PROTOCOL_VERSION};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

/// One ordered migration. `sql` is applied verbatim; `checksum` is derived from
/// it so a silently-edited migration is caught rather than skipped.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Migration {
    pub ordinal: u32,
    pub id: &'static str,
    pub sql: &'static str,
    /// `Some(v)` when this migration stamps `PRAGMA user_version` (the baseline
    /// stamps the v2 fingerprint). Applied inside the migration transaction so
    /// it rolls back with a crashed apply.
    pub sets_user_version: Option<i64>,
}

/// Ambient inputs stamped into every ledger row.
#[derive(Debug, Clone)]
pub(crate) struct MigrationContext {
    pub engine_build: &'static str,
    pub protocol_version: i64,
    pub now_ms: i64,
    pub initial_root_token: Option<String>,
}

impl MigrationContext {
    /// The production context for this build.
    pub fn current(now_ms: i64) -> Self {
        MigrationContext {
            engine_build: ENGINE_BUILD,
            protocol_version: ENGINE_STORAGE_PROTOCOL_VERSION,
            now_ms,
            initial_root_token: None,
        }
    }
}

/// The result of a migration run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    /// Every pending migration applied (or was already applied). `newly_applied`
    /// counts the ones this run actually executed.
    Applied { newly_applied: u32 },
    /// A crash fault fired at a named migration point. Durability is whatever
    /// the point guarantees; proven by reopening, never by trusting this value.
    Crashed,
}

/// The `id` of the baseline migration. `validate_v2` requires this ledger row
/// as a cheap own-store fingerprint (a foreign db can fake table names but not
/// this row).
pub(crate) const BASELINE_MIGRATION_ID: &str = "v2-baseline";

/// The engine schema: every table, index, and FTS5 virtual table the engine
/// reads or writes. Notes on individual shapes live with the code that owns
/// the table.
const V2_BASELINE_DDL: &str = "\
CREATE TABLE engine_migrations (
    ordinal          INTEGER NOT NULL UNIQUE,
    id               TEXT    NOT NULL PRIMARY KEY,
    checksum         TEXT    NOT NULL,
    engine_build     TEXT    NOT NULL,
    protocol_version INTEGER NOT NULL,
    transactional    INTEGER NOT NULL,
    started_at       INTEGER NOT NULL,
    completed_at     INTEGER,
    integrity_ok     INTEGER
) STRICT;

CREATE TABLE engine_ownership (
    rowid_guard   INTEGER NOT NULL PRIMARY KEY CHECK (rowid_guard = 1),
    engine_uuid   TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL,
    engine_build  TEXT    NOT NULL,
    schema_version INTEGER NOT NULL
) STRICT;

CREATE TABLE engine_requests (
    request_id   TEXT    NOT NULL PRIMARY KEY,
    payload_hash TEXT    NOT NULL,
    result_seq   INTEGER NOT NULL,
    committed_at INTEGER NOT NULL,
    kind         TEXT
) STRICT;

CREATE TABLE versioned_workspaces (
    workspace_id    TEXT NOT NULL PRIMARY KEY,
    main_version_id TEXT NOT NULL
) STRICT;

CREATE TABLE versions (
    workspace_id    TEXT    NOT NULL,
    version_id      TEXT    NOT NULL,
    kind            TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    created_at_ms   INTEGER NOT NULL,
    fork_version_id TEXT,
    fork_moment_id  TEXT,
    PRIMARY KEY (workspace_id, version_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE active_versions (
    workspace_id TEXT NOT NULL PRIMARY KEY,
    version_id   TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE file_objects (
    workspace_id  TEXT    NOT NULL,
    object_id     TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, object_id),
    UNIQUE (object_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE blobs (
    sha256      TEXT    NOT NULL PRIMARY KEY,
    byte_length INTEGER NOT NULL,
    text        TEXT    NOT NULL
) STRICT;

CREATE TABLE binary_blobs (
    sha256      TEXT NOT NULL PRIMARY KEY,
    byte_length INTEGER NOT NULL,
    bytes       BLOB NOT NULL
) STRICT;

CREATE TABLE path_aliases (
    workspace_id TEXT NOT NULL,
    version_id   TEXT NOT NULL,
    path         TEXT NOT NULL,
    object_id    TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version_id, path),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE materialization_jobs (
    job_id            TEXT    NOT NULL PRIMARY KEY,
    target_path       TEXT    NOT NULL,
    content_sha256    TEXT    NOT NULL,
    -- Expected on-disk preimage immediately before the replace. NULL present=0
    -- means 'the target is expected absent'; a hash with present=1 means 'the
    -- target is expected to still hold exactly this content'. A mismatch is an
    -- external write we must preserve, never clobber.
    preimage_present  INTEGER NOT NULL,
    preimage_sha256   TEXT,
    target_generation INTEGER NOT NULL,
    -- 'pending' | 'complete' | 'conflict'. Only 'pending' is replayed.
    status            TEXT    NOT NULL DEFAULT 'pending',
    created_at_ms     INTEGER NOT NULL,
    completed_at_ms   INTEGER,
    operation TEXT NOT NULL DEFAULT 'write',
    workspace_id TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (content_sha256) REFERENCES binary_blobs(sha256)
) STRICT;

CREATE INDEX idx_materialization_jobs_status ON materialization_jobs(status);

CREATE TABLE secret_files (
    workspace_id     TEXT    NOT NULL,
    version_id       TEXT    NOT NULL,
    path             TEXT    NOT NULL,
    iv_base64        TEXT    NOT NULL,
    auth_tag_base64  TEXT    NOT NULL,
    ciphertext_base64 TEXT   NOT NULL,
    byte_length      INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    latest_moment_id TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, version_id, path),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE secret_fork_bases (
    workspace_id      TEXT    NOT NULL,
    version_id        TEXT    NOT NULL,
    path              TEXT    NOT NULL,
    iv_base64         TEXT    NOT NULL,
    auth_tag_base64   TEXT    NOT NULL,
    ciphertext_base64 TEXT    NOT NULL,
    byte_length       INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, version_id, path),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE secret_moments (
    workspace_id            TEXT    NOT NULL,
    moment_order            INTEGER NOT NULL,
    moment_id               TEXT    NOT NULL,
    version_id              TEXT    NOT NULL,
    path                    TEXT    NOT NULL,
    recorded_at_ms          INTEGER NOT NULL,
    operation               TEXT    NOT NULL,
    metadata_origin         TEXT    NOT NULL,
    metadata_summary        TEXT,
    metadata_correlation_id TEXT,
    after_present           INTEGER NOT NULL,
    after_iv_base64         TEXT,
    after_auth_tag_base64   TEXT,
    after_ciphertext_base64 TEXT,
    after_byte_length       INTEGER,
    capture_owned INTEGER NOT NULL DEFAULT 0,
    source_origin_id TEXT,
    source_origin_seq INTEGER,
    PRIMARY KEY (workspace_id, moment_id),
    UNIQUE (workspace_id, moment_order),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_secret_moments_version_order
    ON secret_moments(workspace_id, version_id, moment_order);

CREATE INDEX idx_secret_moments_path_order
    ON secret_moments(workspace_id, version_id, path, moment_order);

CREATE TABLE chat_channels (
    workspace_id  TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    slug          TEXT    NOT NULL,
    kind          TEXT    NOT NULL CHECK (kind IN ('channel', 'dm', 'agent')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, channel_id)
) STRICT;

CREATE UNIQUE INDEX idx_chat_channels_slug ON chat_channels(workspace_id, slug);

CREATE TABLE chat_thread_read_state (
    workspace_id       TEXT    NOT NULL,
    thread_id          TEXT    NOT NULL,
    last_read_sequence INTEGER NOT NULL,
    revision           INTEGER NOT NULL,
    updated_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, thread_id)
) STRICT;

CREATE TABLE chat_channel_wire_ids (
    workspace_id TEXT NOT NULL,
    wire_id      TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    PRIMARY KEY (workspace_id, wire_id)
) STRICT;

CREATE INDEX idx_chat_channel_wire_ids_channel
    ON chat_channel_wire_ids(workspace_id, channel_id);

CREATE TABLE chat_channel_placeholders (
    workspace_id TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    wire_id      TEXT NOT NULL,
    PRIMARY KEY (workspace_id, channel_id),
    UNIQUE (workspace_id, wire_id)
) STRICT;

CREATE TABLE chat_threads (
    workspace_id     TEXT    NOT NULL,
    thread_id        TEXT    NOT NULL,
    title            TEXT    NOT NULL,
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    linked_object_id TEXT,
    linked_path_hint TEXT,
    linked_at_ms     INTEGER,
    channel_id       TEXT,
    PRIMARY KEY (workspace_id, thread_id)
) STRICT;

CREATE INDEX idx_chat_threads_workspace_created
    ON chat_threads(workspace_id, created_at_ms, thread_id);

CREATE INDEX idx_chat_threads_linked_file
    ON chat_threads(workspace_id, linked_object_id, created_at_ms, thread_id);

CREATE INDEX idx_chat_threads_channel
    ON chat_threads(workspace_id, channel_id, updated_at_ms, thread_id);

CREATE TABLE chat_messages (
    workspace_id        TEXT    NOT NULL,
    thread_id           TEXT    NOT NULL,
    message_order       INTEGER NOT NULL,
    message_id          TEXT    NOT NULL,
    author_kind         TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent')),
    author_display_name TEXT    NOT NULL,
    author_user_id      TEXT,
    parent_message_id   TEXT,
    origin              TEXT,
    body                TEXT    NOT NULL,
    created_at_ms       INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id),
    UNIQUE (workspace_id, thread_id, message_order),
    FOREIGN KEY (workspace_id, thread_id)
      REFERENCES chat_threads(workspace_id, thread_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_chat_messages_thread_order
    ON chat_messages(workspace_id, thread_id, message_order);

CREATE INDEX idx_chat_messages_thread_created
    ON chat_messages(workspace_id, thread_id, created_at_ms, message_id);

CREATE INDEX idx_chat_messages_workspace_created
    ON chat_messages(workspace_id, created_at_ms, message_id);

CREATE INDEX idx_chat_messages_author_feed
    ON chat_messages(workspace_id, author_user_id, author_kind, created_at_ms DESC, message_id DESC);

CREATE TABLE chat_reactions (
    workspace_id        TEXT    NOT NULL,
    reaction_id         TEXT    NOT NULL,
    thread_id           TEXT    NOT NULL,
    message_id          TEXT    NOT NULL,
    emoji               TEXT    NOT NULL,
    author_id           TEXT    NOT NULL,
    author_kind         TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent')),
    author_display_name TEXT    NOT NULL,
    state               TEXT    NOT NULL CHECK (state IN ('added', 'removed')),
    at_ms               INTEGER NOT NULL,
    origin_id           TEXT    NOT NULL,
    origin_seq          INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id, emoji, author_id)
) STRICT;

CREATE INDEX idx_chat_reactions_thread
    ON chat_reactions(workspace_id, thread_id, message_id);

CREATE TABLE chat_decisions (
    workspace_id           TEXT    NOT NULL,
    thread_id              TEXT    NOT NULL,
    message_id             TEXT    NOT NULL,
    state                  TEXT    NOT NULL CHECK (state IN ('open', 'resolved')),
    resolved_by_message_id TEXT,
    at_ms                  INTEGER NOT NULL,
    origin_id              TEXT    NOT NULL,
    origin_seq             INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id)
) STRICT;

CREATE INDEX idx_chat_decisions_thread_state
    ON chat_decisions(workspace_id, thread_id, state, message_id);

CREATE TABLE chat_attachments (
    workspace_id       TEXT    NOT NULL,
    attachment_id      TEXT    NOT NULL,
    thread_id          TEXT    NOT NULL,
    message_id         TEXT    NOT NULL,
    target_kind        TEXT    NOT NULL CHECK (target_kind = 'file'),
    object_id          TEXT,
    path_hint          TEXT,
    heading_text       TEXT,
    heading_anchor     TEXT,
    heading_occurrence INTEGER,
    created_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, attachment_id)
) STRICT;

CREATE INDEX idx_chat_attachments_thread_message
    ON chat_attachments(workspace_id, thread_id, message_id, created_at_ms, attachment_id);

CREATE INDEX idx_chat_attachments_file_object
    ON chat_attachments(workspace_id, object_id, created_at_ms DESC, attachment_id DESC);

CREATE INDEX idx_chat_attachments_file_path
    ON chat_attachments(workspace_id, path_hint, created_at_ms DESC, attachment_id DESC);

CREATE TABLE chat_pending_message_parents (
    workspace_id      TEXT NOT NULL,
    child_message_id  TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    parent_message_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, child_message_id)
) STRICT;

CREATE INDEX idx_chat_pending_message_parents_parent
    ON chat_pending_message_parents(workspace_id, thread_id, parent_message_id);

CREATE TABLE chat_agent_read_state (
    workspace_id            TEXT    NOT NULL,
    thread_id               TEXT    NOT NULL,
    last_read_created_at_ms INTEGER NOT NULL,
    last_read_message_id    TEXT    NOT NULL,
    revision                INTEGER NOT NULL,
    updated_at_ms           INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, thread_id)
) STRICT;

CREATE TABLE chat_mentions (
    workspace_id  TEXT    NOT NULL,
    thread_id     TEXT    NOT NULL,
    message_id    TEXT    NOT NULL,
    handle        TEXT    NOT NULL,
    author_kind   TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent')),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id, handle)
) STRICT;

CREATE INDEX idx_chat_mentions_handle
    ON chat_mentions(workspace_id, handle, created_at_ms, message_id);

CREATE TABLE chat_follows (
    workspace_id  TEXT    NOT NULL,
    owner_user_id TEXT    NOT NULL,
    target_kind   TEXT    NOT NULL CHECK (target_kind IN ('person', 'agent', 'channel', 'thread')),
    target_id     TEXT    NOT NULL,
    state         TEXT    NOT NULL CHECK (state IN ('following', 'unfollowed')),
    updated_at_ms INTEGER NOT NULL,
    origin_id     TEXT    NOT NULL,
    origin_seq    INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, owner_user_id, target_kind, target_id)
) STRICT;

CREATE INDEX idx_chat_follows_active
    ON chat_follows(workspace_id, owner_user_id, state, target_kind, target_id);

CREATE TABLE chat_feed_read_state (
    workspace_id            TEXT    NOT NULL,
    owner_user_id           TEXT    NOT NULL,
    last_seen_created_at_ms INTEGER NOT NULL,
    last_seen_message_id    TEXT    NOT NULL,
    updated_at_ms           INTEGER NOT NULL,
    origin_id               TEXT    NOT NULL,
    origin_seq              INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, owner_user_id)
) STRICT;

CREATE TABLE chat_bookmarks (
    workspace_id     TEXT    NOT NULL,
    bookmark_id      TEXT    NOT NULL,
    owner_user_id    TEXT    NOT NULL,
    target_kind      TEXT    NOT NULL CHECK (target_kind IN ('message', 'thread')),
    target_id        TEXT    NOT NULL,
    thread_id        TEXT    NOT NULL,
    message_id       TEXT,
    mode             TEXT    NOT NULL CHECK (mode IN ('live', 'snapshot')),
    destination_path TEXT    NOT NULL,
    state            TEXT    NOT NULL CHECK (state IN ('active', 'archived')),
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, bookmark_id),
    UNIQUE (workspace_id, owner_user_id, target_kind, target_id)
) STRICT;

CREATE INDEX idx_chat_bookmarks_owner_state
    ON chat_bookmarks(workspace_id, owner_user_id, state, updated_at_ms DESC, bookmark_id);

CREATE INDEX idx_chat_bookmarks_live_thread
    ON chat_bookmarks(workspace_id, thread_id, mode, state);

CREATE TABLE chat_bookmark_outbox (
    workspace_id         TEXT    NOT NULL,
    bookmark_id          TEXT    NOT NULL,
    generation           INTEGER NOT NULL,
    projected_generation INTEGER NOT NULL DEFAULT 0,
    projection_state     TEXT    NOT NULL CHECK (projection_state IN ('pending', 'ready', 'failed', 'stale')),
    last_projected_at_ms INTEGER,
    projection_object_id TEXT,
    failure_reason       TEXT,
    updated_at_ms        INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, bookmark_id)
) STRICT;

CREATE INDEX idx_chat_bookmark_outbox_pending
    ON chat_bookmark_outbox(workspace_id, projection_state, updated_at_ms, bookmark_id);

CREATE TABLE chat_dispatch_ledger (
    workspace_id       TEXT    NOT NULL,
    trigger_message_id TEXT    NOT NULL,
    thread_id          TEXT    NOT NULL,
    state              TEXT    NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
    run_id             TEXT,
    failure_reason     TEXT,
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    created_at_ms      INTEGER NOT NULL,
    updated_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, trigger_message_id)
) STRICT;

CREATE INDEX idx_chat_dispatch_ledger_state
    ON chat_dispatch_ledger(workspace_id, state, created_at_ms, trigger_message_id);

CREATE TABLE chat_dispatch_scan_cursor (
    workspace_id      TEXT    NOT NULL,
    max_created_at_ms INTEGER NOT NULL,
    updated_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id)
) STRICT;

CREATE TABLE agent_run_records (
    workspace_id        TEXT    NOT NULL,
    run_id              TEXT    NOT NULL,
    thread_id           TEXT    NOT NULL,
    trigger_message_id  TEXT    NOT NULL,
    command             TEXT    NOT NULL,
    started_at_ms       INTEGER NOT NULL,
    ended_at_ms         INTEGER,
    exit_code           INTEGER,
    failure_reason      TEXT,
    log_path            TEXT,
    failure_note_posted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, run_id)
) STRICT;

CREATE INDEX idx_agent_run_records_thread_started
    ON agent_run_records(workspace_id, thread_id, started_at_ms);

CREATE UNIQUE INDEX idx_agent_run_records_run_id ON agent_run_records(run_id);

CREATE TABLE run_message_links (
    workspace_id TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    run_id       TEXT NOT NULL,
    PRIMARY KEY (workspace_id, message_id)
) STRICT;

CREATE INDEX idx_run_message_links_run
    ON run_message_links(workspace_id, run_id, message_id);

CREATE TABLE chat_dispatch_pause (
    workspace_id  TEXT    NOT NULL,
    thread_id     TEXT    NOT NULL,
    paused        INTEGER NOT NULL,
    reason        TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, thread_id)
) STRICT;

CREATE VIRTUAL TABLE engine_search_files_fts USING fts5(
    workspace_id UNINDEXED,
    version_id UNINDEXED,
    object_id UNINDEXED,
    path UNINDEXED,
    text,
    tokenize='trigram'
);

CREATE VIRTUAL TABLE engine_search_chat_messages_fts USING fts5(
    workspace_id UNINDEXED,
    thread_id UNINDEXED,
    message_id UNINDEXED,
    text,
    tokenize='trigram'
);

CREATE TABLE engine_search_index_state (
    workspace_id         TEXT    NOT NULL,
    version_id           TEXT    NOT NULL,
    indexed_at_ms        INTEGER NOT NULL,
    file_policy_degraded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, version_id)
) STRICT;

CREATE TABLE sync_identity (
    workspace_id       TEXT    NOT NULL PRIMARY KEY,
    origin_id          TEXT    NOT NULL,
    replication_epoch  TEXT    NOT NULL,
    stream_identity    TEXT    NOT NULL,
    created_at_ms      INTEGER NOT NULL
) STRICT;

CREATE TABLE replication_log (
    workspace_id   TEXT    NOT NULL,
    origin_id      TEXT    NOT NULL,
    origin_seq     INTEGER NOT NULL CHECK (origin_seq >= 0),
    op_kind        TEXT    NOT NULL,
    payload_json   TEXT    NOT NULL,
    recorded_at_ms INTEGER NOT NULL,
    imported       INTEGER NOT NULL CHECK (imported IN (0, 1)),
    apply_disposition TEXT NOT NULL DEFAULT 'applied'
      CHECK (apply_disposition IN ('applied', 'refused')),
    PRIMARY KEY (workspace_id, origin_id, origin_seq)
) STRICT;

CREATE INDEX idx_replication_log_order
    ON replication_log(workspace_id, recorded_at_ms, origin_id, origin_seq);

CREATE TABLE replication_refused_moment_blobs (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    role TEXT NOT NULL CHECK (role IN ('payload-before', 'payload-after', 'before')),
    text_sha256 TEXT REFERENCES blobs(sha256) ON DELETE RESTRICT,
    binary_sha256 TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    PRIMARY KEY (workspace_id, origin_id, origin_seq, role),
    CHECK ((text_sha256 IS NOT NULL) != (binary_sha256 IS NOT NULL)),
    FOREIGN KEY (workspace_id, origin_id, origin_seq)
      REFERENCES replication_log(workspace_id, origin_id, origin_seq) ON DELETE RESTRICT
) STRICT;
CREATE INDEX replication_refused_moment_text_blobs
    ON replication_refused_moment_blobs(text_sha256) WHERE text_sha256 IS NOT NULL;
CREATE INDEX replication_refused_moment_binary_blobs
    ON replication_refused_moment_blobs(binary_sha256) WHERE binary_sha256 IS NOT NULL;

CREATE TABLE replication_refused_ydoc_blobs (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    update_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    PRIMARY KEY (workspace_id, origin_id, origin_seq),
    FOREIGN KEY (workspace_id, origin_id, origin_seq)
      REFERENCES replication_log(workspace_id, origin_id, origin_seq) ON DELETE RESTRICT
) STRICT;
CREATE INDEX replication_refused_ydoc_binary_blobs
    ON replication_refused_ydoc_blobs(update_sha256);

CREATE TABLE replication_peers (
    workspace_id TEXT    NOT NULL,
    origin_id    TEXT    NOT NULL,
    acked_seq    INTEGER NOT NULL CHECK (acked_seq >= -1),
    retry_origin_seq INTEGER
    CHECK (retry_origin_seq IS NULL OR retry_origin_seq >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (retry_count >= 0),
    PRIMARY KEY (workspace_id, origin_id)
) STRICT;

CREATE TABLE sync_relay_cursors (
    workspace_id       TEXT NOT NULL PRIMARY KEY,
    cursor             TEXT NOT NULL,
    replication_epoch  TEXT NOT NULL,
    stream_identity    TEXT NOT NULL
) STRICT;

CREATE TABLE sync_relay_push_state (
    workspace_id TEXT    NOT NULL,
    origin_id    TEXT    NOT NULL,
    pushed_seq   INTEGER NOT NULL CHECK (pushed_seq >= -1),
    PRIMARY KEY (workspace_id, origin_id)
) STRICT;

CREATE TABLE shared_channel_cursors (
    workspace_id TEXT NOT NULL,
    share_id     TEXT NOT NULL,
    cursor       TEXT NOT NULL,
    PRIMARY KEY (workspace_id, share_id)
) STRICT;

CREATE TABLE shared_channel_peers (
    workspace_id       TEXT    NOT NULL,
    share_id           TEXT    NOT NULL,
    origin_id          TEXT    NOT NULL,
    applied_origin_seq INTEGER NOT NULL CHECK (applied_origin_seq >= -1),
    dense_seq          INTEGER NOT NULL CHECK (dense_seq >= -1),
    PRIMARY KEY (workspace_id, share_id, origin_id)
) STRICT;

CREATE TABLE shared_channel_push_state (
    workspace_id TEXT    NOT NULL,
    share_id     TEXT    NOT NULL,
    pushed_seq   INTEGER NOT NULL CHECK (pushed_seq >= -1),
    dense_seq INTEGER
    CHECK (dense_seq IS NULL OR dense_seq >= -1),
    PRIMARY KEY (workspace_id, share_id)
) STRICT;

CREATE TABLE share_view_cursors (
    workspace_id TEXT NOT NULL,
    share_id     TEXT NOT NULL,
    cursor       TEXT NOT NULL,
    PRIMARY KEY (workspace_id, share_id)
) STRICT;

CREATE TABLE shadow_clone (
    rowid_guard INTEGER NOT NULL PRIMARY KEY CHECK (rowid_guard = 1),
    token TEXT NOT NULL
) STRICT;

CREATE TABLE conflicts (
    workspace_id TEXT NOT NULL,
    conflict_id TEXT NOT NULL,
    path TEXT NOT NULL,
    target_version_id TEXT NOT NULL,
    source_version_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    chosen_from TEXT NOT NULL,
    resolution TEXT,
    metadata_origin TEXT NOT NULL,
    metadata_summary TEXT,
    metadata_correlation_id TEXT,
    base_exists INTEGER NOT NULL,
    base_path TEXT NOT NULL,
    base_object_id TEXT,
    base_content_kind TEXT DEFAULT 'text',
    base_blob_sha256 TEXT,
    base_updated_at_ms INTEGER,
    base_latest_moment_id TEXT,
    base_metadata_origin TEXT,
    base_metadata_summary TEXT,
    base_metadata_correlation_id TEXT,
    current_exists INTEGER NOT NULL,
    current_path TEXT NOT NULL,
    current_object_id TEXT,
    current_content_kind TEXT DEFAULT 'text',
    current_blob_sha256 TEXT,
    current_updated_at_ms INTEGER,
    current_latest_moment_id TEXT,
    current_metadata_origin TEXT,
    current_metadata_summary TEXT,
    current_metadata_correlation_id TEXT,
    incoming_exists INTEGER NOT NULL,
    incoming_path TEXT NOT NULL,
    incoming_object_id TEXT,
    incoming_content_kind TEXT DEFAULT 'text',
    incoming_blob_sha256 TEXT,
    incoming_updated_at_ms INTEGER,
    incoming_latest_moment_id TEXT,
    incoming_metadata_origin TEXT,
    incoming_metadata_summary TEXT,
    incoming_metadata_correlation_id TEXT,
    base_binary_sha256 TEXT,
    current_binary_sha256 TEXT,
    incoming_binary_sha256 TEXT,
    PRIMARY KEY (workspace_id, conflict_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (base_blob_sha256) REFERENCES blobs(sha256),
    FOREIGN KEY (current_blob_sha256) REFERENCES blobs(sha256),
    FOREIGN KEY (incoming_blob_sha256) REFERENCES blobs(sha256),
    FOREIGN KEY (base_binary_sha256) REFERENCES binary_blobs(sha256),
    FOREIGN KEY (current_binary_sha256) REFERENCES binary_blobs(sha256),
    FOREIGN KEY (incoming_binary_sha256) REFERENCES binary_blobs(sha256)
) STRICT;

CREATE INDEX idx_conflicts_workspace_status ON conflicts(workspace_id, status, created_at_ms, conflict_id);

CREATE TABLE snapshots (
    workspace_id     TEXT    NOT NULL,
    version_id       TEXT    NOT NULL,
    object_id        TEXT    NOT NULL,
    path             TEXT    NOT NULL,
    blob_sha256      TEXT,
    updated_at_ms    INTEGER NOT NULL,
    latest_moment_id TEXT    NOT NULL,
    metadata_origin  TEXT    NOT NULL,
    content_kind     TEXT    NOT NULL DEFAULT 'text'
                             CHECK (content_kind IN ('text', 'binary')),
    binary_sha256    TEXT    REFERENCES binary_blobs(sha256),
    metadata_summary TEXT,
    metadata_correlation_id TEXT,
    -- A head carries EXACTLY the digest for its kind: a text head has its text
    -- blob and no binary ref; a binary head has its binary ref and no text blob.
    -- Fail-closed at the DB level so a malformed dual/absent-digest union can
    -- never become durable state.
    CHECK (
        (content_kind = 'text'   AND blob_sha256   IS NOT NULL AND binary_sha256 IS NULL)
     OR (content_kind = 'binary' AND binary_sha256 IS NOT NULL AND blob_sha256   IS NULL)
    ),
    PRIMARY KEY (workspace_id, version_id, object_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
) STRICT;

CREATE TABLE fork_base_snapshots (
    workspace_id     TEXT    NOT NULL,
    version_id       TEXT    NOT NULL,
    object_id        TEXT    NOT NULL,
    path             TEXT    NOT NULL,
    blob_sha256      TEXT,
    updated_at_ms    INTEGER NOT NULL,
    latest_moment_id TEXT    NOT NULL,
    metadata_origin  TEXT    NOT NULL,
    content_kind     TEXT    NOT NULL DEFAULT 'text'
                             CHECK (content_kind IN ('text', 'binary')),
    binary_sha256    TEXT    REFERENCES binary_blobs(sha256),
    metadata_summary TEXT,
    metadata_correlation_id TEXT,
    CHECK (
        (content_kind = 'text'   AND blob_sha256   IS NOT NULL AND binary_sha256 IS NULL)
     OR (content_kind = 'binary' AND binary_sha256 IS NOT NULL AND blob_sha256   IS NULL)
    ),
    PRIMARY KEY (workspace_id, version_id, object_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
) STRICT;

CREATE TABLE moments (
    workspace_id      TEXT    NOT NULL,
    moment_order      INTEGER NOT NULL,
    moment_id         TEXT    NOT NULL,
    version_id        TEXT    NOT NULL,
    object_id         TEXT    NOT NULL,
    path              TEXT    NOT NULL,
    recorded_at_ms    INTEGER NOT NULL,
    operation         TEXT    NOT NULL,
    after_blob_sha256 TEXT,
    before_present    INTEGER NOT NULL,
    before_blob_sha256 TEXT,
    metadata_origin   TEXT    NOT NULL,
    author_json       TEXT,
    sync_record_only  INTEGER,
    before_latest_moment_id TEXT,
    after_content_kind TEXT NOT NULL DEFAULT 'text'
                       CHECK (after_content_kind IN ('text', 'binary')),
    after_binary_sha256 TEXT REFERENCES binary_blobs(sha256),
    before_content_kind TEXT NOT NULL DEFAULT 'text'
                        CHECK (before_content_kind IN ('text', 'binary')),
    before_binary_sha256 TEXT REFERENCES binary_blobs(sha256),
    payload_before_path TEXT,
    payload_before_content_kind TEXT,
    payload_before_blob_sha256 TEXT,
    payload_after_path TEXT,
    payload_after_content_kind TEXT,
    payload_after_blob_sha256 TEXT,
    metadata_summary TEXT,
    metadata_correlation_id TEXT,
    before_object_id TEXT,
    before_version_id TEXT,
    before_path TEXT,
    before_updated_at_ms INTEGER,
    before_metadata_origin TEXT,
    before_metadata_summary TEXT,
    before_metadata_correlation_id TEXT,
    -- The AFTER content of every moment carries exactly the digest matching its
    -- kind (a text moment its text blob, a binary moment its binary ref) and
    -- never the other kind's digest.
    CHECK (
        (after_content_kind = 'text'   AND after_blob_sha256   IS NOT NULL AND after_binary_sha256 IS NULL)
     OR (after_content_kind = 'binary' AND after_binary_sha256 IS NOT NULL AND after_blob_sha256   IS NULL)
    ),
    -- The BEFORE (rollback preimage) may be ABSENT (first write / no preimage),
    -- so only forbid the WRONG-kind digest: a text preimage never carries a
    -- binary ref and a binary preimage never carries a text blob.
    CHECK (
        (before_content_kind = 'text'   AND before_binary_sha256 IS NULL)
     OR (before_content_kind = 'binary' AND before_blob_sha256   IS NULL)
    ),
    PRIMARY KEY (workspace_id, moment_id),
    UNIQUE (workspace_id, moment_order),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (after_blob_sha256) REFERENCES blobs(sha256),
    FOREIGN KEY (before_blob_sha256) REFERENCES blobs(sha256)
) STRICT;

CREATE INDEX idx_moments_workspace_order ON moments(workspace_id, moment_order DESC);

CREATE INDEX idx_moments_version_order ON moments(workspace_id, version_id, moment_order DESC);

CREATE INDEX idx_moments_object_order ON moments(workspace_id, object_id, moment_order DESC);

CREATE INDEX idx_path_aliases_workspace_object ON path_aliases(workspace_id, object_id);

CREATE TABLE replication_pending_refusals (
    workspace_id   TEXT    NOT NULL,
    origin_id      TEXT    NOT NULL,
    origin_seq     INTEGER NOT NULL CHECK (origin_seq >= 0),
    op_kind        TEXT    NOT NULL,
    reason_code    TEXT    NOT NULL CHECK (reason_code IN (
        'invalid-input'
    )),
    reason_message TEXT    NOT NULL,
    report_id      TEXT,
    PRIMARY KEY (workspace_id, origin_id, origin_seq),
    FOREIGN KEY (workspace_id, origin_id, origin_seq)
      REFERENCES replication_log(workspace_id, origin_id, origin_seq)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX replication_pending_refusals_by_report
    ON replication_pending_refusals (workspace_id, report_id);

CREATE TABLE chat_pending_replication (
    workspace_id    TEXT    NOT NULL,
    origin_id       TEXT    NOT NULL,
    origin_seq      INTEGER NOT NULL,
    dependency_kind TEXT    NOT NULL CHECK (
      dependency_kind IN (
        'follow-target',
        'feed-message',
        'attachment-message',
        'message-thread'
      )
    ),
    dependency_id   TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, origin_id, origin_seq)
) STRICT;

CREATE INDEX chat_pending_replication_by_dependency
    ON chat_pending_replication (workspace_id, dependency_kind, dependency_id);

CREATE INDEX idx_materialization_jobs_workspace_path_status_generation
    ON materialization_jobs (
        workspace_id,
        target_path,
        status,
        target_generation
    );

CREATE TABLE ydoc_deferred_updates (
    workspace_id     TEXT    NOT NULL,
    version_id       TEXT    NOT NULL,
    object_id        TEXT    NOT NULL,
    origin_id        TEXT    NOT NULL,
    origin_seq       INTEGER NOT NULL CHECK (origin_seq >= 0),
    recorded_at_ms   INTEGER NOT NULL,
    lineage_claim_id TEXT
      CHECK (lineage_claim_id IS NULL OR (
        length(lineage_claim_id) = 64
        AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'
      )),
    relay_seq INTEGER
      CHECK (relay_seq IS NULL OR relay_seq >= 0),
    record_facts_json TEXT,
    PRIMARY KEY (workspace_id, origin_id, origin_seq),
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX ydoc_deferred_updates_by_doc
    ON ydoc_deferred_updates(workspace_id, version_id, object_id);

CREATE INDEX ydoc_deferred_updates_by_lineage
    ON ydoc_deferred_updates(
      workspace_id, version_id, object_id, lineage_claim_id, origin_id, origin_seq
    ) WHERE lineage_claim_id IS NOT NULL;

CREATE TABLE replication_pending_conflict_bundles (
    bundle_order            INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id            TEXT    NOT NULL,
    conflict_id             TEXT    NOT NULL,
    format_version          INTEGER NOT NULL CHECK (format_version = 1),
    pre_effect_moment_order INTEGER NOT NULL CHECK (pre_effect_moment_order >= 0),
    created_at_ms           INTEGER NOT NULL,
    UNIQUE (workspace_id, conflict_id),
    UNIQUE (bundle_order, workspace_id),
    FOREIGN KEY (workspace_id)
      REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX replication_pending_conflict_bundles_by_cut
    ON replication_pending_conflict_bundles(
      workspace_id, pre_effect_moment_order, bundle_order
    );

CREATE TABLE replication_pending_conflict_ops (
    bundle_order  INTEGER NOT NULL,
    op_index      INTEGER NOT NULL CHECK (op_index BETWEEN 0 AND 2),
    op_kind       TEXT    NOT NULL,
    payload_json  TEXT    NOT NULL
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (bundle_order, op_index),
    CHECK (
      (op_index = 0 AND op_kind = 'conflict.resolve')
      OR (op_index IN (1, 2) AND op_kind = 'moment.append')
    ),
    FOREIGN KEY (bundle_order)
      REFERENCES replication_pending_conflict_bundles(bundle_order)
      ON DELETE CASCADE
) STRICT;

CREATE TABLE replication_pending_conflict_moments (
    workspace_id TEXT    NOT NULL,
    bundle_order INTEGER NOT NULL,
    op_index     INTEGER NOT NULL CHECK (op_index IN (1, 2)),
    moment_id    TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, moment_id),
    UNIQUE (bundle_order, op_index),
    FOREIGN KEY (bundle_order, workspace_id)
      REFERENCES replication_pending_conflict_bundles(bundle_order, workspace_id)
      ON DELETE CASCADE,
    FOREIGN KEY (bundle_order, op_index)
      REFERENCES replication_pending_conflict_ops(bundle_order, op_index)
      ON DELETE CASCADE
) STRICT;

CREATE INDEX replication_pending_conflict_moments_by_bundle
    ON replication_pending_conflict_moments(bundle_order, op_index);

CREATE TABLE replication_pending_conflict_text_blobs (
    bundle_order INTEGER NOT NULL,
    blob_sha256  TEXT    NOT NULL,
    PRIMARY KEY (bundle_order, blob_sha256),
    FOREIGN KEY (bundle_order)
      REFERENCES replication_pending_conflict_bundles(bundle_order)
      ON DELETE CASCADE,
    FOREIGN KEY (blob_sha256)
      REFERENCES blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE replication_pending_conflict_binary_blobs (
    bundle_order INTEGER NOT NULL,
    blob_sha256  TEXT    NOT NULL,
    PRIMARY KEY (bundle_order, blob_sha256),
    FOREIGN KEY (bundle_order)
      REFERENCES replication_pending_conflict_bundles(bundle_order)
      ON DELETE CASCADE,
    FOREIGN KEY (blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE ydoc_base_relay_candidates (
    workspace_id     TEXT    NOT NULL,
    version_id       TEXT    NOT NULL,
    object_id        TEXT    NOT NULL,
    lineage_claim_id TEXT    NOT NULL
      CHECK (length(lineage_claim_id) = 64
             AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'),
    origin_id        TEXT    NOT NULL CHECK (length(origin_id) > 0),
    origin_seq       INTEGER NOT NULL CHECK (origin_seq >= 0),
    PRIMARY KEY (workspace_id, version_id, object_id, origin_id, origin_seq),
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (lineage_claim_id)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE INDEX ydoc_base_relay_candidates_by_doc
    ON ydoc_base_relay_candidates(workspace_id, version_id, object_id);

CREATE TABLE scene_asset_delete_authorities (
    workspace_id             TEXT NOT NULL,
    version_id               TEXT NOT NULL,
    drawing_object_id        TEXT NOT NULL,
    drawing_delete_moment_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version_id, drawing_delete_moment_id),
    FOREIGN KEY (workspace_id, version_id)
        REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, drawing_object_id)
        REFERENCES file_objects(workspace_id, object_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE scene_asset_delete_authority_items (
    workspace_id             TEXT NOT NULL,
    version_id               TEXT NOT NULL,
    drawing_delete_moment_id TEXT NOT NULL,
    asset_delete_moment_id   TEXT NOT NULL,
    asset_path               TEXT NOT NULL,
    asset_sha256             TEXT NOT NULL
        CHECK (length(asset_sha256) = 64
           AND asset_sha256 NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (workspace_id, version_id, drawing_delete_moment_id, asset_path),
    UNIQUE (workspace_id, asset_delete_moment_id),
    FOREIGN KEY (workspace_id, version_id, drawing_delete_moment_id)
        REFERENCES scene_asset_delete_authorities(
            workspace_id, version_id, drawing_delete_moment_id
        ) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_scene_asset_delete_authority_parent
    ON scene_asset_delete_authority_items (
        workspace_id,
        version_id,
        drawing_delete_moment_id
    );

CREATE TABLE ydoc_docs (
    workspace_id            TEXT    NOT NULL,
    version_id              TEXT    NOT NULL,
    object_id               TEXT    NOT NULL,
    content_kind            TEXT    NOT NULL DEFAULT 'richdoc'
                                    CHECK (content_kind IN ('plaintext', 'richdoc', 'scene')),
    regime                  TEXT    NOT NULL DEFAULT 'local-only'
                                    CHECK (regime IN ('local-only', 'replicated')),
    head_update_seq         INTEGER NOT NULL DEFAULT 0
                                    CHECK (head_update_seq >= 0),
    head_snapshot_seq       INTEGER NOT NULL DEFAULT 0
                                    CHECK (head_snapshot_seq >= 0),
    settle_seq              INTEGER NOT NULL DEFAULT 0
                                    CHECK (settle_seq >= 0),
    last_settled_sha        TEXT,
    updated_at_ms           INTEGER NOT NULL,
    path                    TEXT,
    lineage_claim_status    TEXT    NOT NULL DEFAULT 'unclaimed'
                                    CHECK (lineage_claim_status IN ('unclaimed', 'exact')),
    lineage_claim_id        TEXT
      CHECK (lineage_claim_id IS NULL OR (
        length(lineage_claim_id) = 64
        AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'
      )),
    lineage_parent_claim_id TEXT
      CHECK (lineage_parent_claim_id IS NULL OR (
        length(lineage_parent_claim_id) = 64
        AND lineage_parent_claim_id NOT GLOB '*[^0-9a-f]*'
      )),
    lineage_epoch_tag       TEXT
      CHECK (lineage_epoch_tag IS NULL OR (
        length(lineage_epoch_tag) = 64
        AND lineage_epoch_tag NOT GLOB '*[^0-9a-f]*'
      )),
    base_origin_id          TEXT,
    base_origin_seq         INTEGER
      CHECK (base_origin_seq IS NULL OR base_origin_seq >= 0),
    base_relay_seq          INTEGER
      CHECK (base_relay_seq IS NULL OR base_relay_seq >= 0),
    base_relay_confirmed_absent INTEGER NOT NULL DEFAULT 0
      CHECK (base_relay_confirmed_absent IN (0, 1)), seed_source_sha256 TEXT,
    PRIMARY KEY (workspace_id, version_id, object_id),
    CHECK (head_snapshot_seq <= head_update_seq),
    CHECK (
      (lineage_claim_status = 'unclaimed'
       AND lineage_claim_id IS NULL
       AND lineage_parent_claim_id IS NULL
       AND lineage_epoch_tag IS NULL)
      OR
      (regime = 'replicated'
       AND lineage_claim_status = 'exact'
       AND lineage_claim_id IS NOT NULL
       AND (
         (lineage_parent_claim_id IS NULL AND lineage_epoch_tag IS NULL)
         OR
         (lineage_parent_claim_id IS NOT NULL AND lineage_epoch_tag IS NOT NULL)
       ))
    ),
    CHECK (
      lineage_parent_claim_id IS NULL
      OR lineage_parent_claim_id <> lineage_claim_id
    ),
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (lineage_claim_id)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (lineage_parent_claim_id)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE ydoc_updates (
    workspace_id       TEXT    NOT NULL,
    version_id         TEXT    NOT NULL,
    object_id          TEXT    NOT NULL,
    seq                INTEGER NOT NULL CHECK (seq > 0),
    update_blob_sha256 TEXT    NOT NULL,
    actor_origin_id    TEXT,
    recorded_at_ms     INTEGER NOT NULL,
    actor_kind TEXT
    CHECK (actor_kind IN ('human','agent','automation')),
    on_behalf_of TEXT,
    chain_depth INTEGER
    CHECK (chain_depth IS NULL OR chain_depth >= 0),
    PRIMARY KEY (workspace_id, version_id, object_id, seq),
    FOREIGN KEY (update_blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, version_id, object_id)
      REFERENCES ydoc_docs(workspace_id, version_id, object_id)
      ON DELETE CASCADE
) STRICT;

CREATE TABLE ydoc_snapshots (
    workspace_id             TEXT    NOT NULL,
    version_id               TEXT    NOT NULL,
    object_id                TEXT    NOT NULL,
    up_to_seq                INTEGER NOT NULL CHECK (up_to_seq >= 0),
    snapshot_blob_sha256     TEXT    NOT NULL,
    state_vector_blob_sha256 TEXT    NOT NULL,
    recorded_at_ms           INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id, up_to_seq),
    FOREIGN KEY (snapshot_blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (state_vector_blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, version_id, object_id)
      REFERENCES ydoc_docs(workspace_id, version_id, object_id)
      ON DELETE CASCADE
) STRICT;

CREATE TABLE ydoc_inactive_lineages (
    workspace_id                           TEXT    NOT NULL,
    version_id                             TEXT    NOT NULL,
    object_id                              TEXT    NOT NULL,
    lineage_claim_id                       TEXT    NOT NULL
      CHECK (length(lineage_claim_id) = 64
             AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'),
    parent_claim_id                        TEXT
      CHECK (parent_claim_id IS NULL OR (
        length(parent_claim_id) = 64
        AND parent_claim_id NOT GLOB '*[^0-9a-f]*'
      )),
    disposition                            TEXT    NOT NULL CHECK (disposition IN (
      'superseded-predecessor', 'conflicting-successor', 'rejected-base'
    )),
    content_kind                           TEXT    NOT NULL
      CHECK (content_kind IN ('plaintext', 'richdoc', 'scene')),
    path                                   TEXT,
    epoch_tag                              TEXT
      CHECK (epoch_tag IS NULL OR (
        length(epoch_tag) = 64 AND epoch_tag NOT GLOB '*[^0-9a-f]*'
      )),
    full_state_blob_sha256                 TEXT    NOT NULL,
    state_vector_blob_sha256               TEXT    NOT NULL,
    last_surfaced_state_vector_blob_sha256 TEXT,
    last_surfaced_projection_sha256        TEXT
      CHECK (last_surfaced_projection_sha256 IS NULL OR (
        length(last_surfaced_projection_sha256) = 64
        AND last_surfaced_projection_sha256 NOT GLOB '*[^0-9a-f]*'
      )),
    open_conflict_id                       TEXT,
    recorded_at_ms                         INTEGER NOT NULL,
    updated_at_ms                          INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id, lineage_claim_id),
    CHECK (parent_claim_id IS NULL OR parent_claim_id <> lineage_claim_id),
    CHECK (
      (parent_claim_id IS NULL AND epoch_tag IS NULL)
      OR (parent_claim_id IS NOT NULL AND epoch_tag IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES file_objects(workspace_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (lineage_claim_id)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (parent_claim_id)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (full_state_blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (state_vector_blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (last_surfaced_state_vector_blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (last_surfaced_projection_sha256)
      REFERENCES blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, open_conflict_id)
      REFERENCES conflicts(workspace_id, conflict_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_ydoc_updates_doc_seq
    ON ydoc_updates(workspace_id, version_id, object_id, seq);

CREATE INDEX idx_ydoc_updates_doc_blob
    ON ydoc_updates(workspace_id, version_id, object_id, update_blob_sha256);

CREATE INDEX idx_ydoc_snapshots_doc_uptoseq
    ON ydoc_snapshots(workspace_id, version_id, object_id, up_to_seq DESC);

CREATE INDEX ydoc_inactive_lineages_by_disposition
    ON ydoc_inactive_lineages(
      workspace_id, version_id, object_id, disposition, lineage_claim_id
    );

CREATE INDEX ydoc_inactive_lineages_by_parent
    ON ydoc_inactive_lineages(
      workspace_id, version_id, object_id, parent_claim_id, lineage_claim_id
    ) WHERE parent_claim_id IS NOT NULL;

CREATE INDEX ydoc_inactive_lineages_by_open_conflict
    ON ydoc_inactive_lineages(workspace_id, open_conflict_id)
    WHERE open_conflict_id IS NOT NULL;

CREATE TABLE ydoc_recovery_decisions (
    workspace_id                    TEXT    NOT NULL,
    origin_id                       TEXT    NOT NULL CHECK (length(origin_id) > 0),
    origin_seq                      INTEGER NOT NULL CHECK (origin_seq >= 0),
    version_id                      TEXT    NOT NULL CHECK (length(version_id) > 0),
    object_id                       TEXT    NOT NULL CHECK (length(object_id) > 0),
    original_path                   TEXT    NOT NULL CHECK (length(original_path) > 0),
    incoming_content_kind           TEXT    NOT NULL
      CHECK (incoming_content_kind IN ('plaintext', 'richdoc', 'scene')),
    incoming_update_blob_sha256     TEXT    NOT NULL
      CHECK (length(incoming_update_blob_sha256) = 64
             AND incoming_update_blob_sha256 NOT GLOB '*[^0-9a-f]*'),
    incoming_lineage_claim_id       TEXT    NOT NULL
      CHECK (length(incoming_lineage_claim_id) = 64
             AND incoming_lineage_claim_id NOT GLOB '*[^0-9a-f]*'),
    incoming_is_base_state          INTEGER NOT NULL
      CHECK (incoming_is_base_state = 1),
    losing_claim_id                 TEXT    NOT NULL
      CHECK (length(losing_claim_id) = 64
             AND losing_claim_id NOT GLOB '*[^0-9a-f]*'),
    recovered_path                  TEXT    NOT NULL CHECK (length(recovered_path) > 0),
    recovery_collision_ordinal      TEXT    NOT NULL
      CHECK (length(recovery_collision_ordinal) > 0
             AND recovery_collision_ordinal NOT GLOB '*[^0-9]*'),
    recovery_object_id              TEXT    NOT NULL CHECK (length(recovery_object_id) > 0),
    recovery_moment_id              TEXT    NOT NULL CHECK (length(recovery_moment_id) > 0),
    recorded_at_ms                  INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
    PRIMARY KEY (workspace_id, origin_id, origin_seq),
    UNIQUE (workspace_id, recovery_object_id),
    UNIQUE (workspace_id, recovery_moment_id),
    FOREIGN KEY (workspace_id)
      REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (incoming_update_blob_sha256)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (incoming_lineage_claim_id)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (losing_claim_id)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE share_view_file_lane (
    workspace_id  TEXT    NOT NULL PRIMARY KEY,
    recorded_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE share_proposal_push_state (
    workspace_id TEXT    NOT NULL,
    share_id     TEXT    NOT NULL,
    scanned_seq  INTEGER NOT NULL CHECK (scanned_seq >= -1),
    PRIMARY KEY (workspace_id, share_id)
) STRICT;

CREATE INDEX idx_secret_moments_history_time
    ON secret_moments(workspace_id, version_id, recorded_at_ms DESC, moment_order DESC);

CREATE TABLE chat_conversation_revisions (
    workspace_id     TEXT    NOT NULL,
    thread_id        TEXT    NOT NULL,
    content_revision INTEGER NOT NULL CHECK (content_revision > 0),
    PRIMARY KEY (workspace_id, thread_id)
) STRICT;

CREATE TABLE collections (
    workspace_id             TEXT NOT NULL,
    version_id               TEXT NOT NULL,
    collection_path          TEXT NOT NULL,
    schema_path              TEXT NOT NULL,
    schema_status            TEXT NOT NULL
      CHECK (schema_status IN ('valid', 'degraded')),
    degradation_reasons_json TEXT NOT NULL CHECK (json_valid(degradation_reasons_json)),
    PRIMARY KEY (workspace_id, version_id, collection_path),
    FOREIGN KEY (workspace_id, version_id)
      REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE collection_records (
    workspace_id    TEXT NOT NULL,
    version_id      TEXT NOT NULL,
    record_id       TEXT,
    collection_path TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    object_id       TEXT NOT NULL,
    adoption_state  TEXT NOT NULL
      CHECK (adoption_state IN (
        'pending', 'pending-lossless', 'deferred-conflict', 'deferred-conflict-lossless', 'adopted'
      )),
    index_initialized INTEGER NOT NULL DEFAULT 0
      CHECK (index_initialized IN (0, 1)),
    PRIMARY KEY (workspace_id, version_id, file_path),
    UNIQUE (workspace_id, version_id, record_id),
    FOREIGN KEY (workspace_id, version_id, collection_path)
      REFERENCES collections(workspace_id, version_id, collection_path) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX collection_records_by_collection
    ON collection_records(workspace_id, version_id, collection_path, file_path);

CREATE TABLE collection_record_fields (
    workspace_id          TEXT NOT NULL,
    version_id            TEXT NOT NULL,
    record_id             TEXT NOT NULL,
    field_name            TEXT NOT NULL,
    value_json            TEXT NOT NULL CHECK (json_valid(value_json)),
    validation_status     TEXT NOT NULL
      CHECK (validation_status IN ('valid', 'flagged', 'untyped')),
    validation_reason_json TEXT CHECK (
      validation_reason_json IS NULL OR json_valid(validation_reason_json)
    ),
    PRIMARY KEY (workspace_id, version_id, record_id, field_name),
    FOREIGN KEY (workspace_id, version_id)
      REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE collection_field_history (
    history_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id           TEXT NOT NULL,
    version_id             TEXT NOT NULL,
    record_id              TEXT NOT NULL,
    field_name             TEXT NOT NULL,
    previous_value_json    TEXT CHECK (
      previous_value_json IS NULL OR json_valid(previous_value_json)
    ),
    next_value_json        TEXT CHECK (
      next_value_json IS NULL OR json_valid(next_value_json)
    ),
    author_origin_id       TEXT,
    source_origin_id       TEXT,
    source_origin_seq      INTEGER CHECK (
      source_origin_seq IS NULL OR source_origin_seq >= 0
    ),
    recorded_at_ms         INTEGER NOT NULL,
    actor_kind TEXT
    CHECK (actor_kind IN ('human','agent','automation')),
    on_behalf_of TEXT,
    chain_depth INTEGER
    CHECK (chain_depth IS NULL OR chain_depth >= 0),
    CHECK (
      (source_origin_id IS NULL AND source_origin_seq IS NULL) OR
      (source_origin_id IS NOT NULL AND source_origin_seq IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id, version_id)
      REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX collection_field_history_by_record
    ON collection_field_history(
      workspace_id, version_id, record_id, recorded_at_ms DESC, history_id DESC
    );

CREATE UNIQUE INDEX collection_field_history_by_source
    ON collection_field_history(
      workspace_id, version_id, record_id, field_name,
      source_origin_id, source_origin_seq
    ) WHERE source_origin_id IS NOT NULL;

CREATE TABLE collection_relation_edges (
    workspace_id          TEXT NOT NULL,
    version_id            TEXT NOT NULL,
    source_record_id      TEXT NOT NULL,
    field_name            TEXT NOT NULL,
    target_record_id      TEXT NOT NULL,
    target_collection_path TEXT NOT NULL,
    many                  INTEGER NOT NULL CHECK (many IN (0, 1)),
    PRIMARY KEY (
      workspace_id, version_id, source_record_id, field_name, target_record_id
    ),
    FOREIGN KEY (workspace_id, version_id)
      REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE collection_historical_record_owners (
    workspace_id          TEXT NOT NULL,
    version_id            TEXT NOT NULL,
    object_id             TEXT NOT NULL,
    moment_order          INTEGER NOT NULL CHECK (moment_order >= 0),
    record_id             TEXT NOT NULL,
    collection_path       TEXT NOT NULL,
    PRIMARY KEY (workspace_id, moment_order),
    FOREIGN KEY (workspace_id, moment_order)
      REFERENCES moments(workspace_id, moment_order) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, version_id)
      REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX collection_historical_record_owners_by_record
    ON collection_historical_record_owners(
      workspace_id, version_id, record_id, object_id
    );

CREATE INDEX collection_historical_record_owners_by_object
    ON collection_historical_record_owners(
      workspace_id, version_id, object_id, moment_order DESC
    );

CREATE TABLE collection_historical_record_owner_backfills (
    workspace_id          TEXT NOT NULL,
    version_id            TEXT NOT NULL,
    index_version         INTEGER NOT NULL CHECK (index_version = 1),
    PRIMARY KEY (workspace_id, version_id),
    FOREIGN KEY (workspace_id, version_id)
      REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_moments_global_order
    ON moments(moment_order DESC);

CREATE INDEX idx_materialization_jobs_mutation_generation
    ON materialization_jobs(target_generation DESC)
    WHERE job_id NOT GLOB 'version-switch-mat_*'
      AND job_id NOT GLOB 'version-switch-secret-mat_*';

CREATE TABLE automation_subscriptions (
    workspace_id  TEXT    NOT NULL,
    automation_id TEXT    NOT NULL,
    prefix        TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, automation_id, prefix)
) STRICT;

CREATE TABLE automation_claims (
    workspace_id       TEXT    NOT NULL,
    claim_id           TEXT    NOT NULL,
    automation_id      TEXT    NOT NULL,
    trigger_origin_id  TEXT,
    trigger_origin_seq INTEGER,
    trigger_history_id INTEGER,
    record_id          TEXT    NOT NULL,
    collection_path    TEXT    NOT NULL,
    depth              INTEGER NOT NULL CHECK (depth >= 0),
    state              TEXT    NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
    attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error              TEXT,
    created_at_ms      INTEGER NOT NULL,
    updated_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, claim_id),
    CHECK ((trigger_origin_id IS NULL) = (trigger_origin_seq IS NULL)),
    CHECK ((trigger_origin_id IS NOT NULL) <> (trigger_history_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX idx_automation_claims_trigger_coordinate
    ON automation_claims(workspace_id, automation_id, trigger_origin_id, trigger_origin_seq)
    WHERE trigger_origin_id IS NOT NULL;

CREATE UNIQUE INDEX idx_automation_claims_trigger_history
    ON automation_claims(workspace_id, automation_id, trigger_history_id)
    WHERE trigger_history_id IS NOT NULL;

CREATE INDEX idx_automation_claims_state
    ON automation_claims(workspace_id, state, created_at_ms, claim_id);

CREATE TABLE ydoc_owner_bindings (
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    relay_database_namespace TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
    accepted_cursor INTEGER NOT NULL CHECK (accepted_cursor >= 0),
    native_head_sequence INTEGER NOT NULL CHECK (native_head_sequence >= 0),
    checkpoint_digest TEXT NOT NULL REFERENCES binary_blobs(sha256),
    max_pending_bytes INTEGER NOT NULL CHECK (max_pending_bytes > 0),
    max_pending_age_ms INTEGER NOT NULL CHECK (max_pending_age_ms > 0),
    PRIMARY KEY (workspace_id, main_version_id, object_id, lineage_claim_id)
) STRICT;

CREATE TABLE ydoc_owner_applied_frames (
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
    relay_database_namespace TEXT NOT NULL,
    journal_cursor INTEGER NOT NULL CHECK(journal_cursor > 0),
    previous_cursor INTEGER NOT NULL CHECK(previous_cursor >= 0 AND previous_cursor < journal_cursor),
    update_digest TEXT NOT NULL,
    previous_revision INTEGER NOT NULL CHECK(previous_revision > 0),
    previous_native_head INTEGER NOT NULL CHECK(previous_native_head >= 0),
    native_head_sequence INTEGER NOT NULL CHECK(native_head_sequence >= 0),
    PRIMARY KEY(workspace_id,main_version_id,object_id,lineage_claim_id,journal_cursor)
) STRICT;

CREATE TABLE live_owner_adoptions (
    relay_database_namespace TEXT NOT NULL,
    adoption_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    source_moment_id TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    source_byte_length INTEGER NOT NULL CHECK (source_byte_length >= 0),
    baseline_moment_relay_sequence INTEGER NOT NULL CHECK (baseline_moment_relay_sequence >= 0),
    baseline_registered_at_ms INTEGER NOT NULL CHECK (baseline_registered_at_ms >= 0),
    evidence_digest TEXT NOT NULL,
    coverage_digest TEXT NOT NULL,
    covered_outbox_sequence INTEGER NOT NULL CHECK (covered_outbox_sequence >= 0),
    local_ydoc_sequence INTEGER NOT NULL CHECK (local_ydoc_sequence >= 0),
    terminal_cursor INTEGER NOT NULL CHECK (terminal_cursor >= 0),
    terminal_receipt_json TEXT NOT NULL CHECK (json_valid(terminal_receipt_json)),
    host_coordinate_json TEXT NOT NULL CHECK (json_valid(host_coordinate_json)),
    max_pending_bytes INTEGER NOT NULL CHECK (max_pending_bytes BETWEEN 1 AND 9007199254740991),
    max_pending_age_ms INTEGER NOT NULL CHECK (max_pending_age_ms BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (relay_database_namespace, adoption_id),
    UNIQUE (workspace_id, main_version_id, object_id, lineage_claim_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (lineage_claim_id) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (source_digest) REFERENCES blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE live_device_bootstraps (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) > 0),
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    bootstrap_id TEXT NOT NULL CHECK (length(CAST(bootstrap_id AS BLOB)) BETWEEN 1 AND 512),
    bootstrap_moment_id TEXT NOT NULL CHECK (length(CAST(bootstrap_moment_id AS BLOB)) BETWEEN 1 AND 512),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    baseline_digest TEXT NOT NULL CHECK (length(baseline_digest) = 64 AND baseline_digest NOT GLOB '*[^0-9a-f]*'),
    baseline_byte_length INTEGER NOT NULL CHECK (baseline_byte_length BETWEEN 2 AND 20971520),
    baseline_moment_relay_sequence INTEGER NOT NULL CHECK (baseline_moment_relay_sequence BETWEEN 0 AND 9007199254740991),
    baseline_registered_at_ms INTEGER NOT NULL CHECK (baseline_registered_at_ms BETWEEN 0 AND 9007199254740991),
    projected_markdown_digest TEXT NOT NULL CHECK (length(projected_markdown_digest) = 64 AND projected_markdown_digest NOT GLOB '*[^0-9a-f]*'),
    projected_markdown_byte_length INTEGER NOT NULL CHECK (projected_markdown_byte_length BETWEEN 0 AND 10485760),
    local_ydoc_sequence INTEGER NOT NULL CHECK (local_ydoc_sequence BETWEEN 0 AND 9007199254740991),
    host_coordinate_json TEXT NOT NULL CHECK (json_valid(host_coordinate_json)),
    PRIMARY KEY (relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id),
    UNIQUE (relay_database_namespace, bootstrap_id),
    UNIQUE (workspace_id, bootstrap_moment_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (baseline_digest) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE live_accepted_updates (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 9007199254740991),
    journal_cursor INTEGER NOT NULL CHECK (journal_cursor BETWEEN 1 AND 9007199254740991),
    delivery_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    update_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    suffix_count INTEGER NOT NULL CHECK (suffix_count BETWEEN 1 AND 4095),
    suffix_bytes INTEGER NOT NULL CHECK (suffix_bytes BETWEEN 1 AND 41943040),
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, event_count),
    UNIQUE (relay_database_namespace, delivery_id),
    UNIQUE (relay_database_namespace, journal_cursor),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX live_accepted_updates_cursor ON live_accepted_updates
    (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,journal_cursor);

CREATE TABLE live_accepted_checkpoints (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    event_count INTEGER NOT NULL CHECK (event_count BETWEEN 0 AND 9007199254740991),
    journal_cursor INTEGER NOT NULL CHECK (journal_cursor BETWEEN 0 AND 9007199254740991),
    terminal_json TEXT NOT NULL CHECK (json_valid(terminal_json)),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    origin_stamp TEXT NOT NULL CHECK (length(origin_stamp)=64 AND origin_stamp NOT GLOB '*[^0-9a-f]*'),
    state_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
    restore_operation_id TEXT,
    restore_stamp TEXT,
    CHECK ((restore_operation_id IS NULL AND restore_stamp IS NULL) OR (event_count>0 AND restore_operation_id IS NOT NULL AND restore_stamp IS NOT NULL AND length(restore_stamp)=64)),
    FOREIGN KEY (relay_database_namespace,restore_operation_id) REFERENCES live_restore_fences(relay_database_namespace,operation_id) ON DELETE RESTRICT,
    PRIMARY KEY (relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, event_count),
    UNIQUE (relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, journal_cursor),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE live_restore_fences (
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    relay_database_namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    input_json TEXT NOT NULL CHECK (json_valid(input_json)),
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
    proposal_candidate_sha256 TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    proposal_frozen_sha256 TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    proposal_point_sha256 TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    application_json TEXT CHECK (application_json IS NULL OR json_valid(application_json)),
    application_delivery_id TEXT,
    lineage_claim_id TEXT GENERATED ALWAYS AS (json_extract(input_json,'$.oldBinding.lineageClaimId')) VIRTUAL,
    old_generation INTEGER GENERATED ALWAYS AS (json_extract(input_json,'$.oldBinding.restoreFenceGeneration')) VIRTUAL,
    new_generation INTEGER GENERATED ALWAYS AS (json_extract(input_json,'$.newFence')) VIRTUAL,
    previous_operation_id TEXT,
    resume_receipt_json TEXT CHECK (resume_receipt_json IS NULL OR json_valid(resume_receipt_json)),
    resume_settlement_id TEXT REFERENCES live_device_settlements(settlement_id) ON DELETE RESTRICT,
    resume_evidence_digest TEXT,
    CHECK ((resume_receipt_json IS NULL AND resume_settlement_id IS NULL AND resume_evidence_digest IS NULL)
        OR (resume_receipt_json IS NOT NULL AND resume_settlement_id IS NOT NULL AND application_json IS NOT NULL
            AND resume_evidence_digest IS NOT NULL AND length(resume_evidence_digest)=64 AND resume_evidence_digest NOT GLOB '*[^0-9a-f]*')),
    CHECK ((application_json IS NULL AND application_delivery_id IS NULL)
        OR (application_json IS NOT NULL AND application_delivery_id IS NOT NULL AND proposal_json IS NOT NULL)),
    CHECK ((proposal_json IS NULL AND proposal_candidate_sha256 IS NULL AND proposal_frozen_sha256 IS NULL AND proposal_point_sha256 IS NULL)
        OR (proposal_json IS NOT NULL AND proposal_candidate_sha256 IS NOT NULL AND proposal_frozen_sha256 IS NOT NULL AND proposal_point_sha256 IS NOT NULL)),
    PRIMARY KEY (relay_database_namespace, operation_id),
    UNIQUE (relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, new_generation),
    FOREIGN KEY (relay_database_namespace, previous_operation_id)
        REFERENCES live_restore_fences(relay_database_namespace, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (relay_database_namespace, workspace_id, application_delivery_id)
        REFERENCES live_device_update_applications(relay_database_namespace, workspace_id, delivery_id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX live_restore_active ON live_restore_fences(workspace_id,main_version_id,object_id)
    WHERE resume_receipt_json IS NULL;
CREATE INDEX live_restore_document_generation ON live_restore_fences(workspace_id,main_version_id,object_id,new_generation);
CREATE UNIQUE INDEX live_restore_application_delivery ON live_restore_fences(relay_database_namespace,application_delivery_id)
    WHERE application_delivery_id IS NOT NULL;

CREATE TABLE live_device_settlements (
    settlement_id TEXT NOT NULL PRIMARY KEY,
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
    main_version_id TEXT NOT NULL CHECK (length(CAST(main_version_id AS BLOB)) BETWEEN 1 AND 512),
    object_id TEXT NOT NULL CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
    lineage_claim_id TEXT NOT NULL CHECK (length(CAST(lineage_claim_id AS BLOB)) BETWEEN 1 AND 512),
    previous_cursor INTEGER NOT NULL CHECK (previous_cursor BETWEEN 0 AND 9007199254740991),
    terminal_cursor INTEGER NOT NULL CHECK (terminal_cursor BETWEEN previous_cursor AND 9007199254740991),
    previous_ydoc_sequence INTEGER NOT NULL CHECK (previous_ydoc_sequence BETWEEN 0 AND 9007199254740991),
    local_ydoc_sequence INTEGER NOT NULL CHECK (local_ydoc_sequence BETWEEN previous_ydoc_sequence AND 9007199254740991),
    application_count INTEGER NOT NULL CHECK (application_count BETWEEN 0 AND 9007199254740991),
    interval_digest TEXT NOT NULL CHECK (length(interval_digest)=64 AND interval_digest NOT GLOB '*[^0-9a-f]*'),
    moment_id TEXT NOT NULL CHECK (length(CAST(moment_id AS BLOB)) BETWEEN 1 AND 512),
    markdown_digest TEXT NOT NULL CHECK (length(markdown_digest)=64 AND markdown_digest NOT GLOB '*[^0-9a-f]*'),
    source_state_vector_digest TEXT NOT NULL CHECK (length(source_state_vector_digest)=64 AND source_state_vector_digest NOT GLOB '*[^0-9a-f]*'),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    host_coordinate_json TEXT NOT NULL CHECK (json_valid(host_coordinate_json)),
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
    settlement_kind TEXT NOT NULL DEFAULT 'ordinary' CHECK (settlement_kind IN ('ordinary','restore')),
    restore_operation_id TEXT,
    CHECK ((settlement_kind='ordinary' AND restore_operation_id IS NULL)
        OR (settlement_kind='restore' AND restore_operation_id IS NOT NULL)),
    UNIQUE (relay_database_namespace, restore_operation_id),
    FOREIGN KEY (relay_database_namespace, restore_operation_id)
        REFERENCES live_restore_fences(relay_database_namespace, operation_id) ON DELETE RESTRICT,
    UNIQUE (relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, terminal_cursor),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE ydoc_owner_activation_sources (
    activation_id TEXT PRIMARY KEY,
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    source_moment_id TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    full_state_digest TEXT NOT NULL,
    descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
    FOREIGN KEY (lineage_claim_id) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (source_digest) REFERENCES blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (full_state_digest) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ydoc_owner_activation_source_document
    ON ydoc_owner_activation_sources(relay_database_namespace,workspace_id,version_id,object_id,lineage_claim_id);

CREATE TABLE ydoc_owner_base_sources (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    path TEXT NOT NULL,
    source_moment_id TEXT NOT NULL,
    source_blob_sha256 TEXT NOT NULL,
    source_byte_length INTEGER NOT NULL CHECK (source_byte_length >= 0),
    PRIMARY KEY (workspace_id, version_id, object_id, lineage_claim_id),
    FOREIGN KEY (workspace_id, version_id, object_id) REFERENCES ydoc_docs(workspace_id, version_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (lineage_claim_id) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (source_blob_sha256) REFERENCES blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE live_device_application_bindings (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) > 0),
    workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
    main_version_id TEXT NOT NULL CHECK (length(CAST(main_version_id AS BLOB)) BETWEEN 1 AND 512),
    object_id TEXT NOT NULL CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
    lineage_claim_id TEXT NOT NULL CHECK (length(CAST(lineage_claim_id AS BLOB)) BETWEEN 1 AND 512),
    current_path TEXT NOT NULL CHECK (length(CAST(current_path AS BLOB)) BETWEEN 1 AND 1024),
    selector_paths_json TEXT NOT NULL CHECK (json_valid(selector_paths_json)),
    restore_fence_generation INTEGER NOT NULL CHECK (restore_fence_generation BETWEEN 0 AND 9007199254740991),
    host_id TEXT NOT NULL CHECK (length(CAST(host_id AS BLOB)) BETWEEN 1 AND 1024),
    host_epoch INTEGER NOT NULL CHECK (host_epoch BETWEEN 1 AND 9007199254740991),
    instance_id TEXT NOT NULL CHECK (length(CAST(instance_id AS BLOB)) BETWEEN 1 AND 1024),
    connection_id TEXT NOT NULL CHECK (length(CAST(connection_id AS BLOB)) BETWEEN 1 AND 1024),
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    PRIMARY KEY (relay_database_namespace, workspace_id, main_version_id, object_id)
) STRICT;

CREATE TABLE live_device_update_applications (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) > 0),
    workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
    delivery_id TEXT NOT NULL CHECK (length(CAST(delivery_id AS BLOB)) BETWEEN 1 AND 512),
    main_version_id TEXT NOT NULL CHECK (length(CAST(main_version_id AS BLOB)) BETWEEN 1 AND 512),
    object_id TEXT NOT NULL CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
    lineage_claim_id TEXT NOT NULL CHECK (length(CAST(lineage_claim_id AS BLOB)) BETWEEN 1 AND 512),
    current_path TEXT NOT NULL CHECK (length(CAST(current_path AS BLOB)) BETWEEN 1 AND 1024),
    selector_paths_json TEXT NOT NULL CHECK (json_valid(selector_paths_json)),
    restore_fence_generation INTEGER NOT NULL CHECK (restore_fence_generation BETWEEN 0 AND 9007199254740991),
    update_digest TEXT NOT NULL CHECK (length(update_digest) = 64 AND update_digest NOT GLOB '*[^0-9a-f]*'),
    update_byte_length INTEGER NOT NULL CHECK (update_byte_length BETWEEN 1 AND 9007199254740991),
    journal_cursor INTEGER NOT NULL CHECK (journal_cursor BETWEEN 1 AND 9007199254740991),
    accepting_host_epoch INTEGER NOT NULL CHECK (accepting_host_epoch BETWEEN 1 AND 9007199254740991),
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('owner', 'named', 'link')),
    principal_id TEXT NOT NULL CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 512),
    grant_id TEXT CHECK (grant_id IS NULL OR length(CAST(grant_id AS BLOB)) BETWEEN 1 AND 512),
    grant_generation INTEGER CHECK (grant_generation IS NULL OR grant_generation BETWEEN 1 AND 9007199254740991),
    received_at_ms INTEGER NOT NULL CHECK (received_at_ms BETWEEN 0 AND 9007199254740991),
    first_seen_count INTEGER NOT NULL CHECK (first_seen_count BETWEEN 0 AND 9007199254740991),
    local_ydoc_sequence INTEGER NOT NULL CHECK (local_ydoc_sequence BETWEEN 1 AND 9007199254740991),
    applied_host_id TEXT NOT NULL CHECK (length(CAST(applied_host_id AS BLOB)) BETWEEN 1 AND 1024),
    applied_host_epoch INTEGER NOT NULL CHECK (applied_host_epoch BETWEEN 1 AND 9007199254740991),
    applied_instance_id TEXT NOT NULL CHECK (length(CAST(applied_instance_id AS BLOB)) BETWEEN 1 AND 1024),
    applied_connection_id TEXT NOT NULL CHECK (length(CAST(applied_connection_id AS BLOB)) BETWEEN 1 AND 1024),
    CHECK ((principal_kind = 'owner' AND grant_id IS NULL AND grant_generation IS NULL)
        OR (principal_kind IN ('named', 'link') AND grant_id IS NOT NULL AND grant_generation IS NOT NULL)),
    PRIMARY KEY (relay_database_namespace, workspace_id, delivery_id),
    UNIQUE (relay_database_namespace, delivery_id),
    UNIQUE (relay_database_namespace, journal_cursor),
    FOREIGN KEY (update_digest) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE INDEX live_device_applications_document_cursor
    ON live_device_update_applications(relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, journal_cursor);
CREATE INDEX live_device_bindings_document
    ON live_device_application_bindings(workspace_id, main_version_id, object_id);
CREATE INDEX live_device_applications_content
    ON live_device_update_applications(relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, update_digest);

CREATE TABLE live_device_application_first_seen (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) > 0),
    workspace_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
    client_id INTEGER NOT NULL CHECK (client_id BETWEEN 0 AND 9007199254740991),
    start_clock INTEGER NOT NULL CHECK (start_clock BETWEEN 0 AND 4294967294),
    end_clock INTEGER NOT NULL CHECK (end_clock BETWEEN 1 AND 4294967295),
    CHECK (start_clock < end_clock),
    PRIMARY KEY (relay_database_namespace, workspace_id, delivery_id, ordinal),
    FOREIGN KEY (relay_database_namespace, workspace_id, delivery_id)
        REFERENCES live_device_update_applications(relay_database_namespace, workspace_id, delivery_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX live_device_application_delivery_ranges
    ON live_device_application_first_seen(relay_database_namespace, delivery_id, ordinal);

-- Portable historical evidence is separate from native live authority.
CREATE TABLE live_audit_base_publications (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    base_blob_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    PRIMARY KEY (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id),
    FOREIGN KEY (workspace_id,origin_id,origin_seq)
      REFERENCES replication_log(workspace_id,origin_id,origin_seq) ON DELETE RESTRICT
) STRICT;

CREATE TABLE live_audit_bases (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    base_blob_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    PRIMARY KEY (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id)
) STRICT;

CREATE TABLE live_audit_base_conflicts (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    record_digest TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    base_blob_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    PRIMARY KEY (workspace_id,origin_id,origin_seq),
    FOREIGN KEY (workspace_id,origin_id,origin_seq)
      REFERENCES replication_log(workspace_id,origin_id,origin_seq) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- Owner update recovery stays independent of live document and version rows.
CREATE TABLE live_audit_record_manifests (
    record_digest TEXT PRIMARY KEY NOT NULL,
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
    update_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;
CREATE INDEX live_audit_manifest_updates ON live_audit_record_manifests(update_sha256);
CREATE TABLE live_audit_pending_exports (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    after_event_count INTEGER NOT NULL CHECK(after_event_count BETWEEN 0 AND 9007199254740991),
    after_settlement_cursor INTEGER NOT NULL DEFAULT -1 CHECK(after_settlement_cursor BETWEEN -1 AND 9007199254740991),
    PRIMARY KEY(workspace_id,relay_database_namespace,main_version_id,object_id,lineage_claim_id)
) STRICT;
CREATE INDEX live_accepted_enrollment_streams ON live_accepted_checkpoints(workspace_id,event_count,relay_database_namespace,main_version_id,object_id,lineage_claim_id);
CREATE TABLE live_audit_settlements (
    settlement_id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    markdown_digest TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT
) STRICT;
CREATE TABLE live_audit_settlement_publications (
    settlement_id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    relay_database_namespace TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    terminal_cursor INTEGER NOT NULL CHECK(terminal_cursor BETWEEN 0 AND 9007199254740991),
    markdown_digest TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    FOREIGN KEY(workspace_id,origin_id,origin_seq) REFERENCES replication_log(workspace_id,origin_id,origin_seq) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX live_audit_settlement_export_stream ON live_audit_settlement_publications(workspace_id,relay_database_namespace,main_version_id,object_id,lineage_claim_id,terminal_cursor);
CREATE TABLE live_audit_settlement_conflicts (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    record_digest TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    markdown_digest TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
    PRIMARY KEY(workspace_id,origin_id,origin_seq),
    FOREIGN KEY(workspace_id,origin_id,origin_seq) REFERENCES replication_log(workspace_id,origin_id,origin_seq) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE live_audit_record_chunks (
    record_digest TEXT NOT NULL REFERENCES live_audit_record_manifests(record_digest) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 1024),
    chunk_sha256 TEXT NOT NULL REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    PRIMARY KEY(record_digest,ordinal)
) STRICT;
CREATE INDEX live_audit_chunk_roots ON live_audit_record_chunks(chunk_sha256);
CREATE TABLE live_audit_events (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 9007199254740991),
    record_digest TEXT NOT NULL REFERENCES live_audit_record_manifests(record_digest) ON DELETE RESTRICT,
    evidence_digest TEXT NOT NULL,
    journal_cursor INTEGER NOT NULL CHECK(journal_cursor BETWEEN 1 AND 9007199254740991),
    delivery_id TEXT NOT NULL,
    accepting_host_epoch INTEGER NOT NULL CHECK(accepting_host_epoch BETWEEN 1 AND 9007199254740991),
    restore_operation_id TEXT,
    restore_markdown_digest TEXT,
    CHECK ((restore_operation_id IS NULL AND restore_markdown_digest IS NULL) OR
           (restore_operation_id IS NOT NULL AND restore_markdown_digest IS NOT NULL)),
    PRIMARY KEY(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count),
    UNIQUE(relay_database_namespace,journal_cursor),
    UNIQUE(relay_database_namespace,delivery_id)
) STRICT;
CREATE INDEX live_audit_event_interval ON live_audit_events(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,journal_cursor);
CREATE TABLE live_audit_event_publications (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    PRIMARY KEY(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count),
    FOREIGN KEY(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count)
      REFERENCES live_audit_events(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count) ON DELETE RESTRICT,
    FOREIGN KEY(workspace_id,origin_id,origin_seq) REFERENCES replication_log(workspace_id,origin_id,origin_seq) ON DELETE RESTRICT
) STRICT;
CREATE TABLE live_audit_event_conflicts (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    record_digest TEXT NOT NULL REFERENCES live_audit_record_manifests(record_digest) ON DELETE RESTRICT,
    PRIMARY KEY(workspace_id,origin_id,origin_seq),
    FOREIGN KEY(workspace_id,origin_id,origin_seq) REFERENCES replication_log(workspace_id,origin_id,origin_seq) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX replication_ydoc_content ON replication_log(workspace_id,
    json_extract(payload_json,'$.versionId'),json_extract(payload_json,'$.objectId'),
    json_extract(payload_json,'$.lineageClaimId'),json_extract(payload_json,'$.updateBlobSha256'),
    json_extract(payload_json,'$.path'),origin_id,origin_seq) WHERE op_kind='ydoc.update';

CREATE TABLE owner_ydoc_outboxes (
    outbox_id                 TEXT NOT NULL PRIMARY KEY,
    workspace_id              TEXT NOT NULL,
    main_version_id           TEXT NOT NULL,
    object_id                 TEXT NOT NULL,
    lineage_claim_id          TEXT NOT NULL,
    current_path              TEXT NOT NULL,
    selector_paths_json       TEXT NOT NULL CHECK (json_valid(selector_paths_json)),
    restore_fence_generation  INTEGER NOT NULL CHECK (restore_fence_generation >= 0),
    base_update_digest        TEXT NOT NULL,
    base_blob_digest          TEXT NOT NULL,
    base_byte_length          INTEGER NOT NULL CHECK (base_byte_length > 0),
    state                     TEXT NOT NULL CHECK (state IN ('active', 'sealed', 'quarantined')),
    pending_bytes             INTEGER NOT NULL CHECK (pending_bytes >= 0),
    oldest_entry_at_ms        INTEGER CHECK (oldest_entry_at_ms IS NULL OR oldest_entry_at_ms >= 0),
    next_sequence             INTEGER NOT NULL CHECK (next_sequence >= 1),
    quarantine_reason         TEXT,
    observed_binding_json     TEXT CHECK (
      observed_binding_json IS NULL OR json_valid(observed_binding_json)
    ),
    created_at_ms             INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK (
      (state = 'quarantined' AND quarantine_reason IS NOT NULL) OR
      (state != 'quarantined' AND quarantine_reason IS NULL AND observed_binding_json IS NULL)
    ),
    CHECK (
      (pending_bytes = 0 AND oldest_entry_at_ms IS NULL) OR
      (pending_bytes > 0 AND oldest_entry_at_ms IS NOT NULL)
    ),
    UNIQUE (workspace_id, main_version_id, object_id, lineage_claim_id, restore_fence_generation),
    FOREIGN KEY (base_blob_digest)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE owner_ydoc_outbox_entries (
    outbox_id                TEXT NOT NULL,
    sequence                 INTEGER NOT NULL CHECK (sequence >= 1),
    append_key               TEXT NOT NULL UNIQUE,
    delivery_id              TEXT NOT NULL UNIQUE,
    update_digest            TEXT NOT NULL,
    native_source_json       TEXT CHECK (native_source_json IS NULL OR json_valid(native_source_json)),
    accepted_receipt_json    TEXT CHECK (accepted_receipt_json IS NULL OR json_valid(accepted_receipt_json)),
    update_blob_digest       TEXT,
    byte_length              INTEGER NOT NULL CHECK (byte_length > 0),
    created_at_ms            INTEGER NOT NULL CHECK (created_at_ms >= 0),
    pending                  INTEGER NOT NULL CHECK (pending IN (0, 1)),
    result_pending_bytes     INTEGER NOT NULL CHECK (result_pending_bytes > 0),
    result_oldest_entry_at_ms INTEGER NOT NULL CHECK (result_oldest_entry_at_ms >= 0),
    result_state             TEXT NOT NULL CHECK (result_state IN ('active', 'sealed')),
    CHECK (
      (pending = 1 AND update_blob_digest IS NOT NULL) OR
      (pending = 0 AND update_blob_digest IS NULL)
    ),
    PRIMARY KEY (outbox_id, sequence),
    FOREIGN KEY (outbox_id)
      REFERENCES owner_ydoc_outboxes(outbox_id) ON DELETE RESTRICT,
    FOREIGN KEY (update_blob_digest)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;
CREATE INDEX owner_ydoc_outbox_entries_pending
    ON owner_ydoc_outbox_entries(outbox_id, sequence) WHERE pending=1;
";

/// Migration 1: a channel is a group. It has a type (what it holds), a
/// purpose (one line), and a folder path. A thread has a lane: the posts
/// lane is the feed; the chat lane is one running conversation per group. A
/// decision can carry options and the one chosen.
///
/// Every column defaults, so rows written before this migration keep their
/// meaning: a channel is a posts group with no folder, a thread is a post,
/// a decision is a bare question.
pub(crate) const V2_GROUPS_MIGRATION_ID: &str = "v2-groups";
const V2_GROUPS_DDL: &str = "\
ALTER TABLE chat_channels ADD COLUMN type TEXT NOT NULL DEFAULT 'posts'
    CHECK (type IN ('posts', 'chat', 'both'));
ALTER TABLE chat_channels ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_channels ADD COLUMN folder_path TEXT;
ALTER TABLE chat_threads ADD COLUMN lane TEXT NOT NULL DEFAULT 'posts'
    CHECK (lane IN ('posts', 'chat'));
ALTER TABLE chat_decisions ADD COLUMN options_json TEXT;
ALTER TABLE chat_decisions ADD COLUMN chosen_option TEXT;
";

const V2_AGENT_OWNER_DDL: &str = "\
ALTER TABLE chat_messages ADD COLUMN author_owner_display_name TEXT;
";

const V2_OWNER_SETTLEMENT_LOOKUP_DDL: &str = "\
CREATE INDEX live_audit_settlement_moment ON live_audit_settlements(
    workspace_id, json_extract(record_json,'$.momentId'), markdown_digest
);
CREATE INDEX replication_log_moment ON replication_log(
    workspace_id, json_extract(payload_json,'$.momentId')
) WHERE op_kind='moment.append';
";

const V2_OWNER_PENDING_SETTLEMENTS_DDL: &str = "\
CREATE TABLE owner_pending_settlements (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    relay_namespace TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    terminal_cursor INTEGER NOT NULL CHECK (terminal_cursor >= 0),
    checked_sequence INTEGER NOT NULL DEFAULT 0 CHECK (checked_sequence >= 0),
    record_facts_json TEXT CHECK (record_facts_json IS NULL OR json_valid(record_facts_json)),
    applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
    report_id TEXT,
    PRIMARY KEY (workspace_id, origin_id, origin_seq),
    FOREIGN KEY (workspace_id, origin_id, origin_seq)
      REFERENCES replication_log(workspace_id, origin_id, origin_seq)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX owner_pending_settlements_ready ON owner_pending_settlements(
    workspace_id, checked_sequence, terminal_cursor
);
CREATE INDEX owner_pending_settlements_report ON owner_pending_settlements(workspace_id, report_id);
CREATE TABLE owner_pending_settlement_blobs (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    role TEXT NOT NULL CHECK (role IN ('payload-before', 'payload-after', 'before')),
    text_sha256 TEXT REFERENCES blobs(sha256) ON DELETE RESTRICT,
    binary_sha256 TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    PRIMARY KEY (workspace_id, origin_id, origin_seq, role),
    CHECK ((text_sha256 IS NOT NULL) != (binary_sha256 IS NOT NULL)),
    FOREIGN KEY (workspace_id, origin_id, origin_seq)
      REFERENCES owner_pending_settlements(workspace_id, origin_id, origin_seq)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX owner_pending_settlement_text_blobs
    ON owner_pending_settlement_blobs(text_sha256) WHERE text_sha256 IS NOT NULL;
CREATE INDEX owner_pending_settlement_binary_blobs
    ON owner_pending_settlement_blobs(binary_sha256) WHERE binary_sha256 IS NOT NULL;
";

/// Collection automations. A subscription names the change kinds it wants
/// and, for changed records, the fields. A claim carries the kind, author,
/// and bounded field facts of its change, and its run: 1, plus one per
/// retry. Rows written before this migration were plugin subscriptions
/// (added and changed records, any field) and first-run, changed-record
/// claims without facts. Their automation ids were `<plugin>/<id>`, with no
/// namespace; they move into `plugin:`, where the plugin executor drains.
const V2_AUTOMATION_CHANGE_FACTS_DDL: &str = "\
ALTER TABLE automation_subscriptions ADD COLUMN on_added INTEGER NOT NULL DEFAULT 1
    CHECK (on_added IN (0, 1));
ALTER TABLE automation_subscriptions ADD COLUMN on_changed INTEGER NOT NULL DEFAULT 1
    CHECK (on_changed IN (0, 1));
ALTER TABLE automation_subscriptions ADD COLUMN on_removed INTEGER NOT NULL DEFAULT 0
    CHECK (on_removed IN (0, 1));
ALTER TABLE automation_subscriptions ADD COLUMN field_names_json TEXT
    CHECK (field_names_json IS NULL OR json_valid(field_names_json));
ALTER TABLE automation_claims ADD COLUMN change_kind TEXT NOT NULL DEFAULT 'changed'
    CHECK (change_kind IN ('added', 'changed', 'removed'));
ALTER TABLE automation_claims ADD COLUMN author_origin_id TEXT;
ALTER TABLE automation_claims ADD COLUMN actor_kind TEXT
    CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'agent', 'automation'));
ALTER TABLE automation_claims ADD COLUMN on_behalf_of TEXT;
ALTER TABLE automation_claims ADD COLUMN change_fields_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(change_fields_json));
ALTER TABLE automation_claims ADD COLUMN change_fields_omitted INTEGER NOT NULL DEFAULT 0
    CHECK (change_fields_omitted >= 0);
ALTER TABLE automation_claims ADD COLUMN run INTEGER NOT NULL DEFAULT 1 CHECK (run >= 1);
UPDATE automation_subscriptions SET automation_id = 'plugin:' || automation_id
    WHERE instr(automation_id, ':') = 0;
UPDATE automation_claims SET automation_id = 'plugin:' || automation_id
    WHERE instr(automation_id, ':') = 0;
CREATE INDEX idx_automation_claims_automation
    ON automation_claims(workspace_id, automation_id, created_at_ms, claim_id);
";

const V2_RELAY_DEFERRED_OPS_DDL: &str = "\
CREATE TABLE relay_deferred_ops (
    workspace_id TEXT NOT NULL REFERENCES sync_identity(workspace_id) ON DELETE CASCADE,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK(origin_seq >= 0),
    replication_epoch TEXT NOT NULL,
    stream_identity TEXT NOT NULL,
    envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
    retained_bytes INTEGER NOT NULL CHECK(retained_bytes > 0),
    checked_sequence INTEGER NOT NULL DEFAULT 0 CHECK(checked_sequence >= 0),
    report_id TEXT,
    PRIMARY KEY(workspace_id,origin_id,origin_seq)
) STRICT;
CREATE TABLE relay_deferred_blobs (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    is_text INTEGER NOT NULL CHECK(is_text IN (0,1)),
    text_sha256 TEXT REFERENCES blobs(sha256) ON DELETE RESTRICT,
    binary_sha256 TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    CHECK ((is_text=1 AND text_sha256 IS NOT NULL AND text_sha256=sha256 AND binary_sha256 IS NULL)
        OR (is_text=0 AND binary_sha256 IS NOT NULL AND binary_sha256=sha256 AND text_sha256 IS NULL)),
    PRIMARY KEY(workspace_id,origin_id,origin_seq,sha256,is_text),
    FOREIGN KEY(workspace_id,origin_id,origin_seq)
        REFERENCES relay_deferred_ops(workspace_id,origin_id,origin_seq) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_relay_deferred_text_blob ON relay_deferred_blobs(text_sha256);
CREATE INDEX idx_relay_deferred_binary_blob ON relay_deferred_blobs(binary_sha256);
";

/// Added and removed records. Reconcile claims them keyed by the moment that
/// brought the record's file into its Collection or took it out, so a claim
/// may now hold a third trigger shape. SQLite cannot change a CHECK in
/// place, so the claims table is rebuilt with every row kept. Capture now
/// looks up the record a written file is bound to, so bindings gain an index
/// by object. `merged_moments` names the moments a merge wrote: they replay
/// another version's changes, which claimed where they were made. A Y.Doc
/// lineage keeps the author of its first update in `creator_author_json`,
/// so the settle that creates its file names that author after compaction
/// folds the update away.
const V2_AUTOMATION_RECORD_LIFECYCLE_DDL: &str = "\
CREATE TABLE automation_claims_next (
    workspace_id          TEXT    NOT NULL,
    claim_id              TEXT    NOT NULL,
    automation_id         TEXT    NOT NULL,
    trigger_origin_id     TEXT,
    trigger_origin_seq    INTEGER,
    trigger_history_id    INTEGER,
    trigger_moment_order  INTEGER,
    record_id             TEXT    NOT NULL,
    collection_path       TEXT    NOT NULL,
    depth                 INTEGER NOT NULL CHECK (depth >= 0),
    state                 TEXT    NOT NULL
                          CHECK (state IN ('pending', 'running', 'done', 'failed')),
    attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error                 TEXT,
    created_at_ms         INTEGER NOT NULL,
    updated_at_ms         INTEGER NOT NULL,
    change_kind           TEXT    NOT NULL DEFAULT 'changed'
                          CHECK (change_kind IN ('added', 'changed', 'removed')),
    author_origin_id      TEXT,
    actor_kind            TEXT
                          CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'agent', 'automation')),
    on_behalf_of          TEXT,
    change_fields_json    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(change_fields_json)),
    change_fields_omitted INTEGER NOT NULL DEFAULT 0 CHECK (change_fields_omitted >= 0),
    run                   INTEGER NOT NULL DEFAULT 1 CHECK (run >= 1),
    PRIMARY KEY (workspace_id, claim_id),
    CHECK ((trigger_origin_id IS NULL) = (trigger_origin_seq IS NULL)),
    CHECK ((trigger_origin_id IS NOT NULL) + (trigger_history_id IS NOT NULL)
           + (trigger_moment_order IS NOT NULL) = 1)
) STRICT;
INSERT INTO automation_claims_next
    (workspace_id, claim_id, automation_id, trigger_origin_id, trigger_origin_seq,
     trigger_history_id, record_id, collection_path, depth, state, attempts, error,
     created_at_ms, updated_at_ms, change_kind, author_origin_id, actor_kind, on_behalf_of,
     change_fields_json, change_fields_omitted, run)
SELECT workspace_id, claim_id, automation_id, trigger_origin_id, trigger_origin_seq,
       trigger_history_id, record_id, collection_path, depth, state, attempts, error,
       created_at_ms, updated_at_ms, change_kind, author_origin_id, actor_kind, on_behalf_of,
       change_fields_json, change_fields_omitted, run
FROM automation_claims;
DROP TABLE automation_claims;
ALTER TABLE automation_claims_next RENAME TO automation_claims;
CREATE UNIQUE INDEX idx_automation_claims_trigger_coordinate
    ON automation_claims(workspace_id, automation_id, trigger_origin_id, trigger_origin_seq)
    WHERE trigger_origin_id IS NOT NULL;
CREATE UNIQUE INDEX idx_automation_claims_trigger_history
    ON automation_claims(workspace_id, automation_id, trigger_history_id)
    WHERE trigger_history_id IS NOT NULL;
CREATE UNIQUE INDEX idx_automation_claims_trigger_moment
    ON automation_claims(workspace_id, automation_id, trigger_moment_order, change_kind, record_id)
    WHERE trigger_moment_order IS NOT NULL;
CREATE INDEX idx_automation_claims_state
    ON automation_claims(workspace_id, state, created_at_ms, claim_id);
CREATE INDEX idx_automation_claims_automation
    ON automation_claims(workspace_id, automation_id, created_at_ms, claim_id);
CREATE INDEX collection_records_by_object
    ON collection_records(workspace_id, version_id, object_id);
CREATE TABLE merged_moments (
    workspace_id TEXT    NOT NULL,
    moment_order INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, moment_order)
) STRICT;
ALTER TABLE ydoc_docs ADD COLUMN creator_author_json TEXT
    CHECK (creator_author_json IS NULL OR json_valid(creator_author_json));
";

/// Collection automations post in chat under a third author kind. SQLite
/// cannot change a CHECK in place, so the message and mention tables are
/// rebuilt with every row kept; no trigger or foreign key points at either.
/// A message this computer's automation wrote also records which automation
/// wrote it and its chain depth. Both stay on this computer: rows from other
/// computers leave them empty, and only automation rows may carry them.
const V2_CHAT_AUTOMATION_AUTHOR_DDL: &str = "\
CREATE TABLE chat_messages_next (
    workspace_id              TEXT    NOT NULL,
    thread_id                 TEXT    NOT NULL,
    message_order             INTEGER NOT NULL,
    message_id                TEXT    NOT NULL,
    author_kind               TEXT    NOT NULL
                              CHECK (author_kind IN ('human', 'agent', 'automation')),
    author_display_name       TEXT    NOT NULL,
    author_user_id            TEXT,
    parent_message_id         TEXT,
    origin                    TEXT,
    body                      TEXT    NOT NULL,
    created_at_ms             INTEGER NOT NULL,
    author_owner_display_name TEXT,
    automation_id             TEXT,
    chain_depth               INTEGER CHECK (chain_depth IS NULL OR chain_depth >= 1),
    PRIMARY KEY (workspace_id, message_id),
    UNIQUE (workspace_id, thread_id, message_order),
    FOREIGN KEY (workspace_id, thread_id)
      REFERENCES chat_threads(workspace_id, thread_id) ON DELETE CASCADE,
    CHECK ((automation_id IS NULL) = (chain_depth IS NULL)),
    CHECK (automation_id IS NULL OR author_kind = 'automation')
) STRICT;
INSERT INTO chat_messages_next
    (workspace_id, thread_id, message_order, message_id, author_kind, author_display_name,
     author_user_id, parent_message_id, origin, body, created_at_ms, author_owner_display_name)
SELECT workspace_id, thread_id, message_order, message_id, author_kind, author_display_name,
       author_user_id, parent_message_id, origin, body, created_at_ms, author_owner_display_name
FROM chat_messages;
DROP TABLE chat_messages;
ALTER TABLE chat_messages_next RENAME TO chat_messages;
CREATE INDEX idx_chat_messages_thread_order
    ON chat_messages(workspace_id, thread_id, message_order);
CREATE INDEX idx_chat_messages_thread_created
    ON chat_messages(workspace_id, thread_id, created_at_ms, message_id);
CREATE INDEX idx_chat_messages_workspace_created
    ON chat_messages(workspace_id, created_at_ms, message_id);
CREATE INDEX idx_chat_messages_author_feed
    ON chat_messages(workspace_id, author_user_id, author_kind, created_at_ms DESC, message_id DESC);
CREATE TABLE chat_mentions_next (
    workspace_id  TEXT    NOT NULL,
    thread_id     TEXT    NOT NULL,
    message_id    TEXT    NOT NULL,
    handle        TEXT    NOT NULL,
    author_kind   TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent', 'automation')),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id, handle)
) STRICT;
INSERT INTO chat_mentions_next
    (workspace_id, thread_id, message_id, handle, author_kind, created_at_ms)
SELECT workspace_id, thread_id, message_id, handle, author_kind, created_at_ms
FROM chat_mentions;
DROP TABLE chat_mentions;
ALTER TABLE chat_mentions_next RENAME TO chat_mentions;
CREATE INDEX idx_chat_mentions_handle
    ON chat_mentions(workspace_id, handle, created_at_ms, message_id);
";

/// Claims that no record change starts. A Group message, a button press,
/// and a schedule each key a claim on a trigger key the claim's trigger
/// names (`message:<id>`, `press:<id>`, `schedule:<dueMs>`), and a message
/// or schedule claim has no record. Only a message claim is written here;
/// the button and schedule kinds are fixed now so the claims table is
/// rebuilt once. SQLite cannot change a CHECK in place, so the rebuild keeps
/// every row.
///
/// A Collection automation subscribes to messages in a Group. Only the
/// computer that runs such automations registers these subscriptions, and it
/// claims a Group message the one time it stores that message, however the
/// message arrives. A message claim carries the message itself, within the
/// claim budget.
///
/// Two partial indexes let settle prune only the claims it can change: done
/// record claims, and done moment or message claims that still carry facts.
/// Their state and run are key columns too, so the planner prefers them to
/// the automation index when the key rows of message claims pile up.
const V2_AUTOMATION_TRIGGER_KEYS_DDL: &str = "\
CREATE TABLE automation_group_subscriptions (
    workspace_id  TEXT    NOT NULL,
    automation_id TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    starts_with   TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, automation_id, channel_id)
) STRICT;
CREATE INDEX idx_automation_group_subscriptions_channel
    ON automation_group_subscriptions(workspace_id, channel_id);
CREATE TABLE automation_claims_next (
    workspace_id          TEXT    NOT NULL,
    claim_id              TEXT    NOT NULL,
    automation_id         TEXT    NOT NULL,
    trigger_origin_id     TEXT,
    trigger_origin_seq    INTEGER,
    trigger_history_id    INTEGER,
    trigger_moment_order  INTEGER,
    trigger_key           TEXT,
    record_id             TEXT,
    collection_path       TEXT    NOT NULL,
    depth                 INTEGER NOT NULL CHECK (depth >= 0),
    state                 TEXT    NOT NULL
                          CHECK (state IN ('pending', 'running', 'done', 'failed')),
    attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error                 TEXT,
    created_at_ms         INTEGER NOT NULL,
    updated_at_ms         INTEGER NOT NULL,
    change_kind           TEXT    NOT NULL DEFAULT 'changed'
                          CHECK (change_kind IN ('added', 'changed', 'removed', 'message',
                                                 'button', 'schedule')),
    author_origin_id      TEXT,
    actor_kind            TEXT
                          CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'agent', 'automation')),
    on_behalf_of          TEXT,
    change_fields_json    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(change_fields_json)),
    change_fields_omitted INTEGER NOT NULL DEFAULT 0 CHECK (change_fields_omitted >= 0),
    run                   INTEGER NOT NULL DEFAULT 1 CHECK (run >= 1),
    message_json          TEXT    CHECK (message_json IS NULL OR json_valid(message_json)),
    PRIMARY KEY (workspace_id, claim_id),
    CHECK ((trigger_origin_id IS NULL) = (trigger_origin_seq IS NULL)),
    CHECK ((trigger_origin_id IS NOT NULL) + (trigger_history_id IS NOT NULL)
           + (trigger_moment_order IS NOT NULL) + (trigger_key IS NOT NULL) = 1),
    CHECK ((trigger_key IS NOT NULL) = (change_kind IN ('message', 'button', 'schedule'))),
    CHECK ((record_id IS NULL) = (change_kind IN ('message', 'schedule'))),
    CHECK (message_json IS NULL OR change_kind = 'message')
) STRICT;
INSERT INTO automation_claims_next
    (workspace_id, claim_id, automation_id, trigger_origin_id, trigger_origin_seq,
     trigger_history_id, trigger_moment_order, record_id, collection_path, depth, state,
     attempts, error, created_at_ms, updated_at_ms, change_kind, author_origin_id, actor_kind,
     on_behalf_of, change_fields_json, change_fields_omitted, run)
SELECT workspace_id, claim_id, automation_id, trigger_origin_id, trigger_origin_seq,
       trigger_history_id, trigger_moment_order, record_id, collection_path, depth, state,
       attempts, error, created_at_ms, updated_at_ms, change_kind, author_origin_id, actor_kind,
       on_behalf_of, change_fields_json, change_fields_omitted, run
FROM automation_claims;
DROP TABLE automation_claims;
ALTER TABLE automation_claims_next RENAME TO automation_claims;
CREATE UNIQUE INDEX idx_automation_claims_trigger_coordinate
    ON automation_claims(workspace_id, automation_id, trigger_origin_id, trigger_origin_seq)
    WHERE trigger_origin_id IS NOT NULL;
CREATE UNIQUE INDEX idx_automation_claims_trigger_history
    ON automation_claims(workspace_id, automation_id, trigger_history_id)
    WHERE trigger_history_id IS NOT NULL;
CREATE UNIQUE INDEX idx_automation_claims_trigger_moment
    ON automation_claims(workspace_id, automation_id, trigger_moment_order, change_kind, record_id)
    WHERE trigger_moment_order IS NOT NULL;
CREATE UNIQUE INDEX idx_automation_claims_trigger_key
    ON automation_claims(workspace_id, automation_id, trigger_key)
    WHERE trigger_key IS NOT NULL;
CREATE INDEX idx_automation_claims_prunable
    ON automation_claims(workspace_id, automation_id, state, run)
    WHERE state = 'done' AND run = 1
      AND trigger_moment_order IS NULL AND change_kind <> 'message';
CREATE INDEX idx_automation_claims_settled_facts
    ON automation_claims(workspace_id, automation_id, state, run)
    WHERE state = 'done' AND run = 1
      AND (trigger_moment_order IS NOT NULL OR change_kind = 'message')
      AND (change_fields_json <> '[]' OR message_json IS NOT NULL);
CREATE INDEX idx_automation_claims_state
    ON automation_claims(workspace_id, state, created_at_ms, claim_id);
CREATE INDEX idx_automation_claims_automation
    ON automation_claims(workspace_id, automation_id, created_at_ms, claim_id);
";

/// Buttons and schedules. A button claim keys on `press:<press id>` and a
/// schedule claim on `schedule:<due ms>`, in the trigger key the claims
/// table already has. One button claim at a time is pending or running per
/// automation and record, so a double click runs once. A press key is
/// looked up across the workspace's buttons, so a press id sent to another
/// button is recognized. `automation_presses` remembers each press for 30
/// days, so a press sent again after a lost reply finds its claim.
/// `automation_schedule_marks` records, per schedule, the time up to which
/// every due time was claimed or skipped.
const V2_AUTOMATION_BUTTONS_AND_SCHEDULES_DDL: &str = "\
CREATE UNIQUE INDEX idx_automation_claims_active_button
    ON automation_claims(workspace_id, automation_id, record_id)
    WHERE change_kind = 'button' AND state IN ('pending', 'running');
CREATE INDEX idx_automation_claims_press_key
    ON automation_claims(workspace_id, trigger_key)
    WHERE change_kind = 'button';
CREATE TABLE automation_presses (
    workspace_id  TEXT    NOT NULL,
    press_id      TEXT    NOT NULL,
    automation_id TEXT    NOT NULL,
    record_id     TEXT    NOT NULL,
    pressed_by    TEXT    NOT NULL,
    pressed_at_ms INTEGER NOT NULL,
    claim_id      TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, press_id)
) STRICT;
CREATE INDEX automation_presses_by_claim ON automation_presses(workspace_id, claim_id);
CREATE INDEX automation_presses_by_time ON automation_presses(workspace_id, pressed_at_ms);
CREATE TABLE automation_schedule_marks (
    workspace_id  TEXT    NOT NULL,
    automation_id TEXT    NOT NULL,
    schedule_hash TEXT    NOT NULL,
    through_ms    INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, automation_id)
) STRICT;
";

/// The count of changes applied to each workspace that did not originate on
/// this computer (`remote_changes.rs`). A store upgraded to this migration
/// starts at 0. An owner tells its own accepted drafts from other frames by
/// digest, so outbox entries gain an index by digest.
const V2_REMOTE_CHANGES_DDL: &str = "\
CREATE TABLE remote_changes (
    workspace_id TEXT    NOT NULL PRIMARY KEY,
    applied      INTEGER NOT NULL CHECK (applied >= 0)
) STRICT;
CREATE INDEX owner_ydoc_outbox_entries_by_digest
    ON owner_ydoc_outbox_entries(update_digest);
";

/// A share recipient's direct writes to a Collection's own files: where the
/// direct lane last read this replica's journal for a share, its two
/// positions for each file, and the writes it planned and has not finished.
const V2_SHARE_DIRECT_WRITES_DDL: &str = "\
CREATE TABLE share_direct_write_state (
    workspace_id      TEXT    NOT NULL,
    share_id          TEXT    NOT NULL,
    scanned_seq       INTEGER NOT NULL CHECK (scanned_seq >= -1),
    plan_seq          INTEGER CHECK (plan_seq IS NULL OR plan_seq >= -1),
    plan_more_pending INTEGER NOT NULL DEFAULT 0 CHECK (plan_more_pending IN (0, 1)),
    PRIMARY KEY (workspace_id, share_id)
) STRICT;
CREATE TABLE share_direct_write_marks (
    workspace_id      TEXT    NOT NULL,
    share_id          TEXT    NOT NULL,
    object_id         TEXT    NOT NULL,
    delivered_through INTEGER NOT NULL CHECK (delivered_through >= -1),
    decided_through   INTEGER NOT NULL CHECK (decided_through >= delivered_through),
    PRIMARY KEY (workspace_id, share_id, object_id)
) STRICT;
CREATE TABLE share_direct_write_plan (
    workspace_id TEXT    NOT NULL,
    share_id     TEXT    NOT NULL,
    ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
    submit_id    TEXT    NOT NULL,
    changes_json TEXT    NOT NULL CHECK (json_valid(changes_json)),
    objects_json TEXT    NOT NULL CHECK (json_valid(objects_json)),
    result_json  TEXT    CHECK (result_json IS NULL OR json_valid(result_json)),
    PRIMARY KEY (workspace_id, share_id, ordinal)
) STRICT;
";

// The lineage update the workspace file is known to hold: the head_update_seq a
// settle covered, or NULL when nothing proves it. An open compares it with the
// head to tell a lineage that is ahead of its file from one that is not. A
// writer that rewinds the head must clear it; the check refuses one that
// rewinds below it.
const V2_YDOC_SETTLED_UPDATE_SEQ_DDL: &str = "\
ALTER TABLE ydoc_docs ADD COLUMN settled_update_seq INTEGER
    CHECK (settled_update_seq IS NULL
        OR (settled_update_seq >= 0 AND settled_update_seq <= head_update_seq));
";

/// Group message claims that hold across a handover (ADR 0012).
///
/// A frozen Group subscription claims nothing: the computer handing over
/// freezes them all, and keeps them so a repeated release answers the same.
/// The coverage names every (automation, message) a host decided, claimed
/// or skipped as the automation's own post, including those an earlier host
/// handed over. A message it names never claims again here, and the next
/// host gets the recent part. The state row holds, per workspace, the host
/// generation this computer last watched at, so a relay record no newer than
/// it changes nothing, when it last took a handover, the coverage floor, and
/// when a Group message last started nothing because it was dated ahead of
/// this computer's clock or arrived after the floor passed it. Every Group
/// subscription already here starts now, because the claims kept so far do
/// not say which older messages were decided.
const V2_AUTOMATION_GROUP_COVERAGE_DDL: &str = "\
ALTER TABLE automation_group_subscriptions
    ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1));
UPDATE automation_group_subscriptions
    SET created_at_ms = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER);
CREATE TABLE automation_group_coverage (
    workspace_id  TEXT    NOT NULL,
    automation_id TEXT    NOT NULL,
    message_id    TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, automation_id, message_id)
) STRICT;
CREATE INDEX idx_automation_group_coverage_created
    ON automation_group_coverage(workspace_id, created_at_ms);
CREATE TABLE automation_group_state (
    workspace_id        TEXT    NOT NULL PRIMARY KEY,
    generation          INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    imported_at_ms      INTEGER NOT NULL DEFAULT 0,
    floor_ms            INTEGER,
    ahead_skipped_at_ms INTEGER,
    late_skipped_at_ms  INTEGER
) STRICT;
";

/// Files the materializer moved into its staging directory whose bytes the
/// store does not hold. An `open` row names one until it goes back to its
/// path, when the row is deleted. A `kept` row is the evidence of bytes
/// another program wrote that could not go back.
const V2_MATERIALIZATION_DISPLACEMENTS_DDL: &str = "\
CREATE TABLE materialization_displacements (
    displacement_id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    target_path TEXT NOT NULL,
    displaced_name TEXT NOT NULL,
    expected_sha256 TEXT NOT NULL,
    content_sha256 TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'kept')),
    displaced_sha256 TEXT,
    created_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER,
    CHECK ((state = 'kept') = (resolved_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX materialization_displacements_state
    ON materialization_displacements(state, job_id);
";

const V2_RETAINED_DISPLACEMENTS_DDL: &str = r#"
CREATE TABLE materialization_retained (
    displacement_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    target_path TEXT NOT NULL,
    source_path TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    inode TEXT NOT NULL,
    digest TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    mtime TEXT NOT NULL,
    ctime TEXT NOT NULL,
    changed_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX materialization_retained_due ON materialization_retained(changed_at_ms);
CREATE INDEX materialization_retained_job ON materialization_retained(job_id);
CREATE TABLE materialization_displacement_reads (
    workspace_id TEXT NOT NULL,
    displacement_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    target_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, displacement_id, sha256)
) STRICT;
CREATE TABLE materialization_staging_locations (
    job_id TEXT PRIMARY KEY,
    directory TEXT NOT NULL
) STRICT;
"#;

/// Run history keeps an automation's settled claims 30 days from when they
/// last settled, and its newest failure. An expired claim that still keeps a
/// trigger from running twice stays, marked `expired` and out of run
/// history. A deleted claim's failures move to
/// `automation_retired_failures`, so an automation's failure generation
/// never goes down.
const V2_AUTOMATION_RUN_RETENTION_DDL: &str = "\
ALTER TABLE automation_claims ADD COLUMN expired INTEGER NOT NULL DEFAULT 0
    CHECK (expired IN (0, 1));
CREATE TABLE automation_retired_failures (
    workspace_id  TEXT    NOT NULL,
    automation_id TEXT    NOT NULL,
    failures      INTEGER NOT NULL CHECK (failures > 0),
    PRIMARY KEY (workspace_id, automation_id)
) STRICT;
DROP INDEX idx_automation_claims_prunable;
DROP INDEX idx_automation_claims_settled_facts;
CREATE INDEX idx_automation_claims_expiring
    ON automation_claims(workspace_id, updated_at_ms)
    WHERE state IN ('done', 'failed') AND expired = 0;
CREATE INDEX idx_automation_claims_failed
    ON automation_claims(workspace_id, automation_id, updated_at_ms, claim_id)
    WHERE state = 'failed' AND expired = 0;
CREATE INDEX idx_automation_claims_expired_schedule_keys
    ON automation_claims(workspace_id, automation_id)
    WHERE expired = 1 AND change_kind = 'schedule' AND substr(trigger_key, 1, 9) = 'schedule:';
CREATE INDEX idx_automation_claims_history
    ON automation_claims(workspace_id, automation_id, created_at_ms, claim_id)
    WHERE expired = 0;
";

// A job references either content table. Keep the reference checks while
// allowing text jobs to use the text blob already owned by their moment.
const V2_MATERIALIZATION_TEXT_BLOBS_DDL: &str = "\
ALTER TABLE engine_requests ADD COLUMN publication_outcome TEXT
    CHECK (publication_outcome IN ('applied', 'skipped', 'conflict', 'superseded'));
CREATE TABLE materialization_jobs_next (
    job_id TEXT NOT NULL PRIMARY KEY,
    target_path TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    preimage_present INTEGER NOT NULL,
    preimage_sha256 TEXT,
    target_generation INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    operation TEXT NOT NULL DEFAULT 'write',
    workspace_id TEXT NOT NULL DEFAULT ''
) STRICT;
INSERT INTO materialization_jobs_next SELECT * FROM materialization_jobs;
DROP TABLE materialization_jobs;
ALTER TABLE materialization_jobs_next RENAME TO materialization_jobs;
CREATE INDEX idx_materialization_jobs_status ON materialization_jobs(status);
CREATE INDEX idx_materialization_jobs_workspace_path_status_generation
    ON materialization_jobs(workspace_id, target_path, status, target_generation);
CREATE INDEX idx_materialization_jobs_mutation_generation
    ON materialization_jobs(target_generation DESC)
    WHERE job_id NOT GLOB 'version-switch-mat_*'
      AND job_id NOT GLOB 'version-switch-secret-mat_*';
CREATE TRIGGER materialization_content_insert BEFORE INSERT ON materialization_jobs
WHEN NOT EXISTS (SELECT 1 FROM blobs WHERE sha256 = NEW.content_sha256)
 AND NOT EXISTS (SELECT 1 FROM binary_blobs WHERE sha256 = NEW.content_sha256)
BEGIN SELECT RAISE(ABORT, 'missing materialization content'); END;
CREATE TRIGGER materialization_content_update BEFORE UPDATE OF content_sha256 ON materialization_jobs
WHEN NOT EXISTS (SELECT 1 FROM blobs WHERE sha256 = NEW.content_sha256)
 AND NOT EXISTS (SELECT 1 FROM binary_blobs WHERE sha256 = NEW.content_sha256)
BEGIN SELECT RAISE(ABORT, 'missing materialization content'); END;
CREATE TRIGGER materialization_text_delete BEFORE DELETE ON blobs
WHEN EXISTS (SELECT 1 FROM materialization_jobs WHERE content_sha256 = OLD.sha256)
 AND NOT EXISTS (SELECT 1 FROM binary_blobs WHERE sha256 = OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'referenced materialization content'); END;
CREATE TRIGGER materialization_text_update BEFORE UPDATE OF sha256 ON blobs
WHEN OLD.sha256 <> NEW.sha256
 AND EXISTS (SELECT 1 FROM materialization_jobs WHERE content_sha256 = OLD.sha256)
 AND NOT EXISTS (SELECT 1 FROM binary_blobs WHERE sha256 = OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'referenced materialization content'); END;
CREATE TRIGGER materialization_binary_delete BEFORE DELETE ON binary_blobs
WHEN EXISTS (SELECT 1 FROM materialization_jobs WHERE content_sha256 = OLD.sha256)
 AND NOT EXISTS (SELECT 1 FROM blobs WHERE sha256 = OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'referenced materialization content'); END;
CREATE TRIGGER materialization_binary_update BEFORE UPDATE OF sha256 ON binary_blobs
WHEN OLD.sha256 <> NEW.sha256
 AND EXISTS (SELECT 1 FROM materialization_jobs WHERE content_sha256 = OLD.sha256)
 AND NOT EXISTS (SELECT 1 FROM blobs WHERE sha256 = OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'referenced materialization content'); END;
";

/// Record history names the automation run that wrote a change: the claim
/// it ran for and the automation's name when it ran. Only an automation's
/// change names one, and the two are set together.
const V2_RECORD_HISTORY_AUTOMATION_RUN_DDL: &str = "\
ALTER TABLE collection_field_history ADD COLUMN automation_claim_id TEXT
    CHECK (automation_claim_id IS NULL OR actor_kind = 'automation');
ALTER TABLE collection_field_history ADD COLUMN automation_name TEXT
    CHECK ((automation_name IS NULL) = (automation_claim_id IS NULL));
";

/// Live edits keep their authors. A moment's `author_json` becomes a list
/// with one entry per author, so each stored single author becomes a list of
/// one; NULL stays NULL. `pending_authors_json` holds the authors compaction folded
/// before a settle covered them. `settle_prior_update_seq` holds the
/// boundary one unresolved settle replaced: -1 when that boundary was NULL,
/// and NULL when no settle is unresolved.
const V2_YDOC_LIVE_EDIT_AUTHORS_DDL: &str = "\
ALTER TABLE ydoc_docs DROP COLUMN creator_author_json;
ALTER TABLE ydoc_updates ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0
    CHECK (is_seed IN (0, 1));
UPDATE ydoc_updates SET is_seed=1 WHERE seq=1 AND EXISTS(
    SELECT 1 FROM ydoc_docs d WHERE d.workspace_id=ydoc_updates.workspace_id
        AND d.version_id=ydoc_updates.version_id AND d.object_id=ydoc_updates.object_id
        AND d.seed_source_sha256 IS NOT NULL);
ALTER TABLE ydoc_inactive_lineages ADD COLUMN pending_authors_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(pending_authors_json) AND json_type(pending_authors_json) = 'array');
ALTER TABLE ydoc_recovery_decisions ADD COLUMN recovery_author_json TEXT
    CHECK (recovery_author_json IS NULL OR json_valid(recovery_author_json));
ALTER TABLE ydoc_docs ADD COLUMN pending_authors_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(pending_authors_json) AND json_type(pending_authors_json) = 'array');
ALTER TABLE ydoc_docs ADD COLUMN settle_prior_update_seq INTEGER
    CHECK (settle_prior_update_seq IS NULL OR settle_prior_update_seq >= -1);
UPDATE moments SET author_json = json_array(json(author_json))
    WHERE author_json IS NOT NULL AND json_valid(author_json)
      AND json_type(author_json) = 'object';
";

/// Only the owner's delivery declares, and the agent ID and depth are present
/// together. An enrolled owner's draft records the observed binding revision
/// it was queued under; a draft never names a native source.
const V2_LIVE_APPLICATION_AGENT_DECLARATIONS_DDL: &str = "\
ALTER TABLE owner_ydoc_outbox_entries ADD COLUMN draft_binding_revision INTEGER
    CHECK (draft_binding_revision IS NULL OR (native_source_json IS NULL
        AND draft_binding_revision BETWEEN 1 AND 9007199254740991));
ALTER TABLE live_device_update_applications ADD COLUMN declared_agent_id TEXT
    CHECK (declared_agent_id IS NULL OR (principal_kind = 'owner'
        AND length(CAST(declared_agent_id AS BLOB)) BETWEEN 1 AND 512));
ALTER TABLE live_device_update_applications ADD COLUMN declared_on_behalf_of TEXT
    CHECK (declared_on_behalf_of IS NULL OR (declared_agent_id IS NOT NULL
        AND length(CAST(declared_on_behalf_of AS BLOB)) BETWEEN 1 AND 512));
ALTER TABLE live_device_update_applications ADD COLUMN declared_depth INTEGER
    CHECK ((declared_depth IS NULL) = (declared_agent_id IS NULL)
        AND (declared_depth IS NULL OR declared_depth BETWEEN 0 AND 64));
";

const V2_YDOC_SHARING_DECLINED_DDL: &str = "
ALTER TABLE ydoc_docs ADD COLUMN sharing_declined_json TEXT
    CHECK (sharing_declined_json IS NULL OR
        (length(sharing_declined_json) <= 1024 AND json_valid(sharing_declined_json)));
CREATE TRIGGER ydoc_sharing_declined_claimed AFTER UPDATE OF lineage_claim_status ON ydoc_docs
WHEN NEW.lineage_claim_status != 'unclaimed' AND NEW.sharing_declined_json IS NOT NULL
BEGIN
    UPDATE ydoc_docs SET sharing_declined_json=NULL
    WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER ydoc_sharing_declined_head AFTER UPDATE ON snapshots
WHEN NEW.blob_sha256 IS NOT OLD.blob_sha256
    OR (NEW.latest_moment_id IS NOT OLD.latest_moment_id AND NEW.metadata_origin='restore')
BEGIN
    UPDATE ydoc_docs SET sharing_declined_json=NULL
    WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id
        AND sharing_declined_json IS NOT NULL;
END;
CREATE TRIGGER ydoc_sharing_declined_deleted AFTER DELETE ON snapshots
BEGIN
    UPDATE ydoc_docs SET sharing_declined_json=NULL
    WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id
        AND sharing_declined_json IS NOT NULL;
END;
CREATE TRIGGER ydoc_sharing_declined_restore AFTER INSERT ON live_restore_fences
BEGIN
    UPDATE ydoc_docs SET sharing_declined_json=NULL
    WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id
        AND sharing_declined_json IS NOT NULL;
END;
";

const V2_OWNER_BINDING_REBIND_DDL: &str = "\
CREATE TEMP TABLE owner_rebind_parents AS SELECT * FROM owner_ydoc_outboxes;
CREATE TEMP TABLE owner_rebind_entries AS SELECT * FROM owner_ydoc_outbox_entries;
DROP TABLE owner_ydoc_outbox_entries;
DROP TABLE owner_ydoc_outboxes;
CREATE TABLE owner_ydoc_outboxes (
    outbox_id                 TEXT NOT NULL PRIMARY KEY,
    workspace_id              TEXT NOT NULL,
    main_version_id           TEXT NOT NULL,
    object_id                 TEXT NOT NULL,
    lineage_claim_id          TEXT NOT NULL,
    current_path              TEXT NOT NULL,
    selector_paths_json       TEXT NOT NULL CHECK (json_valid(selector_paths_json)),
    restore_fence_generation  INTEGER NOT NULL CHECK (restore_fence_generation >= 0),
    base_update_digest        TEXT NOT NULL,
    base_blob_digest          TEXT NOT NULL,
    base_byte_length          INTEGER NOT NULL CHECK (base_byte_length > 0),
    state                     TEXT NOT NULL CHECK (state IN ('active', 'sealed', 'quarantined')),
    pending_bytes             INTEGER NOT NULL CHECK (pending_bytes >= 0),
    oldest_entry_at_ms        INTEGER CHECK (oldest_entry_at_ms IS NULL OR oldest_entry_at_ms >= 0),
    next_sequence             INTEGER NOT NULL CHECK (next_sequence >= 1),
    quarantine_reason         TEXT,
    observed_binding_json     TEXT CHECK (
      observed_binding_json IS NULL OR json_valid(observed_binding_json)
    ),
    created_at_ms             INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK (
      (state = 'quarantined' AND quarantine_reason IS NOT NULL) OR
      (state != 'quarantined' AND quarantine_reason IS NULL AND observed_binding_json IS NULL)
    ),
    CHECK (
      (pending_bytes = 0 AND oldest_entry_at_ms IS NULL) OR
      (pending_bytes > 0 AND oldest_entry_at_ms IS NOT NULL)
    ),
    UNIQUE (workspace_id, main_version_id, object_id, lineage_claim_id, restore_fence_generation, current_path, selector_paths_json),
    FOREIGN KEY (base_blob_digest)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;

INSERT INTO owner_ydoc_outboxes SELECT * FROM owner_rebind_parents;
CREATE TABLE owner_ydoc_outbox_entries (
    outbox_id                TEXT NOT NULL,
    sequence                 INTEGER NOT NULL CHECK (sequence >= 1),
    append_key               TEXT NOT NULL UNIQUE,
    delivery_id              TEXT NOT NULL UNIQUE,
    update_digest            TEXT NOT NULL,
    native_source_json       TEXT CHECK (native_source_json IS NULL OR json_valid(native_source_json)),
    accepted_receipt_json    TEXT CHECK (accepted_receipt_json IS NULL OR json_valid(accepted_receipt_json)),
    update_blob_digest       TEXT,
    byte_length              INTEGER NOT NULL CHECK (byte_length > 0),
    created_at_ms            INTEGER NOT NULL CHECK (created_at_ms >= 0),
    pending                  INTEGER NOT NULL CHECK (pending IN (0, 1)),
    result_pending_bytes     INTEGER NOT NULL CHECK (result_pending_bytes > 0),
    result_oldest_entry_at_ms INTEGER NOT NULL CHECK (result_oldest_entry_at_ms >= 0),
    result_state             TEXT NOT NULL CHECK (result_state IN ('active', 'sealed')),
    draft_binding_revision INTEGER CHECK (draft_binding_revision IS NULL OR (native_source_json IS NULL AND draft_binding_revision BETWEEN 1 AND 9007199254740991)),
    agent_declaration_json TEXT CHECK (agent_declaration_json IS NULL OR json_valid(agent_declaration_json)),
    automation_declaration_json TEXT CHECK (automation_declaration_json IS NULL OR json_valid(automation_declaration_json)),
    terminal_blob_digest TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    terminal_reason TEXT CHECK (terminal_reason IS NULL OR (length(terminal_reason) BETWEEN 1 AND 256 AND pending=0 AND accepted_receipt_json IS NULL)),
    CHECK (
      (pending = 1 AND update_blob_digest IS NOT NULL) OR
      (pending = 0 AND update_blob_digest IS NULL)
    ),
    PRIMARY KEY (outbox_id, sequence),
    FOREIGN KEY (outbox_id)
      REFERENCES owner_ydoc_outboxes(outbox_id) ON DELETE RESTRICT,
    FOREIGN KEY (update_blob_digest)
      REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;
INSERT INTO owner_ydoc_outbox_entries (outbox_id,sequence,append_key,delivery_id,update_digest,native_source_json,accepted_receipt_json,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision,agent_declaration_json,automation_declaration_json,terminal_blob_digest,terminal_reason) SELECT outbox_id,sequence,append_key,delivery_id,update_digest,native_source_json,accepted_receipt_json,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision,agent_declaration_json,automation_declaration_json,terminal_blob_digest,terminal_reason FROM owner_rebind_entries;
DROP TABLE owner_rebind_entries;
DROP TABLE owner_rebind_parents;
CREATE INDEX owner_ydoc_outbox_entries_pending ON owner_ydoc_outbox_entries(outbox_id,sequence) WHERE pending=1;
CREATE INDEX owner_ydoc_outbox_entries_by_digest ON owner_ydoc_outbox_entries(update_digest);
";

const V2_LIVE_SETTLEMENT_PUBLICATION_DDL: &str = "
CREATE TABLE live_settlement_publication_states (
    settlement_id TEXT NOT NULL PRIMARY KEY
        REFERENCES live_device_settlements(settlement_id) ON DELETE CASCADE,
    state_blob_sha256 TEXT NOT NULL
        REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;
CREATE TABLE live_settlement_publication_admissions (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    moment_id TEXT NOT NULL,
    admission_json TEXT NOT NULL,
    authors_json TEXT,
    fallback_origin_seq INTEGER,
    PRIMARY KEY (workspace_id, origin_id, origin_seq)
) STRICT;
CREATE TABLE live_settlement_attribution_unavailable (
    workspace_id TEXT NOT NULL,
    moment_id TEXT NOT NULL,
    settlement_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (workspace_id, moment_id)
) STRICT;
";

// A fence row also holds its restore proof, which can be tens of MiB, and SQLite
// reaches a later column of a row only by walking the overflow pages of every
// column before it. Each edit and live application on a restored document
// reads its resumed fence, so answer those reads from this index instead.
const V2_LIVE_RESTORE_RESUMED_LOOKUP_DDL: &str = "
DROP INDEX live_restore_document_generation;
CREATE INDEX live_restore_resumed ON live_restore_fences(workspace_id,main_version_id,object_id,new_generation,relay_database_namespace,resume_receipt_json);
";

const V2_FIELD_HISTORY_LINK_AUTHOR_DDL: &str = "
ALTER TABLE collection_field_history ADD COLUMN link_author_json TEXT;
";

const V2_YDOC_FILE_EXPORT_LANE_DDL: &str = "
ALTER TABLE ydoc_docs ADD COLUMN file_export_lane INTEGER NOT NULL DEFAULT 0 CHECK (file_export_lane IN (0,1,2,3));
UPDATE ydoc_docs SET file_export_lane=1 WHERE lineage_claim_status='unclaimed' AND sharing_declined_json IS NOT NULL;
DROP TRIGGER ydoc_sharing_declined_head;
CREATE TRIGGER ydoc_sharing_declined_head AFTER UPDATE ON snapshots
WHEN NEW.blob_sha256 IS NOT OLD.blob_sha256
    OR (NEW.latest_moment_id IS NOT OLD.latest_moment_id AND NEW.metadata_origin='restore')
BEGIN
    UPDATE ydoc_docs SET sharing_declined_json=NULL
    WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id
        AND file_export_lane NOT IN (1,2) AND sharing_declined_json IS NOT NULL;
END;
DROP TRIGGER ydoc_sharing_declined_restore;
CREATE TRIGGER ydoc_sharing_declined_restore AFTER INSERT ON live_restore_fences
BEGIN
    UPDATE ydoc_docs SET sharing_declined_json=NULL
    WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id
        AND file_export_lane NOT IN (1,2) AND sharing_declined_json IS NOT NULL;
END;
CREATE TRIGGER ydoc_file_export_claimed AFTER UPDATE OF lineage_claim_status ON ydoc_docs
WHEN NEW.lineage_claim_status != 'unclaimed' AND NEW.file_export_lane != 0
BEGIN
    UPDATE ydoc_docs SET file_export_lane=0 WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER ydoc_file_export_deleted AFTER DELETE ON snapshots
BEGIN
    UPDATE ydoc_docs SET file_export_lane=3 WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id AND file_export_lane IN (1,2);
END;
";

/// The frozen, ordered list of migrations this build knows. No build may
/// delete or rename the `v2-baseline` ledger row, because an older build
/// recognizes a newer store only by that row and would otherwise offer
/// Rebuild for it.
pub(crate) const BASELINE_MIGRATIONS: &[Migration] = &[
    Migration {
        ordinal: 0,
        id: BASELINE_MIGRATION_ID,
        sql: V2_BASELINE_DDL,
        sets_user_version: Some(ENGINE_SCHEMA_VERSION),
    },
    Migration {
        ordinal: 1,
        id: V2_GROUPS_MIGRATION_ID,
        sql: V2_GROUPS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 2,
        id: "v2-agent-owner",
        sql: V2_AGENT_OWNER_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 3,
        id: "v2-owner-settlement-lookup",
        sql: V2_OWNER_SETTLEMENT_LOOKUP_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 4,
        id: "v2-owner-pending-settlements",
        sql: V2_OWNER_PENDING_SETTLEMENTS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 5,
        id: "v2-automation-change-facts",
        sql: V2_AUTOMATION_CHANGE_FACTS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 6,
        id: "v2-relay-bootstrap-complete",
        sql: "ALTER TABLE sync_relay_cursors ADD COLUMN bootstrap_complete INTEGER NOT NULL DEFAULT 1 CHECK (bootstrap_complete IN (0, 1));",
        sets_user_version: None,
    },
    Migration {
        ordinal: 7,
        id: "v2-relay-deferred-ops",
        sql: V2_RELAY_DEFERRED_OPS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 8,
        id: "v2-automation-record-lifecycle",
        sql: V2_AUTOMATION_RECORD_LIFECYCLE_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 9,
        id: "v2-chat-automation-author",
        sql: V2_CHAT_AUTOMATION_AUTHOR_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 10,
        id: "v2-automation-trigger-keys",
        sql: V2_AUTOMATION_TRIGGER_KEYS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 11,
        id: "v2-automation-buttons-and-schedules",
        sql: V2_AUTOMATION_BUTTONS_AND_SCHEDULES_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 12,
        id: "v2-remote-changes",
        sql: V2_REMOTE_CHANGES_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 13,
        id: "v2-share-direct-writes",
        sql: V2_SHARE_DIRECT_WRITES_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 14,
        id: "v2-authored-create-intent",
        sql: "CREATE TABLE authored_create_intent (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), input_json TEXT NOT NULL, stage_id TEXT NOT NULL) STRICT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 15,
        id: "v2-ydoc-settled-update-seq",
        sql: V2_YDOC_SETTLED_UPDATE_SEQ_DDL,
        sets_user_version: None,
    },
    // Ordinal 16 is unused.
    Migration {
        ordinal: 17,
        id: "v2-automation-group-coverage",
        sql: V2_AUTOMATION_GROUP_COVERAGE_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 19,
        id: "v2-sync-identity-claim-state",
        sql: "ALTER TABLE sync_identity ADD COLUMN claim_state TEXT CHECK (claim_state IN ('pending','workspace-unavailable','epoch-superseded','identity-not-recognized','identity-required','stream-identity-mismatch')); ALTER TABLE sync_identity ADD COLUMN claim_account_id TEXT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 20,
        id: "v2-materialization-displacements",
        sql: V2_MATERIALIZATION_DISPLACEMENTS_DDL,
        sets_user_version: None,
    },
    // Who the relay accepted a claimed live change from, when that was a
    // person the owner shared with or an Edit share link. Null for every
    // other claim.
    Migration {
        ordinal: 21,
        id: "v2-automation-claim-shared-author",
        sql: "ALTER TABLE automation_claims ADD COLUMN change_author_json TEXT CHECK (change_author_json IS NULL OR json_valid(change_author_json));",
        sets_user_version: None,
    },
    // The relay's live journal cursor of the frame a claimed live change came
    // in, so the relay can tell when a settlement has carried it. Null for
    // every other claim.
    Migration {
        ordinal: 22,
        id: "v2-automation-claim-live-cursor",
        sql: "ALTER TABLE automation_claims ADD COLUMN change_live_cursor INTEGER CHECK (change_live_cursor IS NULL OR change_live_cursor BETWEEN 1 AND 9007199254740991);",
        sets_user_version: None,
    },
    Migration {
        ordinal: 23,
        id: "v2-automation-run-retention",
        sql: V2_AUTOMATION_RUN_RETENTION_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 24,
        id: "v2-materialization-text-blobs",
        sql: V2_MATERIALIZATION_TEXT_BLOBS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 25,
        id: "v2-record-history-automation-run",
        sql: V2_RECORD_HISTORY_AUTOMATION_RUN_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 26,
        id: "v2-ydoc-live-edit-authors",
        sql: V2_YDOC_LIVE_EDIT_AUTHORS_DDL,
        sets_user_version: None,
    },
    // The agent an owner's queued draft declared, kept with its delivery
    // after the relay's receipt. Null for every entry that declared none.
    Migration {
        ordinal: 27,
        id: "v2-owner-draft-agent-declarations",
        sql: "ALTER TABLE owner_ydoc_outbox_entries ADD COLUMN agent_declaration_json TEXT CHECK (agent_declaration_json IS NULL OR json_valid(agent_declaration_json));",
        sets_user_version: None,
    },
    // The agent the owner declared for an applied delivery, beside the
    // authority the relay derived, and the enrollment proof of an owner's
    // queued draft. Null for every delivery and entry without them.
    Migration {
        ordinal: 28,
        id: "v2-live-application-agent-declarations",
        sql: V2_LIVE_APPLICATION_AGENT_DECLARATIONS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 29,
        id: "v2-live-admitted-metadata-receipts",
        sql: "ALTER TABLE live_device_update_applications DROP COLUMN declared_on_behalf_of; ALTER TABLE live_device_update_applications DROP COLUMN declared_depth; ALTER TABLE live_device_update_applications DROP COLUMN declared_agent_id; ALTER TABLE live_device_update_applications ADD COLUMN admitted_metadata_json TEXT CHECK (admitted_metadata_json IS NULL OR json_valid(admitted_metadata_json)); ALTER TABLE live_audit_events ADD COLUMN canonical_version INTEGER NOT NULL DEFAULT 1 CHECK (canonical_version IN (1,2));",
        sets_user_version: None,
    },
    Migration {
        ordinal: 30,
        id: "v2-retained-head-export-attempts",
        sql: "CREATE INDEX replication_log_moment_object ON replication_log( \
                workspace_id,json_extract(payload_json,'$.versionId'), \
                json_extract(payload_json,'$.objectId')) WHERE op_kind='moment.append'; \
              ALTER TABLE ydoc_docs ADD COLUMN export_attempt_moment_id TEXT; \
              ALTER TABLE ydoc_docs ADD COLUMN export_attempt_update_seq INTEGER; \
              ALTER TABLE ydoc_docs ADD COLUMN export_attempt_snapshot_seq INTEGER;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 31,
        id: "v2-ydoc-sharing-declined",
        sql: V2_YDOC_SHARING_DECLINED_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 32,
        id: "v2-owner-draft-automation-declarations",
        sql: "ALTER TABLE owner_ydoc_outbox_entries ADD COLUMN automation_declaration_json TEXT CHECK (automation_declaration_json IS NULL OR json_valid(automation_declaration_json));",
        sets_user_version: None,
    },
    Migration {
        ordinal: 33,
        id: "v2-owner-draft-terminal-refusal",
        sql: "ALTER TABLE owner_ydoc_outbox_entries ADD COLUMN terminal_blob_digest TEXT REFERENCES binary_blobs(sha256) ON DELETE RESTRICT; ALTER TABLE owner_ydoc_outbox_entries ADD COLUMN terminal_reason TEXT CHECK (terminal_reason IS NULL OR (length(terminal_reason) BETWEEN 1 AND 256 AND pending=0 AND accepted_receipt_json IS NULL));",
        sets_user_version: None,
    },
    Migration {
        ordinal: 34,
        id: "v2-owner-draft-rebound-coordinates",
        sql: V2_OWNER_BINDING_REBIND_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 35,
        id: "v2-automation-claim-parent",
        sql: "ALTER TABLE automation_claims ADD COLUMN parent_claim_id TEXT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 36,
        id: "share-direct-write-refusal-reason",
        sql: "ALTER TABLE share_direct_write_marks ADD COLUMN refusal_reason TEXT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 37,
        id: "v2-audited-projection-authors",
        sql: "CREATE TABLE live_audit_projection_authors ( \
                workspace_id TEXT NOT NULL, origin_id TEXT NOT NULL, origin_seq INTEGER NOT NULL, \
                version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL, \
                lineage_claim_id TEXT NOT NULL, author_json TEXT NOT NULL \
                  CHECK (json_valid(author_json) AND json_type(author_json)='array' \
                    AND json_array_length(author_json) BETWEEN 1 AND 1024 \
                    AND length(CAST(author_json AS BLOB))<=131072), \
                PRIMARY KEY(workspace_id,origin_id,origin_seq), \
                FOREIGN KEY(workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE \
              ) STRICT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 38,
        id: "v2-live-settlement-publication",
        sql: V2_LIVE_SETTLEMENT_PUBLICATION_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 39,
        id: "v2-retained-export-attempt-lineage",
        sql: "ALTER TABLE ydoc_docs ADD COLUMN export_attempt_lineage_claim_id TEXT; ALTER TABLE ydoc_docs ADD COLUMN export_wait_asset_sha256 TEXT; ALTER TABLE ydoc_docs ADD COLUMN export_wait_asset_path TEXT CHECK (export_wait_asset_path IS NULL OR export_wait_asset_sha256 IS NOT NULL); CREATE INDEX idx_moments_version_path_order ON moments(workspace_id,version_id,path,moment_order DESC) WHERE path GLOB 'assets/excalidraw/*';",
        sets_user_version: None,
    },
    Migration {
        ordinal: 40,
        id: "v2-open-document-artifacts",
        sql: V2_OPEN_DOCUMENT_ARTIFACTS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 41,
        id: "v2-ydoc-file-export-lane",
        sql: V2_YDOC_FILE_EXPORT_LANE_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 42,
        id: "v2-field-history-link-author",
        sql: V2_FIELD_HISTORY_LINK_AUTHOR_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 43,
        id: "v2-audited-projection-contributions",
        sql: "CREATE TABLE live_audit_projection_contributions ( \
                workspace_id TEXT NOT NULL, origin_id TEXT NOT NULL, origin_seq INTEGER NOT NULL, \
                record_digest TEXT NOT NULL, author_json TEXT NOT NULL \
                  CHECK (json_valid(author_json) AND json_type(author_json)='array' \
                    AND json_array_length(author_json) BETWEEN 1 AND 1024 \
                    AND length(CAST(author_json AS BLOB))<=131072), \
                PRIMARY KEY(workspace_id,origin_id,origin_seq,record_digest), \
                FOREIGN KEY(workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE \
              ) STRICT; \
              ALTER TABLE live_audit_projection_authors ADD COLUMN moment_base_json TEXT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 44,
        id: "v2-chat-channel-keyset-page",
        sql: "CREATE INDEX idx_chat_channels_page ON chat_channels(workspace_id, created_at_ms, channel_id);",
        sets_user_version: None,
    },
    Migration {
        ordinal: 45,
        id: "v2-chat-local-dispatch-discovery",
        sql: "CREATE TABLE chat_dispatch_local_discovery (workspace_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (workspace_id, message_id), FOREIGN KEY (workspace_id, message_id) REFERENCES chat_messages(workspace_id, message_id) ON DELETE CASCADE) STRICT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 46,
        id: "v2-moments-history-time",
        sql: "CREATE INDEX idx_moments_history_time ON moments(workspace_id, version_id, recorded_at_ms, moment_order); CREATE INDEX idx_moments_object_history_time ON moments(workspace_id, version_id, object_id, recorded_at_ms, moment_order);",
        sets_user_version: None,
    },
    Migration {
        ordinal: 47,
        id: "v2-engine-store-role",
        sql: "ALTER TABLE engine_ownership ADD COLUMN store_role TEXT NOT NULL DEFAULT 'owner' CHECK (store_role IN ('owner','passive'));",
        sets_user_version: None,
    },
    Migration {
        ordinal: 48,
        id: "v2-capture-file-holds",
        sql: "CREATE TABLE capture_file_holds (workspace_id TEXT NOT NULL, source_version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL, observed_sha256 TEXT NOT NULL CHECK(length(observed_sha256)=64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'), observed_size INTEGER NOT NULL CHECK(observed_size>=0), reason TEXT NOT NULL CHECK(reason='ydoc-resolution-not-representable'), observed_at_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL CHECK(attempt_count>0), retry_requested INTEGER NOT NULL CHECK(retry_requested IN (0,1)), PRIMARY KEY(workspace_id,path), FOREIGN KEY(workspace_id,source_version_id) REFERENCES versions(workspace_id,version_id), FOREIGN KEY(workspace_id,object_id) REFERENCES file_objects(workspace_id,object_id)) STRICT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 49,
        id: "v2-local-chat-actor-key",
        sql: "ALTER TABLE chat_messages ADD COLUMN author_actor_key TEXT CHECK (author_actor_key IS NULL OR json_valid(author_actor_key));",
        sets_user_version: None,
    },
    Migration {
        ordinal: 50,
        id: "v2-live-restore-resumed-lookup",
        sql: V2_LIVE_RESTORE_RESUMED_LOOKUP_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 51,
        id: "v2-owner-outbox-person-edit",
        sql: "ALTER TABLE owner_ydoc_outbox_entries ADD COLUMN person_edit INTEGER CHECK (person_edit IS NULL OR person_edit=1);",
        sets_user_version: None,
    },
    Migration {
        ordinal: 52,
        id: "v2-replica-frontiers",
        sql: V2_REPLICA_FRONTIERS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 53,
        id: "v2-owner-live-stops",
        sql: V2_OWNER_LIVE_STOPS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 54,
        id: "v2-retained-materialization-displacements",
        sql: V2_RETAINED_DISPLACEMENTS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 55,
        id: "v2-history-operation-correlation",
        sql: "CREATE INDEX idx_moments_operation_correlation ON moments(workspace_id, metadata_correlation_id);",
        sets_user_version: None,
    },
    Migration {
        ordinal: 56,
        id: "v2-hosted-replica",
        sql: V2_HOSTED_REPLICA_DDL,
        sets_user_version: None,
    },
    // A file retired before this names no document. It keeps its row, so
    // its path stays held and the file still goes; its document is unknown.
    Migration {
        ordinal: 57,
        id: "v2-hosted-retired-file-object",
        sql: "ALTER TABLE hosted_retired_files ADD COLUMN object_id TEXT CHECK (length(object_id) > 0);",
        sets_user_version: None,
    },
    Migration {
        ordinal: 58,
        id: "v2-hosted-parked-documents",
        sql: V2_HOSTED_PARKED_DOCUMENTS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 59,
        id: "v2-persisted-links",
        sql: include_str!("links.sql"),
        sets_user_version: None,
    },
    Migration {
        ordinal: 60,
        id: "v2-agent-run-failure-handled",
        sql: "ALTER TABLE agent_run_records RENAME COLUMN failure_note_posted TO failure_handled;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 61,
        id: "v2-ordinary-pull-progress",
        sql: V2_ORDINARY_PULL_PROGRESS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 62,
        id: "v2-history-undo-plans",
        sql: "CREATE INDEX idx_engine_requests_kind ON engine_requests(kind,request_id); \
              CREATE TABLE history_undo_plans (request_id TEXT PRIMARY KEY REFERENCES engine_requests(request_id), workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, operation_id TEXT NOT NULL, author_json TEXT, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, errors_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(errors_json)), UNIQUE(workspace_id,operation_id)) STRICT;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 63,
        id: "v2-file-search-key",
        sql: include_str!("file_search_key.sql"),
        sets_user_version: None,
    },
    Migration {
        ordinal: 64,
        id: "v2-ydoc-files-seen",
        sql: V2_YDOC_FILES_SEEN_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 65,
        id: "v2-chat-conversation-file-links",
        sql: include_str!("conversation_file_links.sql"),
        sets_user_version: None,
    },
    // A merge write that finds its target occupied looks up the pending
    // delete that expects those bytes.
    Migration {
        ordinal: 66,
        id: "v2-pending-delete-preimage-index",
        sql: "CREATE INDEX idx_materialization_jobs_pending_delete_preimage \
              ON materialization_jobs(workspace_id, preimage_sha256) \
              WHERE status = 'pending' AND operation = 'delete';",
        sets_user_version: None,
    },
    // Why the sweep can never release a retained original. A volume that
    // cannot refuse to unlink an open file keeps each one until a person or
    // an agent deletes it. Rows from before this read as unblocked until the
    // sweep checks their volume.
    Migration {
        ordinal: 67,
        id: "v2-retained-release-blocked",
        sql: "ALTER TABLE materialization_retained ADD COLUMN release_blocked TEXT \
              CHECK (release_blocked IS NULL OR release_blocked = 'busy-check-unsupported'); \
              CREATE INDEX materialization_retained_blocked \
              ON materialization_retained(workspace_id, release_blocked, size) \
              WHERE release_blocked IS NOT NULL;",
        sets_user_version: None,
    },
    Migration {
        ordinal: 68,
        id: "v2-live-owner-activations",
        sql: V2_LIVE_OWNER_ACTIVATIONS_DDL,
        sets_user_version: None,
    },
];

/// A lineage keeps its one immutable adoption. Each activation that held the
/// document since has a row: at most one unreleased per document lineage, at
/// most one successor per activation, and both links stay on one lineage.
/// An adopted activation carries every adoption fact, its lineage's origin and
/// its baseline relay coordinate; a released activation that never adopted
/// carries no adoption fact or origin, and its baseline only if it had one.
/// Every adoption becomes its own current activation, and a binding names the
/// activation of its lineage's adoption. A retirement records the exact
/// activation and restore generation it began for, before it ends any of the
/// activation's runtime, and keeps that row until the activation's release.
/// Capture finds a document lineage's released tails across namespaces by
/// `live_owner_activations_document`.
///
/// A document's released tail generation changes with every row its tails
/// read: activations, outboxes and their entries, applications and accepted
/// history, seed captures, the journal rows native entries name, the
/// document's head and lineage columns, and terminal blobs, and with the
/// stored bytes of each entry's update, which a held document's inspection
/// merges. It also moves with the state inspection loads that the
/// inspection's own coordinates do not name, so none of it can change and
/// change back unseen: a journal row past the document's latest snapshot
/// changing, going, or arriving below the top; the latest snapshot going or
/// moving back, or any snapshot's key or digest changing; an archived
/// lineage going, or its key or digest changing; and a blob a journal row,
/// snapshot or archived lineage names arriving, or its bytes changing. While
/// foreign keys are on such a blob cannot go, but one a damaged store lacks
/// can arrive. A row that claims another document still moves the document
/// whose entry holds its delivery, and an activation moves the documents of
/// every activation whose chain passes through it. Each trigger finds those
/// documents by index; a blob nothing names or one already stored, an
/// append, a row a compaction folded, a snapshot a compaction superseded, or
/// a compaction whose bound passes no sequence an entry names, moves nothing.
/// The first activation of a document creates its row, which outlives the
/// document, so a recreated document never reads an earlier generation. A
/// generation only advances, and a mutation that would take it past its
/// bound fails, whatever conflict policy the mutation names.
///
/// A hosted document held for released retained work keeps the binding it
/// holds against with its digest, how its work continues, and whether that
/// binding went stale; no other hold carries them. The binding changes only
/// with its digest, so a reader that never reads the binding still knows
/// when it changed. Any change to the binding, a hold carrying one arriving
/// or going, or such a hold moving to another document, also advances the
/// hold revision of each document it leaves or reaches, so two writes cannot
/// change the binding and restore its digest unseen. The revision is its
/// own, so a hold written never moves the released tail generation its
/// document's validations are cached by. Like a generation, a revision only
/// advances and outlives its hold. Writers never `REPLACE` rows of
/// `hosted_documents`, `ydoc_snapshots` or
/// `ydoc_inactive_lineages`: without recursive triggers its implicit delete
/// fires no trigger, and it passes the binding's guard. The binding comes
/// last in the row, so reading the rest never reaches it. Rebuilding the
/// table keeps every row, its parked heads and aliases among them. A
/// deferred Y.Doc update records which ingress deferred it, and a hosted one
/// the feed it
/// arrived on: its namespace, epoch, stream and relay sequence. A row
/// deferred earlier is local in a workspace that is no hosted replica, and
/// its feed is unknown in one that is.
///
/// A device's decision to keep a held document's retained version as an
/// ordinary copy is keyed by the binding it answers and its attempt. It keeps
/// that binding, the copy's text by digest and length, the contributions the
/// copy merged, the copy's identities and allocated path, and, once known, the
/// relay coordinate that accepted the copy and the resolution's terminal
/// outcome. The copy's text outlives no decision that names it; the copy
/// itself may go.
const V2_LIVE_OWNER_ACTIVATIONS_DDL: &str = "\
CREATE UNIQUE INDEX live_owner_adoptions_lineage ON live_owner_adoptions
    (relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id);
CREATE TABLE live_owner_activations (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) > 0),
    activation_id TEXT NOT NULL CHECK (length(CAST(activation_id AS BLOB)) BETWEEN 1 AND 1024),
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    origin_adoption_id TEXT,
    predecessor_activation_id TEXT CHECK (predecessor_activation_id IS NOT activation_id),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    source_moment_id TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    source_byte_length INTEGER NOT NULL CHECK (source_byte_length BETWEEN 0 AND 9007199254740991),
    baseline_moment_relay_sequence INTEGER CHECK (baseline_moment_relay_sequence BETWEEN 0 AND 9007199254740991),
    baseline_registered_at_ms INTEGER CHECK (baseline_registered_at_ms BETWEEN 0 AND 9007199254740991),
    host_coordinate_json TEXT NOT NULL CHECK (json_valid(host_coordinate_json)),
    evidence_digest TEXT,
    coverage_digest TEXT,
    covered_outbox_sequence INTEGER CHECK (covered_outbox_sequence BETWEEN 0 AND 9007199254740991),
    local_ydoc_sequence INTEGER CHECK (local_ydoc_sequence BETWEEN 0 AND 9007199254740991),
    terminal_cursor INTEGER CHECK (terminal_cursor BETWEEN 0 AND 9007199254740991),
    terminal_receipt_json TEXT CHECK (json_valid(terminal_receipt_json)),
    max_pending_bytes INTEGER CHECK (max_pending_bytes BETWEEN 1 AND 9007199254740991),
    max_pending_age_ms INTEGER CHECK (max_pending_age_ms BETWEEN 1 AND 9007199254740991),
    boundary_json TEXT CHECK (json_valid(boundary_json)),
    released_at_ms INTEGER CHECK (released_at_ms BETWEEN 0 AND 9007199254740991),
    released_restore_generation INTEGER CHECK (released_restore_generation BETWEEN 0 AND 9007199254740991),
    released_accepted_cursor INTEGER CHECK (released_accepted_cursor BETWEEN 0 AND 9007199254740991),
    released_boundary_json TEXT CHECK (json_valid(released_boundary_json)),
    carried_manifest_json TEXT CHECK (json_valid(carried_manifest_json)),
    CHECK ((evidence_digest IS NULL AND coverage_digest IS NULL AND covered_outbox_sequence IS NULL
            AND local_ydoc_sequence IS NULL AND terminal_cursor IS NULL AND terminal_receipt_json IS NULL
            AND max_pending_bytes IS NULL AND max_pending_age_ms IS NULL AND boundary_json IS NULL)
        OR (evidence_digest IS NOT NULL AND coverage_digest IS NOT NULL AND covered_outbox_sequence IS NOT NULL
            AND local_ydoc_sequence IS NOT NULL AND terminal_cursor IS NOT NULL AND terminal_receipt_json IS NOT NULL
            AND max_pending_bytes IS NOT NULL AND max_pending_age_ms IS NOT NULL
            AND baseline_moment_relay_sequence IS NOT NULL)),
    CHECK ((baseline_moment_relay_sequence IS NULL) = (baseline_registered_at_ms IS NULL)),
    CHECK ((origin_adoption_id IS NULL) = (evidence_digest IS NULL)),
    CHECK ((released_at_ms IS NULL AND released_restore_generation IS NULL AND released_accepted_cursor IS NULL
            AND released_boundary_json IS NULL AND carried_manifest_json IS NULL)
        OR (released_at_ms IS NOT NULL AND released_restore_generation IS NOT NULL AND released_accepted_cursor IS NOT NULL
            AND released_boundary_json IS NOT NULL AND carried_manifest_json IS NOT NULL)),
    CHECK (released_at_ms IS NOT NULL OR evidence_digest IS NOT NULL),
    PRIMARY KEY (relay_database_namespace, activation_id),
    UNIQUE (relay_database_namespace, activation_id, workspace_id, main_version_id, object_id, lineage_claim_id),
    FOREIGN KEY (relay_database_namespace, origin_adoption_id, workspace_id, main_version_id, object_id, lineage_claim_id)
        REFERENCES live_owner_adoptions(relay_database_namespace, adoption_id, workspace_id, main_version_id, object_id, lineage_claim_id),
    FOREIGN KEY (relay_database_namespace, predecessor_activation_id, workspace_id, main_version_id, object_id, lineage_claim_id)
        REFERENCES live_owner_activations(relay_database_namespace, activation_id, workspace_id, main_version_id, object_id, lineage_claim_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (lineage_claim_id) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT,
    FOREIGN KEY (source_digest) REFERENCES blobs(sha256) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX live_owner_activations_current ON live_owner_activations
    (workspace_id,main_version_id,object_id,lineage_claim_id) WHERE released_at_ms IS NULL;
CREATE UNIQUE INDEX live_owner_activations_successor ON live_owner_activations
    (relay_database_namespace,predecessor_activation_id) WHERE predecessor_activation_id IS NOT NULL;
CREATE INDEX live_owner_activations_lineage ON live_owner_activations
    (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id);
CREATE INDEX live_owner_activations_document ON live_owner_activations
    (workspace_id,main_version_id,object_id,lineage_claim_id,relay_database_namespace);
CREATE TABLE live_owner_retirements (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) > 0),
    activation_id TEXT NOT NULL CHECK (length(CAST(activation_id AS BLOB)) BETWEEN 1 AND 1024),
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    restore_fence_generation INTEGER NOT NULL CHECK (restore_fence_generation BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (relay_database_namespace, activation_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX live_owner_retirements_document ON live_owner_retirements
    (workspace_id,main_version_id,object_id);
CREATE TABLE released_tail_generations (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (workspace_id, version_id, object_id)
) STRICT;
CREATE TRIGGER released_tail_generation_advance BEFORE UPDATE ON released_tail_generations
WHEN NEW.generation NOT BETWEEN OLD.generation+1 AND 9007199254740991 OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.version_id IS NOT OLD.version_id OR NEW.object_id IS NOT OLD.object_id BEGIN
    SELECT RAISE(ABORT,'a released tail generation only advances, within its bound');
END;
CREATE TRIGGER released_tail_generation_kept BEFORE DELETE ON released_tail_generations BEGIN
    SELECT RAISE(ABORT,'a released tail generation outlives its document');
END;
CREATE INDEX owner_ydoc_outbox_entries_native_sequence ON owner_ydoc_outbox_entries
    (json_extract(native_source_json,'$.binding.objectId'),json_extract(native_source_json,'$.nativeSequence'));
CREATE INDEX owner_ydoc_outbox_entries_terminal_blob ON owner_ydoc_outbox_entries(terminal_blob_digest)
    WHERE terminal_blob_digest IS NOT NULL;
CREATE TRIGGER released_tail_activation_insert AFTER INSERT ON live_owner_activations BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    INSERT INTO released_tail_generations SELECT NEW.workspace_id,NEW.main_version_id,NEW.object_id,1
        WHERE NOT EXISTS(SELECT 1 FROM released_tail_generations
          WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (WITH RECURSIVE followers(namespace,activation_id) AS (
           SELECT NEW.relay_database_namespace,NEW.activation_id
           UNION SELECT a.relay_database_namespace,a.activation_id FROM live_owner_activations a JOIN followers f
             ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id)
         SELECT a.workspace_id,a.main_version_id,a.object_id FROM live_owner_activations a JOIN followers f
           ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id);
END;
CREATE TRIGGER released_tail_activation_update AFTER UPDATE ON live_owner_activations BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    INSERT INTO released_tail_generations SELECT NEW.workspace_id,NEW.main_version_id,NEW.object_id,1
        WHERE NOT EXISTS(SELECT 1 FROM released_tail_generations
          WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (WITH RECURSIVE followers(namespace,activation_id) AS (
           SELECT OLD.relay_database_namespace,OLD.activation_id
           UNION SELECT NEW.relay_database_namespace,NEW.activation_id
           UNION SELECT a.relay_database_namespace,a.activation_id FROM live_owner_activations a JOIN followers f
             ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id)
         SELECT a.workspace_id,a.main_version_id,a.object_id FROM live_owner_activations a JOIN followers f
           ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id);
END;
CREATE TRIGGER released_tail_activation_delete AFTER DELETE ON live_owner_activations BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (WITH RECURSIVE followers(namespace,activation_id) AS (
           SELECT OLD.relay_database_namespace,OLD.activation_id
           UNION SELECT a.relay_database_namespace,a.activation_id FROM live_owner_activations a JOIN followers f
             ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id)
         SELECT a.workspace_id,a.main_version_id,a.object_id FROM live_owner_activations a JOIN followers f
           ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id);
END;
CREATE TRIGGER released_tail_outbox_insert AFTER INSERT ON owner_ydoc_outboxes BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_outbox_update AFTER UPDATE ON owner_ydoc_outboxes BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_outbox_delete AFTER DELETE ON owner_ydoc_outboxes BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
END;
CREATE TRIGGER released_tail_entry_insert AFTER INSERT ON owner_ydoc_outbox_entries BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT workspace_id,main_version_id,object_id FROM owner_ydoc_outboxes WHERE outbox_id=NEW.outbox_id);
END;
CREATE TRIGGER released_tail_entry_update AFTER UPDATE ON owner_ydoc_outbox_entries BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT workspace_id,main_version_id,object_id FROM owner_ydoc_outboxes WHERE outbox_id=OLD.outbox_id);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT workspace_id,main_version_id,object_id FROM owner_ydoc_outboxes WHERE outbox_id=NEW.outbox_id);
END;
CREATE TRIGGER released_tail_entry_delete AFTER DELETE ON owner_ydoc_outbox_entries BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT workspace_id,main_version_id,object_id FROM owner_ydoc_outboxes WHERE outbox_id=OLD.outbox_id);
END;
CREATE TRIGGER released_tail_application_insert AFTER INSERT ON live_device_update_applications BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=NEW.delivery_id);
END;
CREATE TRIGGER released_tail_application_update AFTER UPDATE ON live_device_update_applications BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=OLD.delivery_id);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=NEW.delivery_id);
END;
CREATE TRIGGER released_tail_application_delete AFTER DELETE ON live_device_update_applications BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=OLD.delivery_id);
END;
CREATE TRIGGER released_tail_accepted_insert AFTER INSERT ON live_accepted_updates BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=NEW.delivery_id);
END;
CREATE TRIGGER released_tail_accepted_update AFTER UPDATE ON live_accepted_updates BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=OLD.delivery_id);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=NEW.delivery_id);
END;
CREATE TRIGGER released_tail_accepted_delete AFTER DELETE ON live_accepted_updates BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=OLD.delivery_id);
END;
CREATE TRIGGER released_tail_capture_insert AFTER INSERT ON ydoc_owner_activation_sources BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_capture_update AFTER UPDATE ON ydoc_owner_activation_sources BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_capture_delete AFTER DELETE ON ydoc_owner_activation_sources BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
END;
CREATE TRIGGER released_tail_journal_insert AFTER INSERT ON ydoc_updates BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id
          AND EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
            WHERE json_extract(e.native_source_json,'$.binding.objectId')=NEW.object_id
              AND json_extract(e.native_source_json,'$.nativeSequence')=NEW.seq
              AND o.workspace_id=NEW.workspace_id AND o.main_version_id=NEW.version_id AND o.object_id=NEW.object_id);
END;
CREATE TRIGGER released_tail_journal_update AFTER UPDATE ON ydoc_updates BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id
          AND EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
            WHERE json_extract(e.native_source_json,'$.binding.objectId')=OLD.object_id
              AND json_extract(e.native_source_json,'$.nativeSequence')=OLD.seq
              AND o.workspace_id=OLD.workspace_id AND o.main_version_id=OLD.version_id AND o.object_id=OLD.object_id);
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id
          AND EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
            WHERE json_extract(e.native_source_json,'$.binding.objectId')=NEW.object_id
              AND json_extract(e.native_source_json,'$.nativeSequence')=NEW.seq
              AND o.workspace_id=NEW.workspace_id AND o.main_version_id=NEW.version_id AND o.object_id=NEW.object_id);
END;
CREATE TRIGGER released_tail_journal_delete AFTER DELETE ON ydoc_updates BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id
          AND EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
            WHERE json_extract(e.native_source_json,'$.binding.objectId')=OLD.object_id
              AND json_extract(e.native_source_json,'$.nativeSequence')=OLD.seq
              AND o.workspace_id=OLD.workspace_id AND o.main_version_id=OLD.version_id AND o.object_id=OLD.object_id);
END;
CREATE TRIGGER released_tail_document_insert AFTER INSERT ON ydoc_docs BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_document_update
AFTER UPDATE OF workspace_id,version_id,object_id,lineage_claim_status,lineage_claim_id,
    lineage_parent_claim_id,lineage_epoch_tag ON ydoc_docs
WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.version_id IS NOT NEW.version_id
  OR OLD.object_id IS NOT NEW.object_id
  OR OLD.lineage_claim_status IS NOT NEW.lineage_claim_status OR OLD.lineage_claim_id IS NOT NEW.lineage_claim_id
  OR OLD.lineage_parent_claim_id IS NOT NEW.lineage_parent_claim_id OR OLD.lineage_epoch_tag IS NOT NEW.lineage_epoch_tag
BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_document_compaction AFTER UPDATE OF head_snapshot_seq ON ydoc_docs
WHEN OLD.head_snapshot_seq IS NOT NEW.head_snapshot_seq BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id
          AND EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id
            WHERE json_extract(e.native_source_json,'$.binding.objectId')=NEW.object_id
              AND json_extract(e.native_source_json,'$.nativeSequence')
                > min(OLD.head_snapshot_seq,NEW.head_snapshot_seq)
              AND json_extract(e.native_source_json,'$.nativeSequence')
                <= max(OLD.head_snapshot_seq,NEW.head_snapshot_seq)
              AND o.workspace_id=NEW.workspace_id AND o.main_version_id=NEW.version_id AND o.object_id=NEW.object_id);
END;
CREATE TRIGGER released_tail_document_delete AFTER DELETE ON ydoc_docs BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
END;
CREATE TRIGGER released_tail_blob_insert AFTER INSERT ON binary_blobs
WHEN EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries WHERE terminal_blob_digest=NEW.sha256)
  OR EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries WHERE update_digest=NEW.sha256) BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.terminal_blob_digest=NEW.sha256);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.update_digest=NEW.sha256);
END;
CREATE TRIGGER released_tail_blob_update AFTER UPDATE OF sha256,byte_length,bytes ON binary_blobs
WHEN EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries WHERE terminal_blob_digest IN (OLD.sha256,NEW.sha256))
  OR EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries WHERE update_digest IN (OLD.sha256,NEW.sha256)) BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.terminal_blob_digest IN (OLD.sha256,NEW.sha256));
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.update_digest IN (OLD.sha256,NEW.sha256));
END;
CREATE TRIGGER released_tail_blob_delete AFTER DELETE ON binary_blobs
WHEN EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries WHERE terminal_blob_digest=OLD.sha256)
  OR EXISTS(SELECT 1 FROM owner_ydoc_outbox_entries WHERE update_digest=OLD.sha256) BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.terminal_blob_digest=OLD.sha256);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.update_digest=OLD.sha256);
END;
DROP INDEX idx_ydoc_updates_doc_blob;
CREATE INDEX idx_ydoc_updates_blob ON ydoc_updates(update_blob_sha256,workspace_id,version_id,object_id);
CREATE INDEX ydoc_snapshots_blob ON ydoc_snapshots(snapshot_blob_sha256);
CREATE INDEX ydoc_inactive_lineages_full_state ON ydoc_inactive_lineages(full_state_blob_sha256);
CREATE TRIGGER released_tail_head_journal_insert AFTER INSERT ON ydoc_updates
WHEN EXISTS(SELECT 1 FROM ydoc_updates WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id
    AND object_id=NEW.object_id AND seq>NEW.seq) BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_head_journal_update
AFTER UPDATE OF workspace_id,version_id,object_id,seq,update_blob_sha256 ON ydoc_updates BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_head_journal_delete AFTER DELETE ON ydoc_updates
WHEN OLD.seq > coalesce((SELECT max(up_to_seq) FROM ydoc_snapshots WHERE workspace_id=OLD.workspace_id
    AND version_id=OLD.version_id AND object_id=OLD.object_id),0) BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
END;
CREATE TRIGGER released_tail_state_blob_update AFTER UPDATE OF sha256,byte_length,bytes ON binary_blobs
WHEN EXISTS(SELECT 1 FROM ydoc_updates WHERE update_blob_sha256 IN (OLD.sha256,NEW.sha256))
  OR EXISTS(SELECT 1 FROM ydoc_snapshots WHERE snapshot_blob_sha256 IN (OLD.sha256,NEW.sha256))
  OR EXISTS(SELECT 1 FROM ydoc_inactive_lineages WHERE full_state_blob_sha256 IN (OLD.sha256,NEW.sha256)) BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT workspace_id,version_id,object_id FROM ydoc_updates WHERE update_blob_sha256 IN (OLD.sha256,NEW.sha256));
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT workspace_id,version_id,object_id FROM ydoc_snapshots
           WHERE snapshot_blob_sha256 IN (OLD.sha256,NEW.sha256));
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT workspace_id,version_id,object_id FROM ydoc_inactive_lineages
           WHERE full_state_blob_sha256 IN (OLD.sha256,NEW.sha256));
END;
CREATE TRIGGER released_tail_state_blob_insert AFTER INSERT ON binary_blobs
WHEN EXISTS(SELECT 1 FROM ydoc_updates WHERE update_blob_sha256=NEW.sha256)
  OR EXISTS(SELECT 1 FROM ydoc_snapshots WHERE snapshot_blob_sha256=NEW.sha256)
  OR EXISTS(SELECT 1 FROM ydoc_inactive_lineages WHERE full_state_blob_sha256=NEW.sha256) BEGIN
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT workspace_id,version_id,object_id FROM ydoc_updates WHERE update_blob_sha256=NEW.sha256);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT workspace_id,version_id,object_id FROM ydoc_snapshots WHERE snapshot_blob_sha256=NEW.sha256);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id) IN
        (SELECT workspace_id,version_id,object_id FROM ydoc_inactive_lineages
           WHERE full_state_blob_sha256=NEW.sha256);
END;
CREATE TRIGGER released_tail_snapshot_update
AFTER UPDATE OF workspace_id,version_id,object_id,up_to_seq,snapshot_blob_sha256 ON ydoc_snapshots
WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.version_id IS NOT NEW.version_id
  OR OLD.object_id IS NOT NEW.object_id OR OLD.up_to_seq IS NOT NEW.up_to_seq
  OR OLD.snapshot_blob_sha256 IS NOT NEW.snapshot_blob_sha256 BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_snapshot_delete AFTER DELETE ON ydoc_snapshots
WHEN OLD.up_to_seq > coalesce((SELECT max(up_to_seq) FROM ydoc_snapshots WHERE workspace_id=OLD.workspace_id
    AND version_id=OLD.version_id AND object_id=OLD.object_id),-1) BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
END;
CREATE TRIGGER released_tail_archive_update
AFTER UPDATE OF workspace_id,version_id,object_id,lineage_claim_id,full_state_blob_sha256 ON ydoc_inactive_lineages
WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.version_id IS NOT NEW.version_id
  OR OLD.object_id IS NOT NEW.object_id OR OLD.lineage_claim_id IS NOT NEW.lineage_claim_id
  OR OLD.full_state_blob_sha256 IS NOT NEW.full_state_blob_sha256 BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER released_tail_archive_delete AFTER DELETE ON ydoc_inactive_lineages BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND object_id=OLD.object_id;
END;
INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,main_version_id,
    object_id,lineage_claim_id,origin_adoption_id,binding_json,source_moment_id,source_digest,source_byte_length,
    baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,
    covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms)
  SELECT relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,adoption_id,
    binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,
    baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,
    local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms
  FROM live_owner_adoptions;
ALTER TABLE live_device_application_bindings ADD COLUMN activation_id TEXT
    CHECK (length(CAST(activation_id AS BLOB)) BETWEEN 1 AND 1024);
UPDATE live_device_application_bindings SET activation_id=(SELECT a.adoption_id FROM live_owner_adoptions a
    WHERE a.relay_database_namespace=live_device_application_bindings.relay_database_namespace
      AND a.workspace_id=live_device_application_bindings.workspace_id
      AND a.main_version_id=live_device_application_bindings.main_version_id
      AND a.object_id=live_device_application_bindings.object_id
      AND a.lineage_claim_id=live_device_application_bindings.lineage_claim_id);
CREATE TEMP TABLE hosted_parked_snapshots_kept AS SELECT * FROM hosted_parked_snapshots;
CREATE TEMP TABLE hosted_parked_path_aliases_kept AS SELECT * FROM hosted_parked_path_aliases;
DROP TABLE hosted_parked_path_aliases;
DROP TABLE hosted_parked_snapshots;
CREATE TABLE hosted_documents_next (
    workspace_id TEXT NOT NULL REFERENCES hosted_replicas(workspace_id) ON DELETE CASCADE,
    object_id TEXT NOT NULL,
    path TEXT NOT NULL CHECK (length(path) > 0),
    state TEXT NOT NULL CHECK (state IN ('backfilling','held','ready','parked')),
    held_reason TEXT CHECK (held_reason IN
      ('hosted-backfill-path-held','hosted-backfill-work-waiting','hosted-scope-path-mismatch',
       'hosted-conflict-parent-withheld','hosted-live-edit-unadmitted','released-lineage-unsettled')),
    held_path TEXT CHECK (length(held_path) > 0),
    held_by TEXT CHECK (length(held_by) > 0),
    held_conflict_id TEXT CHECK (length(held_conflict_id) > 0),
    backfill_cursor INTEGER NOT NULL DEFAULT 0 CHECK (backfill_cursor >= 0),
    scope_generation INTEGER NOT NULL CHECK (scope_generation >= 0),
    unmaterialized_seq INTEGER CHECK (unmaterialized_seq > 0),
    released_hold_continuation TEXT CHECK (released_hold_continuation IN ('frozen','dependency-drain')),
    released_hold_binding_stale INTEGER NOT NULL DEFAULT 0 CHECK (released_hold_binding_stale IN (0,1)),
    released_hold_binding_digest TEXT CHECK (length(released_hold_binding_digest) = 64
      AND released_hold_binding_digest NOT GLOB '*[^0-9a-f]*'),
    released_hold_binding_json TEXT CHECK (json_valid(released_hold_binding_json)),
    PRIMARY KEY (workspace_id, object_id),
    CHECK ((state = 'held') = (held_reason IS NOT NULL)),
    CHECK ((held_by IS NOT NULL) = (held_reason IS 'hosted-backfill-path-held')),
    CHECK ((held_conflict_id IS NOT NULL) = (held_reason IS 'hosted-conflict-parent-withheld')),
    CHECK (held_reason IS NOT 'hosted-backfill-path-held' OR held_path IS NOT NULL),
    CHECK (held_reason NOT IN ('hosted-backfill-work-waiting','hosted-conflict-parent-withheld',
      'hosted-live-edit-unadmitted','released-lineage-unsettled') OR held_path IS NULL),
    CHECK (state <> 'parked' OR unmaterialized_seq IS NULL),
    CHECK ((released_hold_binding_json IS NOT NULL) = (held_reason IS 'released-lineage-unsettled')),
    CHECK ((released_hold_binding_digest IS NOT NULL) = (held_reason IS 'released-lineage-unsettled')),
    CHECK ((released_hold_continuation IS NOT NULL) = (held_reason IS 'released-lineage-unsettled')),
    CHECK (held_reason IS 'released-lineage-unsettled' OR released_hold_binding_stale = 0)
) STRICT;
INSERT INTO hosted_documents_next (workspace_id,object_id,path,state,held_reason,held_path,
    held_by,held_conflict_id,backfill_cursor,scope_generation,unmaterialized_seq)
  SELECT workspace_id,object_id,path,state,held_reason,held_path,held_by,held_conflict_id,
    backfill_cursor,scope_generation,unmaterialized_seq FROM hosted_documents;
DROP TABLE hosted_documents;
ALTER TABLE hosted_documents_next RENAME TO hosted_documents;
CREATE TRIGGER released_hold_binding_digest_moves BEFORE UPDATE OF released_hold_binding_json ON hosted_documents
WHEN OLD.released_hold_binding_json IS NOT NEW.released_hold_binding_json
  AND OLD.released_hold_binding_digest IS NEW.released_hold_binding_digest BEGIN
    SELECT RAISE(ABORT,'a released hold binding changes with its digest');
END;
CREATE TABLE released_hold_revisions (
    workspace_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (workspace_id, object_id)
) STRICT;
CREATE TRIGGER released_hold_revision_advance BEFORE UPDATE ON released_hold_revisions
WHEN NEW.revision NOT BETWEEN OLD.revision+1 AND 9007199254740991 OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.object_id IS NOT OLD.object_id BEGIN
    SELECT RAISE(ABORT,'a released hold revision only advances, within its bound');
END;
CREATE TRIGGER released_hold_revision_kept BEFORE DELETE ON released_hold_revisions BEGIN
    SELECT RAISE(ABORT,'a released hold revision outlives its hold');
END;
CREATE TRIGGER released_hold_revision_insert AFTER INSERT ON hosted_documents
WHEN NEW.released_hold_binding_json IS NOT NULL BEGIN
    UPDATE released_hold_revisions SET revision=revision+1
        WHERE workspace_id=NEW.workspace_id AND object_id=NEW.object_id;
    INSERT INTO released_hold_revisions SELECT NEW.workspace_id,NEW.object_id,1
        WHERE NOT EXISTS(SELECT 1 FROM released_hold_revisions
          WHERE workspace_id=NEW.workspace_id AND object_id=NEW.object_id);
END;
CREATE TRIGGER released_hold_revision_update
AFTER UPDATE OF workspace_id,object_id,released_hold_binding_json ON hosted_documents
WHEN OLD.released_hold_binding_json IS NOT NEW.released_hold_binding_json
  OR (OLD.released_hold_binding_json IS NOT NULL
    AND (OLD.workspace_id IS NOT NEW.workspace_id OR OLD.object_id IS NOT NEW.object_id)) BEGIN
    UPDATE released_hold_revisions SET revision=revision+1
        WHERE workspace_id=OLD.workspace_id AND object_id=OLD.object_id;
    INSERT INTO released_hold_revisions SELECT OLD.workspace_id,OLD.object_id,1
        WHERE NOT EXISTS(SELECT 1 FROM released_hold_revisions
          WHERE workspace_id=OLD.workspace_id AND object_id=OLD.object_id);
    UPDATE released_hold_revisions SET revision=revision+1
        WHERE workspace_id=NEW.workspace_id AND object_id=NEW.object_id;
    INSERT INTO released_hold_revisions SELECT NEW.workspace_id,NEW.object_id,1
        WHERE NOT EXISTS(SELECT 1 FROM released_hold_revisions
          WHERE workspace_id=NEW.workspace_id AND object_id=NEW.object_id);
END;
CREATE TRIGGER released_hold_revision_delete AFTER DELETE ON hosted_documents
WHEN OLD.released_hold_binding_json IS NOT NULL BEGIN
    UPDATE released_hold_revisions SET revision=revision+1
        WHERE workspace_id=OLD.workspace_id AND object_id=OLD.object_id;
    INSERT INTO released_hold_revisions SELECT OLD.workspace_id,OLD.object_id,1
        WHERE NOT EXISTS(SELECT 1 FROM released_hold_revisions
          WHERE workspace_id=OLD.workspace_id AND object_id=OLD.object_id);
END;
CREATE TABLE hosted_parked_snapshots (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    path TEXT NOT NULL,
    blob_sha256 TEXT REFERENCES blobs(sha256),
    updated_at_ms INTEGER NOT NULL,
    latest_moment_id TEXT NOT NULL,
    metadata_origin TEXT NOT NULL,
    content_kind TEXT NOT NULL CHECK (content_kind IN ('text', 'binary')),
    binary_sha256 TEXT REFERENCES binary_blobs(sha256),
    metadata_summary TEXT,
    metadata_correlation_id TEXT,
    CHECK (
        (content_kind = 'text'   AND blob_sha256   IS NOT NULL AND binary_sha256 IS NULL)
     OR (content_kind = 'binary' AND binary_sha256 IS NOT NULL AND blob_sha256   IS NULL)
    ),
    PRIMARY KEY (workspace_id, version_id, object_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES hosted_documents(workspace_id, object_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX hosted_parked_snapshots_by_document ON hosted_parked_snapshots(workspace_id, object_id);
CREATE TABLE hosted_parked_path_aliases (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    path TEXT NOT NULL,
    object_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version_id, path, object_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES hosted_documents(workspace_id, object_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX hosted_parked_path_aliases_by_document
  ON hosted_parked_path_aliases(workspace_id, object_id, version_id, path);
INSERT INTO hosted_parked_snapshots (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
    latest_moment_id,metadata_origin,content_kind,binary_sha256,metadata_summary,metadata_correlation_id)
  SELECT workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,
    content_kind,binary_sha256,metadata_summary,metadata_correlation_id FROM temp.hosted_parked_snapshots_kept;
INSERT INTO hosted_parked_path_aliases (workspace_id,version_id,path,object_id)
  SELECT workspace_id,version_id,path,object_id FROM temp.hosted_parked_path_aliases_kept;
DROP TABLE temp.hosted_parked_snapshots_kept;
DROP TABLE temp.hosted_parked_path_aliases_kept;
ALTER TABLE ydoc_deferred_updates ADD COLUMN relay_namespace TEXT
    CHECK (relay_namespace IS NULL OR length(CAST(relay_namespace AS BLOB)) > 0);
ALTER TABLE ydoc_deferred_updates ADD COLUMN replication_epoch TEXT
    CHECK (replication_epoch IS NULL OR length(CAST(replication_epoch AS BLOB)) > 0);
ALTER TABLE ydoc_deferred_updates ADD COLUMN stream_identity TEXT
    CHECK (stream_identity IS NULL OR length(CAST(stream_identity AS BLOB)) > 0);
ALTER TABLE ydoc_deferred_updates ADD COLUMN ingress_kind TEXT NOT NULL DEFAULT 'legacy-unknown'
    CHECK (ingress_kind IN ('local','hosted','legacy-unknown')
      AND (ingress_kind <> 'hosted' OR (relay_namespace IS NOT NULL AND replication_epoch IS NOT NULL
        AND stream_identity IS NOT NULL AND relay_seq IS NOT NULL AND relay_seq > 0)));
UPDATE ydoc_deferred_updates SET ingress_kind='local'
  WHERE NOT EXISTS(SELECT 1 FROM hosted_replicas h WHERE h.workspace_id=ydoc_deferred_updates.workspace_id);
ALTER TABLE ydoc_deferred_updates ADD COLUMN lineage_replacement_json TEXT
    CHECK (lineage_replacement_json IS NULL OR json_valid(lineage_replacement_json));
ALTER TABLE ydoc_deferred_updates ADD COLUMN applied_refusal TEXT
    CHECK (applied_refusal IS NULL OR length(applied_refusal) > 0);
ALTER TABLE relay_deferred_ops ADD COLUMN relay_namespace TEXT
    CHECK (relay_namespace IS NULL OR length(CAST(relay_namespace AS BLOB)) > 0);
ALTER TABLE relay_deferred_ops ADD COLUMN ingress_kind TEXT NOT NULL DEFAULT 'legacy-unknown'
    CHECK (ingress_kind IN ('local','hosted','legacy-unknown')
      AND (ingress_kind <> 'hosted' OR (relay_namespace IS NOT NULL
        AND length(CAST(replication_epoch AS BLOB)) > 0 AND length(CAST(stream_identity AS BLOB)) > 0
        AND json_type(envelope_json,'$.relaySeq') IS 'integer'
        AND json_extract(envelope_json,'$.relaySeq') > 0)));
UPDATE relay_deferred_ops SET ingress_kind='local'
  WHERE NOT EXISTS(SELECT 1 FROM hosted_replicas h WHERE h.workspace_id=relay_deferred_ops.workspace_id);
CREATE TABLE ydoc_drain_reports (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    report_json TEXT NOT NULL CHECK (json_valid(report_json)),
    report_id TEXT,
    PRIMARY KEY(workspace_id,origin_id,origin_seq)
) STRICT;
DROP TRIGGER ydoc_pending_artifacts_settled;
CREATE TRIGGER ydoc_pending_artifacts_settled AFTER UPDATE OF last_settled_sha,settled_update_seq ON ydoc_docs
WHEN NEW.settled_update_seq=NEW.head_update_seq AND EXISTS (
    SELECT 1 FROM snapshots s WHERE s.workspace_id=NEW.workspace_id
      AND s.version_id=NEW.version_id AND s.object_id=NEW.object_id
      AND s.blob_sha256=NEW.last_settled_sha)
BEGIN
    DELETE FROM replication_pending_refusals WHERE workspace_id=NEW.workspace_id
      AND reason_code='document-artifact-recovery-failed'
      AND (origin_id,origin_seq) IN (SELECT origin_id,origin_seq FROM ydoc_pending_artifacts
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id);
    DELETE FROM ydoc_pending_artifacts WHERE workspace_id=NEW.workspace_id
      AND version_id=NEW.version_id AND object_id=NEW.object_id
      AND NOT EXISTS (SELECT 1 FROM ydoc_deferred_updates u WHERE u.workspace_id=NEW.workspace_id
        AND u.version_id=NEW.version_id AND u.object_id=NEW.object_id);
END;
CREATE TABLE released_hold_copy_decisions (
    workspace_id TEXT NOT NULL,
    binding_digest TEXT NOT NULL CHECK (length(binding_digest)=64 AND binding_digest NOT GLOB '*[^0-9a-f]*'),
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 9007199254740991),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json) AND json_type(binding_json)='object'
      AND json_extract(binding_json,'$.workspaceId') IS workspace_id),
    projection_sha256 TEXT NOT NULL
      CHECK (length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
    projection_byte_length INTEGER NOT NULL CHECK (projection_byte_length BETWEEN 0 AND 9007199254740991),
    merged_contribution_ids_json TEXT NOT NULL
      CHECK (json_valid(merged_contribution_ids_json) AND json_type(merged_contribution_ids_json)='array'),
    recovery_object_id TEXT NOT NULL CHECK (length(recovery_object_id) > 0),
    recovery_moment_id TEXT NOT NULL CHECK (length(recovery_moment_id) > 0),
    recovered_path TEXT NOT NULL CHECK (length(recovered_path) > 0),
    collision_ordinal TEXT NOT NULL
      CHECK (length(collision_ordinal) > 0 AND collision_ordinal NOT GLOB '*[^0-9]*'),
    recovery_author_json TEXT NOT NULL CHECK (json_valid(recovery_author_json)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    accepted_recovery_origin_id TEXT CHECK (length(accepted_recovery_origin_id) > 0),
    accepted_recovery_origin_seq INTEGER CHECK (accepted_recovery_origin_seq BETWEEN 0 AND 9007199254740991),
    accepted_recovery_relay_seq INTEGER CHECK (accepted_recovery_relay_seq BETWEEN 1 AND 9007199254740991),
    resolution_outcome TEXT CHECK (resolution_outcome IN ('resolved','stale')),
    resolution_outcome_at_ms INTEGER CHECK (resolution_outcome_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK ((accepted_recovery_origin_id IS NULL AND accepted_recovery_origin_seq IS NULL
            AND accepted_recovery_relay_seq IS NULL)
        OR (accepted_recovery_origin_id IS NOT NULL AND accepted_recovery_origin_seq IS NOT NULL
            AND accepted_recovery_relay_seq IS NOT NULL)),
    CHECK ((resolution_outcome IS NULL) = (resolution_outcome_at_ms IS NULL)),
    PRIMARY KEY (workspace_id, binding_digest, attempt),
    UNIQUE (workspace_id, recovery_object_id),
    UNIQUE (workspace_id, recovery_moment_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (projection_sha256) REFERENCES blobs(sha256) ON DELETE RESTRICT
) STRICT;
CREATE INDEX released_hold_copy_decisions_projection ON released_hold_copy_decisions(projection_sha256);
";

/// The triggers that keep and move a released tail generation, keep a hold's
/// binding with its digest, and keep and advance its hold revision. A store
/// missing one would keep tails, or release proofs, its rows no longer prove.
pub(crate) const RELEASED_TAIL_TRIGGERS: &[&str] = &[
    "released_tail_generation_advance",
    "released_tail_generation_kept",
    "released_tail_activation_insert",
    "released_tail_activation_update",
    "released_tail_activation_delete",
    "released_tail_outbox_insert",
    "released_tail_outbox_update",
    "released_tail_outbox_delete",
    "released_tail_entry_insert",
    "released_tail_entry_update",
    "released_tail_entry_delete",
    "released_tail_application_insert",
    "released_tail_application_update",
    "released_tail_application_delete",
    "released_tail_accepted_insert",
    "released_tail_accepted_update",
    "released_tail_accepted_delete",
    "released_tail_capture_insert",
    "released_tail_capture_update",
    "released_tail_capture_delete",
    "released_tail_journal_insert",
    "released_tail_journal_update",
    "released_tail_journal_delete",
    "released_tail_document_insert",
    "released_tail_document_update",
    "released_tail_document_compaction",
    "released_tail_document_delete",
    "released_tail_blob_insert",
    "released_tail_blob_update",
    "released_tail_blob_delete",
    "released_tail_head_journal_insert",
    "released_tail_head_journal_update",
    "released_tail_head_journal_delete",
    "released_tail_state_blob_update",
    "released_tail_state_blob_insert",
    "released_tail_snapshot_update",
    "released_tail_snapshot_delete",
    "released_tail_archive_update",
    "released_tail_archive_delete",
    "released_hold_binding_digest_moves",
    "released_hold_revision_advance",
    "released_hold_revision_kept",
    "released_hold_revision_insert",
    "released_hold_revision_update",
    "released_hold_revision_delete",
];

/// Documents whose file a `ydoc.open` found on disk while the version had no
/// head for it: New File's empty file, before capture records it. A moment
/// records every other file a document has had. Together they tell a session
/// that continues the document whether its missing file was deleted.
const V2_YDOC_FILES_SEEN_DDL: &str = "\
CREATE TABLE ydoc_files_seen (
    workspace_id TEXT NOT NULL,
    version_id   TEXT NOT NULL,
    object_id    TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id),
    FOREIGN KEY (workspace_id, version_id)
      REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;
";

/// The ordinary pull pass whose applied pages await their terminal commit.
/// A replication identity change abandons it.
const V2_ORDINARY_PULL_PROGRESS_DDL: &str = "\
ALTER TABLE sync_identity ADD COLUMN ordinary_pull_token TEXT
    CHECK (ordinary_pull_token IS NULL OR length(ordinary_pull_token) > 0);
CREATE TRIGGER sync_identity_change_abandons_ordinary_pull
AFTER UPDATE OF origin_id,replication_epoch,stream_identity ON sync_identity
WHEN NEW.ordinary_pull_token IS NOT NULL
  AND (OLD.origin_id IS NOT NEW.origin_id OR OLD.replication_epoch IS NOT NEW.replication_epoch
    OR OLD.stream_identity IS NOT NEW.stream_identity)
BEGIN
    UPDATE sync_identity SET ordinary_pull_token=NULL WHERE workspace_id=NEW.workspace_id;
END;
";

/// A hosted document that left the scope parks instead of losing its state.
/// Its heads and path aliases move to the parked tables, whose blob keys keep
/// their bytes, so its paths come free while its history, Y.Doc and
/// activation stay for its return. A returning document whose history holds
/// a live edit the host never admitted is held. `unmaterialized_seq` is the
/// relay position of the newest row of a document a pass applied before any
/// committed pass wrote its files, so a document that leaves the scope first
/// can still finish them before it parks.
const V2_HOSTED_PARKED_DOCUMENTS_DDL: &str = "\
CREATE TABLE hosted_documents_next (
    workspace_id TEXT NOT NULL REFERENCES hosted_replicas(workspace_id) ON DELETE CASCADE,
    object_id TEXT NOT NULL,
    path TEXT NOT NULL CHECK (length(path) > 0),
    state TEXT NOT NULL CHECK (state IN ('backfilling','held','ready','parked')),
    held_reason TEXT CHECK (held_reason IN
      ('hosted-backfill-path-held','hosted-backfill-work-waiting','hosted-scope-path-mismatch',
       'hosted-conflict-parent-withheld','hosted-live-edit-unadmitted')),
    held_path TEXT CHECK (length(held_path) > 0),
    held_by TEXT CHECK (length(held_by) > 0),
    held_conflict_id TEXT CHECK (length(held_conflict_id) > 0),
    backfill_cursor INTEGER NOT NULL DEFAULT 0 CHECK (backfill_cursor >= 0),
    scope_generation INTEGER NOT NULL CHECK (scope_generation >= 0),
    unmaterialized_seq INTEGER CHECK (unmaterialized_seq > 0),
    PRIMARY KEY (workspace_id, object_id),
    CHECK ((state = 'held') = (held_reason IS NOT NULL)),
    CHECK ((held_by IS NOT NULL) = (held_reason IS 'hosted-backfill-path-held')),
    CHECK ((held_conflict_id IS NOT NULL) = (held_reason IS 'hosted-conflict-parent-withheld')),
    CHECK (held_reason IS NOT 'hosted-backfill-path-held' OR held_path IS NOT NULL),
    CHECK (held_reason NOT IN ('hosted-backfill-work-waiting','hosted-conflict-parent-withheld',
      'hosted-live-edit-unadmitted') OR held_path IS NULL),
    CHECK (state <> 'parked' OR unmaterialized_seq IS NULL)
) STRICT;
INSERT INTO hosted_documents_next (workspace_id,object_id,path,state,held_reason,held_path,
    held_by,held_conflict_id,backfill_cursor,scope_generation)
  SELECT workspace_id,object_id,path,state,held_reason,held_path,held_by,held_conflict_id,
    backfill_cursor,scope_generation FROM hosted_documents;
DROP TABLE hosted_documents;
ALTER TABLE hosted_documents_next RENAME TO hosted_documents;
CREATE TABLE hosted_parked_snapshots (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    path TEXT NOT NULL,
    blob_sha256 TEXT REFERENCES blobs(sha256),
    updated_at_ms INTEGER NOT NULL,
    latest_moment_id TEXT NOT NULL,
    metadata_origin TEXT NOT NULL,
    content_kind TEXT NOT NULL CHECK (content_kind IN ('text', 'binary')),
    binary_sha256 TEXT REFERENCES binary_blobs(sha256),
    metadata_summary TEXT,
    metadata_correlation_id TEXT,
    CHECK (
        (content_kind = 'text'   AND blob_sha256   IS NOT NULL AND binary_sha256 IS NULL)
     OR (content_kind = 'binary' AND binary_sha256 IS NOT NULL AND blob_sha256   IS NULL)
    ),
    PRIMARY KEY (workspace_id, version_id, object_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES hosted_documents(workspace_id, object_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX hosted_parked_snapshots_by_document ON hosted_parked_snapshots(workspace_id, object_id);
CREATE TABLE hosted_parked_path_aliases (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    path TEXT NOT NULL,
    object_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version_id, path, object_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES hosted_documents(workspace_id, object_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX hosted_parked_path_aliases_by_document
  ON hosted_parked_path_aliases(workspace_id, object_id, version_id, path);
";

const V2_REPLICA_FRONTIERS_DDL: &str = "\
CREATE TABLE replica_frontiers (
    workspace_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    log_cursor INTEGER NOT NULL CHECK (log_cursor BETWEEN 0 AND 9007199254740991),
    journal_cursor INTEGER NOT NULL CHECK (journal_cursor BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE replica_documents (
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL CHECK (length(lineage_claim_id)=64 AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'),
    relay_database_namespace TEXT NOT NULL,
    restore_generation INTEGER NOT NULL CHECK (restore_generation BETWEEN 1 AND 9007199254740991),
    event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 9007199254740991),
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
    journal_cursor INTEGER NOT NULL CHECK (journal_cursor BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY(workspace_id,main_version_id,object_id,lineage_claim_id)
) STRICT;
CREATE TABLE replica_first_seen (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL CHECK (length(lineage_claim_id)=64 AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'),
    client_id INTEGER NOT NULL CHECK (client_id BETWEEN 0 AND 9007199254740991),
    start_clock INTEGER NOT NULL CHECK (start_clock BETWEEN 0 AND 9007199254740991),
    end_clock INTEGER NOT NULL CHECK (end_clock BETWEEN 1 AND 9007199254740991 AND end_clock>start_clock),
    PRIMARY KEY(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock)
) STRICT;
";

const V2_OWNER_LIVE_STOPS_DDL: &str = "\
ALTER TABLE owner_ydoc_outboxes ADD COLUMN pending_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_entry_count>=0);
UPDATE owner_ydoc_outboxes SET pending_entry_count=(SELECT COUNT(*) FROM owner_ydoc_outbox_entries e WHERE e.outbox_id=owner_ydoc_outboxes.outbox_id AND e.pending=1);
CREATE TRIGGER owner_outbox_count_insert AFTER INSERT ON owner_ydoc_outbox_entries WHEN NEW.pending=1 BEGIN
    UPDATE owner_ydoc_outboxes SET pending_entry_count=pending_entry_count+1 WHERE outbox_id=NEW.outbox_id;
END;
CREATE TRIGGER owner_outbox_count_delete AFTER DELETE ON owner_ydoc_outbox_entries WHEN OLD.pending=1 BEGIN
    UPDATE owner_ydoc_outboxes SET pending_entry_count=pending_entry_count-1 WHERE outbox_id=OLD.outbox_id;
END;
CREATE TRIGGER owner_outbox_count_update AFTER UPDATE OF pending,outbox_id ON owner_ydoc_outbox_entries WHEN OLD.pending<>NEW.pending OR OLD.outbox_id<>NEW.outbox_id BEGIN
    UPDATE owner_ydoc_outboxes SET pending_entry_count=pending_entry_count-OLD.pending WHERE outbox_id=OLD.outbox_id;
    UPDATE owner_ydoc_outboxes SET pending_entry_count=pending_entry_count+NEW.pending WHERE outbox_id=NEW.outbox_id;
END;
CREATE TABLE owner_live_stops (
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    relay_database_namespace TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('requested','released')),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= requested_at_ms),
    PRIMARY KEY(workspace_id,main_version_id,object_id),
    FOREIGN KEY(workspace_id,main_version_id,object_id) REFERENCES ydoc_docs(workspace_id,version_id,object_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_owner_live_stops_requested ON owner_live_stops(workspace_id,main_version_id,object_id) WHERE state='requested';
";

/// A session host's replica of the documents the relay's scoped feed serves
/// it. The row is the replica kind: admission, deferred replay and outbound
/// sequences read it, never an inference from other state.
const V2_HOSTED_REPLICA_DDL: &str = "\
CREATE TABLE hosted_replicas (
    workspace_id TEXT NOT NULL PRIMARY KEY REFERENCES sync_identity(workspace_id),
    scope_token TEXT CHECK (scope_token IS NULL OR length(scope_token) > 0),
    scope_generation INTEGER NOT NULL DEFAULT 0 CHECK (scope_generation >= 0),
    main_cursor INTEGER NOT NULL DEFAULT 0 CHECK (main_cursor >= 0),
    cursor_commits INTEGER NOT NULL DEFAULT 0 CHECK (cursor_commits >= 0),
    last_outbound_seq INTEGER NOT NULL DEFAULT -1 CHECK (last_outbound_seq >= -1),
    created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE hosted_documents (
    workspace_id TEXT NOT NULL REFERENCES hosted_replicas(workspace_id) ON DELETE CASCADE,
    object_id TEXT NOT NULL,
    path TEXT NOT NULL CHECK (length(path) > 0),
    state TEXT NOT NULL CHECK (state IN ('backfilling','held','ready')),
    held_reason TEXT CHECK (held_reason IN
      ('hosted-backfill-path-held','hosted-backfill-work-waiting','hosted-scope-path-mismatch',
       'hosted-conflict-parent-withheld')),
    held_path TEXT CHECK (length(held_path) > 0),
    held_by TEXT CHECK (length(held_by) > 0),
    held_conflict_id TEXT CHECK (length(held_conflict_id) > 0),
    backfill_cursor INTEGER NOT NULL DEFAULT 0 CHECK (backfill_cursor >= 0),
    scope_generation INTEGER NOT NULL CHECK (scope_generation >= 0),
    PRIMARY KEY (workspace_id, object_id),
    CHECK ((state = 'held') = (held_reason IS NOT NULL)),
    CHECK ((held_by IS NOT NULL) = (held_reason IS 'hosted-backfill-path-held')),
    CHECK ((held_conflict_id IS NOT NULL) = (held_reason IS 'hosted-conflict-parent-withheld')),
    CHECK (held_reason IS NOT 'hosted-backfill-path-held' OR held_path IS NOT NULL),
    CHECK (held_reason NOT IN ('hosted-backfill-work-waiting','hosted-conflict-parent-withheld')
      OR held_path IS NULL)
) STRICT;
CREATE TABLE hosted_withheld_befores (
    workspace_id TEXT NOT NULL REFERENCES hosted_replicas(workspace_id) ON DELETE CASCADE,
    moment_id TEXT NOT NULL,
    before_object_id TEXT NOT NULL,
    before_path TEXT NOT NULL,
    before_sha256 TEXT NOT NULL,
    before_content_kind TEXT NOT NULL CHECK (before_content_kind IN ('text','binary')),
    PRIMARY KEY (workspace_id, moment_id),
    FOREIGN KEY (workspace_id, moment_id)
      REFERENCES moments(workspace_id, moment_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE hosted_deferred_ops (
    workspace_id TEXT NOT NULL REFERENCES hosted_replicas(workspace_id) ON DELETE CASCADE,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    object_id TEXT NOT NULL,
    relay_seq INTEGER NOT NULL CHECK (relay_seq > 0),
    PRIMARY KEY (workspace_id, origin_id, origin_seq),
    FOREIGN KEY (workspace_id, origin_id, origin_seq)
      REFERENCES relay_deferred_ops(workspace_id, origin_id, origin_seq) ON DELETE CASCADE
) STRICT;
CREATE INDEX hosted_deferred_ops_by_document ON hosted_deferred_ops(workspace_id, object_id, relay_seq);
CREATE TABLE hosted_retired_files (
    workspace_id TEXT NOT NULL REFERENCES hosted_replicas(workspace_id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK (length(path) > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    PRIMARY KEY (workspace_id, path)
) STRICT;
";

const V2_OPEN_DOCUMENT_ARTIFACTS_DDL: &str = "\
CREATE TABLE replication_pending_refusals_next (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK (origin_seq >= 0),
    op_kind TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code IN ('invalid-input','document-artifact-recovery-failed')),
    reason_message TEXT NOT NULL,
    report_id TEXT,
    PRIMARY KEY(workspace_id,origin_id,origin_seq),
    FOREIGN KEY(workspace_id,origin_id,origin_seq)
      REFERENCES replication_log(workspace_id,origin_id,origin_seq)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO replication_pending_refusals_next SELECT * FROM replication_pending_refusals;
DROP TABLE replication_pending_refusals;
ALTER TABLE replication_pending_refusals_next RENAME TO replication_pending_refusals;
CREATE INDEX replication_pending_refusals_by_report ON replication_pending_refusals(workspace_id,report_id);
ALTER TABLE ydoc_docs ADD COLUMN last_local_update_seq INTEGER NOT NULL DEFAULT 0;
UPDATE ydoc_docs SET last_local_update_seq=head_update_seq
    WHERE head_update_seq>COALESCE(settled_update_seq,0);
CREATE TABLE ydoc_pending_artifacts (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    moment_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    last_attempt_state TEXT,
    PRIMARY KEY(workspace_id,version_id,object_id),
    FOREIGN KEY(workspace_id,version_id,object_id)
      REFERENCES ydoc_docs(workspace_id,version_id,object_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,moment_id)
      REFERENCES moments(workspace_id,moment_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX replication_ydoc_origin_document ON replication_log(workspace_id,
    json_extract(payload_json,'$.versionId'),json_extract(payload_json,'$.objectId'),origin_id,origin_seq)
    WHERE op_kind='ydoc.update';
CREATE TRIGGER ydoc_pending_artifacts_settled AFTER UPDATE OF last_settled_sha,settled_update_seq ON ydoc_docs
WHEN NEW.settled_update_seq=NEW.head_update_seq AND EXISTS (
    SELECT 1 FROM snapshots s WHERE s.workspace_id=NEW.workspace_id
      AND s.version_id=NEW.version_id AND s.object_id=NEW.object_id
      AND s.blob_sha256=NEW.last_settled_sha)
BEGIN
    DELETE FROM replication_pending_refusals WHERE workspace_id=NEW.workspace_id
      AND reason_code='document-artifact-recovery-failed'
      AND (origin_id,origin_seq) IN (SELECT origin_id,origin_seq FROM ydoc_pending_artifacts
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id AND object_id=NEW.object_id);
    DELETE FROM ydoc_pending_artifacts WHERE workspace_id=NEW.workspace_id
      AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER ydoc_local_tail_retired AFTER UPDATE OF head_update_seq ON ydoc_docs
WHEN NEW.head_update_seq<OLD.head_update_seq
BEGIN
    UPDATE ydoc_docs SET last_local_update_seq=0 WHERE workspace_id=NEW.workspace_id
      AND version_id=NEW.version_id AND object_id=NEW.object_id;
END;
CREATE TRIGGER ydoc_recovery_mark_advanced BEFORE UPDATE OF origin_id,origin_seq ON ydoc_pending_artifacts
WHEN OLD.last_attempt_state IS NOT NULL
BEGIN
    DELETE FROM replication_pending_refusals WHERE workspace_id=OLD.workspace_id
      AND origin_id=OLD.origin_id AND origin_seq=OLD.origin_seq
      AND reason_code='document-artifact-recovery-failed';
END;
CREATE TRIGGER ydoc_recovery_text_repaired AFTER UPDATE OF text ON blobs
BEGIN
    UPDATE ydoc_pending_artifacts SET last_attempt_state=NULL WHERE last_attempt_state IS NOT NULL
      AND EXISTS(SELECT 1 FROM snapshots s WHERE s.workspace_id=ydoc_pending_artifacts.workspace_id
        AND s.version_id=ydoc_pending_artifacts.version_id AND s.object_id=ydoc_pending_artifacts.object_id
        AND s.blob_sha256=NEW.sha256);
END;
CREATE TRIGGER ydoc_recovery_blob_repaired AFTER UPDATE OF bytes ON binary_blobs
BEGIN
    UPDATE ydoc_pending_artifacts SET last_attempt_state=NULL WHERE last_attempt_state IS NOT NULL;
END;

";

/// Lowercase-hex sha-256 of the migration DDL — the checksum stored in and
/// re-verified against the ledger.
pub(crate) fn migration_checksum(sql: &str) -> String {
    crate::blob::hex_sha256(sql.as_bytes())
}

#[cfg(feature = "fault-injection")]
#[inline]
fn should_crash(faults: &dyn FaultInjector, point: FaultPoint) -> bool {
    faults.poll(point) == crate::faults::FaultAction::Crash
}

#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
fn should_crash(_faults: &dyn FaultInjector, _point: FaultPoint) -> bool {
    false
}

/// A migration's ledger state on the current store.
enum LedgerStatus {
    /// No completed row (or the ledger table does not exist yet — a fresh store).
    Missing,
    /// Completed; carries the recorded checksum for the compatibility check.
    Complete { checksum: String },
}

fn ledger_status(conn: &Connection, id: &str) -> Result<LedgerStatus, StorageError> {
    let row = conn
        .query_row(
            "SELECT checksum FROM engine_migrations WHERE id = ?1 AND completed_at IS NOT NULL",
            [id],
            |r| r.get::<_, String>(0),
        )
        .optional();
    match row {
        Ok(Some(checksum)) => Ok(LedgerStatus::Complete { checksum }),
        Ok(None) => Ok(LedgerStatus::Missing),
        // A fresh store has no `engine_migrations` table until the baseline
        // creates it; that is 'missing', not an error.
        Err(rusqlite::Error::SqliteFailure(_, Some(ref msg))) if msg.contains("no such table") => {
            Ok(LedgerStatus::Missing)
        }
        Err(other) => Err(StorageError::migration(other)),
    }
}

/// `PRAGMA quick_check` → true iff the sole result row is `ok`.
fn quick_check_ok(conn: &Connection) -> Result<bool, StorageError> {
    let result: String = conn
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(StorageError::migration)?;
    Ok(result.eq_ignore_ascii_case("ok"))
}

/// Assert the migration list is well-formed: strictly increasing ordinals and
/// unique ids. The runner trusts slice order to be ordinal order, so a list
/// appended out of order would otherwise apply DDL out of order with no other
/// trip. Fail closed instead.
fn validate_migration_order(migrations: &[Migration]) -> Result<(), StorageError> {
    let mut seen_ids = std::collections::HashSet::new();
    let mut prev_ordinal: Option<u32> = None;
    for migration in migrations {
        if let Some(prev) = prev_ordinal
            && migration.ordinal <= prev
        {
            return Err(StorageError::MigrationFailed { source: None });
        }
        prev_ordinal = Some(migration.ordinal);
        if !seen_ids.insert(migration.id) {
            return Err(StorageError::MigrationFailed { source: None });
        }
    }
    Ok(())
}

/// The refusal for a store a newer build migrated, or `None`. The ledger must
/// be this engine's, which the baseline row proves, and hold a row
/// `migrations` does not define. A newer build wrote that row, whether or not
/// its migration completed, and this build cannot know what it changed.
/// Reads only, so the open ritual asks before it writes anything.
pub(crate) fn newer_build_refusal(
    conn: &Connection,
    migrations: &[Migration],
) -> rusqlite::Result<Option<StorageError>> {
    let mut ledger = match conn
        .prepare("SELECT ordinal, id FROM engine_migrations ORDER BY ordinal")
    {
        Ok(statement) => statement,
        // No ledger, no newer migration. The open's validation judges the
        // rest of the file.
        Err(rusqlite::Error::SqliteFailure(_, Some(ref msg))) if msg.contains("no such table") => {
            return Ok(None);
        }
        Err(other) => return Err(other),
    };
    let rows = ledger
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !rows.iter().any(|(_, id)| id == BASELINE_MIGRATION_ID) {
        return Ok(None);
    }
    Ok(rows
        .into_iter()
        .find(|(_, id)| !migrations.iter().any(|migration| migration.id == id))
        .map(|(ordinal, id)| StorageError::MigratedByNewerBuild {
            ordinal,
            // The id reaches the desktop's technical details; bound it.
            id: id.chars().take(64).collect(),
        }))
}

/// Run every pending migration in `migrations` (ordered) against `conn`,
/// idempotently and crash-recoverably. Safe to call on every open: already-
/// applied migrations are skipped after a checksum check.
pub(crate) fn run_migrations(
    conn: &mut Connection,
    migrations: &[Migration],
    ctx: &MigrationContext,
    faults: &dyn FaultInjector,
) -> Result<MigrationOutcome, StorageError> {
    // Fail closed on a malformed migration list before touching the store.
    validate_migration_order(migrations)?;

    let mut newly_applied = 0u32;
    for (index, migration) in migrations.iter().enumerate() {
        // `migrate.between-steps`: a crash after a prior migration committed but
        // before this one begins. Restart resumes from the ledger.
        if index > 0 && should_crash(faults, FaultPoint::MigrateBetweenSteps) {
            return Ok(MigrationOutcome::Crashed);
        }

        match ledger_status(conn, migration.id)? {
            LedgerStatus::Complete { checksum } => {
                let expected = migration_checksum(migration.sql);
                if checksum != expected {
                    // A completed migration whose DDL this build defines
                    // differently — a tampered or incompatible ledger. Fail
                    // closed rather than skip-and-diverge. The two checksum
                    // prefixes tell a reader which build wrote the store.
                    return Err(StorageError::MigrationFailed {
                        source: Some(
                            format!(
                                "migration {} ({}) was applied from a different definition than this build's: the store recorded {}, this build defines {}",
                                migration.ordinal,
                                migration.id,
                                checksum.chars().take(12).collect::<String>(),
                                &expected[..12]
                            )
                            .into(),
                        ),
                    });
                }
                continue;
            }
            LedgerStatus::Missing => {}
        }

        match apply_transactional(conn, migration, ctx, faults)? {
            MigrationOutcome::Crashed => return Ok(MigrationOutcome::Crashed),
            MigrationOutcome::Applied { .. } => newly_applied += 1,
        }
    }
    Ok(MigrationOutcome::Applied { newly_applied })
}

pub(crate) fn refuse_declared_v1_evidence(conn: &Connection) -> Result<(), StorageError> {
    let has_ledger: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_migrations')", [], |row| row.get(0),
    ).map_err(StorageError::migration)?;
    if has_ledger && conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM engine_migrations WHERE id='v2-live-admitted-metadata-receipts' AND completed_at IS NOT NULL)", [], |row| row.get::<_, bool>(0),
    ).map_err(StorageError::migration)? {
        return Ok(());
    }
    let has_columns: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('live_device_update_applications') WHERE name='declared_agent_id')", [], |row| row.get(0),
    ).map_err(StorageError::migration)?;
    let declared_application = has_columns && conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_device_update_applications WHERE declared_agent_id IS NOT NULL OR declared_on_behalf_of IS NOT NULL OR declared_depth IS NOT NULL)", [], |row| row.get::<_, bool>(0),
    ).map_err(StorageError::migration)?;
    let has_history: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='live_accepted_updates')", [], |row| row.get(0),
    ).map_err(StorageError::migration)?;
    let declared_history = has_history && conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_accepted_updates WHERE json_type(metadata_json, '$.accepted.agentDeclaration') IS NOT NULL)", [], |row| row.get::<_, bool>(0),
    ).map_err(StorageError::migration)?;
    let has_chunks: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='live_audit_record_chunks')", [], |row| row.get(0),
    ).map_err(StorageError::migration)?;
    let mut declared_audit = false;
    if has_chunks {
        // The portable application framing precedes the bounded accepted header.
        let prefix_bytes = crate::limits::MAX_LIVE_ACCEPTED_HEADER_BYTES + 8192;
        let mut statement = conn.prepare("SELECT substr(b.bytes,1,?1) FROM live_audit_record_chunks c JOIN binary_blobs b ON b.sha256=c.chunk_sha256 WHERE c.ordinal=0")
            .map_err(StorageError::migration)?;
        let prefixes = statement
            .query_map([prefix_bytes as i64], |row| row.get::<_, Vec<u8>>(0))
            .map_err(StorageError::migration)?;
        for prefix in prefixes {
            let prefix = prefix.map_err(StorageError::migration)?;
            let marker = b",\"metadata\":{\"accepted\":";
            let Some(start) = prefix
                .windows(marker.len())
                .position(|bytes| bytes == marker)
            else {
                continue;
            };
            let accepted = &prefix[start + marker.len()..];
            let Some(end) = accepted
                .windows(b",\"firstSeen\":".len())
                .position(|bytes| bytes == b",\"firstSeen\":")
            else {
                continue;
            };
            declared_audit |= accepted[..end]
                .windows(b",\"agentDeclaration\":".len())
                .any(|bytes| bytes == b",\"agentDeclaration\":");
            if declared_audit {
                break;
            }
        }
    }
    if declared_application || declared_history || declared_audit {
        return Err(StorageError::MigrationFailed { source: Some(
            "Migration 29 cannot open a store with declared v1 accepted evidence. Its data is unchanged. For a development reset, delete <workspace>/.dohc/engine.".into(),
        ) });
    }
    Ok(())
}

fn apply_transactional(
    conn: &mut Connection,
    migration: &Migration,
    ctx: &MigrationContext,
    faults: &dyn FaultInjector,
) -> Result<MigrationOutcome, StorageError> {
    let checksum = migration_checksum(migration.sql);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::migration)?;

    if migration.id == "v2-live-admitted-metadata-receipts" {
        refuse_declared_v1_evidence(&tx)?;
    }

    tx.execute_batch(migration.sql)
        .map_err(StorageError::migration)?;

    if let Some(version) = migration.sets_user_version {
        // Participates in the transaction; rolls back with a crashed apply.
        tx.pragma_update(None, "user_version", version)
            .map_err(StorageError::migration)?;
    }

    // The baseline (ordinal 0) stamps the engine-ownership record. Bound params
    // (build/timestamp) cannot ride the DDL batch, so it is seeded here; the
    // opaque UUID is generated by SQLite so no Rust RNG dependency is needed.
    if migration.ordinal == 0 {
        tx.execute(
            "INSERT INTO engine_ownership \
             (rowid_guard, engine_uuid, created_at_ms, engine_build, schema_version) \
             VALUES (1, lower(hex(randomblob(16))), ?1, ?2, ?3)",
            rusqlite::params![ctx.now_ms, ctx.engine_build, ENGINE_SCHEMA_VERSION],
        )
        .map_err(StorageError::migration)?;
        if let Some(token) = &ctx.initial_root_token {
            tx.execute(
                "INSERT INTO shadow_clone (rowid_guard, token) VALUES (1, ?1)",
                [token],
            )
            .map_err(StorageError::migration)?;
        }
    }

    let integrity_ok = quick_check_ok(&tx)?;
    if !integrity_ok {
        // A migration that produces a structurally broken store never commits.
        return Err(StorageError::MigrationFailed { source: None });
    }

    tx.execute(
        "INSERT INTO engine_migrations \
         (ordinal, id, checksum, engine_build, protocol_version, transactional, \
          started_at, completed_at, integrity_ok) \
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, 1) \
         ON CONFLICT(id) DO UPDATE SET \
           checksum = excluded.checksum, completed_at = excluded.completed_at, \
           integrity_ok = excluded.integrity_ok",
        rusqlite::params![
            migration.ordinal,
            migration.id,
            checksum,
            ctx.engine_build,
            ctx.protocol_version,
            ctx.now_ms,
        ],
    )
    .map_err(StorageError::migration)?;

    // `migrate.before-ledger-commit`: body + ledger staged, not yet durable. A
    // crash rolls the whole transaction back; restart re-runs from scratch.
    if should_crash(faults, FaultPoint::MigrateBeforeLedgerCommit) {
        drop(tx); // explicit rollback
        return Ok(MigrationOutcome::Crashed);
    }

    tx.commit().map_err(StorageError::migration)?;
    Ok(MigrationOutcome::Applied { newly_applied: 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p0_passive_upgrade_adds_empty_retention_without_originating_work() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-retained-materialization-displacements");
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 54);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute("UPDATE engine_ownership SET store_role='passive'", [])
            .unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        assert!(crate::schema::store_is_passive(&conn).unwrap());
        for table in [
            "materialization_retained",
            "materialization_staging_locations",
            "materialization_displacement_reads",
            "materialization_jobs",
            "replication_log",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
    }

    #[test]
    fn p0_upgrade_adds_retention_without_changing_jobs() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-retained-materialization-displacements");
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 54);
        // Migration 67 changes the table 54 creates, so a store without 54
        // predates 67 too.
        let without_retention: Vec<_> = BASELINE_MIGRATIONS
            .iter()
            .copied()
            .filter(|migration| !matches!(migration.ordinal, 54 | 67))
            .collect();
        run_migrations(&mut conn, &without_retention, &ctx, &NoFaults).unwrap();
        let sha = crate::blob::put_binary_blob(&conn, b"before").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        crate::materialize::enqueue_job(
            &tx,
            &crate::MaterializationJobSpec {
                job_id: "pending".into(),
                workspace_id: "ws".into(),
                target_path: "notes.md".into(),
                content_sha256: sha,
                preimage: crate::Preimage::Absent,
                target_generation: 1,
                now_ms: 1,
            },
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 2 }
        );
        let jobs:i64=conn.query_row("SELECT COUNT(*) FROM materialization_jobs WHERE job_id='pending' AND status='pending'",[],|r|r.get(0)).unwrap();
        assert_eq!(jobs, 1);
        for ordinal in [54, 55, 56, 67] {
            let applied: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM engine_migrations WHERE ordinal=?1 AND completed_at IS NOT NULL",
                    [ordinal],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(applied, 1, "migration {ordinal} applied once");
        }
        let history_index: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='idx_moments_operation_correlation')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(history_index, "migration 55's index survives migration 54");
        assert_eq!(
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 0 }
        );
        for table in [
            "materialization_retained",
            "materialization_displacement_reads",
            "materialization_staging_locations",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[cfg(feature = "fault-injection")]
    use crate::faults::FaultAction;
    use crate::faults::NoFaults;

    fn field_history_link_upgrade(rows: i64) {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let mut conn = open_bare(&path);
        let ctx = MigrationContext::current(1000);
        let target = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == "v2-field-history-link-author")
            .unwrap_or(BASELINE_MIGRATIONS.len());
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..target], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','main',0);").unwrap();
        let tx = conn.transaction().unwrap();
        {
            let mut insert = tx.prepare("INSERT INTO collection_field_history(workspace_id,version_id,record_id,field_name,previous_value_json,next_value_json,author_origin_id,source_origin_id,source_origin_seq,recorded_at_ms,actor_kind,on_behalf_of,chain_depth,automation_claim_id,automation_name) VALUES ('ws','main','record','status','\"before\"','\"after\"','actor','source',?1,?1,'automation','person',2,'claim','Stamp')").unwrap();
            for id in 1..=rows {
                insert.execute([id]).unwrap();
            }
        }
        tx.commit().unwrap();
        let root = |conn: &Connection| {
            conn.query_row(
                "SELECT rootpage FROM sqlite_schema WHERE name='collection_field_history'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        };
        let before_root = root(&conn);
        let start = std::time::Instant::now();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        println!(
            "field_history_link_migration: rows={rows} on_disk=true elapsed_ns={}",
            start.elapsed().as_nanos()
        );
        assert_eq!(root(&conn), before_root, "the table was not rebuilt");
        let unchanged: i64 = conn.query_row("SELECT count(*) FROM collection_field_history WHERE history_id=source_origin_seq AND recorded_at_ms=history_id AND workspace_id='ws' AND version_id='main' AND record_id='record' AND field_name='status' AND previous_value_json='\"before\"' AND next_value_json='\"after\"' AND author_origin_id='actor' AND source_origin_id='source' AND actor_kind='automation' AND on_behalf_of='person' AND chain_depth=2 AND automation_claim_id='claim' AND automation_name='Stamp' AND link_author_json IS NULL", [], |row| row.get(0)).unwrap();
        assert_eq!(unchanged, rows);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM collection_field_history", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            rows
        );
        conn.execute("INSERT INTO collection_field_history(workspace_id,version_id,record_id,field_name,recorded_at_ms,link_author_json) VALUES ('ws','main','record','status',?1,?2)", rusqlite::params![rows+1, r#"{"kind":"link","grantId":"grant","grantGeneration":1,"publicPrincipalId":"public"}"#]).unwrap();
        assert_eq!(conn.last_insert_rowid(), rows + 1);
        assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('collection_field_history_by_record','collection_field_history_by_source')", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        drop(conn);
        let mut conn = open_bare(&path);
        assert_eq!(root(&conn), before_root);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM collection_field_history", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            rows + 1
        );
        assert_eq!(
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 0 }
        );
    }

    #[test]
    fn field_history_link_migration_preserves_populated_rows() {
        field_history_link_upgrade(3);
    }

    #[test]
    #[ignore = "manual migration timing on one million persisted rows"]
    fn field_history_link_migration_million_rows() {
        field_history_link_upgrade(1_000_000);
    }
    #[cfg(feature = "fault-injection")]
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Editing a shipped migration strands every store that already applied
    /// it: the ledger checksum stops matching and the open fails closed. A
    /// schema change appends a migration. Change a pin here only to reject
    /// every existing store on purpose.
    #[test]
    fn shipped_migrations_keep_their_checksums() {
        let pinned = [
            (
                "v2-baseline",
                "fe1e3530330b43dd501800fb8dd66d18b2c32a19b8e158a9d25a243650f510ce",
            ),
            (
                "v2-groups",
                "5eaec46edc3fec5c729e8cca60c994be2c90299d9f06db842b276872d3e77075",
            ),
            (
                "v2-agent-owner",
                "1b2a97da5260065640bdaaa9cfc2bad24cba32a08755db6fdf0e57a6aec52754",
            ),
            (
                "v2-owner-settlement-lookup",
                "4a0f33de170847a66bce66949d7eae39aadd6280f52fe5a6685f12bb1ff98ca1",
            ),
            (
                "v2-owner-pending-settlements",
                "b512dfef371e1c09e92508e2633e122e18c4421df0505a9f5c851b65fe26e0c4",
            ),
            (
                "v2-automation-change-facts",
                "664e71f126144d9f2e90379cf12a84952dd768f765070bfbc62a0e0989a78f9c",
            ),
            (
                "v2-relay-bootstrap-complete",
                "bb22e47bbdec585d028462a7927b7f87c04437dbe9f8bd9940ce9ba3117e1001",
            ),
            (
                "v2-relay-deferred-ops",
                "1290cb517b2ca2e246daa474eb9e3ed8ba2446ba64b59f68fd00b016f3492407",
            ),
            (
                "v2-automation-record-lifecycle",
                "6415d033148cd23041a34cb07b6520e03718c6b0c9f6b4c1d13bd4d6612002ba",
            ),
            (
                "v2-chat-automation-author",
                "d5589dd027faf792b65857b27897731a0da25379df7b421c2c8749985ac1e947",
            ),
            (
                "v2-automation-trigger-keys",
                "57599cccea26a02546761c6e3ea414ceff2a38d7bdbe631807ed9c4db910f03a",
            ),
            (
                "v2-automation-buttons-and-schedules",
                "64a653b710618fbc4ae3031f6cd1382c4fab7f8c730c9e79392ca6f45fa0ab00",
            ),
            (
                "v2-remote-changes",
                "e7025812c2e9291510cd2a8fb99b6f5cd54bc001244b1e36ac399160dda57212",
            ),
            (
                "v2-share-direct-writes",
                "8a34d5488c9313ad8f2ad2b84cb5c274ff1e2a9a06b962a14141e9188b399c46",
            ),
            (
                "v2-authored-create-intent",
                "be47dca6cca30c2330af64417998687bd61443adf6ad5677325216f63b9a590e",
            ),
            (
                "v2-ydoc-settled-update-seq",
                "ff19c6ed0c9ceb9d4fde2fc59e12529c5e428a9ef722d7c4280748e839e1e65a",
            ),
            (
                "v2-automation-group-coverage",
                "5b2247e5582d3fdb328eae4d4af88ae7c2e9be8acf0e2dd8aa6ccfa81d23afe8",
            ),
            (
                "v2-sync-identity-claim-state",
                "3cf872e265017c043dd394e9a67c6a3108cec735d06c7cab6f89d00b164feaee",
            ),
            (
                "v2-materialization-displacements",
                "2887eaf2ca3af9e0361b7dce143eddaf80e94c60dfaf46bcb2b29443c735a36b",
            ),
            (
                "v2-automation-claim-shared-author",
                "8533e507bf0a0d99971e20ce73e57068b076986b2088166c144a0345aa03e7ae",
            ),
            (
                "v2-automation-claim-live-cursor",
                "e0e03940b8d14b9e61ba21a9ea5d2d99410074802e43a5d0f593761d3a27c942",
            ),
            (
                "v2-automation-run-retention",
                "6adf05d0ee7187060acef8edd6ef82b1aaf482eeedd8c0e0c994c676b11a895a",
            ),
            (
                "v2-materialization-text-blobs",
                "2f5662203a97d14c1ecd6e1902a1dfd2d1b0dfe11734fe7c12b4a2982fc317ca",
            ),
            (
                "v2-record-history-automation-run",
                "7a31e23961f026d1e131b1473e9e6f47e867b00c40bb5090ada94d7fedf07a83",
            ),
            (
                "v2-ydoc-live-edit-authors",
                "33ec61e3e1f37d0908e6e5eac829e9e5a749e2834e4ce42729716fc32fe5d938",
            ),
            (
                "v2-owner-draft-agent-declarations",
                "7bb36813afe82921b70fa48a9fe0fa99bf0506f041bf1781e57892fc03d9d867",
            ),
            (
                "v2-live-application-agent-declarations",
                "047aea88c31886283062cc9f717639888ddc3129ba6bb927ff3e94404224eec5",
            ),
            (
                "v2-live-admitted-metadata-receipts",
                "384caa34711fd4cc1431c153d3e567f33b4c99e8f5428175f7c76c64f7ef83c3",
            ),
            (
                "v2-retained-head-export-attempts",
                "ba1421193e0df1585620c17a25e4a1e085340eb5669438b0e23046351b7073df",
            ),
            (
                "v2-ydoc-sharing-declined",
                "8a42bb97818cd2b4456555336bc1d2819b96e68b66280cf4366d2021bded0c02",
            ),
            (
                "v2-owner-draft-automation-declarations",
                "81dcb94e818f3455ac41f94852312d1b707c36694286732743ce0ba96377a23b",
            ),
            (
                "v2-owner-draft-terminal-refusal",
                "c6c1ffbba30e745b1ba3ab8903f3f99cebece197004a5bd220074a626f83d06f",
            ),
            (
                "v2-owner-draft-rebound-coordinates",
                "f8a202bc0daef9617dd578e89cd74b1939888ea7e5c1baa001e7a6c1f8aadb67",
            ),
            (
                "v2-automation-claim-parent",
                "40ce1151cb687e0cd5a4f3ccca776ab3a1fbae59ff5f143b79d149c5b3e36c29",
            ),
            (
                "share-direct-write-refusal-reason",
                "736fa9f1e41d88dc962377d775966f3295f1b412a0f531aae1fd5b404c838dcc",
            ),
            (
                "v2-audited-projection-authors",
                "cb6dbdfebbadb6df1f3c271f602022a40d5ef543d72681275ab50450f4483437",
            ),
            (
                "v2-live-settlement-publication",
                "e37325b7a31bbba1c63cfd891cbecd6054809201002ac482c95ab41d54ad8458",
            ),
            (
                "v2-retained-export-attempt-lineage",
                "e971935dc8d67177407762aab1adae46e2c7def69762f4e0764239a28a5feed8",
            ),
            (
                "v2-open-document-artifacts",
                "2a4525cbf68a02045589052295e240bc621fc2de73f96f3a549d505bc06394d7",
            ),
            (
                "v2-ydoc-file-export-lane",
                "7caa4d6ee7db128cdb9b6b87e2c05b487ce39cb4b5f93ac96b2da5d4bbec7175",
            ),
            (
                "v2-field-history-link-author",
                "459b1b741b2a2ae0ee53c7c4696a6935ad651ae5905c1e3da42642f88ee413f0",
            ),
            (
                "v2-audited-projection-contributions",
                "ffe123de3b71b3874993b68c764c0f939d081ec784a982d8dc8b359152955d55",
            ),
            (
                "v2-chat-channel-keyset-page",
                "67a6a8d2f92652a3d1cbbdf98b66d8441830a2db5a74502cdd15ca4c23851001",
            ),
            (
                "v2-chat-local-dispatch-discovery",
                "659dcf6fbde5b08aa32a066d0c07cdd6bfe8514fae5cc718904d0de059ef4eb6",
            ),
            (
                "v2-moments-history-time",
                "5aa8707d5659bbfb8e3e0076c812d1d723a011e6cfb32fefe490f8b1066b2c39",
            ),
            (
                "v2-engine-store-role",
                "8d75962511b05d48c91ea5c041ed69c8ab6b181212aee4c0cad4c7e16f61a54b",
            ),
            (
                "v2-capture-file-holds",
                "e5326f922618067ec6dec0bed092a8ea98c929a101f5166e448f935cd8ac9dfc",
            ),
            (
                "v2-local-chat-actor-key",
                "f84d0497555ff288db36304ed0c4b41b7f61d1d7f10396b9fd08a61da0fc7219",
            ),
            (
                "v2-live-restore-resumed-lookup",
                "ccc7e17969beb6ae6259e9ce174863fa91d15c2bdad66c3f8232e8b236ff8b8c",
            ),
            (
                "v2-owner-outbox-person-edit",
                "55940512b28bebcdda24b3c86763c66e29416eed55f157b8c06edf9f5b5622df",
            ),
            (
                "v2-replica-frontiers",
                "b42454c383b3e4b2b7c107a4c2b7abe56476235d857dba46aa3fbbae1a790af3",
            ),
            (
                "v2-owner-live-stops",
                "fd9a692216dd5b73e9c3f08bee04b16dbcd313084e370a3592db4c8bc59d9adb",
            ),
            (
                "v2-retained-materialization-displacements",
                "a3acee99edade72fc8fda127206bcf641f876ad08fb4b39ce96c50afc372a2b3",
            ),
            (
                "v2-history-operation-correlation",
                "c0f4d24b926a03be07f0999f3aab707da566b2de18654243031f0cb1b80a4819",
            ),
            (
                "v2-hosted-replica",
                "332fbe3728b51bdb26a1cc9cc0d8d1da4decd311aa991687be899f4def7c7468",
            ),
            (
                "v2-hosted-retired-file-object",
                "7eb78041929d56613f64fd29f5f68200564dd7c08421ce869e96f4a36cb5c675",
            ),
            (
                "v2-hosted-parked-documents",
                "d6090f08905899107200c732a3c4301d726213b87489861b1af664515bcf5b44",
            ),
            (
                "v2-persisted-links",
                "605a6d01c45ddce5f97465428a20e9f5b2d3185f3e9da2c550a1072521062f44",
            ),
            (
                "v2-agent-run-failure-handled",
                "56e87a5adcc33c2af1f301c3c25c91fe7c6b1c738f34e35ccd629080d89bcc50",
            ),
            (
                "v2-ordinary-pull-progress",
                "d97e08cea4e222c34c253d21da14e714bf118ac330e0b0ea3891f2d499e8097e",
            ),
            (
                "v2-history-undo-plans",
                "804873129399ca333652a5efdfc20b18e2219671d068e70ee2a78dc3a2c92783",
            ),
            (
                "v2-file-search-key",
                "60447cc5e4274b65f3f9e71a830288acfc896ac0899d471e8bcebaf754519695",
            ),
            (
                "v2-ydoc-files-seen",
                "85a36c7e1b7e392360e0caf3136b589cfcf0e052d4a26c53118e1ce045b32b5d",
            ),
            (
                "v2-chat-conversation-file-links",
                "a976e7546ecf2efacaa0e885b966bfaac96f4c2b1c3ca24f417fbf3b645bdd22",
            ),
            (
                "v2-pending-delete-preimage-index",
                "a6ead02cfa43cab0395717b10b07be6e314baa0b453c09ebb63c56df2267d08b",
            ),
            (
                "v2-retained-release-blocked",
                "16b4bee68d7fde08b97ade0bd28c4969c185b73bb65bf54ceb6006bfeaee40ff",
            ),
            (
                "v2-live-owner-activations",
                "ab7c083adc62cd7ceb164fda18d23f473673bf6c024c091742e292d84683cd5b",
            ),
        ];
        assert_eq!(BASELINE_MIGRATIONS.len(), pinned.len());
        for (migration, (id, checksum)) in BASELINE_MIGRATIONS.iter().zip(pinned) {
            assert_eq!(migration.id, id);
            assert_eq!(
                migration_checksum(migration.sql),
                checksum,
                "the {id} migration changed after it shipped"
            );
        }
    }

    #[test]
    #[ignore = "scheduled migration 65 alias-index measurement"]
    fn conversation_links_measure_migration_alias_index_on_large_store() {
        assert!(
            !std::hint::black_box(cfg!(debug_assertions)),
            "run with --release"
        );
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-chat-conversation-file-links");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON; BEGIN;
            INSERT INTO versioned_workspaces VALUES('ws','v-0');",
        )
        .unwrap();
        for i in 0..10 {
            conn.execute("INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES('ws',?1,'named','Measured',1)",[format!("v-{i}")]).unwrap();
        }
        {
            let mut object = conn
                .prepare_cached("INSERT INTO file_objects VALUES('ws',?1,1)")
                .unwrap();
            for i in 0..50_000 {
                object.execute([format!("f-{i:06}")]).unwrap();
            }
            let mut alias = conn
                .prepare_cached("INSERT INTO path_aliases VALUES('ws',?1,?2,?3)")
                .unwrap();
            for version in 0..10 {
                for i in 0..50_000 {
                    alias
                        .execute(rusqlite::params![
                            format!("v-{version}"),
                            format!("notes/{}/file-{i:06}.md", "long-label/".repeat(8)),
                            format!("f-{i:06}")
                        ])
                        .unwrap();
                }
            }
        }
        conn.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        let bytes_before = std::fs::metadata(dir.join("engine.db")).unwrap().len();
        let start = std::time::Instant::now();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let migration_us = start.elapsed().as_micros();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        let bytes_after = std::fs::metadata(dir.join("engine.db")).unwrap().len();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM chat_conversation_file_link_state",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        // Measure just the alias-index DDL too, on the same populated store.
        conn.execute_batch(
            "DROP INDEX conversation_file_link_alias; PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .unwrap();
        let start = std::time::Instant::now();
        conn.execute_batch("CREATE INDEX conversation_file_link_alias ON path_aliases(workspace_id,version_id,object_id,path);").unwrap();
        let index_us = start.elapsed().as_micros();
        println!(
            "CONVERSATION_LINKS_MIGRATION_MEASUREMENT {{\"aliases\":500000,\"objects\":50000,\"versions\":10,\"migrationUs\":{migration_us},\"aliasIndexUs\":{index_us},\"databaseBytesBefore\":{bytes_before},\"databaseBytesAfter\":{bytes_after}}}"
        );
    }

    #[test]
    fn conversation_links_migrations_64_and_65_apply_in_order_from_fresh_and_main_64() {
        for resume_at_main_64 in [false, true] {
            let dir = tempdir();
            let path = dir.join("engine.db");
            let mut conn = open_bare(&path);
            let ctx = MigrationContext::current(1);
            let before = migration_index("v2-chat-conversation-file-links");
            let predecessor = &BASELINE_MIGRATIONS[before - 1];
            assert_eq!(
                (predecessor.ordinal, predecessor.id),
                (64, "v2-ydoc-files-seen")
            );
            assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 65);
            let prior = if resume_at_main_64 {
                run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
                let row: (String, String) = conn.query_row(
                    "SELECT id,checksum FROM engine_migrations WHERE ordinal=64 AND completed_at IS NOT NULL",
                    [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
                assert_eq!(
                    row,
                    (predecessor.id.into(), migration_checksum(predecessor.sql))
                );
                conn.execute_batch("INSERT INTO versioned_workspaces VALUES('ws','main');
                    INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES('ws','main','named','Main',1);
                    INSERT INTO ydoc_files_seen VALUES('ws','main','seen-before-links');").unwrap();
                drop(conn);
                conn = open_bare(&path);
                Some(row)
            } else {
                None
            };
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
            let rows: Vec<(i64, String, String)> = conn.prepare(
                "SELECT ordinal,id,checksum FROM engine_migrations WHERE ordinal BETWEEN 64 AND 65 AND completed_at IS NOT NULL ORDER BY ordinal"
            ).unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
                .collect::<Result<_,_>>().unwrap();
            assert_eq!(
                rows,
                vec![
                    (
                        64,
                        predecessor.id.into(),
                        migration_checksum(predecessor.sql)
                    ),
                    (
                        65,
                        "v2-chat-conversation-file-links".into(),
                        migration_checksum(BASELINE_MIGRATIONS[before].sql)
                    ),
                ]
            );
            if let Some(prior) = prior {
                assert_eq!((rows[0].1.clone(), rows[0].2.clone()), prior);
                assert_eq!(
                    conn.query_row("SELECT object_id FROM ydoc_files_seen", [], |r| r
                        .get::<_, String>(0))
                        .unwrap(),
                    "seen-before-links"
                );
            }
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM chat_conversation_file_link_state",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
    }

    #[test]
    fn pending_delete_preimage_index_covers_jobs_from_main_65() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-pending-delete-preimage-index");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 65);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 66);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        let sha = crate::blob::hex_sha256(b"old");
        conn.execute(
            "INSERT INTO blobs(sha256,byte_length,text) VALUES(?1,3,'old')",
            [&sha],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO materialization_jobs(job_id,target_path,content_sha256,preimage_present,preimage_sha256,target_generation,status,created_at_ms,operation,workspace_id) \
             VALUES('merge-mat_old','notes.md',?1,1,?1,1,'pending',1,'delete','ws')",
            [&sha],
        )
        .unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let jobs = crate::materialize::pending_merge_deletes_expecting(&conn, "ws", &sha).unwrap();
        assert_eq!(
            jobs.iter()
                .map(|job| job.job_id.as_str())
                .collect::<Vec<_>>(),
            ["merge-mat_old"]
        );
        assert!(
            conn.query_row(
                "SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_materialization_jobs_pending_delete_preimage'",
                [],
                |_| Ok(()),
            )
            .is_ok()
        );
    }

    /// Rows retained before migration 67 keep their fields and read as
    /// unblocked until the sweep checks their volume. The summary reads only
    /// the blocked rows' index.
    #[test]
    fn retained_release_blocked_upgrades_rows_from_main_66() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-retained-release-blocked");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 66);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 67);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute(
            "INSERT INTO materialization_retained(job_id,workspace_id,target_path,source_path,device,inode,digest,size,mtime,ctime,changed_at_ms) \
             VALUES('job','ws','notes.md','.dohc/engine/displaced/job.0','1','2','abc',10,'0:0','0:0',5)",
            [],
        )
        .unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let rows = crate::materialize::retained_rows(&conn, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].size,
                rows[0].changed_at_ms,
                rows[0].busy_check_unsupported
            ),
            (10, 5, false)
        );
        assert_eq!(
            crate::materialize::retained_summary(&conn, "ws").unwrap(),
            crate::RetainedSummary::default()
        );
        crate::materialize::record_retained_busy_check(&conn, &rows[0], true).unwrap();
        assert_eq!(
            crate::materialize::retained_summary(&conn, "ws").unwrap(),
            crate::RetainedSummary {
                count: 1,
                bytes: 10
            }
        );
        assert!(
            conn.execute(
                "UPDATE materialization_retained SET release_blocked='busy'",
                []
            )
            .is_err(),
            "only known reasons are recorded"
        );
        let plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT COUNT(*), COALESCE(SUM(size), 0) FROM materialization_retained \
                 WHERE workspace_id=?1 AND release_blocked IS NOT NULL",
            )
            .unwrap()
            .query_map(["ws"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter()
                .any(|detail| detail.contains("COVERING INDEX materialization_retained_blocked")),
            "{plan:?}"
        );
    }

    #[test]
    fn conversation_links_upgrade_preserves_mentions_without_startup_backfill() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-chat-conversation-file-links");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 64);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 65);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO chat_attachments(workspace_id,attachment_id,thread_id,message_id,target_kind,object_id,created_at_ms) VALUES('ws','old','t','m','file','f',1);").unwrap();
        assert!(
            conn.prepare("SELECT * FROM chat_conversation_file_links")
                .is_err()
        );
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        for table in [
            "chat_conversation_file_links",
            "chat_conversation_file_link_state",
            "chat_conversation_file_link_work",
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM chat_attachments WHERE attachment_id='old'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(conn);
        let mut conn = open_bare(&dir.join("engine.db"));
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM chat_conversation_file_link_state",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn file_search_key_upgrade_preserves_rows_and_indexes_exact_deletion() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-file-search-key");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 62);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 63);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO engine_search_files_fts(workspace_id,version_id,object_id,path,text) VALUES ('ws','main','a','a.md','alpha'),('ws','other','a','a.md','other'),('ws','main','b','b.md','beta');").unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let plan: String = conn.query_row("EXPLAIN QUERY PLAN SELECT id FROM engine_search_files_fts_content WHERE c0='ws' AND c1='main' AND c2='a'", [], |row| row.get(3)).unwrap();
        assert!(
            plan.contains("COVERING INDEX idx_engine_search_files_key"),
            "{plan}"
        );
        assert_eq!(conn.execute("DELETE FROM engine_search_files_fts WHERE rowid IN (SELECT id FROM engine_search_files_fts_content WHERE c0='ws' AND c1='main' AND c2='a')", []).unwrap(), 1);
        let rows: Vec<(String,String)> = conn.prepare("SELECT version_id,object_id FROM engine_search_files_fts ORDER BY version_id,object_id").unwrap().query_map([], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(
            rows,
            vec![("main".into(), "b".into()), ("other".into(), "a".into())]
        );
        conn.execute_batch("INSERT INTO engine_search_files_fts(engine_search_files_fts) VALUES('integrity-check');").unwrap();
    }

    #[test]
    fn agent_run_failure_handled_upgrade_preserves_values() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-agent-run-failure-handled");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 59);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 60);
        {
            let mut conn = open_bare(&path);
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults)
                .expect("previous store version");
            conn.execute_batch(
                "INSERT INTO agent_run_records
                 (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms,failure_note_posted)
                 VALUES ('ws','unhandled','thread','trigger-1','agent',10,0),
                        ('ws','handled','thread','trigger-2','agent',20,1);",
            )
            .expect("previous run values");
        }

        let mut conn = open_bare(&path);
        let through = &BASELINE_MIGRATIONS[..=before];
        assert_eq!(
            run_migrations(&mut conn, through, &ctx, &NoFaults).expect("upgrade"),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let runs = conn
            .prepare("SELECT run_id, failure_handled FROM agent_run_records ORDER BY started_at_ms")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            runs,
            vec![
                ("unhandled".to_owned(), false),
                ("handled".to_owned(), true)
            ]
        );
        let old_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('agent_run_records') WHERE name='failure_note_posted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_columns, 0);
        conn.execute_batch(
            "INSERT INTO agent_run_records
             (workspace_id,run_id,thread_id,trigger_message_id,command,started_at_ms)
             VALUES ('ws','new','thread','trigger-3','agent',30);",
        )
        .expect("default remains available");
        assert!(
            !conn
                .query_row(
                    "SELECT failure_handled FROM agent_run_records WHERE run_id='new'",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap()
        );
        assert_eq!(
            run_migrations(&mut conn, through, &ctx, &NoFaults).expect("reopen"),
            MigrationOutcome::Applied { newly_applied: 0 }
        );
    }

    const ADOPTION_FACTS: &str = "json_array(binding_json,source_moment_id,source_digest,source_byte_length,\
        baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,\
        coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,\
        max_pending_bytes,max_pending_age_ms)";

    #[test]
    fn live_owner_activations_upgrade_backfills_each_adoption_and_its_binding() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-live-owner-activations");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 67);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 68);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults)
            .expect("previous store version");
        let lineage = crate::blob::put_binary_blob(&conn, b"lineage").unwrap();
        let other = crate::blob::put_binary_blob(&conn, b"other").unwrap();
        let source = crate::blob::hex_sha256(b"");
        conn.execute(
            "INSERT INTO blobs(sha256,text,byte_length) VALUES (?1,'',0)",
            [&source],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main')")
            .unwrap();
        for (adoption, object, receipt) in [
            ("adoption-a", "a", "null"),
            (
                "adoption-b",
                "b",
                r#"{"deliveryId":"d","updateDigest":"u","journalCursor":7,"acceptingHostEpoch":1}"#,
            ),
        ] {
            conn.execute(
                "INSERT INTO live_owner_adoptions VALUES ('relay',?1,'ws','main',?2,?3,?4,'moment',?5,0,3,4,'evidence','coverage',5,6,?6,?7,'{\"hostId\":\"host\"}',1000,2000)",
                rusqlite::params![adoption, object, lineage, format!("{{\"objectId\":\"{object}\"}}"), source,
                    if object == "a" { 0 } else { 7 }, receipt],
            )
            .unwrap();
        }
        for (object, claim) in [("a", &lineage), ("b", &other), ("c", &lineage)] {
            conn.execute(
                "INSERT INTO live_device_application_bindings VALUES ('relay','ws','main',?1,?2,'a.md','[\"a.md\"]',0,'host',1,'instance','connection',1)",
                rusqlite::params![object, claim],
            )
            .unwrap();
        }
        let adoptions = |conn: &Connection| -> Vec<String> {
            conn.prepare(&format!("SELECT json_array(relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id)||{ADOPTION_FACTS} FROM live_owner_adoptions ORDER BY adoption_id"))
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let roots = adoptions(&conn);

        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults)
                .expect("upgrade"),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        assert_eq!(
            adoptions(&conn),
            roots,
            "the lineage origin stays as it was"
        );
        let backfilled: Vec<(String, String, Option<String>, bool)> = conn
            .prepare(&format!(
                "SELECT v.activation_id,v.origin_adoption_id,v.predecessor_activation_id,
                    {ADOPTION_FACTS}=(SELECT {ADOPTION_FACTS} FROM live_owner_adoptions a WHERE a.adoption_id=v.activation_id)
                    AND v.boundary_json IS NULL AND v.released_at_ms IS NULL
                 FROM live_owner_activations v ORDER BY v.activation_id"
            ))
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            backfilled,
            vec![
                ("adoption-a".into(), "adoption-a".into(), None, true),
                ("adoption-b".into(), "adoption-b".into(), None, true),
            ]
        );
        let bindings: Vec<(String, Option<String>)> = conn
            .prepare("SELECT object_id,activation_id FROM live_device_application_bindings ORDER BY object_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            bindings,
            vec![
                ("a".into(), Some("adoption-a".into())),
                ("b".into(), None),
                ("c".into(), None),
            ],
            "a binding names the adoption of its own lineage only"
        );
        let document: (i64, String) = conn
            .query_row(
                "SELECT l.partial,(SELECT group_concat(name,',') FROM
                    (SELECT name FROM pragma_index_info('live_owner_activations_document') ORDER BY seqno))
                 FROM pragma_index_list('live_owner_activations') l WHERE l.name='live_owner_activations_document'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            document,
            (
                0,
                "workspace_id,main_version_id,object_id,lineage_claim_id,relay_database_namespace"
                    .into()
            ),
            "every activation of a document lineage is found by its document"
        );

        // `baseline` is the relay sequence and registration time, each present or absent.
        let insert_with = |id: &str,
                           predecessor: Option<&str>,
                           object: &str,
                           released: bool,
                           adopted: bool,
                           baseline: (Option<i64>, Option<i64>),
                           origin: Option<&str>| {
            conn.execute(
                "INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,main_version_id,
                    object_id,lineage_claim_id,origin_adoption_id,predecessor_activation_id,binding_json,source_moment_id,
                    source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,
                    host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,
                    terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms,released_at_ms,
                    released_restore_generation,released_accepted_cursor,released_boundary_json,carried_manifest_json)
                 VALUES ('relay',?1,'ws','main',?3,?4,?10,?2,'{}','moment',?5,0,?8,?9,'{}',
                    iif(?7,'e',NULL),iif(?7,'c',NULL),iif(?7,0,NULL),iif(?7,0,NULL),iif(?7,0,NULL),iif(?7,'null',NULL),
                    iif(?7,1,NULL),iif(?7,1,NULL),iif(?6,9,NULL),iif(?6,1,NULL),iif(?6,0,NULL),iif(?6,'[]',NULL),iif(?6,'[]',NULL))",
                rusqlite::params![id, predecessor, object, lineage, source, released, adopted, baseline.0, baseline.1, origin],
            )
        };
        // An adopted row names its lineage's origin; one that never adopted names none.
        let insert = |id: &str,
                      predecessor: Option<&str>,
                      object: &str,
                      released: bool,
                      adopted: bool,
                      baseline: (Option<i64>, Option<i64>)| {
            insert_with(
                id,
                predecessor,
                object,
                released,
                adopted,
                baseline,
                (adopted && object == "a").then_some("adoption-a"),
            )
        };
        let known = (Some(0), Some(0));
        assert!(
            insert("second-current", None, "a", false, true, known).is_err(),
            "one unreleased activation per document lineage"
        );
        assert!(
            insert("never-adopted", None, "a", false, false, known).is_err(),
            "an unreleased activation is adopted"
        );
        insert("released", Some("adoption-a"), "a", true, false, known)
            .expect("a released successor");
        assert!(
            insert("sibling", Some("adoption-a"), "a", true, false, known).is_err(),
            "one successor per activation"
        );
        assert!(
            insert("elsewhere", Some("released"), "b", true, false, known).is_err(),
            "a predecessor stays on its lineage"
        );
        insert(
            "unregistered",
            Some("released"),
            "a",
            true,
            false,
            (None, None),
        )
        .expect("a release that never adopted needs no baseline");
        for (id, baseline) in [("half", (Some(1), None)), ("other-half", (None, Some(1)))] {
            assert!(
                insert(id, None, "c", true, false, baseline).is_err(),
                "a baseline's sequence and time arrive together"
            );
        }
        assert!(
            insert(
                "unanchored",
                Some("unregistered"),
                "a",
                true,
                true,
                (None, None)
            )
            .is_err(),
            "an adoption carries its baseline"
        );
        assert!(
            insert_with(
                "unrooted",
                Some("unregistered"),
                "a",
                true,
                true,
                known,
                None
            )
            .is_err(),
            "an adoption names its lineage's origin"
        );
        assert!(
            insert_with(
                "rooted",
                Some("unregistered"),
                "a",
                true,
                false,
                known,
                Some("adoption-a")
            )
            .is_err(),
            "an activation that never adopted names no origin"
        );
        // Sol's any-namespace ruling: a document lineage has one adopted
        // origin in any namespace, and succession stays in its own.
        let copied = |table: &str, id_column: &str, id: &str, changes: &str| {
            conn.execute_batch(&format!(
                "CREATE TEMP TABLE copied AS SELECT * FROM {table} WHERE {id_column}='{id}';
                 UPDATE copied SET relay_database_namespace='other',{changes};"
            ))
            .unwrap();
            let inserted = conn
                .execute(&format!("INSERT INTO {table} SELECT * FROM copied"), [])
                .map_err(|error| error.to_string());
            conn.execute_batch("DROP TABLE copied").unwrap();
            inserted
        };
        let refused = |inserted: Result<usize, String>, constraint: &str, case: &str| {
            assert!(
                inserted
                    .as_ref()
                    .is_err_and(|error| error.contains(constraint)),
                "{case}: {inserted:?}"
            );
        };
        refused(
            copied(
                "live_owner_adoptions",
                "adoption_id",
                "adoption-a",
                "adoption_id='adoption-other'",
            ),
            "UNIQUE",
            "a second adopted origin in another namespace",
        );
        refused(
            copied(
                "live_owner_activations",
                "activation_id",
                "released",
                "activation_id='across'",
            ),
            "FOREIGN KEY",
            "a successor of an activation in another namespace",
        );
        refused(
            copied(
                "live_owner_activations",
                "activation_id",
                "adoption-a",
                "activation_id='adopted-across',released_at_ms=9,released_restore_generation=1,
                 released_accepted_cursor=0,released_boundary_json='[]',carried_manifest_json='[]'",
            ),
            "FOREIGN KEY",
            "an adoption naming the origin of another namespace",
        );
        let unregistered: (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT baseline_moment_relay_sequence,baseline_registered_at_ms
                 FROM live_owner_activations WHERE activation_id='unregistered'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(unregistered, (None, None), "nothing invents a baseline");
        assert!(
            conn.execute(
                "UPDATE live_owner_activations SET carried_manifest_json=NULL WHERE activation_id='released'",
                []
            )
            .is_err(),
            "release facts arrive together"
        );
        assert!(
            conn.execute(
                "UPDATE live_owner_activations SET terminal_receipt_json=NULL WHERE activation_id='adoption-a'",
                []
            )
            .is_err(),
            "adoption facts arrive together"
        );
        assert_eq!(adoptions(&conn), roots);
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults)
                .expect("reopen"),
            MigrationOutcome::Applied { newly_applied: 0 }
        );
    }

    fn ordinary_pull_token(conn: &Connection) -> Option<String> {
        conn.query_row(
            "SELECT ordinary_pull_token FROM sync_identity WHERE workspace_id='ws'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn ordinary_pull_progress_upgrade_starts_with_no_unfinished_pull() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-ordinary-pull-progress");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 60);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 61);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute(
            "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
             VALUES ('ws','origin','epoch','stream',1)",
            [],
        )
        .unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        assert_eq!(ordinary_pull_token(&conn), None);
        assert!(
            conn.execute(
                "UPDATE sync_identity SET ordinary_pull_token='' WHERE workspace_id='ws'",
                []
            )
            .is_err(),
            "an empty token owns nothing"
        );
    }

    #[test]
    fn each_identity_change_abandons_the_unfinished_ordinary_pull() {
        for column in ["origin_id", "replication_epoch", "stream_identity"] {
            let dir = tempdir();
            let mut conn = open_bare(&dir.join("engine.db"));
            run_migrations(
                &mut conn,
                BASELINE_MIGRATIONS,
                &MigrationContext::current(1),
                &NoFaults,
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms,ordinary_pull_token) \
                 VALUES ('ws','origin','epoch','stream',1,'token')",
                [],
            )
            .unwrap();
            // Other columns, and rewriting a value unchanged, leave the pull.
            conn.execute(
                &format!(
                    "UPDATE sync_identity SET claim_state='pending',{column}={column} WHERE workspace_id='ws'"
                ),
                [],
            )
            .unwrap();
            assert_eq!(ordinary_pull_token(&conn).as_deref(), Some("token"));
            // A rolled-back change keeps the identity and its pull together.
            conn.execute_batch(&format!(
                "BEGIN; UPDATE sync_identity SET {column}='changed' WHERE workspace_id='ws'; ROLLBACK;"
            ))
            .unwrap();
            assert_eq!(ordinary_pull_token(&conn).as_deref(), Some("token"));
            conn.execute(
                &format!("UPDATE sync_identity SET {column}='changed' WHERE workspace_id='ws'"),
                [],
            )
            .unwrap();
            assert_eq!(ordinary_pull_token(&conn), None, "{column} changed");
        }
    }

    #[test]
    fn owner_stop_upgrade_counts_pending_entries_and_tracks_terminal_changes() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-owner-live-stops");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        let digest = crate::blob::put_binary_blob(&conn, b"x").unwrap();
        conn.execute("INSERT INTO owner_ydoc_outboxes(outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,created_at_ms) VALUES('outbox','ws','main','object','lineage','owner.md','[]',0,?1,?1,1,'active',2,1,4,1)",[&digest]).unwrap();
        for sequence in 1..=3 {
            conn.execute("INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state) VALUES('outbox',?1,?2,?2,?3,?4,1,1,?5,2,1,'active')",rusqlite::params![sequence,format!("key-{sequence}"),digest,(sequence<=2).then_some(&digest),i64::from(sequence<=2)]).unwrap();
        }
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let count = |conn: &Connection| {
            conn.query_row(
                "SELECT pending_entry_count FROM owner_ydoc_outboxes WHERE outbox_id='outbox'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(count(&conn), 2);
        conn.execute("INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state) VALUES('outbox',4,'key-4','key-4',?1,?1,1,1,1,3,1,'active')",[&digest]).unwrap();
        assert_eq!(count(&conn), 3);
        conn.execute("UPDATE owner_ydoc_outbox_entries SET pending=0,update_blob_digest=NULL WHERE sequence=4",[]).unwrap();
        assert_eq!(count(&conn), 2);
        conn.execute("DELETE FROM owner_ydoc_outbox_entries WHERE pending=0", [])
            .unwrap();
        assert_eq!(count(&conn), 2);
        conn.execute("DELETE FROM owner_ydoc_outbox_entries", [])
            .unwrap();
        assert_eq!(count(&conn), 0);
    }

    #[test]
    fn local_dispatch_discovery_upgrade_preserves_the_cursor_without_backfilling_messages() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-chat-local-dispatch-discovery");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO chat_channels (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) VALUES ('ws','channel','Channel','channel','channel',1,1); INSERT INTO chat_threads (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) VALUES ('ws','thread','Thread',20,20,'channel'); INSERT INTO chat_messages (workspace_id,thread_id,message_order,message_id,author_kind,author_display_name,body,created_at_ms) VALUES ('ws','thread',0,'old','human','Ada','@agent',20); INSERT INTO chat_dispatch_scan_cursor (workspace_id,max_created_at_ms,updated_at_ms) VALUES ('ws',100,101);").unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let state: (i64, i64, i64) = conn.query_row(
            "SELECT (SELECT COUNT(*) FROM chat_messages), (SELECT COUNT(*) FROM chat_dispatch_local_discovery), (SELECT max_created_at_ms FROM chat_dispatch_scan_cursor WHERE workspace_id='ws')",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(state, (1, 0, 100));
    }

    #[test]
    fn hosted_replica_applies_fresh_and_upgrades_a_store_at_its_predecessor() {
        let hosted = |conn: &Connection| {
            conn.execute_batch(
                "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                 VALUES ('hosted','service-host:a','epoch','stream',1); \
                 INSERT INTO hosted_replicas (workspace_id,created_at_ms) VALUES ('hosted',1); \
                 INSERT INTO hosted_documents (workspace_id,object_id,path,state,scope_generation) \
                 VALUES ('hosted','doc','doc.md','backfilling',0); \
                 INSERT INTO hosted_retired_files (workspace_id,path,sha256) \
                 VALUES ('hosted','gone.md',printf('%064d',0));",
            )
            .unwrap();
            let state: (Option<String>, i64, i64, i64, i64, i64) = conn
                .query_row(
                    "SELECT scope_token,scope_generation,main_cursor,cursor_commits, \
                     last_outbound_seq,(SELECT backfill_cursor FROM hosted_documents) \
                     FROM hosted_replicas",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .unwrap();
            assert_eq!(state, (None, 0, 0, 0, -1, 0));
            for invalid in [
                "INSERT INTO hosted_replicas (workspace_id,created_at_ms) VALUES ('no-identity',1)",
                "UPDATE hosted_documents SET state='retired'",
                "UPDATE hosted_documents SET state='held'",
                "UPDATE hosted_documents SET held_reason='hosted-backfill-work-waiting'",
                "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-path-held',\
                 held_path='a.md'",
                "UPDATE hosted_documents SET state='held',held_reason='hosted-conflict-parent-withheld'",
                "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting',\
                 held_conflict_id='conflict'",
                "UPDATE hosted_documents SET path=''",
                "INSERT INTO hosted_deferred_ops (workspace_id,origin_id,origin_seq,object_id,relay_seq) \
                 VALUES ('hosted','origin:a',0,'doc',1)",
                "UPDATE hosted_replicas SET scope_token=''",
                "UPDATE hosted_replicas SET cursor_commits=-1",
                "UPDATE hosted_replicas SET last_outbound_seq=-2",
                "INSERT INTO hosted_withheld_befores (workspace_id,moment_id,before_object_id,\
                 before_path,before_sha256,before_content_kind) \
                 VALUES ('hosted','no-moment','private','a.md','sha','text')",
                "INSERT INTO hosted_retired_files (workspace_id,path,sha256) VALUES ('hosted','a.md','sha')",
                "INSERT INTO hosted_retired_files (workspace_id,path,sha256) \
                 VALUES ('ordinary','a.md',printf('%064d',0))",
            ] {
                assert!(conn.execute(invalid, []).is_err(), "{invalid}");
            }
            conn.execute("DELETE FROM hosted_replicas", []).unwrap();
            let documents: i64 = conn
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM hosted_documents) \
                     + (SELECT COUNT(*) FROM hosted_retired_files)",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                documents, 0,
                "documents and their files leave with their replica"
            );
        };
        let ctx = MigrationContext::current(1);
        let dir = tempdir();
        let mut fresh = open_bare(&dir.join("fresh.db"));
        fresh.pragma_update(None, "foreign_keys", true).unwrap();
        run_migrations(&mut fresh, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        hosted(&fresh);

        let mut upgraded = open_bare(&dir.join("upgraded.db"));
        upgraded.pragma_update(None, "foreign_keys", true).unwrap();
        let before = migration_index("v2-hosted-replica");
        run_migrations(
            &mut upgraded,
            &BASELINE_MIGRATIONS[..before],
            &ctx,
            &NoFaults,
        )
        .unwrap();
        upgraded
            .execute_batch(
                "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                 VALUES ('ordinary','origin:a','epoch','stream',1);",
            )
            .unwrap();
        assert_eq!(
            run_migrations(
                &mut upgraded,
                &BASELINE_MIGRATIONS[..=before],
                &ctx,
                &NoFaults
            )
            .unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let replicas: i64 = upgraded
            .query_row("SELECT COUNT(*) FROM hosted_replicas", [], |row| row.get(0))
            .unwrap();
        assert_eq!(replicas, 0, "an existing replica stays ordinary");
        hosted(&upgraded);
    }

    /// A file retired before files named their document keeps its row, so
    /// its path stays held until the file goes.
    #[test]
    fn hosted_retired_file_object_upgrade_keeps_files_retired_before_it() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-hosted-retired-file-object");
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 57);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch(
            "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
             VALUES ('hosted','service-host:a','epoch','stream',1); \
             INSERT INTO hosted_replicas (workspace_id,created_at_ms) VALUES ('hosted',1); \
             INSERT INTO hosted_retired_files (workspace_id,path,sha256) \
             VALUES ('hosted','locked.md',printf('%064d',0));",
        )
        .unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        conn.execute(
            "INSERT INTO hosted_retired_files (workspace_id,path,object_id,sha256) \
             VALUES ('hosted','gone.md','gone',printf('%064d',1))",
            [],
        )
        .unwrap();
        let files: Vec<(String, Option<String>)> = conn
            .prepare("SELECT path,object_id FROM hosted_retired_files ORDER BY path")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            files,
            [
                ("gone.md".to_owned(), Some("gone".to_owned())),
                ("locked.md".to_owned(), None),
            ]
        );
        assert!(
            conn.execute(
                "INSERT INTO hosted_retired_files (workspace_id,path,object_id,sha256) \
                 VALUES ('hosted','empty.md','',printf('%064d',2))",
                [],
            )
            .is_err()
        );
    }

    /// Every hosted document keeps its state across the upgrade. After it, a
    /// document can park, and one can be held for a live edit the host never
    /// admitted, which names no path.
    #[test]
    fn hosted_parked_documents_upgrade_keeps_every_document() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-hosted-parked-documents");
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 58);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch(
            "INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
             VALUES ('hosted','service-host:a','epoch','stream',1); \
             INSERT INTO hosted_replicas (workspace_id,scope_generation,created_at_ms) VALUES ('hosted',2,1); \
             INSERT INTO hosted_documents (workspace_id,object_id,path,state,held_reason,held_path, \
               held_by,backfill_cursor,scope_generation) \
             VALUES ('hosted','held','a.md','held','hosted-backfill-path-held','a.md','ready',4,2), \
                    ('hosted','ready','b.md','ready',NULL,NULL,NULL,7,1);",
        )
        .unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        type Row = (String, String, Option<String>, Option<String>, i64, i64);
        let rows: Vec<Row> = conn
            .prepare(
                "SELECT object_id,state,held_reason,held_by,backfill_cursor,scope_generation \
                 FROM hosted_documents ORDER BY object_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                (
                    "held".to_owned(),
                    "held".to_owned(),
                    Some("hosted-backfill-path-held".to_owned()),
                    Some("ready".to_owned()),
                    4,
                    2
                ),
                ("ready".to_owned(), "ready".to_owned(), None, None, 7, 1),
            ]
        );
        // A document's parked rows are found without scanning every parked row.
        for (table, index) in [
            (
                "hosted_parked_snapshots",
                "hosted_parked_snapshots_by_document",
            ),
            (
                "hosted_parked_path_aliases",
                "hosted_parked_path_aliases_by_document",
            ),
        ] {
            let plan: String = conn
                .query_row(
                    &format!(
                        "EXPLAIN QUERY PLAN SELECT version_id,path FROM {table} \
                         WHERE workspace_id='hosted' AND object_id='held'"
                    ),
                    [],
                    |row| row.get(3),
                )
                .unwrap();
            assert!(plan.contains(index), "{table}: {plan}");
        }
        for valid in [
            "UPDATE hosted_documents SET state='parked',held_reason=NULL,held_path=NULL,held_by=NULL \
             WHERE object_id='held'",
            "UPDATE hosted_documents SET state='held',held_reason='hosted-live-edit-unadmitted' \
             WHERE object_id='ready'",
            "UPDATE hosted_documents SET unmaterialized_seq=9 WHERE object_id='ready'",
        ] {
            conn.execute(valid, []).unwrap();
        }
        for invalid in [
            "UPDATE hosted_documents SET held_path='b.md' WHERE object_id='ready'",
            "UPDATE hosted_documents SET state='parked' WHERE object_id='ready'",
            "UPDATE hosted_documents SET state='retired' WHERE object_id='held'",
            "UPDATE hosted_documents SET unmaterialized_seq=0 WHERE object_id='ready'",
            "UPDATE hosted_documents SET unmaterialized_seq=9 WHERE object_id='held'",
        ] {
            assert!(conn.execute(invalid, []).is_err(), "{invalid}");
        }
        conn.execute("DELETE FROM hosted_replicas", []).unwrap();
        let documents: i64 = conn
            .query_row("SELECT COUNT(*) FROM hosted_documents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(documents, 0, "documents leave with their replica");
    }

    /// Hosted documents, held and parked ones among them, with their parked
    /// heads and aliases, and deferred Y.Doc updates of a hosted and an
    /// ordinary workspace.
    const HOSTED_AND_DEFERRED_ROWS: &str = "\
        INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
          VALUES ('hosted','service-host:a','epoch','stream',1),('ordinary','origin:a','epoch','stream',1); \
        INSERT INTO hosted_replicas (workspace_id,scope_generation,cursor_commits,created_at_ms) \
          VALUES ('hosted',2,5,1); \
        INSERT INTO versioned_workspaces VALUES ('hosted','main'),('ordinary','main'); \
        INSERT INTO versions (workspace_id,version_id,kind,name,created_at_ms) \
          VALUES ('hosted','main','main','main',0),('ordinary','main','main','main',0); \
        INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
          VALUES ('hosted','held',0),('ordinary','doc',0); \
        INSERT INTO blobs (sha256,byte_length,text) VALUES (printf('%064d',0),1,'x'); \
        INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES (printf('%064d',1),1,x'01'); \
        INSERT INTO hosted_documents (workspace_id,object_id,path,state,held_reason,held_path, \
          held_by,backfill_cursor,scope_generation,unmaterialized_seq) \
          VALUES ('hosted','held','a.md','held','hosted-backfill-path-held','a.md','ready',4,2,NULL), \
                 ('hosted','ready','b.md','ready',NULL,NULL,NULL,7,2,9), \
                 ('hosted','parked','c.md','parked',NULL,NULL,NULL,3,1,NULL), \
                 ('hosted','image','d.png','parked',NULL,NULL,NULL,2,1,NULL); \
        INSERT INTO hosted_parked_snapshots (workspace_id,version_id,object_id,path,blob_sha256, \
          updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256,metadata_summary, \
          metadata_correlation_id) \
          VALUES ('hosted','main','parked','c.md',printf('%064d',0),5,'moment','sync','text',NULL,NULL,NULL), \
                 ('hosted','main','image','d.png',NULL,6,'binary-moment','sync','binary', \
                   printf('%064d',1),'a summary','a correlation'); \
        INSERT INTO hosted_parked_path_aliases (workspace_id,version_id,path,object_id) \
          VALUES ('hosted','main','old/c.md','parked'); \
        INSERT INTO ydoc_deferred_updates (workspace_id,version_id,object_id,origin_id,origin_seq, \
          recorded_at_ms,relay_seq) \
          VALUES ('hosted','main','held','peer',1,5,3),('ordinary','main','doc','peer',1,5,NULL); \
        INSERT INTO relay_deferred_ops (workspace_id,origin_id,origin_seq,replication_epoch, \
          stream_identity,envelope_json,retained_bytes) \
          VALUES ('hosted','peer',1,'epoch','stream','{\"relaySeq\":3}',1), \
                 ('ordinary','peer',1,'epoch','stream','{}',1);";

    /// Every row the hosted tables and deferred Y.Doc updates hold, by the
    /// columns both schemas share.
    fn hosted_and_deferred_rows(conn: &Connection) -> String {
        conn.query_row(
            "SELECT json_array( \
               (SELECT json_group_array(json_array(workspace_id,object_id,path,state,held_reason,held_path, \
                  held_by,held_conflict_id,backfill_cursor,scope_generation,unmaterialized_seq)) \
                FROM (SELECT * FROM hosted_documents ORDER BY object_id)), \
               (SELECT json_group_array(json_array(workspace_id,version_id,object_id,path,blob_sha256, \
                  updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256, \
                  metadata_summary,metadata_correlation_id)) \
                FROM (SELECT * FROM hosted_parked_snapshots ORDER BY object_id)), \
               (SELECT json_group_array(json_array(workspace_id,version_id,path,object_id)) \
                FROM hosted_parked_path_aliases), \
               (SELECT json_group_array(json_array(workspace_id,version_id,object_id,origin_id,origin_seq, \
                  recorded_at_ms,lineage_claim_id,relay_seq)) \
                FROM (SELECT * FROM ydoc_deferred_updates ORDER BY workspace_id)), \
               (SELECT json_group_array(json_array(workspace_id,origin_id,origin_seq,replication_epoch, \
                  stream_identity,envelope_json,retained_bytes,checked_sequence,report_id)) \
                FROM (SELECT * FROM relay_deferred_ops ORDER BY workspace_id)))",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Plan r3's local decision table: one row per binding and attempt, with
    /// unique copy identities in a workspace, every digest, length, integer
    /// and JSON value checked, accepted coordinates and terminal outcomes
    /// whole or absent, the copy's text pinned while a decision names it, and
    /// the rows gone with their workspace.
    #[test]
    fn released_hold_copy_decisions_check_every_column() {
        let ctx = MigrationContext::current(1);
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("decisions.db"));
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let text = "c".repeat(64);
        conn.execute_batch(&format!(
            "INSERT INTO versioned_workspaces VALUES ('ws','main'),('other','main');
             INSERT INTO blobs VALUES ('{text}',4,'copy');"
        ))
        .unwrap();
        let digest = "a".repeat(64);
        // A decision of `attempt` naming `copy` and `moment`, its binding in
        // `bound`'s workspace and its text at `projection`.
        let insert = |attempt: i64, copy: &str, moment: &str, bound: &str, projection: &str| {
            format!(
                "INSERT INTO released_hold_copy_decisions (workspace_id,binding_digest,attempt,binding_json,
                   projection_sha256,projection_byte_length,merged_contribution_ids_json,recovery_object_id,
                   recovery_moment_id,recovered_path,collision_ordinal,recovery_author_json,created_at_ms)
                 VALUES ('ws','{digest}',{attempt},'{{\"workspaceId\":\"{bound}\"}}','{projection}',4,'[]',
                   '{copy}','{moment}','notes/plan (retained).md','0','{{}}',1)"
            )
        };
        conn.execute(&insert(0, "copy", "moment", "ws", &text), [])
            .unwrap();
        for valid in [
            "UPDATE released_hold_copy_decisions SET accepted_recovery_origin_id='owner', \
             accepted_recovery_origin_seq=0,accepted_recovery_relay_seq=7",
            "UPDATE released_hold_copy_decisions SET resolution_outcome='resolved',resolution_outcome_at_ms=2",
            "UPDATE released_hold_copy_decisions SET resolution_outcome='stale'",
            "UPDATE released_hold_copy_decisions SET collision_ordinal='12', \
             merged_contribution_ids_json='[{\"kind\":\"carried\"}]'",
        ] {
            conn.execute(valid, []).unwrap();
        }
        // Another attempt at the same binding names other copy identities.
        conn.execute(&insert(1, "copy-1", "moment-1", "ws", &text), [])
            .unwrap();
        let unstored = "d".repeat(64);
        for invalid in [
            // The same attempt, or another attempt reusing a copy identity.
            insert(0, "copy-2", "moment-2", "ws", &text),
            insert(2, "copy", "moment-2", "ws", &text),
            insert(2, "copy-2", "moment", "ws", &text),
            // A binding of another workspace, a projection never stored.
            insert(3, "copy-3", "moment-3", "other", &text),
            insert(3, "copy-3", "moment-3", "ws", &unstored),
        ] {
            assert!(conn.execute(&invalid, []).is_err(), "{invalid}");
        }
        for invalid in [
            "UPDATE released_hold_copy_decisions SET binding_digest='ABC' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET attempt=-1 WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET attempt=9007199254740992 WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET binding_json='not json' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET binding_json='[]' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET projection_byte_length=-1 WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET merged_contribution_ids_json='{}' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET recovered_path='' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET collision_ordinal='' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET collision_ordinal='-1' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET recovery_author_json='not json' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET created_at_ms=-1 WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET accepted_recovery_relay_seq=NULL WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET accepted_recovery_relay_seq=0 WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET accepted_recovery_origin_id='' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET resolution_outcome=NULL WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET resolution_outcome_at_ms=NULL WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET resolution_outcome='refused' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET recovery_object_id='copy-1' WHERE attempt=0",
            "UPDATE released_hold_copy_decisions SET recovery_moment_id='moment-1' WHERE attempt=0",
        ] {
            assert!(conn.execute(invalid, []).is_err(), "{invalid}");
        }
        assert!(
            conn.execute(&format!("DELETE FROM blobs WHERE sha256='{text}'"), [])
                .is_err(),
            "a decision pins its copy's text"
        );
        conn.execute(
            "DELETE FROM versioned_workspaces WHERE workspace_id='ws'",
            [],
        )
        .unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM released_hold_copy_decisions",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "decisions leave with their workspace");
        conn.execute(&format!("DELETE FROM blobs WHERE sha256='{text}'"), [])
            .unwrap();
    }

    /// A released-lineage hold carries its binding with its digest, and its
    /// continuation, and no other hold does; the binding is the row's last
    /// column. A hosted deferral names its whole feed, and a local one needs
    /// none.
    fn released_hold_and_deferred_feed_constraints_hold(conn: &Connection) {
        let new_columns: (Option<String>, Option<String>, Option<String>, i64) = conn
            .query_row(
                "SELECT released_hold_binding_json,released_hold_binding_digest, \
                 released_hold_continuation,released_hold_binding_stale \
                 FROM hosted_documents WHERE object_id='held'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(new_columns, (None, None, None, 0));
        let last: String = conn
            .query_row(
                "SELECT name FROM pragma_table_info('hosted_documents') ORDER BY cid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last, "released_hold_binding_json");
        let digest = "a".repeat(64);
        let hold = format!(
            "UPDATE hosted_documents SET held_reason='released-lineage-unsettled',held_path=NULL, \
             held_by=NULL,released_hold_binding_json='{{}}',released_hold_binding_digest='{digest}', \
             released_hold_continuation='frozen' WHERE object_id='held'"
        );
        let rebound = format!(
            "UPDATE hosted_documents SET released_hold_binding_json='{{\"rebound\":1}}', \
             released_hold_binding_digest='{}' WHERE object_id='held'",
            "b".repeat(64)
        );
        for valid in [
            hold.as_str(),
            rebound.as_str(),
            "UPDATE hosted_documents SET released_hold_binding_json=released_hold_binding_json \
             WHERE object_id='held'",
            "UPDATE hosted_documents SET released_hold_continuation='dependency-drain', \
             released_hold_binding_stale=1 WHERE object_id='held'",
            "INSERT INTO ydoc_deferred_updates (workspace_id,version_id,object_id,origin_id,origin_seq, \
             recorded_at_ms,relay_seq,ingress_kind,relay_namespace,replication_epoch,stream_identity) \
             VALUES ('hosted','main','held','peer',2,6,4,'hosted','relay','epoch','stream')",
            "INSERT INTO ydoc_deferred_updates (workspace_id,version_id,object_id,origin_id,origin_seq, \
             recorded_at_ms,ingress_kind) VALUES ('ordinary','main','doc','peer',2,6,'local')",
            "UPDATE ydoc_deferred_updates SET lineage_replacement_json='{}' WHERE origin_seq=2",
            "INSERT INTO relay_deferred_ops (workspace_id,origin_id,origin_seq,replication_epoch, \
             stream_identity,envelope_json,retained_bytes,ingress_kind,relay_namespace) \
             VALUES ('hosted','peer',2,'epoch','stream','{\"relaySeq\":4}',1,'hosted','relay')",
            "INSERT INTO relay_deferred_ops (workspace_id,origin_id,origin_seq,replication_epoch, \
             stream_identity,envelope_json,retained_bytes,ingress_kind) \
             VALUES ('ordinary','peer',2,'epoch','stream','{}',1,'local')",
        ] {
            conn.execute(valid, []).unwrap();
        }
        for invalid in [
            "UPDATE hosted_documents SET state='held',held_reason='released-lineage-unsettled' \
             WHERE object_id='ready'",
            "UPDATE hosted_documents SET state='held',held_reason='released-lineage-unsettled', \
             released_hold_binding_json='{}' WHERE object_id='ready'",
            "UPDATE hosted_documents SET state='held',held_reason='released-lineage-unsettled', \
             released_hold_continuation='frozen' WHERE object_id='ready'",
            "UPDATE hosted_documents SET released_hold_binding_json='{}', \
             released_hold_continuation='frozen' WHERE object_id='ready'",
            "UPDATE hosted_documents SET released_hold_binding_stale=1 WHERE object_id='ready'",
            "UPDATE hosted_documents SET released_hold_binding_digest=NULL WHERE object_id='held'",
            "UPDATE hosted_documents SET released_hold_binding_digest='abc' WHERE object_id='held'",
            "UPDATE hosted_documents SET released_hold_binding_digest=upper(released_hold_binding_digest) \
             WHERE object_id='held'",
            "UPDATE hosted_documents SET released_hold_binding_json='not json' WHERE object_id='held'",
            "UPDATE hosted_documents SET released_hold_binding_json='{}' WHERE object_id='held'",
            "UPDATE hosted_documents SET released_hold_continuation='thawed' WHERE object_id='held'",
            "UPDATE hosted_documents SET released_hold_binding_stale=2 WHERE object_id='held'",
            "UPDATE hosted_documents SET held_path='a.md' WHERE object_id='held'",
            "UPDATE hosted_documents SET held_reason='hosted-backfill-work-waiting' WHERE object_id='held'",
            "UPDATE ydoc_deferred_updates SET ingress_kind='hosted' WHERE origin_seq=1",
            "UPDATE ydoc_deferred_updates SET ingress_kind='remote' WHERE origin_seq=1",
            "UPDATE ydoc_deferred_updates SET relay_namespace=NULL WHERE ingress_kind='hosted'",
            "UPDATE ydoc_deferred_updates SET relay_namespace='' WHERE ingress_kind='hosted'",
            "UPDATE ydoc_deferred_updates SET replication_epoch=NULL WHERE ingress_kind='hosted'",
            "UPDATE ydoc_deferred_updates SET stream_identity=NULL WHERE ingress_kind='hosted'",
            "UPDATE ydoc_deferred_updates SET relay_seq=NULL WHERE ingress_kind='hosted'",
            "UPDATE ydoc_deferred_updates SET relay_seq=0 WHERE ingress_kind='hosted'",
            "UPDATE ydoc_deferred_updates SET lineage_replacement_json='not json' WHERE origin_seq=1",
            "UPDATE relay_deferred_ops SET ingress_kind='hosted' WHERE origin_seq=1",
            "UPDATE relay_deferred_ops SET ingress_kind='remote' WHERE origin_seq=1",
            "UPDATE relay_deferred_ops SET relay_namespace=NULL WHERE ingress_kind='hosted'",
            "UPDATE relay_deferred_ops SET relay_namespace='' WHERE ingress_kind='hosted'",
            "UPDATE relay_deferred_ops SET replication_epoch='' WHERE ingress_kind='hosted'",
            "UPDATE relay_deferred_ops SET stream_identity='' WHERE ingress_kind='hosted'",
            "UPDATE relay_deferred_ops SET envelope_json='{}' WHERE ingress_kind='hosted'",
            "UPDATE relay_deferred_ops SET envelope_json='{\"relaySeq\":0}' WHERE ingress_kind='hosted'",
            "UPDATE relay_deferred_ops SET envelope_json='{\"relaySeq\":\"4\"}' WHERE ingress_kind='hosted'",
        ] {
            assert!(conn.execute(invalid, []).is_err(), "{invalid}");
        }
        for invalid in [
            format!("UPDATE hosted_documents SET released_hold_binding_digest='{digest}' WHERE object_id='ready'"),
            format!(
                "UPDATE hosted_documents SET state='held',held_reason='released-lineage-unsettled', \
                 released_hold_binding_digest='{digest}',released_hold_continuation='frozen' \
                 WHERE object_id='ready'"
            ),
            "UPDATE hosted_documents SET state='held',held_reason='released-lineage-unsettled', \
             released_hold_binding_json='{}',released_hold_continuation='frozen' WHERE object_id='ready'"
                .to_owned(),
        ] {
            assert!(conn.execute(&invalid, []).is_err(), "{invalid}");
        }
        conn.execute("DELETE FROM hosted_replicas", []).unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM hosted_documents) \
                 + (SELECT COUNT(*) FROM hosted_parked_snapshots) \
                 + (SELECT COUNT(*) FROM hosted_parked_path_aliases)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            left, 0,
            "documents and their parked heads leave with their replica"
        );
    }

    /// The activations migration rebuilds the hosted documents table for the
    /// released-lineage hold and gives deferred Y.Doc updates and retained
    /// relay work their feed. An upgrade keeps every hosted document, hold,
    /// parked head and alias, and deferred row; a deferred row of a
    /// workspace that is no hosted replica
    /// is local, and one of a hosted replica keeps an unknown feed. A fresh
    /// store enforces the same rules.
    #[test]
    fn live_owner_activations_upgrade_keeps_hosted_documents_and_classifies_deferred_rows() {
        let ctx = MigrationContext::current(1);
        let dir = tempdir();
        let mut fresh = open_bare(&dir.join("fresh.db"));
        fresh.pragma_update(None, "foreign_keys", true).unwrap();
        run_migrations(&mut fresh, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        fresh.execute_batch(HOSTED_AND_DEFERRED_ROWS).unwrap();
        released_hold_and_deferred_feed_constraints_hold(&fresh);

        let mut conn = open_bare(&dir.join("upgraded.db"));
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        let before = migration_index("v2-live-owner-activations");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch(HOSTED_AND_DEFERRED_ROWS).unwrap();
        let kept = hosted_and_deferred_rows(&conn);
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        assert_eq!(hosted_and_deferred_rows(&conn), kept);
        let foreign: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(foreign, 0);
        let feeds: String = conn
            .query_row(
                "SELECT json_group_array(json_array(workspace_id,ingress_kind,relay_namespace, \
                   replication_epoch,stream_identity)) \
                 FROM (SELECT * FROM ydoc_deferred_updates ORDER BY workspace_id)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            feeds,
            r#"[["hosted","legacy-unknown",null,null,null],["ordinary","local",null,null,null]]"#
        );
        let relay_feeds: String = conn
            .query_row(
                "SELECT json_group_array(json_array(workspace_id,ingress_kind,relay_namespace)) \
                 FROM (SELECT * FROM relay_deferred_ops ORDER BY workspace_id)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            relay_feeds,
            r#"[["hosted","legacy-unknown",null],["ordinary","local",null]]"#
        );
        released_hold_and_deferred_feed_constraints_hold(&conn);
    }

    #[test]
    fn restore_resumed_lookup_upgrade_indexes_existing_fences() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-live-restore-resumed-lookup");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','doc','relay','restore','{\"newFence\":1}','{}');").unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let indexes: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_list('live_restore_fences')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(indexes.iter().any(|name| name == "live_restore_resumed"));
        assert!(
            !indexes
                .iter()
                .any(|name| name == "live_restore_document_generation")
        );
        let found: (i64, String) = conn
            .query_row(
                "SELECT new_generation,relay_database_namespace FROM live_restore_fences INDEXED BY live_restore_resumed WHERE workspace_id='ws' AND main_version_id='main' AND object_id='doc'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(found, (1, "relay".to_owned()));
    }

    #[test]
    fn materialization_text_blobs_upgrade_preserves_jobs_and_content_references() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-materialization-text-blobs");
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 24);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute("INSERT INTO engine_requests (request_id, payload_hash, result_seq, committed_at, kind) VALUES ('before-upgrade', 'fingerprint', 7, 3, 'versioned')", []).unwrap();
        let binary = crate::blob::put_binary_blob(&conn, b"binary").unwrap();
        conn.execute("INSERT INTO materialization_jobs (job_id, target_path, content_sha256, preimage_present, target_generation, created_at_ms) VALUES ('pending', 'asset.bin', ?1, 0, 1, 1), ('complete', 'other.bin', ?1, 0, 2, 2)", [&binary]).unwrap();
        conn.execute("UPDATE materialization_jobs SET status='complete', completed_at_ms=3 WHERE job_id='complete'", []).unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let request: (String, i64, Option<String>) = conn.query_row(
            "SELECT payload_hash, result_seq, publication_outcome FROM engine_requests WHERE request_id='before-upgrade'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(request, ("fingerprint".into(), 7, None));
        let jobs: i64 = conn.query_row("SELECT count(*) FROM materialization_jobs WHERE (job_id='pending' AND status='pending') OR (job_id='complete' AND status='complete' AND completed_at_ms=3)", [], |row| row.get(0)).unwrap();
        assert_eq!(jobs, 2);
        assert!(
            conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [&binary])
                .is_err()
        );
        conn.execute("INSERT INTO blobs VALUES ('text-sha', 4, 'text')", [])
            .unwrap();
        conn.execute("INSERT INTO materialization_jobs (job_id, target_path, content_sha256, preimage_present, target_generation, created_at_ms) VALUES ('text', 'note.txt', 'text-sha', 0, 3, 3)", []).unwrap();
        assert!(
            conn.execute("DELETE FROM blobs WHERE sha256='text-sha'", [])
                .is_err()
        );
        assert!(
            conn.execute(
                "UPDATE blobs SET sha256='changed' WHERE sha256='text-sha'",
                []
            )
            .is_err()
        );
        assert!(
            conn.execute(
                "UPDATE binary_blobs SET sha256='changed' WHERE sha256=?1",
                [&binary]
            )
            .is_err()
        );
        assert!(
            conn.execute(
                "UPDATE materialization_jobs SET content_sha256='missing' WHERE job_id='text'",
                []
            )
            .is_err()
        );
        assert!(conn.execute("INSERT INTO materialization_jobs (job_id, target_path, content_sha256, preimage_present, target_generation, created_at_ms) VALUES ('missing', 'missing.txt', 'missing', 0, 4, 4)", []).is_err());
        conn.execute("DELETE FROM materialization_jobs WHERE job_id='text'", [])
            .unwrap();
        conn.execute("DELETE FROM blobs WHERE sha256='text-sha'", [])
            .unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
    }

    /// The ledger is raw TEXT. A tampered checksum that is not ASCII must
    /// refuse like any other mismatch, not panic on a byte boundary.
    #[test]
    fn a_non_ascii_ledger_checksum_is_refused_not_a_panic() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("baseline");
        conn.execute(
            "UPDATE engine_migrations SET checksum = ?1 WHERE ordinal = 0",
            ["aaaaaaaaaaaé"],
        )
        .expect("tamper");
        let refused = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults)
            .expect_err("a mismatched ledger refuses");
        assert!(matches!(refused, StorageError::MigrationFailed { .. }));
        assert!(
            std::error::Error::source(&refused).is_some(),
            "the cause names the migration"
        );
    }

    /// Where a migration sits in the shipped list, so an upgrade test runs
    /// everything before it however many migrations come after.
    fn migration_index(id: &str) -> usize {
        BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == id)
            .expect("a shipped migration")
    }

    #[test]
    fn capture_file_hold_migration_upgrades_a_populated_store() {
        let scratch = tempdir();
        let mut conn = open_bare(&scratch.join("holds.db"));
        let ctx = MigrationContext::current(10);
        let before = migration_index("v2-capture-file-holds");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute("INSERT INTO versioned_workspaces VALUES ('ws','main')", [])
            .unwrap();
        conn.execute("INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','Main',1)", []).unwrap();
        conn.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO file_objects SELECT 'ws','object-'||x,1 FROM n", []).unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let objects: i64 = conn
            .query_row("SELECT COUNT(*) FROM file_objects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(objects, 100);
        let holds: i64 = conn
            .query_row("SELECT COUNT(*) FROM capture_file_holds", [], |r| r.get(0))
            .expect("the upgrade creates the hold ledger");
        assert_eq!(holds, 0);
        conn.execute("INSERT INTO capture_file_holds(workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested) VALUES ('ws','main','object-1','held.md',?1,1,'ydoc-resolution-not-representable',10,1,0)", ["a".repeat(64)]).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
                .optional()
                .unwrap(),
            None
        );
    }

    #[test]
    #[ignore = "manual migration cost measurement"]
    fn capture_file_hold_migration_cost_100000_objects() {
        let scratch = tempdir();
        let source = scratch.join("source.db");
        let mut conn = open_bare(&source);
        let ctx = MigrationContext::current(10);
        let before = migration_index("v2-capture-file-holds");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute("INSERT INTO versioned_workspaces VALUES ('ws','main')", [])
            .unwrap();
        conn.execute("INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','Main',1)", []).unwrap();
        conn.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO file_objects SELECT 'ws','object-'||x,1 FROM n", []).unwrap();
        drop(conn);
        let mut samples = Vec::new();
        for sample in 0..33 {
            let copy = scratch.join(format!("copy-{sample}.db"));
            std::fs::copy(&source, &copy).unwrap();
            let mut conn = open_bare(&copy);
            let start = std::time::Instant::now();
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let objects: i64 = conn
                .query_row("SELECT COUNT(*) FROM file_objects", [], |row| row.get(0))
                .unwrap();
            assert_eq!(objects, 100000);
            drop(conn);
            std::fs::remove_file(copy).unwrap();
            if sample >= 3 {
                samples.push(elapsed);
            }
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "migration_100000_objects warmups=3 samples=30 median_ms={:.6} p95_ms={:.6}",
            (samples[14] + samples[15]) / 2.0,
            samples[28]
        );
    }

    fn migration_29_history_fixture(conn: &Connection) -> (String, String) {
        conn.execute(
            "INSERT INTO versioned_workspaces VALUES ('workspace', 'main')",
            [],
        )
        .unwrap();
        let digest = crate::blob::put_binary_blob(conn, &[0, 0]).unwrap();
        let metadata = format!(
            r#"{{"accepted":{{"receipt":{{"deliveryId":"delivery","updateDigest":"{digest}","journalCursor":1,"acceptingHostEpoch":1}},"binding":{{"workspaceId":"workspace","mainVersionId":"main","objectId":"object","lineageClaimId":"lineage","currentPath":"docs/a.md","selectorPaths":["docs"],"restoreFenceGeneration":0}},"authority":{{"grantGeneration":null,"grantId":null,"principalId":"owner","principalKind":"owner"}},"receivedAtMs":30}},"firstSeen":[]}}"#
        );
        let initial = crate::blob::hex_sha256(
            br#"["accepted-history-v1",["relay","workspace","main","object","lineage"]]"#,
        );
        let evidence = crate::blob::hex_sha256(
            format!(r#"["accepted-event-v1","{initial}",1,{metadata}]"#).as_bytes(),
        );
        conn.execute("INSERT INTO live_device_update_applications (relay_database_namespace,workspace_id,delivery_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,update_digest,update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id) VALUES ('relay','workspace','delivery','main','object','lineage','docs/a.md','[\"docs\"]',0,?1,2,1,1,'owner','owner',30,0,1,'host',1,'instance','connection')", [&digest]).unwrap();
        conn.execute("INSERT INTO live_accepted_updates (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count,journal_cursor,delivery_id,metadata_json,update_sha256,suffix_count,suffix_bytes,evidence_digest) VALUES ('relay','workspace','main','object','lineage',1,1,'delivery',?1,?2,1,2,?3)", rusqlite::params![metadata,digest,evidence]).unwrap();
        (metadata, evidence)
    }

    fn migration_29_application_evidence(conn: &Connection) -> String {
        conn.query_row("SELECT json_array(relay_database_namespace,workspace_id,delivery_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,update_digest,update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,grant_id,grant_generation,received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id,declared_agent_id,declared_on_behalf_of,declared_depth) FROM live_device_update_applications", [], |row| row.get(0)).unwrap()
    }

    fn migration_29_history_evidence(conn: &Connection) -> (String, String) {
        conn.query_row(
            "SELECT metadata_json,evidence_digest FROM live_accepted_updates",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn migration_29_refuses_declared_v1_columns_or_metadata_without_changing_data() {
        for declared_columns in [true, false] {
            let dir = tempdir();
            let path = dir.join("engine.db");
            let mut conn = open_bare(&path);
            let ctx = MigrationContext::current(1_000);
            let before = migration_index("v2-live-admitted-metadata-receipts");
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
            migration_29_history_fixture(&conn);
            if declared_columns {
                conn.execute("UPDATE live_device_update_applications SET declared_agent_id='trip-agent',declared_on_behalf_of='owner',declared_depth=2", []).unwrap();
            } else {
                conn.execute("UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.agentDeclaration',json('{\"agentId\":\"trip-agent\",\"onBehalfOf\":null,\"depth\":2}'))", []).unwrap();
            }
            let original_application = migration_29_application_evidence(&conn);
            let original_history = migration_29_history_evidence(&conn);
            let err = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults)
                .expect_err("declared v1 evidence must stop migration 29");
            assert!(matches!(err, StorageError::MigrationFailed { .. }));
            let cause = std::error::Error::source(&err).unwrap().to_string();
            assert!(cause.contains("declared v1 accepted evidence"), "{cause}");
            assert!(cause.contains("<workspace>/.dohc/engine"), "{cause}");
            assert_eq!(
                migration_29_application_evidence(&conn),
                original_application
            );
            assert_eq!(migration_29_history_evidence(&conn), original_history);
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM engine_migrations WHERE ordinal=29",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('live_device_update_applications') WHERE name='admitted_metadata_json'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            drop(conn);
            let image = std::fs::read(&path).unwrap();
            let Err(err) = crate::EngineStore::open(&path, 2_000) else {
                panic!("opening declared history refuses");
            };
            assert!(
                std::error::Error::source(&err)
                    .unwrap()
                    .to_string()
                    .contains("declared v1 accepted evidence")
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                image,
                "refusing the store preserves its database bytes"
            );
        }
    }

    #[test]
    fn migration_29_upgrades_undeclared_v1_history_without_changing_its_evidence() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let mut conn = open_bare(&path);
        let ctx = MigrationContext::current(1_000);
        let before = migration_index("v2-live-admitted-metadata-receipts");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        let original = migration_29_history_fixture(&conn);
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        assert_eq!(migration_29_history_evidence(&conn), original);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('live_device_update_applications') WHERE name IN ('declared_agent_id','declared_on_behalf_of','declared_depth')", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('live_device_update_applications') WHERE name='admitted_metadata_json'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('live_audit_events') WHERE name='canonical_version'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('owner_ydoc_outbox_entries') WHERE name='agent_declaration_json'", [], |row| row.get::<_, i64>(0)).unwrap(), 1, "native request declarations remain available");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM engine_migrations WHERE ordinal=29",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(conn);
        let store = crate::EngineStore::open(&path, 2_000).unwrap();
        assert_eq!(
            store
                .read_with(|conn| Ok::<_, rusqlite::Error>(migration_29_history_evidence(conn)))
                .unwrap(),
            original
        );
    }

    #[test]
    fn migration_29_refuses_replicated_or_conflicting_declared_v1_evidence() {
        for (conflict, large_header) in [(false, false), (true, false), (false, true), (true, true)]
        {
            let dir = tempdir();
            let path = dir.join("engine.db");
            let mut conn = open_bare(&path);
            let ctx = MigrationContext::current(1_000);
            let before = migration_index("v2-live-admitted-metadata-receipts");
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
            let (metadata, evidence) = migration_29_history_fixture(&conn);
            let declaration = ",\"agentDeclaration\":{\"agentId\":\"trip-agent\",\"onBehalfOf\":null,\"depth\":0}";
            let head = metadata.strip_suffix("},\"firstSeen\":[]}").unwrap();
            // A syntactically valid accepted header can place its declaration
            // beyond the old prefix without exceeding the native header bound.
            let padding = if large_header {
                " ".repeat(280_000)
            } else {
                String::new()
            };
            let head = head.replacen("\"binding\":", &format!("\"binding\":{padding}"), 1);
            assert!(head.len() < crate::limits::MAX_LIVE_ACCEPTED_HEADER_BYTES);
            if large_header {
                assert!(head.len() > 270_336);
            }
            let record = format!(
                "{{\"kind\":\"application\",\"metadata\":{head}{declaration}}},\"firstSeen\":[]}}}}"
            );
            serde_json::from_str::<serde_json::Value>(&record).unwrap();
            let chunk = crate::blob::put_binary_blob(&conn, record.as_bytes()).unwrap();
            let update: String = conn
                .query_row(
                    "SELECT update_sha256 FROM live_accepted_updates",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            conn.execute(
                "INSERT INTO live_audit_record_manifests VALUES (?1,'{}',?2)",
                rusqlite::params![chunk, update],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO live_audit_record_chunks VALUES (?1,0,?1)",
                [&chunk],
            )
            .unwrap();
            if conflict {
                conn.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('workspace','peer',0,'live.audit','{}',1,1)", []).unwrap();
                conn.execute(
                    "INSERT INTO live_audit_event_conflicts VALUES ('workspace','peer',0,?1)",
                    [&chunk],
                )
                .unwrap();
            } else {
                conn.execute("INSERT INTO live_audit_events VALUES ('relay','workspace','main','object','lineage',1,?1,?2,1,'delivery',1,NULL,NULL)", rusqlite::params![chunk,evidence]).unwrap();
            }
            conn.execute("DELETE FROM live_device_update_applications", [])
                .unwrap();
            conn.execute("DELETE FROM live_accepted_updates", [])
                .unwrap();
            let err = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap_err();
            assert!(
                std::error::Error::source(&err)
                    .unwrap()
                    .to_string()
                    .contains("declared v1 accepted evidence")
            );
            assert_eq!(
                crate::blob::get_binary_blob(&conn, &chunk)
                    .unwrap()
                    .unwrap(),
                record.as_bytes()
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM engine_migrations WHERE ordinal=29",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            drop(conn);
            let image = std::fs::read(&path).unwrap();
            assert!(crate::EngineStore::open(&path, 2_000).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), image);
        }
    }

    #[test]
    fn a_claim_from_before_shared_authors_reads_none_and_a_new_one_must_be_json() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let mut conn = open_bare(&path);
        let ctx = MigrationContext::current(1_000);
        let before = migration_index("v2-automation-claim-shared-author");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        let insert = |conn: &Connection, claim_id: &str| {
            conn.execute(
                "INSERT INTO automation_claims (workspace_id, claim_id, automation_id, trigger_history_id, \
                 record_id, collection_path, depth, state, created_at_ms, updated_at_ms) \
                 VALUES ('ws', ?1, 'collection:tasks#stamp', ?2, 'rec', 'tasks', 0, 'pending', 1, 1)",
                rusqlite::params![claim_id, claim_id.len() as i64],
            )
        };
        insert(&conn, "atc_old").unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let author: Option<String> = conn
            .query_row(
                "SELECT change_author_json FROM automation_claims WHERE claim_id = 'atc_old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(author, None, "a claim from before names no shared author");
        insert(&conn, "atc_newer").unwrap();
        assert!(
            conn.execute(
                "UPDATE automation_claims SET change_author_json = 'not json' WHERE claim_id = 'atc_newer'",
                [],
            )
            .is_err()
        );
    }

    #[test]
    fn a_claim_from_before_live_cursors_reads_none_and_a_new_one_must_be_positive() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let mut conn = open_bare(&path);
        let ctx = MigrationContext::current(1_000);
        let before = migration_index("v2-automation-claim-live-cursor");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute(
            "INSERT INTO automation_claims (workspace_id, claim_id, automation_id, trigger_history_id, \
             record_id, collection_path, depth, state, created_at_ms, updated_at_ms) \
             VALUES ('ws', 'atc_old', 'collection:tasks#stamp', 1, 'rec', 'tasks', 0, 'pending', 1, 1)",
            [],
        )
        .unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let cursor: Option<i64> = conn
            .query_row(
                "SELECT change_live_cursor FROM automation_claims WHERE claim_id = 'atc_old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cursor, None, "a claim from before has no live cursor");
        assert!(
            conn.execute(
                "UPDATE automation_claims SET change_live_cursor = 0 WHERE claim_id = 'atc_old'",
                [],
            )
            .is_err()
        );
        conn.execute(
            "UPDATE automation_claims SET change_live_cursor = 7 WHERE claim_id = 'atc_old'",
            [],
        )
        .unwrap();
    }

    #[test]
    fn relay_identity_claim_migration_preserves_existing_identity() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let mut conn = open_bare(&path);
        let ctx = MigrationContext::current(1_000);
        let before = migration_index("v2-sync-identity-claim-state");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute("INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('ws','origin','epoch','stream',1)", []).unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let identity: (String, String, String, Option<String>, Option<String>) = conn.query_row(
            "SELECT origin_id,replication_epoch,stream_identity,claim_state,claim_account_id FROM sync_identity WHERE workspace_id='ws'", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(
            identity,
            (
                "origin".to_owned(),
                "epoch".to_owned(),
                "stream".to_owned(),
                None,
                None
            )
        );
        assert!(
            conn.execute("UPDATE sync_identity SET claim_state='unexpected'", [])
                .is_err()
        );
    }

    /// A stored single author becomes a list of one, NULL history stays NULL,
    /// and every lineage starts with no pending authors and no unresolved
    /// settle.
    #[test]
    fn live_edit_author_migration_turns_single_authors_into_lists() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let mut conn = open_bare(&path);
        let ctx = MigrationContext::current(1_000);
        let before = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == "v2-ydoc-live-edit-authors")
            .expect("the live edit author migration ships");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id) VALUES ('ws', 'main');
             INSERT INTO versions (workspace_id, version_id, name, kind, created_at_ms)
                 VALUES ('ws', 'main', 'Main', 'main', 1);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES ('ws', 'object', 1);
             INSERT INTO blobs (sha256, byte_length, text) VALUES ('sha', 1, 'x');",
        ).unwrap();
        let agent = r#"{"kind":"agent","agentId":"runner","onBehalfOf":"local"}"#;
        for (order, author) in [(1, Some(agent)), (2, None)] {
            conn.execute(
                "INSERT INTO moments (workspace_id, moment_order, moment_id, version_id, \
                     object_id, path, recorded_at_ms, operation, after_blob_sha256, \
                     before_present, metadata_origin, author_json) \
                 VALUES ('ws', ?1, 'moment-' || ?1, 'main', 'object', 'a.md', 1, 'write', \
                         'sha', 0, 'api', ?2)",
                rusqlite::params![order, author],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO ydoc_docs (workspace_id, version_id, object_id, updated_at_ms, \
                 creator_author_json) VALUES ('ws', 'main', 'object', 1, ?1)",
            [agent],
        )
        .unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();

        let authors: Vec<Option<String>> = conn
            .prepare("SELECT author_json FROM moments ORDER BY moment_order")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let list = format!("[{agent}]");
        assert_eq!(authors, vec![Some(list.clone()), None]);
        let doc: (String, Option<i64>) = conn
            .query_row(
                "SELECT pending_authors_json, settle_prior_update_seq FROM ydoc_docs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(doc, ("[]".to_owned(), None));
        let creator_columns: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('ydoc_docs') WHERE name='creator_author_json'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(creator_columns, 0);
        assert!(
            conn.execute("UPDATE ydoc_docs SET pending_authors_json = '{}'", [])
                .is_err(),
            "pending authors are a list"
        );
        assert!(
            conn.execute("UPDATE ydoc_docs SET settle_prior_update_seq = -2", [])
                .is_err(),
            "-1 is the only sentinel"
        );
        conn.execute("UPDATE ydoc_docs SET settle_prior_update_seq = -1", [])
            .expect("-1 records a prior NULL boundary");
    }

    /// The shipped list is well-formed. `validate_migration_order` runs before
    /// every migration, so a malformed list already fails closed at runtime,
    /// but that failure would first be seen by whoever opened a store.
    #[test]
    fn a_groups_store_gains_nullable_agent_owner_metadata() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let mut conn = open_bare(&path);
        let ctx = MigrationContext::current(1_000);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..2], &ctx, &NoFaults)
            .expect("shipped schema");
        assert_eq!(
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("upgrade"),
            MigrationOutcome::Applied {
                newly_applied: BASELINE_MIGRATIONS.len() as u32 - 2
            }
        );
        let nullable: bool = conn.query_row("SELECT [notnull] = 0 FROM pragma_table_info('chat_messages') WHERE name = 'author_owner_display_name'", [], |row| row.get(0)).expect("column");
        assert!(nullable);
    }

    /// Claims written before trigger keys keep every column and trigger, and
    /// the rebuilt table takes each kind with its key and record rules.
    #[test]
    fn automation_claims_from_before_trigger_keys_upgrade_unchanged() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        let before = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == "v2-automation-trigger-keys")
            .expect("the trigger key migration ships");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults)
            .expect("store before trigger keys");
        conn.execute_batch(
            "INSERT INTO automation_claims \
                 (workspace_id, claim_id, automation_id, trigger_moment_order, record_id, \
                  collection_path, depth, state, attempts, error, created_at_ms, updated_at_ms, \
                  change_kind, change_fields_json, run) \
                 VALUES ('ws', 'atc_added', 'collection:Trip#stamp', 7, 'rec', 'Trip', 1, \
                         'failed', 2, 'boom', 3, 4, 'added', '[]', 2);",
        )
        .expect("seed a claim");
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("upgrade");
        type Row = (
            String,
            Option<i64>,
            Option<String>,
            i64,
            String,
            i64,
            Option<String>,
            i64,
            Option<String>,
        );
        let row: Row = conn
            .query_row(
                "SELECT automation_id, trigger_moment_order, trigger_key, depth, state, \
                        attempts, error, run, message_json FROM automation_claims",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .expect("upgraded claim");
        assert_eq!(
            row,
            (
                "collection:Trip#stamp".into(),
                Some(7),
                None,
                1,
                "failed".into(),
                2,
                Some("boom".into()),
                2,
                None
            )
        );
        let insert = |claim_id: &str,
                      key: Option<&str>,
                      record_id: Option<&str>,
                      kind: &str,
                      message_json: Option<&str>| {
            conn.execute(
                "INSERT INTO automation_claims \
                     (workspace_id, claim_id, automation_id, trigger_key, record_id, \
                      collection_path, depth, state, created_at_ms, updated_at_ms, change_kind, \
                      message_json) \
                 VALUES ('ws', ?1, 'collection:Trip#task', ?2, ?3, 'Trip', 0, 'pending', 5, 5, \
                         ?4, ?5)",
                rusqlite::params![claim_id, key, record_id, kind, message_json],
            )
        };
        let message = Some("{\"id\":\"message-1\"}");
        insert("atc_message", Some("message:1"), None, "message", message)
            .expect("a message claim");
        insert("atc_button", Some("press:1"), Some("rec"), "button", None)
            .expect("a button claim names its record");
        insert("atc_schedule", Some("schedule:9"), None, "schedule", None)
            .expect("a schedule claim has no record");
        for (claim_id, key, record_id, kind, message_json, why) in [
            (
                "atc_again",
                Some("message:1"),
                None,
                "message",
                None,
                "one claim per key and automation",
            ),
            (
                "atc_kind",
                Some("message:2"),
                Some("rec"),
                "changed",
                None,
                "a record change keys on its change, not a trigger key",
            ),
            (
                "atc_nokey",
                None,
                None,
                "message",
                None,
                "a message claim names its key",
            ),
            (
                "atc_record",
                Some("message:3"),
                Some("rec"),
                "message",
                None,
                "a message claim has no record",
            ),
            (
                "atc_norecord",
                Some("press:2"),
                None,
                "button",
                None,
                "a button claim names its record",
            ),
            (
                "atc_json",
                Some("press:3"),
                Some("rec"),
                "button",
                message,
                "only a message claim carries a message",
            ),
        ] {
            assert!(
                insert(claim_id, key, record_id, kind, message_json).is_err(),
                "{why}"
            );
        }
        conn.execute(
            "INSERT INTO automation_group_subscriptions \
                 (workspace_id, automation_id, channel_id, starts_with, created_at_ms) \
             VALUES ('ws', 'collection:Trip#task', 'channel-1', '/task', 1)",
            [],
        )
        .expect("a Group subscription");
    }

    /// One button claim at a time is pending or running per automation and
    /// record, and a store gains the press and schedule mark tables.
    #[test]
    fn one_button_claim_is_active_per_automation_and_record() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("migrate");
        let insert = |claim_id: &str, record_id: &str, state: &str| {
            conn.execute(
                "INSERT INTO automation_claims \
                     (workspace_id, claim_id, automation_id, trigger_key, record_id, \
                      collection_path, depth, state, created_at_ms, updated_at_ms, change_kind) \
                 VALUES ('ws', ?1, 'collection:Invoices#pay', 'press:' || ?1, ?2, 'Invoices', \
                         0, ?3, 5, 5, 'button')",
                rusqlite::params![claim_id, record_id, state],
            )
        };
        insert("atc_done", "rec", "done").expect("a finished press");
        insert("atc_failed", "rec", "failed").expect("a failed press");
        insert("atc_pending", "rec", "pending").expect("an unfinished press");
        assert!(
            insert("atc_running", "rec", "running").is_err(),
            "a second unfinished press of the same button on the same record"
        );
        insert("atc_other", "rec_2", "running").expect("another record");
        conn.execute_batch(
            "INSERT INTO automation_presses \
                 (workspace_id, press_id, automation_id, record_id, pressed_by, pressed_at_ms, \
                  claim_id) \
                 VALUES ('ws', 'p1', 'collection:Invoices#pay', 'rec', 'user:ada', 5, \
                         'atc_pending'); \
             INSERT INTO automation_schedule_marks \
                 (workspace_id, automation_id, schedule_hash, through_ms) \
                 VALUES ('ws', 'collection:Invoices#report', 'h', 5);",
        )
        .expect("a press and a schedule mark");
    }

    /// Every Group subscription from before the coverage starts at the
    /// upgrade, so a later handover replays no message from before it, and
    /// stays on.
    #[test]
    fn group_subscriptions_from_before_the_coverage_start_at_the_upgrade() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        let before = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == "v2-automation-group-coverage")
            .expect("the Group coverage migration ships");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults)
            .expect("the schema before it");
        conn.execute_batch(
            "INSERT INTO automation_group_subscriptions \
                 (workspace_id, automation_id, channel_id, starts_with, created_at_ms) \
                 VALUES ('ws', 'collection:Trip#task', 'trip', '/task', 1);",
        )
        .expect("a subscription");
        let clock = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_millis() as i64
        };
        let upgrading = clock();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("upgrade");
        let upgraded = clock();
        let (start, frozen): (i64, i64) = conn
            .query_row(
                "SELECT created_at_ms, frozen FROM automation_group_subscriptions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("subscription");
        assert!(
            (upgrading - 1..=upgraded + 1).contains(&start),
            "{start} is the upgrade"
        );
        assert_eq!(frozen, 0, "a subscription stays on");
        assert!(
            conn.execute("UPDATE automation_group_subscriptions SET frozen = 2", [],)
                .is_err(),
            "frozen is a flag"
        );
        let coverage: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_group_coverage",
                [],
                |row| row.get(0),
            )
            .expect("coverage");
        assert_eq!(coverage, 0);
    }

    /// Messages and mentions written before automations could post keep every
    /// column, and the rebuilt tables take the automation kind with its local
    /// provenance on automation rows only.
    #[test]
    fn chat_rows_from_before_automation_authors_upgrade_unchanged() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        let before = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == "v2-chat-automation-author")
            .expect("the chat automation author migration ships");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults)
            .expect("store before automation authors");
        conn.execute_batch(
            "INSERT INTO chat_threads (workspace_id, thread_id, title, created_at_ms, updated_at_ms) \
                 VALUES ('ws', 'thread-1', '', 1, 1); \
             INSERT INTO chat_messages \
                 (workspace_id, thread_id, message_order, message_id, author_kind, author_display_name, \
                  author_user_id, parent_message_id, origin, body, created_at_ms, author_owner_display_name) \
                 VALUES ('ws', 'thread-1', 0, 'message-1', 'human', 'Ice', 'user-ice', NULL, NULL, 'Hi @ana', 2, NULL), \
                        ('ws', 'thread-1', 1, 'message-2', 'agent', 'Helper', 'user-ice', 'message-1', 'cli', 'Done', 3, 'Ice'); \
             INSERT INTO chat_mentions (workspace_id, thread_id, message_id, handle, author_kind, created_at_ms) \
                 VALUES ('ws', 'thread-1', 'message-1', 'ana', 'human', 2);",
        )
        .expect("seed pre-upgrade chat rows");
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("upgrade");

        type Row = (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            i64,
            Option<String>,
            Option<String>,
            Option<i64>,
        );
        let rows: Vec<Row> = conn
            .prepare(
                "SELECT message_id, author_kind, author_display_name, author_user_id, parent_message_id, \
                        origin, body, created_at_ms, author_owner_display_name, automation_id, chain_depth \
                 FROM chat_messages ORDER BY message_order",
            )
            .expect("message query")
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                    row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?))
            })
            .expect("messages")
            .collect::<Result<_, _>>()
            .expect("message rows");
        assert_eq!(
            rows,
            vec![
                (
                    "message-1".into(),
                    "human".into(),
                    "Ice".into(),
                    Some("user-ice".into()),
                    None,
                    None,
                    "Hi @ana".into(),
                    2,
                    None,
                    None,
                    None
                ),
                (
                    "message-2".into(),
                    "agent".into(),
                    "Helper".into(),
                    Some("user-ice".into()),
                    Some("message-1".into()),
                    Some("cli".into()),
                    "Done".into(),
                    3,
                    Some("Ice".into()),
                    None,
                    None
                ),
            ]
        );
        let mention: (String, String) = conn
            .query_row(
                "SELECT handle, author_kind FROM chat_mentions WHERE message_id = 'message-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("mention");
        assert_eq!(mention, ("ana".to_owned(), "human".to_owned()));

        let insert = |kind: &str, automation_id: Option<&str>, depth: Option<i64>, order: i64| {
            conn.execute(
                "INSERT INTO chat_messages \
                     (workspace_id, thread_id, message_order, message_id, author_kind, author_display_name, \
                      body, created_at_ms, automation_id, chain_depth) \
                 VALUES ('ws', 'thread-1', ?1, ?2, ?3, 'Stamp the finish date', 'Done', 4, ?4, ?5)",
                rusqlite::params![order, format!("message-{order}"), kind, automation_id, depth],
            )
        };
        insert(
            "automation",
            Some("collection:Trip/Tasks#stamp"),
            Some(1),
            10,
        )
        .expect("a local automation message");
        insert("automation", None, None, 11).expect("an automation message from another computer");
        assert!(
            insert("human", Some("collection:Trip/Tasks#stamp"), Some(1), 12).is_err(),
            "only automation rows name an automation"
        );
        assert!(
            insert("automation", Some("collection:Trip/Tasks#stamp"), None, 13).is_err(),
            "an automation id comes with its depth"
        );
        assert!(
            insert(
                "automation",
                Some("collection:Trip/Tasks#stamp"),
                Some(0),
                14
            )
            .is_err(),
            "an automation write is at depth 1 or more"
        );
        conn.execute(
            "INSERT INTO chat_mentions (workspace_id, thread_id, message_id, handle, author_kind, created_at_ms) \
             VALUES ('ws', 'thread-1', 'message-10', 'ana', 'automation', 4)",
            [],
        )
        .expect("an automation mention");
    }

    /// Plugin subscriptions and claims written before the automation facts
    /// migration keep their meaning: a subscription wants added and changed
    /// records on any field, a claim is a first-run changed-record claim
    /// without facts, and both move into the `plugin:` namespace the plugin
    /// executor drains, keeping each claim's id and trigger. The domain
    /// tests drain and retry a claim of this shape.
    #[test]
    fn automation_rows_from_before_the_change_facts_upgrade_with_their_meaning() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        let before = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == "v2-automation-change-facts")
            .expect("the change facts migration ships");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults)
            .expect("store before the change facts");
        conn.execute_batch(
            "INSERT INTO automation_subscriptions \
                 (workspace_id, automation_id, prefix, created_at_ms) \
                 VALUES ('ws', 'hello/triage', 'tasks', 1); \
             INSERT INTO automation_claims \
                 (workspace_id, claim_id, automation_id, trigger_history_id, record_id, \
                  collection_path, depth, state, attempts, error, created_at_ms, updated_at_ms) \
                 VALUES ('ws', 'atc_failed', 'hello/triage', 1, 'rec', 'tasks', 0, 'failed', 1, \
                         'handler threw', 2, 2), \
                        ('ws', 'atc_pending', 'hello/triage', 2, 'rec', 'tasks', 0, 'pending', 0, \
                         NULL, 3, 3);",
        )
        .expect("seed pre-upgrade automation rows");
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("upgrade");

        let subscription: (i64, i64, i64, Option<String>) = conn
            .query_row(
                "SELECT on_added, on_changed, on_removed, field_names_json \
                 FROM automation_subscriptions WHERE automation_id = 'plugin:hello/triage'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("upgraded subscription");
        assert_eq!(subscription, (1, 1, 0, None));
        let mut statement = conn
            .prepare(
                "SELECT claim_id, change_kind, author_origin_id, actor_kind, on_behalf_of, \
                        change_fields_json, change_fields_omitted, run, automation_id, \
                        trigger_history_id \
                 FROM automation_claims ORDER BY claim_id",
            )
            .expect("claim query");
        let claims = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            })
            .expect("claims")
            .collect::<Result<Vec<_>, _>>()
            .expect("claim rows");
        for (claim_id, history_id) in [("atc_failed", 1), ("atc_pending", 2)] {
            assert!(
                claims.contains(&(
                    claim_id.to_owned(),
                    "changed".to_owned(),
                    None,
                    None,
                    None,
                    "[]".to_owned(),
                    0,
                    1,
                    "plugin:hello/triage".to_owned(),
                    history_id,
                )),
                "{claim_id} upgrades to a first-run changed claim: {claims:?}"
            );
        }
    }

    #[test]
    fn existing_relay_cursors_keep_bootstrap_complete_when_upgraded() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1_000);
        let before = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.id == "v2-relay-bootstrap-complete")
            .expect("bootstrap tracking migration");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults)
            .expect("schema before bootstrap tracking");
        conn.execute(
            "INSERT INTO sync_relay_cursors (workspace_id,cursor,replication_epoch,stream_identity) \
             VALUES ('ws','42','epoch','stream')",
            [],
        )
        .expect("existing cursor");
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("upgrade");
        let cursor: (String, bool) = conn
            .query_row(
                "SELECT cursor,bootstrap_complete FROM sync_relay_cursors WHERE workspace_id='ws'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("upgraded cursor");
        assert_eq!(cursor, ("42".to_owned(), true));
    }

    #[test]
    fn a_baseline_only_store_gains_the_groups_columns() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        let baseline_only = &BASELINE_MIGRATIONS[..1];
        run_migrations(&mut conn, baseline_only, &ctx, &NoFaults).expect("baseline");
        let has_type: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_channels') WHERE name = 'type'",
                [],
                |r| r.get(0),
            )
            .expect("probe");
        assert!(!has_type, "the baseline alone has no type column");

        let out = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults)
            .expect("groups and agent owner");
        assert_eq!(
            out,
            MigrationOutcome::Applied {
                newly_applied: BASELINE_MIGRATIONS.len() as u32 - 1
            }
        );
        for (table, column) in [
            ("chat_channels", "type"),
            ("chat_channels", "purpose"),
            ("chat_channels", "folder_path"),
            ("chat_threads", "lane"),
            ("chat_decisions", "options_json"),
            ("chat_decisions", "chosen_option"),
        ] {
            let present: bool = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) > 0 FROM pragma_table_info('{table}') WHERE name = ?1"
                    ),
                    [column],
                    |r| r.get(0),
                )
                .expect("probe");
            assert!(
                present,
                "{table}.{column} must exist after the groups migration"
            );
        }
        // Old rows keep their meaning through the defaults.
        conn.execute(
            "INSERT INTO chat_channels (workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms) \
             VALUES ('w', 'c', 'general', 'general', 'channel', 1, 1)",
            [],
        )
        .expect("insert");
        let (kind, purpose, folder): (String, String, Option<String>) = conn
            .query_row(
                "SELECT type, purpose, folder_path FROM chat_channels WHERE channel_id = 'c'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("read");
        assert_eq!(
            (kind.as_str(), purpose.as_str(), folder),
            ("posts", "", None)
        );
    }

    #[test]
    fn the_real_migration_ledger_has_unique_increasing_ordinals_and_ids() {
        validate_migration_order(BASELINE_MIGRATIONS).expect("well-formed migration list");
    }

    /// The ordinal a newer build's first migration takes: one past this
    /// build's last, so the fixtures hold whatever this build ships.
    fn next_ordinal() -> u32 {
        BASELINE_MIGRATIONS.last().expect("a migration").ordinal + 1
    }

    /// This build's migrations plus newer stand-ins at the following ordinals.
    fn newer_list(ids: &[&'static str]) -> Vec<Migration> {
        let mut newer = BASELINE_MIGRATIONS.to_vec();
        for (offset, &id) in (0u32..).zip(ids) {
            newer.push(Migration {
                ordinal: next_ordinal() + offset,
                id,
                sql: match offset {
                    0 => "CREATE TABLE from_a_newer_build_0 (x INTEGER);",
                    _ => "CREATE TABLE from_a_newer_build_1 (x INTEGER);",
                },
                sets_user_version: None,
            });
        }
        newer
    }

    /// An older build cannot know what a newer build's migration changed, so
    /// it must not run against the store.
    #[test]
    fn a_shorter_migration_list_refuses_a_store_with_an_extra_completed_row() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        let newer = newer_list(&["from-a-newer-build"]);
        run_migrations(&mut conn, &newer, &ctx, &NoFaults).expect("the newer build migrates");

        assert!(
            newer_build_refusal(&conn, &newer)
                .expect("read ledger")
                .is_none(),
            "the newer build opens its store"
        );
        let refused = newer_build_refusal(&conn, BASELINE_MIGRATIONS)
            .expect("read ledger")
            .expect("a shorter list refuses the store");
        assert_eq!(refused.code(), "migrated-by-newer-build");
        assert_eq!(
            refused.to_string(),
            format!(
                "a newer build ran migration {} (from-a-newer-build), which this build does not define",
                next_ordinal()
            )
        );
    }

    /// A store two migrations ahead is refused by naming the first migration
    /// this build does not define.
    #[test]
    fn a_store_two_migrations_ahead_names_the_first_unknown_migration() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        let newer = newer_list(&["newer-first", "newer-second"]);
        run_migrations(&mut conn, &newer, &ctx, &NoFaults).expect("migrate two ahead");

        let refused = newer_build_refusal(&conn, BASELINE_MIGRATIONS)
            .expect("read ledger")
            .expect("the older build refuses the store");
        assert_eq!(refused.code(), "migrated-by-newer-build");
        assert_eq!(
            refused.to_string(),
            format!(
                "a newer build ran migration {} (newer-first), which this build does not define",
                next_ordinal()
            )
        );
    }

    /// A newer build's migration that stopped before it completed can still
    /// have changed the store. Its started row alone refuses the store.
    #[test]
    fn a_newer_builds_unfinished_migration_refuses_the_store() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);
        let mut conn = open_bare(&path);
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("migrate");
        conn.execute(
            "INSERT INTO engine_migrations \
             (ordinal, id, checksum, engine_build, protocol_version, transactional, started_at) \
             VALUES (?1, 'from-a-newer-build', 'newer', 'newer', 1, 0, 2)",
            [i64::from(next_ordinal())],
        )
        .expect("a newer build starts a migration and stops");

        let refused = newer_build_refusal(&conn, BASELINE_MIGRATIONS)
            .expect("read ledger")
            .expect("the started row refuses the store");
        assert_eq!(refused.code(), "migrated-by-newer-build");
    }

    /// Only this engine's ledger names a newer build. A table with the same
    /// name but no baseline row belongs to something else, and the open's own
    /// checks classify it.
    #[test]
    fn a_ledger_without_the_baseline_row_names_no_newer_build() {
        let dir = tempdir();
        let conn = open_bare(&dir.join("engine.db"));
        conn.execute_batch(
            "CREATE TABLE engine_migrations (ordinal INTEGER, id TEXT);
             INSERT INTO engine_migrations VALUES (0, 'someone-elses-migration');",
        )
        .expect("a foreign ledger");
        assert!(
            newer_build_refusal(&conn, BASELINE_MIGRATIONS)
                .expect("read ledger")
                .is_none()
        );
    }

    /// A one-shot crash injector local to the storage crate's tests (the
    /// testkit's `ScriptedFaults` cannot be used here without a dependency
    /// cycle).
    #[cfg(feature = "fault-injection")]
    struct OneShotCrash {
        point: FaultPoint,
        armed: AtomicBool,
    }
    #[cfg(feature = "fault-injection")]
    impl OneShotCrash {
        fn at(point: FaultPoint) -> Self {
            OneShotCrash {
                point,
                armed: AtomicBool::new(true),
            }
        }
    }
    #[cfg(feature = "fault-injection")]
    impl FaultInjector for OneShotCrash {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == self.point && self.armed.swap(false, Ordering::AcqRel) {
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }

    #[test]
    fn file_export_lane_migration_preserves_prune_and_head_changes_clears_claim_and_retires_delete()
    {
        let mut conn = Connection::open_in_memory().unwrap();
        let ctx = MigrationContext::current(1000);
        let target = BASELINE_MIGRATIONS
            .iter()
            .position(|migration| migration.ordinal == 41)
            .unwrap();
        assert_eq!(BASELINE_MIGRATIONS[target - 1].ordinal, 40);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..target], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','main',0); INSERT INTO file_objects VALUES ('ws','doc',0);").unwrap();
        let sha = "a".repeat(64);
        conn.execute("INSERT INTO blobs VALUES (?1,1,'a')", [&sha])
            .unwrap();
        conn.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES ('ws','main','doc','doc.md',?1,0,'a','ydoc')",[&sha]).unwrap();
        conn.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,updated_at_ms,sharing_declined_json) VALUES ('ws','main','doc','plaintext','local-only','unclaimed',0,?1)",[format!(r#"{{"head_sha256":"{sha}","constraint":"MAX_YDOC_UPDATE_BYTES","limit_bytes":20,"observed_bytes":21}}"#)]).unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=target], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let flag = |conn: &Connection| {
            conn.query_row("SELECT file_export_lane FROM ydoc_docs", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        assert_eq!(flag(&conn), 1);
        conn.execute(
            "UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0",
            [],
        )
        .unwrap();
        conn.execute("UPDATE snapshots SET latest_moment_id='b'", [])
            .unwrap();
        assert_eq!(flag(&conn), 1);
        let next_sha = "b".repeat(64);
        conn.execute("INSERT INTO blobs VALUES (?1,1,'b')", [&next_sha])
            .unwrap();
        conn.execute(
            "UPDATE snapshots SET blob_sha256=?1,metadata_origin='restore'",
            [&next_sha],
        )
        .unwrap();
        assert_eq!(flag(&conn), 1);
        assert!(
            conn.query_row(
                "SELECT sharing_declined_json IS NOT NULL FROM ydoc_docs",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
        );
        let claim = crate::hex_sha256(b"");
        conn.execute("INSERT INTO binary_blobs VALUES (?1,0,X'')", [&claim])
            .unwrap();
        conn.execute("UPDATE ydoc_docs SET regime='replicated',lineage_claim_status='exact',lineage_claim_id=?1",[&claim]).unwrap();
        assert_eq!(flag(&conn), 0);
        conn.execute(
            "UPDATE ydoc_docs SET regime='local-only',lineage_claim_status='unclaimed',lineage_claim_id=NULL,file_export_lane=1",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM snapshots", []).unwrap();
        assert_eq!(flag(&conn), 3);
        assert!(
            conn.execute("UPDATE ydoc_docs SET file_export_lane=4", [])
                .is_err()
        );
    }

    #[test]
    fn owner_person_marker_migration_upgrades_a_populated_store_without_crediting_old_work() {
        let mut conn = Connection::open_in_memory().unwrap();
        let ctx = MigrationContext::current(1_000);
        let before = migration_index("v2-owner-outbox-person-edit");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO binary_blobs VALUES ('base',1,X'58'); \
            INSERT INTO owner_ydoc_outboxes(outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,created_at_ms) \
            VALUES ('outbox','ws','main','doc','base','doc.md','[\"doc.md\"]',0,'base','base',1,'active',1,1,2,1); \
            INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state) \
            VALUES ('outbox',1,'append','delivery','base','base',1,1,1,1,1,'active');").unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let retained: (String, Option<bool>) = conn
            .query_row(
                "SELECT delivery_id,person_edit FROM owner_ydoc_outbox_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(retained, ("delivery".into(), None));
        conn.execute("UPDATE owner_ydoc_outbox_entries SET person_edit=1", [])
            .unwrap();
        assert!(
            conn.execute("UPDATE owner_ydoc_outbox_entries SET person_edit=0", [])
                .is_err()
        );
    }

    #[test]
    fn retained_export_lineage_migration_upgrades_ordinal_38_without_backfill() {
        let mut conn = Connection::open_in_memory().unwrap();
        let ctx = MigrationContext::current(1_000);
        let before = BASELINE_MIGRATIONS
            .iter()
            .take_while(|m| m.ordinal <= 38)
            .count();
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 38);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); \
            INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','main',0); \
            INSERT INTO file_objects VALUES ('ws','doc',0);").unwrap();
        let claim = "c".repeat(64);
        conn.execute(
            "INSERT INTO binary_blobs(sha256,byte_length,bytes) VALUES (?1,0,X'')",
            [&claim],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ydoc_docs (workspace_id,version_id,object_id,content_kind,regime, \
            head_update_seq,head_snapshot_seq,lineage_claim_status,lineage_claim_id,updated_at_ms, \
            export_attempt_moment_id,export_attempt_update_seq,export_attempt_snapshot_seq) \
            VALUES ('ws','main','doc','plaintext','replicated',1,0,'exact',?1,0,'moment',1,0)",
            [&claim],
        )
        .unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let waiting: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT export_wait_asset_path,export_wait_asset_sha256 FROM ydoc_docs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(waiting, (None, None), "existing rows have no asset wait");
        let retry = || {
            conn.query_row(
                "SELECT export_attempt_lineage_claim_id IS NOT lineage_claim_id \
            FROM ydoc_docs WHERE export_attempt_moment_id='moment' \
            AND export_attempt_update_seq=1 AND export_attempt_snapshot_seq=0",
                [],
                |r| r.get::<_, bool>(0),
            )
            .unwrap()
        };
        assert!(retry(), "NULL attempt lineage retries the existing row");
        conn.execute(
            "UPDATE ydoc_docs SET export_attempt_lineage_claim_id=lineage_claim_id",
            [],
        )
        .unwrap();
        assert!(
            !retry(),
            "recording the lineage suppresses the next unchanged attempt"
        );
    }

    #[test]
    fn open_document_artifacts_upgrade_from_39_backfills_local_tails() {
        let mut conn = Connection::open_in_memory().unwrap();
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-open-document-artifacts");
        assert_eq!(BASELINE_MIGRATIONS[before - 1].ordinal, 39);
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 40);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','main',0); INSERT INTO file_objects VALUES ('ws','doc',0),('ws','settled',0); INSERT INTO blobs(sha256,byte_length,text) VALUES ('old',3,'old'),('new',3,'new'); INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,head_update_seq,head_snapshot_seq,settled_update_seq,updated_at_ms) VALUES ('ws','main','doc','plaintext','local-only','unclaimed',2,0,1,0),('ws','main','settled','plaintext','local-only','unclaimed',2,0,2,0); INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES ('ws','main','doc','doc.md','old',0,'m0','sync'); INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','peer',0,'moment.append','{}',0,1); INSERT INTO replication_pending_refusals VALUES ('ws','peer',0,'moment.append','invalid-input','Existing refusal','report');").unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        assert_eq!(
            conn.query_row(
                "SELECT last_local_update_seq FROM ydoc_docs WHERE object_id='doc'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT last_local_update_seq FROM ydoc_docs WHERE object_id='settled'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT reason_message,report_id FROM replication_pending_refusals",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("Existing refusal".into(), "report".into())
        );
        let ddl:String=conn.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='replication_pending_refusals'",[],|r|r.get(0)).unwrap();
        assert!(ddl.contains("CHECK (origin_seq >= 0)"));
        assert!(
            ddl.contains("reason_code IN ('invalid-input','document-artifact-recovery-failed')")
        );
        assert!(ddl.contains("PRIMARY KEY(workspace_id,origin_id,origin_seq)"));
        assert!(ddl.contains("DEFERRABLE INITIALLY DEFERRED"));
        assert!(ddl.ends_with("STRICT"));
        let index_columns = conn
            .prepare("PRAGMA index_info(replication_pending_refusals_by_report)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(2))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(index_columns, ["workspace_id", "report_id"]);
        let foreign_columns = conn
            .prepare("PRAGMA foreign_key_list(replication_pending_refusals)")
            .unwrap()
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(6)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            foreign_columns,
            ["workspace_id", "origin_id", "origin_seq"].map(|column| (
                "replication_log".into(),
                column.into(),
                column.into(),
                "CASCADE".into()
            ))
        );
        assert!(
            conn.execute(
                "UPDATE replication_pending_refusals SET reason_code='unknown'",
                []
            )
            .is_err()
        );
        conn.execute_batch("INSERT INTO moments(workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,operation,after_blob_sha256,before_present,metadata_origin) VALUES ('ws',1,'m1','main','doc','doc.md',1,'write','new',0,'sync'); INSERT INTO ydoc_pending_artifacts VALUES ('ws','main','doc','m1','peer',0,'claim',NULL);").unwrap();
        conn.execute("UPDATE ydoc_docs SET settled_update_seq=2,last_settled_sha='new' WHERE object_id='doc'", []).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        conn.execute("UPDATE snapshots SET blob_sha256='new'", [])
            .unwrap();
        conn.execute(
            "UPDATE ydoc_docs SET last_settled_sha='new' WHERE object_id='doc'",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM ydoc_pending_artifacts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        // Cleanup must retain unrelated refusals on the same coordinate.
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM replication_pending_refusals",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        conn.execute(
            "UPDATE ydoc_docs SET head_update_seq=0,settled_update_seq=NULL WHERE object_id='doc'",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT last_local_update_seq FROM ydoc_docs WHERE object_id='doc'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn sharing_decline_migration_clears_head_claim_delete_and_restore() {
        let mut conn = Connection::open_in_memory().unwrap();
        let ctx = MigrationContext::current(1_000);
        let before = migration_index("v2-ydoc-sharing-declined");
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 31);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES ('ws','main','main','main',0); INSERT INTO file_objects VALUES ('ws','doc',0);").unwrap();
        for value in ['a', 'b'] {
            conn.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,1,?2)",
                rusqlite::params![value.to_string().repeat(64), value.to_string()],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO binary_blobs(sha256,byte_length,bytes) VALUES (?1,0,X'')",
            ["c".repeat(64)],
        )
        .unwrap();
        conn.execute("INSERT INTO ydoc_docs (workspace_id,version_id,object_id,content_kind,regime,head_update_seq,head_snapshot_seq,lineage_claim_status,updated_at_ms) VALUES ('ws','main','doc','plaintext','local-only',0,0,'unclaimed',0)", []).unwrap();
        conn.execute("INSERT INTO snapshots (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES ('ws','main','doc','notes/a.md',?1,0,'moment','api')", ["a".repeat(64)]).unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=before], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let refusal = format!(
            r#"{{"head_sha256":"{}","constraint":"MAX_YDOC_UPDATE_BYTES","limit_bytes":20,"observed_bytes":21}}"#,
            "a".repeat(64)
        );
        let current = |conn: &Connection| {
            conn.query_row("SELECT sharing_declined_json FROM ydoc_docs", [], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap()
        };
        assert_eq!(current(&conn), None);
        conn.execute("UPDATE ydoc_docs SET sharing_declined_json=?1", [&refusal])
            .unwrap();
        // Rename keeps the identity and its refusal.
        conn.execute(
            "UPDATE snapshots SET path='notes/renamed.md',latest_moment_id='renamed'",
            [],
        )
        .unwrap();
        assert_eq!(current(&conn), Some(refusal.clone()));
        // Invalidation shares the head transaction's commit boundary.
        let tx = conn.transaction().unwrap();
        tx.execute("UPDATE snapshots SET blob_sha256=?1", ["b".repeat(64)])
            .unwrap();
        assert_eq!(current(&tx), None);
        tx.rollback().unwrap();
        assert_eq!(current(&conn), Some(refusal.clone()));
        conn.execute("UPDATE snapshots SET blob_sha256=?1", ["b".repeat(64)])
            .unwrap();
        assert_eq!(current(&conn), None);
        conn.execute("UPDATE ydoc_docs SET sharing_declined_json=?1", [&refusal])
            .unwrap();
        // A same-byte restore must clear it too.
        conn.execute(
            "UPDATE snapshots SET metadata_origin='restore',latest_moment_id='restored'",
            [],
        )
        .unwrap();
        assert_eq!(current(&conn), None);
        conn.execute("UPDATE ydoc_docs SET sharing_declined_json=?1", [&refusal])
            .unwrap();
        conn.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','doc','relay','restore','{}','{}')", []).unwrap();
        assert_eq!(current(&conn), None);
        conn.execute("UPDATE ydoc_docs SET sharing_declined_json=?1", [&refusal])
            .unwrap();
        // Both local success and a pull installing a peer claim take this update.
        conn.execute("UPDATE ydoc_docs SET regime='replicated',lineage_claim_status='exact',lineage_claim_id=?1", ["c".repeat(64)]).unwrap();
        assert_eq!(current(&conn), None);
        conn.execute("UPDATE ydoc_docs SET sharing_declined_json=?1", [&refusal])
            .unwrap();
        conn.execute("DELETE FROM snapshots", []).unwrap();
        assert_eq!(current(&conn), None);
        conn.execute("UPDATE ydoc_docs SET sharing_declined_json=?1", [&refusal])
            .unwrap();
        // Archive drops the marker, which owns the refusal.
        conn.execute("DELETE FROM ydoc_docs", []).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM ydoc_docs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    fn open_bare(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).expect("open");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn
    }

    // A synthetic migration after the shipped schema exercises resume.
    #[cfg(feature = "fault-injection")]
    const M2_SQL: &str = "CREATE TABLE r04_probe (x INTEGER NOT NULL);";
    #[cfg(feature = "fault-injection")]
    fn two_migrations() -> Vec<Migration> {
        let mut v = BASELINE_MIGRATIONS.to_vec();
        v.push(Migration {
            ordinal: BASELINE_MIGRATIONS
                .last()
                .map_or(0, |last| last.ordinal + 1),
            id: "r04-probe",
            sql: M2_SQL,
            sets_user_version: None,
        });
        v
    }

    #[test]
    fn baseline_applies_once_and_is_idempotent() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);

        let mut conn = open_bare(&path);
        let out = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("run");
        assert_eq!(
            out,
            MigrationOutcome::Applied {
                newly_applied: BASELINE_MIGRATIONS.len() as u32
            }
        );
        // Second run is a no-op: already applied, checksum matches.
        let out2 = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("run2");
        assert_eq!(out2, MigrationOutcome::Applied { newly_applied: 0 });

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("uv");
        assert_eq!(version, ENGINE_SCHEMA_VERSION);
        let owns: i64 = conn
            .query_row("SELECT COUNT(*) FROM engine_ownership", [], |r| r.get(0))
            .expect("own");
        assert_eq!(owns, 1);
    }

    #[test]
    fn deleting_a_version_cascades_collection_index_rows() {
        let dir = tempdir();
        let path = dir.join("collection-index-version-cascade.db");
        let ctx = MigrationContext::current(1_100);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("apply baseline");

        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
                 VALUES ('ws', 'main');
             INSERT INTO versions (workspace_id, version_id, name, kind, created_at_ms)
                 VALUES ('ws', 'main', 'Main', 'main', 1),
                        ('ws', 'feature', 'Feature', 'named', 2);
             INSERT INTO collection_record_fields (
                 workspace_id, version_id, record_id, field_name,
                 value_json, validation_status
             ) VALUES ('ws', 'main', 'main-record', 'title', 'null', 'valid'),
                      ('ws', 'feature', 'feature-record', 'title', 'null', 'valid');
             INSERT INTO collection_field_history (
                 workspace_id, version_id, record_id, field_name,
                 next_value_json, recorded_at_ms
             ) VALUES ('ws', 'main', 'main-record', 'title', '\"Main\"', 3),
                      ('ws', 'feature', 'feature-record', 'title', '\"Feature\"', 4);
             INSERT INTO collection_relation_edges (
                 workspace_id, version_id, source_record_id, field_name,
                 target_record_id, target_collection_path, many
             ) VALUES ('ws', 'main', 'main-record', 'related',
                       'main-target', 'people.collection.yaml', 0),
                      ('ws', 'feature', 'feature-record', 'related',
                       'feature-target', 'people.collection.yaml', 0);",
        )
        .expect("seed version-scoped collection index rows");

        conn.execute(
            "DELETE FROM versions WHERE workspace_id='ws' AND version_id='feature'",
            [],
        )
        .expect("delete feature version");

        let remaining: (i64, i64, i64) = conn
            .query_row(
                "SELECT
                     (SELECT COUNT(*) FROM collection_record_fields),
                     (SELECT COUNT(*) FROM collection_field_history),
                     (SELECT COUNT(*) FROM collection_relation_edges)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count surviving collection index rows");
        assert_eq!(remaining, (1, 1, 1));
        for table in [
            "collection_record_fields",
            "collection_field_history",
            "collection_relation_edges",
        ] {
            let deleted_version_rows: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE version_id='feature'"),
                    [],
                    |row| row.get(0),
                )
                .expect("count deleted version rows");
            assert_eq!(
                deleted_version_rows, 0,
                "{table} must cascade with its version"
            );
        }
    }

    #[test]
    fn history_operation_index_upgrades_across_reserved_ordinals() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("history-operation-index.db"));
        let ctx = MigrationContext::current(1100);
        let index = migration_index("v2-history-operation-correlation");
        assert_eq!(BASELINE_MIGRATIONS[index].ordinal, 55);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..index], &ctx, &NoFaults).unwrap();
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=index], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        let plan: Vec<String> = conn.prepare("EXPLAIN QUERY PLAN SELECT moment_id FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2")
            .unwrap().query_map(rusqlite::params!["ws", "dohc-operation:one"], |row| row.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert!(
            plan.iter()
                .any(|line| line.contains("idx_moments_operation_correlation")),
            "{plan:?}"
        );
        assert_eq!(
            run_migrations(&mut conn, &BASELINE_MIGRATIONS[..=index], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 0 }
        );
        // The real migration before 55 can arrive after it: it applies once,
        // 55 doesn't apply twice, and the index survives it.
        let late_dir = tempdir();
        let mut late = open_bare(&late_dir.join("history-operation-late.db"));
        let mut early = BASELINE_MIGRATIONS[..=index].to_vec();
        early.remove(index - 1);
        run_migrations(&mut late, &early, &ctx, &NoFaults).unwrap();
        assert_eq!(
            run_migrations(&mut late, &BASELINE_MIGRATIONS[..=index], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 1 }
        );
        assert_eq!(
            run_migrations(&mut late, &BASELINE_MIGRATIONS[..=index], &ctx, &NoFaults).unwrap(),
            MigrationOutcome::Applied { newly_applied: 0 }
        );
        let late_plan: Vec<String> = late.prepare("EXPLAIN QUERY PLAN SELECT moment_id FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2")
            .unwrap().query_map(rusqlite::params!["ws", "dohc-operation:one"], |row| row.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert!(
            late_plan
                .iter()
                .any(|line| line.contains("idx_moments_operation_correlation")),
            "{late_plan:?}"
        );
    }
    #[test]
    fn collection_history_index_serves_newest_first_record_reads() {
        let dir = tempdir();
        let path = dir.join("collection-history-index.db");
        let ctx = MigrationContext::current(1_100);
        let mut conn = open_bare(&path);
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("apply baseline");

        let plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT field_name, previous_value_json, next_value_json,
                        author_origin_id, recorded_at_ms
                   FROM collection_field_history
                  WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3
                  ORDER BY recorded_at_ms DESC, history_id DESC LIMIT ?4",
            )
            .expect("prepare newest-first history plan")
            .query_map(rusqlite::params!["ws", "main", "record", 100], |row| {
                row.get(3)
            })
            .expect("query newest-first history plan")
            .collect::<rusqlite::Result<_>>()
            .expect("collect newest-first history plan");

        assert!(
            plan.iter()
                .any(|detail| detail.contains("collection_field_history_by_record")),
            "record history must use its record index: {plan:?}"
        );
        assert!(
            plan.iter()
                .all(|detail| !detail.contains("TEMP B-TREE FOR ORDER BY")),
            "record history index must serve newest-first ordering: {plan:?}"
        );
    }

    #[test]
    fn global_generation_indexes_match_the_high_water_domains() {
        let dir = tempdir();
        let path = dir.join("global-generation-indexes.db");
        let ctx = MigrationContext::current(1_100);
        let mut conn = open_bare(&path);

        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("apply baseline");

        let index_sql = |name: &str| -> String {
            conn.query_row(
                "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?1",
                [name],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("missing index {name}: {error}"))
        };
        let normalized = |sql: String| sql.split_whitespace().collect::<Vec<_>>().join(" ");

        assert_eq!(
            normalized(index_sql("idx_moments_global_order")),
            "CREATE INDEX idx_moments_global_order ON moments(moment_order DESC)"
        );
        assert_eq!(
            normalized(index_sql("idx_materialization_jobs_mutation_generation")),
            "CREATE INDEX idx_materialization_jobs_mutation_generation ON materialization_jobs(target_generation DESC) WHERE job_id NOT GLOB 'version-switch-mat_*' AND job_id NOT GLOB 'version-switch-secret-mat_*'"
        );
    }

    #[test]
    fn pending_owner_settlements_retain_blobs_until_queue_removal() {
        let dir = tempdir();
        let path = dir.join("pending-owner-settlements.db");
        let ctx = MigrationContext::current(2_900);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("apply migrations");
        conn.execute_batch(
            "BEGIN;
             INSERT INTO blobs (sha256, byte_length, text)
                 VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'x');
             INSERT INTO binary_blobs (sha256, byte_length, bytes)
                 VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,x'01');
             INSERT INTO owner_pending_settlement_blobs VALUES
                 ('ws','peer',0,'payload-before','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL),
                 ('ws','peer',0,'payload-after',NULL,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
             INSERT INTO owner_pending_settlements (
                 workspace_id,origin_id,origin_seq,main_version_id,object_id,
                 lineage_claim_id,relay_namespace,binding_json,terminal_cursor
             ) VALUES ('ws','peer',0,'main','object','lineage','relay','{}',3);
             INSERT INTO replication_log (
                 workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported
             ) VALUES ('ws','peer',0,'moment.append','{}',1,1);
             COMMIT;",
        )
        .expect("pins and queue can precede the imported envelope");
        for sql in [
            "UPDATE owner_pending_settlements SET checked_sequence=-1",
            "UPDATE owner_pending_settlements SET record_facts_json='invalid'",
        ] {
            conn.execute(sql, [])
                .expect_err("pending settlement rejects invalid drain state");
        }
        conn.execute(
            "UPDATE owner_pending_settlements SET checked_sequence=1, record_facts_json='[]'",
            [],
        )
        .expect("persist valid drain state");
        for sql in [
            "DELETE FROM blobs",
            "DELETE FROM binary_blobs",
            "DELETE FROM replication_log",
        ] {
            conn.execute(sql, [])
                .expect_err("pending settlement retains its durable inputs");
        }
        conn.execute("DELETE FROM owner_pending_settlements", [])
            .expect("remove pending settlement");
        let pins: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM owner_pending_settlement_blobs",
                [],
                |row| row.get(0),
            )
            .expect("count remaining pins");
        assert_eq!(pins, 0);
        conn.execute_batch(
            "DELETE FROM blobs; DELETE FROM binary_blobs; DELETE FROM replication_log;",
        )
        .expect("removed queue releases its inputs");
    }

    #[test]
    fn ydoc_lineage_claim_schema_enforces_roots_constraints_and_indexes() {
        let dir = tempdir();
        let path = dir.join("ydoc-lineage-constraints.db");
        let ctx = MigrationContext::current(2_901);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("apply baseline");
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
                 VALUES ('ws', 'main');
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms)
                 VALUES ('ws', 'object', 1), ('ws', 'prebase', 2);
             INSERT INTO binary_blobs (sha256, byte_length, bytes) VALUES
                 ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,x'01'),
                 ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,x'02'),
                 ('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',1,x'03'),
                 ('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',1,x'04');
             INSERT INTO blobs (sha256, byte_length, text)
                 VALUES ('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',1,'x');
             INSERT INTO ydoc_docs (
                 workspace_id, version_id, object_id, content_kind, regime,
                 head_update_seq, head_snapshot_seq, settle_seq, updated_at_ms,
                 path, lineage_claim_status, lineage_claim_id
             ) VALUES (
                 'ws','main','object','plaintext','replicated',0,0,0,3,NULL,
                 'exact','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
             );
             INSERT INTO ydoc_inactive_lineages (
                 workspace_id, version_id, object_id, lineage_claim_id,
                 disposition, content_kind, path, full_state_blob_sha256,
                 state_vector_blob_sha256,
                 last_surfaced_state_vector_blob_sha256,
                 last_surfaced_projection_sha256, recorded_at_ms, updated_at_ms
             ) VALUES (
                 'ws','main','object',
                 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                 'rejected-base','plaintext',NULL,
                 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',4,4
             );
             INSERT INTO ydoc_deferred_updates (
                 workspace_id, version_id, object_id, origin_id, origin_seq,
                 recorded_at_ms, lineage_claim_id
             ) VALUES (
                 'ws','main','prebase','peer',1,5,
                 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
             );",
        )
        .expect("seed valid latest-shape rows");

        for invalid in [
            "INSERT INTO ydoc_docs (
                 workspace_id,version_id,object_id,content_kind,regime,
                 head_update_seq,head_snapshot_seq,settle_seq,updated_at_ms,
                 lineage_claim_status,lineage_claim_id
             ) VALUES (
                 'ws','other','object','plaintext','local-only',0,0,0,1,
                 'exact','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
             )",
            "UPDATE ydoc_docs SET head_update_seq=-1 WHERE workspace_id='ws' AND object_id='object'",
            "UPDATE ydoc_docs SET head_snapshot_seq=1 WHERE workspace_id='ws' AND object_id='object'",
            "UPDATE ydoc_docs SET lineage_parent_claim_id=
                 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
             WHERE workspace_id='ws' AND object_id='object'",
        ] {
            conn.execute(invalid, [])
                .expect_err("latest marker constraint must fail closed");
        }
        for (invalid, constraint) in [
            (
                "INSERT INTO ydoc_updates (
                     workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms
                 ) VALUES (
                     'ws','main','object',0,
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',6
                 )",
                "update sequence zero",
            ),
            (
                "INSERT INTO ydoc_snapshots (
                     workspace_id,version_id,object_id,up_to_seq,
                     snapshot_blob_sha256,state_vector_blob_sha256,recorded_at_ms
                 ) VALUES (
                     'ws','main','object',-1,
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',6
                 )",
                "negative snapshot sequence",
            ),
            (
                "INSERT INTO ydoc_deferred_updates (
                     workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms
                 ) VALUES ('ws','main','prebase','invalid-peer',-1,6)",
                "negative deferred origin sequence",
            ),
        ] {
            conn.execute(invalid, []).expect_err(constraint);
        }
        conn.execute(
            "DELETE FROM binary_blobs WHERE sha256=
             'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",
            [],
        )
        .expect_err("inactive full state is a RESTRICT root");
        conn.execute(
            "DELETE FROM blobs WHERE sha256=
             'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'",
            [],
        )
        .expect_err("surfaced projection is a RESTRICT root");
        conn.execute(
            "DELETE FROM file_objects WHERE workspace_id='ws' AND object_id='object'",
            [],
        )
        .expect_err("inactive lineage prevents cascading away its file object");

        let partial_indexes: Vec<String> = conn
            .prepare(
                "SELECT name FROM pragma_index_list('ydoc_inactive_lineages') \
                 WHERE partial=1 ORDER BY name",
            )
            .expect("prepare inactive indexes")
            .query_map([], |row| row.get(0))
            .expect("read inactive indexes")
            .collect::<rusqlite::Result<_>>()
            .expect("collect inactive indexes");
        assert_eq!(
            partial_indexes,
            [
                "ydoc_inactive_lineages_by_open_conflict".to_owned(),
                "ydoc_inactive_lineages_by_parent".to_owned(),
            ]
        );
        let deferred_partial: i64 = conn
            .query_row(
                "SELECT partial FROM pragma_index_list('ydoc_deferred_updates') \
                 WHERE name='ydoc_deferred_updates_by_lineage'",
                [],
                |row| row.get(0),
            )
            .expect("claim-aware deferred index");
        assert_eq!(deferred_partial, 1);
        let fk_violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("foreign key check");
        assert_eq!(fk_violations, 0);
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn initial_root_binding_survives_both_migration_crash_boundaries() {
        for point in [
            FaultPoint::MigrateBeforeLedgerCommit,
            FaultPoint::MigrateBetweenSteps,
        ] {
            let dir = tempdir();
            let path = dir.join("engine.db");
            let mut ctx = MigrationContext::current(1_000);
            ctx.initial_root_token = Some("root-token".to_owned());
            {
                let mut conn = open_bare(&path);
                assert_eq!(
                    run_migrations(
                        &mut conn,
                        BASELINE_MIGRATIONS,
                        &ctx,
                        &OneShotCrash::at(point)
                    )
                    .unwrap(),
                    MigrationOutcome::Crashed,
                );
            }
            let mut reopened =
                crate::EngineStore::open_with_root_token(&path, 2_000, "root-token", None).unwrap();
            assert!(reopened.bind_root_token("root-token", &NoFaults).unwrap());
            drop(reopened);
            let mut reopened =
                crate::EngineStore::open_with_root_token(&path, 3_000, "other-root", None).unwrap();
            assert!(reopened.bind_root_token("root-token", &NoFaults).unwrap());
            assert!(!reopened.bind_root_token("other-root", &NoFaults).unwrap());
        }
    }

    #[test]
    fn initial_root_binding_never_adopts_an_existing_unbound_store() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        drop(crate::EngineStore::open(&path, 1_000).unwrap());
        let mut reopened =
            crate::EngineStore::open_with_root_token(&path, 2_000, "new-root", None).unwrap();
        assert!(!reopened.bind_root_token("new-root", &NoFaults).unwrap());
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn crash_before_ledger_commit_rolls_back_and_reopen_recovers() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_000);

        // Arm a crash inside the baseline transaction, before commit.
        let faults = OneShotCrash::at(FaultPoint::MigrateBeforeLedgerCommit);
        {
            let mut conn = open_bare(&path);
            let out = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &faults).expect("run");
            assert_eq!(out, MigrationOutcome::Crashed);
            // The transaction rolled back: no baseline table exists.
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_migrations'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .expect("q");
            assert!(exists.is_none(), "crashed baseline must leave no schema");
            // simulated process death:
        }

        // Reopen and re-run with no fault: recovers cleanly and applies the baseline.
        let mut conn = open_bare(&path);
        let out = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("recover");
        assert_eq!(
            out,
            MigrationOutcome::Applied {
                newly_applied: BASELINE_MIGRATIONS.len() as u32
            }
        );
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn crash_between_steps_resumes_second_migration_from_ledger() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(2_000);
        let migrations = two_migrations();

        let faults = OneShotCrash::at(FaultPoint::MigrateBetweenSteps);
        {
            let mut conn = open_bare(&path);
            let out = run_migrations(&mut conn, &migrations, &ctx, &faults).expect("run");
            assert_eq!(out, MigrationOutcome::Crashed);
            // Baseline committed; probe migration did not run.
            let probe: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='r04_probe'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .expect("q");
            assert!(
                probe.is_none(),
                "probe must not exist after between-steps crash"
            );
            let base: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM engine_migrations WHERE id = ?1",
                    [BASELINE_MIGRATION_ID],
                    |r| r.get(0),
                )
                .expect("base");
            assert_eq!(base, 1, "baseline must be durably recorded");
        }

        // Resume: the baseline is skipped; the remaining migrations apply.
        let mut conn = open_bare(&path);
        let out = run_migrations(&mut conn, &migrations, &ctx, &NoFaults).expect("resume");
        assert_eq!(
            out,
            MigrationOutcome::Applied {
                newly_applied: migrations.len() as u32 - 1
            }
        );
        let probe: i64 = conn
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='r04_probe'",
                [],
                |r| r.get(0),
            )
            .expect("probe");
        assert_eq!(probe, 1);
    }

    #[test]
    fn out_of_order_or_duplicate_migration_list_fails_closed() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(3_000);

        // Ordinals [0, 2, 1]: a dev appended out of order. Must fail closed
        // before applying anything (no partial out-of-order DDL).
        let a = Migration {
            ordinal: 1,
            id: "a",
            sql: "CREATE TABLE a (x INTEGER);",
            sets_user_version: None,
        };
        let b = Migration {
            ordinal: 2,
            id: "b",
            sql: "CREATE TABLE b (x INTEGER);",
            sets_user_version: None,
        };
        let out_of_order = &[BASELINE_MIGRATIONS[0], b, a];
        let mut conn = open_bare(&path);
        let err = run_migrations(&mut conn, out_of_order, &ctx, &NoFaults).unwrap_err();
        assert_eq!(err.code(), "migration-failed");
        // Nothing was applied.
        let applied: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_migrations'",
                [],
                |r| r.get(0),
            )
            .optional()
            .expect("q");
        assert!(applied.is_none(), "out-of-order list must apply nothing");

        // Duplicate id also fails closed.
        let dup = &[
            BASELINE_MIGRATIONS[0],
            Migration {
                ordinal: 1,
                ..BASELINE_MIGRATIONS[0]
            },
        ];
        let mut conn2 = open_bare(&dir.join("dup.db"));
        assert_eq!(
            run_migrations(&mut conn2, dup, &ctx, &NoFaults)
                .unwrap_err()
                .code(),
            "migration-failed"
        );
    }

    #[test]
    fn checksum_mismatch_on_completed_migration_fails_closed() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(3_000);

        let mut conn = open_bare(&path);
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("run");

        // Simulate a build whose baseline DDL differs from the recorded ledger.
        let tampered = &[Migration {
            sql: "CREATE TABLE engine_migrations_DIFFERENT (x INTEGER);",
            ..BASELINE_MIGRATIONS[0]
        }];
        let err = run_migrations(&mut conn, tampered, &ctx, &NoFaults).unwrap_err();
        assert_eq!(err.code(), "migration-failed");
    }

    #[test]
    fn persisted_links_upgrade_seeds_existing_heads_and_survives_cascades() {
        let dir = tempdir();
        let mut conn = open_bare(&dir.join("engine.db"));
        let ctx = MigrationContext::current(1);
        let before = migration_index("v2-persisted-links");
        assert_eq!(BASELINE_MIGRATIONS[before].ordinal, 59);
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..before], &ctx, &NoFaults).unwrap();
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES('ws','main'); INSERT INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES('ws','main','main','Main',1); INSERT INTO file_objects VALUES('ws','a',1); INSERT INTO blobs VALUES('hash',5,'[[b]]'); INSERT INTO path_aliases VALUES('ws','main','a.md','a'); INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('ws','main','a','a.md','hash',1,'m','test');").unwrap();
        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).unwrap();
        let pending: i64 = conn
            .query_row("SELECT COUNT(*) FROM link_pending", [], |r| r.get(0))
            .expect("persisted queue must exist");
        assert_eq!(pending, 0);
        assert_eq!(
            conn.query_row(
                "SELECT wr FROM pragma_table_list WHERE name='link_index_state'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT seed_phase FROM link_index_state", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "deferred"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM link_aliases", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        conn.execute("DELETE FROM file_objects WHERE object_id='a'", [])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM link_pending", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }

    #[cfg(feature = "fault-injection")]
    #[test]
    fn seed_phase_guard_uses_one_primary_key_lookup() {
        let conn = Connection::open_in_memory().unwrap();
        let definition = include_str!("links.sql")
            .split("CREATE TABLE link_index_state ")
            .nth(1)
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE guard_before {}; CREATE TABLE guard_after {};",
            definition.replace(", WITHOUT ROWID", ""),
            definition,
        ))
        .unwrap();
        for table in ["guard_before", "guard_after"] {
            conn.execute(&format!("INSERT INTO {table}(workspace_id,version_id,parser_generation) VALUES('ws','main',1)"), []).unwrap();
        }
        let query = |table| {
            format!("SELECT seed_phase FROM {table} WHERE workspace_id=?1 AND version_id=?2")
        };
        let plan: String = conn
            .query_row(
                &format!("EXPLAIN QUERY PLAN {}", query("guard_after")),
                ["ws", "main"],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("USING PRIMARY KEY"), "{plan}");
        let mut before = conn.prepare(&query("guard_before")).unwrap();
        let mut after = conn.prepare(&query("guard_after")).unwrap();
        let mut before_ns = Vec::new();
        let mut after_ns = Vec::new();
        let mut phase = crate::capture_phase::Phase::new("trigger_guard_comparison", None, 0, true);
        // Same prepared lookup as the trigger, including SQL dispatch. Alternate
        // the two layouts; these timings are diagnostic, never a gate limit.
        for trial in 0..6 {
            for is_after in if trial % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                let statement = if is_after { &mut after } else { &mut before };
                let label = if is_after {
                    "guard_without_rowid"
                } else {
                    "guard_rowid"
                };
                let measure = crate::capture_phase::Measure::new(label);
                let started = std::time::Instant::now();
                for _ in 0..15_000 {
                    let value: String = statement.query_row(["ws", "main"], |r| r.get(0)).unwrap();
                    assert_eq!(value, "deferred");
                }
                let elapsed = (started.elapsed().as_nanos() / 15_000) as u64;
                drop(measure);
                crate::capture_phase::count(label, 15_000);
                if is_after {
                    after_ns.push(elapsed);
                } else {
                    before_ns.push(elapsed);
                }
            }
        }
        before_ns.sort();
        after_ns.sort();
        phase.field("before_rowid_ns_per_lookup", before_ns[3]);
        phase.field("after_without_rowid_ns_per_lookup", after_ns[3]);
        phase.field("lookups_per_trial", 15_000_u64);
        phase.finish("measured");
        eprintln!(
            "TRIGGER_GUARD before_ns={} after_ns={} lookups_per_trial=15000 trials=6; SQL dispatch included",
            before_ns[3], after_ns[3]
        );
    }

    fn tempdir() -> dohc_test_scratch::ScratchDir {
        dohc_test_scratch::ScratchDir::new_named("r04-mig").expect("mkdir")
    }

    /// A store with documents `a` and `b`, each with an activation, whose
    /// writes skip the schema's checks. `a`'s outbox entry names native
    /// sequence 5, its delivery `delivery-a`, and terminal blob `refused`.
    fn released_tail_store(dir: &dohc_test_scratch::ScratchDir) -> Connection {
        let path = dir.join("engine.db");
        drop(crate::EngineStore::open(&path, 0).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&format!(
            "PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON;
             INSERT INTO ydoc_docs(workspace_id,version_id,object_id,updated_at_ms) VALUES ('ws','main','a',0),('ws','main','b',0);
             {activation_a}; {activation_b};
             INSERT INTO owner_ydoc_outboxes(outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,
               selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,
               pending_bytes,next_sequence,created_at_ms)
             VALUES ('outbox-a','ws','main','a','lineage','a.md','[]',0,'base','base',1,'active',0,2,0),
                    ('outbox-b','ws','main','b','lineage','b.md','[]',0,'base','base',1,'active',0,1,0);
             {entry}",
            activation_a = released_tail_activation("activation", "a", "lineage", None),
            activation_b = released_tail_activation("activation-b", "b", "lineage", None),
            entry = released_tail_entry(1, "delivery-a", 5),
        ))
        .unwrap();
        conn
    }

    fn released_tail_activation(
        id: &str,
        object: &str,
        lineage: &str,
        predecessor: Option<&str>,
    ) -> String {
        format!(
            "INSERT INTO live_owner_activations VALUES ('relay','{id}','ws','main','{object}','{lineage}','{id}',{},
               '{{}}','source','source',0,1,0,'{{}}','evidence','coverage',0,0,0,'null',1000000,60000,
               NULL,NULL,NULL,NULL,NULL,NULL)",
            predecessor.map_or("NULL".to_owned(), |id| format!("'{id}'"))
        )
    }

    fn released_tail_entry(sequence: i64, delivery: &str, native_sequence: i64) -> String {
        format!(
            "INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,
               native_source_json,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,
               result_state,terminal_blob_digest,terminal_reason)
             VALUES ('outbox-a',{sequence},'key-{sequence}','{delivery}','refused',
               json_object('binding',json_object('objectId','a'),'nativeSequence',{native_sequence}),1,0,0,1,0,
               'active','refused','refused')"
        )
    }

    fn released_tail_application(table: &str, delivery: &str, object: &str, cursor: i64) -> String {
        match table {
            "live_device_update_applications" => format!(
                "INSERT INTO live_device_update_applications (relay_database_namespace,workspace_id,delivery_id,
                   main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,
                   update_digest,update_byte_length,journal_cursor,accepting_host_epoch,principal_kind,principal_id,
                   received_at_ms,first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch,
                   applied_instance_id,applied_connection_id)
                 VALUES ('relay','ws','{delivery}','main','{object}','lineage','a.md','[]',0,'update',1,{cursor},1,
                   'owner','owner',0,0,1,'host',1,'instance','connection')"
            ),
            _ => format!(
                "INSERT INTO live_accepted_updates VALUES ('relay','ws','main','{object}','lineage',{cursor},{cursor},
                   '{delivery}','{{}}','update',1,1,'evidence')"
            ),
        }
    }

    fn released_tail_generation(conn: &Connection, object: &str) -> Option<i64> {
        use rusqlite::OptionalExtension;
        conn.query_row(
            "SELECT generation FROM released_tail_generations WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
            [object],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    /// Sol's tails-cache ruling: each of the nine tables a document's
    /// released tails read moves its generation, old and new rows alike. A
    /// delivery moves the document whose entry holds it, whatever document
    /// its row claims; an activation moves the document of every activation
    /// whose chain passes through it. So does the state a held document's
    /// inspection loads that its coordinates do not name (Sol's r2c-3c-1
    /// finding 1), including a latest snapshot removed after it folded rows,
    /// an archive rebound, and a missing blob restored (Sol's r2c-3c-3
    /// findings 1 and 2, Opus's finding 1). A blob nothing names, a folded
    /// journal row no entry names, an append, a superseded snapshot pruned,
    /// and a document column neither reads move nothing. The generation
    /// outlives its document.
    #[test]
    fn every_released_tail_input_moves_its_documents_generation() {
        let dir = tempdir();
        let conn = released_tail_store(&dir);
        assert_eq!(
            released_tail_generation(&conn, "c"),
            None,
            "no activation, no generation"
        );
        let step = |sql: &str, moved: &[&str]| {
            let objects = ["a", "b", "c"];
            let before = objects.map(|object| released_tail_generation(&conn, object));
            conn.execute_batch(sql).unwrap();
            for (object, before) in objects.into_iter().zip(before) {
                let after = released_tail_generation(&conn, object);
                if moved.contains(&object) {
                    assert!(after > before, "{sql} moves {object}");
                } else {
                    assert_eq!(after, before, "{sql} keeps {object}");
                }
            }
        };
        step(
            "UPDATE live_owner_activations SET source_byte_length=1 WHERE activation_id='activation'",
            &["a"],
        );
        step(
            &released_tail_activation("follower", "b", "follower", Some("activation")),
            &["b"],
        );
        // Past the store's checks, a chain can pass through other documents:
        // `c`'s runs through `b`'s activation to `a`'s.
        step(
            &released_tail_activation("third", "c", "third", Some("follower")),
            &["c"],
        );
        step(
            "UPDATE live_owner_activations SET binding_json='[]' WHERE activation_id='activation'",
            &["a", "b", "c"],
        );
        step(
            "DELETE FROM live_owner_activations WHERE activation_id='follower'",
            &["b", "c"],
        );
        step(
            "UPDATE owner_ydoc_outboxes SET created_at_ms=1 WHERE outbox_id='outbox-a'",
            &["a"],
        );
        step(
            "UPDATE owner_ydoc_outboxes SET object_id='b' WHERE outbox_id='outbox-a'",
            &["a", "b"],
        );
        step(
            "UPDATE owner_ydoc_outboxes SET object_id='a' WHERE outbox_id='outbox-a'",
            &["a", "b"],
        );
        step(&released_tail_entry(2, "delivery-2", 6), &["a"]);
        step(
            "UPDATE owner_ydoc_outbox_entries SET created_at_ms=1 WHERE sequence=2",
            &["a"],
        );
        step(
            "UPDATE owner_ydoc_outbox_entries SET outbox_id='outbox-b' WHERE sequence=2",
            &["a", "b"],
        );
        step(
            "DELETE FROM owner_ydoc_outbox_entries WHERE sequence=2",
            &["b"],
        );
        for table in ["live_device_update_applications", "live_accepted_updates"] {
            step(
                &released_tail_application(table, "delivery-a", "b", 1),
                &["a", "b"],
            );
            step(&released_tail_application(table, "unheld", "b", 2), &["b"]);
            step(
                &format!("UPDATE {table} SET delivery_id='moved' WHERE delivery_id='delivery-a'"),
                &["a", "b"],
            );
            step(
                &format!("UPDATE {table} SET delivery_id='delivery-a' WHERE delivery_id='moved'"),
                &["a", "b"],
            );
            step(
                &format!("DELETE FROM {table} WHERE delivery_id='delivery-a'"),
                &["a", "b"],
            );
            step(
                &format!("DELETE FROM {table} WHERE delivery_id='unheld'"),
                &["b"],
            );
        }
        step(
            "INSERT INTO ydoc_owner_activation_sources VALUES ('seed','relay','ws','main','a','lineage','moment','source','state','{}')",
            &["a"],
        );
        step(
            "UPDATE ydoc_owner_activation_sources SET full_state_digest='other'",
            &["a"],
        );
        step(
            "UPDATE ydoc_owner_activation_sources SET object_id='b'",
            &["a", "b"],
        );
        step("DELETE FROM ydoc_owner_activation_sources", &["b"]);
        let journal = |seq: i64| {
            format!(
                "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) VALUES ('ws','main','a',{seq},'update',0)"
            )
        };
        let snapshot = |seq: i64| {
            format!(
                "INSERT INTO ydoc_snapshots VALUES ('ws','main','a',{seq},'snapshot','vector',0)"
            )
        };
        // Rows up to `a`'s latest snapshot, 4, are folded: inspection never
        // loads them.
        step(&snapshot(4), &[]);
        step(&journal(4), &[]);
        step(&journal(5), &["a"]);
        step("UPDATE ydoc_updates SET recorded_at_ms=1 WHERE seq=4", &[]);
        step("UPDATE ydoc_updates SET seq=7 WHERE seq=5", &["a"]);
        step("UPDATE ydoc_updates SET seq=5 WHERE seq=7", &["a"]);
        step("DELETE FROM ydoc_updates WHERE seq=4", &[]);
        step("DELETE FROM ydoc_updates WHERE seq=5", &["a"]);
        // The rows past it, which inspection loads the head from, move `a`
        // however they change, unless appended at the top, which the head's
        // coordinates name; so do the bytes of any blob a journal row, a
        // snapshot or an archive names. A compaction's own snapshot, and
        // pruning the rows it folded, move nothing.
        step(&journal(8), &[]);
        step(&journal(9), &[]);
        step(&journal(10), &[]);
        step("DELETE FROM ydoc_updates WHERE seq=9", &["a"]);
        step(&journal(9), &["a"]);
        step(
            "UPDATE ydoc_updates SET update_blob_sha256='other' WHERE seq=9",
            &["a"],
        );
        step("UPDATE ydoc_updates SET recorded_at_ms=2 WHERE seq=9", &[]);
        step(&snapshot(9), &[]);
        step(
            "DELETE FROM ydoc_updates WHERE object_id='a' AND seq<=9",
            &[],
        );
        // Removing the latest snapshot once it folded rows moves `a`, so the
        // folded rows cannot change unseen and the snapshot come back; so
        // does moving it back or changing its digest. Pruning a snapshot a
        // later one supersedes, or a compaction rewriting the latest as it
        // was, moves nothing.
        step(
            "DELETE FROM ydoc_snapshots WHERE object_id='a' AND up_to_seq=9",
            &["a"],
        );
        step(&snapshot(9), &[]);
        step(
            "DELETE FROM ydoc_snapshots WHERE object_id='a' AND up_to_seq>0 AND up_to_seq<9",
            &[],
        );
        step(
            "INSERT INTO ydoc_snapshots VALUES ('ws','main','a',9,'snapshot','vector',1)
             ON CONFLICT(workspace_id,version_id,object_id,up_to_seq) DO UPDATE SET
               snapshot_blob_sha256=excluded.snapshot_blob_sha256,recorded_at_ms=excluded.recorded_at_ms",
            &[],
        );
        step(
            "UPDATE ydoc_snapshots SET up_to_seq=8 WHERE object_id='a' AND up_to_seq=9",
            &["a"],
        );
        step(
            "UPDATE ydoc_snapshots SET up_to_seq=9 WHERE object_id='a' AND up_to_seq=8",
            &["a"],
        );
        step(
            "UPDATE ydoc_snapshots SET snapshot_blob_sha256='other' WHERE object_id='a'",
            &["a"],
        );
        step(
            "UPDATE ydoc_snapshots SET snapshot_blob_sha256='snapshot' WHERE object_id='a'",
            &["a"],
        );
        step(
            "UPDATE ydoc_snapshots SET object_id='b' WHERE object_id='a'",
            &["a", "b"],
        );
        step(
            "UPDATE ydoc_snapshots SET object_id='a' WHERE object_id='b'",
            &["a", "b"],
        );
        // A blob a journal row or snapshot names, missing from a damaged
        // store, moves its document once restored.
        step("INSERT INTO binary_blobs VALUES ('update',1,X'00')", &["a"]);
        step(
            "INSERT INTO binary_blobs VALUES ('snapshot',1,X'00')",
            &["a"],
        );
        step("INSERT INTO binary_blobs VALUES ('archive',1,X'00')", &[]);
        step(
            "UPDATE binary_blobs SET bytes=X'01' WHERE sha256='update'",
            &["a"],
        );
        step(
            "UPDATE binary_blobs SET bytes=X'01' WHERE sha256='snapshot'",
            &["a"],
        );
        let archive = "INSERT INTO ydoc_inactive_lineages(workspace_id,version_id,object_id,lineage_claim_id,
               disposition,content_kind,full_state_blob_sha256,state_vector_blob_sha256,recorded_at_ms,updated_at_ms)
             VALUES ('ws','main','b','archived','superseded-predecessor','richdoc','archive','vector',0,0)";
        step(archive, &[]);
        step(
            "UPDATE binary_blobs SET byte_length=2 WHERE sha256='archive'",
            &["b"],
        );
        // An archive moves its document as it goes or its key or digest
        // changes, so neither can change and change back unseen; its kind
        // and bookkeeping, which the proof compares or never reads, move
        // nothing. Its blob restored moves it too.
        step(
            "UPDATE ydoc_inactive_lineages SET full_state_blob_sha256='other' WHERE lineage_claim_id='archived'",
            &["b"],
        );
        step(
            "UPDATE ydoc_inactive_lineages SET full_state_blob_sha256='archive' WHERE lineage_claim_id='archived'",
            &["b"],
        );
        step(
            "UPDATE ydoc_inactive_lineages SET content_kind='plaintext',updated_at_ms=1 WHERE lineage_claim_id='archived'",
            &[],
        );
        step(
            "UPDATE ydoc_inactive_lineages SET object_id='a' WHERE lineage_claim_id='archived'",
            &["a", "b"],
        );
        step(
            "UPDATE ydoc_inactive_lineages SET object_id='b' WHERE lineage_claim_id='archived'",
            &["a", "b"],
        );
        step(
            "DELETE FROM ydoc_inactive_lineages WHERE lineage_claim_id='archived'",
            &["b"],
        );
        step(archive, &[]);
        conn.execute_batch("DELETE FROM binary_blobs WHERE sha256='archive'")
            .unwrap();
        step(
            "INSERT INTO binary_blobs VALUES ('archive',1,X'00')",
            &["b"],
        );
        step("DELETE FROM ydoc_updates WHERE seq=10", &["a"]);
        step(
            "UPDATE ydoc_docs SET head_update_seq=9,updated_at_ms=1,path='a.md' WHERE object_id='a'",
            &[],
        );
        step(
            "UPDATE ydoc_docs SET head_snapshot_seq=head_snapshot_seq WHERE object_id='a'",
            &[],
        );
        // A compaction moves the generation only past a sequence an entry
        // names, here 5, whichever way its bound goes.
        step(
            "UPDATE ydoc_docs SET head_snapshot_seq=4 WHERE object_id='a'",
            &[],
        );
        step(
            "UPDATE ydoc_docs SET head_snapshot_seq=5 WHERE object_id='a'",
            &["a"],
        );
        step(
            "UPDATE ydoc_docs SET head_snapshot_seq=9 WHERE object_id='a'",
            &[],
        );
        step(
            "UPDATE ydoc_docs SET head_snapshot_seq=3 WHERE object_id='a'",
            &["a"],
        );
        step(
            "UPDATE ydoc_docs SET lineage_claim_status='exact',lineage_claim_id='lineage' WHERE object_id='a'",
            &["a"],
        );
        let retired = released_tail_generation(&conn, "a").unwrap();
        step("DELETE FROM ydoc_docs WHERE object_id='a'", &["a"]);
        step(
            "INSERT INTO ydoc_docs(workspace_id,version_id,object_id,updated_at_ms) VALUES ('ws','main','a',0)",
            &["a"],
        );
        assert!(
            released_tail_generation(&conn, "a").unwrap() > retired + 1,
            "kept across retirement and recreation"
        );
        step("INSERT INTO binary_blobs VALUES ('unrelated',1,X'00')", &[]);
        step(
            "UPDATE binary_blobs SET bytes=X'01' WHERE sha256='unrelated'",
            &[],
        );
        step(
            "INSERT INTO binary_blobs VALUES ('refused',1,X'00')",
            &["a"],
        );
        step(
            "UPDATE binary_blobs SET bytes=X'0102' WHERE sha256='refused'",
            &["a"],
        );
        step(
            "UPDATE binary_blobs SET byte_length=2 WHERE sha256='refused'",
            &["a"],
        );
        step("DELETE FROM binary_blobs WHERE sha256='refused'", &["a"]);
        step("DELETE FROM binary_blobs WHERE sha256='unrelated'", &[]);
        // The bytes an entry's update names, which a held document's
        // inspection merges, move that entry's document as a terminal blob
        // does: arriving, changing and going.
        step(
            "INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,
               byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state)
             VALUES ('outbox-b',3,'key-b-3','delivery-b','merged',1,0,0,1,0,'active')",
            &["b"],
        );
        step("INSERT INTO binary_blobs VALUES ('merged',1,X'00')", &["b"]);
        step(
            "UPDATE binary_blobs SET bytes=X'01' WHERE sha256='merged'",
            &["b"],
        );
        step("DELETE FROM binary_blobs WHERE sha256='merged'", &["b"]);
    }

    fn released_hold_revision(conn: &Connection, object: &str) -> Option<i64> {
        use rusqlite::OptionalExtension;
        conn.query_row(
            "SELECT revision FROM released_hold_revisions WHERE workspace_id='ws' AND object_id=?1",
            [object],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    /// Sol's r2c-3c-7 ruling on their and Opus's r2c-3c-5 finding 1: a hold's
    /// binding advances its document's hold revision as it is set, changes,
    /// moves to another document and back, goes and comes back, so two
    /// writes cannot change it and restore its digest unseen. Its digest
    /// alone, the binding rewritten as it was, the hold's other columns, and
    /// a document with no binding arriving or going advance nothing. No hold
    /// write moves a released tail generation. A revision only advances,
    /// within its bound, and outlives its hold.
    #[test]
    fn every_change_to_a_holds_binding_advances_its_revision() {
        let dir = tempdir();
        let conn = released_tail_store(&dir);
        conn.execute_batch("INSERT INTO versioned_workspaces VALUES ('ws','main')")
            .unwrap();
        let objects = ["a", "b"];
        let generations = objects.map(|object| released_tail_generation(&conn, object));
        let step = |sql: &str, advanced: &[&str]| {
            let before = objects.map(|object| released_hold_revision(&conn, object));
            conn.execute_batch(sql).unwrap();
            for (object, before) in objects.into_iter().zip(before) {
                let after = released_hold_revision(&conn, object);
                if advanced.contains(&object) {
                    assert!(after > before, "{sql} advances {object}");
                } else {
                    assert_eq!(after, before, "{sql} keeps {object}");
                }
            }
            assert_eq!(
                objects.map(|object| released_tail_generation(&conn, object)),
                generations,
                "{sql} moves no generation"
            );
        };
        step(
            "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
             VALUES ('ws','a','a.md','ready',0)",
            &[],
        );
        let digest = |n: u8| char::from(b'0' + n).to_string().repeat(64);
        let bind = |json: &str, digest: &str| {
            format!(
                "UPDATE hosted_documents SET state='held',held_reason='released-lineage-unsettled',
                   released_hold_continuation='frozen',released_hold_binding_json='{json}',
                   released_hold_binding_digest='{digest}' WHERE object_id='a'"
            )
        };
        step(&bind("[1]", &digest(1)), &["a"]);
        step(&bind("[2]", &digest(2)), &["a"]);
        step(&bind("[3]", &digest(1)), &["a"]);
        step(&bind("[3]", &digest(2)), &[]);
        step(
            "UPDATE hosted_documents SET released_hold_binding_json=released_hold_binding_json,
               released_hold_binding_stale=1,path='moved.md',scope_generation=1 WHERE object_id='a'",
            &[],
        );
        step(
            "UPDATE hosted_documents SET object_id='b' WHERE object_id='a'",
            &["a", "b"],
        );
        step(
            "UPDATE hosted_documents SET object_id='a' WHERE object_id='b'",
            &["a", "b"],
        );
        conn.execute_batch(
            "CREATE TEMP TABLE kept_hold AS SELECT * FROM hosted_documents WHERE object_id='a'",
        )
        .unwrap();
        step("DELETE FROM hosted_documents WHERE object_id='a'", &["a"]);
        step(
            "INSERT INTO hosted_documents SELECT * FROM temp.kept_hold",
            &["a"],
        );
        step(
            "UPDATE hosted_documents SET state='ready',held_reason=NULL,released_hold_continuation=NULL,
               released_hold_binding_stale=0,released_hold_binding_json=NULL,released_hold_binding_digest=NULL
             WHERE object_id='a'",
            &["a"],
        );
        step(
            "INSERT INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
             VALUES ('ws','b','b.md','ready',0)",
            &[],
        );
        step("DELETE FROM hosted_documents", &[]);
        for reset in [
            "UPDATE released_hold_revisions SET revision=1 WHERE object_id='a'",
            "UPDATE released_hold_revisions SET revision=revision WHERE object_id='a'",
            "UPDATE released_hold_revisions SET object_id='c' WHERE object_id='a'",
            "DELETE FROM released_hold_revisions WHERE object_id='a'",
        ] {
            let before = released_hold_revision(&conn, "a");
            assert!(conn.execute_batch(reset).is_err(), "{reset}");
            assert_eq!(released_hold_revision(&conn, "a"), before, "{reset}");
        }
        conn.execute_batch(
            "UPDATE released_hold_revisions SET revision=9007199254740991 WHERE object_id='a'",
        )
        .unwrap();
        assert!(
            conn.execute_batch("INSERT INTO hosted_documents SELECT * FROM temp.kept_hold")
                .is_err(),
            "a hold whose revision is at its bound cannot arrive"
        );
        let held: i64 = conn
            .query_row("SELECT COUNT(*) FROM hosted_documents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(held, 0);
    }

    /// A generation at its bound fails the mutation that would move it, even
    /// one whose conflict policy ignores failures, and the mutation leaves
    /// nothing. A generation never goes back, and never goes away.
    #[test]
    fn a_released_tail_generation_at_its_bound_fails_the_mutation() {
        let dir = tempdir();
        let unchecked = released_tail_store(&dir);
        unchecked
            .execute_batch("UPDATE released_tail_generations SET generation=9007199254740991 WHERE object_id='a'")
            .unwrap();
        drop(unchecked);
        let conn = Connection::open(dir.join("engine.db")).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        let moved = conn.execute(
            "UPDATE owner_ydoc_outboxes SET created_at_ms=7 WHERE outbox_id='outbox-a'",
            [],
        );
        assert!(moved.is_err(), "{moved:?}");
        let kept: i64 = conn
            .query_row(
                "SELECT created_at_ms FROM owner_ydoc_outboxes WHERE outbox_id='outbox-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, 0);
        let ignored = conn.execute(
            "INSERT OR IGNORE INTO binary_blobs VALUES ('refused',1,X'00')",
            [],
        );
        assert!(ignored.is_err(), "{ignored:?}");
        let blobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM binary_blobs WHERE sha256='refused'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(blobs, 0);
        assert_eq!(
            released_tail_generation(&conn, "a"),
            Some(9_007_199_254_740_991)
        );
        for reset in [
            "UPDATE released_tail_generations SET generation=1 WHERE object_id='b'",
            "UPDATE released_tail_generations SET generation=generation WHERE object_id='b'",
            "UPDATE released_tail_generations SET object_id='c' WHERE object_id='b'",
            "DELETE FROM released_tail_generations WHERE object_id='b'",
        ] {
            let before = released_tail_generation(&conn, "b");
            assert!(conn.execute_batch(reset).is_err(), "{reset}");
            assert_eq!(released_tail_generation(&conn, "b"), before, "{reset}");
        }
    }

    /// Sol's tails-cache ruling: a trigger finds what it moves by index, so
    /// its work stays the same however long a lineage's history grows.
    #[test]
    fn released_tail_triggers_never_scan_retained_history() {
        let dir = tempdir();
        let conn = released_tail_store(&dir);
        let steps = |sql: &str| vm_steps(&conn, sql);
        let journal = |seq: i64| {
            format!(
                "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms)
                 VALUES ('ws','main','a',{seq},'update',0)"
            )
        };
        // Each write once over one entry, then over 20,000: an unrelated
        // blob, a journal row no entry names and one an entry names, an
        // application of a held delivery, an entry's own change, an
        // activation's, a seed capture's and a compaction's.
        let writes = |sequence: i64| {
            [
                "UPDATE ydoc_docs SET head_snapshot_seq=head_snapshot_seq+1 WHERE object_id='a'".to_owned(),
                format!("UPDATE live_owner_activations SET source_byte_length={sequence} WHERE activation_id='activation'"),
                format!(
                    "INSERT INTO ydoc_owner_activation_sources VALUES
                       ('seed-{sequence}','relay','ws','main','a','lineage','moment','source','state','{{}}')"
                ),
                format!("INSERT INTO binary_blobs VALUES ('unrelated-{sequence}',1,X'00')"),
                journal(1_000_000 + sequence),
                journal(if sequence == 1 { 5 } else { sequence }),
                released_tail_application(
                    "live_device_update_applications",
                    &format!("delivery-{}", if sequence == 1 { "a" } else { "held" }),
                    "b",
                    sequence,
                ),
                format!("UPDATE owner_ydoc_outbox_entries SET created_at_ms=1 WHERE outbox_id='outbox-a' AND sequence={sequence}"),
            ]
        };
        let short = writes(1).map(|write| steps(&write));
        conn.execute_batch("BEGIN").unwrap();
        for sequence in 2..20_002 {
            let delivery = if sequence == 10_000 {
                "delivery-held".to_owned()
            } else {
                format!("delivery-{sequence}")
            };
            conn.execute_batch(&released_tail_entry(sequence, &delivery, sequence))
                .unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
        let long = writes(10_000).map(|write| steps(&write));
        for ((write, short), long) in writes(10_000).iter().zip(short).zip(long) {
            assert!(
                long < short + 100,
                "{write}: {short} steps over one entry, {long} over 20,000"
            );
        }
    }

    /// How many virtual machine steps `sql` takes on `conn`, its triggers'
    /// included.
    fn vm_steps(conn: &Connection, sql: &str) -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        let counted = std::sync::Arc::new(AtomicU64::new(0));
        let counter = std::sync::Arc::clone(&counted);
        conn.progress_handler(
            1,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        conn.execute_batch(sql).unwrap();
        conn.progress_handler(0, None::<fn() -> bool>).unwrap();
        counted.load(Ordering::Relaxed)
    }

    /// What `EXPLAIN QUERY PLAN` details of `sql`, with `?1` and `?2` bound.
    fn query_plan(conn: &Connection, sql: &str) -> Vec<String> {
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let bound = statement.parameter_count();
        let params = ["digest", "other"];
        statement
            .query_map(rusqlite::params_from_iter(&params[..bound]), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    /// Opus's r2c-3c-1 finding 5 and r2c-3c-3 finding 2: a trigger that
    /// matches moves its documents by the generations' key. Over 20,000
    /// documents with generations, entries naming blobs, journal rows past
    /// the latest snapshot, and snapshots and archives naming blobs of their
    /// own, every installed trigger that matches takes as many steps as over
    /// one: a blob one entry names arriving and going, the bytes of a blob a
    /// journal row, a snapshot or an archive names changing, an inner journal
    /// row going, coming back and changing its digest, a missing blob it
    /// names arriving, a snapshot changing its digest, the latest snapshot
    /// going, and an archive changing its digest and going. Every statement
    /// those triggers run searches by index, never scans.
    #[test]
    fn released_tail_triggers_that_match_move_by_key() {
        let dir = tempdir();
        let conn = released_tail_store(&dir);
        let grow = |from: i64, to: i64| {
            conn.execute_batch("BEGIN").unwrap();
            for n in from..to {
                conn.execute_batch(&format!(
                    "INSERT INTO released_tail_generations VALUES ('ws','main','doc-{n}',1);
                     INSERT INTO owner_ydoc_outbox_entries(outbox_id,sequence,append_key,delivery_id,update_digest,
                       byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state)
                     VALUES ('outbox-b',{n},'key-b-{n}','delivery-b-{n}','merged-{n}',1,0,0,1,0,'active');
                     INSERT INTO binary_blobs VALUES ('journal-{n}',1,X'00');
                     INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms)
                       VALUES ('ws','main','a',{n},'journal-{n}',0);
                     INSERT INTO binary_blobs VALUES ('snapshot-{n}',1,X'00');
                     INSERT INTO ydoc_snapshots VALUES ('ws','main','b',{n},'snapshot-{n}','vector',0);
                     INSERT INTO binary_blobs VALUES ('archive-{n}',1,X'00');
                     INSERT INTO ydoc_inactive_lineages(workspace_id,version_id,object_id,lineage_claim_id,
                       disposition,content_kind,full_state_blob_sha256,state_vector_blob_sha256,recorded_at_ms,
                       updated_at_ms)
                     VALUES ('ws','main','b','archived-{n}','superseded-predecessor','richdoc','archive-{n}',
                       'vector',0,0)"
                ))
                .unwrap();
            }
            conn.execute_batch("COMMIT").unwrap();
        };
        // Row `n` has a row past it, so it is inner. `b`'s latest snapshot
        // is the last one grown.
        let writes = |n: i64| {
            let row =
                format!("workspace_id='ws' AND version_id='main' AND object_id='a' AND seq={n}");
            let b = "workspace_id='ws' AND version_id='main' AND object_id='b'";
            [
                format!("INSERT INTO binary_blobs VALUES ('merged-{n}',1,X'00')"),
                format!("DELETE FROM binary_blobs WHERE sha256='merged-{n}'"),
                format!("UPDATE binary_blobs SET bytes=X'01' WHERE sha256='journal-{n}'"),
                format!("DELETE FROM ydoc_updates WHERE {row}"),
                format!(
                    "INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms)
                     VALUES ('ws','main','a',{n},'journal-{n}',0)"
                ),
                format!("UPDATE binary_blobs SET bytes=X'01' WHERE sha256='snapshot-{n}'"),
                format!("UPDATE binary_blobs SET bytes=X'01' WHERE sha256='archive-{n}'"),
                format!("UPDATE ydoc_updates SET update_blob_sha256='missing-{n}' WHERE {row}"),
                format!("INSERT INTO binary_blobs VALUES ('missing-{n}',1,X'00')"),
                format!("UPDATE ydoc_snapshots SET snapshot_blob_sha256='missing-{n}' WHERE {b} AND up_to_seq={n}"),
                format!(
                    "DELETE FROM ydoc_snapshots WHERE {b} AND up_to_seq=
                       (SELECT max(up_to_seq) FROM ydoc_snapshots WHERE {b})"
                ),
                format!(
                    "UPDATE ydoc_inactive_lineages SET full_state_blob_sha256='missing-{n}'
                     WHERE {b} AND lineage_claim_id='archived-{n}'"
                ),
                format!("DELETE FROM ydoc_inactive_lineages WHERE {b} AND lineage_claim_id='archived-{n}'"),
            ]
        };
        let moved = || {
            released_tail_generation(&conn, "a").unwrap()
                + released_tail_generation(&conn, "b").unwrap()
        };
        grow(1, 3);
        let short = writes(1).map(|write| {
            let before = moved();
            let steps = vm_steps(&conn, &write);
            assert!(moved() > before, "{write} matches");
            steps
        });
        grow(3, 20_002);
        let long = writes(10_000).map(|write| vm_steps(&conn, &write));
        for ((write, short), long) in writes(10_000).iter().zip(short).zip(long) {
            assert!(
                long < short + 100,
                "{write}: {short} steps over one, {long} over 20,000"
            );
        }

        // One statement for each source of a blob's documents: SQLite scans
        // the generations for a key `IN` a union of them.
        let generations = "UPDATE released_tail_generations SET generation=generation+1 \
            WHERE (workspace_id,version_id,object_id) IN";
        let outbox = "SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e \
            JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE";
        let mut sources = Vec::new();
        for digest in ["=?1", " IN (?1,?2)"] {
            sources.extend([
                format!("{outbox} e.terminal_blob_digest{digest}"),
                format!("{outbox} e.update_digest{digest}"),
                format!("SELECT workspace_id,version_id,object_id FROM ydoc_updates WHERE update_blob_sha256{digest}"),
                format!(
                    "SELECT workspace_id,version_id,object_id FROM ydoc_snapshots WHERE snapshot_blob_sha256{digest}"
                ),
                format!(
                    "SELECT workspace_id,version_id,object_id FROM ydoc_inactive_lineages \
                     WHERE full_state_blob_sha256{digest}"
                ),
            ]);
        }
        for sql in sources
            .iter()
            .map(|source| format!("{generations} ({source})"))
        {
            let plan = query_plan(&conn, &sql);
            assert!(
                plan.iter()
                    .any(|detail| detail.starts_with("SEARCH released_tail_generations")),
                "{sql}: {plan:#?}"
            );
            assert!(
                !plan.iter().any(|detail| detail.starts_with("SCAN")),
                "{sql}: {plan:#?}"
            );
        }
        // The activation triggers' walk over successors, from an inserted or
        // deleted activation, or from an updated one's old and new rows: it
        // scans only its own queue, and searches activations by the
        // successor index.
        let followers = |seeds: &str| {
            format!(
                "{generations} (WITH RECURSIVE followers(namespace,activation_id) AS ({seeds} \
                 UNION SELECT a.relay_database_namespace,a.activation_id FROM live_owner_activations a \
                   JOIN followers f ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id) \
                 SELECT a.workspace_id,a.main_version_id,a.object_id FROM live_owner_activations a \
                   JOIN followers f ON a.relay_database_namespace=f.namespace AND a.predecessor_activation_id=f.activation_id)"
            )
        };
        for sql in [
            followers("SELECT ?1,?2"),
            followers("SELECT ?1,?2 UNION SELECT ?2,?1"),
        ] {
            let plan = query_plan(&conn, &sql);
            assert!(
                plan.iter()
                    .any(|detail| detail.starts_with("SEARCH released_tail_generations")),
                "{sql}: {plan:#?}"
            );
            assert_eq!(
                plan.iter()
                    .filter(|detail| detail
                        .starts_with("SEARCH a USING INDEX live_owner_activations_successor"))
                    .count(),
                2,
                "{sql}: {plan:#?}"
            );
            assert!(
                !plan.iter().any(|detail| detail.starts_with("SCAN")
                    && !detail.starts_with("SCAN f")
                    && !detail.starts_with("SCAN CONSTANT ROW")),
                "{sql}: {plan:#?}"
            );
        }
        for gate in [
            "SELECT 1 FROM owner_ydoc_outbox_entries WHERE update_digest=?1",
            "SELECT 1 FROM owner_ydoc_outbox_entries WHERE terminal_blob_digest=?1",
            "SELECT 1 FROM ydoc_updates WHERE update_blob_sha256 IN (?1,?2)",
            "SELECT 1 FROM ydoc_snapshots WHERE snapshot_blob_sha256 IN (?1,?2)",
            "SELECT 1 FROM ydoc_inactive_lineages WHERE full_state_blob_sha256 IN (?1,?2)",
            "SELECT 1 FROM ydoc_updates WHERE update_blob_sha256=?1",
            "SELECT 1 FROM ydoc_snapshots WHERE snapshot_blob_sha256=?1",
            "SELECT 1 FROM ydoc_inactive_lineages WHERE full_state_blob_sha256=?1",
            "SELECT 1 FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id='a' AND seq>5",
            "SELECT max(up_to_seq) FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id='a'",
        ] {
            let plan = query_plan(&conn, gate);
            assert!(
                !plan.iter().any(|detail| detail.starts_with("SCAN")),
                "{gate}: {plan:#?}"
            );
        }
    }
}
