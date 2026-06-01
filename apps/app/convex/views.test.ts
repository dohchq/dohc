/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_views'
const ALICE = 'ws_views_alice'
const BOB = 'ws_views_bob'

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

async function seedOrgWithBob(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'View Org' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, {
    inviteCode,
  })
  return orgId
}

describe('api.views.list', () => {
  it('discovers root and folder-local views with manifest defaults', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, '.views/home/src/App.tsx')
    await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx')
    await seedAtom(
      t,
      W,
      'clients/acme/.views/client-portal/view.json',
      JSON.stringify({ title: 'Client Portal' }),
    )
    await seedAtom(t, W, 'clients/acme/.views/client-portal/src/App.tsx')
    await seedAtom(t, W, 'clients/acme/tasks.md', '# Tasks')

    const result = await t.withIdentity({ subject: W }).query(api.views.list, {})

    expect(result.truncated).toBe(false)
    expect(result.views.map((view) => ({
      packageRoot: view.packageRoot,
      scopePath: view.scopePath,
      viewName: view.viewName,
      title: view.title,
      entryPath: view.entryPath,
      hasConfig: view.hasConfig,
      configStatus: view.configStatus,
    }))).toEqual([
      {
        packageRoot: '.views/home',
        scopePath: '',
        viewName: 'home',
        title: 'Home',
        entryPath: '.views/home/src/App.tsx',
        hasConfig: false,
        configStatus: { ok: true },
      },
      {
        packageRoot: 'clients/acme/.views/client-portal',
        scopePath: 'clients/acme',
        viewName: 'client-portal',
        title: 'Client Portal',
        entryPath: 'clients/acme/.views/client-portal/src/App.tsx',
        hasConfig: true,
        configStatus: { ok: true },
      },
      {
        packageRoot: 'clients/acme/.views/overview',
        scopePath: 'clients/acme',
        viewName: 'overview',
        title: 'Overview',
        entryPath: 'clients/acme/.views/overview/src/App.tsx',
        hasConfig: false,
        configStatus: { ok: true },
      },
    ])
  })

  it('lists malformed configs with defaults and a calm diagnostic', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'clients/acme/.views/broken/view.json', '{')
    await seedAtom(t, W, 'clients/acme/.views/broken/src/App.tsx')

    const result = await t.withIdentity({ subject: W }).query(api.views.list, {})
    expect(result.views[0]).toMatchObject({
      packageRoot: 'clients/acme/.views/broken',
      title: 'Broken',
      entryPath: 'clients/acme/.views/broken/src/App.tsx',
      hasConfig: true,
      configStatus: {
        ok: false,
        reason: 'invalid-json',
      },
    })
  })

  it('filters discovery through atom read access', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithBob(t)
    await seedAtom(t, orgId, 'clients/acme/.views/public/src/App.tsx')
    await seedAtom(t, orgId, 'clients/acme/.views/private/src/App.tsx')

    const privateEntry = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'clients/acme/.views/private/src/App.tsx'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      activeWorkspaceId: orgId,
      atomId: privateEntry!._id,
      mode: 'private',
    })

    const bobViews = await t
      .withIdentity({ subject: BOB })
      .query(api.views.list, { activeWorkspaceId: orgId })

    expect(bobViews.views.map((view) => view.packageRoot)).toEqual([
      'clients/acme/.views/public',
    ])
  })
})

describe('api.views.get', () => {
  it('returns one resolved descriptor or null for malformed/missing roots', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx')

    await expect(
      t.withIdentity({ subject: W }).query(api.views.get, {
        packageRoot: 'clients/acme/views/overview',
      }),
    ).resolves.toBeNull()

    await expect(
      t.withIdentity({ subject: W }).query(api.views.get, {
        packageRoot: 'clients/acme/.views/missing',
      }),
    ).resolves.toBeNull()

    const view = await t.withIdentity({ subject: W }).query(api.views.get, {
      packageRoot: 'clients/acme/.views/overview',
    })
    expect(view).toMatchObject({
      packageRoot: 'clients/acme/.views/overview',
      scopePath: 'clients/acme',
      title: 'Overview',
      entryPath: 'clients/acme/.views/overview/src/App.tsx',
    })
  })
})

describe('api.views.getSourceFiles', () => {
  it('returns readable package source files with package-relative paths', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx', 'import "./styles.css"')
    await seedAtom(t, W, 'clients/acme/.views/overview/src/styles.css', 'main { color: red }')
    await seedAtom(t, W, 'clients/acme/tasks.md', '{status: active}')

    const result = await t.withIdentity({ subject: W }).query(api.views.getSourceFiles, {
      packageRoot: 'clients/acme/.views/overview',
    })

    expect(result).toEqual({
      ok: true,
      entry: 'src/App.tsx',
      truncated: false,
      files: [
        { relativePath: 'src/App.tsx', body: 'import "./styles.css"' },
        { relativePath: 'src/styles.css', body: 'main { color: red }' },
      ],
    })
  })

  it('caps discovered views and source package size', async () => {
    const t = convexTest(schema, modules)
    for (let i = 0; i < 501; i++) {
      await seedAtom(t, W, `.views/view-${String(i).padStart(3, '0')}/src/App.tsx`)
    }

    const listed = await t.withIdentity({ subject: W }).query(api.views.list, {})
    expect(listed.views).toHaveLength(500)
    expect(listed.truncated).toBe(true)

    const files = Array.from({ length: 101 }, (_, i) => `src/${i}.ts`)
    for (const file of files) {
      await seedAtom(t, 'ws_big_view', `.views/big/${file}`, 'export const x = 1')
    }
    await seedAtom(t, 'ws_big_view', '.views/big/src/App.tsx', 'console.log(1)')

    const source = await t.withIdentity({ subject: 'ws_big_view' }).query(
      api.views.getSourceFiles,
      { packageRoot: '.views/big' },
    )
    expect(source).toMatchObject({
      ok: false,
      code: 'too-many-files',
    })
  })
})
