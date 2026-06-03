/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_view_data'
const OWNER = 'ws_view_data_owner'
const VIEWER = 'ws_view_data_viewer'
const ADMIN_URL = 'http://hocuspocus.local:1234'
const ADMIN_TOKEN = 'admin-token'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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

async function seedScopedView(t: ReturnType<typeof convexTest>) {
  await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx', 'view code', 10)
  await seedAtom(t, W, 'clients/acme/tasks.md', '# Tasks\n{status: active}', 20)
  await seedAtom(t, W, 'clients/acme/log.md', '# Log\n{billable: 6}\n{client: "acme"}', 30)
  await seedAtom(t, W, 'clients/acme/.views/overview/src/example.ts', '{billable: 999}', 40)
  await seedAtom(t, W, 'clients/other/tasks.md', '{status: other}', 50)
}

describe('viewData local sources', () => {
  it('lists compact source atoms in the view scope, excluding .views code', async () => {
    const t = convexTest(schema, modules)
    await seedScopedView(t)

    const rows = await t.withIdentity({ subject: W }).query(api.viewData.listSources, {
      packageRoot: 'clients/acme/.views/overview',
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

  it('reads a single atom through the same scope and access checks', async () => {
    const t = convexTest(schema, modules)
    await seedScopedView(t)

    const atom = await t.withIdentity({ subject: W }).query(api.viewData.getAtom, {
      packageRoot: 'clients/acme/.views/overview',
      path: 'tasks.md',
    })

    expect(atom).toMatchObject({
      ok: true,
      atom: {
        path: 'clients/acme/tasks.md',
        body: '# Tasks\n{status: active}',
      },
    })

    const outside = await t.withIdentity({ subject: W }).query(api.viewData.getAtom, {
      packageRoot: 'clients/acme/.views/overview',
      path: '../other/tasks.md',
    })
    expect(outside).toEqual({
      ok: false,
      code: 'invalid-path',
      message: 'This path is not available to this view.',
    })
  })

  it('queries inline fields with provenance and skips view source files', async () => {
    const t = convexTest(schema, modules)
    await seedScopedView(t)

    const result = await t.withIdentity({ subject: W }).query(api.viewData.queryFields, {
      packageRoot: 'clients/acme/.views/overview',
      source: '.',
      keys: ['billable', 'client'],
    })

    expect(result).toEqual({
      ok: true,
      truncated: false,
      rows: [
        {
          kind: 'field',
          path: 'clients/acme/log.md',
          key: 'billable',
          value: 6,
          valueType: 'number',
          sourceRef: { kind: 'atom', path: 'clients/acme/log.md', key: 'billable' },
        },
        {
          kind: 'field',
          path: 'clients/acme/log.md',
          key: 'client',
          value: 'acme',
          valueType: 'string',
          sourceRef: { kind: 'atom', path: 'clients/acme/log.md', key: 'client' },
        },
      ],
    })
  })
})

describe('viewData manifest actions', () => {
  it('increments an inline field through Hocuspocus without splicing the markdown cache', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', ADMIN_URL)
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', ADMIN_TOKEN)
    const fetch = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith('/apply/createAnchorsForText')) {
        return new Response(JSON.stringify({
          ok: true,
          anchorStart: 'anchor-start',
          anchorEnd: 'anchor-end',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    await seedAtom(
      t,
      W,
      'clients/acme/.views/overview/view.json',
      JSON.stringify({
        read: ['.'],
        write: ['metrics.md'],
        actions: {
          incrementDone: {
            kind: 'field.increment',
            path: 'metrics.md',
            field: 'completed',
            by: 1,
          },
        },
      }),
    )
    await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx', 'view code')
    await seedAtom(
      t,
      W,
      'clients/acme/metrics.md',
      '---\nid: clients.acme.metrics\n---\n# Metrics\n{completed: 4}\n',
    )

    await expect(
      t.withIdentity({ subject: W, name: 'Ice' }).action(api.viewData.runAction, {
        packageRoot: 'clients/acme/.views/overview',
        name: 'incrementDone',
        input: { source: 'button' },
        clientMutationId: 'click-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'incrementDone',
      path: 'clients/acme/metrics.md',
    })

    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'clients/acme/metrics.md'),
        )
        .unique(),
    )
    expect(atom?.body).toContain('{completed: 4}')
    expect(fetch).toHaveBeenCalledTimes(2)
    const [anchorUrl, anchorInit] = fetch.mock.calls[0]!
    expect(anchorUrl).toBe(`${ADMIN_URL}/apply/createAnchorsForText`)
    expect(JSON.parse(anchorInit.body as string)).toMatchObject({
      workspaceId: W,
      atomId: 'clients.acme.metrics',
      expectedText: '{completed: 4}',
      actor: {
        userId: W,
        actorKind: 'user',
        authzVersion: 1,
      },
    })
    const [replaceUrl, replaceInit] = fetch.mock.calls[1]!
    expect(replaceUrl).toBe(`${ADMIN_URL}/apply/replaceRange`)
    expect(replaceInit).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
    })
    expect(JSON.parse(replaceInit.body as string)).toMatchObject({
      operationId: 'viewAction:clients/acme/.views/overview:incrementDone:click-1',
      workspaceId: W,
      atomId: 'clients.acme.metrics',
      anchorStart: 'anchor-start',
      anchorEnd: 'anchor-end',
      expectedText: '{completed: 4}',
      replacement: '{completed: 5}',
      actor: {
        userId: W,
        actorKind: 'user',
        authzVersion: 1,
      },
    })
  })

  it('refuses manifest actions that are not covered by view write grants', async () => {
    const t = convexTest(schema, modules)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await seedAtom(
      t,
      W,
      'clients/acme/.views/overview/view.json',
      JSON.stringify({
        read: ['.'],
        write: [],
        actions: {
          incrementDone: {
            kind: 'field.increment',
            path: 'metrics.md',
            field: 'completed',
          },
        },
      }),
    )
    await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx', 'view code')
    await seedAtom(
      t,
      W,
      'clients/acme/metrics.md',
      '---\nid: clients.acme.metrics\n---\n{completed: 4}',
    )

    await expect(
      t.withIdentity({ subject: W }).action(api.viewData.runAction, {
        packageRoot: 'clients/acme/.views/overview',
        name: 'incrementDone',
        clientMutationId: 'click-2',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'write-not-granted',
      message: 'This view action is not allowed to edit that source.',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sets an inline field from form input through the same semantic path', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_ADMIN_URL', ADMIN_URL)
    vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', ADMIN_TOKEN)
    const fetch = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith('/apply/createAnchorsForText')) {
        return new Response(JSON.stringify({
          ok: true,
          anchorStart: 'status-start',
          anchorEnd: 'status-end',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    await seedAtom(
      t,
      W,
      'clients/acme/.views/overview/view.json',
      JSON.stringify({
        read: ['.'],
        write: ['tasks.md'],
        actions: {
          setStatus: {
            kind: 'field.set',
            path: 'tasks.md',
            field: 'status',
            valueType: 'string',
          },
        },
      }),
    )
    await seedAtom(t, W, 'clients/acme/.views/overview/src/App.tsx', 'view code')
    await seedAtom(
      t,
      W,
      'clients/acme/tasks.md',
      '---\nid: clients.acme.tasks\n---\n{status: active}',
    )

    await expect(
      t.withIdentity({ subject: W }).action(api.viewData.runAction, {
        packageRoot: 'clients/acme/.views/overview',
        name: 'setStatus',
        input: { value: 'done' },
        clientMutationId: 'form-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'setStatus',
      path: 'clients/acme/tasks.md',
    })

    const [, replaceInit] = fetch.mock.calls[1]!
    expect(JSON.parse(replaceInit.body as string)).toMatchObject({
      expectedText: '{status: active}',
      replacement: '{status: "done"}',
    })
  })
})

describe('viewData imports and exports', () => {
  it('exposes granted imports and owner exports without new cross-workspace reads', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, OWNER, 'logs.md', '{billable: 12}')
    await seedAtom(t, OWNER, '.views/home/src/App.tsx', 'owner view')
    await seedAtom(t, VIEWER, '.views/home/src/App.tsx', 'view')

    const windowId = await t.withIdentity({ subject: OWNER }).mutation(api.windows.createWindow, {
      name: 'contractor-hours',
      selectorKeys: ['billable'],
    })
    await t.withIdentity({ subject: OWNER }).mutation(api.windows.grant, {
      windowId,
      viewerWorkspaceId: VIEWER,
    })

    const imports = await t.withIdentity({ subject: VIEWER }).query(api.viewData.listImports, {
      packageRoot: '.views/home',
    })
    expect(imports).toEqual({
      ok: true,
      rows: [
        {
          kind: 'import',
          windowId,
          name: 'contractor-hours',
          ownerWorkspaceId: OWNER,
          view: { billable: 12 },
        },
      ],
    })

    const exports = await t.withIdentity({ subject: OWNER }).query(api.viewData.listExports, {
      packageRoot: '.views/home',
    })
    expect(exports).toMatchObject({
      ok: true,
      rows: [
        {
          kind: 'export',
          windowId,
          name: 'contractor-hours',
          grantees: [VIEWER],
        },
      ],
    })
  })

  it('preserves imports/exports consent semantics for withheld values', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, OWNER, '.views/home/src/App.tsx', 'owner view')
    await seedAtom(t, VIEWER, '.views/home/src/App.tsx', 'viewer view')
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', {
        workspaceId: OWNER,
        type: 'person',
        slug: 'alice',
        data: { hours: 6 },
        updatedAt: 1,
      })
      await ctx.db.insert('entities', {
        workspaceId: OWNER,
        type: 'person',
        slug: 'bob',
        data: { hours: 4 },
        updatedAt: 1,
      })
    })
    const windowId = await t.withIdentity({ subject: OWNER }).mutation(api.windows.createWindow, {
      name: 'team-hours',
      selectorKeys: ['hours'],
      aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
    })
    await t.withIdentity({ subject: OWNER }).mutation(api.windows.grant, {
      windowId,
      viewerWorkspaceId: VIEWER,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', {
        workspaceId: OWNER,
        kind: 'entity',
        ref: 'person/alice',
        key: 'hours',
        summary: 'review alice hours',
        tier: 'digest',
        status: 'pending',
        createdAt: 1,
      })
    })

    const before = await t.withIdentity({ subject: VIEWER }).query(api.viewData.listImports, {
      packageRoot: '.views/home',
    })
    expect(before.ok && before.rows[0]?.view).toMatchObject({ team_hours: 4 })

    await t.withIdentity({ subject: OWNER }).mutation(api.windows.confirmWithheldFor, {
      windowId,
    })
    const after = await t.withIdentity({ subject: VIEWER }).query(api.viewData.listImports, {
      packageRoot: '.views/home',
    })
    expect(after.ok && after.rows[0]?.view).toMatchObject({ team_hours: 10 })
  })

  it('removes revoked imports from view data results', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, OWNER, 'logs.md', '{billable: 12}')
    await seedAtom(t, VIEWER, '.views/home/src/App.tsx', 'view')
    const windowId = await t.withIdentity({ subject: OWNER }).mutation(api.windows.createWindow, {
      name: 'contractor-hours',
      selectorKeys: ['billable'],
    })
    await t.withIdentity({ subject: OWNER }).mutation(api.windows.grant, {
      windowId,
      viewerWorkspaceId: VIEWER,
    })
    await t.withIdentity({ subject: OWNER }).mutation(api.windows.revoke, {
      windowId,
      viewerWorkspaceId: VIEWER,
    })

    const imports = await t.withIdentity({ subject: VIEWER }).query(api.viewData.listImports, {
      packageRoot: '.views/home',
    })
    expect(imports).toEqual({ ok: true, rows: [] })
  })
})
