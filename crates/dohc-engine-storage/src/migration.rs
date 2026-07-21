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
-- version) names a fully-built index generation; its ABSENCE forces
-- ensure_search_index_for_version to (re)build. Committed in the SAME
-- transaction as the FTS rows it certifies, so a query never observes a torn
-- mid-index state.
--
-- `file_policy_degraded` extends the TS logical shape (a recorded Rust delta):
-- 1 marks a generation built while the FILE policy was broken (file index
-- FROZEN, chat index authoritative). Recording it durably means a stable
-- degraded window does NOT re-index chat on every query (the TS engine, which
-- leaves NO state row while degraded, re-wipes+rebuilds chat per query), and a
-- degraded↔healthy TRANSITION is what triggers the file rebuild — not the
-- mere absence of a row. The timestamp affinity is INTEGER per the
-- R04/R08/R09/R11a convention (an engine-internal repair marker, never
-- cross-engine compared).
CREATE TABLE engine_search_index_state (
    workspace_id         TEXT    NOT NULL,
    version_id           TEXT    NOT NULL,
    indexed_at_ms        INTEGER NOT NULL,
    file_policy_degraded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, version_id)
) STRICT;
";

/// The `id` of the R12 search migration.
pub(crate) const SEARCH_MIGRATION_ID: &str = "v1-search";

/// Ordinal 5 (R05 versioning residual). Adds the durable pointer from a moment
/// to the moment that produced its concrete rollback preimage.
const V1_MOMENT_BEFORE_LINK_DDL: &str = "\
ALTER TABLE moments ADD COLUMN before_latest_moment_id TEXT;
-- Rust originally encoded no-preimage/concrete-preimage as 0/1. Normalize to
-- the TS tri-state: 0 legacy-unset, 1 explicit-absent, 2 concrete-preimage.
UPDATE moments SET before_present = before_present + 1 WHERE before_present IN (0, 1);
-- Resolve concrete preimages produced by an earlier materialized moment in the
-- same version.
UPDATE moments AS m
SET before_latest_moment_id = (
    SELECT prev.moment_id FROM moments AS prev
    WHERE prev.workspace_id = m.workspace_id
      AND prev.version_id  = m.version_id
      AND prev.object_id   = m.object_id
      AND prev.moment_order < m.moment_order
      AND (prev.sync_record_only IS NULL OR prev.sync_record_only = 0)
    ORDER BY prev.moment_order DESC
    LIMIT 1
)
WHERE m.before_present = 2 AND m.before_latest_moment_id IS NULL;
-- Resolve the remaining first-write-after-fork preimages from the frozen base.
UPDATE moments AS m
SET before_latest_moment_id = (
    SELECT fb.latest_moment_id FROM fork_base_snapshots AS fb
    WHERE fb.workspace_id = m.workspace_id
      AND fb.version_id   = m.version_id
      AND fb.object_id    = m.object_id
)
WHERE m.before_present = 2 AND m.before_latest_moment_id IS NULL;
";

/// The `id` of the R05 moment-preimage-link migration.
pub(crate) const MOMENT_BEFORE_LINK_MIGRATION_ID: &str = "v1-moment-before-link";

/// Ordinal 6 (R10). R10's durable replication substrate. Cursor advancement is
/// deliberately separate from imported-op application: `replication_log` plus
/// `replication_peers` commit with the domain mutation, while relay/share
/// cursors advance only after downstream materialization succeeds. Appended
/// strictly after R05's ordinal-5 `v1-moment-before-link`.
const V1_SYNC_DDL: &str = "\
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
    PRIMARY KEY (workspace_id, origin_id, origin_seq)
) STRICT;
CREATE INDEX idx_replication_log_order
    ON replication_log(workspace_id, recorded_at_ms, origin_id, origin_seq);

CREATE TABLE replication_peers (
    workspace_id TEXT    NOT NULL,
    origin_id    TEXT    NOT NULL,
    acked_seq    INTEGER NOT NULL CHECK (acked_seq >= -1),
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
    PRIMARY KEY (workspace_id, share_id)
) STRICT;

CREATE TABLE share_view_cursors (
    workspace_id TEXT NOT NULL,
    share_id     TEXT NOT NULL,
    cursor       TEXT NOT NULL,
    PRIMARY KEY (workspace_id, share_id)
) STRICT;
";

/// The `id` of the R10 sync migration.
pub(crate) const SYNC_MIGRATION_ID: &str = "v1-sync";

/// Ordinal 7 (R06 compare/merge/conflicts shard). Adds durable conflict objects
/// plus the materialization operation needed by merge and resolution deletes.
/// `STRICT` + `INTEGER` timestamps follow the R04 baseline convention; TS
/// `REAL` affinity is internal because conflict rows are never cross-engine
/// compared by affinity, matching the R08/R09/R11a/R12 precedent.
const V1_CONFLICTS_DDL: &str = "\
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
    PRIMARY KEY (workspace_id, conflict_id),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (base_blob_sha256) REFERENCES blobs(sha256),
    FOREIGN KEY (current_blob_sha256) REFERENCES blobs(sha256),
    FOREIGN KEY (incoming_blob_sha256) REFERENCES blobs(sha256)
) STRICT;
CREATE INDEX idx_conflicts_workspace_status ON conflicts(workspace_id, status, created_at_ms, conflict_id);
ALTER TABLE materialization_jobs ADD COLUMN operation TEXT NOT NULL DEFAULT 'write';
";

/// The `id` of the R06 conflict-object migration.
pub(crate) const CONFLICTS_MIGRATION_ID: &str = "v1-conflicts";

const V1_SHADOW_CLONE_DDL: &str = "
CREATE TABLE shadow_clone (
    rowid_guard INTEGER NOT NULL PRIMARY KEY CHECK (rowid_guard = 1),
    token TEXT NOT NULL
) STRICT;
";

pub(crate) const SHADOW_CLONE_MIGRATION_ID: &str = "v1-shadow-clone";

