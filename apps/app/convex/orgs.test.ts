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
  return { orgId }
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
