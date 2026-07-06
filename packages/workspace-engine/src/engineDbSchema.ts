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
}

export type EngineIntegrityCheckMode = "quick" | "full";

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
  db.exec(SECRET_TABLES_DDL);
  db.exec(ENGINE_SEARCH_INDEX_DDL);
  db.exec(CHAT_CHANNEL_TABLES_DDL);
  ensureMomentsAuthorColumn(db, corrupt);
  ensureChatThreadsChannelColumn(db, corrupt);
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
        payload_before_blob_sha256 TEXT,
        payload_after_path TEXT NOT NULL,
        payload_after_blob_sha256 TEXT NOT NULL,
        metadata_origin TEXT NOT NULL,
        metadata_summary TEXT,
        metadata_correlation_id TEXT,
        before_present INTEGER NOT NULL,
        before_object_id TEXT,
        before_version_id TEXT,
        before_path TEXT,
        before_blob_sha256 TEXT,
        before_updated_at_ms REAL,
        before_latest_moment_id TEXT,
        before_metadata_origin TEXT,
        before_metadata_summary TEXT,
        before_metadata_correlation_id TEXT,
        author_json TEXT,
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
        base_blob_sha256 TEXT,
        base_updated_at_ms REAL,
        base_latest_moment_id TEXT,
        base_metadata_origin TEXT,
        base_metadata_summary TEXT,
        base_metadata_correlation_id TEXT,
        current_exists INTEGER NOT NULL,
        current_path TEXT NOT NULL,
        current_object_id TEXT,
        current_blob_sha256 TEXT,
        current_updated_at_ms REAL,
        current_latest_moment_id TEXT,
        current_metadata_origin TEXT,
        current_metadata_summary TEXT,
        current_metadata_correlation_id TEXT,
        incoming_exists INTEGER NOT NULL,
        incoming_path TEXT NOT NULL,
        incoming_object_id TEXT,
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
