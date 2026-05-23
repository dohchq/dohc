/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const A = 'ws_alice' // org creator/owner
const B = 'ws_bob'   // joins the org
const C = 'ws_carol' // never joins

const seedFor = (
  t: ReturnType<typeof convexTest>,
  ws: string,
  path: string,
  body: string,
) => t.mutation(internal.atoms._upsertInternal, { workspaceId: ws, path, body, source: 'user' })

async function makeOrgWithMember(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: A })
    .mutation(api.orgs.createOrg, { name: 'Acme Inc' })
  await t.withIdentity({ subject: B }).mutation(api.orgs.joinOrg, { inviteCode })
  return { orgId, inviteCode }
}

describe('orgs 1c — create / join / membership', () => {
  it('create makes the creator an owner; join by code adds a member', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await makeOrgWithMember(t)
    const aOrgs = await t.withIdentity({ subject: A }).query(api.orgs.myOrgs, {})
    expect(aOrgs).toHaveLength(1)
    expect(aOrgs[0]).toMatchObject({ orgId, name: 'Acme Inc', role: 'owner' })
    expect(aOrgs[0].inviteCode).toBeTruthy() // owner sees the code
    const bOrgs = await t.withIdentity({ subject: B }).query(api.orgs.myOrgs, {})
    expect(bOrgs[0]).toMatchObject({ orgId, role: 'member' })
    expect(bOrgs[0].inviteCode).toBeNull() // members don't get the code
    // a non-member sees no orgs
    expect(await t.withIdentity({ subject: C }).query(api.orgs.myOrgs, {})).toHaveLength(0)
  })

  it('a bad invite code is rejected', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.withIdentity({ subject: B }).mutation(api.orgs.joinOrg, { inviteCode: 'nope' }),
    ).rejects.toThrow(/no company/i)
  })
})

describe('orgs 1c — share to company (opt-in, members only)', () => {
  it('a member can read an org-shared cell; a non-member cannot', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await makeOrgWithMember(t)
    await seedFor(t, A, 'roadmap.md', '---\nid: roadmap\n---\nQ3 plan {target: 100}')
    const shareId = await t
      .withIdentity({ subject: A })
      .mutation(api.atomShares.shareAtomToOrg, {
        fileId: 'roadmap', orgId, permission: 'view',
      })
    // member B reads it
    const got = await t
      .withIdentity({ subject: B })
      .query(api.atomShares.getSharedAtom, { shareId })
    expect(got?.body).toContain('{target: 100}')
    // non-member C is DENIED
    expect(
      await t.withIdentity({ subject: C }).query(api.atomShares.getSharedAtom, { shareId }),
    ).toBeNull()
  })

  it('non-members cannot share to a company they are not in', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await makeOrgWithMember(t)
    await seedFor(t, C, 'mine.md', '---\nid: mine\n---\nx')
    await expect(
      t.withIdentity({ subject: C }).mutation(api.atomShares.shareAtomToOrg, {
        fileId: 'mine', orgId, permission: 'view',
      }),
    ).rejects.toThrow(/not a member/i)
  })
})

