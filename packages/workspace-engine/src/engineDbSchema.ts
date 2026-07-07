// THE engine.db schema bootstrap (single owner). versionedTextStore and
// linkedChatStore open the SAME `.dohc/engine/engine.db` file over separate
// WAL connections, and whichever opens first creates the schema. Keeping the
// DDL and validation in ONE module means the two stores can never drift into
// creating incompatible databases (a drift had already started: the chat
// store's private DDL copy lacked `active_versions`).
//
// First-open concurrency: two brand-new opens can race (a second window, or
// the chat store beside the text store). The DDL is idempotent
// (IF NOT EXISTS + INSERT OR IGNORE) inside one immediate transaction, so the
// loser waits on the winner's lock, no-ops, and falls through to validation —
// "table already exists" is never misread as corruption.

export const ENGINE_SCHEMA_VERSION = 1;
export const ENGINE_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface EngineSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

export interface EngineSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): EngineSqliteStatement;
  close(): void;
  // node:sqlite DatabaseSync exposes this; optional so narrow test doubles
  // remain assignable. Undefined reads as "open".
  readonly isOpen?: boolean;
}

export type EngineIntegrityCheckMode = "quick" | "full";

// Test-only handle bookkeeping. Windows cannot delete files with open handles,
// so test teardowns must close every engine DB handle before removing a temp
// workspace root. Production closes handles through each store's close()
// seam; this registry only tracks handles while running under a test harness
// (guard below), so production behavior on every platform is unchanged.
const trackedEngineDbHandlesForTest = new Set<{ close(): void; readonly isOpen?: boolean }>();

