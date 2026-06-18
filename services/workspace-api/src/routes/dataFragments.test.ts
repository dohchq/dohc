import { readFile } from "node:fs/promises";
import type { WorkspaceBackend } from "@dohc/workspace-contracts";
import { defaultPostgresUrl } from "@dohc/workspace-postgres";
import { createPostgresWorkspaceBackend } from "@dohc/workspace-postgres/services/backend";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceApiHandler } from "../server";

const migrationUrls = [
  "0001_initial.sql",
  "0002_better_auth.sql",
  "0006_data_fragments.sql",
].map(
  (name) =>
    new URL(`../../../../packages/workspace-postgres/src/db/migrations/${name}`, import.meta.url),
);

const workspaceId = "fragment-ws";
const targetWorkspaceId = "fragment-target-ws";
const ownerId = "fragment_owner";
const memberId = "fragment_member";
const otherMemberId = "fragment_other_member";
const strangerId = "fragment_stranger";
const recipientId = "fragment_recipient";
const recipientEmail = "fragment-recipient@dohc.test";
const unverifiedId = "fragment_unverified";
const unverifiedEmail = "fragment-unverified@dohc.test";
const atomId = "fragment-source-atom";

let pool: pg.Pool;

const handlerFor = (userId: string) =>
  createWorkspaceApiHandler({
    backend: pool
      ? createPostgresWorkspaceBackend(pool)
      : ({} as unknown as WorkspaceBackend),
    resolveActor: async (_request, workspaceIdFromRoute) => ({
      userId,
      workspaceId: workspaceIdFromRoute,
    }),
    shared: { pool },
  });

const call = (userId: string, path: string, init?: RequestInit) =>
  handlerFor(userId)(new Request(`http://api.test${path}`, init));

const postFragment = (userId: string, body: unknown) =>
  call(userId, `/workspaces/${workspaceId}/data-fragments`, {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl });
  for (const url of migrationUrls) await pool.query(await readFile(url, "utf8"));
  await clearFixtures();
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'Fragments', 'shared'),
            ($3, $3, $4, $3, 'Fragment Target', 'shared')`,
    [workspaceId, ownerId, targetWorkspaceId, recipientId],
  );
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ('fragment-m-owner', $1, $2, 'owner'),
            ('fragment-m-member', $1, $3, 'member'),
            ('fragment-m-other', $1, $4, 'member'),
            ('fragment-m-target-owner', $5, $6, 'owner')`,
    [workspaceId, ownerId, memberId, otherMemberId, targetWorkspaceId, recipientId],
  );
  await pool.query(
    `insert into atoms (id, workspace_id, path, kind, body, revision)
     values ($2, $1, 'notes/day.md', 'markdown',
       'I ate 10 apples. Private source detail: launch budget is 42.', 1),
       ('fragment-target-atom', $3, 'notes/target.md', 'markdown', 'I ate', 1)`,
    [workspaceId, atomId, targetWorkspaceId],
  );
  await pool.query(
    `insert into "user" (id, name, email, "emailVerified")
     values ($1, 'Recipient', $2, true), ($3, 'Unverified', $4, false)`,
    [recipientId, recipientEmail, unverifiedId, unverifiedEmail],
  );
});

afterEach(async () => {
  await clearFixtures();
  await pool?.end();
});

async function clearFixtures() {
  for (const table of [
    "data_fragment_shares",
    "data_fragments",
    "shares",
    "atoms",
    "workspace_members",
    "workspaces",
  ]) {
    await pool.query(`delete from ${table} where workspace_id = any($1::text[])`, [
      [workspaceId, targetWorkspaceId],
    ]);
  }
  await pool.query(`delete from "user" where email like 'fragment-%'`);
}

