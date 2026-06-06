/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const ADMIN_URL = 'http://hocuspocus.local'
const ADMIN_TOKEN = 'admin-token'
const ALICE = 'ws_collection_mutations_alice'
const BOB = 'ws_collection_mutations_bob'

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Finance Team' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '',
  updatedAt = Date.now(),
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId, path, body, updatedAt })
  })
}

async function seedTracker(t: ReturnType<typeof convexTest>, workspaceId: string) {
  await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/tracker/app.json',
    JSON.stringify({
      title: 'Finance Tracker',
      read: ['transactions/**'],
      write: ['transactions/**'],
      collections: {
        transactions: {
          source: 'transactions/*.md',
          write: 'transactions/**',
          format: 'markdown-table',
          key: 'ID',
        },
      },
    }),
  )
  await seedAtom(
    t,
    workspaceId,
    'finance/transactions/2026-06.md',
    [
      '# June 2026 Transactions',
      '',
      '| ID | Merchant | Amount | Reviewed |',
      '|---|---|---:|---|',
      '| txn_001 | Grab | 420 | No |',
      '| txn_002 | Cafe | 250 | Yes |',
    ].join('\n'),
    123,
  )
}

function stubSemanticFetch() {
  vi.stubEnv('HOCUSPOCUS_ADMIN_URL', ADMIN_URL)
  vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', ADMIN_TOKEN)
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (String(url).endsWith('/createAnchorsForText')) {
      return new Response(JSON.stringify({
        ok: true,
        anchorStart: `start:${body.expectedText}`,
        anchorEnd: `end:${body.expectedText}`,
      }))
    }
    if (String(url).endsWith('/replaceRange')) {
      return new Response(JSON.stringify({
        ok: true,
        operationId: body.operationId,
        atomId: body.atomId,
      }))
    }
    return new Response(JSON.stringify({ ok: false, reason: 'unexpected-route' }), { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function trustTracker(t: ReturnType<typeof convexTest>, workspaceId: string, subject = ALICE) {
  await t.withIdentity({ subject }).mutation(api.appTrust.grant, {
    activeWorkspaceId: workspaceId,
    packageRoot: 'finance/.apps/tracker',
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('appData collection mutations', () => {
  it('plans markdown-table updates through Hocuspocus semantic replacement and records provenance', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedTracker(t, workspaceId)
    await trustTracker(t, workspaceId)
    const fetch = stubSemanticFetch()

    const result = await t.withIdentity({ subject: ALICE }).action(
      api.appData.runCollectionMutation,
      {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'update',
        id: 'txn_001',
        patch: { Reviewed: 'Yes', Amount: 430 },
        clientMutationId: 'mut-update-1',
        expectedSourceRevision: '123',
      },
    )

    expect(result).toMatchObject({
      ok: true,
      operation: 'collection.update',
      path: 'finance/transactions/2026-06.md',
      sourceRevision: '123',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    const [anchorUrl, anchorInit] = fetch.mock.calls[0]!
    const [replaceUrl, replaceInit] = fetch.mock.calls[1]!
    expect(String(anchorUrl)).toBe(`${ADMIN_URL}/apply/createAnchorsForText`)
    expect(JSON.parse(String(anchorInit?.body))).toMatchObject({
      expectedText: '| txn_001 | Grab | 420 | No |',
      actor: { userId: ALICE, actorKind: 'app' },
    })
    expect(String(replaceUrl)).toBe(`${ADMIN_URL}/apply/replaceRange`)
    expect(JSON.parse(String(replaceInit?.body))).toMatchObject({
      operationId: 'appCollection:finance/.apps/tracker:transactions:update:mut-update-1',
      expectedText: '| txn_001 | Grab | 420 | No |',
      replacement: '| txn_001 | Grab | 430 | Yes |',
    })

    const provenance = await t.run(async (ctx) =>
      ctx.db
        .query('appProvenance')
        .withIndex('by_workspace_app', (q) =>
          q.eq('workspaceId', workspaceId).eq('packageRoot', 'finance/.apps/tracker'),
        )
        .collect(),
    )
    expect(provenance).toEqual([
      expect.objectContaining({
        actorUserId: ALICE,
        operation: 'collection.update',
        targetId: 'txn_001',
        targetPath: 'finance/transactions/2026-06.md',
        sourceRevision: '123',
        clientMutationId: 'mut-update-1',
      }),
    ])
  })

  it('rejects duplicate inserts before calling the semantic backend', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedTracker(t, workspaceId)
    await trustTracker(t, workspaceId)
    const fetch = stubSemanticFetch()

    const result = await t.withIdentity({ subject: ALICE }).action(
      api.appData.runCollectionMutation,
      {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'insert',
        record: { ID: 'txn_001', Merchant: 'Grab', Amount: 420 },
        clientMutationId: 'dup-insert',
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'collection-duplicate-id' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects stale source revisions before calling the semantic backend', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedTracker(t, workspaceId)
    await trustTracker(t, workspaceId)
    const fetch = stubSemanticFetch()

    const result = await t.withIdentity({ subject: ALICE }).action(
      api.appData.runCollectionMutation,
      {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'delete',
        id: 'txn_002',
        clientMutationId: 'stale-delete',
        expectedSourceRevision: '122',
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'source-version-conflict' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects locked source writes before calling the semantic backend', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedTracker(t, workspaceId)
    await trustTracker(t, workspaceId)
    const source = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', workspaceId).eq('path', 'finance/transactions/2026-06.md'),
        )
        .unique(),
    )
    await t.run(async (ctx) => {
      await ctx.db.patch(source!._id, { userLocked: true })
    })
    const fetch = stubSemanticFetch()

    const result = await t.withIdentity({ subject: ALICE }).action(
      api.appData.runCollectionMutation,
      {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'update',
        id: 'txn_001',
        patch: { Reviewed: 'Yes' },
        clientMutationId: 'locked-update',
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'source-write-not-authorized' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps app trust per user for collection mutations', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedTracker(t, workspaceId)
    await trustTracker(t, workspaceId, ALICE)

    const result = await t.withIdentity({ subject: BOB }).action(
      api.appData.runCollectionMutation,
      {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'update',
        id: 'txn_001',
        patch: { Reviewed: 'Yes' },
        clientMutationId: 'bob-untrusted',
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'app-trust-required' })
  })
})
