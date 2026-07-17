//! The ordered, idempotent, crash-recoverable migration ledger and runner
//! (`plan §Post-cutover migration ledger`, `TEST_ORACLE.md` §3.2 points 10/11).
//!
//! CAL-1 shipped an `engine_migrations` *skeleton* (id, checksum, applied_at)
//! and an eager one-shot `CREATE`. R04 promotes it to the real thing:
//!
//! - **The day-one v2 schema is one ordered migration.** [`BASELINE_MIGRATIONS`]
//!   is the frozen list; the baseline (ordinal 0) assembles every v2 table and
//!   stamps the `user_version = 2` fingerprint. Later schema changes append to
//!   this list and flow through the same runner — never an improvised
//!   `ALTER`/lazy-DDL dance (`plan §Day-one Rust schema`).
//! - **The ledger row records everything the plan asks for**: migration id +
//!   checksum (sha-256 of the DDL), engine build + storage/protocol version,
//!   started/completed timestamps, transactional-vs-not classification, and the
//!   integrity-check result.
//! - **The runner is ordered, idempotent, and crash-recoverable.** It walks the
//!   list in order; a migration whose completed ledger row matches this build's
//!   checksum is skipped; a completed row with a *different* checksum fails
//!   closed (tampered/incompatible ledger); a missing or incomplete row is
//!   applied. A transactional migration commits its body, its `user_version`
//!   stamp, its integrity result, and its ledger row in ONE transaction, so a
//!   crash mid-apply rolls back to the prior consistent state and restart
//!   re-runs from the ledger. A partially-applied migration recovers correctly
//!   on reopen — the point of the two named fault points.

use crate::error::StorageError;
use crate::faults::{FaultInjector, FaultPoint};
use crate::limits::{ENGINE_BUILD, ENGINE_SCHEMA_VERSION, ENGINE_STORAGE_PROTOCOL_VERSION};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

/// Whether a migration can run inside a single transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationKind {
    /// Body + ledger row commit atomically. A crash rolls the whole thing back;
    /// restart re-runs from scratch. The strongest guarantee; the baseline and
    /// every ordinary DDL migration is this.
    Transactional,
    /// Cannot be wrapped in a transaction (e.g. a future `VACUUM`-class step).
    /// The runner records a *started* row, runs the (idempotent-by-contract)
    /// body, then records completion. A crash between leaves a started-but-
    /// incomplete row that restart re-runs idempotently.
    ///
    /// No shipped migration is non-transactional yet (the baseline is DDL); the
    /// apply path and its crash recovery are proven by `tests`. Kept as the
    /// forward contract later schema changes classify against.
    #[allow(
        dead_code,
        reason = "forward migration classification; apply path is test-covered"
    )]
    NonTransactional,
}

/// One ordered migration. `sql` is applied verbatim; `checksum` is derived from
/// it so a silently-edited migration is caught rather than skipped.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Migration {
    pub ordinal: u32,
    pub id: &'static str,
    pub kind: MigrationKind,
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

/// The `id` of the frozen v2 baseline migration. `validate_v2` requires this
/// ledger row as a cheap own-store fingerprint (a foreign db can fake table
/// names but not this row).
pub(crate) const BASELINE_MIGRATION_ID: &str = "v2-baseline";

/// The frozen day-one v2 schema, expressed as the baseline migration. Assembles
/// every v2 table (CAL-1 ledgers + documents + journal, CAL-2 versioning, R04
/// `binary_blobs` / `materialization_jobs` / `engine_ownership`) and stamps the
/// fingerprint. See `schema.rs` for the table-shape rationale carried over from
/// the calibration slices.
const V2_BASELINE_DDL: &str = "\
-- ===========================================================================
-- Migration ledger (promoted at R04). Append-only; one row per migration.
-- `completed_at`/`integrity_ok` are NULL for a started-but-unfinished
-- non-transactional migration and NON-NULL once complete. A crash-recoverable
-- runner reads this to resume exactly where it left off.
-- ===========================================================================
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

-- Engine ownership record (`plan §Day-one Rust schema`). A single guarded row
-- carrying an opaque engine UUID stamped at init: proves the store is ours and
-- gives backups/diagnostics a redaction-safe identity that is not a file path.
CREATE TABLE engine_ownership (
    rowid_guard   INTEGER NOT NULL PRIMARY KEY CHECK (rowid_guard = 1),
    engine_uuid   TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL,
    engine_build  TEXT    NOT NULL,
    schema_version INTEGER NOT NULL
) STRICT;

