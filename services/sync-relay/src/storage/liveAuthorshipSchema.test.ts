import {afterEach, expect, it} from "vitest";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  inspectDatabase,
  reopenTestStorage,
  storagePath,
  testHandler,
  testStorage,
  type InspectionDatabase,
} from "../testing";
import {
  assertLiveAuthorColumns,
  initializeLiveAuthorshipSchema,
  LIVE_AUTHOR_CLIENTS,
  LIVE_AUTHOR_COLUMNS,
  LIVE_AUTHOR_MIGRATION,
} from "./liveAuthorshipSchema";
import type {SqliteDb} from "./types";

afterEach(closeTestStorages);

const journal = "sync_relay_live_update_journal";
const triggers = ["live_author_client_usage_insert", "live_author_client_usage_delete", "live_author_log_usage_insert", "live_author_log_usage_delete"];
const marker = (db: InspectionDatabase) => db.prepare("SELECT * FROM sync_relay_migrations WHERE migration_id=?").get(LIVE_AUTHOR_MIGRATION);
const schemaSnapshot = (db: InspectionDatabase) => ({
  schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all(),
  migrations: db.prepare("SELECT * FROM sync_relay_migrations ORDER BY migration_id").all(),
});

async function closedDatabase() {
  const storage = await testStorage();
  const path = storagePath(storage);
  closeTestStorage(storage);
  return {path, db: inspectDatabase(path)};
}