/// Ordinal 9. Adds content-addressed binary-blob references to each conflict
/// side while preserving the existing text-blob references. SQLite keeps this
/// schema change declarative through a transactional table rebuild. Unlike the
/// prior additive migrations, the rebuild's `INSERT ... SELECT` runs with
/// foreign keys ON and therefore RE-VALIDATES every historical row's FKs — a
/// store carrying a latent dangling reference becomes unopenable at upgrade
/// (fail-closed with a clean rollback to v8, remediable by restoring the
/// missing referent).
const V1_BINARY_CONFLICT_SIDES_DDL: &str = "\
CREATE TABLE conflicts_v9 (
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
INSERT INTO conflicts_v9 (
    workspace_id, conflict_id, path, target_version_id, source_version_id,
    created_at_ms, updated_at_ms, status, chosen_from, resolution,
    metadata_origin, metadata_summary, metadata_correlation_id,
    base_exists, base_path, base_object_id, base_content_kind, base_blob_sha256,
    base_updated_at_ms, base_latest_moment_id, base_metadata_origin,
    base_metadata_summary, base_metadata_correlation_id,
    current_exists, current_path, current_object_id, current_content_kind,
    current_blob_sha256, current_updated_at_ms, current_latest_moment_id,
    current_metadata_origin, current_metadata_summary, current_metadata_correlation_id,
    incoming_exists, incoming_path, incoming_object_id, incoming_content_kind,
    incoming_blob_sha256, incoming_updated_at_ms, incoming_latest_moment_id,
    incoming_metadata_origin, incoming_metadata_summary, incoming_metadata_correlation_id,
    base_binary_sha256, current_binary_sha256, incoming_binary_sha256
)
SELECT
    workspace_id, conflict_id, path, target_version_id, source_version_id,
    created_at_ms, updated_at_ms, status, chosen_from, resolution,
    metadata_origin, metadata_summary, metadata_correlation_id,
    base_exists, base_path, base_object_id, base_content_kind, base_blob_sha256,
    base_updated_at_ms, base_latest_moment_id, base_metadata_origin,
    base_metadata_summary, base_metadata_correlation_id,
    current_exists, current_path, current_object_id, current_content_kind,
    current_blob_sha256, current_updated_at_ms, current_latest_moment_id,
    current_metadata_origin, current_metadata_summary, current_metadata_correlation_id,
    incoming_exists, incoming_path, incoming_object_id, incoming_content_kind,
    incoming_blob_sha256, incoming_updated_at_ms, incoming_latest_moment_id,
    incoming_metadata_origin, incoming_metadata_summary, incoming_metadata_correlation_id,
    NULL, NULL, NULL
FROM conflicts;
DROP TABLE conflicts;
ALTER TABLE conflicts_v9 RENAME TO conflicts;
CREATE INDEX idx_conflicts_workspace_status ON conflicts(workspace_id, status, created_at_ms, conflict_id);
";

/// The `id` of the binary conflict-side migration.
pub(crate) const BINARY_CONFLICT_SIDES_MIGRATION_ID: &str = "v1-binary-conflict-sides";

/// Ordinal 10. Gives binary content the same durable head shape as text by
/// adding discriminated binary references to moments and both snapshot tables.
/// The rebuild copies every v9 column explicitly. With foreign keys enabled,
/// those copies also re-validate historical references and fail closed by
/// rolling the whole migration back when a referent is missing.
///
/// INVARIANT: the fail-closed FK re-validation depends on the CALLER having set
/// `PRAGMA foreign_keys=ON` before the runner opens the migration transaction
/// (`schema.rs:181`), not on this migration. The migration deliberately does not
/// toggle the pragma itself — a `PRAGMA foreign_keys` inside the active
/// transactional rebuild is a silent no-op in SQLite and would break the
/// transactional-rebuild semantics. Holds today because every open path enables
/// it before migrating.
const V1_BINARY_HEAD_DDL: &str = "\
CREATE TABLE snapshots_v10 (
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
INSERT INTO snapshots_v10 (
    workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms,
    latest_moment_id, metadata_origin, content_kind, binary_sha256
)
SELECT
    workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms,
    latest_moment_id, metadata_origin, 'text', NULL
FROM snapshots;
DROP TABLE snapshots;
ALTER TABLE snapshots_v10 RENAME TO snapshots;

CREATE TABLE fork_base_snapshots_v10 (
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
    CHECK (
        (content_kind = 'text'   AND blob_sha256   IS NOT NULL AND binary_sha256 IS NULL)
     OR (content_kind = 'binary' AND binary_sha256 IS NOT NULL AND blob_sha256   IS NULL)
    ),
    PRIMARY KEY (workspace_id, version_id, object_id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
) STRICT;
INSERT INTO fork_base_snapshots_v10 (
    workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms,
    latest_moment_id, metadata_origin, content_kind, binary_sha256
)
SELECT
    workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms,
    latest_moment_id, metadata_origin, 'text', NULL
FROM fork_base_snapshots;
DROP TABLE fork_base_snapshots;
ALTER TABLE fork_base_snapshots_v10 RENAME TO fork_base_snapshots;

CREATE TABLE moments_v10 (
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
INSERT INTO moments_v10 (
    workspace_id, moment_order, moment_id, version_id, object_id, path,
    recorded_at_ms, operation, after_blob_sha256, before_present,
    before_blob_sha256, metadata_origin, author_json, sync_record_only,
    before_latest_moment_id, after_content_kind, after_binary_sha256,
    before_content_kind, before_binary_sha256
)
SELECT
    workspace_id, moment_order, moment_id, version_id, object_id, path,
    recorded_at_ms, operation, after_blob_sha256, before_present,
    before_blob_sha256, metadata_origin, author_json, sync_record_only,
    before_latest_moment_id, 'text', NULL, 'text', NULL
FROM moments;
DROP TABLE moments;
ALTER TABLE moments_v10 RENAME TO moments;
CREATE INDEX idx_moments_workspace_order ON moments(workspace_id, moment_order DESC);
CREATE INDEX idx_moments_version_order ON moments(workspace_id, version_id, moment_order DESC);
CREATE INDEX idx_moments_object_order ON moments(workspace_id, object_id, moment_order DESC);
";

/// The `id` of the binary-head migration.
pub(crate) const BINARY_HEAD_MIGRATION_ID: &str = "v1-binary-head";

/// Ordinal 11. Supports capture reconciliation's reverse alias lookup without
/// scanning every alias in the workspace for each newly discovered file.
const V1_PATH_ALIASES_OBJECT_INDEX_DDL: &str = "\
CREATE INDEX idx_path_aliases_workspace_object ON path_aliases(workspace_id, object_id);
";

/// The `id` of the reverse path-alias lookup migration.
pub(crate) const PATH_ALIASES_OBJECT_INDEX_MIGRATION_ID: &str = "v1-path-aliases-object-index";

/// Deferred replicated Y.Doc coordinates: rows acked while a live lease held
/// the doc, pending replay into `ydoc_updates`. The imported replication log
/// keeps the payload; this table records WHICH coordinates are actually
/// pending, so drains replay only genuinely-deferred rows (never the whole
/// history, which after compaction would re-append non-dedupable updates).
const V1_YDOC_DEFERRED_DDL: &str = "CREATE TABLE ydoc_deferred_updates (
    workspace_id   TEXT    NOT NULL,
    version_id     TEXT    NOT NULL,
    object_id      TEXT    NOT NULL,
    origin_id      TEXT    NOT NULL,
    origin_seq     INTEGER NOT NULL,
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, origin_id, origin_seq),
    FOREIGN KEY (workspace_id, version_id, object_id)
      REFERENCES ydoc_docs(workspace_id, version_id, object_id)
      ON DELETE CASCADE
) STRICT;
CREATE INDEX ydoc_deferred_updates_by_doc
    ON ydoc_deferred_updates (workspace_id, version_id, object_id);
