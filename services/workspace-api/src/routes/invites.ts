import { randomUUID } from "node:crypto";
import type { Actor } from "@dohc/workspace-contracts";
import type pg from "pg";
import type { SharedAtomDeps } from "./shared";
import { assertWorkspaceAccess } from "./shares";

// Member invitations (plan Phase E5 server lane; closes the convex-deletion
// review gap): inviting an EXISTING user writes the workspace_members row
// immediately and records the invitation claimed; an unknown email leaves a
// pending workspace_invitations row that claimWorkspaceInvitations (the
// Better Auth afterEmailVerification hook) converts to membership once the
// signer VERIFIES the invited address — never at bare signup.
//
// The claimed-vs-pending status an inviter sees is an ACCEPTED member-gated
// account-existence oracle (security review P3): it is inherent to the
// share-vs-invite UX (the pending list must exclude claimed rows anyway) and
// only authenticated workspace members reach it.

export type InviteRow = {
  inviteId: string;
  workspaceId: string;
  email: string;
  role: string;
  invitedBy: string;
  status: "pending" | "claimed";
};

export async function createInvite(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
  body: { email?: string },
): Promise<{ ok: true; invite: InviteRow }> {
  const pool = requirePool(deps);
  if (typeof body.email !== "string" || !body.email.includes("@")) {
    throw new Error("email must be an email address");
  }
  await assertWorkspaceAccess(pool, actor);

  const user = await pool.query<{ id: string }>(
    `select id from "user" where lower(email) = lower($1) limit 1`,
    [body.email],
  );
  if (user.rows[0]) {
    // Existing user: membership lands now; the invitation row is the audit
    // trail and is born claimed. Idempotent on the membership unique index.
    await addMember(pool, actor.workspaceId, user.rows[0].id, "member");
    const { rows } = await pool.query<DbInviteRow>(
      `insert into workspace_invitations (id, workspace_id, email, invited_by, role, claimed_at)
       values ($1, $2, $3, $4, 'member', now())
       returning ${INVITE_RETURNING}`,
      [randomUUID(), actor.workspaceId, body.email, actor.userId],
    );
    return { ok: true, invite: toInvite(rows[0]) };
  }

  // Unknown email: ONE live pending row per (workspace, email) — a double
  // invite upserts onto the existing row (partial unique index, migration
  // 0004); the no-op DO UPDATE makes RETURNING yield it.
  const { rows } = await pool.query<DbInviteRow>(
    `insert into workspace_invitations (id, workspace_id, email, invited_by, role)
     values ($1, $2, $3, $4, 'member')
     on conflict (workspace_id, (lower(email))) where claimed_at is null and deleted_at is null
     do update set invited_by = workspace_invitations.invited_by
     returning ${INVITE_RETURNING}`,
    [randomUUID(), actor.workspaceId, body.email, actor.userId],
  );
  return { ok: true, invite: toInvite(rows[0]) };
}

// DELETE /invites/:id — revoke a PENDING invitation (members/owners of its
// workspace); claimed or already-revoked rows are a 404.
export async function revokeInvite(
  deps: SharedAtomDeps | undefined,
  userId: string,
  inviteId: string,
): Promise<{ ok: true; revoked: true }> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<{ workspace_id: string }>(
    `select workspace_id from workspace_invitations
     where id = $1 and claimed_at is null and deleted_at is null`,
    [inviteId],
  );
  if (!rows[0]) throw coded("not-found", "pending invitation not found");
  try {
    await assertWorkspaceAccess(pool, { userId, workspaceId: rows[0].workspace_id });
  } catch {
    // Any member may revoke, so only strangers fail this check — a 403 would
    // confirm the foreign inviteId exists (security review P3 cross-tenant
    // oracle); collapse it into the missing-row 404.
    throw coded("not-found", "pending invitation not found");
  }
  await pool.query("update workspace_invitations set deleted_at = now() where id = $1", [
    inviteId,
  ]);
  return { ok: true, revoked: true };
}

// GET /workspaces/:workspaceId/invites — pending only, members/owners only.
export async function listInvites(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
): Promise<{ ok: true; invites: InviteRow[] }> {
  const pool = requirePool(deps);
  await assertWorkspaceAccess(pool, actor);
  const { rows } = await pool.query<DbInviteRow>(
    `select ${INVITE_RETURNING} from workspace_invitations
     where workspace_id = $1 and claimed_at is null and deleted_at is null
     order by created_at asc, id asc`,
    [actor.workspaceId],
  );
  return { ok: true, invites: rows.map(toInvite) };
}

// Better Auth afterEmailVerification hook body (and user.create.after for
// accounts born verified): pending invitations for the VERIFIED email become
// workspace_members rows. Revoked rows never claim.
export async function claimWorkspaceInvitations(
  pool: pg.Pool,
  user: { id: string; email: string },
): Promise<void> {
  const { rows } = await pool.query<{ workspace_id: string; role: string }>(
    `update workspace_invitations set claimed_at = now()
     where lower(email) = lower($1) and claimed_at is null and deleted_at is null
     returning workspace_id, role`,
    [user.email],
  );
  for (const row of rows) {
    await addMember(pool, row.workspace_id, user.id, row.role);
  }
}

// Membership write shared by invite-existing-user and claim-on-verification:
// a LIVE membership keeps its role (re-inviting the owner never downgrades),
// but reviving a soft-deleted row resets the role to the INVITED one — a
// plain member's re-invite must not resurrect a removed user's prior
// elevated role (security review P3 privilege-escalation-by-revival).
async function addMember(pool: pg.Pool, workspaceId: string, userId: string, role: string) {
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, $4)
     on conflict (workspace_id, user_id)
     do update set
       role = case when workspace_members.deleted_at is null
         then workspace_members.role else excluded.role end,
       deleted_at = null, updated_at = now()`,
    [randomUUID(), workspaceId, userId, role],
  );
}

const INVITE_RETURNING = "id, workspace_id, email, invited_by, role, claimed_at";

type DbInviteRow = {
  id: string;
  workspace_id: string;
  email: string;
  invited_by: string;
  role: string;
  claimed_at: Date | null;
};

function toInvite(row: DbInviteRow): InviteRow {
  return {
    inviteId: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    status: row.claimed_at ? "claimed" : "pending",
  };
}

function requirePool(deps: SharedAtomDeps | undefined): pg.Pool {
  if (!deps?.pool) throw coded("not-found", "invitations are not configured on this server");
  return deps.pool;
}

function coded(code: string, message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