function removeAuthorshipMigration(db: InspectionDatabase): void {
  // Recreate the pre-authorship store without the later hosted-publication extensions.
  db.exec("ALTER TABLE sync_relay_log DROP COLUMN relay_admission");
  for(const name of ["settlement_cut_usage_insert","settlement_cut_usage_delete","settlement_cut_journal_delete","settlement_binding_usage_insert","settlement_binding_usage_delete","settlement_admission_usage_insert","settlement_admission_usage_delete"])db.exec(`DROP TRIGGER ${name}`);
  db.exec("DROP TABLE sync_relay_live_settlement_bindings");db.exec("DROP TABLE sync_relay_live_settlement_cuts");
  db.exec("ALTER TABLE sync_relay_log DROP COLUMN settlement_admission_json");
  db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id='hosted-settlement-admission-v1'").run();
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger}`);
  db.exec(`DROP TABLE ${LIVE_AUTHOR_CLIENTS}`);
  for (const column of LIVE_AUTHOR_COLUMNS) db.exec(`ALTER TABLE ${journal} DROP COLUMN ${column.split(" ")[0]}`);
  db.exec("ALTER TABLE sync_relay_log DROP COLUMN admitted_author_snapshot_json");
  db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(LIVE_AUTHOR_MIGRATION);
}

function replaceSchemaSql(db: InspectionDatabase, name: string, before: string, after: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name);
  expect(typeof row?.sql).toBe("string");
  const sql = String(row!.sql);
  expect(sql).toContain(before);
  const children = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all(name);
  expect(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()?.count).toBe(0);
  db.exec(`DROP TABLE ${name}`);
  db.exec(sql.replace(before, after));
  for (const child of children) db.exec(String(child.sql));
}

it("installs the exact v2 marker and preserves it when reopening", async () => {
  const {path, db} = await closedDatabase();
  expect(LIVE_AUTHOR_MIGRATION).toBe("relay-admitted-authors-v2");
  const before = marker(db);
  expect(before).toEqual({migration_id: "relay-admitted-authors-v2", completed_at_ms: expect.any(Number)});
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'live_author_%' ORDER BY name").all().map(row => row.name)).toEqual([...triggers].sort());
  db.close();
  closeTestStorage(reopenTestStorage(path));
  const check = inspectDatabase(path);
  expect(marker(check)).toEqual(before);
});

it("upgrades an existing v1 row with canonical version 1 and no attributed author", async () => {
  const storage = await testStorage();
  await claimWorkspace(testHandler(storage), "owner", "workspace");
  const path = storagePath(storage);
  closeTestStorage(storage);
  const db = inspectDatabase(path);
  removeAuthorshipMigration(db);
  db.exec(`CREATE TABLE sync_relay_live_update_agent_declarations (journal_cursor INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, on_behalf_of TEXT, depth INTEGER NOT NULL) STRICT`);
  db.prepare("INSERT INTO sync_relay_migrations VALUES (?,1)").run("live-update-agent-declarations-v1");
  db.prepare(`INSERT INTO ${journal} (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
    current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,accepting_host_epoch,
    received_at_ms,update_bytes,relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes)
    VALUES (?,?,?,'main',?,?,?,'["notes.md"]',0,'owner','owner',1,1,?,'namespace',1,?,1)`)
    .run("old-delivery", "a".repeat(64), "workspace", "object", "b".repeat(64), "notes.md", new Uint8Array([1]), "c".repeat(64));
  const before = db.prepare(`SELECT * FROM ${journal}`).get();
  db.close();
  closeTestStorage(reopenTestStorage(path));
  const check = inspectDatabase(path);
  expect(check.prepare(`SELECT * FROM ${journal}`).get()).toEqual({...before, canonical_version: 1,
    author_context_json: null, author_snapshot_json: null, first_seen_deletes_json: "[]", checkpoint_coverage_json: null, seed_first_seen_json: "[]"});
  expect(marker(check)?.migration_id).toBe(LIVE_AUTHOR_MIGRATION);
  expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_live_update_agent_declarations'").get()).toBeUndefined();
});

it("refuses declared v1 relay evidence before migration and preserves its rows and schema", async () => {
  const {path, db} = await closedDatabase();
  removeAuthorshipMigration(db);
  db.exec(`CREATE TABLE sync_relay_live_update_agent_declarations (journal_cursor INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, on_behalf_of TEXT, depth INTEGER NOT NULL) STRICT`);
  db.prepare("INSERT INTO sync_relay_migrations VALUES (?,1)").run("live-update-agent-declarations-v1");
  db.prepare("INSERT INTO sync_relay_live_update_agent_declarations VALUES (1,?,?,2)").run("trip-agent-ü", "人");
  const before = schemaSnapshot(db);
  const rows = db.prepare("SELECT * FROM sync_relay_live_update_agent_declarations").all();
  db.close();
  expect(() => reopenTestStorage(path)).toThrow("Cannot open a relay store with declared v1 accepted evidence. Its data is unchanged.");
  const check = inspectDatabase(path);
  expect(schemaSnapshot(check)).toEqual(before);
  expect(check.prepare("SELECT * FROM sync_relay_live_update_agent_declarations").all()).toEqual(rows);
});

it("refuses a missing marker without adopting or repairing migrated objects", async () => {
  const {path, db} = await closedDatabase();
  db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(LIVE_AUTHOR_MIGRATION);
  const before = schemaSnapshot(db);
  expect(() => initializeLiveAuthorshipSchema(db as SqliteDb)).toThrow("live author schema is missing or damaged");
  db.close();
  expect(() => reopenTestStorage(path)).toThrow(/schema is missing or damaged/);
  expect(schemaSnapshot(inspectDatabase(path))).toEqual(before);
});

it.each([LIVE_AUTHOR_CLIENTS, ...triggers])("refuses missing migrated object %s", async name => {
  const {path, db} = await closedDatabase();
  db.exec(`DROP ${name === LIVE_AUTHOR_CLIENTS ? "TABLE" : "TRIGGER"} ${name}`);
  const before = schemaSnapshot(db);
  db.close();
  expect(() => reopenTestStorage(path)).toThrow("live author schema is missing or damaged");
  expect(schemaSnapshot(inspectDatabase(path))).toEqual(before);
});

it.each(triggers)("refuses changed quota trigger %s", async name => {
  const {path, db} = await closedDatabase();
  const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql);
  db.exec(`DROP TRIGGER ${name}`);
  db.exec(sql.replace("UPDATE sync_relay_workspace_usage", "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes WHERE workspace_id='unrelated'; UPDATE sync_relay_workspace_usage"));
  db.close();
  expect(() => reopenTestStorage(path)).toThrow("live author schema is missing or damaged");
});

it.each(LIVE_AUTHOR_COLUMNS)("requires the exact migrated column constraint: %s", async column => {
  const {path, db} = await closedDatabase();
  replaceSchemaSql(db, journal, column, column.slice(0, column.indexOf(" CHECK ")));
  expect(() => assertLiveAuthorColumns(db as SqliteDb)).toThrow("live author schema is missing or damaged");
  db.close();
  expect(() => reopenTestStorage(path)).toThrow(/schema is missing or damaged/);
});

it("requires the log snapshot JSON constraint and exact column shape", async () => {
  const {path, db} = await closedDatabase();
  replaceSchemaSql(db, "sync_relay_log", "admitted_author_snapshot_json TEXT CHECK (admitted_author_snapshot_json IS NULL OR json_valid(admitted_author_snapshot_json))", "admitted_author_snapshot_json TEXT");
  db.close();
  expect(() => reopenTestStorage(path)).toThrow("live author schema is missing or damaged");
});

it("requires the exact client table constraints", async () => {
  const {path, db} = await closedDatabase();
  replaceSchemaSql(db, LIVE_AUTHOR_CLIENTS, "CHECK (storage_bytes > 0)", "CHECK (storage_bytes >= 0)");
  db.close();
  expect(() => reopenTestStorage(path)).toThrow("live author schema is missing or damaged");
});

it("preserves the original v1 journal constraint checks after stripping migration columns", async () => {
  const {path, db} = await closedDatabase();
  replaceSchemaSql(db, journal, "CHECK (journal_cursor BETWEEN 1 AND 9007199254740991)", "CHECK (journal_cursor BETWEEN 0 AND 9007199254740991)");
  db.close();
  expect(() => reopenTestStorage(path)).toThrow("live update journal schema is missing or damaged");
});

it("rolls back all migration objects, columns and earlier repairs if writing the marker fails", async () => {
  const {path, db} = await closedDatabase();
  removeAuthorshipMigration(db);
  db.exec(`DROP INDEX idx_sync_relay_log_page;
    CREATE TRIGGER refuse_live_author_marker BEFORE INSERT ON sync_relay_migrations
    WHEN NEW.migration_id='relay-admitted-authors-v2' BEGIN SELECT RAISE(ABORT,'marker write refused'); END`);
  const before = schemaSnapshot(db);
  db.close();
  expect(() => reopenTestStorage(path)).toThrow("marker write refused");
  const check = inspectDatabase(path);
  expect(schemaSnapshot(check)).toEqual(before);
  expect(check.prepare(`PRAGMA table_info(${journal})`).all()).toHaveLength(24);
  expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(LIVE_AUTHOR_CLIENTS)).toBeUndefined();
});
