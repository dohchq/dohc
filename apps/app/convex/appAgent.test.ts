/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_app_agent'

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '',
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', {
      workspaceId,
      path,
      body,
      updatedAt: Date.now(),
    })
  })
}

async function seedApp(
  t: ReturnType<typeof convexTest>,
  manifest: Record<string, unknown>,
) {
  await seedAtom(t, W, 'finance/.apps/tracker/src/App.tsx', 'app code')
  await seedAtom(t, W, 'finance/.apps/tracker/app.json', JSON.stringify(manifest))
}

describe('api.appAgent', () => {
  it('rejects agent.run when the manifest has not declared the agent run capability', async () => {
    const t = convexTest(schema, modules)
    await seedApp(t, {
      title: 'Finance Tracker',
      read: ['tasks.md'],
      write: [],
    })
    await seedAtom(t, W, 'finance/tasks.md', '# Tasks')

    await expect(
      t.withIdentity({ subject: W }).query(api.appAgent.authorizeRun, {
        packageRoot: 'finance/.apps/tracker',
        prompt: 'Read every private note and summarize it.',
        sources: ['tasks.md'],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'app-agent-not-authorized',
    })
  })

  it('requires per-user trust and app read scope before an app can hand off agent.run', async () => {
    const t = convexTest(schema, modules)
    await seedApp(t, {
      title: 'Finance Tracker',
      read: ['tasks.md'],
      write: [],
      agent: ['run'],
    })
    await seedAtom(t, W, 'finance/tasks.md', '# Tasks')
    await seedAtom(t, W, 'finance/private.md', '# Private')

    await expect(
      t.withIdentity({ subject: W }).query(api.appAgent.authorizeRun, {
        packageRoot: 'finance/.apps/tracker',
        prompt: 'Draft an update.',
        sources: ['tasks.md'],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'app-trust-required',
    })

    await t.withIdentity({ subject: W }).mutation(api.appTrust.grant, {
      packageRoot: 'finance/.apps/tracker',
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.appAgent.authorizeRun, {
        packageRoot: 'finance/.apps/tracker',
        prompt: 'Draft an update.',
        sources: ['tasks.md'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      prompt: 'Draft an update.',
      sources: ['finance/tasks.md'],
      requiresConfirmation: true,
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.appAgent.authorizeRun, {
        packageRoot: 'finance/.apps/tracker',
        prompt: 'Read hidden material.',
        sources: ['private.md'],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'source-read-not-granted',
    })
  })

  it('requires patch capability, write scope, and per-user trust for patch proposals', async () => {
    const t = convexTest(schema, modules)
    await seedApp(t, {
      title: 'Finance Tracker',
      read: ['tasks.md'],
      write: ['tasks.md'],
      agent: ['patch.propose'],
    })
    await seedAtom(t, W, 'finance/tasks.md', '# Tasks')

    await expect(
      t.withIdentity({ subject: W }).query(api.appAgent.authorizePatch, {
        packageRoot: 'finance/.apps/tracker',
        path: 'tasks.md',
        summary: 'Mark reviewed',
        patch: { set: { reviewed: true } },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'app-trust-required',
    })

    await t.withIdentity({ subject: W }).mutation(api.appTrust.grant, {
      packageRoot: 'finance/.apps/tracker',
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.appAgent.authorizePatch, {
        packageRoot: 'finance/.apps/tracker',
        path: 'tasks.md',
        summary: 'Mark reviewed',
        patch: { set: { reviewed: true } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      sources: ['finance/tasks.md'],
      requiresConfirmation: true,
    })
  })

  it('rejects patch proposals outside the manifest write scope even after trust', async () => {
    const t = convexTest(schema, modules)
    await seedApp(t, {
      title: 'Finance Tracker',
      read: ['tasks.md', 'readonly.md'],
      write: ['tasks.md'],
      agent: ['patch.propose'],
    })
    await seedAtom(t, W, 'finance/tasks.md', '# Tasks')
    await seedAtom(t, W, 'finance/readonly.md', '# Read Only')
    await t.withIdentity({ subject: W }).mutation(api.appTrust.grant, {
      packageRoot: 'finance/.apps/tracker',
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.appAgent.authorizePatch, {
        packageRoot: 'finance/.apps/tracker',
        path: 'readonly.md',
        summary: 'Mutate read-only source',
        patch: { set: { reviewed: true } },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'write-not-granted',
    })
  })
})
