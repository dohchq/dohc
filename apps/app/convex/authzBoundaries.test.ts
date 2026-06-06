/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const ALICE = 'ws_authz_boundaries_alice'
const BOB = 'ws_authz_boundaries_bob'

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Finance Team' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function seedAtom(t: ReturnType<typeof convexTest>, workspaceId: string, path: string, body = '') {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId, path, body, updatedAt: Date.now() })
  })
}

describe('app authz boundaries', () => {
  it('manifest read scope never grants access to a private source by itself', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedAtom(t, orgId, 'finance/.apps/tracker/src/App.tsx', 'app')
    await seedAtom(t, orgId, 'finance/.apps/tracker/app.json', JSON.stringify({
      title: 'Finance Tracker',
      read: ['private/**'],
    }))
    await seedAtom(t, orgId, 'finance/private/ledger.md', '# Ledger\nsecret')
    const privateAtom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'finance/private/ledger.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      activeWorkspaceId: orgId,
      atomId: privateAtom!._id,
      mode: 'private',
    })

    await expect(
      t.withIdentity({ subject: BOB }).query(api.appData.getAtom, {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        path: 'private/ledger.md',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'source-read-not-authorized' })
  })

  it('cross-workspace activeWorkspaceId spoofing is denied server-side', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await expect(
      t.withIdentity({ subject: 'ws_authz_boundaries_eve' }).query(api.appData.listSources, {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
        source: '.',
      }),
    ).rejects.toThrow()
  })
})
