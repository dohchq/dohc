import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { openSyncRelayStorage, type CurrentLiveBindingRequest, type SyncRelayStorage } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import { prepareLiveDeliveryWorkspace, registerLiveDeliveryBaseline } from "./storage/liveDeliveryReservations.js";

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
function baseline(db: Pick<RawDatabase, "prepare">, changed: Record<string, unknown> = {}): void {
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

// These synthetic bytes and moments prove authority reads, not validated registration.
const readBaseline = new Uint8Array([0, 0]);
const readLineage = createHash("sha256").update(readBaseline).digest("hex");
const readDocument = { workspaceId: "workspace-1", mainVersionId: "main", objectId: "object-1", lineageClaimId: readLineage };
const ownerActor = { kind: "owner", userId: "owner-1", shareId: "share-1" } as const;
const namedActor = { kind: "named", userId: "reader-1", grantId: "edit-1" } as const;
const readHost = { mode: "device", hostId: "host-1", hostEpoch: parseHostEpoch(1), instanceId: "instance-1", connectionId: "connection-1" } as const;

function seedReadMoment(db: RawDatabase, changed: Record<string, unknown> = {}): void {
  const row = { workspace_id: "workspace-1", object_id: "object-1", relay_seq: 1, moment_id: "moment-1",
    version_id: "main", path: "docs/a.md", blob_sha256: "b".repeat(64), content_kind: "text", byte_length: 1,
    recorded_at_ms: 1, ...changed };
  db.prepare(`INSERT INTO sync_relay_object_moments (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

function seedReadGrant(db: RawDatabase, changed: Record<string, unknown> = {}): void {
  const row = { grant_id: "edit-1", share_id: "share-1", principal_kind: "user", principal_user_id: "reader-1",
    principal_email: null, access: "edit", generation: 4, status: "active", created_at_ms: 0, revoked_at_ms: null,
    parent_grant_id: null, ...changed };
  db.prepare(`INSERT INTO sync_relay_share_grants (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

async function withBindingFixture(run: (storage: SyncRelayStorage, path: string) => void): Promise<void> {
  const path = await database();
  raw(path, db => {
    workspace(db);
    seedReadMoment(db);
    db.prepare("INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run("share-1", "workspace-1", "owner-1", JSON.stringify({ paths: ["docs"], versionId: null }), 0);
    seedReadGrant(db);
    seedReadGrant(db, { grant_id: "view-1", access: "view" });
  });
  const storage = openSyncRelayStorage(path);
  try {
    const context = storage as StorageContext;
    context.tx(() => {
      prepareLiveDeliveryWorkspace(context, readDocument.workspaceId, readHost.hostId);
      baseline(context.db, { lineage_claim_id: readLineage, baseline_digest: readLineage, baseline_bytes: readBaseline,
        baseline_projected_byte_length: 1, restore_fence_generation: 7 });
      registerLiveDeliveryBaseline(context, readDocument, readHost.hostId);
    });
    expect(storage.provisionLiveHostControl({ mode: readHost.mode, hostId: readHost.hostId, updatedAtMs: 1, guard: () => undefined }).ok).toBe(true);
    expect(storage.registerLiveHost({ ...readHost, updatedAtMs: 2, guard: () => undefined }).ok).toBe(true);
    run(storage, path);
  } finally { storage.close(); }
}

it("reads owned current owner and exact named authority, preserving the stored fence across reopen", async () => {
  await withBindingFixture((storage, path) => {
    const before = raw(path, db => db.prepare(`SELECT * FROM ${documents}`).all());
    for (const actor of [ownerActor, namedActor]) {
      const request = { document: { ...readDocument }, actor: { ...actor } };
      const result = storage.resolveCurrentLiveDocumentBinding(request);
      expect(result).toEqual({ kind: "current", host: readHost,
        binding: { ...readDocument, currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 7 },
        authority: actor.kind === "owner"
          ? { principalKind: "owner", principalId: "owner-1", grantId: null, grantGeneration: null }
          : { principalKind: "named", principalId: "reader-1", grantId: "edit-1", grantGeneration: 4 } });
      if (result.kind !== "current") throw new Error("expected current authority");
      (result.binding.selectorPaths as string[]).push("outside");
      (result.host as { hostId: string }).hostId = "poison";
      (result.authority as { principalId: string }).principalId = "poison";
      expect(request).toEqual({ document: readDocument, actor });
      const reopened = openSyncRelayStorage(path);
      try {
        const fresh = reopened.resolveCurrentLiveDocumentBinding({ document: readDocument, actor });
        expect(fresh.kind).toBe("current");
        if (fresh.kind === "current") {
          expect(fresh.binding.selectorPaths).toEqual(["docs"]);
          expect(fresh.binding.restoreFenceGeneration).toBe(7);
          expect(fresh.host).toEqual(readHost);
          expect(fresh.authority.principalId).toBe(actor.userId);
        }
      } finally { reopened.close(); }
    }
    expect(raw(path, db => db.prepare(`SELECT * FROM ${documents}`).all())).toEqual(before);
  });
});

it("never substitutes another grant and reads current same-grant generation", async () => {
  await withBindingFixture((storage, path) => {
    const enumeration = vi.spyOn(storage, "listActiveShareGrantsForRecipient").mockImplementation(() => { throw new Error("enumerated grants"); });
    try {
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: { ...namedActor, grantId: "view-1" } }))
        .toEqual({ kind: "refused", reason: "stale-selector" });
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: { ...namedActor, grantId: "missing" } }))
        .toEqual({ kind: "refused", reason: "not-authorized" });
      raw(path, db => db.exec("UPDATE sync_relay_share_grants SET generation = 5 WHERE grant_id = 'edit-1'"));
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }))
        .toMatchObject({ kind: "current", authority: { grantId: "edit-1", grantGeneration: 5 } });
      expect(enumeration).not.toHaveBeenCalled();
    } finally { enumeration.mockRestore(); }
  });
});

