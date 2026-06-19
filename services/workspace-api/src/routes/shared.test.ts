import { readFile } from "node:fs/promises";
import type { WorkspaceBackend } from "@dohc/workspace-contracts";
import { defaultPostgresUrl } from "@dohc/workspace-postgres";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceApiHandler } from "../server";
import { resolveSharedAtom } from "./shared";

// Live-pg share lifecycle for the kept product (phase 13 backend-deletion
// review, triage item 1): view/edit capability honored, revocation honored, and a
// non-member with a share reads ONLY the shared atom.
const migrationUrl = new URL(
  "../../../../packages/workspace-postgres/src/db/migrations/0001_initial.sql",
  import.meta.url,
);

const workspaceId = "phase13-shared-ws";
const ownerId = "phase13_shared_owner";
const memberId = "phase13_shared_member";
const recipientId = "phase13_shared_recipient";
const strangerId = "phase13_shared_stranger";
const sharedAtomId = "phase13-shared-atom";
const unsharedAtomId = "phase13-unshared-atom";
const shareId = "phase13-share-row";

let pool: pg.Pool;

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl });
  await pool.query(await readFile(migrationUrl, "utf8"));
  await clearWorkspace();
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'Shared', 'shared')`,
    [workspaceId, ownerId],
  );
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ('phase13-shared-m-owner', $1, $2, 'owner'),
            ('phase13-shared-m-member', $1, $3, 'member')`,
    [workspaceId, ownerId, memberId],
  );
  await pool.query(
    `insert into atoms (id, workspace_id, path, kind, body, revision)
     values ($2, $1, 'notes/shared.md', 'markdown', '# Shared note', 1),
            ($3, $1, 'notes/private.md', 'markdown', '# Private note', 1)`,
    [workspaceId, sharedAtomId, unsharedAtomId],
  );
  await pool.query(
    `insert into shares (id, workspace_id, target_kind, target_id, recipient_user_id, capability)
     values ($1, $2, 'atom', $3, $4, 'view')`,
    [shareId, workspaceId, sharedAtomId, recipientId],
  );
});

afterEach(async () => {
  await clearWorkspace();
  await pool?.end();
});

async function clearWorkspace() {
  for (const table of ["shares", "atoms", "workspace_members", "workspaces"]) {
    await pool.query(`delete from ${table} where workspace_id = $1`, [workspaceId]);
  }
}

describe("GET /shared/atoms/:atomId (live pg)", () => {
  it("members and owners read any workspace atom with edit capability", async () => {
    for (const userId of [memberId, ownerId]) {
      await expect(resolveSharedAtom({ pool }, userId, sharedAtomId)).resolves.toEqual({
        ok: true,
        atomId: sharedAtomId,
        workspaceId,
        path: "notes/shared.md",
        body: "# Shared note",
        capability: "edit",
      });
      await expect(
        resolveSharedAtom({ pool }, userId, unsharedAtomId),
      ).resolves.toMatchObject({ ok: true, capability: "edit" });
    }
  });

  it("a share recipient reads the shared atom with the share row's capability", async () => {
    await expect(resolveSharedAtom({ pool }, recipientId, sharedAtomId)).resolves.toEqual({
      ok: true,
      atomId: sharedAtomId,
      workspaceId,
      path: "notes/shared.md",
      body: "# Shared note",
      capability: "view",
    });

    await pool.query("update shares set capability = 'edit' where id = $1", [shareId]);
    await expect(
      resolveSharedAtom({ pool }, recipientId, sharedAtomId),
    ).resolves.toMatchObject({ ok: true, capability: "edit" });
  });

  it("a non-member with a share sees ONLY the shared atom, never its workspace siblings", async () => {
    await expect(
      resolveSharedAtom({ pool }, recipientId, unsharedAtomId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects non-members without a share", async () => {
    await expect(
      resolveSharedAtom({ pool }, strangerId, sharedAtomId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("honors revocation: a soft-deleted share stops resolving", async () => {
    await pool.query("update shares set deleted_at = now() where id = $1", [shareId]);
    await expect(
      resolveSharedAtom({ pool }, recipientId, sharedAtomId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns not-found for deleted and unknown atoms (even for members)", async () => {
    await pool.query("update atoms set deleted_at = now() where id = $1", [sharedAtomId]);
    await expect(
      resolveSharedAtom({ pool }, memberId, sharedAtomId),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      resolveSharedAtom({ pool }, memberId, "phase13-no-such-atom"),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("maps to HTTP statuses through the API handler: 200 member, 200 recipient, 403 stranger, 404 missing", async () => {
    // The backend is never consulted on /shared routes; access comes from SQL.
    const handlerFor = (userId: string) =>
      createWorkspaceApiHandler({
        backend: {} as unknown as WorkspaceBackend,
        resolveActor: async (_request, workspaceIdFromRoute) => ({
          userId,
          workspaceId: workspaceIdFromRoute,
        }),
        shared: { pool },
      });
    const get = (userId: string, atomId: string) =>
      handlerFor(userId)(new Request(`http://api.test/shared/atoms/${atomId}`));

    const member = await get(memberId, sharedAtomId);
    expect(member.status).toBe(200);
    await expect(member.json()).resolves.toMatchObject({ ok: true, capability: "edit" });

    const recipient = await get(recipientId, sharedAtomId);
    expect(recipient.status).toBe(200);
    await expect(recipient.json()).resolves.toMatchObject({ ok: true, capability: "view" });

    expect((await get(strangerId, sharedAtomId)).status).toBe(403);
    expect((await get(recipientId, unsharedAtomId)).status).toBe(403);
    expect((await get(memberId, "phase13-no-such-atom")).status).toBe(404);
  });
});
