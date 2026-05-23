// Role gates for org workspaces (org-plan.md §6).
//
// Personal workspaces grant implicit Owner to their owner — no
// memberships row is needed (workspaceId == WorkOS subject ⇒ self).
// Org workspaces gate on the `memberships` row's `role` field.
//
// v1 roles: 'owner' | 'member'. Multiple Owners allowed (decisions.md
// §2). The Admin tier was cut after the round-2 review (it differed
// from Owner on exactly one row in the matrix; multiple-Owners covers
// shared admin work). Add it back when a real Admin-but-not-Owner
// privilege gap emerges.

import type { QueryCtx, MutationCtx } from './_generated/server'

export type Role = 'owner' | 'member'

/** Read the caller's role in the given workspace. `null` if the
 *  caller has no access. Personal self-access returns `'owner'`. */
export async function readRole(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<Role | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return null
  const subject = identity.subject
  if (workspaceId === subject) return 'owner'
  const m = await ctx.db
    .query('memberships')
    .withIndex('by_org_workspace', (q) =>
      q.eq('orgId', workspaceId).eq('workspaceId', subject),
    )
    .unique()
  if (!m) return null
  if (m.status !== undefined && m.status !== 'active') return null
  return m.role
}

/** Throw unless the caller's role on `workspaceId` is `>= atLeast`.
 *  `readRole` itself does the membership + active-status lookup; no
 *  redundant `requireWorkspace` call. Rejects an unauthenticated
 *  caller (readRole returns null when identity is missing). */
export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
  atLeast: Role,
): Promise<Role> {
  const role = await readRole(ctx, workspaceId)
  if (role === null) {
    // Differentiate unauthenticated vs not-a-member for a clearer error.
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    throw new Error(`Not a member of workspace ${workspaceId}`)
  }
  if (atLeast === 'owner' && role !== 'owner') {
    throw new Error(`Requires Owner in workspace ${workspaceId}`)
  }
  return role
}

/** Count active Owners in an org workspace — used by `removeMember` /
 *  `changeRole` / `leaveOrg` to refuse the last-Owner-removal. */
export async function countActiveOwners(
  ctx: QueryCtx | MutationCtx,
  orgId: string,
): Promise<number> {
  const rows = await ctx.db
    .query('memberships')
    .withIndex('by_org', (q) => q.eq('orgId', orgId))
    .collect()
  return rows.filter(
    (r) =>
      r.role === 'owner' && (r.status === undefined || r.status === 'active'),
  ).length
}
