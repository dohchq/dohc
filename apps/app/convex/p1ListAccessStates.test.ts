/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1las'
const BOB = 'ws_bob_p1las'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function makeOrgDefault(
  t: ReturnType<typeof convexTest>,
  orgId: string,
  path: string,
) {
  const atom = await t.run(async (ctx) => {
    const atoms = await ctx.db.query('atoms').collect()
    return atoms.find(
      (row: { workspaceId: string; path: string }) =>
        row.workspaceId === orgId && row.path === path,
    )
  })
  await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
    atomId: atom!._id,
    activeWorkspaceId: orgId,
    mode: null,
  })
}

// P1 (multiplayer-and-h-followups §6.5) — file-tree lock-badge
// data source. Tree consumes [{fileId, mode}] and renders a Lock
// icon next to each match.

describe('P1 — listAccessStates', () => {
  it('returns private/restricted entries for atoms the caller can read', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    // Alice creates two atoms and locks them differently.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/p.md',
      body: 'p',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/r.md',
      body: 'r',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'open/x.md',
      body: 'x',
    })
    await makeOrgDefault(t, orgId, 'open/x.md')

    const [pRow, rRow] = await t.run(async (ctx) => {
      const allAtoms = await ctx.db.query('atoms').collect()
      const p = allAtoms.find((a: { path: string }) => a.path === 'alice/p.md')
      const r = allAtoms.find((a: { path: string }) => a.path === 'alice/r.md')
      return [p, r]
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: pRow!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: rRow!._id,
      activeWorkspaceId: orgId,
      mode: 'restricted',
      allowedUserIds: [BOB],
    })

    // Alice (owner) sees BOTH locked atoms in her tree state.
    const alice = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomAccess.listAccessStates, { activeWorkspaceId: orgId })
    expect(alice.length).toBe(2)
    expect(alice.map((a) => a.mode).sort()).toEqual(['private', 'restricted'])

    // Bob can read the RESTRICTED one (he's on the allowlist) but
    // not the PRIVATE one — listAccessStates omits what he can't read.
    const bob = await t
      .withIdentity({ subject: BOB })
      .query(api.atomAccess.listAccessStates, { activeWorkspaceId: orgId })
    expect(bob.length).toBe(1)
    expect(bob[0]?.mode).toBe('restricted')
  })

  it('empty result when no overrides exist (common case)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'team/n.md',
      body: 'n',
    })
    await makeOrgDefault(t, orgId, 'team/n.md')
    const out = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomAccess.listAccessStates, { activeWorkspaceId: orgId })
    expect(out).toEqual([])
  })
})
