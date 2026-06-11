import { readFile } from "node:fs/promises";
import type { WorkspaceBackend } from "@dohc/workspace-contracts";
import { defaultPostgresUrl } from "@dohc/workspace-postgres";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceAuth } from "../auth/betterAuth";
import { claimWorkspaceInvitations } from "./invites";
import { createWorkspaceApiHandler } from "../server";

// Live-pg member invitations (plan Phase E5 server lane; closes the tracked
// convex-deletion gap): inviting an existing VERIFIED user grants membership
// now; unknown AND unverified emails leave a pending row that a REAL Better
// Auth email VERIFICATION (driven through the node handler) claims — bare
// signup never does; revoked invitations never claim, including under a
// concurrent revoke/claim race (deterministic two-client interleavings).
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
const raceClaimerId = "e5_invites_race_claimer";
const raceVerifierId = "e5_invites_race_verifier";
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

// Real Better Auth signup/verification driven through the node handler:
// sendOnSignUp delivers the verification URL through the sendEmail seam, the
// test captures it per-address and replays it.
function authHarness() {
  const verifyUrls = new Map<string, string>();
  const auth = createWorkspaceAuth({
    pool,
    baseURL: "http://localhost:1786",
    secret: "test-secret-0123456789abcdef0123456789abcdef",
    sendEmail: async (to, _subject, body) => {
      verifyUrls.set(to, body);
    },
  });
  const signUp = async (email: string) => {
    const response = await auth.handler(
      new Request("http://localhost:1786/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "a-real-password-123", name: "Invited User" }),
      }),
    );
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    return user;
  };
  const verify = async (email: string) => {
    const response = await auth.handler(new Request(verifyUrls.get(email)!));
    expect([200, 302]).toContain(response.status);
  };
  return { signUp, verify };
}

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
  // VERIFIED: invites resolve existing users among verified accounts only
  // (security review P1); the unverified case has its own test below.
  await pool.query(
    `insert into "user" (id, name, email, "emailVerified") values ($1, 'Existing', $2, true)`,
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
    // Uniform shape (security review P3): authz precedes body validation, so
    // a non-member gets the SAME 403 for malformed payloads — even non-JSON.
    expect((await postInvite(strangerId, "not-an-email")).status).toBe(403);
    expect(
      (
        await call(strangerId, `/workspaces/${workspaceId}/invites`, {
          method: "POST",
          body: "not json",
        })
      ).status,
    ).toBe(403);
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
    const { signUp, verify } = authHarness();

    // Invited then signed up: NO membership yet (the address is unproven)…
    const invitedEmail = unique();
    const { invite } = await (await postInvite(memberId, invitedEmail)).json();
    const user = await signUp(invitedEmail);
    expect((await membershipFor(user.id)).rowCount).toBe(0);

    // …then email verification lands membership and claims the invitation.
    await verify(invitedEmail);
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
    const revokedUser = await signUp(revokedEmail);
    await verify(revokedEmail);
    expect((await membershipFor(revokedUser.id)).rowCount).toBe(0);
  }, 30_000);

  it("treats an UNVERIFIED existing account as unproven: the invite stays pending until THEIR verification claims it", async () => {
    const { signUp, verify } = authHarness();

    // The account exists FIRST, unverified (a squatter — or just a slow
    // verifier — security review P1)…
    const email = unique();
    const user = await signUp(email);

    // …inviting that address must NOT hand the unverified account membership;
    // it records the same pending row an unknown email gets.
    const invited = await (await postInvite(memberId, email)).json();
    expect(invited).toMatchObject({
      ok: true,
      invite: { workspaceId, email, status: "pending" },
    });
    expect((await membershipFor(user.id)).rowCount).toBe(0);

    // afterEmailVerification fires for EXISTING-account verification too, and
    // claims the invitation created AFTER the account: proof of mailbox
    // control is what converts the pending row, never account age.
    await verify(email);
    expect((await membershipFor(user.id)).rows).toEqual([{ role: "member" }]);
    const claimed = await pool.query(
      "select claimed_at from workspace_invitations where id = $1",
      [invited.invite.inviteId],
    );
    expect(claimed.rows[0]?.claimed_at).not.toBeNull();
  }, 30_000);

  it("revoke 404s when a verification claim is in flight: membership stands, never a false success", async () => {
    const email = unique();
    const { invite } = await (await postInvite(memberId, email)).json();

    const claimer = await pool.connect();
    try {
      // The exact conditional claim claimWorkspaceInvitations runs, held open
      // in an explicit transaction: this client now owns the row lock.
      await claimer.query("begin");
      const claimed = await claimer.query(
        `update workspace_invitations set claimed_at = now()
         where lower(email) = lower($1) and claimed_at is null and deleted_at is null
         returning workspace_id, role`,
        [email],
      );
      expect(claimed.rowCount).toBe(1);

      // Dispatch the REAL revoke route now: its conditional UPDATE blocks on
      // the locked row, so the interleaving is deterministic — revoke only
      // proceeds after the claim commits, re-evaluates its WHERE, and finds
      // claimed_at set → zero rows → 404.
      const revoke = call(ownerId, `/invites/${invite.inviteId}`, { method: "DELETE" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await claimer.query(
        `insert into workspace_members (id, workspace_id, user_id, role)
         values ('e5-invites-m-race-a', $1, $2, 'member')`,
        [workspaceId, raceClaimerId],
      );
      await claimer.query("commit");
      expect((await revoke).status).toBe(404);
    } finally {
      claimer.release();
    }

    // The membership stands and the invitation is claimed, NOT revoked — the
    // owner saw a 404, never `revoked: true` over a live membership.
    expect((await membershipFor(raceClaimerId)).rows).toEqual([{ role: "member" }]);
    const row = await pool.query(
      "select claimed_at, deleted_at from workspace_invitations where id = $1",
      [invite.inviteId],
    );
    expect(row.rows[0].claimed_at).not.toBeNull();
    expect(row.rows[0].deleted_at).toBeNull();
  });

  it("a claim arriving while revoke holds the row never lands membership", async () => {
    const email = unique();
    const { invite } = await (await postInvite(memberId, email)).json();

    const revoker = await pool.connect();
    try {
      // The exact conditional revoke the route runs, held open: this client
      // owns the row lock with deleted_at set but uncommitted.
      await revoker.query("begin");
      const revoked = await revoker.query(
        `update workspace_invitations set deleted_at = now()
         where id = $1 and claimed_at is null and deleted_at is null
         returning id`,
        [invite.inviteId],
      );
      expect(revoked.rowCount).toBe(1);

      // Dispatch the REAL claim path now: its conditional UPDATE blocks on
      // the locked row, re-evaluates after commit, sees deleted_at set, and
      // skips the row — deterministically, no membership.
      const claim = claimWorkspaceInvitations(pool, { id: raceVerifierId, email });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await revoker.query("commit");
      await claim;
    } finally {
      revoker.release();
    }

    expect((await membershipFor(raceVerifierId)).rowCount).toBe(0);
    const row = await pool.query(
      "select claimed_at, deleted_at from workspace_invitations where id = $1",
      [invite.inviteId],
    );
    expect(row.rows[0].claimed_at).toBeNull();
    expect(row.rows[0].deleted_at).not.toBeNull();
  });
});
