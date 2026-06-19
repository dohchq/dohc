import type { Actor } from "@dohc/workspace-contracts";
import type pg from "pg";
import type { SharedAtomDeps } from "./shared";
import { assertWorkspaceAccess } from "./shares";

export type WorkspaceMemberRow = {
  userId: string;
  email: string | null;
  role: string;
};

type DbMemberRow = {
  user_id: string;
  email: string | null;
  role: string;
  is_owner: boolean;
};

export async function listWorkspaceMembers(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
): Promise<{ ok: true; members: WorkspaceMemberRow[] }> {
  const pool = requirePool(deps);
  await assertWorkspaceAccess(pool, actor);
  const { rows } = await pool.query<DbMemberRow>(
    `with member_rows as (
       select m.user_id, m.role, m.created_at
       from workspace_members m
       where m.workspace_id = $1 and m.deleted_at is null
       union all
       select w.owner_user_id as user_id, 'owner' as role, w.created_at
       from workspaces w
       where w.workspace_id = $1 and w.deleted_at is null
     )
     select r.user_id,
       coalesce(auth_user.email, legacy_user.email) as email,
       r.role,
       exists(select 1 from workspaces w
         where w.workspace_id = $1 and w.owner_user_id = r.user_id
           and w.deleted_at is null) as is_owner
     from member_rows r
     left join "user" auth_user on auth_user.id = r.user_id
     left join users legacy_user on legacy_user.id = r.user_id
     order by r.created_at asc, r.user_id asc`,
    [actor.workspaceId],
  );
  const members = new Map<string, WorkspaceMemberRow>();
  for (const row of rows) {
    const existing = members.get(row.user_id);
    const role = row.is_owner ? "owner" : row.role;
    if (!existing) {
      members.set(row.user_id, {
        userId: row.user_id,
        email: row.email,
        role,
      });
      continue;
    }
    if (existing.role !== "owner" && role === "owner") {
      members.set(row.user_id, { ...existing, role });
    }
  }
  return { ok: true, members: [...members.values()] };
}

function requirePool(deps: SharedAtomDeps | undefined): pg.Pool {
  if (!deps?.pool) {
    const error = new Error("workspace members are not configured on this server");
    (error as Error & { code?: string }).code = "not-found";
    throw error;
  }
  return deps.pool;
}
