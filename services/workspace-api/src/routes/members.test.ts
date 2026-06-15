import { readFile } from "node:fs/promises";
import type { WorkspaceBackend } from "@dohc/workspace-contracts";
import { defaultPostgresUrl } from "@dohc/workspace-postgres";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceApiHandler } from "../server";

const migrationUrls = ["0001_initial.sql", "0002_better_auth.sql"].map(
  (name) =>
    new URL(
      `../../../../packages/workspace-postgres/src/db/migrations/${name}`,
      import.meta.url,
    ),
);

const workspaceId = "e5-members-ws";
const ownerId = "e5_members_owner";
const memberId = "e5_members_member";
const removedId = "e5_members_removed";
const strangerId = "e5_members_stranger";

let pool: pg.Pool;

const handlerFor = (userId: string) =>
  createWorkspaceApiHandler({
    backend: {} as unknown as WorkspaceBackend,
    resolveActor: async (_request, workspaceIdFromRoute) => ({
      userId,
      workspaceId: workspaceIdFromRoute,
    }),
    shared: { pool },
  });

const call = (userId: string, path: string, init?: RequestInit) =>
  handlerFor(userId)(new Request(`http://api.test${path}`, init));

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl });
  for (const url of migrationUrls) await pool.query(await readFile(url, "utf8"));
  await clearFixtures();
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'Members', 'shared')`,
    [workspaceId, ownerId],
  );
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role, deleted_at)
     values ('e5-members-m-member', $1, $2, 'member', null),
            ('e5-members-m-removed', $1, $3, 'member', now())`,
    [workspaceId, memberId, removedId],
  );
  await pool.query(
    `insert into "user" (id, name, email, "emailVerified")
     values ($1, 'Owner', 'e5-members-owner@dohc.test', true),
            ($2, 'Member', 'e5-members-member@dohc.test', true),
            ($3, 'Removed', 'e5-members-removed@dohc.test', true)`,
    [ownerId, memberId, removedId],
  );
});

afterEach(async () => {
  await clearFixtures();
  await pool?.end();
});

async function clearFixtures() {
  for (const table of ["workspace_members", "workspaces"]) {
    await pool.query(`delete from ${table} where workspace_id = $1`, [workspaceId]);
  }
  await pool.query(`delete from "user" where email like 'e5-members-%'`);
}

describe("workspace member routes (live pg)", () => {
  it("lists owner + live members with emails, hides soft-deleted memberships", async () => {
    const response = await call(memberId, `/workspaces/${workspaceId}/members`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      members: [
        {
          userId: ownerId,
          email: "e5-members-owner@dohc.test",
          role: "owner",
        },
        {
          userId: memberId,
          email: "e5-members-member@dohc.test",
          role: "member",
        },
      ],
    });
  });

  it("lets a workspace owner see members even if their member row is missing", async () => {
    const response = await call(ownerId, `/workspaces/${workspaceId}/members`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.members).toContainEqual({
      userId: ownerId,
      email: "e5-members-owner@dohc.test",
      role: "owner",
    });
  });

  it("forbids non-members and missing shared deps", async () => {
    expect((await call(strangerId, `/workspaces/${workspaceId}/members`)).status).toBe(403);
    const noShared = createWorkspaceApiHandler({
      backend: {} as unknown as WorkspaceBackend,
      resolveActor: async (_request, workspaceIdFromRoute) => ({
        userId: memberId,
        workspaceId: workspaceIdFromRoute,
      }),
    });
    expect(
      (
        await noShared(
          new Request(`http://api.test/workspaces/${workspaceId}/members`),
        )
      ).status,
    ).toBe(404);
  });
});
