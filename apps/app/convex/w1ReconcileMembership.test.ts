/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const SUBJECT = 'ws_w1_subject'

describe('_reconcileMembershipRows (W1 / H-7)', () => {
  it('adds memberships for WorkOS-active orgs we know about (workosOrgId-linked)', async () => {
    const t = convexTest(schema, modules)
    // Insert a Convex org with a workosOrgId link (as if createOrgWithBridge ran).
    const orgId = await t.run(async (ctx) => {
      return await ctx.db.insert('orgs', {
        name: 'Acme',
        inviteCode: 'invite_w1',
        createdBy: 'creator',
        createdAt: Date.now(),
        status: 'active',
        workosOrgId: 'wos_acme_01',
      })
    })

    // Subject is NOT yet a member.
    const before = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_org_workspace', (q) =>
          q.eq('orgId', orgId as string).eq('workspaceId', SUBJECT),
        )
        .unique(),
    )
    expect(before).toBeNull()

    // Reconcile says subject is active in wos_acme_01 → membership inserted.
    const r = await t.mutation(internal.orgs._reconcileMembershipRows, {
      subject: SUBJECT,
      workosOrgIds: ['wos_acme_01'],
    })
    expect(r.added).toBe(1)
    expect(r.removed).toBe(0)

    const after = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_org_workspace', (q) =>
          q.eq('orgId', orgId as string).eq('workspaceId', SUBJECT),
        )
        .unique(),
    )
    expect(after?.status).toBe('active')
    expect(after?.role).toBe('member')
  })

  it('soft-removes memberships in linked-orgs the subject is no longer in (WorkOS)', async () => {
    const t = convexTest(schema, modules)
    // Insert linked org + active membership.
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('orgs', {
        name: 'Acme',
        inviteCode: 'invite',
        createdBy: 'c',
        createdAt: Date.now(),
        status: 'active',
        workosOrgId: 'wos_acme_01',
      })
      await ctx.db.insert('memberships', {
        orgId: id,
        workspaceId: SUBJECT,
        role: 'member',
        status: 'active',
      })
      return id
    })

    // Reconcile says subject is in NO orgs → soft-remove the existing membership.
    const r = await t.mutation(internal.orgs._reconcileMembershipRows, {
      subject: SUBJECT,
      workosOrgIds: [],
    })
    expect(r.removed).toBe(1)
    expect(r.added).toBe(0)

    const after = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_org_workspace', (q) =>
          q.eq('orgId', orgId as string).eq('workspaceId', SUBJECT),
        )
        .unique(),
    )
    expect(after?.status).toBe('removed')
  })

  it('LEAVES ALONE memberships in orgs without workosOrgId (manually-created orgs)', async () => {
    const t = convexTest(schema, modules)
    // Org with NO workosOrgId (created before bridge or without WorkOS).
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('orgs', {
        name: 'Manual',
        inviteCode: 'invite',
        createdBy: 'c',
        createdAt: Date.now(),
        status: 'active',
        // workosOrgId omitted intentionally
      })
      await ctx.db.insert('memberships', {
        orgId: id,
        workspaceId: SUBJECT,
        role: 'owner',
        status: 'active',
      })
      return id
    })

    // Reconcile with subject in NO WorkOS orgs → the manual-org membership
    // is NOT soft-removed (WorkOS isn't authoritative for unlinked orgs).
    const r = await t.mutation(internal.orgs._reconcileMembershipRows, {
      subject: SUBJECT,
      workosOrgIds: [],
    })
    expect(r.removed).toBe(0)

    const after = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_org_workspace', (q) =>
          q.eq('orgId', orgId as string).eq('workspaceId', SUBJECT),
        )
        .unique(),
    )
    expect(after?.status).toBe('active')
  })

  it('re-activates a previously-removed membership when WorkOS says the user is back', async () => {
    const t = convexTest(schema, modules)
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('orgs', {
        name: 'Acme',
        inviteCode: 'invite',
        createdBy: 'c',
        createdAt: Date.now(),
        status: 'active',
        workosOrgId: 'wos_acme_01',
      })
      // Pre-existing soft-removed membership (the user was removed; now
      // WorkOS says they're back in).
      await ctx.db.insert('memberships', {
        orgId: id,
        workspaceId: SUBJECT,
        role: 'owner', // preserved on re-activation (WorkOS-driven, not invite-code)
        status: 'removed',
      })
      return id
    })

    const r = await t.mutation(internal.orgs._reconcileMembershipRows, {
      subject: SUBJECT,
      workosOrgIds: ['wos_acme_01'],
    })
    expect(r.added).toBe(1)

    const after = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_org_workspace', (q) =>
          q.eq('orgId', orgId as string).eq('workspaceId', SUBJECT),
        )
        .unique(),
    )
    expect(after?.status).toBe('active')
    // Role preserved (NOT reset to 'member' like the invite-code rejoin).
    expect(after?.role).toBe('owner')
  })

  it('counts "kept" for memberships already-active in still-active orgs', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const id = await ctx.db.insert('orgs', {
        name: 'Acme',
        inviteCode: 'invite',
        createdBy: 'c',
        createdAt: Date.now(),
        status: 'active',
        workosOrgId: 'wos_acme_01',
      })
      await ctx.db.insert('memberships', {
        orgId: id,
        workspaceId: SUBJECT,
        role: 'member',
        status: 'active',
      })
      return id
    })
    const r = await t.mutation(internal.orgs._reconcileMembershipRows, {
      subject: SUBJECT,
      workosOrgIds: ['wos_acme_01'],
    })
    expect(r.kept).toBe(1)
    expect(r.added).toBe(0)
    expect(r.removed).toBe(0)
  })

  it('public reconcileMembership action is no-op when WORKOS_API_KEY is unset (graceful)', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: SUBJECT })
    const r = await asA.action(api.orgsBridge.reconcileMembership, {})
    expect(r).toEqual({
      synced: false,
      reason: 'no-api-key',
      added: 0,
      removed: 0,
      kept: 0,
    })
  })
})