-- Request / idempotency ledger (CAL-1). Written in the SAME transaction as the
-- mutation it records, so a crash after commit but before ack replays to the
-- recorded result instead of re-executing (the exactly-once contract).
CREATE TABLE engine_requests (
    request_id   TEXT    NOT NULL PRIMARY KEY,
    payload_hash TEXT    NOT NULL,
    result_seq   INTEGER NOT NULL,
    committed_at INTEGER NOT NULL
) STRICT;

-- Minimal domain table exercised by the compound-write API (CAL-1).
CREATE TABLE documents (
    doc_id        TEXT    NOT NULL PRIMARY KEY,
    body          TEXT    NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;

-- Replication journal (CAL-1/CAL-2): appended in the same txn as the mutation.
CREATE TABLE replication_journal (
    seq           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    doc_id        TEXT    NOT NULL,
    op_kind       TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL
) STRICT;

-- CAL-2 versioning tables (see schema.rs for shape rationale).
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

-- Content-addressed TEXT blobs (sha256 -> bytes). Dedup by hash.
CREATE TABLE blobs (
    sha256      TEXT    NOT NULL PRIMARY KEY,
    byte_length INTEGER NOT NULL,
    text        TEXT    NOT NULL
) STRICT;

-- Content-addressed BINARY blobs (sha256 -> bytes). Dedup by hash; the binary
-- analog of `blobs`, filed under the sha-256 of the exact bytes. R04.
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

CREATE TABLE snapshots (
    workspace_id     TEXT    NOT NULL,
    version_id       TEXT    NOT NULL,
    object_id        TEXT    NOT NULL,
    path             TEXT    NOT NULL,
    blob_sha256      TEXT    NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    latest_moment_id TEXT    NOT NULL,
    metadata_origin  TEXT    NOT NULL,
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
    blob_sha256      TEXT    NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    latest_moment_id TEXT    NOT NULL,
    metadata_origin  TEXT    NOT NULL,
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
    after_blob_sha256 TEXT    NOT NULL,
    before_present    INTEGER NOT NULL,
    before_blob_sha256 TEXT,
    metadata_origin   TEXT    NOT NULL,
    author_json       TEXT,
    sync_record_only  INTEGER,
    PRIMARY KEY (workspace_id, moment_id),
    UNIQUE (workspace_id, moment_order),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (after_blob_sha256) REFERENCES blobs(sha256)
) STRICT;

CREATE INDEX idx_moments_workspace_order ON moments(workspace_id, moment_order DESC);
CREATE INDEX idx_moments_version_order ON moments(workspace_id, version_id, moment_order DESC);
CREATE INDEX idx_moments_object_order ON moments(workspace_id, object_id, moment_order DESC);

-- Durable materialization jobs (R04, `plan §Filesystem/database crash
-- boundary`). Committed in the SAME transaction as the canonical state they
-- materialize, so a crash never leaves disk intent without a job record. The
-- filesystem pipeline (`dohc-engine-files::materialize`) replays PENDING jobs
-- idempotently at startup and marks them COMPLETE (or CONFLICT for
-- preserve-both). Identity is carried by content hash + generation, never by a
-- torn on-disk file.
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
    FOREIGN KEY (content_sha256) REFERENCES binary_blobs(sha256)
) STRICT;

CREATE INDEX idx_materialization_jobs_status ON materialization_jobs(status);
";

/// Ordinal 1 (R08 secrets shard, appended via the migration-append capability
/// contract). Adds the three secret-backed-file tables — encrypted tips, fork
/// bases, and metadata-only history moments — whose logical shapes match the TS
/// engine's `secret_files` / `secret_fork_bases` / `secret_moments`
/// (`engineDbSchema.ts`). Only ciphertext + IV + tag (base64 TEXT) and byte
/// lengths are stored; plaintext never enters any column. `STRICT` + `INTEGER`
/// timestamps follow the R04 baseline convention (the TS `REAL` columns are an
/// engine-internal detail; cross-engine parity rides the AEAD ciphertext, not
/// the SQLite column affinity — see `LANGUAGE_SEMANTICS_MATRIX.md` §10.5).
const V1_SECRETS_DDL: &str = "\
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
    PRIMARY KEY (workspace_id, moment_id),
    UNIQUE (workspace_id, moment_order),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_secret_moments_version_order
    ON secret_moments(workspace_id, version_id, moment_order);
