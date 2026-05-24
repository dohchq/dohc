/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1f'
const BOB = 'ws_bob_p1f'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 (multiplayer-and-h-followups §6.5) — the FOURTH read surface
// is the reactive formula evaluator. `{= sum(salary) }` in any
// editor aggregates inline `{salary: 120000}` values across the
// whole workspace; without an access gate, a public dashboard's
// sum would silently include a private atom's salary value, leaking
// it through a confidentiality-violating aggregate. The gate sits
// in buildStore — atoms the viewer can't read are dropped BEFORE
// their values enter byKey, so every fail-soft semantic (`—` /
// 0-for-count) cleanly carries over.

describe('P1 — evalFormulas (reactive)', () => {
  it("sum: a private atom does NOT contribute to a teammate's aggregate", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    // Path-derived fileIds: `public/alice.md` → `public.alice` etc.
    // (the public upsert binds an atomIds row from the path).
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'public/alice.md',
      body: '{salary: 100000}',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'private/bob.md',
      body: '{salary: 200000}',
    })

    const bobAtom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'private/bob.md'),
        )
        .unique(),
    )
    // Alice marks bob.md PRIVATE (owner-only).
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: bobAtom!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Alice's reactive editor: BOTH salaries enter the store → 300000.
    const aliceOut = await t
      .withIdentity({ subject: ALICE })
      .query(api.formulaEval.evalFormulas, {
        srcs: ['sum(salary)'],
        activeWorkspaceId: orgId,
      })
    expect(aliceOut[0]?.value).toBe(300000)

    // Bob's reactive editor: private/bob.md is filtered BEFORE its
    // salary enters byKey, so the sum is 100000 (no leak).
    const bobOut = await t
      .withIdentity({ subject: BOB })
      .query(api.formulaEval.evalFormulas, {
        srcs: ['sum(salary)'],
        activeWorkspaceId: orgId,
      })
    expect(bobOut[0]?.value).toBe(100000)
  })

  it("count: a private atom does NOT bump a teammate's count", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'projects/p1.md',
      body: '{status: active}',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'projects/secret.md',
      body: '{status: active}',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'projects/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // count(projects.* status=active) — Alice sees both, Bob sees only p1.
    const aliceOut = await t
      .withIdentity({ subject: ALICE })
      .query(api.formulaEval.evalFormulas, {
        srcs: ['count(projects.* status=active)'],
        activeWorkspaceId: orgId,
      })
    expect(aliceOut[0]?.value).toBe(2)

    const bobOut = await t
      .withIdentity({ subject: BOB })
      .query(api.formulaEval.evalFormulas, {
        srcs: ['count(projects.* status=active)'],
        activeWorkspaceId: orgId,
      })
    expect(bobOut[0]?.value).toBe(1)
  })

  it("bare address: returns null (—) for a private atom's referenced value", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    // path `private/x.md` → fileId `private.x`; address `private.x.value`.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'private/x.md',
      body: '{value: 42}',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'private/x.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Alice: gets 42.
    const aliceOut = await t
      .withIdentity({ subject: ALICE })
      .query(api.formulaEval.evalFormulas, {
        srcs: ['private.x.value'],
        activeWorkspaceId: orgId,
      })
    expect(aliceOut[0]?.value).toBe(42)

    // Bob: null — the private atom never enters the store, so the
    // bare address has zero matches → null → editor renders `—`
    // (identical shape to a missing/non-existent reference). No
    // existence oracle.
    const bobOut = await t
      .withIdentity({ subject: BOB })
      .query(api.formulaEval.evalFormulas, {
        srcs: ['private.x.value'],
        activeWorkspaceId: orgId,
      })
    expect(bobOut[0]?.value).toBeNull()
  })
})
