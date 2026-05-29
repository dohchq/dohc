/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const A = 'ws_a2_alice'

describe('_seedNewOrg (H-2 / A2)', () => {
  it('seeds .context/company.md + dashboard.md with the org name without completing the setup wedge', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })

    // Create the org first (the bridge action wraps this in production
    // and calls _seedNewOrg after; here we call _seedNewOrg directly to
    // unit-test the seed mutation in isolation).
    const { orgId } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme Inc',
    })
    await t.mutation(internal.orgs._seedNewOrg, { orgId })

    // The org should still enter the setup-first onboarding wedge.
    // Seed files are placeholders, not proof that the team has told
    // dohc what shared system to build.
    expect(await t.query(internal.onboarding._state, { workspaceId: orgId }))
      .toBe('NEW')

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

  it('is idempotent: re-seeding does not create an onboarding row', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const { orgId } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme',
    })
    await t.mutation(internal.orgs._seedNewOrg, { orgId })
    await t.mutation(internal.orgs._seedNewOrg, { orgId })

    // The agent begins onboarding when the user enters the wedge.
    // Re-seeding placeholders must not silently flip NEW to IN_PROGRESS.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('onboarding')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', orgId))
        .collect(),
    )
    expect(rows.length).toBe(0)
  })

  it('progressOf ignores placeholder seed files until the team setup is real', async () => {
    // H-2 seeds starter files so the workspace is not visually empty,
    // but they must not satisfy the never-end-empty floor. The team
    // still needs the setup-first wedge to shape a real shared system.
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
    expect(progress.hasMe).toBe(false)
    expect(progress.mePath).toBeNull()
    expect(progress.hasDashboardWithQuery).toBe(false)
    expect(progress.dashboardPath).toBeNull()
  })
})
