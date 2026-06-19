import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceError } from "@dohc/workspace-contracts";
import { createPostgresWorkspaceBackend } from "./backend";
import { createMemoryBlobStore } from "./databaseFiles";
import { defaultPostgresUrl } from "../db/client";

// Live-pg coverage for the Phase 9 cloud-sync data-loss fixes: binary
// updateAsset (revision bump + stale reject), revision-guarded delete, and
// delete-then-recreate succeeding under the PARTIAL path-unique index (0003).
const migrationUrls = [
  new URL("../db/migrations/0001_initial.sql", import.meta.url),
  new URL("../db/migrations/0003_partial_path_unique.sql", import.meta.url),
];

const actor = {
  userId: "phase9_sync_alice",
  workspaceId: "phase9_sync_workspace",
};

const WORKSPACE_SCOPED_TABLES = [
  "database_operations",
  "database_files",
  "assets",
  "document_states",
  "atom_revisions",
  "atoms",
  "locks",
  "shares",
  "permissions",
  "folders",
  "workspace_events",
  "workspace_members",
  "workspaces",
] as const;

let pool: pg.Pool;

function makeBackend() {
  return createPostgresWorkspaceBackend(pool, { blobStore: createMemoryBlobStore() });
}

beforeEach(async () => {
  pool = new pg.Pool({
    connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
  });
  for (const url of migrationUrls) {
    await pool.query(await readFile(url, "utf8"));
  }
  await clearWorkspace(pool, actor.workspaceId, actor.userId);
  await seedWorkspace(pool, actor.workspaceId, actor.userId);
});

afterEach(async () => {
  await clearWorkspace(pool, actor.workspaceId, actor.userId);
  await pool?.end();
});

describe("postgres sync backend", () => {
  it("updateAsset bumps the revision and swaps the stored blob", async () => {
    const backend = makeBackend();
    const created = await backend.saveAsset(actor, {
      path: "img/photo.png",
      kind: "image",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(created.revision).toBe("1");

    const updated = await backend.updateAsset(actor, {
      path: "img/photo.png",
      expectedRevision: "1",
      kind: "image",
      mediaType: "image/png",
      bytes: new Uint8Array([9, 9, 9, 9]),
    });
    expect(updated.revision).toBe("2");

    const read = await backend.readAsset(actor, "img/photo.png");
    expect([...read.bytes]).toEqual([9, 9, 9, 9]);
    expect(read.revision).toBe("2");
  });

  it("updateAsset rejects a stale expectedRevision (no last-writer-wins)", async () => {
    const backend = makeBackend();
    await backend.saveAsset(actor, {
      path: "img/photo.png",
      kind: "image",
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
    });
    await backend.updateAsset(actor, {
      path: "img/photo.png",
      expectedRevision: "1",
      kind: "image",
      mediaType: "image/png",
      bytes: new Uint8Array([2]),
    });
    // Now at revision 2; a writer still on revision 1 must be rejected.
    await expect(
      backend.updateAsset(actor, {
        path: "img/photo.png",
        expectedRevision: "1",
        kind: "image",
        mediaType: "image/png",
        bytes: new Uint8Array([3]),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The newer content survives.
    expect([...(await backend.readAsset(actor, "img/photo.png")).bytes]).toEqual([2]);
  });

  it("updateAsset on an unknown path is not_found (saveAsset stays create-only)", async () => {
    const backend = makeBackend();
    await expect(
      backend.updateAsset(actor, {
        path: "img/missing.png",
        expectedRevision: "1",
        kind: "image",
        mediaType: "image/png",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("deleteFile rejects a stale expectedRevision (stale delete can't erase newer content)", async () => {
    const backend = makeBackend();
    await backend.createAtom(actor, { path: "notes.md", kind: "markdown", body: "v1" });
    await backend.writeAtom(actor, { path: "notes.md", expectedRevision: "1", body: "v2" });
    // The atom is now revision 2; a delete carrying the stale revision 1 fails.
    await expect(backend.deleteFile(actor, "notes.md", "1")).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await backend.readText(actor, "notes.md")).body).toBe("v2");
  });

  it("delete-then-recreate the same path succeeds (partial unique index)", async () => {
    const backend = makeBackend();
    await backend.createAtom(actor, { path: "todo.md", kind: "markdown", body: "first" });
    await backend.deleteFile(actor, "todo.md");
    // Without the partial index this throws "File path already exists" on the
    // surviving tombstone — the headline wedge.
    const recreated = await backend.createAtom(actor, {
      path: "todo.md",
      kind: "markdown",
      body: "second",
    });
    expect(recreated.revision).toBe("1");
    expect((await backend.readText(actor, "todo.md")).body).toBe("second");

    // Same for assets.
    await backend.saveAsset(actor, {
      path: "a.bin",
      kind: "file",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([1]),
    });
    await backend.deleteFile(actor, "a.bin");
    const reasset = await backend.saveAsset(actor, {
      path: "a.bin",
      kind: "file",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([2]),
    });
    expect(reasset.revision).toBe("1");
  });
});

async function seedWorkspace(db: pg.Pool, workspaceId: string, userId: string) {
  await db.query(
    `insert into users (id, workspace_id, token_identifier, email, name)
     values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
    [userId, workspaceId, `token:${userId}`, `${userId}@example.com`, userId],
  );
  await db.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $3, $4, 'personal') on conflict (id) do nothing`,
    [workspaceId, userId, workspaceId, workspaceId],
  );
  await db.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, 'owner') on conflict (workspace_id, user_id) do nothing`,
    [`member_${workspaceId}_${userId}`, workspaceId, userId],
  );
}

async function clearWorkspace(db: pg.Pool, workspaceId: string, userId: string) {
  for (const table of WORKSPACE_SCOPED_TABLES) {
    await db.query(`delete from ${quotePgIdent(table)} where workspace_id = $1`, [workspaceId]);
  }
  await db.query("delete from users where id = $1", [userId]);
}

function quotePgIdent(value: (typeof WORKSPACE_SCOPED_TABLES)[number]) {
  if (!/^[a-z_]+$/.test(value)) throw new Error(`Unsafe table name: ${value}`);
  return `"${value}"`;
}
