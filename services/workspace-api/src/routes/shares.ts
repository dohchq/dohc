import { randomUUID } from "node:crypto";
import type { Actor } from "@dohc/workspace-contracts";
import type pg from "pg";
import type { SharedAtomDeps } from "./shared";

// Share lifecycle for the repositioned product (plan Phase E5 server lane):
// members/owners share ONE atom with an EXISTING user by email; re-sharing
// the same atom+recipient updates capability in place (the old Convex
// audience-upsert semantics); revocation is a soft delete that the
// GET /shared/atoms/:atomId resolver honors immediately. Unknown emails are
// the invitation flow (invites.ts), never a share row.

export type ShareCapability = "view" | "edit";

export type CreateShareRequest = {
  atomId?: string;
  atomPath?: string;
  recipientEmail?: string;
  capability?: ShareCapability;
};

export type ShareRow = {
  shareId: string;
  workspaceId: string;
  atomId: string;
  atomPath: string | null;
  recipientUserId: string;
  recipientEmail: string;
  capability: ShareCapability;
};

export async function createShare(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
  body: CreateShareRequest,
): Promise<{ ok: true; share: ShareRow }> {
  const pool = requirePool(deps);
  const { atomId, atomPath, recipientEmail, capability } = body;
  if (capability !== "view" && capability !== "edit") {
    throw new Error('capability must be "view" or "edit"');
  }
  if (typeof recipientEmail !== "string" || !recipientEmail.includes("@")) {
    throw new Error("recipientEmail must be an email address");
  }
  if ((atomId === undefined) === (atomPath === undefined)) {
    throw new Error("exactly one of atomId or atomPath is required");
  }
  await assertWorkspaceAccess(pool, actor);

  // The atom must be a LIVE row in the route's workspace whichever way the
  // caller names it (share links are keyed by atoms.id, see shared.ts).
  const atom = await pool.query<{ id: string; path: string }>(
    `select id, path from atoms
     where workspace_id = $1 and deleted_at is null
       and ${atomId !== undefined ? "id = $2" : "path = $2"}
     limit 1`,
    [actor.workspaceId, atomId ?? atomPath],
  );
  if (!atom.rows[0]) throw coded("not-found", "atom not found in this workspace");

  // Recipients are resolved server-side from the Better Auth user table;
  // pending-email sharing is the invitation flow, NOT a share row. The
  // distinct 404 here is an ACCEPTED member-gated account-existence oracle
  // (security review P3): only authenticated workspace members reach it, and
  // silently falling through to an invitation would escalate an atom-scoped
  // share request into full workspace membership.
  const recipient = await pool.query<{ id: string; email: string }>(
    `select id, email from "user" where lower(email) = lower($1) limit 1`,
    [recipientEmail],
  );
  if (!recipient.rows[0]) {
    throw coded("not-found", "no user with that email — invite them to the workspace instead");
  }

  // Audience upsert: one live share per (atom, recipient); re-sharing only
  // moves capability. Two statements keep us off ON CONFLICT (the shares
  // table predates a uniqueness index for this triple).
  const updated = await pool.query<DbShareRow>(
    `update shares set capability = $1, updated_at = now()
     where workspace_id = $2 and target_kind = 'atom' and target_id = $3
       and recipient_user_id = $4 and deleted_at is null
     returning ${SHARE_RETURNING}`,
    [capability, actor.workspaceId, atom.rows[0].id, recipient.rows[0].id],
  );
  const row =
    updated.rows[0] ??
    (
      await pool.query<DbShareRow>(
        `insert into shares (id, workspace_id, target_kind, target_id,
           recipient_user_id, recipient_email, capability, created_by)
         values ($1, $2, 'atom', $3, $4, $5, $6, $7)
         returning ${SHARE_RETURNING}`,
        [
          randomUUID(),
          actor.workspaceId,
          atom.rows[0].id,
          recipient.rows[0].id,
          recipient.rows[0].email,
          capability,
          actor.userId,
        ],
      )
    ).rows[0];
  return { ok: true, share: { ...toShare(row), atomPath: atom.rows[0].path } };
}

