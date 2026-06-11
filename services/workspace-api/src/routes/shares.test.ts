import { readFile } from "node:fs/promises";
import type { WorkspaceBackend } from "@dohc/workspace-contracts";
import { defaultPostgresUrl } from "@dohc/workspace-postgres";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceApiHandler } from "../server";

// Live-pg share lifecycle (plan Phase E5 server lane): members/owners create
// shares by recipient email, re-sharing upserts capability, revocation soft-
// deletes and the shared-link route 403s immediately, and /me/shares powers
// "shared with me". Mirrors the shared.test.ts fixture idioms.
const migrationUrls = [
  "0001_initial.sql",
  "0002_better_auth.sql",
  "0004_invitations.sql",
  "0005_share_audience_unique.sql",
].map(
  (name) =>
    new URL(`../../../../packages/workspace-postgres/src/db/migrations/${name}`, import.meta.url),
);

const workspaceId = "e5-shares-ws";
const ownerId = "e5_shares_owner";
const memberId = "e5_shares_member";
const otherMemberId = "e5_shares_other_member";
const strangerId = "e5_shares_stranger";
const recipientId = "e5_shares_recipient";
const recipientEmail = "e5-shares-recipient@dohc.test";
const unverifiedId = "e5_shares_unverified";
const unverifiedEmail = "e5-shares-unverified@dohc.test";
const atomId = "e5-shares-atom";
const otherAtomId = "e5-shares-atom-2";

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

const postShare = (userId: string, body: unknown) =>
  call(userId, `/workspaces/${workspaceId}/shares`, {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl });
  for (const url of migrationUrls) await pool.query(await readFile(url, "utf8"));
  await clearFixtures();
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'Shares', 'shared')`,
    [workspaceId, ownerId],
  );
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ('e5-shares-m-owner', $1, $2, 'owner'),
            ('e5-shares-m-member', $1, $3, 'member'),
            ('e5-shares-m-other', $1, $4, 'member')`,
    [workspaceId, ownerId, memberId, otherMemberId],
  );
  await pool.query(
    `insert into atoms (id, workspace_id, path, kind, body, revision)
     values ($2, $1, 'notes/shared.md', 'markdown', '# Shared note', 1),
            ($3, $1, 'notes/second.md', 'markdown', '# Second note', 1)`,
    [workspaceId, atomId, otherAtomId],
  );
  // The recipient is a VERIFIED Better Auth account (recipients resolve by
  // email among verified users only — security review P1); the unverified
  // account exists to prove it can never receive shares.
  await pool.query(
    `insert into "user" (id, name, email, "emailVerified")
     values ($1, 'Recipient', $2, true), ($3, 'Squatter', $4, false)`,
    [recipientId, recipientEmail, unverifiedId, unverifiedEmail],
  );
});

afterEach(async () => {
  await clearFixtures();
  await pool?.end();
});

async function clearFixtures() {
  for (const table of ["shares", "atoms", "workspace_members", "workspaces"]) {
    await pool.query(`delete from ${table} where workspace_id = $1`, [workspaceId]);
  }
  await pool.query(`delete from "user" where email like 'e5-shares-%'`);
}

