/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_app_sec_alice'
const BOB = 'ws_app_sec_bob'

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
  extra: Record<string, unknown> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId, path, body, updatedAt: Date.now(), ...extra })
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
        transactions: { source: 'transactions/*.md', write: 'transactions/**' },
      },
    }),
  )
}

async function seedTransactionTable(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  extra: Record<string, unknown> = {},
) {
  await seedAtom(
    t,
    workspaceId,
    'finance/transactions/2026-06.md',
    [
      '| ID | Merchant | Amount |',
      '|---|---|---:|',
      '| txn_001 | Lyft | 18 |',
    ].join('\n'),
    extra,
  )
}

describe('app security boundaries', () => {
  it('denies app read when manifest allows the path but the user cannot read the source', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    await seedAtom(t, orgId, 'finance/transactions/2026-06.md', '# June\n{Merchant: "Grab"}')
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

    const result = await t.withIdentity({ subject: BOB }).query(api.appData.getAtom, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
      path: 'transactions/2026-06.md',
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'source-read-not-authorized',
    })
  })

  it('requires the calling user to trust the current manifest before app writes', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    await seedTransactionTable(t, orgId)
    await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })

    const result = await t.withIdentity({ subject: BOB }).action(
      api.appData.runCollectionMutation,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'insert',
        record: { Merchant: 'Grab', Amount: 420 },
        clientMutationId: 'bob-untrusted',
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'app-trust-required',
    })
  })

  it('denies app writes outside manifest write scope or normal actor write access', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    await seedTransactionTable(t, orgId, { userLocked: true })
    await t.withIdentity({ subject: BOB }).mutation(api.appTrust.grant, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })

    const result = await t.withIdentity({ subject: BOB }).action(
      api.appData.runCollectionMutation,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'insert',
        record: { Merchant: 'Grab', Amount: 420 },
        clientMutationId: 'bob-locked',
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'source-write-not-authorized',
    })
  })
})
