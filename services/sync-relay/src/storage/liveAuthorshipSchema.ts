import type { SqliteDb } from "./types";

export const LIVE_AUTHOR_MIGRATION = "relay-admitted-authors-v2";
export const LIVE_AUTHOR_CLIENTS = "sync_relay_live_author_clients";
export const LIVE_AUTHOR_COLUMNS = [
  "canonical_version INTEGER NOT NULL DEFAULT 1 CHECK (canonical_version IN (1,2))",
  "author_context_json TEXT CHECK (author_context_json IS NULL OR json_valid(author_context_json))",
  "author_snapshot_json TEXT CHECK (author_snapshot_json IS NULL OR json_valid(author_snapshot_json))",
  "first_seen_deletes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(first_seen_deletes_json))",
  "checkpoint_coverage_json TEXT CHECK (checkpoint_coverage_json IS NULL OR json_valid(checkpoint_coverage_json))",
  "seed_first_seen_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(seed_first_seen_json))",
] as const;
const logColumn = "admitted_author_snapshot_json TEXT CHECK (admitted_author_snapshot_json IS NULL OR json_valid(admitted_author_snapshot_json))";
const clientSql = `CREATE TABLE ${LIVE_AUTHOR_CLIENTS} (
  workspace_id TEXT NOT NULL, main_version_id TEXT NOT NULL, object_id TEXT NOT NULL, lineage_claim_id TEXT NOT NULL,
  client_id INTEGER NOT NULL CHECK (client_id BETWEEN 0 AND 9007199254740991),
  author_snapshot_json TEXT NOT NULL CHECK (json_valid(author_snapshot_json)),
  storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
  PRIMARY KEY (workspace_id,main_version_id,object_id,lineage_claim_id,client_id),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`;
const triggerSql = {
  live_author_client_usage_insert: `CREATE TRIGGER live_author_client_usage_insert AFTER INSERT ON ${LIVE_AUTHOR_CLIENTS} BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes WHERE workspace_id=NEW.workspace_id; END`,
  live_author_client_usage_delete: `CREATE TRIGGER live_author_client_usage_delete AFTER DELETE ON ${LIVE_AUTHOR_CLIENTS} BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id; END`,
  live_author_log_usage_insert: `CREATE TRIGGER live_author_log_usage_insert AFTER INSERT ON sync_relay_log WHEN NEW.admitted_author_snapshot_json IS NOT NULL BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+length(CAST(NEW.admitted_author_snapshot_json AS BLOB)) WHERE workspace_id=NEW.workspace_id; END`,
  live_author_log_usage_delete: `CREATE TRIGGER live_author_log_usage_delete AFTER DELETE ON sync_relay_log WHEN OLD.admitted_author_snapshot_json IS NOT NULL BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-length(CAST(OLD.admitted_author_snapshot_json AS BLOB)) WHERE workspace_id=OLD.workspace_id; END`,
} as const;
const normalize = (sql: string) => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
function require(value: unknown): asserts value { if (!value) throw new Error("live author schema is missing or damaged"); }
function assertColumnSql(db: SqliteDb, table: string, definition: string): void {
  const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(table);
  require(row?.type === "table" && typeof row.sql === "string");
  const sql = normalize(row.sql), fragment = ", " + definition;
  const index = sql.indexOf(fragment);
  require(index >= 0);
  const rest = sql.slice(index + fragment.length).trimStart();
  require(rest.startsWith(",") || rest.startsWith(")"));
}
function assertObject(db: SqliteDb, name: string, type: string, table: string, sql: string): void {
  const rows = db.prepare("SELECT type,tbl_name,sql FROM sqlite_schema WHERE name=?").all(name);
  const row = rows[0];
  require(rows.length === 1 && row?.type === type && row.tbl_name === table &&
    typeof row.sql === "string" && normalize(row.sql) === normalize(sql));
}
export function originalLiveJournalSql(sql: string): string {
  let result = normalize(sql);
  for (const column of LIVE_AUTHOR_COLUMNS) result = result.replace(", " + column, "");
  return result;
}
export function liveAuthorSchemaMarked(db: SqliteDb): boolean {
  return !!db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(LIVE_AUTHOR_MIGRATION);
}
export function assertLiveAuthorColumns(db: SqliteDb): void {
  const columns = db.prepare("PRAGMA table_info(sync_relay_live_update_journal)").all().slice(24);
  const expected = [[24,"canonical_version","INTEGER",1,"1",0], [25,"author_context_json","TEXT",0,null,0],
    [26,"author_snapshot_json","TEXT",0,null,0], [27,"first_seen_deletes_json","TEXT",1,"'[]'",0],
    [28,"checkpoint_coverage_json","TEXT",0,null,0], [29,"seed_first_seen_json","TEXT",1,"'[]'",0]];
  require(JSON.stringify(columns.map(r => [r.cid,r.name,r.type,r.notnull,r.dflt_value,r.pk])) === JSON.stringify(expected));
  for (const column of LIVE_AUTHOR_COLUMNS) assertColumnSql(db, "sync_relay_live_update_journal", column);
}
function assertSchema(db: SqliteDb): void {
  assertLiveAuthorColumns(db);
  assertObject(db, LIVE_AUTHOR_CLIENTS, "table", LIVE_AUTHOR_CLIENTS, clientSql);
  const columns = db.prepare("PRAGMA table_info(sync_relay_log)").all().filter(r => Number(r.cid) >= 7 && r.name !== "settlement_admission_json" && r.name !== "relay_admission");
  require(JSON.stringify(columns.map(r => [r.cid,r.name,r.type,r.notnull,r.dflt_value,r.pk])) ===
    JSON.stringify([[7,"admitted_author_snapshot_json","TEXT",0,null,0]]));
  assertColumnSql(db, "sync_relay_log", logColumn);
  for (const [name, sql] of Object.entries(triggerSql)) {
    assertObject(db, name, "trigger", name.startsWith("live_author_client_") ? LIVE_AUTHOR_CLIENTS : "sync_relay_log", sql);
  }
}
export function initializeLiveAuthorshipSchema(db: SqliteDb): void {
  if (liveAuthorSchemaMarked(db)) { assertSchema(db); return; }
  const names = [LIVE_AUTHOR_CLIENTS, ...Object.keys(triggerSql)];
  require(db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(",")})`).all(...names).length === 0);
  require(!db.prepare("PRAGMA table_info(sync_relay_live_update_journal)").all().some(row =>
    LIVE_AUTHOR_COLUMNS.some(column => column.startsWith(String(row.name) + " "))));
  require(!db.prepare("PRAGMA table_info(sync_relay_log)").all().some(row => row.name === "admitted_author_snapshot_json"));
  for (const column of LIVE_AUTHOR_COLUMNS) db.exec("ALTER TABLE sync_relay_live_update_journal ADD COLUMN " + column);
  db.exec("ALTER TABLE sync_relay_log ADD COLUMN " + logColumn);
  db.exec(clientSql);
  for (const sql of Object.values(triggerSql)) db.exec(sql);
  assertSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(LIVE_AUTHOR_MIGRATION, Date.now());
}