describe("share lifecycle routes (live pg)", () => {
  it("creates a share by atomPath, upserts capability on re-share, and resolves by atomId too", async () => {
    const created = await postShare(memberId, {
      atomPath: "notes/shared.md",
      recipientEmail,
      capability: "view",
    });
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body).toMatchObject({
      ok: true,
      share: {
        workspaceId,
        atomId,
        atomPath: "notes/shared.md",
        recipientUserId: recipientId,
        recipientEmail,
        capability: "view",
      },
    });

    // Re-share the same atom+recipient (this time by atomId): SAME row, new
    // capability — the Convex audience-upsert semantics.
    const reshared = await postShare(memberId, { atomId, recipientEmail, capability: "edit" });
    expect(reshared.status).toBe(200);
    await expect(reshared.json()).resolves.toMatchObject({
      ok: true,
      share: { shareId: body.share.shareId, capability: "edit" },
    });
    const rows = await pool.query(
      "select capability from shares where workspace_id = $1 and deleted_at is null",
      [workspaceId],
    );
    expect(rows.rows).toEqual([{ capability: "edit" }]);

    // The recipient can now open the shared link with the upserted capability.
    const link = await call(recipientId, `/shared/atoms/${atomId}`);
    expect(link.status).toBe(200);
    await expect(link.json()).resolves.toMatchObject({ ok: true, capability: "edit" });
  });

  it("403s a member who re-shares ANOTHER member's share (capability escalation); the owner may", async () => {
    // Member A shares as view…
    const { share } = await (
      await postShare(memberId, { atomId, recipientEmail, capability: "view" })
    ).json();

    // …member B may not escalate it to edit (security review P2), and the
    // refusal must not name the current capability.
    const escalation = await postShare(otherMemberId, { atomId, recipientEmail, capability: "edit" });
    expect(escalation.status).toBe(403);
    const body = await escalation.json();
    expect(body).toMatchObject({ ok: false, code: "forbidden" });
    expect(body.error).not.toMatch(/view|edit/);
    const after = await pool.query("select capability from shares where id = $1", [share.shareId]);
    expect(after.rows).toEqual([{ capability: "view" }]);
    // The recipient's link capability is unchanged.
    await expect((await call(recipientId, `/shared/atoms/${atomId}`)).json()).resolves.toMatchObject(
      { ok: true, capability: "view" },
    );

    // The workspace owner MAY change a share they did not create — same row.
    const ownerUpdate = await postShare(ownerId, { atomId, recipientEmail, capability: "edit" });
    expect(ownerUpdate.status).toBe(200);
    await expect(ownerUpdate.json()).resolves.toMatchObject({
      ok: true,
      share: { shareId: share.shareId, capability: "edit" },
    });
  });

  it("rejects unknown recipient emails (invitation flow, not a share row) and bad bodies", async () => {
    const unknown = await postShare(ownerId, {
      atomId,
      recipientEmail: "e5-shares-nobody@dohc.test",
      capability: "view",
    });
    expect(unknown.status).toBe(404);

    // An UNVERIFIED account is not a proven email owner (security review P1):
    // it gets the EXACT unknown-email answer — same status, same message — so
    // the route neither shares with a mailbox squatter nor reveals whether an
    // unverified signup exists for the address.
    const unverified = await postShare(ownerId, {
      atomId,
      recipientEmail: unverifiedEmail,
      capability: "view",
    });
    expect(unverified.status).toBe(404);
    await expect(unverified.json()).resolves.toEqual(await unknown.json());
    expect((await pool.query("select 1 from shares where workspace_id = $1", [workspaceId])).rowCount).toBe(0);

    for (const body of [
      { atomId, recipientEmail, capability: "admin" },
      { recipientEmail, capability: "view" },
      { atomId, atomPath: "notes/shared.md", recipientEmail, capability: "view" },
      { atomId, recipientEmail: "not-an-email", capability: "view" },
    ]) {
      expect((await postShare(ownerId, body)).status).toBe(400);
    }
    expect(
      (await postShare(ownerId, { atomId: "e5-shares-missing", recipientEmail, capability: "view" })).status,
    ).toBe(404);
  });

  it("403s non-members on create and list; members and owners list live shares", async () => {
    expect(
      (await postShare(strangerId, { atomId, recipientEmail, capability: "view" })).status,
    ).toBe(403);
    // Uniform shape (security review P3): authz precedes body validation, so
    // a non-member gets the SAME 403 for malformed payloads — even non-JSON.
    expect((await postShare(strangerId, { capability: "admin" })).status).toBe(403);
    expect(
      (
        await call(strangerId, `/workspaces/${workspaceId}/shares`, {
          method: "POST",
          body: "not json",
        })
      ).status,
    ).toBe(403);
    expect((await call(strangerId, `/workspaces/${workspaceId}/shares`)).status).toBe(403);

    await postShare(memberId, { atomId, recipientEmail, capability: "view" });
    for (const userId of [memberId, ownerId]) {
      const list = await call(userId, `/workspaces/${workspaceId}/shares`);
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        ok: true,
        shares: [
          {
            atomId,
            atomPath: "notes/shared.md",
            recipientUserId: recipientId,
            capability: "view",
          },
        ],
      });
    }
  });

  it("lists atoms shared WITH the session user on /me/shares", async () => {
    await postShare(memberId, { atomId, recipientEmail, capability: "view" });
    const mine = await call(recipientId, "/me/shares");
    expect(mine.status).toBe(200);
    await expect(mine.json()).resolves.toEqual({
      ok: true,
      shares: [
        {
          shareId: expect.any(String),
          workspaceId,
          atomId,
          atomPath: "notes/shared.md",
          recipientUserId: recipientId,
          recipientEmail,
          capability: "view",
        },
      ],
    });
    await expect((await call(strangerId, "/me/shares")).json()).resolves.toEqual({
      ok: true,
      shares: [],
    });
  });

  it("revokes end to end: only sharer/owner may revoke, and the shared link 403s immediately", async () => {
    const { share } = await (
      await postShare(memberId, { atomId, recipientEmail, capability: "view" })
    ).json();

    // The shared link works before revocation…
    expect((await call(recipientId, `/shared/atoms/${atomId}`)).status).toBe(200);

    // …a fellow member who is NOT the sharer gets an honest 403, while a
    // stranger gets the missing-row 404 (no cross-tenant existence oracle)…
    expect((await call(otherMemberId, `/shares/${share.shareId}`, { method: "DELETE" })).status).toBe(403);
    expect((await call(strangerId, `/shares/${share.shareId}`, { method: "DELETE" })).status).toBe(404);

    // …the sharer can, and the link 403s immediately after.
    const revoked = await call(memberId, `/shares/${share.shareId}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ ok: true, revoked: true });
    expect((await call(recipientId, `/shared/atoms/${atomId}`)).status).toBe(403);

    // Revoked shares vanish from listings and a second DELETE is a 404.
    await expect((await call(memberId, `/workspaces/${workspaceId}/shares`)).json()).resolves.toEqual({ ok: true, shares: [] });
    await expect((await call(recipientId, "/me/shares")).json()).resolves.toEqual({ ok: true, shares: [] });
    expect((await call(memberId, `/shares/${share.shareId}`, { method: "DELETE" })).status).toBe(404);

    // The workspace owner may revoke a share they did not create.
    const { share: second } = await (
      await postShare(memberId, { atomId: otherAtomId, recipientEmail, capability: "view" })
    ).json();
    expect((await call(ownerId, `/shares/${second.shareId}`, { method: "DELETE" })).status).toBe(200);
  });

  it("migration 0005 dedupes pre-existing duplicate audience rows, keeping the newest", async () => {
    // Recreate the pre-0005 world: no audience index, two live rows for the
    // same (workspace, atom, recipient) — the duplicate the racy two-statement
    // upsert could produce.
    await pool.query("drop index if exists shares_audience_unique");
    await pool.query(
      `insert into shares (id, workspace_id, target_kind, target_id,
         recipient_user_id, capability, created_by, created_at)
       values ('e5-shares-dup-old', $1, 'atom', $2, $3, 'edit', $4, now() - interval '1 hour'),
              ('e5-shares-dup-new', $1, 'atom', $2, $3, 'view', $4, now())`,
      [workspaceId, atomId, recipientId, memberId],
    );

    // Re-applying the migration soft-deletes the older duplicate (the newest
    // capability decision wins) and restores the unique index.
    const migration = migrationUrls.find((url) =>
      url.pathname.endsWith("0005_share_audience_unique.sql"),
    )!;
    await pool.query(await readFile(migration, "utf8"));
    const live = await pool.query(
      "select id from shares where workspace_id = $1 and deleted_at is null",
      [workspaceId],
    );
    expect(live.rows).toEqual([{ id: "e5-shares-dup-new" }]);

    // The index is back: the single-statement upsert updates that row in
    // place instead of inserting a second live one.
    const reshared = await postShare(memberId, { atomId, recipientEmail, capability: "edit" });
    expect(reshared.status).toBe(200);
    await expect(reshared.json()).resolves.toMatchObject({
      ok: true,
      share: { shareId: "e5-shares-dup-new", capability: "edit" },
    });
  });
});
