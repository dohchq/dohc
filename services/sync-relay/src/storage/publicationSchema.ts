import type { SqliteDb } from "./types";
import { rebuildTables } from "./rebuildTables";

export function initializeAppPublicationSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_app_publications (
      publication_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      share_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      grant_generation INTEGER NOT NULL CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
      owner_user_id TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      authority_revision INTEGER NOT NULL CHECK (authority_revision BETWEEN 1 AND 9007199254740991),
      UNIQUE (publication_id, workspace_id),
      FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (grant_id, share_id) REFERENCES sync_relay_share_grants(grant_id, share_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, manifest_sha256) REFERENCES sync_relay_blobs(workspace_id, sha256)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_publication_approvals (
      publication_id TEXT NOT NULL REFERENCES sync_relay_app_publications(publication_id) ON DELETE CASCADE,
      authority_revision INTEGER NOT NULL,
      facts_json TEXT NOT NULL,
      PRIMARY KEY (publication_id, authority_revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_app_publication_blobs (
      publication_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY (publication_id, workspace_id, sha256),
      FOREIGN KEY (publication_id, workspace_id) REFERENCES sync_relay_app_publications(publication_id, workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, sha256) REFERENCES sync_relay_blobs(workspace_id, sha256)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_publication_blobs_workspace
      ON sync_relay_app_publication_blobs(workspace_id, sha256);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_publication_discovery
      ON sync_relay_app_publications(workspace_id, grant_id, grant_generation, active, publication_id);
  `);
  initializeMarkedTable(
    db,
    TAKEDOWN_MIGRATION,
    TAKEDOWN_TABLE,
    TAKEDOWN_SQL,
    "Publication takedown",
  );
  initializeMarkedTable(
    db,
    HOLD_MIGRATION,
    HOLD_TABLE,
    HOLD_SQL,
    "App publishing hold",
    HOLD_BACKFILL,
  );
}

const TAKEDOWN_MIGRATION = "app-publication-operator-takedowns-v1";
const TAKEDOWN_TABLE = "sync_relay_app_publication_takedowns";
const TAKEDOWN_SQL = `CREATE TABLE sync_relay_app_publication_takedowns (
  publication_id TEXT PRIMARY KEY REFERENCES sync_relay_app_publications(publication_id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (actor = 'operator'),
  disabled_at_ms INTEGER NOT NULL CHECK (disabled_at_ms BETWEEN 0 AND 9007199254740991),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024 AND length(CAST(reason AS BLOB)) <= 4096 AND instr(reason, char(0)) = 0)
) STRICT`;

const HOLD_MIGRATION = "app-publishing-holds-v1";
const HOLD_TABLE = "sync_relay_app_publishing_holds";
const HOLD_SQL = `CREATE TABLE sync_relay_app_publishing_holds (
  publication_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  held_at_ms INTEGER NOT NULL CHECK (held_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT`;
// Takedowns made before the hold existed hold their owners too.
const HOLD_BACKFILL = `INSERT INTO sync_relay_app_publishing_holds(publication_id,owner_user_id,held_at_ms)
  SELECT t.publication_id,p.owner_user_id,t.disabled_at_ms FROM sync_relay_app_publication_takedowns t
  JOIN sync_relay_app_publications p USING(publication_id)`;

export function initializeMarkedTable(
  db: SqliteDb,
  migration: string,
  table: string,
  sql: string,
  label: string,
  backfill?: string,
): void {
  const marked = db
    .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?")
    .get(migration);
  const existing = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name=? AND type='table'")
    .get(table);
  const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
  if (marked) {
    if (!existing || normalize(String(existing.sql)) !== normalize(sql))
      throw new Error(`${label} schema is missing or damaged.`);
    return;
  }
  if (existing) throw new Error(`Unmarked ${label.toLowerCase()} schema already exists.`);
  db.exec(sql);
  if (backfill) db.exec(backfill);
  db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES(?,?)").run(
    migration,
    Date.now(),
  );
}

const AUDIENCE_MIGRATION = "app-publication-audience-v1";
const PUBLICATIONS = "sync_relay_app_publications";
const AUDIENCE_SQL = `CREATE TABLE sync_relay_app_publications (
  publication_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  grant_id TEXT,
  grant_generation INTEGER CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
  owner_user_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  authority_revision INTEGER NOT NULL CHECK (authority_revision BETWEEN 1 AND 9007199254740991),
  audience TEXT NOT NULL DEFAULT 'link' CHECK (audience IN ('link', 'workspace')),
  CHECK ((audience = 'link') = (grant_id IS NOT NULL AND grant_generation IS NOT NULL)),
  UNIQUE (publication_id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id, share_id) REFERENCES sync_relay_share_grants(grant_id, share_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, manifest_sha256) REFERENCES sync_relay_blobs(workspace_id, sha256)
) STRICT`;

// A Workspace Publication reaches members through the workspace share, so it holds no link grant.
// Runs after every table that references publications exists.
export function initializeAppPublicationAudience(db: SqliteDb): void {
  const marked = db
    .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?")
    .get(AUDIENCE_MIGRATION);
  if (!marked) {
    rebuildTables(
      db,
      [
        PUBLICATIONS,
        "sync_relay_app_publication_approvals",
        "sync_relay_app_publication_blobs",
        TAKEDOWN_TABLE,
        "sync_relay_app_collection_approvals",
      ],
      (table, sql) => (table === PUBLICATIONS ? AUDIENCE_SQL : sql),
    );
    db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES(?,?)").run(
      AUDIENCE_MIGRATION,
      Date.now(),
    );
  }
  const owned = db
    .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?")
    .get(OWNER_MIGRATION);
  assertPublicationSchema(db, owned ? OWNER_SQL : AUDIENCE_SQL);
}

function assertPublicationSchema(db: SqliteDb, sql: string): void {
  const current = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name=? AND type='table'")
    .get(PUBLICATIONS);
  const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
  if (!current || normalize(String(current.sql)) !== normalize(sql))
    throw new Error("App publication schema is missing or damaged.");
}

const OWNER_MIGRATION = "app-publication-owner-audience-v1";
const OWNER_SQL = `CREATE TABLE sync_relay_app_publications (
  publication_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  share_id TEXT,
  grant_id TEXT,
  grant_generation INTEGER CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
  owner_user_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  authority_revision INTEGER NOT NULL CHECK (authority_revision BETWEEN 1 AND 9007199254740991),
  audience TEXT NOT NULL DEFAULT 'link' CHECK (audience IN ('link', 'workspace', 'owner')),
  app_root TEXT,
  replaced INTEGER NOT NULL DEFAULT 0 CHECK (replaced IN (0, 1)),
  CHECK ((audience = 'link') = (grant_id IS NOT NULL AND grant_generation IS NOT NULL)),
  CHECK ((audience = 'owner') = (share_id IS NULL)),
  CHECK ((audience = 'owner') = (app_root IS NOT NULL)),
  CHECK (replaced = 0 OR audience = 'owner'),
  UNIQUE (publication_id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id, share_id) REFERENCES sync_relay_share_grants(grant_id, share_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, manifest_sha256) REFERENCES sync_relay_blobs(workspace_id, sha256)
) STRICT`;

export function initializeOwnerAppPublications(db: SqliteDb): void {
  if (
    !db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(OWNER_MIGRATION)
  ) {
    rebuildTables(
      db,
      [
        PUBLICATIONS,
        "sync_relay_app_publication_approvals",
        "sync_relay_app_publication_blobs",
        TAKEDOWN_TABLE,
        "sync_relay_app_collection_approvals",
        "sync_relay_member_apps",
        "sync_relay_app_viewer_consents",
      ],
      (table, sql) => (table === PUBLICATIONS ? OWNER_SQL : sql),
    );
    db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES(?,?)").run(
      OWNER_MIGRATION,
      Date.now(),
    );
  }
  assertPublicationSchema(db, OWNER_SQL);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_relay_owner_publications
    ON ${PUBLICATIONS}(workspace_id, owner_user_id, app_root) WHERE audience = 'owner'`);
}