CREATE INDEX idx_secret_moments_path_order
    ON secret_moments(workspace_id, version_id, path, moment_order);
";

/// The `id` of the R08 secrets migration.
pub(crate) const SECRETS_MIGRATION_ID: &str = "v1-secrets";

/// Ordinal 2 (R11a Y.Doc durable cache, appended via the migration-append
/// capability contract). Adds the three durable-Y.Doc tables — the per-doc
/// marker with its head pointers, the content-addressed durable update log, and
/// the folded full-state snapshots — whose logical shapes match the TS engine's
/// `ydoc_docs` / `ydoc_updates` / `ydoc_snapshots` (`engineDbSchema.ts`
/// `ENGINE_YDOC_DDL`). Update and snapshot BYTES are content-addressed into the
/// existing `binary_blobs` table; these tables carry only the sha references and
/// the head pointers. `STRICT` + `INTEGER` timestamps follow the R04 baseline
/// convention (the TS `REAL` columns are an engine-internal detail; the CRDT
/// lineage rides the content-addressed blobs, not the SQLite column affinity —
/// same rationale R08 recorded for its `REAL`→`INTEGER` timestamps).
///
/// Two columns extend the TS logical shape and are recorded deltas: `regime`
/// distinguishes the local-only-prunable cache from the replicated never-prune
/// durable lineage (the TS driver carries this as a constructor flag, not a
/// column; making it a column makes each doc's regime durable and inspectable),
/// and `base_claimed` makes the base-once discipline a durable per-doc fact the
/// claim transaction re-checks (the TS driver derives it from lineage presence).
///
/// The marker's `FOREIGN KEY (workspace_id, object_id) → file_objects` keeps the
/// GC-root accounting the TS schema documents: a `binary_blob` referenced by a
/// live `ydoc_updates`/`ydoc_snapshots` row (reachable from a marker head) is a
/// GC root, and deleting the rich-doc file cascades every ydoc_* row away so its
/// blobs become collectable.
const V1_YDOC_DDL: &str = "\
CREATE TABLE ydoc_docs (
    workspace_id      TEXT    NOT NULL,
    version_id        TEXT    NOT NULL,
    object_id         TEXT    NOT NULL,
    -- CHECK-constrained so a corrupted/forward value can NEVER be stored and
    -- later silently downgraded on read (a bad `regime` must not send a
    -- replicated lineage down the pruning path; a bad `content_kind` must not
    -- project the wrong root). Fail closed at write.
    content_kind      TEXT    NOT NULL DEFAULT 'richdoc'
                              CHECK (content_kind IN ('plaintext', 'richdoc')),
    regime            TEXT    NOT NULL DEFAULT 'local-only'
                              CHECK (regime IN ('local-only', 'replicated')),
    head_update_seq   INTEGER NOT NULL DEFAULT 0,
    head_snapshot_seq INTEGER NOT NULL DEFAULT 0,
    base_claimed      INTEGER NOT NULL DEFAULT 0,
    -- Durable, monotone-forever settle generation (NEVER reset, even by a
    -- local-only close-prune): makes the settle job id clock-independent so a
    -- crash-retry with an advanced wall clock still dedups. `last_settled_sha`
    -- records the content last materialized so an unchanged re-settle is an
    -- idempotent no-op while a content change bumps the generation.
    settle_seq        INTEGER NOT NULL DEFAULT 0,
    last_settled_sha  TEXT,
    updated_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id),
    FOREIGN KEY (workspace_id, object_id)
      REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE ydoc_updates (
    workspace_id       TEXT    NOT NULL,
    version_id         TEXT    NOT NULL,
    object_id          TEXT    NOT NULL,
    seq                INTEGER NOT NULL,
    update_blob_sha256 TEXT    NOT NULL,
    actor_origin_id    TEXT,
    recorded_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id, seq),
    FOREIGN KEY (update_blob_sha256) REFERENCES binary_blobs(sha256),
    FOREIGN KEY (workspace_id, version_id, object_id)
      REFERENCES ydoc_docs(workspace_id, version_id, object_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_ydoc_updates_doc_seq
    ON ydoc_updates(workspace_id, version_id, object_id, seq);

-- Content-addressed dedup index: an update blob already present in a doc's log
-- makes a redelivered/echoed remote update an O(1) idempotent no-op.
CREATE INDEX idx_ydoc_updates_doc_blob
    ON ydoc_updates(workspace_id, version_id, object_id, update_blob_sha256);

CREATE TABLE ydoc_snapshots (
    workspace_id             TEXT    NOT NULL,
    version_id               TEXT    NOT NULL,
    object_id                TEXT    NOT NULL,
    up_to_seq                INTEGER NOT NULL,
    snapshot_blob_sha256     TEXT    NOT NULL,
    state_vector_blob_sha256 TEXT    NOT NULL,
    recorded_at_ms           INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id, up_to_seq),
    FOREIGN KEY (snapshot_blob_sha256) REFERENCES binary_blobs(sha256),
    FOREIGN KEY (state_vector_blob_sha256) REFERENCES binary_blobs(sha256),
    FOREIGN KEY (workspace_id, version_id, object_id)
      REFERENCES ydoc_docs(workspace_id, version_id, object_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_ydoc_snapshots_doc_uptoseq
    ON ydoc_snapshots(workspace_id, version_id, object_id, up_to_seq DESC);
";

/// The `id` of the R11a Y.Doc durable-cache migration.
pub(crate) const YDOC_MIGRATION_ID: &str = "v1-ydoc";

/// Ordinal 3 (R09 chats domain, appended via the migration-append capability
/// contract). Adds the chat surface tables — threads/channels/messages,
/// reactions/decisions/attachments/mentions, read-state, follows/personal-feed/
/// bookmarks, and the durable dispatch ledger + agent-run records — whose
/// logical shapes match the TS engine's chat cluster (`engineDbSchema.ts`
/// `CHAT_CHANNEL_TABLES_DDL` / `CHAT_PHASE_ONE_DDL` / `CHAT_FEED_DDL` /
/// `CHAT_BOOKMARK_DDL` / `AGENT_DISPATCH_DDL` + the `chat_threads` /
/// `chat_messages` core). The TS store grows these across a create-path plus
/// lazy `ensureNullableColumn` upgrades (`chat_threads.channel_id`,
/// `chat_messages.author_user_id`/`parent_message_id`/`origin`,
/// `chat_attachments.heading_*`, `chat_bookmark_outbox.projection_object_id`);
/// the fresh Rust baseline folds every such column into the initial shape so a
/// day-one Rust store equals a fully-upgraded TS store.
///
/// `STRICT` + `INTEGER` timestamps follow the R04 baseline convention. TS stores
/// SOME chat timestamps as `REAL` (`chat_threads`/`chat_channels`/read-state/
/// reactions/follows/feed/bookmarks) and some as `INTEGER`
/// (`chat_decisions`/`chat_mentions`/`chat_dispatch_*`/`agent_run_records`); the
/// affinity is an engine-internal detail (semantics matrix §2.4). Cross-engine
/// parity rides logical row shape and content-addressed identity (channel wire
/// ids, sha256 projection paths), not the SQLite column affinity — the same
/// `REAL`→`INTEGER` rationale R08/R11a recorded for their timestamp columns.
///
/// CHECK constraints mirror the TS schema's fail-closed enum columns
/// (`chat_decisions.state`, `chat_attachments.target_kind`, `chat_follows`
/// target-kind/state, `chat_bookmarks` target-kind/mode/state,
/// `chat_bookmark_outbox.projection_state`, `chat_dispatch_ledger.state`) so a
/// corrupt/forward value can never be stored and later silently misread.
///
/// The trailing block is the deferred-chat-parent repair (BEHAVIOR_DELTA §D2 /
/// `engineDbSchema.ts:779-837`): it moves replicated replies whose parent has
/// not arrived into `chat_pending_message_parents` and NULLs cross-thread/self
/// parent links. Because this migration CREATEs `chat_messages` empty in the
/// same transaction immediately before, the repair is ALWAYS a no-op on a Rust
/// store (and a foreign/TS `engine.db` never reaches this runner — the v1-vs-v2
/// fingerprint fence in `schema.rs` rejects it before any migration runs). It is
/// folded in as a keyed, checksum-gated record of the exact TS repair SQL — the
/// semantic contract R10 replicated-apply and any future TS→Rust importer must
/// converge to — not a live data-rewrite path. Kept over dropping it so the
/// repair semantics live in one auditable place next to the tables they touch.
const V1_CHATS_DDL: &str = "\
-- Channels + per-thread read cursors (WS-E). Durable rows key on channel_id;
-- the slug UNIQUE index is a collision-safe lookup alias per workspace.
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

-- (workspace, wire_id) -> channel_id. A locally created channel's wire id is
-- its own channel_id; the auto-created 'general'/'My agent' channels use
-- deterministic well-known wire ids so independently minted rows converge.
CREATE TABLE chat_channel_wire_ids (
    workspace_id TEXT NOT NULL,
    wire_id      TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    PRIMARY KEY (workspace_id, wire_id)
) STRICT;
CREATE INDEX idx_chat_channel_wire_ids_channel
    ON chat_channel_wire_ids(workspace_id, channel_id);

-- Provenance for channels synthesized by a thread that replicated before its
-- channel-create op; the authoritative create later replaces the guess in place.
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

-- Reactions (WS-MU-C2): one LWW register per (message, emoji, author) cell.
-- Tombstones ('removed') retained; reads filter state='added'. No FK: a
-- cross-origin reaction op can precede the message it targets.
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

-- Receiver-owned personal Feed state (LWW registers with retained tombstones).
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

-- Durable agent-dispatch ledger + private run records (single-writer
-- replacement for the desktop's raw second connection, STATE_OWNERSHIP DELETED).
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

-- Local-only provenance from agent-authored chat reports to their private
-- runner trace. Deliberately absent from every replication/projection/export.
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

-- Deferred-chat-parent repair (BEHAVIOR_DELTA §D2). No-op on a fresh store;
-- keyed to the `v1-chats` ledger row so it runs exactly once per database.
INSERT OR IGNORE INTO chat_pending_message_parents (
    workspace_id, child_message_id, thread_id, parent_message_id
)
SELECT child.workspace_id, child.message_id, child.thread_id, child.parent_message_id
FROM chat_messages child
WHERE child.parent_message_id IS NOT NULL
  AND child.parent_message_id <> child.message_id
  AND NOT EXISTS (
    SELECT 1 FROM chat_messages parent
    WHERE parent.workspace_id = child.workspace_id
      AND parent.message_id = child.parent_message_id
  );
UPDATE chat_messages AS child
SET parent_message_id = NULL
WHERE child.parent_message_id IS NOT NULL
  AND (
    child.parent_message_id = child.message_id
    OR NOT EXISTS (
      SELECT 1 FROM chat_messages parent
      WHERE parent.workspace_id = child.workspace_id
        AND parent.thread_id = child.thread_id
        AND parent.message_id = child.parent_message_id
    )
  );
";

/// The `id` of the R09 chats-domain migration.
pub(crate) const CHATS_MIGRATION_ID: &str = "v1-chats";

/// Ordinal 4 (R12 search shard, appended via the migration-append capability
/// contract). Adds the full-text search surface — two FTS5 virtual tables over
/// file text and chat-message text, plus the durable per-version index-state
/// marker — whose logical shapes match the TS engine's `engine_search_files_fts`
/// / `engine_search_chat_messages_fts` / `engine_search_index_state`
/// (`engineDbSchema.ts` `ENGINE_SEARCH_INDEX_DDL`).
///
/// **FTS5 config is pinned byte-for-byte to the TS oracle**: the column list
/// (UNINDEXED metadata columns + one indexed `text` column) and
/// `tokenize='trigram'` (no options) are reproduced verbatim so the trigram
/// prefilter and the `rowid`-ordered candidate stream behave identically on
/// both engines. FTS5 + the trigram tokenizer are compiled into the bundled
/// SQLite unconditionally (`libsqlite3-sys` 0.35 `build.rs` sets
/// `-DSQLITE_ENABLE_FTS5`; the trigram tokenizer ships since SQLite 3.34 and the
/// bundle is 3.50.2) — no extra `rusqlite` feature is required, and the
/// migration's own `quick_check` gate proves the CREATE VIRTUAL TABLE succeeded
/// on THIS build before the ledger row is written. A build lacking FTS5 would
/// fail this migration closed rather than silently ship a searchless store.
///
/// `engine_search_index_state.indexed_at_ms` is `INTEGER` here where TS uses
/// `REAL`; the value is an engine-internal repair marker (never cross-engine
/// compared), so the affinity follows the R04/R08/R11a/R09 `INTEGER`-timestamp
/// convention. Unlike the TS engine's lazy-additive search tables (created on
/// open, absent = "no search yet"), the Rust migration ledger always creates
/// them, so their presence is a hard v2 invariant enforced in `schema.rs`.
const V1_SEARCH_DDL: &str = "\
-- File-text FTS index. One row per (workspace, version, object) currently
-- searchable text file; UNINDEXED metadata columns are stored-but-not-tokenized
-- so a policy re-check and dedup can read them back without a join. A regular
-- (non-external-content) FTS5 table, so ordinary DELETE ... WHERE on the
-- UNINDEXED keys removes a row. Trigram tokenizer, no options — matches TS.
CREATE VIRTUAL TABLE engine_search_files_fts USING fts5(
    workspace_id UNINDEXED,
    version_id UNINDEXED,
    object_id UNINDEXED,
    path UNINDEXED,
    text,
    tokenize='trigram'
);

-- Chat-message FTS index. One row per (workspace, thread, message); the
-- per-thread header row uses the sentinel message id '__thread__'. Chat is not
-- versioned, so rows are workspace-scoped (no version_id column).
CREATE VIRTUAL TABLE engine_search_chat_messages_fts USING fts5(
    workspace_id UNINDEXED,
    thread_id UNINDEXED,
    message_id UNINDEXED,
    text,
    tokenize='trigram'
);

-- Durable per-version index generation. A committed row for (workspace,
-- version) names a fully-built file index generation; its ABSENCE forces
-- ensure_search_index_for_version to (re)build. A degraded-file-policy window
-- deliberately leaves this unset so fixing the policy triggers a full rebuild
-- (the fail-closed freeze-not-drop model). Committed in the SAME transaction as
-- the FTS rows it certifies, so a query never observes a torn mid-index state.
CREATE TABLE engine_search_index_state (
    workspace_id  TEXT    NOT NULL,
    version_id    TEXT    NOT NULL,
    indexed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id)
) STRICT;
";

/// The `id` of the R12 search migration.
pub(crate) const SEARCH_MIGRATION_ID: &str = "v1-search";

/// The frozen, ordered list of migrations this build knows. The baseline (0) is
/// the day-one v2 schema; future schema changes append with a monotone ordinal.
pub(crate) const BASELINE_MIGRATIONS: &[Migration] = &[
    Migration {
        ordinal: 0,
        id: BASELINE_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V2_BASELINE_DDL,
        sets_user_version: Some(ENGINE_SCHEMA_VERSION),
    },
    Migration {
        ordinal: 1,
        id: SECRETS_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_SECRETS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 2,
        id: YDOC_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_YDOC_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 3,
        id: CHATS_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_CHATS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 4,
        id: SEARCH_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_SEARCH_DDL,
        sets_user_version: None,
    },
];

/// Lowercase-hex sha-256 of the migration DDL — the checksum stored in and
/// re-verified against the ledger.
pub(crate) fn migration_checksum(sql: &str) -> String {
    let digest = Sha256::digest(sql.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
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
    /// No row (or the ledger table does not exist yet — a fresh store).
    Missing,
    /// A started-but-incomplete non-transactional migration: re-run idempotently
    /// — but only if its recorded checksum still matches this build's definition.
    Incomplete { checksum: String },
    /// Completed; carries the recorded checksum for the compatibility check.
    Complete { checksum: String },
}

fn ledger_status(conn: &Connection, id: &str) -> Result<LedgerStatus, StorageError> {
    let row = conn
        .query_row(
            "SELECT checksum, completed_at FROM engine_migrations WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)),
        )
        .optional();
    match row {
        Ok(Some((checksum, Some(_completed)))) => Ok(LedgerStatus::Complete { checksum }),
        Ok(Some((checksum, None))) => Ok(LedgerStatus::Incomplete { checksum }),
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

/// Run every pending migration in `migrations` (ordered) against `conn`,
/// idempotently and crash-recoverably. Safe to call on every open: already-
/// applied migrations are skipped after a checksum check.
/// Assert the migration list is well-formed: strictly increasing ordinals and
/// unique ids. The runner trusts *slice order* to be *ordinal order*, so a dev
/// appending out of order (`[0, 2, 1]`) would otherwise apply DDL out of order
/// with no other trip (distinct ids/ordinals pass the checksum gate). Fail
/// closed instead.
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

pub(crate) fn run_migrations(
    conn: &mut Connection,
    migrations: &[Migration],
    ctx: &MigrationContext,
    faults: &dyn FaultInjector,
) -> Result<MigrationOutcome, StorageError> {
    // Fail closed on a malformed migration list BEFORE touching the store.
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
                if checksum != migration_checksum(migration.sql) {
                    // A completed migration whose DDL this build defines
                    // differently — a tampered or incompatible ledger. Fail
                    // closed rather than skip-and-diverge.
                    return Err(StorageError::MigrationFailed { source: None });
                }
                continue;
            }
            LedgerStatus::Incomplete { checksum } => {
                // A started-but-unfinished migration whose DDL changed between
                // builds must NOT be re-run: the new body would apply over the
                // partial effects of the old one. Fail closed; only a
                // checksum-matching incomplete row is resumed.
                if checksum != migration_checksum(migration.sql) {
                    return Err(StorageError::MigrationFailed { source: None });
                }
            }
            LedgerStatus::Missing => {}
        }

        let outcome = match migration.kind {
            MigrationKind::Transactional => apply_transactional(conn, migration, ctx, faults)?,
            MigrationKind::NonTransactional => {
                apply_non_transactional(conn, migration, ctx, faults)?
            }
        };
        match outcome {
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

fn apply_non_transactional(
    conn: &mut Connection,
    migration: &Migration,
    ctx: &MigrationContext,
    faults: &dyn FaultInjector,
) -> Result<MigrationOutcome, StorageError> {
    let checksum = migration_checksum(migration.sql);

    // Record a started row in its own commit so a crash mid-body leaves a
    // durable 'incomplete' marker restart can resume from. Idempotent: a
    // re-run after a crash finds the row already present.
    conn.execute(
        "INSERT INTO engine_migrations \
         (ordinal, id, checksum, engine_build, protocol_version, transactional, \
          started_at, completed_at, integrity_ok) \
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, NULL, NULL) \
         ON CONFLICT(id) DO NOTHING",
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

    // The body MUST be idempotent (e.g. `CREATE TABLE IF NOT EXISTS`) because a
    // crash-and-resume re-runs it against a partially-applied store.
    conn.execute_batch(migration.sql)
        .map_err(StorageError::migration)?;

    // `migrate.before-ledger-commit` (non-transactional flavor): the started
    // row is durable but completion is not recorded. Restart re-runs the body.
    if should_crash(faults, FaultPoint::MigrateBeforeLedgerCommit) {
        return Ok(MigrationOutcome::Crashed);
    }

    let integrity_ok = quick_check_ok(conn)?;
    if !integrity_ok {
        return Err(StorageError::MigrationFailed { source: None });
    }

    conn.execute(
        "UPDATE engine_migrations SET completed_at = ?1, integrity_ok = 1 WHERE id = ?2",
        rusqlite::params![ctx.now_ms, migration.id],
    )
    .map_err(StorageError::migration)?;
    Ok(MigrationOutcome::Applied { newly_applied: 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::faults::{FaultAction, NoFaults};
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A one-shot crash injector local to the storage crate's tests (the
    /// testkit's `ScriptedFaults` cannot be used here without a dependency
    /// cycle).
    struct OneShotCrash {
        point: FaultPoint,
        armed: AtomicBool,
    }
    impl OneShotCrash {
        fn at(point: FaultPoint) -> Self {
            OneShotCrash {
                point,
                armed: AtomicBool::new(true),
            }
        }
    }
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

    // A synthetic second migration used to exercise ordering / resume without
    // waiting for a real future schema change.
    const M2_SQL: &str = "CREATE TABLE r04_probe (x INTEGER NOT NULL);";
    fn two_migrations() -> Vec<Migration> {
        // The frozen list now ends at ordinal 4 (R12 search), so a synthetic
        // probe appends at ordinal 5.
        let mut v = BASELINE_MIGRATIONS.to_vec();
        v.push(Migration {
            ordinal: 5,
            id: "r04-probe",
            kind: MigrationKind::Transactional,
            sql: M2_SQL,
            sets_user_version: None,
        });
        v
    }

    /// Count of frozen baseline migrations (baseline + secrets + ydoc + chats).
    const BASELINE_COUNT: u32 = BASELINE_MIGRATIONS.len() as u32;

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
                newly_applied: BASELINE_COUNT
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

        // Reopen and re-run with no fault: recovers cleanly, applying the whole
        // frozen list (baseline + secrets).
        let mut conn = open_bare(&path);
        let out = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("recover");
        assert_eq!(
            out,
            MigrationOutcome::Applied {
                newly_applied: BASELINE_COUNT
            }
        );
    }

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
            // Baseline committed; probe migration did NOT run.
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

        // Resume: baseline is skipped (idempotent); the between-steps crash
        // fired before the secrets migration (ordinal 1), so resume applies the
        // secrets migration (1), the Y.Doc migration (2), the chats migration
        // (3), the search migration (4), AND the probe (5).
        let mut conn = open_bare(&path);
        let out = run_migrations(&mut conn, &migrations, &ctx, &NoFaults).expect("resume");
        assert_eq!(out, MigrationOutcome::Applied { newly_applied: 5 });
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
        // BEFORE applying anything (no partial out-of-order DDL).
        let a = Migration {
            ordinal: 1,
            id: "a",
            kind: MigrationKind::Transactional,
            sql: "CREATE TABLE a (x INTEGER);",
            sets_user_version: None,
        };
        let b = Migration {
            ordinal: 2,
            id: "b",
            kind: MigrationKind::Transactional,
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
    fn incomplete_migration_with_changed_checksum_fails_closed() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(4_500);

        // Establish the baseline, then leave a non-transactional migration in a
        // started-but-incomplete state via a crash before completion.
        {
            let mut conn = open_bare(&path);
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("baseline");
        }
        let mut migrations = BASELINE_MIGRATIONS.to_vec();
        migrations.push(Migration {
            ordinal: 5,
            id: "r04-nontx",
            kind: MigrationKind::NonTransactional,
            sql: "CREATE TABLE IF NOT EXISTS r04_nontx (x INTEGER);",
            sets_user_version: None,
        });
        let faults = OneShotCrash::at(FaultPoint::MigrateBeforeLedgerCommit);
        {
            let mut conn = open_bare(&path);
            let out = run_migrations(&mut conn, &migrations, &ctx, &faults).expect("run");
            assert_eq!(out, MigrationOutcome::Crashed);
        }

        // A later build DEFINES the same migration id with different DDL. The
        // incomplete row's checksum no longer matches: re-running would apply
        // the new body over the old body's partial effects, so fail closed.
        let mut changed = BASELINE_MIGRATIONS.to_vec();
        changed.push(Migration {
            ordinal: 5,
            id: "r04-nontx",
            kind: MigrationKind::NonTransactional,
            sql: "CREATE TABLE IF NOT EXISTS r04_nontx_DIFFERENT (x INTEGER);",
            sets_user_version: None,
        });
        let mut conn = open_bare(&path);
        let err = run_migrations(&mut conn, &changed, &ctx, &NoFaults).unwrap_err();
        assert_eq!(err.code(), "migration-failed");
    }

    #[test]
    fn non_transactional_started_then_resumes() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(4_000);

        // baseline first (transactional), then a non-transactional idempotent step.
        let mut migrations = BASELINE_MIGRATIONS.to_vec();
        migrations.push(Migration {
            ordinal: 5,
            id: "r04-nontx",
            kind: MigrationKind::NonTransactional,
            sql: "CREATE TABLE IF NOT EXISTS r04_nontx (x INTEGER);",
            sets_user_version: None,
        });

        // Establish the (transactional) baseline first so the one-shot crash
        // lands on the non-transactional migration, not the baseline.
        {
            let mut conn = open_bare(&path);
            run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults).expect("baseline");
        }

        // Crash after the started row + body, before completion is recorded.
        let faults = OneShotCrash::at(FaultPoint::MigrateBeforeLedgerCommit);
        {
            let mut conn = open_bare(&path);
            let out = run_migrations(&mut conn, &migrations, &ctx, &faults).expect("run");
            assert_eq!(out, MigrationOutcome::Crashed);
            // The started row is durable but incomplete.
            let completed: Option<i64> = conn
                .query_row(
                    "SELECT completed_at FROM engine_migrations WHERE id='r04-nontx'",
                    [],
                    |r| r.get(0),
                )
                .expect("row");
            assert!(completed.is_none(), "must be started-but-incomplete");
        }

        // Resume: the incomplete row is re-run and completed.
        let mut conn = open_bare(&path);
        let out = run_migrations(&mut conn, &migrations, &ctx, &NoFaults).expect("resume");
        assert_eq!(out, MigrationOutcome::Applied { newly_applied: 1 });
        let completed: Option<i64> = conn
            .query_row(
                "SELECT completed_at FROM engine_migrations WHERE id='r04-nontx'",
                [],
                |r| r.get(0),
            )
            .expect("row2");
        assert_eq!(completed, Some(4_000));
    }

    fn tempdir() -> std::path::PathBuf {
        let mut base = std::env::temp_dir();
        let unique = format!(
            "dohc-r04-mig-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        base.push(unique);
        std::fs::create_dir_all(&base).expect("mkdir");
        base
    }
}