it.each([
  ["revoked grant", "UPDATE sync_relay_share_grants SET status = 'revoked', revoked_at_ms = 3 WHERE grant_id = 'edit-1'", "not-authorized"],
  ["another principal", "UPDATE sync_relay_share_grants SET principal_user_id = 'other' WHERE grant_id = 'edit-1'", "not-authorized"],
  ["narrowed grant", "UPDATE sync_relay_share_grants SET access = 'comment' WHERE grant_id = 'edit-1'", "stale-selector"],
  ["lost granter standing", "UPDATE sync_relay_workspaces SET owner_user_id = 'other'", "not-authorized"],
  ["missing grant", "DELETE FROM sync_relay_share_grants WHERE grant_id = 'edit-1'", "not-authorized"],
] as const)("current named authority refuses %s", async (_label, sql, reason) => {
  await withBindingFixture((storage, path) => {
    raw(path, db => db.exec(sql));
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor })).toEqual({ kind: "refused", reason });
  });
});

it.each(["revoked", "narrowed", "wrong-kind", "missing"] as const)("rechecks dependent Edit parent standing: %s", async change => {
  await withBindingFixture((storage, path) => {
    raw(path, db => {
      seedReadGrant(db, { grant_id: "parent-1", principal_kind: "link", principal_user_id: null });
      db.exec("UPDATE sync_relay_share_grants SET parent_grant_id = 'parent-1' WHERE grant_id = 'edit-1'");
    });
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }).kind).toBe("current");
    raw(path, db => {
      if (change === "revoked") db.exec("UPDATE sync_relay_share_grants SET status = 'revoked', revoked_at_ms = 3 WHERE grant_id = 'parent-1'");
      if (change === "narrowed") db.exec("UPDATE sync_relay_share_grants SET access = 'comment' WHERE grant_id = 'parent-1'");
      if (change === "wrong-kind") db.exec("UPDATE sync_relay_share_grants SET principal_kind = 'user', principal_user_id = 'owner-1' WHERE grant_id = 'parent-1'");
      if (change === "missing") db.exec("PRAGMA foreign_keys = OFF; DELETE FROM sync_relay_share_grants WHERE grant_id = 'parent-1'");
    });
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }))
      .toEqual({ kind: "refused", reason: "not-authorized" });
  });
});

