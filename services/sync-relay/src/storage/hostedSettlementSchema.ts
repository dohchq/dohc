import type { SqliteDb } from "./types";
export const SETTLEMENT_CUTS = "sync_relay_live_settlement_cuts";
export const SETTLEMENT_BINDINGS = "sync_relay_live_settlement_bindings";
export const SETTLEMENT_SCHEMA_MARKER = "hosted-settlement-admission-v1";
const digest = (name: string) =>
  `${name} TEXT NOT NULL CHECK(length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const admissionColumn =
  "settlement_admission_json TEXT CHECK(settlement_admission_json IS NULL OR json_valid(settlement_admission_json))";
const schema: Record<string, string> = {
  [SETTLEMENT_CUTS]: `CREATE TABLE ${SETTLEMENT_CUTS} (
    journal_cursor INTEGER PRIMARY KEY REFERENCES sync_relay_live_update_journal(journal_cursor) ON DELETE CASCADE,
    ${digest("state_sha256")},
    ${digest("markdown_sha256")},
    state_byte_length INTEGER NOT NULL CHECK(state_byte_length BETWEEN 1 AND 20971520),
    markdown_byte_length INTEGER NOT NULL CHECK(markdown_byte_length BETWEEN 0 AND 2097152)
  ) STRICT`,
  [SETTLEMENT_BINDINGS]: `CREATE TABLE ${SETTLEMENT_BINDINGS} (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    main_version_id TEXT NOT NULL CHECK(main_version_id='main'),
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    restore_fence INTEGER NOT NULL CHECK(restore_fence>=0),
    previous_cursor INTEGER NOT NULL CHECK(previous_cursor>=0),
    terminal_cursor INTEGER NOT NULL CHECK(terminal_cursor>previous_cursor),
    settlement_id TEXT NOT NULL,
    moment_id TEXT NOT NULL,
    ${digest("record_digest")},
    ${digest("state_sha256")},
    ${digest("markdown_sha256")},
    origin_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK(origin_seq>=0),
    storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
    PRIMARY KEY(workspace_id,main_version_id,object_id,lineage_claim_id,terminal_cursor),
    UNIQUE(workspace_id,settlement_id),
    UNIQUE(workspace_id,moment_id)
  ) STRICT`,
  settlement_cut_usage_insert: `CREATE TRIGGER settlement_cut_usage_insert AFTER INSERT ON ${SETTLEMENT_CUTS}
    BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+144
      WHERE workspace_id=(SELECT workspace_id FROM sync_relay_live_update_journal WHERE journal_cursor=NEW.journal_cursor);
    END`,
  settlement_cut_usage_delete: `CREATE TRIGGER settlement_cut_usage_delete BEFORE DELETE ON ${SETTLEMENT_CUTS}
    BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-144
      WHERE workspace_id=(SELECT workspace_id FROM sync_relay_live_update_journal WHERE journal_cursor=OLD.journal_cursor);
    END`,
  settlement_cut_journal_delete: `CREATE TRIGGER settlement_cut_journal_delete BEFORE DELETE ON sync_relay_live_update_journal
    BEGIN
      DELETE FROM ${SETTLEMENT_CUTS} WHERE journal_cursor=OLD.journal_cursor;
    END`,
  settlement_binding_usage_insert: `CREATE TRIGGER settlement_binding_usage_insert AFTER INSERT ON ${SETTLEMENT_BINDINGS}
    BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes WHERE workspace_id=NEW.workspace_id;
    END`,
  settlement_binding_usage_delete: `CREATE TRIGGER settlement_binding_usage_delete AFTER DELETE ON ${SETTLEMENT_BINDINGS}
    BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id;
    END`,
  settlement_admission_usage_insert: `CREATE TRIGGER settlement_admission_usage_insert AFTER INSERT ON sync_relay_log
    WHEN NEW.settlement_admission_json IS NOT NULL
    BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+length(CAST(NEW.settlement_admission_json AS BLOB))
      WHERE workspace_id=NEW.workspace_id;
    END`,
  settlement_admission_usage_delete: `CREATE TRIGGER settlement_admission_usage_delete AFTER DELETE ON sync_relay_log
    WHEN OLD.settlement_admission_json IS NOT NULL
    BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-length(CAST(OLD.settlement_admission_json AS BLOB))
      WHERE workspace_id=OLD.workspace_id;
    END`,
};
const normalize = (sql: string) =>
  sql.trim().replace(/;$/, " ").replace(/\s+/g, " ").trim();
function require(value: unknown): asserts value {
  if (!value)
    throw new Error("Hosted settlement schema is missing or damaged.");
}
function assertSchema(db: SqliteDb) {
  for (const [name, sql] of Object.entries(schema)) {
    const actual = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name=?")
      .get(name);
    require(
      typeof actual?.sql === "string" &&
        normalize(actual.sql) === normalize(sql),
    );
  }
  const log = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='sync_relay_log'")
    .get();
  require(
    typeof log?.sql === "string" &&
      normalize(log.sql).includes(admissionColumn),
  );
  const column = db
    .prepare("PRAGMA table_info(sync_relay_log)")
    .all()
    .find((r) => r.name === "settlement_admission_json");
  require(
    column &&
      column.cid === 8 &&
      column.type === "TEXT" &&
      column.notnull === 0 &&
      column.dflt_value === null &&
      column.pk === 0,
  );
}
export function initializeHostedSettlementSchema(db: SqliteDb) {
  if (
    db
      .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?")
      .get(SETTLEMENT_SCHEMA_MARKER)
  ) {
    assertSchema(db);
    return;
  }
  require(
    db
      .prepare(
        `SELECT name FROM sqlite_schema WHERE name IN (${Object.keys(schema)
          .map(() => "?")
          .join(",")})`,
      )
      .all(...Object.keys(schema)).length === 0,
  );
  require(
    !db
      .prepare("PRAGMA table_info(sync_relay_log)")
      .all()
      .some((r) => r.name === "settlement_admission_json"),
  );
  db.exec("ALTER TABLE sync_relay_log ADD COLUMN " + admissionColumn);
  for (const sql of Object.values(schema)) db.exec(sql);
  assertSchema(db);
  db.prepare(
    "INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES(?,?)",
  ).run(SETTLEMENT_SCHEMA_MARKER, Date.now());
}