describe("data fragment Cloud routes (live pg)", () => {
  it("exports only the selected data to a recipient inbox and never grants source file access", async () => {
    const created = await postFragment(memberId, {
      sourcePath: "notes/day.md",
      title: "Apple count",
      body: "10 apples",
      contentType: "text/plain",
      recipientEmail,
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(JSON.stringify(createdBody)).not.toContain("launch budget");
    expect(createdBody).toMatchObject({
      ok: true,
      fragment: {
        sourceWorkspaceId: workspaceId,
        sourcePath: "notes/day.md",
        title: "Apple count",
        preview: "10 apples",
        contentType: "text/plain",
        createdBy: memberId,
        recipientEmail,
      },
    });

    const inbox = await call(recipientId, "/me/data-fragments");
    expect(inbox.status).toBe(200);
    const inboxBody = await inbox.json();
    expect(JSON.stringify(inboxBody)).not.toContain("launch budget");
    expect(inboxBody).toMatchObject({
      ok: true,
      fragments: [
        {
          fragmentId: createdBody.fragment.fragmentId,
          title: "Apple count",
          preview: "10 apples",
          sourcePath: "notes/day.md",
        },
      ],
    });

    const fetched = await call(recipientId, `/data-fragments/${createdBody.fragment.fragmentId}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      ok: true,
      fragment: { body: "10 apples" },
    });

    // The data fragment share is not an atom share. The recipient can import
    // the selected data but cannot read the source file it came from.
    expect((await call(recipientId, `/shared/atoms/${atomId}`)).status).toBe(403);
  });

  it("exports from one workspace and imports only that fragment into another workspace file", async () => {
    const created = await (
      await postFragment(memberId, {
        sourcePath: "notes/day.md",
        title: "Apple count",
        body: "10 apples",
        recipientEmail,
      })
    ).json();

    const fetched = await (
      await call(recipientId, `/data-fragments/${created.fragment.fragmentId}`)
    ).json();
    expect(fetched.fragment.body).toBe("10 apples");

    const before = await (
      await call(recipientId, `/workspaces/${targetWorkspaceId}/files/notes/target.md`)
    ).json();
    expect(before.file.body).toBe("I ate");

    const write = await call(
      recipientId,
      `/workspaces/${targetWorkspaceId}/files/notes/target.md`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: before.file.revision,
          body: `${before.file.body}\n${fetched.fragment.body}`,
        }),
      },
    );
    expect(write.status).toBe(200);

    const after = await (
      await call(recipientId, `/workspaces/${targetWorkspaceId}/files/notes/target.md`)
    ).json();
    expect(after.file.body).toBe("I ate\n10 apples");
    expect(after.file.body).not.toContain("launch budget");
  });

  it("rejects non-recipients and keeps body validation behind workspace authz", async () => {
    const created = await (
      await postFragment(ownerId, {
        sourcePath: "notes/day.md",
        body: "10 apples",
        recipientEmail,
      })
    ).json();

    expect((await call(strangerId, `/data-fragments/${created.fragment.fragmentId}`)).status).toBe(403);
    await expect((await call(strangerId, "/me/data-fragments")).json()).resolves.toEqual({
      ok: true,
      fragments: [],
    });

    expect(
      (
        await postFragment(strangerId, {
          body: "",
          recipientEmail: "not-an-email",
        })
      ).status,
    ).toBe(403);
  });

  it("requires a verified recipient email and supports revocation by exporter or owner", async () => {
    expect(
      (
        await postFragment(memberId, {
          sourcePath: "notes/day.md",
          body: "10 apples",
          recipientEmail: unverifiedEmail,
        })
      ).status,
    ).toBe(404);

    const { fragment } = await (
      await postFragment(memberId, {
        sourcePath: "notes/day.md",
        body: "10 apples",
        recipientEmail,
      })
    ).json();

    expect((await call(otherMemberId, `/data-fragments/${fragment.fragmentId}`, { method: "DELETE" })).status).toBe(403);
    expect((await call(strangerId, `/data-fragments/${fragment.fragmentId}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(recipientId, `/data-fragments/${fragment.fragmentId}`, { method: "DELETE" })).status).toBe(403);

    const revoked = await call(memberId, `/data-fragments/${fragment.fragmentId}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ ok: true, revoked: true });
    expect((await call(recipientId, `/data-fragments/${fragment.fragmentId}`)).status).toBe(404);
    await expect((await call(recipientId, "/me/data-fragments")).json()).resolves.toEqual({
      ok: true,
      fragments: [],
    });

    const { fragment: ownerDeleted } = await (
      await postFragment(memberId, {
        sourcePath: "notes/day.md",
        body: "10 apples",
        recipientEmail,
      })
    ).json();
    expect((await call(ownerId, `/data-fragments/${ownerDeleted.fragmentId}`, { method: "DELETE" })).status).toBe(200);
  });
});
