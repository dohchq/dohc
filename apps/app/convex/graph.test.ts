/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_graph'

const seed = (t: ReturnType<typeof convexTest>, path: string, body: string) =>
  t.mutation(internal.atoms._upsertInternal, { workspaceId: W, path, body, source: 'user' })
const seedFor = (
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body: string,
) =>
  t.mutation(internal.atoms._upsertInternal, {
    workspaceId,
    path,
    body,
    source: 'user',
  })

describe('graph-v1 1c — personalGraph', () => {
  it('cells carry their {} atoms; wikilinks + formula refs are edges', async () => {
    const t = convexTest(schema, modules)
    await seed(t, 'clients/acme.md', '---\nid: clients.acme\n---\n{owed: 500} {rate: 130}')
    await seed(t, 'dash.md', '---\nid: dash\n---\n[[clients/acme]] and {= sum(clients.acme.owed) }')
    const g = await t.withIdentity({ subject: W }).query(api.graph.personalGraph, {})

    const acme = g.nodes.find((n) => n.fileId === 'clients.acme')
    expect(acme).toBeTruthy()
    expect(acme!.atoms).toEqual(
      expect.arrayContaining([
        { key: 'owed', value: '500' },
        { key: 'rate', value: '130' },
      ]),
    )
    // dash → clients.acme via BOTH a wikilink and a formula ref
    const kinds = g.edges
      .filter((e) => e.source === 'dash' && e.target === 'clients.acme')
      .map((e) => e.kind)
      .sort()
    expect(kinds).toEqual(['formula', 'link'])
  })

  it('edges to unknown/unshared files are dropped (no dangling targets)', async () => {
    const t = convexTest(schema, modules)
    await seed(t, 'dash.md', '---\nid: dash\n---\n{= sum(ghost.x) } [[nope]]')
    const g = await t.withIdentity({ subject: W }).query(api.graph.personalGraph, {})
    expect(g.edges).toHaveLength(0)
  })

  it('reads the caller-visible files from the active workspace, not always personal', async () => {
    const t = convexTest(schema, modules)
    const owner = 'ws_graph_owner'
    const member = 'ws_graph_member'
    const { orgId, inviteCode } = await t
      .withIdentity({ subject: owner })
      .mutation(api.orgs.createOrg, {
        name: 'Graph Workspace',
      })
    await t.withIdentity({ subject: member }).mutation(api.orgs.joinOrg, {
      inviteCode,
    })
    await seedFor(t, member, 'personal.md', '---\nid: personal\n---\nPersonal')
    await seedFor(t, orgId, 'team.md', '---\nid: team\n---\nTeam')

    const g = await t.withIdentity({ subject: member }).query(api.graph.personalGraph, {
      activeWorkspaceId: orgId,
    })

    expect(g.nodes.map((n) => n.fileId)).toEqual(['team'])
  })
})

// ── 1c review P1 — sharedGraph owner-qualifies nodes/edges ──────────
describe('graph-v1 1c — sharedGraph never crosses owners', () => {
  it('a formula ref resolves WITHIN the same owner, not to another owner cell of the same fileId', async () => {
    const t = convexTest(schema, modules)
    const A = 'ws_A'
    const B = 'ws_B'
    const V = 'ws_viewer'
    const seedFor = (ws: string, path: string, body: string) =>
      t.mutation(internal.atoms._upsertInternal, { workspaceId: ws, path, body, source: 'user' })
    // A's dash references fileId "x" — A's OWN x, which A does NOT share
    await seedFor(A, 'x.md', '---\nid: x\n---\n{amount: 1}')
    await seedFor(A, 'dash.md', '---\nid: dash\n---\n{= sum(x.amount) }')
    // B shares a DIFFERENT cell that happens to have the same fileId "x"
    await seedFor(B, 'x.md', '---\nid: x\n---\n{amount: 999}')
    await t.withIdentity({ subject: A }).mutation(api.atomShares.shareAtom, {
      fileId: 'dash', granteeWorkspaceId: V, permission: 'view',
    })
    await t.withIdentity({ subject: B }).mutation(api.atomShares.shareAtom, {
      fileId: 'x', granteeWorkspaceId: V, permission: 'view',
    })
    const g = await t.withIdentity({ subject: V }).query(api.graph.sharedGraph, {})
    // owner-qualified ids → no collision
    expect(g.nodes.map((n) => n.id).sort()).toEqual([`${A}::dash`, `${B}::x`].sort())
    // A's dash refs A's OWN (unshared) x → NOT in the known set;
    // it must NOT falsely edge to B's shared x.
    expect(g.edges).toHaveLength(0)
  })
})

// ── 1c review — graph matches legacy-escaped wikilinks ───────────────
describe('graph-v1 — escaped wikilinks produce edges (codex gap #1)', () => {
  it('a \\[\\[..]] link (as a legacy editor stored user-typed links) is an edge', async () => {
    const t = convexTest(schema, modules)
    await seed(t, 'clients/acme.md', '---\nid: clients.acme\n---\nx')
    // a legacy editor serialized a typed [[clients/acme]] with escaped opening brackets:
    await seed(t, 'dash.md', '---\nid: dash\n---\n\\[\\[clients/acme]] notes')
    const g = await t.withIdentity({ subject: W }).query(api.graph.personalGraph, {})
    expect(
      g.edges.some(
        (e) => e.source === 'dash' && e.target === 'clients.acme' && e.kind === 'link',
      ),
    ).toBe(true)
  })
})