function isTestHarness(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

export function trackEngineDbHandleForTest<T extends { close(): void; readonly isOpen?: boolean }>(
  db: T,
): T {
  if (!isTestHarness()) return db;
  trackedEngineDbHandlesForTest.add(db);
  const originalClose = db.close.bind(db);
  db.close = () => {
    // Untrack only once actually closed: a close() that throws leaves the
    // handle registered so the next sweep can retry it.
    originalClose();
    trackedEngineDbHandlesForTest.delete(db);
  };
  return db;
}

// Closes every still-open engine DB handle. Safe between tests: the stores'
// lazy openers check isOpen, so a store whose handle was swept reopens (and
// re-validates) on its next use instead of returning a dead handle.
export function closeTrackedEngineDbHandlesForTest(): void {
  for (const db of [...trackedEngineDbHandlesForTest]) {
    try {
      db.close();
    } catch {
      // Either already closed or genuinely stuck; decided below.
    }
    // Keep genuinely still-open handles registered for a later retry; drop
    // everything else (isOpen undefined means a test double — drop it too).
    if (db.isOpen !== true) trackedEngineDbHandlesForTest.delete(db);
  }
}

const REQUIRED_ENGINE_TABLES = [
  "schema_version",
  "blobs",
  "versioned_workspaces",
  "versions",
  "file_objects",
  "path_aliases",
  "snapshots",
  "fork_base_snapshots",
  "moments",
  "conflicts",
  "chat_threads",
  "chat_messages",
] as const;

// active_versions is a lazy additive upgrade (PR 0M-4): stores created before
// active-version tracking gain the table on open instead of a schema-version
// bump — older readers ignore it, and a missing row still reads as "main is
// active". It is therefore NOT in REQUIRED_ENGINE_TABLES.
const ACTIVE_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS active_versions (
    workspace_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL
  )
`;

// Binary-backed file contents are a lazy additive upgrade (WS-G1): the
// existing `blobs.text NOT NULL` table remains the text store of record, and
// in-cap binary bytes live here keyed by the same sha256 convention. The
// content-kind columns below decide which blob table a snapshot/moment/
// conflict sha points at; older rows default to text.
const BINARY_BLOBS_DDL = `
  CREATE TABLE IF NOT EXISTS binary_blobs (
    sha256 TEXT PRIMARY KEY,
    byte_length INTEGER NOT NULL,
    content BLOB NOT NULL
  )
`;

// Secret-backed files (PR 08) are the same lazy additive upgrade pattern:
// stores created before the secret driver gain the tables on open, and a
// missing table simply reads as "no secret files yet". NOT in
// REQUIRED_ENGINE_TABLES for that reason.
//
// SECURITY INVARIANT: these tables hold AES-256-GCM ciphertext (base64) and
// metadata ONLY. There is no plaintext column, no plaintext digest column,
// and moments carry no content payload beyond the encrypted after-state used
// for restore. Any schema change that would add plaintext here is a secret
// boundary violation.
const SECRET_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS secret_files (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    path TEXT NOT NULL,
    iv_base64 TEXT NOT NULL,
    auth_tag_base64 TEXT NOT NULL,
    ciphertext_base64 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    updated_at_ms REAL NOT NULL,
    latest_moment_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version_id, path)
  );
  CREATE TABLE IF NOT EXISTS secret_fork_bases (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    path TEXT NOT NULL,
    iv_base64 TEXT NOT NULL,
    auth_tag_base64 TEXT NOT NULL,
    ciphertext_base64 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id, path)
  );
  CREATE TABLE IF NOT EXISTS secret_moments (
    workspace_id TEXT NOT NULL,
    moment_order INTEGER NOT NULL,
    moment_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    path TEXT NOT NULL,
    recorded_at_ms REAL NOT NULL,
    operation TEXT NOT NULL,
    metadata_origin TEXT NOT NULL,
    metadata_summary TEXT,
    metadata_correlation_id TEXT,
    after_present INTEGER NOT NULL,
    after_iv_base64 TEXT,
    after_auth_tag_base64 TEXT,
    after_ciphertext_base64 TEXT,
    after_byte_length INTEGER,
    PRIMARY KEY (workspace_id, moment_id),
    UNIQUE (workspace_id, moment_order)
  );
  CREATE INDEX IF NOT EXISTS idx_secret_moments_version_order
    ON secret_moments(workspace_id, version_id, moment_order);
  CREATE INDEX IF NOT EXISTS idx_secret_moments_path_order
    ON secret_moments(workspace_id, version_id, path, moment_order)
`;

// Sync replication metadata is a lazy additive upgrade (0P-A): existing
// engine.db files gain origin identity, local op journal, and per-peer
// high-water marks on open without a schema-version bump. NOT in
// REQUIRED_ENGINE_TABLES because older readers ignore these tables.
export const SYNC_REPLICATION_DDL = `
  CREATE TABLE IF NOT EXISTS sync_identity (
    workspace_id TEXT PRIMARY KEY,
    origin_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS replication_log (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    op_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    recorded_at_ms REAL NOT NULL,
    PRIMARY KEY (workspace_id, origin_id, origin_seq)
  );
  CREATE INDEX IF NOT EXISTS idx_replication_log_order
    ON replication_log(workspace_id, recorded_at_ms, origin_id, origin_seq);
  CREATE TABLE IF NOT EXISTS replication_peers (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    acked_seq INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, origin_id)
  );
  CREATE TABLE IF NOT EXISTS sync_relay_cursors (
    workspace_id TEXT PRIMARY KEY,
    relay_fetch_cursor INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_relay_push_state (
    workspace_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    pushed_seq INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, origin_id)
  )
`;

// Y.Doc engine content-driver tables are the same lazy additive upgrade
// (WS-G2-B): existing engine.db files gain them on open without a schema-
// version bump, and a file with NO ydoc_docs row stays an ordinary text file
// with zero behavior change. Not in REQUIRED_ENGINE_TABLES for that reason.
//
// Filed under (workspace_id, version_id, object_id) because versions are
// independent content lines. Update and snapshot BYTES are content-addressed
// into the existing binary_blobs table (the load-bearing reuse: Y.Doc state
// then replicates through the identical blob-have/blob-put path the 0P relay
// ships, deduped for free) — these tables hold only the sha references + head
// pointers.
//
// MARKDOWN-IS-THE-ARTIFACT (G2-B decision): the settled .md file is the
// durable/canonical artifact; the update log is a fast-resume cache that a
// closed session may prune to a single snapshot. The schema is deliberately
// ADDITIVE-COMPATIBLE with a future persistent-threads layer: keeping
// ydoc_snapshots (and un-pruned ydoc_updates) durable past a closed session —
// so live suggestion threads / marks survive a close — needs NO schema change,
// only a policy flip in the driver's compaction/close path.
export const ENGINE_YDOC_DDL = `
  CREATE TABLE IF NOT EXISTS ydoc_docs (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    content_kind TEXT NOT NULL DEFAULT 'richdoc',
    head_update_seq INTEGER NOT NULL DEFAULT 0,
    head_snapshot_seq INTEGER NOT NULL DEFAULT 0,
    updated_at_ms REAL NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id)
  );
  CREATE TABLE IF NOT EXISTS ydoc_updates (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    update_blob_sha256 TEXT NOT NULL,
    actor_origin_id TEXT,
    recorded_at_ms REAL NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id, seq),
    FOREIGN KEY (update_blob_sha256) REFERENCES binary_blobs(sha256)
  );
  CREATE INDEX IF NOT EXISTS idx_ydoc_updates_doc_seq
    ON ydoc_updates(workspace_id, version_id, object_id, seq);
  CREATE TABLE IF NOT EXISTS ydoc_snapshots (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    up_to_seq INTEGER NOT NULL,
    snapshot_blob_sha256 TEXT NOT NULL,
    state_vector_blob_sha256 TEXT NOT NULL,
    recorded_at_ms REAL NOT NULL,
    PRIMARY KEY (workspace_id, version_id, object_id, up_to_seq),
    FOREIGN KEY (snapshot_blob_sha256) REFERENCES binary_blobs(sha256),
    FOREIGN KEY (state_vector_blob_sha256) REFERENCES binary_blobs(sha256)
  );
  CREATE INDEX IF NOT EXISTS idx_ydoc_snapshots_doc_uptoseq
    ON ydoc_snapshots(workspace_id, version_id, object_id, up_to_seq DESC)
`;

// Search index tables are lazy additive (WS-D): existing engine.db files gain
// them on open without a schema-version bump. The FTS tables store only
// currently searchable text; write-time policy hooks delete rows for secret,
// ignored, untracked, or non-searchable paths instead of indexing them.
export const ENGINE_SEARCH_INDEX_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS engine_search_files_fts USING fts5(
    workspace_id UNINDEXED,
    version_id UNINDEXED,
    object_id UNINDEXED,
    path UNINDEXED,
    text,
    tokenize='trigram'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS engine_search_chat_messages_fts USING fts5(
    workspace_id UNINDEXED,
    thread_id UNINDEXED,
    message_id UNINDEXED,
    text,
    tokenize='trigram'
  );
  CREATE TABLE IF NOT EXISTS engine_search_index_state (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    indexed_at_ms REAL NOT NULL,
    PRIMARY KEY (workspace_id, version_id)
  )
`;

// Chat channels + per-thread read cursors (PR 12, WS-E) are the same lazy
// additive pattern: stores created before channels gain the tables on open,
// and a missing row reads as "no channels yet" / "nothing read yet". NOT in
// REQUIRED_ENGINE_TABLES for that reason. The slug unique index makes the
// lookup alias collision-safe per workspace; durable rows key on channel_id.
const CHAT_CHANNEL_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS chat_channels (
    workspace_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at_ms REAL NOT NULL,
    updated_at_ms REAL NOT NULL,
    PRIMARY KEY (workspace_id, channel_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_slug
    ON chat_channels(workspace_id, slug);
  CREATE TABLE IF NOT EXISTS chat_thread_read_state (
    workspace_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    last_read_sequence INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    updated_at_ms REAL NOT NULL,
    PRIMARY KEY (workspace_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS chat_channel_wire_ids (
    workspace_id TEXT NOT NULL,
    wire_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, wire_id)
  )
`;

// chat_threads.channel_id is a lazy additive nullable column (the
// moments.author_json pattern): older readers select named columns and ignore
// it; an older writer leaves it NULL (a file-linked thread — the pre-PR-12
// truth, since createThread has always required a linked file in practice).
// Exactly-one-owner with linked_object_id is enforced by the store, which
// fails closed on rows carrying both owners, neither owner, or a channel_id
// whose channel row no longer exists.
function ensureChatThreadsChannelColumn(
  db: EngineSqliteDb,
  corrupt: (cause?: unknown) => Error,
): void {
  const hasChannelColumn = () =>
    db
      .prepare("PRAGMA table_info(chat_threads)")
      .all()
      .some((row) => String(row.name) === "channel_id");
  if (!hasChannelColumn()) {
    try {
      db.exec("ALTER TABLE chat_threads ADD COLUMN channel_id TEXT");
    } catch (error) {
      // Two first-opens can race the ALTER; the loser sees "duplicate column".
      if (!hasChannelColumn()) throw corrupt(error);
    }
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chat_threads_channel
       ON chat_threads(workspace_id, channel_id, updated_at_ms, thread_id)`,
  );
}

// moments.author_json is a lazy additive upgrade (PR 0N-1, same pattern as
// active_versions): a nullable column added on open, no schema-version bump.
// Safe because it is additive-nullable both ways — older readers select named
// columns and ignore it, and an older writer's explicit column list simply
// leaves it NULL (an unattributed moment is actor-neutral, the pre-0N truth).
function ensureMomentsAuthorColumn(
  db: EngineSqliteDb,
  corrupt: (cause?: unknown) => Error,
): void {
  const hasAuthorColumn = () =>
    db
      .prepare("PRAGMA table_info(moments)")
      .all()
      .some((row) => String(row.name) === "author_json");
  if (hasAuthorColumn()) return;
  try {
    db.exec("ALTER TABLE moments ADD COLUMN author_json TEXT");
  } catch (error) {
    // Two first-opens can race the ALTER; the loser sees "duplicate column".
    // Re-check instead of parsing the message: present now means the winner
    // added it, anything else is a real failure.
    if (!hasAuthorColumn()) throw corrupt(error);
  }
}

function ensureNullableColumn(
  db: EngineSqliteDb,
  table: string,
  column: string,
  definition: string,
  corrupt: (cause?: unknown) => Error,
): void {
  const hasColumn = () =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => String(row.name) === column);
  if (hasColumn()) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // Same first-open race posture as author_json: re-check the schema state
    // instead of parsing driver-specific duplicate-column messages.
    if (!hasColumn()) throw corrupt(error);
  }
}

function ensureBinaryContentKindColumns(
  db: EngineSqliteDb,
  corrupt: (cause?: unknown) => Error,
): void {
  ensureNullableColumn(db, "snapshots", "content_kind", "TEXT DEFAULT 'text'", corrupt);
  ensureNullableColumn(db, "fork_base_snapshots", "content_kind", "TEXT DEFAULT 'text'", corrupt);
  ensureNullableColumn(db, "moments", "payload_before_content_kind", "TEXT DEFAULT 'text'", corrupt);
  ensureNullableColumn(db, "moments", "payload_after_content_kind", "TEXT DEFAULT 'text'", corrupt);
  ensureNullableColumn(db, "moments", "before_content_kind", "TEXT DEFAULT 'text'", corrupt);
  ensureNullableColumn(db, "conflicts", "base_content_kind", "TEXT DEFAULT 'text'", corrupt);
  ensureNullableColumn(db, "conflicts", "current_content_kind", "TEXT DEFAULT 'text'", corrupt);
  ensureNullableColumn(db, "conflicts", "incoming_content_kind", "TEXT DEFAULT 'text'", corrupt);
}

// moments.sync_record_only is a lazy additive sync upgrade (0P-A round 2):
// nullable/0 means the moment was applied to the materialized file state; 1
// means the row is a persistent divergence history record and must not count
// as the local head. Older readers select named columns and ignore it; older
// writers leave it NULL, which correctly means "applied".
function ensureMomentsSyncRecordOnlyColumn(
  db: EngineSqliteDb,
  corrupt: (cause?: unknown) => Error,
): void {
  const hasRecordOnlyColumn = () =>
    db
      .prepare("PRAGMA table_info(moments)")
      .all()
      .some((row) => String(row.name) === "sync_record_only");
  if (hasRecordOnlyColumn()) return;
  try {
    db.exec("ALTER TABLE moments ADD COLUMN sync_record_only INTEGER");
  } catch (error) {
    if (!hasRecordOnlyColumn()) throw corrupt(error);
  }
}

function listUserTables(db: EngineSqliteDb): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name));
}

export function initializeOrValidateEngineSchema(
  db: EngineSqliteDb,
  corrupt: (cause?: unknown) => Error,
): void {
  // One snapshot read decides which path we are on: a fresh database creates
  // the schema, anything with schema_version validates, and a database with
  // foreign tables but no schema_version fails closed as corrupt.
  const tables = listUserTables(db);
  if (!tables.includes("schema_version")) {
    if (tables.length > 0) throw corrupt();
    createEngineSchema(db);
  }
  const version = db.prepare("SELECT version FROM schema_version WHERE id = 1").get();
  if (Number(version?.version) !== ENGINE_SCHEMA_VERSION) throw corrupt();
  assertRequiredEngineTables(db, corrupt);
  db.exec(ACTIVE_VERSIONS_DDL);
  db.exec(BINARY_BLOBS_DDL);
  db.exec(SECRET_TABLES_DDL);
  db.exec(SYNC_REPLICATION_DDL);
  db.exec(ENGINE_YDOC_DDL);
  db.exec(ENGINE_SEARCH_INDEX_DDL);
  db.exec(CHAT_CHANNEL_TABLES_DDL);
  ensureMomentsAuthorColumn(db, corrupt);
  ensureMomentsSyncRecordOnlyColumn(db, corrupt);
  // versions.sync_materialized (lazy additive, 0P-A gate fix): 1 marks a
  // version whose fork state was materialized from a replicated
  // version.create payload rather than local snapshot lineage. Hydration
  // validation exempts such versions from fork-point lineage inference (their
  // seeded snapshot heads may reference record-only peer history). NULL/0 —
  // the older-writer truth — means locally created.
  ensureNullableColumn(db, "versions", "sync_materialized", "INTEGER", corrupt);
  ensureChatThreadsChannelColumn(db, corrupt);
  ensureBinaryContentKindColumns(db, corrupt);
}

export function assertRequiredEngineTables(
  db: EngineSqliteDb,
  corrupt: (cause?: unknown) => Error,
): void {
  const names = new Set(listUserTables(db));
  for (const table of REQUIRED_ENGINE_TABLES) {
    if (!names.has(table)) throw corrupt();
  }
}

// Integrity policy (decided at the PR 0M-7 arc gate): `quick_check` on every
// open. The full `integrity_check` is O(entire database) and this runs on
// every cold store instantiation, which would grow linearly with the
// append-only moment history; quick_check still catches the corruption
// classes that matter here (malformed pages, broken b-trees) without reading
// every blob. The full scan stays available for diagnostics via
// VersionedTextStoreOptions.integrityCheck = "full".
export function assertEngineSqliteIntegrity(
  db: EngineSqliteDb,
  corrupt: (cause?: unknown) => Error,
  mode: EngineIntegrityCheckMode = "quick",
): void {
  const pragma = mode === "full" ? "integrity_check" : "quick_check";
  const rows = db.prepare(`PRAGMA ${pragma}`).all();
  if (rows.length !== 1 || String(rows[0]?.[pragma]) !== "ok") {
    throw corrupt();
  }
}

// Idempotent by construction so a lost first-open race is harmless; the
// enclosing immediate transaction keeps a crash mid-create atomic.
export function createEngineSchema(db: EngineSqliteDb): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        byte_length INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      ${BINARY_BLOBS_DDL};
      CREATE TABLE IF NOT EXISTS versioned_workspaces (
        workspace_id TEXT PRIMARY KEY,
        main_version_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        workspace_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at_ms REAL NOT NULL,
        fork_version_id TEXT,
        fork_moment_id TEXT,
        PRIMARY KEY (workspace_id, version_id),
        FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS file_objects (
        workspace_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        created_at_ms REAL NOT NULL,
        PRIMARY KEY (workspace_id, object_id),
        UNIQUE (object_id),
        FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS path_aliases (
        workspace_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        path TEXT NOT NULL,
        object_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, version_id, path),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        workspace_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_kind TEXT DEFAULT 'text',
        blob_sha256 TEXT NOT NULL,
        updated_at_ms REAL NOT NULL,
        latest_moment_id TEXT NOT NULL,
        metadata_origin TEXT NOT NULL,
        metadata_summary TEXT,
        metadata_correlation_id TEXT,
        PRIMARY KEY (workspace_id, version_id, object_id),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
        FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE IF NOT EXISTS fork_base_snapshots (
        workspace_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_kind TEXT DEFAULT 'text',
        blob_sha256 TEXT NOT NULL,
        updated_at_ms REAL NOT NULL,
        latest_moment_id TEXT NOT NULL,
        metadata_origin TEXT NOT NULL,
        metadata_summary TEXT,
        metadata_correlation_id TEXT,
        PRIMARY KEY (workspace_id, version_id, object_id),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
        FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE IF NOT EXISTS moments (
        workspace_id TEXT NOT NULL,
        moment_order INTEGER NOT NULL,
        moment_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        path TEXT NOT NULL,
        recorded_at_ms REAL NOT NULL,
        operation TEXT NOT NULL,
        payload_before_path TEXT,
        payload_before_content_kind TEXT DEFAULT 'text',
        payload_before_blob_sha256 TEXT,
        payload_after_path TEXT NOT NULL,
        payload_after_content_kind TEXT DEFAULT 'text',
        payload_after_blob_sha256 TEXT NOT NULL,
        metadata_origin TEXT NOT NULL,
        metadata_summary TEXT,
        metadata_correlation_id TEXT,
        before_present INTEGER NOT NULL,
        before_object_id TEXT,
        before_version_id TEXT,
        before_path TEXT,
        before_content_kind TEXT DEFAULT 'text',
        before_blob_sha256 TEXT,
        before_updated_at_ms REAL,
        before_latest_moment_id TEXT,
        before_metadata_origin TEXT,
        before_metadata_summary TEXT,
        before_metadata_correlation_id TEXT,
        author_json TEXT,
        sync_record_only INTEGER,
        PRIMARY KEY (workspace_id, moment_id),
        UNIQUE (workspace_id, moment_order),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
        FOREIGN KEY (payload_before_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (payload_after_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (before_blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        workspace_id TEXT NOT NULL,
        conflict_id TEXT NOT NULL,
        path TEXT NOT NULL,
        target_version_id TEXT NOT NULL,
        source_version_id TEXT NOT NULL,
        created_at_ms REAL NOT NULL,
        updated_at_ms REAL NOT NULL,
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
        base_updated_at_ms REAL,
        base_latest_moment_id TEXT,
        base_metadata_origin TEXT,
        base_metadata_summary TEXT,
        base_metadata_correlation_id TEXT,
        current_exists INTEGER NOT NULL,
        current_path TEXT NOT NULL,
        current_object_id TEXT,
        current_content_kind TEXT DEFAULT 'text',
        current_blob_sha256 TEXT,
        current_updated_at_ms REAL,
        current_latest_moment_id TEXT,
        current_metadata_origin TEXT,
        current_metadata_summary TEXT,
        current_metadata_correlation_id TEXT,
        incoming_exists INTEGER NOT NULL,
        incoming_path TEXT NOT NULL,
        incoming_object_id TEXT,
        incoming_content_kind TEXT DEFAULT 'text',
        incoming_blob_sha256 TEXT,
        incoming_updated_at_ms REAL,
        incoming_latest_moment_id TEXT,
        incoming_metadata_origin TEXT,
        incoming_metadata_summary TEXT,
        incoming_metadata_correlation_id TEXT,
        PRIMARY KEY (workspace_id, conflict_id),
        FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
        FOREIGN KEY (base_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (current_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (incoming_blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE IF NOT EXISTS chat_threads (
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at_ms REAL NOT NULL,
        updated_at_ms REAL NOT NULL,
        linked_object_id TEXT,
        linked_path_hint TEXT,
        linked_at_ms REAL,
        PRIMARY KEY (workspace_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_order INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_display_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at_ms REAL NOT NULL,
        PRIMARY KEY (workspace_id, message_id),
        UNIQUE (workspace_id, thread_id, message_order),
        FOREIGN KEY (workspace_id, thread_id) REFERENCES chat_threads(workspace_id, thread_id) ON DELETE CASCADE
      );
      ${ACTIVE_VERSIONS_DDL};
      ${SECRET_TABLES_DDL};
      ${CHAT_CHANNEL_TABLES_DDL};
      ${SYNC_REPLICATION_DDL};
      ${ENGINE_YDOC_DDL};
      CREATE INDEX IF NOT EXISTS idx_versions_workspace_name ON versions(workspace_id, name);
      CREATE INDEX IF NOT EXISTS idx_versions_fork ON versions(workspace_id, fork_version_id, fork_moment_id);
      CREATE INDEX IF NOT EXISTS idx_path_aliases_object ON path_aliases(workspace_id, version_id, object_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_path ON snapshots(workspace_id, version_id, path);
      CREATE INDEX IF NOT EXISTS idx_fork_base_snapshots_path ON fork_base_snapshots(workspace_id, version_id, path);
      CREATE INDEX IF NOT EXISTS idx_moments_version_object_order ON moments(workspace_id, version_id, object_id, moment_order);
      CREATE INDEX IF NOT EXISTS idx_moments_version_order ON moments(workspace_id, version_id, moment_order);
      CREATE INDEX IF NOT EXISTS idx_moments_object_before ON moments(workspace_id, object_id, before_latest_moment_id);
      CREATE INDEX IF NOT EXISTS idx_conflicts_workspace_status ON conflicts(workspace_id, status, created_at_ms, conflict_id);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace_created ON chat_threads(workspace_id, created_at_ms, thread_id);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_linked_file ON chat_threads(workspace_id, linked_object_id, created_at_ms, thread_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_order ON chat_messages(workspace_id, thread_id, message_order);
      ${ENGINE_SEARCH_INDEX_DDL};
      INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ${ENGINE_SCHEMA_VERSION});
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