it.each([
  "{", JSON.stringify({ paths: ["docs"], versionId: "pinned" }), JSON.stringify({ paths: [], versionId: null }),
  JSON.stringify({ kind: "chat", channelWireId: "channel-1" }), JSON.stringify({ paths: ["docs-private"], versionId: null }),
  JSON.stringify({ paths: ["outside"], versionId: null }), JSON.stringify({ paths: ["../docs"], versionId: null }),
  JSON.stringify({ paths: ["docs//"], versionId: null }), JSON.stringify({ paths: ["docs", "docs"], versionId: null }),
  JSON.stringify({ paths: ["docs"], versionId: null, extra: true }),
])("refuses selector damage or drift for both actor kinds: %s", async selector => {
  await withBindingFixture((storage, path) => {
    raw(path, db => db.prepare("UPDATE sync_relay_shares SET selector_json = ?").run(selector));
    for (const actor of [ownerActor, namedActor]) {
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor })).toEqual({ kind: "refused", reason: "stale-selector" });
    }
  });
});

it("checks owner and workspace standing before constructing either authority envelope", async () => {
  await withBindingFixture((storage, path) => {
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: { ...ownerActor, userId: "reader-1" } }))
      .toEqual({ kind: "refused", reason: "not-authorized" });
    raw(path, db => {
      db.exec("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES ('other-workspace', 'owner-1', 0)");
      db.exec("UPDATE sync_relay_shares SET workspace_id = 'other-workspace'");
    });
    for (const actor of [ownerActor, namedActor]) {
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor })).toEqual({ kind: "refused", reason: "not-authorized" });
    }
  });
});

it.each(["moved", "deleted", "binary", "replacement"] as const)("rechecks the latest main moment and reverse path: %s", async change => {
  await withBindingFixture((storage, path) => {
    raw(path, db => seedReadMoment(db, { relay_seq: 2, moment_id: "moment-2", ...(change === "moved" ? { path: "elsewhere/a.md" }
      : change === "deleted" ? { path: null, content_kind: null, blob_sha256: null, byte_length: null }
        : change === "binary" ? { content_kind: "binary" } : { object_id: "replacement-1" }) }));
    for (const actor of [ownerActor, namedActor]) expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor }))
      .toEqual({ kind: "refused", reason: "stale-document" });
  });
});

it("ignores a later pinned moment and permits a later valid same-path main edit", async () => {
  await withBindingFixture((storage, path) => {
    raw(path, db => {
      seedReadMoment(db, { relay_seq: 2, moment_id: "edit-2", blob_sha256: "c".repeat(64), byte_length: 5 });
      seedReadMoment(db, { relay_seq: 3, moment_id: "fork-3", version_id: "fork", path: "outside/a.md" });
    });
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }).kind).toBe("current");
  });
});

it.each([
  { blob_sha256: null }, { byte_length: -1 }, { recorded_at_ms: -1 },
])("refuses malformed latest-main facts without changing registered authority: %j", async change => {
  await withBindingFixture((storage, path) => {
    const before = raw(path, db => db.prepare(`SELECT * FROM ${documents}`).all());
    raw(path, db => {
      seedReadMoment(db, { relay_seq: 2, moment_id: "malformed-latest", ...change });
    });
    for (const actor of [ownerActor, namedActor]) {
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor }))
        .toEqual({ kind: "refused", reason: "stale-document" });
    }
    expect(raw(path, db => db.prepare(`SELECT * FROM ${documents}`).all())).toEqual(before);
  });
});

it.each(["absent", "closed", "retired", "another-lineage"] as const)("classifies current authority history as stale: %s", async state => {
  await withBindingFixture((storage, path) => {
    raw(path, db => {
      if (state === "absent") db.exec(`DELETE FROM ${documents}`);
      if (state === "closed") db.exec(`UPDATE ${documents} SET admission_state = 'closed'`);
      if (state === "retired") db.exec(`UPDATE ${documents} SET lineage_state = 'retired', admission_state = 'closed', retired_at_ms = 10`);
    });
    const document = state === "another-lineage" ? { ...readDocument, lineageClaimId: "f".repeat(64) } : readDocument;
    for (const actor of [ownerActor, namedActor]) expect(storage.resolveCurrentLiveDocumentBinding({ document, actor }))
      .toEqual({ kind: "refused", reason: "stale-document" });
  });
});

