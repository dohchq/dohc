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

// The orgIds the given workspace belongs to.
export async function viewerOrgIds(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query('memberships')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .collect()
  return new Set(rows.map((r) => r.orgId))
}

export async function isMember(
  ctx: QueryCtx | MutationCtx,
  orgId: string,
  workspaceId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query('memberships')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .collect()
  return rows.some((r) => r.orgId === orgId)
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
    const orgId = await ctx.db.insert('orgs', {
      name: clean,
      inviteCode,
      createdBy: owner,
      createdAt: Date.now(),
    })
    await ctx.db.insert('memberships', {
      orgId,
      workspaceId: owner,
      role: 'owner',
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
    const already = await isMember(ctx, org._id, caller)
    if (!already) {
      await ctx.db.insert('memberships', {
        orgId: org._id,
        workspaceId: caller,
        role: 'member',
      })
    }
    return { orgId: org._id, name: org.name }
  },
})

export const leaveOrg = mutation({
  args: { orgId: v.id('orgs') },
  handler: async (ctx, { orgId }) => {
    const caller = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', caller))
      .collect()
    for (const r of rows) {
      if (r.orgId === orgId) await ctx.db.delete(r._id)
    }
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
    return rows.map((r) => ({ workspaceId: r.workspaceId, role: r.role }))
  },
})
