//! The ordered, idempotent, crash-recoverable migration ledger and runner.
//!
//! [`BASELINE_MIGRATIONS`] is the frozen list. The baseline (ordinal 0)
//! assembles the whole schema and stamps `user_version = 2`. A later schema
//! change appends a new migration with the next ordinal and flows through the
//! same runner.
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
#[derive(Debug, Clone, Copy)]
pub(crate) struct MigrationContext {
    pub engine_build: &'static str,
    pub protocol_version: i64,
    pub now_ms: i64,
}

impl MigrationContext {
    /// The production context for this build.
    pub fn current(now_ms: i64) -> Self {
        MigrationContext {
            engine_build: ENGINE_BUILD,
            protocol_version: ENGINE_STORAGE_PROTOCOL_VERSION,
            now_ms,
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

/// The frozen, ordered list of migrations this build knows.
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
        id: "v2-automation-record-lifecycle",
        sql: V2_AUTOMATION_RECORD_LIFECYCLE_DDL,
        sets_user_version: None,
    },
];

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
    #[cfg(feature = "fault-injection")]
    use crate::faults::FaultAction;
    use crate::faults::NoFaults;
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
                "v2-automation-record-lifecycle",
                "6415d033148cd23041a34cb07b6520e03718c6b0c9f6b4c1d13bd4d6612002ba",
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
            ordinal: BASELINE_MIGRATIONS.len() as u32,
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

    fn tempdir() -> dohc_test_scratch::ScratchDir {
        dohc_test_scratch::ScratchDir::new_named("r04-mig").expect("mkdir")
    }
}
