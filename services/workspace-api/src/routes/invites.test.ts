import { readFile } from "node:fs/promises";
import type { WorkspaceBackend } from "@dohc/workspace-contracts";
import { defaultPostgresUrl } from "@dohc/workspace-postgres";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceAuth } from "../auth/betterAuth";
import { createWorkspaceApiHandler } from "../server";

// Live-pg member invitations (plan Phase E5 server lane; closes the tracked
// convex-deletion gap): inviting an existing user grants membership now;
// unknown emails leave a pending row that a REAL Better Auth email
// VERIFICATION (driven through the node handler) claims — bare signup never
// does; revoked invitations never claim.
const migrationUrls = ["0001_initial.sql", "0002_better_auth.sql", "0004_invitations.sql"].map(
  (name) =>
    new URL(`../../../../packages/workspace-postgres/src/db/migrations/${name}`, import.meta.url),
);

const workspaceId = "e5-invites-ws";
const ownerId = "e5_invites_owner";
const memberId = "e5_invites_member";
const strangerId = "e5_invites_stranger";
const existingUserId = "e5_invites_existing";
const existingEmail = "e5-invites-existing@dohc.test";
// Signup emails must be unique across runs (the Better Auth user table
// outlives the workspace fixtures).
const unique = () => `e5-invites-${Date.now()}-${Math.floor(Math.random() * 1e6)}@dohc.test`;

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

const postInvite = (userId: string, email: string) =>
  call(userId, `/workspaces/${workspaceId}/invites`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });

const membershipFor = (userId: string) =>
  pool.query(
    `select role from workspace_members
     where workspace_id = $1 and user_id = $2 and deleted_at is null`,
    [workspaceId, userId],
  );

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl });
  for (const url of migrationUrls) await pool.query(await readFile(url, "utf8"));
  await clearFixtures();
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'Invites', 'shared')`,
    [workspaceId, ownerId],
  );
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ('e5-invites-m-owner', $1, $2, 'owner'),
            ('e5-invites-m-member', $1, $3, 'member')`,
    [workspaceId, ownerId, memberId],
  );
  await pool.query(
    `insert into "user" (id, name, email, "emailVerified") values ($1, 'Existing', $2, false)`,
    [existingUserId, existingEmail],
  );
});

afterEach(async () => {
  await clearFixtures();
  await pool?.end();
});

async function clearFixtures() {
  for (const table of ["workspace_invitations", "workspace_members", "workspaces"]) {
    await pool.query(`delete from ${table} where workspace_id = $1`, [workspaceId]);
  }
  await pool.query(`delete from "user" where email like 'e5-invites-%'`);
}