// DELETE /shares/:shareId — soft delete by the sharer or the workspace owner.
// Fellow members get a 403; callers with NO relationship to the share's
// workspace get the same 404 as a missing id, so the response never confirms
// a foreign shareId exists (security review P3 cross-tenant oracle).
export async function revokeShare(
  deps: SharedAtomDeps | undefined,
  userId: string,
  shareId: string,
): Promise<{ ok: true; revoked: true }> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<{
    created_by: string | null;
    is_owner: boolean;
    is_member: boolean;
  }>(
    `select s.created_by,
       exists(select 1 from workspaces w
         where w.workspace_id = s.workspace_id and w.owner_user_id = $2
           and w.deleted_at is null) as is_owner,
       exists(select 1 from workspace_members m
         where m.workspace_id = s.workspace_id and m.user_id = $2
           and m.deleted_at is null) as is_member
     from shares s where s.id = $1 and s.deleted_at is null`,
    [shareId, userId],
  );
  if (!rows[0]) throw coded("not-found", "share not found");
  if (rows[0].created_by !== userId && !rows[0].is_owner) {
    // Members already see the share via listWorkspaceShares, so an honest
    // 403 leaks nothing to them; strangers must not learn the id is live.
    if (!rows[0].is_member) throw coded("not-found", "share not found");
    throw coded("forbidden", "only the sharer or the workspace owner may revoke");
  }
  await pool.query("update shares set deleted_at = now(), updated_at = now() where id = $1", [
    shareId,
  ]);
  return { ok: true, revoked: true };
}

// GET /workspaces/:workspaceId/shares — live shares, members/owners only.
export async function listWorkspaceShares(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
): Promise<{ ok: true; shares: ShareRow[] }> {
  const pool = requirePool(deps);
  await assertWorkspaceAccess(pool, actor);
  const { rows } = await pool.query<DbShareRow>(
    `select ${SHARE_RETURNING_S}, a.path as atom_path
     from shares s left join atoms a on a.id = s.target_id and a.deleted_at is null
     where s.workspace_id = $1 and s.target_kind = 'atom' and s.deleted_at is null
     order by s.created_at asc, s.id asc`,
    [actor.workspaceId],
  );
  return { ok: true, shares: rows.map(toShare) };
}

// GET /me/shares — atoms shared WITH the session user ("shared with me");
// shares onto deleted atoms are hidden, like the shared-link resolver.
export async function listMyShares(
  deps: SharedAtomDeps | undefined,
  userId: string,
): Promise<{ ok: true; shares: ShareRow[] }> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<DbShareRow>(
    `select ${SHARE_RETURNING_S}, a.path as atom_path
     from shares s join atoms a on a.id = s.target_id and a.deleted_at is null
     where s.recipient_user_id = $1 and s.target_kind = 'atom' and s.deleted_at is null
     order by s.created_at asc, s.id asc`,
    [userId],
  );
  return { ok: true, shares: rows.map(toShare) };
}

// Same member-or-owner predicate the shared-link resolver uses; route access
// for the share/invite surfaces is resolved directly against Postgres.
export async function assertWorkspaceAccess(pool: pg.Pool, actor: Actor): Promise<void> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `select exists(select 1 from workspace_members m
        where m.workspace_id = $1 and m.user_id = $2 and m.deleted_at is null)
      or exists(select 1 from workspaces w
        where w.workspace_id = $1 and w.owner_user_id = $2 and w.deleted_at is null)
      as ok`,
    [actor.workspaceId, actor.userId],
  );
  if (!rows[0]?.ok) throw coded("forbidden", "not a member of this workspace");
}

const SHARE_RETURNING =
  "id, workspace_id, target_id, recipient_user_id, recipient_email, capability";
const SHARE_RETURNING_S =
  "s.id, s.workspace_id, s.target_id, s.recipient_user_id, s.recipient_email, s.capability";

type DbShareRow = {
  id: string;
  workspace_id: string;
  target_id: string;
  recipient_user_id: string;
  recipient_email: string | null;
  capability: ShareCapability;
  atom_path?: string | null;
};

function toShare(row: DbShareRow): ShareRow {
  return {
    shareId: row.id,
    workspaceId: row.workspace_id,
    atomId: row.target_id,
    atomPath: row.atom_path ?? null,
    recipientUserId: row.recipient_user_id,
    recipientEmail: row.recipient_email ?? "",
    capability: row.capability,
  };
}

function requirePool(deps: SharedAtomDeps | undefined): pg.Pool {
  if (!deps?.pool) throw coded("not-found", "sharing is not configured on this server");
  return deps.pool;
}

function coded(code: string, message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
