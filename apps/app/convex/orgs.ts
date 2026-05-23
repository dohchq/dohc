// sharing-v1 1c — app-level "company"/org. A workspace creates an
// org (becomes owner) + invites teammates with the org's invite
// code; members are `memberships` rows. Org membership is the gate
// for org-shared atoms (the company graph) — resolveShareAccess
// checks it. NO public function takes a workspaceId arg (the caller
// is always requireWorkspace); orgId/inviteCode are not workspace ids.
import { v } from 'convex/values'
import { query, mutation } from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { requireWorkspace } from './auth'
import { countActiveOwners, requireRole } from './orgRoles'

// Membership rows with `status === undefined` predate the status field
// (org-plan §4); treat them as 'active' for back-compat.
const isActive = (m: { status?: string } | null | undefined): boolean =>
  !!m && (m.status === undefined || m.status === 'active')

// The orgIds the given workspace belongs to (active memberships only).
export async function viewerOrgIds(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query('memberships')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .collect()
  return new Set(rows.filter(isActive).map((r) => r.orgId))
}

export async function isMember(
  ctx: QueryCtx | MutationCtx,
  orgId: string,
  workspaceId: string,
): Promise<boolean> {
  const row = await ctx.db
    .query('memberships')
    .withIndex('by_org_workspace', (q) =>
      q.eq('orgId', orgId).eq('workspaceId', workspaceId),
    )
    .unique()
  return isActive(row)
}

export const createOrg = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const owner = await requireWorkspace(ctx)
    const clean = name.trim() || 'My company'
    // Guarantee a UNIQUE invite code (review P2-1): a 40-bit collision
    // is astronomically unlikely, but `joinOrg` does `.first()` on
    // by_inviteCode, so two orgs sharing a code would land a joiner in
    // the wrong org. Regenerate until the indexed lookup is empty.
    let inviteCode = ''
    for (let i = 0; i < 8; i++) {
      inviteCode = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      const clash = await ctx.db
        .query('orgs')
        .withIndex('by_inviteCode', (q) => q.eq('inviteCode', inviteCode))
        .first()
      if (!clash) break
    }
    const now = Date.now()
    const orgId = await ctx.db.insert('orgs', {
      name: clean,
      inviteCode,
      createdBy: owner,
      createdAt: now,
      status: 'active',
    })
    await ctx.db.insert('memberships', {
      orgId,
      workspaceId: owner,
      role: 'owner',
      status: 'active',
      invitedBy: owner,
      invitedAt: now,
      acceptedAt: now,
    })
    return { orgId, name: clean, inviteCode }
  },
})

export const joinOrg = mutation({
  args: { inviteCode: v.string() },
  handler: async (ctx, { inviteCode }) => {
    const caller = await requireWorkspace(ctx)
    const code = inviteCode.trim()
    const org = await ctx.db
      .query('orgs')
      .withIndex('by_inviteCode', (q) => q.eq('inviteCode', code))
      .first()
    if (!org) throw new Error('No company found for that invite code.')
    const existing = await ctx.db
      .query('memberships')
      .withIndex('by_org_workspace', (q) =>
        q.eq('orgId', org._id).eq('workspaceId', caller),
      )
      .unique()
    const now = Date.now()
    if (!existing) {
      await ctx.db.insert('memberships', {
        orgId: org._id,
        workspaceId: caller,
        role: 'member',
        status: 'active',
        invitedBy: org.createdBy,
        invitedAt: now,
        acceptedAt: now,
      })
    } else if (existing.status === 'invited' || existing.status === 'removed') {
      // re-activate a previously-invited or previously-removed row
      await ctx.db.patch(existing._id, { status: 'active', acceptedAt: now })
    }
    return { orgId: org._id, name: org.name }
  },
})

export const leaveOrg = mutation({
  args: { orgId: v.id('orgs') },
  handler: async (ctx, { orgId }) => {
    const caller = await requireWorkspace(ctx)
    const row = await ctx.db
      .query('memberships')
      .withIndex('by_org_workspace', (q) =>
        q.eq('orgId', orgId).eq('workspaceId', caller),
      )
      .unique()
    if (!row) return { ok: true as const }
    // Refuse last-Owner leave (decisions.md §2) — the org must always
    // have at least one active Owner.
    if (
      row.role === 'owner' &&
      isActive(row) &&
      (await countActiveOwners(ctx, orgId)) <= 1
    ) {
      throw new Error('Cannot leave: you are the last Owner of this org.')
    }
    // Soft-remove (status:'removed') instead of hard delete so re-joining
    // via the same invite code reactivates this row (joinOrg flips status
    // back to 'active' — see :112) rather than orphaning a duplicate.
    // Phase D Members admin will also read this row to show "Removed by
    // X on date" attribution; Phase B/D atom attribution
    // (lastEditedByUserId) will rely on the row surviving offboarding.
    await ctx.db.patch(row._id, { status: 'removed' })
    return { ok: true as const }
  },
})

