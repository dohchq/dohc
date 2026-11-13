import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import {
  prepareLiveDeliveryWorkspace,
  registerLiveDeliveryBaseline,
} from "./storage/liveDeliveryReservations.js";

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function raw<T>(path: string, inspect: (db: RawDatabase) => T): T {
  const db = new DatabaseSync(path);
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}
function reopen(path: string): void {
  openSyncRelayStorage(path).close();
}
async function database(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-live-authority-schema-"));
  roots.push(root);
  const path = join(root, "relay.sqlite");
  reopen(path);
  return path;
}
function schemaSnapshot(path: string): unknown {
  return raw(path, (db) => ({
    objects: db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all(),
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
    workspace_id: "workspace-1",
    main_version_id: "main",
    object_id: "object-1",
    lineage_claim_id: "a".repeat(64),
    replaces_lineage_claim_id: null,
    current_path: "docs/a.md",
    baseline_moment_relay_seq: 1,
    baseline_projected_sha256: "b".repeat(64),
    baseline_projected_byte_length: 0,
    baseline_digest: "a".repeat(64),
    baseline_bytes: new Uint8Array([0]),
    lineage_state: "current",
    admission_state: "open",
    restore_fence_generation: 0,
    registered_at_ms: 0,
    retired_at_ms: null,
    ...changed,
  };
  db.prepare(
    `INSERT INTO ${documents} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(row));
}
function workspace(db: RawDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    "INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, ?)",
  ).run("workspace-1", "owner-1", 0);
}

it("creates the complete authority schema and reopens without changing its marker", async () => {
  const path = await database();
  raw(path, (db) => {
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?, ?) ORDER BY name")
        .all(...objects)
        .map((row) => row.name),
    ).toEqual([...objects].sort());
    expect(
      db
        .prepare("SELECT completed_at_ms FROM sync_relay_migrations WHERE migration_id = ?")
        .get(marker),
    ).toEqual({ completed_at_ms: expect.any(Number) });
    expect(
      db
        .prepare(`PRAGMA table_info(${documents})`)
        .all()
        .map((row) => row.name),
    ).toEqual([
      "workspace_id",
      "main_version_id",
      "object_id",
      "lineage_claim_id",
      "replaces_lineage_claim_id",
      "current_path",
      "baseline_moment_relay_seq",
      "baseline_projected_sha256",
      "baseline_projected_byte_length",
      "baseline_digest",
      "baseline_bytes",
      "lineage_state",
      "admission_state",
      "restore_fence_generation",
      "registered_at_ms",
      "retired_at_ms",
    ]);
    expect(
      db
        .prepare(`PRAGMA table_info(${ranges})`)
        .all()
        .map((row) => row.name),
    ).toEqual([
      "workspace_id",
      "main_version_id",
      "object_id",
      "lineage_claim_id",
      "client_id",
      "start_clock",
      "end_clock",
    ]);
    expect(db.prepare(`PRAGMA index_list(${documents})`).all()).toContainEqual(
      expect.objectContaining({
        name: currentIndex,
        unique: 1,
        partial: 1,
      }),
    );
    expect(
      db
        .prepare(`PRAGMA index_info(${coverageIndex})`)
        .all()
        .map((row) => row.name),
    ).toEqual([
      "workspace_id",
      "main_version_id",
      "object_id",
      "lineage_claim_id",
      "client_id",
      "start_clock",
      "end_clock",
    ]);
  });
  const before = schemaSnapshot(path);
  reopen(path);
  expect(schemaSnapshot(path)).toEqual(before);
});

it.each([documents])("refuses marked schema missing %s without repairing it", async (name) => {
  const path = await database();
  raw(path, (db) => db.exec(`DROP ${name.startsWith("idx_") ? "INDEX" : "TABLE"} ${name}`));
  refusesWithoutRepair(path, /authority schema is missing or damaged/);
});

it.each([documents])(
  "refuses an unmarked reserved-name collision at %s without adoption",
  async (name) => {
    const path = await database();
    raw(path, (db) => {
      removeAuthority(db);
      db.exec(`CREATE VIEW ${name} AS SELECT 1 AS unrelated`);
    });
    refusesWithoutRepair(path, /unmarked live document authority schema/);
  },
);

it("rolls authority schema creation back if its final marker write fails", async () => {
  const path = await database();
  raw(path, (db) => {
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
  raw(path, (db) => db.exec("DROP TRIGGER stop_authority_marker"));
  reopen(path);
});

it("enforces one current lineage and cascades authority ranges only with their workspace", async () => {
  const path = await database();
  raw(path, (db) => {
    workspace(db);
    baseline(db);
    expect(() =>
      baseline(db, { lineage_claim_id: "c".repeat(64), baseline_digest: "c".repeat(64) }),
    ).toThrow();
    baseline(db, {
      lineage_claim_id: "c".repeat(64),
      baseline_digest: "c".repeat(64),
      lineage_state: "retired",
      admission_state: "closed",
      retired_at_ms: 1,
    });
    db.prepare(`INSERT INTO ${ranges} VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "workspace-1",
      "main",
      "object-1",
      "a".repeat(64),
      0,
      0,
      1,
    );
    expect(() =>
      db
        .prepare(`INSERT INTO ${ranges} VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("workspace-1", "main", "other-object", "a".repeat(64), 0, 0, 1),
    ).toThrow();
    expect(db.prepare(`SELECT count(*) AS count FROM ${documents}`).get()?.count).toBe(2);
  });
  reopen(path);
  raw(path, (db) => {
    db.exec("PRAGMA foreign_keys = ON");
    expect(db.prepare(`SELECT count(*) AS count FROM ${ranges}`).get()?.count).toBe(1);
    db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run("workspace-1");
    expect(db.prepare(`SELECT count(*) AS count FROM ${documents}`).get()?.count).toBe(0);
    expect(db.prepare(`SELECT count(*) AS count FROM ${ranges}`).get()?.count).toBe(0);
  });
  reopen(path);
});

// These synthetic bytes and moments prove authority reads, not validated registration.
const readBaseline = new Uint8Array([0, 0]);
const readLineage = createHash("sha256").update(readBaseline).digest("hex");
const readDocument = {
  workspaceId: "workspace-1",
  mainVersionId: "main",
  objectId: "object-1",
  lineageClaimId: readLineage,
};
const ownerActor = { kind: "owner", userId: "owner-1" } as const;
const namedActor = { kind: "named", userId: "reader-1", grantId: "edit-1" } as const;
const readHost = {
  mode: "device",
  hostId: "host-1",
  hostEpoch: parseHostEpoch(1),
  instanceId: "instance-1",
  connectionId: "connection-1",
} as const;

function seedReadMoment(db: RawDatabase, changed: Record<string, unknown> = {}): void {
  const row = {
    workspace_id: "workspace-1",
    object_id: "object-1",
    relay_seq: 1,
    moment_id: "moment-1",
    version_id: "main",
    path: "docs/a.md",
    blob_sha256: "b".repeat(64),
    content_kind: "text",
    byte_length: 1,
    recorded_at_ms: 1,
    ...changed,
  };
  db.prepare(
    `INSERT INTO sync_relay_object_moments (${Object.keys(row).join(",")}) VALUES (${Object.keys(
      row,
    )
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(row));
}

function seedReadGrant(db: RawDatabase, changed: Record<string, unknown> = {}): void {
  const row = {
    grant_id: "edit-1",
    share_id: "share-1",
    principal_kind: "user",
    principal_user_id: "reader-1",
    principal_email: null,
    access: "edit",
    generation: 4,
    status: "active",
    created_at_ms: 0,
    revoked_at_ms: null,
    parent_grant_id: null,
    ...changed,
  };
  db.prepare(
    `INSERT INTO sync_relay_share_grants (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(row));
}

async function withBindingFixture(
  run: (storage: SyncRelayStorage, path: string) => void,
): Promise<void> {
  const path = await database();
  raw(path, (db) => {
    workspace(db);
    seedReadMoment(db);
    db.prepare(
      "INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "share-1",
      "workspace-1",
      "owner-1",
      JSON.stringify({ paths: ["docs"], versionId: null }),
      0,
    );
    seedReadGrant(db);
    seedReadGrant(db, { grant_id: "view-1", access: "view" });
  });
  const storage = openSyncRelayStorage(path);
  try {
    const context = storage as StorageContext;
    context.tx(() => {
      prepareLiveDeliveryWorkspace(context, readDocument.workspaceId, readHost.hostId);
      baseline(context.db, {
        lineage_claim_id: readLineage,
        baseline_digest: readLineage,
        baseline_bytes: readBaseline,
        baseline_projected_byte_length: 1,
        restore_fence_generation: 7,
      });
      registerLiveDeliveryBaseline(context, readDocument, readHost.hostId);
    });
    expect(
      storage.provisionLiveHostControl({
        mode: readHost.mode,
        hostId: readHost.hostId,
        updatedAtMs: 1,
        guard: () => undefined,
      }).ok,
    ).toBe(true);
    expect(
      storage.registerLiveHost({ ...readHost, updatedAtMs: 2, guard: () => undefined }).ok,
    ).toBe(true);
    run(storage, path);
  } finally {
    storage.close();
  }
}

it("reads the baseline binding for owner and named alike, with exact named authority, preserving the stored fence across reopen", async () => {
  await withBindingFixture((storage, path) => {
    const before = raw(path, (db) => db.prepare(`SELECT * FROM ${documents}`).all());
    for (const actor of [ownerActor, namedActor]) {
      // Nothing is recorded, so every editor gets the baseline's own path. The named share decides only admission.
      const selectorPaths = ["docs/a.md"];
      const request = { document: { ...readDocument }, actor: { ...actor } };
      const result = storage.resolveCurrentLiveDocumentBinding(request);
      const binding = {
        ...readDocument,
        currentPath: "docs/a.md",
        selectorPaths,
        restoreFenceGeneration: 7,
      };
      expect(result).toEqual({
        kind: "current",
        host: readHost,
        binding,
        // An owner is shown the binding itself, a named recipient its own share's paths under a workspace ID naming the grant.
        view:
          actor.kind === "owner"
            ? binding
            : { ...binding, workspaceId: "named:edit-1", selectorPaths: ["docs"] },
        authority:
          actor.kind === "owner"
            ? {
                principalKind: "owner",
                principalId: "owner-1",
                grantId: null,
                grantGeneration: null,
              }
            : {
                principalKind: "named",
                principalId: "reader-1",
                grantId: "edit-1",
                grantGeneration: 4,
              },
      });
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
          expect(fresh.binding.selectorPaths).toEqual(selectorPaths);
          expect(fresh.binding.restoreFenceGeneration).toBe(7);
          expect(fresh.host).toEqual(readHost);
          expect(fresh.authority.principalId).toBe(actor.userId);
        }
      } finally {
        reopened.close();
      }
    }
    expect(raw(path, (db) => db.prepare(`SELECT * FROM ${documents}`).all())).toEqual(before);
  });
});

it.each([
  [
    "revoked grant",
    "UPDATE sync_relay_share_grants SET status = 'revoked', revoked_at_ms = 3 WHERE grant_id = 'edit-1'",
    "not-authorized",
  ],
  [
    "narrowed grant",
    "UPDATE sync_relay_share_grants SET access = 'comment' WHERE grant_id = 'edit-1'",
    "stale-selector",
  ],
] as const)("current named authority refuses %s", async (_label, sql, reason) => {
  await withBindingFixture((storage, path) => {
    raw(path, (db) => db.exec(sql));
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
    ).toEqual({ kind: "refused", reason });
  });
});

it.each(["revoked"])("rechecks dependent Edit parent standing: %s", async (change) => {
  await withBindingFixture((storage, path) => {
    raw(path, (db) => {
      seedReadGrant(db, { grant_id: "parent-1", principal_kind: "link", principal_user_id: null });
      db.exec(
        "UPDATE sync_relay_share_grants SET parent_grant_id = 'parent-1' WHERE grant_id = 'edit-1'",
      );
    });
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }).kind,
    ).toBe("current");
    raw(path, (db) => {
      if (change === "revoked")
        db.exec(
          "UPDATE sync_relay_share_grants SET status = 'revoked', revoked_at_ms = 3 WHERE grant_id = 'parent-1'",
        );
      if (change === "narrowed")
        db.exec(
          "UPDATE sync_relay_share_grants SET access = 'comment' WHERE grant_id = 'parent-1'",
        );
      if (change === "wrong-kind")
        db.exec(
          "UPDATE sync_relay_share_grants SET principal_kind = 'user', principal_user_id = 'owner-1' WHERE grant_id = 'parent-1'",
        );
      if (change === "missing")
        db.exec(
          "PRAGMA foreign_keys = OFF; DELETE FROM sync_relay_share_grants WHERE grant_id = 'parent-1'",
        );
    });
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
    ).toEqual({ kind: "refused", reason: "not-authorized" });
  });
});

it.each([JSON.stringify({ paths: ["outside"], versionId: null })])(
  "refuses a named actor on selector damage or drift, which the owner never reads: %s",
  async (selector) => {
    await withBindingFixture((storage, path) => {
      raw(path, (db) => db.prepare("UPDATE sync_relay_shares SET selector_json = ?").run(selector));
      expect(
        storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
      ).toEqual({ kind: "refused", reason: "stale-selector" });
      expect(
        storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor }),
      ).toMatchObject({ kind: "current", binding: { selectorPaths: ["docs/a.md"] } });
    });
  },
);

it("checks owner and workspace standing before constructing either authority envelope", async () => {
  await withBindingFixture((storage, path) => {
    expect(
      storage.resolveCurrentLiveDocumentBinding({
        document: readDocument,
        actor: { ...ownerActor, userId: "reader-1" },
      }),
    ).toEqual({ kind: "refused", reason: "not-authorized" });
    raw(path, (db) => {
      db.exec(
        "INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES ('other-workspace', 'owner-1', 0)",
      );
      db.exec("UPDATE sync_relay_shares SET workspace_id = 'other-workspace'");
    });
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
    ).toEqual({ kind: "refused", reason: "not-authorized" });
    // The workspace's owner holds its document whatever its shares.
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor }).kind,
    ).toBe("current");
  });
});

it.each(["replacement"])("rechecks the latest main moment and reverse path: %s", async (change) => {
  await withBindingFixture((storage, path) => {
    raw(path, (db) =>
      seedReadMoment(db, {
        relay_seq: 2,
        moment_id: "moment-2",
        ...(change === "moved"
          ? { path: "elsewhere/a.md" }
          : change === "deleted"
            ? { path: null, content_kind: null, blob_sha256: null, byte_length: null }
            : change === "binary"
              ? { content_kind: "binary" }
              : { object_id: "replacement-1" }),
      }),
    );
    for (const actor of [ownerActor, namedActor])
      expect(storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor })).toEqual({
        kind: "refused",
        reason: "stale-document",
      });
  });
});

it("returns host-unavailable on disconnect or transition and rereads a new connection", async () => {
  await withBindingFixture((storage, path) => {
    expect(
      storage.disconnectLiveHost({ ...readHost, updatedAtMs: 3, guard: () => undefined }).ok,
    ).toBe(true);
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor }),
    ).toEqual({ kind: "refused", reason: "host-unavailable" });
    const newHost = { ...readHost, connectionId: "connection-2" };
    expect(
      storage.registerLiveHost({ ...newHost, updatedAtMs: 4, guard: () => undefined }).ok,
    ).toBe(true);
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor }),
    ).toMatchObject({ kind: "current", host: newHost });
    expect(
      storage.beginLiveHostTransition({
        from: newHost,
        toMode: "service",
        toHostId: "service-1",
        transitionId: "transition-1",
        startedAtMs: 5,
        guard: () => undefined,
      }).ok,
    ).toBe(true);
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
    ).toEqual({ kind: "refused", reason: "host-unavailable" });
    raw(path, (db) => db.exec("DELETE FROM sync_relay_session_host_control"));
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: ownerActor }),
    ).toEqual({ kind: "refused", reason: "host-unavailable" });
  });
});

it.each([`UPDATE ${documents} SET baseline_bytes = x'01'`])(
  "throws on stored authority or host damage without normalizing it: %s",
  async (sql) => {
    await withBindingFixture((storage, path) => {
      raw(path, (db) => {
        seedReadMoment(db, {
          relay_seq: 2,
          moment_id: "later-same-digest",
          path: "elsewhere/a.md",
        });
        db.exec(sql);
      });
      expect(() =>
        storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
      ).toThrow();
    });
  },
);

it.each([2, 3])(
  "rejects overlapping or mergeable-adjacent baseline ranges ending at %s",
  async (end) => {
    await withBindingFixture((storage, path) => {
      raw(path, (db) => {
        const insert = db.prepare(`INSERT INTO ${ranges} VALUES (?, ?, ?, ?, ?, ?, ?)`);
        insert.run("workspace-1", "main", "object-1", readLineage, 1, 0, end);
        insert.run("workspace-1", "main", "object-1", readLineage, 1, 2, 4);
      });
      expect(() =>
        storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
      ).toThrow(/damaged/);
    });
  },
);

it("keeps one authority snapshot through concurrent grant changes and closes it before the next read", async () => {
  await withBindingFixture((storage, path) => {
    const getGrant = storage.getShareGrant.bind(storage);
    const lookup = vi.spyOn(storage, "getShareGrant").mockImplementation((id) => {
      raw(path, (db) => {
        db.exec("PRAGMA busy_timeout = 0");
        db.exec("UPDATE sync_relay_share_grants SET generation = 9 WHERE grant_id = 'edit-1'");
      });
      return getGrant(id);
    });
    try {
      expect(
        storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
      ).toMatchObject({ kind: "current", authority: { grantGeneration: 4 } });
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      lookup.mockRestore();
    }
    expect(
      storage.resolveCurrentLiveDocumentBinding({ document: readDocument, actor: namedActor }),
    ).toMatchObject({ kind: "current", authority: { grantGeneration: 9 } });
  });
});
