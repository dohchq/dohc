import type pg from "pg";

export type HocuspocusAdminClient = {
  disconnectWorkspaceUser(input: {
    workspaceId: string;
    userId: string;
    signal?: AbortSignal;
  }): Promise<void>;
};

export type SharedAtomDeps = { pool: pg.Pool; hocuspocusAdmin?: HocuspocusAdminClient };

export type SharedAtomResult = {
  ok: true;
  atomId: string;
  workspaceId: string;
  path: string;
  body: string;
  capability: "view" | "edit";
};

type SharedAtomRow = {
  workspace_id: string;
  path: string;
  body: string;
  is_member: boolean;
  is_owner: boolean;
  has_view_share: boolean;
  has_edit_share: boolean;
};

// "Public signed-in" share resolution for the repositioned web client: the
// session user reads ONE atom by stable id when they are a workspace
// member/owner or hold a live (deleted_at null) atom share. Mirrors the
// hocuspocus postgres-acl ACCESS_SQL semantics in one round-trip; keyed by
// atoms.id because share links outlive path renames.
const SHARED_ATOM_SQL = `
  select
    a.workspace_id,
    a.path,
    a.body,
    exists(select 1 from workspace_members m
      where m.workspace_id = a.workspace_id and m.user_id = $2
        and m.deleted_at is null) as is_member,
    exists(select 1 from workspaces w
      where w.workspace_id = a.workspace_id and w.owner_user_id = $2
        and w.deleted_at is null) as is_owner,
    exists(select 1 from shares s
      where s.workspace_id = a.workspace_id and s.target_kind = 'atom' and s.target_id = a.id
        and s.recipient_user_id = $2 and s.capability in ('view', 'edit')
        and s.deleted_at is null) as has_view_share,
    exists(select 1 from shares s
      where s.workspace_id = a.workspace_id and s.target_kind = 'atom' and s.target_id = a.id
        and s.recipient_user_id = $2 and s.capability = 'edit'
        and s.deleted_at is null) as has_edit_share
  from atoms a
  where a.id = $1 and a.deleted_at is null
  limit 1
`;

export async function resolveSharedAtom(
  deps: SharedAtomDeps | undefined,
  userId: string,
  atomId: string,
): Promise<SharedAtomResult> {
  if (!deps?.pool) {
    throw coded("not-found", "shared links are not configured on this server");
  }
  const { rows } = await deps.pool.query<SharedAtomRow>(SHARED_ATOM_SQL, [atomId, userId]);
  const row = rows[0];
  // Missing and deleted atoms are indistinguishable 404s; an existing atom the
  // user cannot read is a 403 (the session already proves who is asking).
  if (!row) throw coded("not-found", "atom not found");
  const capability = row.is_member || row.is_owner || row.has_edit_share
    ? ("edit" as const)
    : row.has_view_share
      ? ("view" as const)
      : undefined;
  if (!capability) throw coded("forbidden", "no access to this atom");
  return {
    ok: true,
    atomId,
    workspaceId: row.workspace_id,
    path: row.path,
    body: row.body,
    capability,
  };
}

function coded(code: string, message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
