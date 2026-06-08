/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_app_collab_alice'
const BOB = 'ws_app_collab_bob'

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
      write: ['transactions/**'],
      collections: {
        transactions: { source: 'transactions/*.md', write: 'transactions/**' },
      },
    }),
  )
  await seedAtom(t, workspaceId, 'finance/transactions/open.md', '# Open\n{Merchant: "Lyft"} {Amount: 18}')
}

describe('app collaboration through canonical sources', () => {
  it('broadcasts collection changes to permitted collaborators through shared source reads', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedTracker(t, orgId)
    await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })

    const beforeAlice = await t.withIdentity({ subject: ALICE }).query(
      api.appCollaboration.collectionRows,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      },
    )
    const beforeBob = await t.withIdentity({ subject: BOB }).query(
      api.appCollaboration.collectionRows,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      },
    )
    expect(beforeAlice).toMatchObject({ ok: true })
    expect(beforeBob).toMatchObject({ ok: true })

    await expect(t.withIdentity({ subject: ALICE }).mutation(
      api.appCollaboration.insertCollectionRow,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        record: { Merchant: 'Grab', Amount: 420, Reviewed: 'No' },
        clientMutationId: 'alice-grab',
      },
    )).resolves.toMatchObject({ ok: false, code: 'canonical-write-required' })

    const afterAlice = await t.withIdentity({ subject: ALICE }).query(
      api.appCollaboration.collectionRows,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      },
    )
    const afterBob = await t.withIdentity({ subject: BOB }).query(
      api.appCollaboration.collectionRows,
      {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
      },
    )

    expect(afterAlice).toMatchObject({ ok: true })
    expect(afterBob).toMatchObject({ ok: true })
    expect(afterAlice.ok && afterAlice.rows).toContainEqual(
      expect.objectContaining({ Merchant: 'Lyft', Amount: 18 }),
    )
    expect(afterBob.ok && afterBob.rows).toContainEqual(
      expect.objectContaining({ Merchant: 'Lyft', Amount: 18 }),
    )
    expect(afterAlice.ok && afterAlice.rows).not.toContainEqual(
      expect.objectContaining({ Merchant: 'Grab', Amount: 420, Reviewed: 'No' }),
    )
  })
})
