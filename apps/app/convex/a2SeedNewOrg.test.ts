/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const A = 'ws_a2_alice'

describe('_seedNewOrg (H-2 / A2)', () => {
  it('seeds onboarding row + .context/company.md + dashboard.md with the org name', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })

    // Create the org first (the bridge action wraps this in production
    // and calls _seedNewOrg after; here we call _seedNewOrg directly to
    // unit-test the seed mutation in isolation).
    const { orgId } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme Inc',
    })
    await t.mutation(internal.orgs._seedNewOrg, { orgId })

    // Onboarding row exists for the new org.
    const onboardingRow = await t.run(async (ctx) =>
      ctx.db
        .query('onboarding')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', orgId))
        .first(),
    )
    expect(onboardingRow).not.toBeNull()
    expect(onboardingRow?.completedAt).toBeUndefined()
    expect(onboardingRow?.deferredAt).toBeUndefined()

    // .context/company.md exists in the org workspace with the org
    // name in frontmatter + body. It is agent-owned but not
    // system-locked, so the user can delete it like any other file.
    const companyMd = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', '.context/company.md'),
        )
        .unique(),
    )
    expect(companyMd).not.toBeNull()
    expect(companyMd?.body).toContain('title: Acme Inc')
    expect(companyMd?.body).toContain('What Acme Inc does')
    expect(companyMd?.systemLocked).toBeFalsy()
    expect(companyMd?.source).toBe('agent')

    // dashboard.md exists with a query block (the live primitive the
    // SYSTEM_PROMPT requires before finish_onboarding).
    const dashboardMd = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'dashboard.md'),
        )
        .unique(),
    )
    expect(dashboardMd).not.toBeNull()
    expect(dashboardMd?.body).toContain('```query')
    expect(dashboardMd?.body).toContain('Acme Inc')
  })

  it('is idempotent: re-seeding does not duplicate the onboarding row', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const { orgId } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme',
    })
    await t.mutation(internal.orgs._seedNewOrg, { orgId })
    await t.mutation(internal.orgs._seedNewOrg, { orgId })

    // Only one onboarding row even after two seeds.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('onboarding')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', orgId))
        .collect(),
    )
    expect(rows.length).toBe(1)
  })

  it('progressOf finds the seeded .context/company.md as the identity atom (H-1 + H-2 integration)', async () => {
    // H-1 (A1) made progressOf branch on workspace kind (looks for
    // .context/company.md in orgs vs .context/me.md in personal).
    // H-2 (A2) seeds .context/company.md. End-to-end: a freshly-created + seeded org reports
    // hasMe:true via the org branch.
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const { orgId } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme',
    })
    await t.mutation(internal.orgs._seedNewOrg, { orgId })
    const progress = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, orgId)
    })
    expect(progress.hasMe).toBe(true)
    expect(progress.mePath).toBe('.context/company.md')
    expect(progress.hasDashboardWithQuery).toBe(true)
    expect(progress.dashboardPath).toBe('dashboard.md')
  })
})
