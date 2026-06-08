/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_collection_index_alice'
const BOB = 'ws_collection_index_bob'
const SQLITE_URL = 'http://sqlite-worker.local'
const SQLITE_TOKEN = 'sqlite-token'

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
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId, path, body, updatedAt: Date.now() })
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
      collections: {
        transactions: {
          source: 'transactions/*.md',
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
      '| ID | Date | Merchant | Amount | Reviewed |',
      '|---|---|---|---:|---|',
      '| txn_001 | 2026-06-06 | Grab | 420 | No |',
      '| txn_002 | 2026-06-07 | Cafe | 250 | Yes |',
    ].join('\n'),
  )
}

function stubSqliteWorker() {
  vi.stubEnv('SQLITE_WORKER_URL', SQLITE_URL)
  vi.stubEnv('SQLITE_WORKER_TOKEN', SQLITE_TOKEN)
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe(`${SQLITE_URL}/indexes/rebuild`)
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${SQLITE_TOKEN}`,
      'content-type': 'application/json',
    })
    const body = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify({
      ok: true,
      index: {
        indexId: body.indexId,
        rowCount: body.rows.length,
        columns: ['id', 'Merchant', 'Amount', 'sourcePath'],
        rows: body.rows,
      },
    }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('collectionIndex', () => {
  it('rebuilds a SQLite worker index from authorized source-backed collection rows', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    const fetch = stubSqliteWorker()

    const result = await t.withIdentity({ subject: ALICE }).action(
      api.collectionIndex.rebuild,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      },
    )

    expect(result).toMatchObject({
      ok: true,
      index: { indexId: `${orgId}:finance/.apps/tracker:transactions`, rowCount: 2 },
    })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(body.rows).toEqual([
      expect.objectContaining({ id: 'txn_001', Merchant: 'Grab', sourcePath: 'finance/transactions/2026-06.md' }),
      expect.objectContaining({ id: 'txn_002', Merchant: 'Cafe', sourcePath: 'finance/transactions/2026-06.md' }),
    ])
    expect(JSON.stringify(body)).not.toContain('SQLite format 3')
  })

  it('does not call the worker when source ACLs hide collection rows', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    const source = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'finance/transactions/2026-06.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      activeWorkspaceId: orgId,
      atomId: source!._id,
      mode: 'private',
    })
    const fetch = stubSqliteWorker()

    const result = await t.withIdentity({ subject: BOB }).action(
      api.collectionIndex.rebuild,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'source-read-not-authorized',
      deniedSources: ['finance/transactions/2026-06.md'],
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed instead of rebuilding a truncated index when source scans overflow', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    for (let index = 0; index < 5001; index += 1) {
      await seedAtom(
        t,
        orgId,
        `finance/overflow/${String(index).padStart(4, '0')}.md`,
        `# Overflow ${index}`,
      )
    }
    const fetch = stubSqliteWorker()

    const result = await t.withIdentity({ subject: ALICE }).action(
      api.collectionIndex.rebuild,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'source-scan-truncated',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
