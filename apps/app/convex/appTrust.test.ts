/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_app_trust_alice'
const BOB = 'ws_app_trust_bob'

function assertOk<T extends { ok: boolean }>(value: T): asserts value is Extract<T, { ok: true }> {
  expect(value).toMatchObject({ ok: true })
  if (!value.ok) throw new Error('expected ok result')
}

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

async function seedTracker(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  extra: Record<string, unknown> = {},
) {
  await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/tracker/app.json',
    JSON.stringify({
      title: 'Finance Tracker',
      read: ['transactions/**', 'categories.md', 'ledger.sqlite'],
      write: ['transactions/**', 'categories.md', 'ledger.sqlite'],
      collections: {
        transactions: { source: 'transactions/*.md', write: 'transactions/**' },
      },
      databases: {
        ledger: { path: 'ledger.sqlite', write: true },
      },
      ...extra,
    }),
  )
}

describe('api.appTrust', () => {
  it('requires per-user trust for the current manifest write key', async () => {
    const t = convexTest(schema, modules)
    await seedTracker(t, ALICE)

    const before = await t.withIdentity({ subject: ALICE }).query(api.appTrust.state, {
      packageRoot: 'finance/.apps/tracker',
    })
    expect(before).toMatchObject({
      ok: true,
      trusted: false,
      title: 'Finance Tracker',
      writeTargets: [
        'finance/categories.md',
        'finance/ledger.sqlite',
        'finance/transactions/**',
      ],
    })
    assertOk(before)
    expect(before.prompt).toContain('Finance Tracker wants to write to:')
    expect(before.prompt).toContain('- finance/transactions/**')
    expect(before.prompt).toContain('Changing app.json resets this permission.')

    const grant = await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      packageRoot: 'finance/.apps/tracker',
    })
    expect(grant).toEqual({ ok: true, trustKey: before.trustKey })

    const after = await t.withIdentity({ subject: ALICE }).query(api.appTrust.state, {
      packageRoot: 'finance/.apps/tracker',
    })
    expect(after).toMatchObject({ ok: true, trusted: true, trustKey: before.trustKey })
  })

  it('resets trust when manifest write capabilities change', async () => {
    const t = convexTest(schema, modules)
    await seedTracker(t, ALICE)
    const before = await t.withIdentity({ subject: ALICE }).query(api.appTrust.state, {
      packageRoot: 'finance/.apps/tracker',
    })
    assertOk(before)
    await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      packageRoot: 'finance/.apps/tracker',
    })

    await t.run(async (ctx) => {
      const rows = await ctx.db.query('atoms').collect()
      const manifest = rows.find(
        (atom) =>
          atom.workspaceId === ALICE &&
          atom.path === 'finance/.apps/tracker/app.json',
      )
      await ctx.db.patch(manifest!._id, {
        body: JSON.stringify({
          title: 'Finance Tracker',
          read: ['transactions/**', 'categories.md', 'ledger.sqlite', 'budgets.md'],
          write: ['transactions/**', 'categories.md', 'ledger.sqlite', 'budgets.md'],
        }),
        updatedAt: Date.now(),
      })
    })

    const after = await t.withIdentity({ subject: ALICE }).query(api.appTrust.state, {
      packageRoot: 'finance/.apps/tracker',
    })
    expect(after).toMatchObject({ ok: true, trusted: false })
    assertOk(after)
    expect(after.trustKey).not.toBe(before.trustKey)
    expect(after.writeTargets).toContain('finance/budgets.md')
  })

  it('does not share trust between collaborators in the same workspace', async () => {
    const t = convexTest(schema, modules)
    const { orgId, inviteCode } = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.orgs.createOrg, { name: 'Finance Team' })
    await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
    await seedTracker(t, orgId)

    const aliceBefore = await t.withIdentity({ subject: ALICE }).query(api.appTrust.state, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })

    const aliceAfter = await t.withIdentity({ subject: ALICE }).query(api.appTrust.state, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })
    const bobAfter = await t.withIdentity({ subject: BOB }).query(api.appTrust.state, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })
    assertOk(aliceBefore)

    expect(aliceAfter).toMatchObject({
      ok: true,
      trusted: true,
      trustKey: aliceBefore.trustKey,
    })
    expect(bobAfter).toMatchObject({
      ok: true,
      trusted: false,
      trustKey: aliceBefore.trustKey,
    })
  })

  it('fails closed when app descriptor resolution would use a capped partial scan', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, ALICE, 'finance/.apps/tracker/src/App.tsx', 'app')
    for (let index = 0; index < 5001; index += 1) {
      await seedAtom(t, ALICE, `archive/${String(index).padStart(4, '0')}.md`, '# Archive')
    }
    await seedAtom(
      t,
      ALICE,
      'finance/.apps/tracker/app.json',
      JSON.stringify({
        title: 'Finance Tracker',
        read: ['ledger.sqlite'],
        write: ['ledger.sqlite'],
      }),
    )

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.appTrust.state, {
        packageRoot: 'finance/.apps/tracker',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'source-scan-truncated',
    })
  })
})
