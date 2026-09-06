import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openSyncRelayStorage } from "./storage.js";

interface RawDatabase {
  close(): void;
  enableDefensive(active: boolean): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  };
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => RawDatabase;
};
const roots: string[] = [];
const marker = "live-document-authority-v1";
const documents = "sync_relay_live_documents";
const ranges = "sync_relay_live_document_baseline_ranges";
const currentIndex = "idx_sync_relay_live_documents_current";
const coverageIndex = "idx_sync_relay_live_document_baseline_coverage";
const objects = [documents, ranges, currentIndex, coverageIndex];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function raw<T>(path: string, inspect: (db: RawDatabase) => T): T {
  const db = new DatabaseSync(path);
  try { return inspect(db); } finally { db.close(); }
}
function reopen(path: string): void { openSyncRelayStorage(path).close(); }
async function database(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-live-authority-schema-"));
  roots.push(root);
  const path = join(root, "relay.sqlite");
  reopen(path);
  return path;
}
function schemaSnapshot(path: string): unknown {
  return raw(path, db => ({
    objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all(),
    migrations: db.prepare("SELECT * FROM sync_relay_migrations ORDER BY migration_id").all(),
  }));
}
function refusesWithoutRepair(path: string, reason: RegExp): void {
  const before = schemaSnapshot(path);
  expect(() => reopen(path)).toThrow(reason);
  expect(schemaSnapshot(path)).toEqual(before);
}
function removeAuthority(db: RawDatabase): void {
  db.exec(`DROP TABLE ${ranges}; DROP TABLE ${documents}`);
  db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?").run(marker);
}
// These rows exercise SQLite representability, not validated Yjs admission.
function baseline(db: RawDatabase, changed: Record<string, unknown> = {}): void {
  const row = {
    workspace_id: "workspace-1", main_version_id: "main", object_id: "object-1",
    lineage_claim_id: "a".repeat(64), replaces_lineage_claim_id: null, current_path: "docs/a.md",
    baseline_moment_relay_seq: 1, baseline_projected_sha256: "b".repeat(64),
    baseline_projected_byte_length: 0, baseline_digest: "a".repeat(64), baseline_bytes: new Uint8Array([0]),
    lineage_state: "current", admission_state: "open", restore_fence_generation: 0,
    registered_at_ms: 0, retired_at_ms: null, ...changed,
  };
  db.prepare(`INSERT INTO ${documents} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}
function workspace(db: RawDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, ?)")
    .run("workspace-1", "owner-1", 0);
}

it("creates the complete authority schema and reopens without changing its marker", async () => {
  const path = await database();
  raw(path, db => {
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?, ?) ORDER BY name").all(...objects)
      .map(row => row.name)).toEqual([...objects].sort());
    expect(db.prepare("SELECT completed_at_ms FROM sync_relay_migrations WHERE migration_id = ?").get(marker))
      .toEqual({ completed_at_ms: expect.any(Number) });
    expect(db.prepare(`PRAGMA table_info(${documents})`).all().map(row => row.name)).toEqual([
      "workspace_id", "main_version_id", "object_id", "lineage_claim_id", "replaces_lineage_claim_id",
      "current_path", "baseline_moment_relay_seq", "baseline_projected_sha256", "baseline_projected_byte_length",
      "baseline_digest", "baseline_bytes", "lineage_state", "admission_state", "restore_fence_generation",
      "registered_at_ms", "retired_at_ms",
    ]);
    expect(db.prepare(`PRAGMA table_info(${ranges})`).all().map(row => row.name)).toEqual([
      "workspace_id", "main_version_id", "object_id", "lineage_claim_id", "client_id", "start_clock", "end_clock",
    ]);
    expect(db.prepare(`PRAGMA index_list(${documents})`).all()).toContainEqual(expect.objectContaining({
      name: currentIndex, unique: 1, partial: 1,
    }));
    expect(db.prepare(`PRAGMA index_info(${coverageIndex})`).all().map(row => row.name)).toEqual([
      "workspace_id", "main_version_id", "object_id", "lineage_claim_id", "client_id", "start_clock", "end_clock",
    ]);
  });
  const before = schemaSnapshot(path);
  reopen(path);
  expect(schemaSnapshot(path)).toEqual(before);
});

it.each(objects)("refuses marked schema missing %s without repairing it", async name => {
  const path = await database();
  raw(path, db => db.exec(`DROP ${name.startsWith("idx_") ? "INDEX" : "TABLE"} ${name}`));
  refusesWithoutRepair(path, /authority schema is missing or damaged/);
});

it.each(objects)("refuses an unmarked reserved-name collision at %s without adoption", async name => {
  const path = await database();
  raw(path, db => {
    removeAuthority(db);
    db.exec(`CREATE VIEW ${name} AS SELECT 1 AS unrelated`);
  });
  refusesWithoutRepair(path, /unmarked live document authority schema/);
});

it("refuses a complete but unmarked authority schema", async () => {
  const path = await database();
  raw(path, db => db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?").run(marker));
  refusesWithoutRepair(path, /unmarked live document authority schema/);
});

it("refuses a persistent trigger that shares a reserved authority table name", async () => {
  const path = await database();
  raw(path, db => {
    db.exec(`CREATE TRIGGER ${documents} BEFORE INSERT ON ${documents}
      BEGIN SELECT RAISE(IGNORE); END`);
    expect(db.prepare("SELECT type FROM sqlite_schema WHERE name = ? ORDER BY type").all(documents))
      .toEqual([{ type: "table" }, { type: "trigger" }]);
  });
  refusesWithoutRepair(path, /authority schema is missing or damaged/);
});

it.each([
  [documents, "main_version_id = 'main'", "main_version_id = 'MAIN'"],
  [documents, "BETWEEN 0 AND 2097152", "BETWEEN 0 AND 2097153"],
  [documents, "BETWEEN 1 AND 20971520", "BETWEEN 1 AND 20971521"],
  [documents, "baseline_bytes BLOB", "baseline_bytes ANY"],
  [documents, "ON DELETE CASCADE", "ON DELETE RESTRICT"],
  [ranges, "ON DELETE CASCADE", "ON DELETE RESTRICT"],
  [ranges, ") STRICT", ")"],
])("refuses changed literal authority DDL: %s / %s", async (name, original, changed) => {
  const path = await database();
  raw(path, db => {
    const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name)?.sql);
    expect(sql).toContain(original);
    db.enableDefensive(false);
    try {
      db.exec("PRAGMA writable_schema = ON");
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = ?").run(sql.replace(original, changed), name);
    } finally {
      try { db.exec("PRAGMA writable_schema = OFF"); }
      finally { db.enableDefensive(true); }
    }
  });
  refusesWithoutRepair(path, /authority schema is missing or damaged/);
});

it.each([
  `DROP INDEX ${currentIndex}; CREATE INDEX ${currentIndex} ON ${documents}(workspace_id, main_version_id, object_id) WHERE lineage_state = 'current'`,
  `DROP INDEX ${currentIndex}; CREATE UNIQUE INDEX ${currentIndex} ON ${documents}(workspace_id, main_version_id, object_id)`,
  `DROP INDEX ${coverageIndex}; CREATE INDEX ${coverageIndex} ON ${ranges}(workspace_id, object_id, main_version_id, lineage_claim_id, client_id, start_clock, end_clock)`,
  `CREATE INDEX unexpected_authority_index ON ${documents}(registered_at_ms)`,
])("refuses damaged authority index metadata: %s", async sql => {
  const path = await database();
  raw(path, db => db.exec(sql));
  refusesWithoutRepair(path, /authority schema is missing or damaged/);
});

it("rolls authority schema creation back if its final marker write fails", async () => {
  const path = await database();
  raw(path, db => {
    removeAuthority(db);
    db.exec(`CREATE TRIGGER stop_authority_marker BEFORE INSERT ON sync_relay_migrations
      WHEN NEW.migration_id = '${marker}' BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema WHERE name IN
          ('${documents}', '${ranges}', '${currentIndex}', '${coverageIndex}')) <> 4
          THEN RAISE(ABORT, 'marker preceded authority objects') END;
        SELECT RAISE(ABORT, 'injected authority marker failure');
      END`);
  });
  refusesWithoutRepair(path, /injected authority marker failure/);
  raw(path, db => db.exec("DROP TRIGGER stop_authority_marker"));
  reopen(path);
});

it("enforces one current lineage and cascades authority ranges only with their workspace", async () => {
  const path = await database();
  raw(path, db => {
    workspace(db);
    baseline(db);
    expect(() => baseline(db, { lineage_claim_id: "c".repeat(64), baseline_digest: "c".repeat(64) })).toThrow();
    baseline(db, { lineage_claim_id: "c".repeat(64), baseline_digest: "c".repeat(64),
      lineage_state: "retired", admission_state: "closed", retired_at_ms: 1 });
    db.prepare(`INSERT INTO ${ranges} VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("workspace-1", "main", "object-1", "a".repeat(64), 0, 0, 1);
    expect(() => db.prepare(`INSERT INTO ${ranges} VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("workspace-1", "main", "other-object", "a".repeat(64), 0, 0, 1)).toThrow();
    expect(db.prepare(`SELECT count(*) AS count FROM ${documents}`).get()?.count).toBe(2);
  });
  reopen(path);
  raw(path, db => {
    db.exec("PRAGMA foreign_keys = ON");
    expect(db.prepare(`SELECT count(*) AS count FROM ${ranges}`).get()?.count).toBe(1);
    db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run("workspace-1");
    expect(db.prepare(`SELECT count(*) AS count FROM ${documents}`).get()?.count).toBe(0);
    expect(db.prepare(`SELECT count(*) AS count FROM ${ranges}`).get()?.count).toBe(0);
  });
  reopen(path);
});

it("keeps the frozen authority row constraints and representable boundaries", async () => {
  const path = await database();
  raw(path, db => {
    workspace(db);
    const invalid: Array<Record<string, unknown>> = [
      { object_id: "" }, { object_id: "x".repeat(513) }, { main_version_id: "fork" },
      { lineage_claim_id: "A".repeat(64) }, { lineage_claim_id: "c".repeat(64) },
      { replaces_lineage_claim_id: "a".repeat(64) }, { replaces_lineage_claim_id: "bad" },
      { current_path: "é".repeat(512) + "a" }, { baseline_moment_relay_seq: 0 },
      { baseline_projected_sha256: "B".repeat(64) }, { baseline_projected_byte_length: -1 },
      { baseline_projected_byte_length: 2097153 }, { baseline_bytes: new Uint8Array() },
      { lineage_state: "unknown" }, { admission_state: "unknown" }, { restore_fence_generation: -1 },
      { restore_fence_generation: 9007199254740992 }, { registered_at_ms: -1 },
      { retired_at_ms: -1 }, { retired_at_ms: 1 },
      { lineage_state: "retired", admission_state: "open", retired_at_ms: 1 },
      { lineage_state: "retired", admission_state: "closed" },
    ];
    for (const changed of invalid) expect(() => baseline(db, changed), JSON.stringify(changed)).toThrow();
    expect(() => baseline(db, { baseline_bytes: new Uint8Array(20971521) })).toThrow();
    baseline(db, { object_id: "x".repeat(512), current_path: "é".repeat(512),
      baseline_projected_byte_length: 2097152, baseline_bytes: new Uint8Array(20971520),
      restore_fence_generation: 9007199254740991 });
    expect(db.prepare(`SELECT count(*) AS count FROM ${documents}`).get()?.count).toBe(1);
  });
});

it("enforces baseline range bounds and composite identity", async () => {
  const path = await database();
  raw(path, db => {
    workspace(db);
    baseline(db);
    const insert = (client: number, start: number, end: number) => db.prepare(`INSERT INTO ${ranges} VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("workspace-1", "main", "object-1", "a".repeat(64), client, start, end);
    for (const [client, start, end] of [[-1, 0, 1], [9007199254740992, 0, 1], [0, -1, 1],
      [0, 4294967295, 4294967295], [0, 0, 0], [0, 1, 1], [0, 2, 1], [0, 0, 4294967296]]) {
      expect(() => insert(client!, start!, end!)).toThrow();
    }
    insert(9007199254740991, 4294967294, 4294967295);
    expect(() => insert(9007199254740991, 4294967294, 4294967295)).toThrow();
  });
});