describe("workspace invitation routes (live pg)", () => {
  it("invites an EXISTING user: immediate membership, invitation born claimed, idempotent", async () => {
    const first = await postInvite(memberId, existingEmail);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      invite: { workspaceId, email: existingEmail, role: "member", status: "claimed" },
    });
    expect((await membershipFor(existingUserId)).rows).toEqual([{ role: "member" }]);

    // Double-invite: still one live membership row, still ok.
    expect((await postInvite(ownerId, existingEmail)).status).toBe(200);
    expect((await membershipFor(existingUserId)).rowCount).toBe(1);
    // Claimed invitations never show in the pending list.
    await expect((await call(memberId, `/workspaces/${workspaceId}/invites`)).json()).resolves.toEqual({ ok: true, invites: [] });
  });

  it("records a pending invitation for unknown emails; double-invite is idempotent", async () => {
    const email = unique();
    const first = await (await postInvite(memberId, email)).json();
    expect(first).toMatchObject({
      ok: true,
      invite: { workspaceId, email, role: "member", status: "pending", invitedBy: memberId },
    });

    const second = await (await postInvite(ownerId, email)).json();
    expect(second.invite.inviteId).toBe(first.invite.inviteId);
    expect(
      (await pool.query("select 1 from workspace_invitations where workspace_id = $1", [workspaceId])).rowCount,
    ).toBe(1);

    const list = await call(ownerId, `/workspaces/${workspaceId}/invites`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      ok: true,
      invites: [{ inviteId: first.invite.inviteId, email, status: "pending" }],
    });
  });

  it("403s non-members on create/list; strangers on revoke get the missing-row 404; rejects bad emails", async () => {
    expect((await postInvite(strangerId, unique())).status).toBe(403);
    expect((await call(strangerId, `/workspaces/${workspaceId}/invites`)).status).toBe(403);
    expect((await postInvite(ownerId, "not-an-email")).status).toBe(400);

    // A stranger's DELETE must not confirm the foreign inviteId exists.
    const { invite } = await (await postInvite(memberId, unique())).json();
    expect((await call(strangerId, `/invites/${invite.inviteId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("re-invite of a REMOVED member revives at the invited role; a live elevated role is untouched", async () => {
    // Removed-with-elevated-role: revival must NOT resurrect the old role.
    await postInvite(memberId, existingEmail);
    await pool.query(
      `update workspace_members set role = 'owner', deleted_at = now()
       where workspace_id = $1 and user_id = $2`,
      [workspaceId, existingUserId],
    );
    expect((await postInvite(memberId, existingEmail)).status).toBe(200);
    expect((await membershipFor(existingUserId)).rows).toEqual([{ role: "member" }]);

    // Live elevated membership: re-inviting the owner never downgrades.
    const ownerEmail = "e5-invites-owner@dohc.test";
    await pool.query(
      `insert into "user" (id, name, email, "emailVerified") values ($1, 'Owner', $2, true)`,
      [ownerId, ownerEmail],
    );
    expect((await postInvite(memberId, ownerEmail)).status).toBe(200);
    expect((await membershipFor(ownerId)).rows).toEqual([{ role: "owner" }]);
  });

  it("revokes a pending invitation (members/owners); revoking twice is a 404", async () => {
    const { invite } = await (await postInvite(memberId, unique())).json();
    const revoked = await call(ownerId, `/invites/${invite.inviteId}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ ok: true, revoked: true });
    await expect((await call(memberId, `/workspaces/${workspaceId}/invites`)).json()).resolves.toEqual({ ok: true, invites: [] });
    expect((await call(ownerId, `/invites/${invite.inviteId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("claims pending invitations only on REAL Better Auth email VERIFICATION — never on bare signup, never for revoked rows", async () => {
    // sendOnSignUp delivers the verification URL through the sendEmail seam;
    // the test captures it per-address and drives the verify-email route.
    const verifyUrls = new Map<string, string>();
    const auth = createWorkspaceAuth({
      pool,
      baseURL: "http://localhost:1786",
      secret: "test-secret-0123456789abcdef0123456789abcdef",
      sendEmail: async (to, _subject, body) => {
        verifyUrls.set(to, body);
      },
    });
    const signUp = (email: string) =>
      auth.handler(
        new Request("http://localhost:1786/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "a-real-password-123", name: "Invited User" }),
        }),
      );
    const verify = (email: string) => auth.handler(new Request(verifyUrls.get(email)!));

    // Invited then signed up: NO membership yet (the address is unproven)…
    const invitedEmail = unique();
    const { invite } = await (await postInvite(memberId, invitedEmail)).json();
    const response = await signUp(invitedEmail);
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    expect((await membershipFor(user.id)).rowCount).toBe(0);

    // …then email verification lands membership and claims the invitation.
    expect([200, 302]).toContain((await verify(invitedEmail)).status);
    expect((await membershipFor(user.id)).rows).toEqual([{ role: "member" }]);
    const claimed = await pool.query(
      "select claimed_at from workspace_invitations where id = $1",
      [invite.inviteId],
    );
    expect(claimed.rows[0]?.claimed_at).not.toBeNull();

    // Revoked BEFORE verification: signup + verify succeed, no membership.
    const revokedEmail = unique();
    const { invite: revokedInvite } = await (await postInvite(memberId, revokedEmail)).json();
    await call(memberId, `/invites/${revokedInvite.inviteId}`, { method: "DELETE" });
    const revokedResponse = await signUp(revokedEmail);
    expect(revokedResponse.status).toBe(200);
    const { user: revokedUser } = (await revokedResponse.json()) as { user: { id: string } };
    expect([200, 302]).toContain((await verify(revokedEmail)).status);
    expect((await membershipFor(revokedUser.id)).rowCount).toBe(0);
  }, 30_000);
});
