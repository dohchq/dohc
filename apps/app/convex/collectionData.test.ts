/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_collection_alice'
const BOB = 'ws_collection_bob'

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

describe('app collection data reads', () => {
  it('lists and gets manifest-backed markdown table rows', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)

    const rows = await t.withIdentity({ subject: ALICE }).query(api.collectionData.list, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
      collection: 'transactions',
      query: { where: { Reviewed: 'No' } },
    })

    expect(rows).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'txn_001', Merchant: 'Grab', Amount: 420 })],
      deniedSources: [],
    })

    const row = await t.withIdentity({ subject: ALICE }).query(api.collectionData.get, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
      collection: 'transactions',
      id: 'txn_002',
    })

    expect(row).toMatchObject({
      ok: true,
      row: expect.objectContaining({ id: 'txn_002', Merchant: 'Cafe', Reviewed: 'Yes' }),
    })
  })

  it('does not leak private source rows even when the manifest allows the path', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    await seedAtom(
      t,
      orgId,
      'finance/transactions/private.md',
      '| ID | Merchant | Amount |\n|---|---|---:|\n| secret_001 | Secret | 999 |',
    )
    const source = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'finance/transactions/private.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      activeWorkspaceId: orgId,
      atomId: source!._id,
      mode: 'private',
    })

    const rows = await t.withIdentity({ subject: BOB }).query(api.collectionData.list, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
      collection: 'transactions',
    })

    expect(rows).toMatchObject({
      ok: true,
      deniedSources: ['finance/transactions/private.md'],
    })
    expect(rows.ok && rows.rows).not.toContainEqual(
      expect.objectContaining({ Merchant: 'Secret' }),
    )
  })

  it('returns a stable error for unknown collections', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.collectionData.list, {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'missing',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'collection-not-found' })
  })

  it('fails closed instead of silently returning partial rows when collection source scans are truncated', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    await t.run(async (ctx) => {
      for (let index = 0; index < 5001; index += 1) {
        await ctx.db.insert('atoms', {
          workspaceId: orgId,
          path: `finance/transactions/bulk-${String(index).padStart(4, '0')}.md`,
          body: '| ID | Merchant |\n|---|---|\n| tx_bulk | Bulk |',
          updatedAt: Date.now() + index,
        })
      }
    })

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.collectionData.list, {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'source-scan-truncated',
    })
  })
})