// Owner-only: remove another member. Refuses last-Owner removal.
export const removeMember = mutation({
  args: {
    orgId: v.id('orgs'),
    memberWorkspaceId: v.string(),
  },
  handler: async (ctx, { orgId, memberWorkspaceId }) => {
    await requireRole(ctx, orgId, 'owner')
    const row = await ctx.db
      .query('memberships')
      .withIndex('by_org_workspace', (q) =>
        q.eq('orgId', orgId).eq('workspaceId', memberWorkspaceId),
      )
      .unique()
    if (!row) throw new Error('Member not found.')
    if (
      row.role === 'owner' &&
      isActive(row) &&
      (await countActiveOwners(ctx, orgId)) <= 1
    ) {
      throw new Error('Cannot remove the last Owner of this org.')
    }
    await ctx.db.patch(row._id, { status: 'removed' })
    return { ok: true as const }
  },
})

// Owner-only: rename the org (decisions.md §3). Trims + falls back to
// the prior name if the new one is whitespace-only (renaming an org
// to "" would brick the switcher). Idempotent.
export const renameOrg = mutation({
  args: { orgId: v.id('orgs'), name: v.string() },
  handler: async (ctx, { orgId, name }) => {
    await requireRole(ctx, orgId, 'owner')
    const org = await ctx.db.get(orgId)
    if (!org) throw new Error('Org not found.')
    const clean = name.trim()
    if (clean.length === 0) throw new Error('Org name cannot be empty.')
    if (clean.length > 80) throw new Error('Org name too long (max 80 chars).')
    if (clean === org.name) return { ok: true as const, changed: false }
    await ctx.db.patch(orgId, { name: clean })
    return { ok: true as const, changed: true }
  },
})

// Owner-only: change a member's role. Refuses demoting the last Owner.
export const changeRole = mutation({
  args: {
    orgId: v.id('orgs'),
    memberWorkspaceId: v.string(),
    role: v.union(v.literal('owner'), v.literal('member')),
  },
  handler: async (ctx, { orgId, memberWorkspaceId, role }) => {
    await requireRole(ctx, orgId, 'owner')
    const row = await ctx.db
      .query('memberships')
      .withIndex('by_org_workspace', (q) =>
        q.eq('orgId', orgId).eq('workspaceId', memberWorkspaceId),
      )
      .unique()
    if (!row || !isActive(row)) throw new Error('Active member not found.')
    if (row.role === role) return { ok: true as const } // idempotent no-op
    if (
      row.role === 'owner' &&
      role === 'member' &&
      (await countActiveOwners(ctx, orgId)) <= 1
    ) {
      throw new Error('Cannot demote the last Owner of this org.')
    }
    await ctx.db.patch(row._id, { role })
    return { ok: true as const }
  },
})

// The caller's companies (+ the invite code, owners only).
export const myOrgs = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', caller))
      .collect()
    const out: Array<{
      orgId: string
      name: string
      role: string
      inviteCode: string | null
    }> = []
    for (const r of rows) {
      if (!isActive(r)) continue
      const org = await ctx.db.get(r.orgId as Id<'orgs'>)
      if (!org) continue
      out.push({
        orgId: r.orgId,
        name: org.name,
        role: r.role,
        // only an owner sees the invite code (to invite others)
        inviteCode: r.role === 'owner' ? org.inviteCode : null,
      })
    }
    return out
  },
})

/** Workspaces the caller can switch to: their personal workspace plus
 *  every org they're an active member of. Drives the UI switcher
 *  (org-plan §9). The personal entry always appears first. */
export const myWorkspaces = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', caller))
      .collect()
    const out: Array<{
      workspaceId: string
      kind: 'personal' | 'org'
      name: string
      role: 'owner' | 'member'
      accent: string | null
    }> = [
      // Personal first — always available; implicit Owner.
      {
        workspaceId: caller,
        kind: 'personal',
        name: 'Personal',
        role: 'owner',
        accent: null,
      },
    ]
    for (const r of rows) {
      if (!isActive(r)) continue
      const org = await ctx.db.get(r.orgId as Id<'orgs'>)
      if (!org) continue
      out.push({
        workspaceId: r.orgId, // org's workspaceId IS orgs._id (string)
        kind: 'org',
        name: org.name,
        role: r.role,
        accent: org.accent ?? null,
      })
    }
    return out
  },
})

// Members of an org — only visible to a member of that org.
export const orgMembers = query({
  args: { orgId: v.id('orgs') },
  handler: async (ctx, { orgId }) => {
    const caller = await requireWorkspace(ctx)
    if (!(await isMember(ctx, orgId, caller))) return null
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
    return rows
      .filter(isActive)
      .map((r) => ({ workspaceId: r.workspaceId, role: r.role }))
  },
})