";

/// The `id` of the deferred Y.Doc coordinates migration.
pub(crate) const YDOC_DEFERRED_MIGRATION_ID: &str = "v1-ydoc-deferred-updates";

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
    Migration {
        ordinal: 5,
        id: MOMENT_BEFORE_LINK_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_MOMENT_BEFORE_LINK_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 6,
        id: SYNC_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_SYNC_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 7,
        id: CONFLICTS_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_CONFLICTS_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 8,
        id: SHADOW_CLONE_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_SHADOW_CLONE_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 9,
        id: BINARY_CONFLICT_SIDES_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_BINARY_CONFLICT_SIDES_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 10,
        id: BINARY_HEAD_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_BINARY_HEAD_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 11,
        id: PATH_ALIASES_OBJECT_INDEX_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_PATH_ALIASES_OBJECT_INDEX_DDL,
        sets_user_version: None,
    },
    Migration {
        ordinal: 12,
        id: YDOC_DEFERRED_MIGRATION_ID,
        kind: MigrationKind::Transactional,
        sql: V1_YDOC_DEFERRED_DDL,
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
        // The frozen list now ends at ordinal 12 (deferred Y.Doc
        // coordinates), so a synthetic probe appends at ordinal 13.
        let mut v = BASELINE_MIGRATIONS.to_vec();
        v.push(Migration {
            ordinal: 13,
            id: "r04-probe",
            kind: MigrationKind::Transactional,
            sql: M2_SQL,
            sets_user_version: None,
        });
        v
    }

    /// Count of frozen baseline migrations through the reverse alias index.
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
    fn moment_before_link_backfill_resolves_like_fresh() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_500);
        let mut conn = open_bare(&path);

        let pre_r05 = BASELINE_MIGRATIONS[..5].to_vec();
        run_migrations(&mut conn, &pre_r05, &ctx, &NoFaults).expect("pre-R05 migrations");
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id) \
             VALUES ('ws', 'main');
             INSERT INTO versions \
             (workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id) \
             VALUES ('ws', 'main', 'main', 'main', 1, NULL, NULL);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
             VALUES ('ws', 'o1', 1);
             INSERT INTO blobs (sha256, byte_length, text) VALUES
             ('b1', 3, 'one'), ('b2', 3, 'two'), ('b3', 5, 'three');
             INSERT INTO moments \
             (workspace_id, moment_order, moment_id, version_id, object_id, path, \
              recorded_at_ms, operation, after_blob_sha256, before_present, \
              before_blob_sha256, metadata_origin, author_json, sync_record_only) \
             VALUES ('ws', 1, 'm1', 'main', 'o1', 'a.md', 10, 'write', 'b1', 0, \
                     NULL, 'user', NULL, NULL);
             INSERT INTO versions \
             (workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id) \
             VALUES ('ws', 'feat', 'named', 'feature', 20, 'main', 'm1');
             INSERT INTO fork_base_snapshots \
             (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
              latest_moment_id, metadata_origin) \
             VALUES ('ws', 'feat', 'o1', 'a.md', 'b1', 10, 'm1', 'user');
             INSERT INTO moments \
             (workspace_id, moment_order, moment_id, version_id, object_id, path, \
              recorded_at_ms, operation, after_blob_sha256, before_present, \
              before_blob_sha256, metadata_origin, author_json, sync_record_only) \
             VALUES ('ws', 2, 'm2', 'feat', 'o1', 'a.md', 30, 'write', 'b2', 1, \
                     'b1', 'user', NULL, NULL),
                    ('ws', 3, 'm3', 'main', 'o1', 'a.md', 40, 'write', 'b3', 1, \
                     'b1', 'user', NULL, NULL);
             INSERT INTO path_aliases (workspace_id, version_id, path, object_id) VALUES
             ('ws', 'main', 'a.md', 'o1'), ('ws', 'feat', 'a.md', 'o1');
             INSERT INTO snapshots \
             (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
              latest_moment_id, metadata_origin) VALUES
             ('ws', 'main', 'o1', 'a.md', 'b3', 40, 'm3', 'user'),
             ('ws', 'feat', 'o1', 'a.md', 'b2', 30, 'm2', 'user');",
        )
        .expect("seed pre-R05 version history");

        run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults)
            .expect("resume through R05");

        let m1: (i64, Option<String>) = conn
            .query_row(
                "SELECT before_present, before_latest_moment_id FROM moments WHERE moment_id = 'm1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("m1");
        let m2: (i64, Option<String>) = conn
            .query_row(
                "SELECT before_present, before_latest_moment_id FROM moments WHERE moment_id = 'm2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("m2");
        let m3: (i64, Option<String>) = conn
            .query_row(
                "SELECT before_present, before_latest_moment_id FROM moments WHERE moment_id = 'm3'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("m3");
        assert_eq!(m1, (1, None));
        assert_eq!(m2, (2, Some("m1".to_owned())));
        assert_eq!(m3, (2, Some("m1".to_owned())));
    }

    #[test]
    fn r06_conflicts_migration_upgrades_existing_store_and_creates_index() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_750);
        let mut conn = open_bare(&path);

        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..7], &ctx, &NoFaults)
            .expect("pre-R06 migrations");
        let before: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'conflicts'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("pre-R06 table probe");
        assert!(before.is_none());

        let outcome = run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults)
            .expect("apply R06, shadow fence, binary conflict sides, and binary head");
        assert_eq!(outcome, MigrationOutcome::Applied { newly_applied: 4 });
        let objects: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE \
                 (type = 'table' AND name = 'conflicts') OR \
                 (type = 'index' AND name = 'idx_conflicts_workspace_status')",
                [],
                |row| row.get(0),
            )
            .expect("R06 objects");
        assert_eq!(objects, 2);
        let strict: i64 = conn
            .query_row(
                "SELECT strict FROM pragma_table_list('conflicts') WHERE name = 'conflicts'",
                [],
                |row| row.get(0),
            )
            .expect("strict conflicts table");
        assert_eq!(strict, 1);
        let integer_timestamps: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('conflicts') WHERE type = 'INTEGER' AND \
                 name IN ('created_at_ms', 'updated_at_ms', 'base_updated_at_ms', \
                 'current_updated_at_ms', 'incoming_updated_at_ms')",
                [],
                |row| row.get(0),
            )
            .expect("integer conflict timestamps");
        assert_eq!(integer_timestamps, 5);
        let operation_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('materialization_jobs') \
                 WHERE name = 'operation' AND dflt_value = '''write'''",
                [],
                |row| row.get(0),
            )
            .expect("operation column");
        assert_eq!(operation_column, 1);
        let ledger: i64 = conn
            .query_row("SELECT COUNT(*) FROM engine_migrations", [], |row| {
                row.get(0)
            })
            .expect("ledger");
        assert_eq!(ledger, 11);
    }

    /// Every `conflicts` column, dumped by name, for value-for-value rebuild
    /// comparison. Ordered by conflict_id so before/after rows pair up.
    fn dump_conflict_rows(conn: &Connection) -> Vec<Vec<(String, rusqlite::types::Value)>> {
        let mut stmt = conn
            .prepare("SELECT * FROM conflicts ORDER BY conflict_id")
            .expect("prepare conflicts dump");
        let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
        stmt.query_map([], |row| {
            names
                .iter()
                .enumerate()
                .map(|(i, name)| Ok((name.clone(), row.get::<_, rusqlite::types::Value>(i)?)))
                .collect()
        })
        .expect("query conflicts dump")
        .collect::<Result<_, _>>()
        .expect("collect conflicts dump")
    }

    fn dump_table_rows(
        conn: &Connection,
        table: &str,
    ) -> Vec<Vec<(String, rusqlite::types::Value)>> {
        let sql = format!("SELECT * FROM {table} ORDER BY rowid");
        let mut stmt = conn.prepare(&sql).expect("prepare table dump");
        let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
        stmt.query_map([], |row| {
            names
                .iter()
                .enumerate()
                .map(|(i, name)| Ok((name.clone(), row.get::<_, rusqlite::types::Value>(i)?)))
                .collect()
        })
        .expect("query table dump")
        .collect::<Result<_, _>>()
        .expect("collect table dump")
    }

    #[test]
    fn binary_conflict_sides_migration_preserves_every_v8_column() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_800);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");

        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..9], &ctx, &NoFaults)
            .expect("migrate through ordinal 8");
        // Row 'a-full': EVERY v8 column carries a distinct non-default value —
        // including resolution = '' (the NULL-vs-empty trap) and non-default
        // *_content_kind — so any dropped, swapped, or re-defaulted column in
        // the rebuild's INSERT..SELECT shows up as a value mismatch.
        // Row 'b-null-kinds': all three *_content_kind explicitly NULL; the
        // copy must NOT re-default them to 'text'.
        // Row 'c-defaults': omits the *_content_kind columns, relying on the
        // v8 DEFAULT 'text'.
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
             VALUES ('ws', 'main');
             INSERT INTO blobs (sha256, byte_length, text) VALUES
                 ('sha-base', 9, 'base text'),
                 ('sha-cur', 12, 'current text'),
                 ('sha-inc', 13, 'incoming text');
             INSERT INTO conflicts (
                 workspace_id, conflict_id, path, target_version_id, source_version_id,
                 created_at_ms, updated_at_ms, status, chosen_from, resolution,
                 metadata_origin, metadata_summary, metadata_correlation_id,
                 base_exists, base_path, base_object_id, base_content_kind,
                 base_blob_sha256, base_updated_at_ms, base_latest_moment_id,
                 base_metadata_origin, base_metadata_summary, base_metadata_correlation_id,
                 current_exists, current_path, current_object_id, current_content_kind,
                 current_blob_sha256, current_updated_at_ms, current_latest_moment_id,
                 current_metadata_origin, current_metadata_summary, current_metadata_correlation_id,
                 incoming_exists, incoming_path, incoming_object_id, incoming_content_kind,
                 incoming_blob_sha256, incoming_updated_at_ms, incoming_latest_moment_id,
                 incoming_metadata_origin, incoming_metadata_summary, incoming_metadata_correlation_id
             ) VALUES (
                 'ws', 'a-full', 'full.md', 'main', 'feature',
                 101, 102, 'resolved', 'incoming', '',
                 'merge', 'summary-full', 'corr-full',
                 1, 'base.md', 'obj-base', 'binary',
                 'sha-base', 103, 'moment-base',
                 'sync', 'base-summary', 'base-corr',
                 1, 'cur.md', 'obj-cur', 'binary',
                 'sha-cur', 104, 'moment-cur',
                 'user', 'cur-summary', 'cur-corr',
                 1, 'inc.md', 'obj-inc', 'binary',
                 'sha-inc', 105, 'moment-inc',
                 'agent', 'inc-summary', 'inc-corr'
             );
             INSERT INTO conflicts (
                 workspace_id, conflict_id, path, target_version_id, source_version_id,
                 created_at_ms, updated_at_ms, status, chosen_from, resolution,
                 metadata_origin,
                 base_exists, base_path, base_content_kind,
                 current_exists, current_path, current_content_kind,
                 incoming_exists, incoming_path, incoming_content_kind
             ) VALUES (
                 'ws', 'b-null-kinds', 'nulls.md', 'main', 'feature',
                 201, 202, 'open', 'current', NULL,
                 'sync',
                 0, 'nulls.md', NULL,
                 0, 'nulls.md', NULL,
                 0, 'nulls.md', NULL
             );
             INSERT INTO conflicts (
                 workspace_id, conflict_id, path, target_version_id, source_version_id,
                 created_at_ms, updated_at_ms, status, chosen_from, resolution,
                 metadata_origin,
                 base_exists, base_path, current_exists, current_path,
                 incoming_exists, incoming_path
             ) VALUES (
                 'ws', 'c-defaults', 'defaults.md', 'main', 'feature',
                 301, 302, 'open', 'current', NULL,
                 'sync',
                 0, 'defaults.md', 0, 'defaults.md', 0, 'defaults.md'
             );",
        )
        .expect("seed ordinal-8 conflicts");
        let before = dump_conflict_rows(&conn);
        assert_eq!(before.len(), 3);

        let outcome = run_migrations(&mut conn, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults)
            .expect("apply binary conflict-side migration");
        assert_eq!(outcome, MigrationOutcome::Applied { newly_applied: 1 });

        let after = dump_conflict_rows(&conn);
        assert_eq!(after.len(), before.len());
        let new_columns = [
            "base_binary_sha256",
            "current_binary_sha256",
            "incoming_binary_sha256",
        ];
        for (before_row, after_row) in before.iter().zip(&after) {
            assert_eq!(
                after_row.len(),
                before_row.len() + new_columns.len(),
                "rebuild must add exactly the three binary columns"
            );
            for (name, value) in before_row {
                let migrated = after_row
                    .iter()
                    .find(|(after_name, _)| after_name == name)
                    .map(|(_, after_value)| after_value);
                assert_eq!(
                    migrated,
                    Some(value),
                    "column {name} must survive the rebuild value-for-value"
                );
            }
            for name in new_columns {
                let added = after_row
                    .iter()
                    .find(|(after_name, _)| after_name == name)
                    .map(|(_, after_value)| after_value);
                assert_eq!(
                    added,
                    Some(&rusqlite::types::Value::Null),
                    "new column {name} must initialize NULL"
                );
            }
        }
        // The re-default trap, stated explicitly: row b's explicit NULL kinds
        // stay NULL instead of picking up the column DEFAULT during the copy.
        let null_kinds: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT base_content_kind, current_content_kind, incoming_content_kind,
                        resolution
                 FROM conflicts WHERE conflict_id = 'b-null-kinds'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("null-kind row");
        assert_eq!(null_kinds, (None, None, None, None));
        let empty_resolution: Option<String> = conn
            .query_row(
                "SELECT resolution FROM conflicts WHERE conflict_id = 'a-full'",
                [],
                |row| row.get(0),
            )
            .expect("empty resolution");
        assert_eq!(empty_resolution, Some(String::new()));

        let binary_fks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('conflicts')
                 WHERE \"table\" = 'binary_blobs'",
                [],
                |row| row.get(0),
            )
            .expect("binary conflict foreign keys");
        assert_eq!(binary_fks, 3);
        let index_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
                 AND name = 'idx_conflicts_workspace_status'",
                [],
                |row| row.get(0),
            )
            .expect("conflicts index");
        assert_eq!(index_present, 1);
        let max_ordinal: i64 = conn
            .query_row("SELECT MAX(ordinal) FROM engine_migrations", [], |row| {
                row.get(0)
            })
            .expect("latest migration ordinal");
        assert_eq!(max_ordinal, 9);

        // Idempotency: a second run has nothing to apply and changes nothing.
        let rerun = run_migrations(&mut conn, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults)
            .expect("rerun is a no-op");
        assert_eq!(rerun, MigrationOutcome::Applied { newly_applied: 0 });
        assert_eq!(dump_conflict_rows(&conn), after);
    }

    #[test]
    fn binary_conflict_sides_migration_rolls_back_when_fk_revalidation_fails() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_800);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");

        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..9], &ctx, &NoFaults)
            .expect("migrate through ordinal 8");
        // Seed a latent dangling text-blob reference the way a corrupted store
        // would carry one: written while FK enforcement was off.
        conn.pragma_update(None, "foreign_keys", false)
            .expect("disable foreign keys");
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
             VALUES ('ws', 'main');
             INSERT INTO conflicts (
                 workspace_id, conflict_id, path, target_version_id, source_version_id,
                 created_at_ms, updated_at_ms, status, chosen_from, resolution,
                 metadata_origin,
                 base_exists, base_path, base_blob_sha256,
                 current_exists, current_path, incoming_exists, incoming_path
             ) VALUES (
                 'ws', 'dangling', 'note.md', 'main', 'feature',
                 10, 11, 'open', 'current', NULL,
                 'sync',
                 1, 'note.md', 'sha-missing',
                 0, 'note.md', 0, 'note.md'
             );",
        )
        .expect("seed dangling ordinal-8 conflict");
        conn.pragma_update(None, "foreign_keys", true)
            .expect("re-enable foreign keys");

        // The ordinal-9 rebuild re-validates the row's FKs and must fail
        // closed, rolling the store back to intact v8.
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults)
            .expect_err("dangling blob reference must abort the rebuild");
        let has_new_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('conflicts')
                 WHERE name = 'base_binary_sha256'",
                [],
                |row| row.get(0),
            )
            .expect("v8 conflicts schema");
        assert_eq!(has_new_column, 0, "rollback must restore the v8 table");
        let orphan_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'conflicts_v9'",
                [],
                |row| row.get(0),
            )
            .expect("no orphan rebuild table");
        assert_eq!(orphan_table, 0);
        let index_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
                 AND name = 'idx_conflicts_workspace_status'",
                [],
                |row| row.get(0),
            )
            .expect("v8 conflicts index");
        assert_eq!(index_present, 1);
        let row_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conflicts WHERE conflict_id = 'dangling'",
                [],
                |row| row.get(0),
            )
            .expect("seeded row survives rollback");
        assert_eq!(row_present, 1);
        let max_ordinal: i64 = conn
            .query_row("SELECT MAX(ordinal) FROM engine_migrations", [], |row| {
                row.get(0)
            })
            .expect("ledger after rollback");
        assert_eq!(max_ordinal, 8);

        // Remediation: restore the missing blob and the upgrade goes through.
        conn.execute(
            "INSERT INTO blobs (sha256, byte_length, text) VALUES ('sha-missing', 4, 'body')",
            [],
        )
        .expect("restore missing blob");
        let outcome = run_migrations(&mut conn, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults)
            .expect("remediated store migrates cleanly");
        assert_eq!(outcome, MigrationOutcome::Applied { newly_applied: 1 });
        let migrated: (String, Option<String>) = conn
            .query_row(
                "SELECT base_blob_sha256, base_binary_sha256
                 FROM conflicts WHERE conflict_id = 'dangling'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("migrated row");
        assert_eq!(migrated, ("sha-missing".to_owned(), None));
    }

    #[test]
    fn fresh_store_reaches_path_aliases_object_index_migration() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_900);
        let mut conn = open_bare(&path);

        let outcome = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults)
            .expect("apply baseline through the deferred Y.Doc coordinates table");
        assert_eq!(outcome, MigrationOutcome::Applied { newly_applied: 13 });
        let max_ordinal: i64 = conn
            .query_row("SELECT MAX(ordinal) FROM engine_migrations", [], |row| {
                row.get(0)
            })
            .expect("latest migration ordinal");
        assert_eq!(max_ordinal, 12);
        let index_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' \
                 AND name = 'idx_path_aliases_workspace_object'",
                [],
                |row| row.get(0),
            )
            .expect("reverse alias index");
        assert_eq!(index_present, 1);
    }

    #[test]
    fn path_aliases_object_index_migration_upgrades_existing_store() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_900);
        let mut conn = open_bare(&path);

        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults)
            .expect("migrate through ordinal 10");
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' \
                 AND name = 'idx_path_aliases_workspace_object'",
                [],
                |row| row.get(0),
            )
            .expect("index absent before ordinal 11");
        assert_eq!(before, 0);

        let outcome = run_migrations(&mut conn, BASELINE_MIGRATIONS, &ctx, &NoFaults)
            .expect("apply reverse alias index migration");
        assert_eq!(outcome, MigrationOutcome::Applied { newly_applied: 2 });
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_info('idx_path_aliases_workspace_object') ORDER BY seqno")
            .expect("prepare reverse alias index columns")
            .query_map([], |row| row.get(0))
            .expect("query reverse alias index columns")
            .collect::<rusqlite::Result<_>>()
            .expect("collect reverse alias index columns");
        assert_eq!(columns, ["workspace_id", "object_id"]);
        let max_ordinal: i64 = conn
            .query_row("SELECT MAX(ordinal) FROM engine_migrations", [], |row| {
                row.get(0)
            })
            .expect("latest migration ordinal");
        assert_eq!(max_ordinal, 12);
    }

    #[test]
    fn binary_head_migration_preserves_every_v9_column() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_900);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");

        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults)
            .expect("migrate through ordinal 9");
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
             VALUES ('ws', 'main');
             INSERT INTO versions (
                 workspace_id, version_id, kind, name, created_at_ms,
                 fork_version_id, fork_moment_id
             ) VALUES ('ws', 'main', 'main', 'Main', 101, NULL, NULL);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms)
             VALUES ('ws', 'object-full', 102), ('ws', 'object-null', 103);
             INSERT INTO blobs (sha256, byte_length, text)
             VALUES ('sha-after', 10, 'after text'), ('sha-before', 11, 'before text');
             INSERT INTO snapshots (
                 workspace_id, version_id, object_id, path, blob_sha256,
                 updated_at_ms, latest_moment_id, metadata_origin
             ) VALUES (
                 'ws', 'main', 'object-full', 'snapshot.md', 'sha-after',
                 201, 'moment-full', 'user'
             );
             INSERT INTO fork_base_snapshots (
                 workspace_id, version_id, object_id, path, blob_sha256,
                 updated_at_ms, latest_moment_id, metadata_origin
             ) VALUES (
                 'ws', 'main', 'object-null', 'fork.md', 'sha-before',
                 202, 'moment-fork', 'sync'
             );
             INSERT INTO moments (
                 workspace_id, moment_order, moment_id, version_id, object_id,
                 path, recorded_at_ms, operation, after_blob_sha256,
                 before_present, before_blob_sha256, metadata_origin,
                 author_json, sync_record_only, before_latest_moment_id
             ) VALUES (
                 'ws', 7, 'moment-full', 'main', 'object-full',
                 'moment.md', 203, 'write', 'sha-after',
                 2, 'sha-before', 'agent',
                 '{\"name\":\"Ada\"}', 1, 'moment-before'
             );",
        )
        .expect("seed ordinal-9 head rows");

        let before_snapshots = dump_table_rows(&conn, "snapshots");
        let before_fork_bases = dump_table_rows(&conn, "fork_base_snapshots");
        let before_moments = dump_table_rows(&conn, "moments");

        let outcome = run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults)
            .expect("apply binary-head migration");
        assert_eq!(outcome, MigrationOutcome::Applied { newly_applied: 1 });

        let cases = [
            (
                "snapshots",
                before_snapshots,
                vec![("content_kind", "text"), ("binary_sha256", "")],
            ),
            (
                "fork_base_snapshots",
                before_fork_bases,
                vec![("content_kind", "text"), ("binary_sha256", "")],
            ),
            (
                "moments",
                before_moments,
                vec![
                    ("after_content_kind", "text"),
                    ("after_binary_sha256", ""),
                    ("before_content_kind", "text"),
                    ("before_binary_sha256", ""),
                ],
            ),
        ];
        for (table, before, added_columns) in cases {
            let after = dump_table_rows(&conn, table);
            assert_eq!(after.len(), before.len());
            for (before_row, after_row) in before.iter().zip(&after) {
                assert_eq!(
                    after_row.len(),
                    before_row.len() + added_columns.len(),
                    "{table} rebuild must add only its binary-head columns"
                );
                for (name, value) in before_row {
                    let migrated = after_row
                        .iter()
                        .find(|(after_name, _)| after_name == name)
                        .map(|(_, after_value)| after_value);
                    assert_eq!(
                        migrated,
                        Some(value),
                        "{table}.{name} must survive value-for-value"
                    );
                }
                for (name, expected) in &added_columns {
                    let added = after_row
                        .iter()
                        .find(|(after_name, _)| after_name == name)
                        .map(|(_, value)| value);
                    let expected = if expected.is_empty() {
                        rusqlite::types::Value::Null
                    } else {
                        rusqlite::types::Value::Text((*expected).to_owned())
                    };
                    assert_eq!(added, Some(&expected), "unexpected {table}.{name}");
                }
            }
        }

        let moment_indexes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name IN (
                     'idx_moments_workspace_order',
                     'idx_moments_version_order',
                     'idx_moments_object_order'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("moments indexes");
        assert_eq!(moment_indexes, 3);
    }

    #[test]
    fn binary_head_migration_rolls_back_when_fk_revalidation_fails() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_900);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");

        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults)
            .expect("migrate through ordinal 9");
        conn.pragma_update(None, "foreign_keys", false)
            .expect("disable foreign keys");
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
             VALUES ('ws', 'main');
             INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms)
             VALUES ('ws', 'main', 'main', 'Main', 1);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms)
             VALUES ('ws', 'object', 2);
             INSERT INTO moments (
                 workspace_id, moment_order, moment_id, version_id, object_id,
                 path, recorded_at_ms, operation, after_blob_sha256,
                 before_present, metadata_origin
             ) VALUES (
                 'ws', 1, 'moment', 'main', 'object', 'note.md', 3,
                 'write', 'sha-missing', 1, 'user'
             );",
        )
        .expect("seed dangling ordinal-9 moment");
        conn.pragma_update(None, "foreign_keys", true)
            .expect("re-enable foreign keys");

        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults)
            .expect_err("dangling blob reference must abort all three rebuilds");
        for (table, column) in [
            ("snapshots", "content_kind"),
            ("fork_base_snapshots", "content_kind"),
            ("moments", "after_content_kind"),
        ] {
            let has_new_column: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                    rusqlite::params![table, column],
                    |row| row.get(0),
                )
                .expect("v9 table schema");
            assert_eq!(has_new_column, 0, "rollback must restore v9 {table}");
        }
        let orphan_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN (
                    'snapshots_v10', 'fork_base_snapshots_v10', 'moments_v10'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("no orphan rebuild tables");
        assert_eq!(orphan_tables, 0);
        let moment_indexes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name IN (
                     'idx_moments_workspace_order',
                     'idx_moments_version_order',
                     'idx_moments_object_order'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("v9 moments indexes");
        assert_eq!(moment_indexes, 3);
        let max_ordinal: i64 = conn
            .query_row("SELECT MAX(ordinal) FROM engine_migrations", [], |row| {
                row.get(0)
            })
            .expect("ledger after rollback");
        assert_eq!(max_ordinal, 9);

        conn.execute(
            "INSERT INTO blobs (sha256, byte_length, text) VALUES ('sha-missing', 4, 'body')",
            [],
        )
        .expect("restore missing blob");
        let outcome = run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults)
            .expect("remediated store migrates cleanly");
        assert_eq!(outcome, MigrationOutcome::Applied { newly_applied: 1 });
    }

    // ===================== ADVERSARIAL REVIEW PROBES (BINHEAD) =====================
    // Ported verbatim from the migration reviewer's worktree as permanent
    // regressions for the ordinal-10 binary-head migration.

    /// Helper: open + migrate a fresh store all the way to ordinal 10 with FKs on.
    fn open_migrated_v10(path: &std::path::Path) -> Connection {
        let ctx = MigrationContext::current(1_900);
        let mut conn = open_bare(path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults)
            .expect("migrate to ordinal 10");
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id)
             VALUES ('ws', 'main');
             INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms)
             VALUES ('ws', 'main', 'main', 'Main', 1);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms)
             VALUES ('ws', 'obj', 2);
             INSERT INTO binary_blobs (sha256, byte_length, bytes)
             VALUES ('bin-real', 3, x'aabbcc');",
        )
        .expect("seed parents");
        conn
    }

    /// PROBE: after v10 the NOT-NULL was actually lifted — a binary snapshot
    /// with NULL text blob but a real binary_sha256 must INSERT cleanly.
    #[test]
    fn probe_v10_permits_null_text_blob_for_binary_rows() {
        let dir = tempdir();
        let conn = open_migrated_v10(&dir.join("engine.db"));

        conn.execute(
            "INSERT INTO snapshots (
                 workspace_id, version_id, object_id, path, blob_sha256,
                 updated_at_ms, latest_moment_id, metadata_origin,
                 content_kind, binary_sha256
             ) VALUES ('ws','main','obj','p.png', NULL, 9, 'm', 'user', 'binary', 'bin-real')",
            [],
        )
        .expect("binary snapshot with NULL text blob must be accepted post-v10");

        conn.execute(
            "INSERT INTO fork_base_snapshots (
                 workspace_id, version_id, object_id, path, blob_sha256,
                 updated_at_ms, latest_moment_id, metadata_origin,
                 content_kind, binary_sha256
             ) VALUES ('ws','main','obj','p.png', NULL, 9, 'm', 'user', 'binary', 'bin-real')",
            [],
        )
        .expect("binary fork_base with NULL text blob must be accepted post-v10");

        conn.execute(
            "INSERT INTO moments (
                 workspace_id, moment_order, moment_id, version_id, object_id, path,
                 recorded_at_ms, operation, after_blob_sha256, before_present,
                 metadata_origin, after_content_kind, after_binary_sha256
             ) VALUES ('ws', 1, 'mm', 'main', 'obj', 'p.png', 3, 'write',
                 NULL, 1, 'user', 'binary', 'bin-real')",
            [],
        )
        .expect("binary moment with NULL after_blob_sha256 must be accepted post-v10");
    }

    /// PROBE: the NEW binary_sha256 -> binary_blobs FKs are actually ENFORCED
    /// (a dangling reference is rejected) and a valid one is accepted.
    #[test]
    fn probe_v10_binary_sha256_fk_is_enforced() {
        let dir = tempdir();
        let conn = open_migrated_v10(&dir.join("engine.db"));

        // Dangling binary ref on snapshots -> rejected.
        let err = conn.execute(
            "INSERT INTO snapshots (
                 workspace_id, version_id, object_id, path, blob_sha256,
                 updated_at_ms, latest_moment_id, metadata_origin,
                 content_kind, binary_sha256
             ) VALUES ('ws','main','obj','p.png', NULL, 9, 'm', 'user', 'binary', 'ghost')",
            [],
        );
        assert!(
            err.is_err(),
            "dangling snapshots.binary_sha256 must be rejected"
        );

        // Dangling binary ref on moments (both after + before) -> rejected.
        let err = conn.execute(
            "INSERT INTO moments (
                 workspace_id, moment_order, moment_id, version_id, object_id, path,
                 recorded_at_ms, operation, after_blob_sha256, before_present,
                 metadata_origin, after_binary_sha256
             ) VALUES ('ws', 1, 'mm', 'main', 'obj', 'p.png', 3, 'write',
                 NULL, 1, 'user', 'ghost')",
            [],
        );
        assert!(
            err.is_err(),
            "dangling moments.after_binary_sha256 must be rejected"
        );

        let err = conn.execute(
            "INSERT INTO moments (
                 workspace_id, moment_order, moment_id, version_id, object_id, path,
                 recorded_at_ms, operation, after_blob_sha256, before_present,
                 metadata_origin, before_binary_sha256
             ) VALUES ('ws', 2, 'mm2', 'main', 'obj', 'p.png', 3, 'write',
                 NULL, 1, 'user', 'ghost')",
            [],
        );
        assert!(
            err.is_err(),
            "dangling moments.before_binary_sha256 must be rejected"
        );

        // Valid binary ref -> accepted.
        conn.execute(
            "INSERT INTO moments (
                 workspace_id, moment_order, moment_id, version_id, object_id, path,
                 recorded_at_ms, operation, after_blob_sha256, before_present,
                 metadata_origin, after_content_kind, after_binary_sha256
             ) VALUES ('ws', 3, 'mm3', 'main', 'obj', 'p.png', 3, 'write',
                 NULL, 1, 'user', 'binary', 'bin-real')",
            [],
        )
        .expect("valid binary ref must be accepted");
    }

    /// PROBE: foreign_key_check is clean after the whole rebuild, and the
    /// migrated schema is byte-identical to a freshly created v10 store for
    /// all three tables (column defs + indexes + STRICT).
    #[test]
    fn probe_v10_schema_matches_fresh_and_fk_check_clean() {
        // Migrated store: through v9, seed a row, then to v10.
        let dir_m = tempdir();
        let ctx = MigrationContext::current(1_900);
        let mut migrated = open_bare(&dir_m.join("m.db"));
        migrated
            .pragma_update(None, "foreign_keys", true)
            .expect("fk on");
        run_migrations(&mut migrated, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults)
            .expect("through v9");
        migrated
            .execute_batch(
                "INSERT INTO versioned_workspaces (workspace_id, main_version_id) VALUES ('ws','main');
                 INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms)
                 VALUES ('ws','main','main','Main',1);
                 INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES ('ws','obj',2);
                 INSERT INTO blobs (sha256, byte_length, text) VALUES ('b', 1, 'x');
                 INSERT INTO snapshots (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, latest_moment_id, metadata_origin)
                 VALUES ('ws','main','obj','p', 'b', 3, 'm', 'user');
                 INSERT INTO moments (workspace_id, moment_order, moment_id, version_id, object_id, path, recorded_at_ms, operation, after_blob_sha256, before_present, metadata_origin)
                 VALUES ('ws', 1, 'm', 'main', 'obj', 'p', 3, 'write', 'b', 1, 'user');",
            )
            .expect("seed v9");
        run_migrations(&mut migrated, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults).expect("to v10");

        // foreign_key_check must be clean.
        let fk_violations: i64 = migrated
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .expect("fk check");
        assert_eq!(
            fk_violations, 0,
            "foreign_key_check must be clean after rebuild"
        );

        // Fresh store straight to v10.
        let dir_f = tempdir();
        let mut fresh = open_bare(&dir_f.join("f.db"));
        fresh
            .pragma_update(None, "foreign_keys", true)
            .expect("fk on");
        run_migrations(&mut fresh, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults).expect("fresh v10");

        for table in ["snapshots", "fork_base_snapshots", "moments"] {
            // Column definitions (name, type, notnull, dflt, pk) must match.
            let cols = |c: &Connection| -> Vec<(i64, String, String, i64, Option<String>, i64)> {
                let mut stmt = c
                    .prepare(&format!("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('{table}') ORDER BY cid"))
                    .unwrap();
                stmt.query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
            };
            assert_eq!(
                cols(&migrated),
                cols(&fresh),
                "{table} column defs must match fresh"
            );

            // FK list must match.
            let fks = |c: &Connection| -> Vec<(String, String, String)> {
                let mut stmt = c
                    .prepare(&format!("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list('{table}') ORDER BY \"table\", \"from\""))
                    .unwrap();
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap()
            };
            assert_eq!(
                fks(&migrated),
                fks(&fresh),
                "{table} FK list must match fresh"
            );

            // Index list (name + unique + origin) must match.
            let idx = |c: &Connection| -> Vec<(String, i64, String)> {
                let mut stmt = c
                    .prepare(&format!("SELECT name, \"unique\", origin FROM pragma_index_list('{table}') ORDER BY name"))
                    .unwrap();
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap()
            };
            assert_eq!(
                idx(&migrated),
                idx(&fresh),
                "{table} index list must match fresh"
            );

            // STRICT flag must match (sqlite_schema.sql retains the keyword).
            let sql: String = migrated
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(
                sql.to_uppercase().contains("STRICT"),
                "{table} must remain STRICT"
            );
        }
    }

    /// PROBE: v9 -> v10 is idempotent — re-running the full baseline is a no-op
    /// that changes no rows.
    #[test]
    fn probe_v10_is_idempotent() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_900);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("fk on");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults).expect("to v10");
        let before = dump_table_rows(&conn, "moments");
        let rerun = run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults)
            .expect("rerun no-op");
        assert_eq!(rerun, MigrationOutcome::Applied { newly_applied: 0 });
        assert_eq!(dump_table_rows(&conn, "moments"), before);
        let max_ordinal: i64 = conn
            .query_row("SELECT MAX(ordinal) FROM engine_migrations", [], |r| {
                r.get(0)
            })
            .expect("ordinal");
        assert_eq!(max_ordinal, 10);
    }

    /// PROBE: NULL nullable columns (author_json, sync_record_only,
    /// before_blob_sha256) round-trip as NULL, not defaulted/dropped.
    #[test]
    fn probe_v10_null_nullable_columns_round_trip() {
        let dir = tempdir();
        let path = dir.join("engine.db");
        let ctx = MigrationContext::current(1_900);
        let mut conn = open_bare(&path);
        conn.pragma_update(None, "foreign_keys", true)
            .expect("fk on");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..10], &ctx, &NoFaults).expect("v9");
        conn.execute_batch(
            "INSERT INTO versioned_workspaces (workspace_id, main_version_id) VALUES ('ws','main');
             INSERT INTO versions (workspace_id, version_id, kind, name, created_at_ms)
             VALUES ('ws','main','main','Main',1);
             INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES ('ws','obj',2);
             INSERT INTO blobs (sha256, byte_length, text) VALUES ('b', 1, 'x');
             INSERT INTO moments (
                 workspace_id, moment_order, moment_id, version_id, object_id, path,
                 recorded_at_ms, operation, after_blob_sha256, before_present, metadata_origin
             ) VALUES ('ws', 1, 'm', 'main', 'obj', 'p', 3, 'write', 'b', 1, 'user');",
        )
        .expect("seed moment with NULL author_json/sync_record_only/before_blob_sha256");
        run_migrations(&mut conn, &BASELINE_MIGRATIONS[..11], &ctx, &NoFaults).expect("v10");
        let (author, sync_only, before_blob): (Option<String>, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT author_json, sync_record_only, before_blob_sha256 FROM moments WHERE moment_id='m'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("read back");
        assert_eq!(author, None, "NULL author_json must stay NULL");
        assert_eq!(sync_only, None, "NULL sync_record_only must stay NULL");
        assert_eq!(before_blob, None, "NULL before_blob_sha256 must stay NULL");
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
        // (3), the search migration (4), the moment-link migration (5), the
        // sync migration (6), conflicts migration (7), shadow-clone migration
        // (8), binary-conflict-sides migration (9), binary-head migration (10),
        // reverse alias index migration (11), deferred Y.Doc coordinates
        // migration (12), AND the probe (13).
        let mut conn = open_bare(&path);
        let out = run_migrations(&mut conn, &migrations, &ctx, &NoFaults).expect("resume");
        assert_eq!(out, MigrationOutcome::Applied { newly_applied: 13 });
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
            ordinal: 13,
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
            ordinal: 13,
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
            ordinal: 13,
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
        // The counter is what makes this unique, NOT the clock: Windows'
        // SystemTime granularity is coarse (~0.5-15ms), so two tests entering
        // this function in the same tick used to get the SAME directory and
        // share one engine.db. That produced a rare "table engine_migrations
        // already exists" failure that only ever reproduced under the full
        // parallel suite, never in isolation.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let mut base = std::env::temp_dir();
        let unique = format!(
            "dohc-r04-mig-{}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
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