describe('orgs 1c — company graph (opt-in only; scoped formulas)', () => {
  it('shows org-shared cells to members; private cells never appear; formulas scoped', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await makeOrgWithMember(t)
    // A's PRIVATE secret + a shared roadmap that references it via formula
    await seedFor(t, A, 'secret.md', '---\nid: secret\n---\n{salary: 99999}')
    await seedFor(t, A, 'roadmap.md', '---\nid: roadmap\n---\n{target: 100} {= sum(secret.salary) }')
    const shareId = await t.withIdentity({ subject: A }).mutation(api.atomShares.shareAtomToOrg, {
      fileId: 'roadmap', orgId, permission: 'view',
    })
    // member B's company graph: roadmap appears, secret does NOT
    const g = await t.withIdentity({ subject: B }).query(api.graph.companyGraph, {})
    expect(g.nodes.map((n) => n.fileId).sort()).toEqual(['roadmap'])
    expect(g.nodes.find((n) => n.fileId === 'secret')).toBeUndefined()
    // the roadmap's formula over A's PRIVATE secret resolves to null (no leak)
    const res = await t.withIdentity({ subject: B }).query(api.formulaEval.evalFormulasShared, {
      shareId, srcs: ['sum(secret.salary)'],
    })
    expect(res[0].value).toBeNull()
    // a non-member sees an empty company graph
    expect(
      (await t.withIdentity({ subject: C }).query(api.graph.companyGraph, {})).nodes,
    ).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Phase 3 (org-plan.md §6 / decisions.md §2): orgs promoted from
// share-audience to tenancy unit. Two roles (Owner / Member), multiple
// Owners allowed, last-Owner protections, soft-remove for offboarding,
// myWorkspaces drives the workspace switcher.
// ──────────────────────────────────────────────────────────────────────

describe('org workspace lifecycle (Phase 3)', () => {
  it('createOrg → myWorkspaces shows personal + the org with the right role', async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await makeOrgWithMember(t)

    const aWs = await t.withIdentity({ subject: A }).query(api.orgs.myWorkspaces, {})
    expect(aWs.map((w) => w.kind)).toEqual(['personal', 'org'])
    expect(aWs[0]).toMatchObject({ workspaceId: A, role: 'owner' })
    expect(aWs[1]).toMatchObject({
      workspaceId: orgId,
      kind: 'org',
      name: 'Acme Inc',
      role: 'owner',
    })

    const bWs = await t.withIdentity({ subject: B }).query(api.orgs.myWorkspaces, {})
    expect(bWs[1]).toMatchObject({ workspaceId: orgId, role: 'member' })
  })

  it('multiple Owners allowed; last Owner cannot leave/be demoted/be removed', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    const { orgId } = await makeOrgWithMember(t)

    // A is the sole Owner.
    await expect(
      asA.mutation(api.orgs.leaveOrg, { orgId }),
    ).rejects.toThrow(/last Owner/)

    // Promote B → two Owners.
    await asA.mutation(api.orgs.changeRole, {
      orgId,
      memberWorkspaceId: B,
      role: 'owner',
    })
    // B can now demote A (one Owner remains).
    await asB.mutation(api.orgs.changeRole, {
      orgId,
      memberWorkspaceId: A,
      role: 'member',
    })
    // B is the only Owner — cannot self-demote.
    await expect(
      asB.mutation(api.orgs.changeRole, {
        orgId,
        memberWorkspaceId: B,
        role: 'member',
      }),
    ).rejects.toThrow(/last Owner/)
    // B is the only Owner — A (Member) cannot remove B.
    await expect(
      asB.mutation(api.orgs.removeMember, {
        orgId,
        memberWorkspaceId: B,
      }),
    ).rejects.toThrow(/last Owner/)
  })

  it('Members cannot invite-by-role-change or remove others (Owner-gated)', async () => {
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    const { orgId } = await makeOrgWithMember(t)

    await expect(
      asB.mutation(api.orgs.removeMember, {
        orgId,
        memberWorkspaceId: A,
      }),
    ).rejects.toThrow(/Requires Owner/)
    await expect(
      asB.mutation(api.orgs.changeRole, {
        orgId,
        memberWorkspaceId: A,
        role: 'member',
      }),
    ).rejects.toThrow(/Requires Owner/)
  })

  it('removeMember soft-removes; the member loses access; rejoin reactivates', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    const { orgId, inviteCode } = await makeOrgWithMember(t)

    expect((await asB.query(api.orgs.myWorkspaces, {})).length).toBe(2)
    await asA.mutation(api.orgs.removeMember, {
      orgId,
      memberWorkspaceId: B,
    })
    expect((await asB.query(api.orgs.myWorkspaces, {})).length).toBe(1)

    // Re-joining via the invite re-activates the removed row.
    await asB.mutation(api.orgs.joinOrg, { inviteCode })
    expect((await asB.query(api.orgs.myWorkspaces, {})).length).toBe(2)
  })

  it('renameOrg (decisions.md §3): Owner-only, trims, rejects empty/over-long, idempotent', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    const { orgId } = await makeOrgWithMember(t)

    // Member cannot rename — Owner-gated.
    await expect(
      asB.mutation(api.orgs.renameOrg, { orgId, name: 'Members R Us' }),
    ).rejects.toThrow(/Requires Owner/)

    // Owner can rename — trims whitespace.
    const r1 = await asA.mutation(api.orgs.renameOrg, {
      orgId,
      name: '  New Name  ',
    })
    expect(r1).toMatchObject({ ok: true, changed: true })
    const after = await asA.query(api.orgs.myWorkspaces, {})
    expect(after.find((w) => w.workspaceId === orgId)?.name).toBe('New Name')

    // Same name ⇒ idempotent no-op.
    const r2 = await asA.mutation(api.orgs.renameOrg, {
      orgId,
      name: 'New Name',
    })
    expect(r2).toMatchObject({ ok: true, changed: false })

    // Empty name (after trim) ⇒ reject.
    await expect(
      asA.mutation(api.orgs.renameOrg, { orgId, name: '   ' }),
    ).rejects.toThrow(/empty/)

    // Over-long ⇒ reject (the cap is 80 chars).
    await expect(
      asA.mutation(api.orgs.renameOrg, {
        orgId,
        name: 'x'.repeat(81),
      }),
    ).rejects.toThrow(/too long/)
  })

  it('a non-member is invisible to the org and to org.orgMembers', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asC = t.withIdentity({ subject: C })
    const { orgId } = await makeOrgWithMember(t)
    // C is NOT a member; orgMembers' own gate returns null for non-members.
    expect(await asC.query(api.orgs.orgMembers, { orgId })).toBeNull()
    // A (Owner) sees the active list (A + B from the helper).
    const members = await asA.query(api.orgs.orgMembers, { orgId })
    expect(members?.length).toBe(2)
    expect(members?.map((m) => m.workspaceId).sort()).toEqual([A, B].sort())
  })
})
