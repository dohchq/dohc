/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_app_data'

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '',
  updatedAt = Date.now(),
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', {
      workspaceId,
      path,
      body,
      updatedAt,
    })
  })
}

async function seedScopedApp(t: ReturnType<typeof convexTest>) {
  await seedAtom(t, W, 'clients/acme/.apps/overview/src/App.tsx', 'app code', 10)
  await seedAtom(
    t,
    W,
    'clients/acme/.apps/overview/app.json',
    JSON.stringify({ read: ['.'], write: [] }),
    11,
  )
  await seedAtom(t, W, 'clients/acme/tasks.md', '# Tasks\n{status: active}', 20)
  await seedAtom(t, W, 'clients/acme/log.md', '# Log\n{billable: 6}', 30)
  await seedAtom(t, W, 'clients/acme/.apps/overview/src/example.ts', '{billable: 999}', 40)
  await seedAtom(t, W, 'clients/other/tasks.md', '{status: other}', 50)
}

describe('appData local sources', () => {
  it('lists compact source atoms in the app scope, excluding .apps code', async () => {
    const t = convexTest(schema, modules)
    await seedScopedApp(t)

    const rows = await t.withIdentity({ subject: W }).query(api.appData.listSources, {
      packageRoot: 'clients/acme/.apps/overview',
      source: '.',
    })

    expect(rows).toEqual({
      ok: true,
      truncated: false,
      rows: [
        expect.objectContaining({
          kind: 'atom',
          path: 'clients/acme/log.md',
          title: 'Log',
          updatedAt: 30,
          sourceRef: { kind: 'atom', path: 'clients/acme/log.md' },
        }),
        expect.objectContaining({
          kind: 'atom',
          path: 'clients/acme/tasks.md',
          title: 'Tasks',
          updatedAt: 20,
          sourceRef: { kind: 'atom', path: 'clients/acme/tasks.md' },
        }),
      ],
    })
  })

  it('rejects legacy .views package roots through appData', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx', 'view code')
    await seedAtom(t, W, 'clients/acme/tasks.md', '# Tasks')

    const rows = await t.withIdentity({ subject: W }).query(api.appData.listSources, {
      packageRoot: 'clients/acme/.views/overview',
      source: '.',
    })

    expect(rows).toEqual({
      ok: false,
      code: 'app-not-found',
      message: 'App not found.',
    })
  })
})