it("returns host-unavailable on disconnect or transition and rereads a new connection", async () => {
  await withBindingFixture((storage, path) => {
    expect(storage.disconnectLiveHost({ ...readHost, updatedAtMs: 3, guard: () => undefined }).ok).toBe(true);
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor }))
      .toEqual({ kind: "refused", reason: "host-unavailable" });
    const newHost = { ...readHost, connectionId: "connection-2" };
    expect(storage.registerLiveHost({ ...newHost, updatedAtMs: 4, guard: () => undefined }).ok).toBe(true);
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor })).toMatchObject({ kind: "current", host: newHost });
    expect(storage.beginLiveHostTransition({ from: newHost, toMode: "service", toHostId: "service-1", transitionId: "transition-1", startedAtMs: 5, guard: () => undefined }).ok).toBe(true);
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }))
      .toEqual({ kind: "refused", reason: "host-unavailable" });
    raw(path, db => db.exec("DELETE FROM sync_relay_session_host_control"));
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor }))
      .toEqual({ kind: "refused", reason: "host-unavailable" });
  });
});

it.each([
  `UPDATE ${documents} SET baseline_bytes = x'01'`,
  `UPDATE ${documents} SET baseline_projected_sha256 = '${"c".repeat(64)}'`,
  `UPDATE ${documents} SET baseline_projected_byte_length = 2`,
  `UPDATE ${documents} SET baseline_moment_relay_seq = 2`,
  `UPDATE ${documents} SET current_path = 'docs//a.md'`,
  `UPDATE ${documents} SET current_path = 'docs/a.txt'`,
  `PRAGMA ignore_check_constraints = ON; UPDATE ${documents} SET restore_fence_generation = -1`,
  `PRAGMA ignore_check_constraints = ON; UPDATE sync_relay_session_host_control SET admission_state = 'broken'`,
  `PRAGMA ignore_check_constraints = ON; UPDATE sync_relay_session_host_control SET admission_state = 'closed'`,
  `PRAGMA ignore_check_constraints = ON; UPDATE sync_relay_session_host_control SET transition_id = 'orphan-transition'`,
])("throws on stored authority or host damage without normalizing it: %s", async sql => {
  await withBindingFixture((storage, path) => {
    raw(path, db => {
      seedReadMoment(db, { relay_seq: 2, moment_id: "later-same-digest", path: "elsewhere/a.md" });
      db.exec(sql);
    });
    expect(() => storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor })).toThrow();
  });
});

it.each([2, 3])("rejects overlapping or mergeable-adjacent baseline ranges ending at %s", async end => {
  await withBindingFixture((storage, path) => {
    raw(path, db => {
      const insert = db.prepare(`INSERT INTO ${ranges} VALUES (?, ?, ?, ?, ?, ?, ?)`);
      insert.run("workspace-1", "main", "object-1", readLineage, 1, 0, end);
      insert.run("workspace-1", "main", "object-1", readLineage, 1, 2, 4);
    });
    expect(() => storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor })).toThrow(/damaged/);
  });
});

it("keeps one authority snapshot through concurrent grant changes and closes it before the next read", async () => {
  await withBindingFixture((storage, path) => {
    const getGrant = storage.getShareGrant.bind(storage);
    const lookup = vi.spyOn(storage, "getShareGrant").mockImplementation(id => {
      raw(path, db => {
        db.exec("PRAGMA busy_timeout = 0");
        db.exec("UPDATE sync_relay_share_grants SET generation = 9 WHERE grant_id = 'edit-1'");
      });
      return getGrant(id);
    });
    try {
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }))
        .toMatchObject({ kind: "current", authority: { grantGeneration: 4 } });
      expect(lookup).toHaveBeenCalledOnce();
    }
    finally { lookup.mockRestore(); }
    expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }))
      .toMatchObject({ kind: "current", authority: { grantGeneration: 9 } });
  });
});

it("rejects inherited, accessor, proxy and extra caller fields without invoking them", async () => {
  await withBindingFixture(storage => {
    const getter = vi.fn(() => readDocument);
    const request = { document: readDocument, actor: namedActor };
    for (const malformed of [
      Object.create(request), { ...request, extra: true }, { ...request, actor: { ...namedActor, kind: "link" } },
      { ...request, document: Object.defineProperty({ ...readDocument }, "objectId", { get: getter }) },
      Object.defineProperty({ actor: namedActor }, "document", { get: getter }),
      { ...request, actor: Object.defineProperty({ ...namedActor }, "kind", { get: getter }) },
      new Proxy(request, { getOwnPropertyDescriptor() { getter(); throw new Error("proxy inspected"); } }),
    ]) expect(() => storage.resolveCurrentLiveDocumentBinding(malformed as CurrentLiveBindingRequest)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(storage.resolveCurrentLiveDocumentBinding(request).kind).toBe("current");
  });
});
