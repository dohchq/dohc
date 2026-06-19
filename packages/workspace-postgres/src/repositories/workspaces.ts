import type pg from "pg";

export type PgQueryable = pg.Pool | pg.PoolClient;

export const workspaceFixtureIds = {
  aliceUserId: "alice",
  bobUserId: "bob",
  aliceWorkspaceId: "workspace_a",
  bobWorkspaceId: "workspace_b",
} as const;

export async function hasWorkspaceMembership(
  db: PgQueryable,
  userId: string,
  workspaceId: string,
) {
  const result = await db.query(
    `
      select 1
      from workspace_members
      where workspace_id = $1
        and user_id = $2
        and deleted_at is null
      limit 1
    `,
    [workspaceId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export type UserWorkspace = { workspaceId: string; name: string | null };

// Every workspace the user can open in the cloud client: live membership rows
// plus ownership (owners always see their workspace even if a membership row
// was never written). Soft deletes hide both sides.
export async function listUserWorkspaces(
  db: PgQueryable,
  userId: string,
): Promise<UserWorkspace[]> {
  const result = await db.query<{ workspace_id: string; name: string | null }>(
    `
      select w.workspace_id, w.name
      from workspaces w
      where w.deleted_at is null
        and (
          w.owner_user_id = $1
          or exists(
            select 1 from workspace_members m
            where m.workspace_id = w.workspace_id
              and m.user_id = $1
              and m.deleted_at is null
          )
        )
      order by w.name asc, w.workspace_id asc
    `,
    [userId],
  );
  return result.rows.map((row) => ({ workspaceId: row.workspace_id, name: row.name }));
}

export async function seedWorkspaceMembershipFixtures(db: PgQueryable) {
  await db.query(
    `
      insert into users (id, workspace_id, token_identifier, email, name)
      values
        ('alice', 'workspace_a', 'token:alice', 'alice@example.com', 'Alice'),
        ('bob', 'workspace_b', 'token:bob', 'bob@example.com', 'Bob')
      on conflict (id) do nothing
    `,
  );

  await db.query(
    `
      insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
      values
        ('workspace_a', 'workspace_a', 'alice', 'alice', 'Alice', 'personal'),
        ('workspace_b', 'workspace_b', 'bob', 'bob', 'Bob', 'personal')
      on conflict (id) do nothing
    `,
  );

  await db.query(
    `
      insert into workspace_members (id, workspace_id, user_id, role)
      values
        ('member_alice_workspace_a', 'workspace_a', 'alice', 'owner'),
        ('member_bob_workspace_b', 'workspace_b', 'bob', 'owner')
      on conflict (workspace_id, user_id) do nothing
    `,
  );
}
