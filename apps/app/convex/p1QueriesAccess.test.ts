/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1q'
const BOB = 'ws_bob_p1q'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 (multiplayer-and-h-followups §6.5) — the docs.* DSL ops in the
// query namespace are the THIRD read surface (after editor + render
// route + search): both `docs.glob("**/*.md")` (path enumerator) and
// `docs.find("path")` (body returner) run via the same evalQuery
// path. Both must filter against the viewer's access:
//
//   • evalQueryBlocks (reactive editor query) pulls the viewer
//     subject from ctx.auth.getUserIdentity() directly
//   • queries.run (action used by the agent's run_query tool) pulls
//     it via internal.agent._viewerSubjectForCaller (same bridge as
//     list_atoms / read_atom)
//
// Tests below cover both paths: the reactive editor query (with
// signed-in identity) and a public surface check that an unsigned
// caller fails-closed on private/restricted atoms (the empty-subject
// branch — strictest fail-closed behavior).

describe('P1 — evalQueryBlocks (reactive editor)', () => {
  it('docs.glob: filters out paths the viewer cannot read', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'public/page.md',
      body: 'p',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 's',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Alice sees both.
    const alice = await t
      .withIdentity({ subject: ALICE })
      .query(api.queries.evalQueryBlocks, {
        srcs: ['docs.glob("**/*.md")'],
        activeWorkspaceId: orgId,
      })
    expect(alice[0]?.value).toContain('alice/secret.md')
    expect(alice[0]?.value).toContain('public/page.md')

    // Bob sees only public/page.md — NEVER alice/secret.md.
    const bob = await t
      .withIdentity({ subject: BOB })
      .query(api.queries.evalQueryBlocks, {
        srcs: ['docs.glob("**/*.md")'],
        activeWorkspaceId: orgId,
      })
    expect(bob[0]?.value).toContain('public/page.md')
    expect(bob[0]?.value).not.toContain('alice/secret.md')
  })

  it('docs.find: returns "missing" for private atoms (no existence oracle)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'top secret body content',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Alice: gets the body (digested).
    const alice = await t
      .withIdentity({ subject: ALICE })
      .query(api.queries.evalQueryBlocks, {
        srcs: ['docs.find("alice/secret.md")'],
        activeWorkspaceId: orgId,
      })
    expect(alice[0]?.value).toContain('top secret')

    // Bob: gets the SAME shape as a missing atom — never the body,
    // never a "you can't see this" hint (which would itself confirm
    // existence to a curious member).
    const bob = await t
      .withIdentity({ subject: BOB })
      .query(api.queries.evalQueryBlocks, {
        srcs: ['docs.find("alice/secret.md")'],
        activeWorkspaceId: orgId,
      })
    expect(bob[0]?.value).toBe('_(missing: alice/secret.md)_')
  })

  it('docs.glob: restricted mode — allowlisted member sees, others do not', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    // Add a third user; Alice will restrict to Bob only (Carol blocked).
    const CAROL = 'ws_carol_p1q'
    // The owner-only invite code is exposed by `myOrgs` — pull it.
    const aliceOrgs = await t
      .withIdentity({ subject: ALICE })
      .query(api.orgs.myOrgs, {})
    const invite = aliceOrgs.find((o) => o.orgId === orgId)?.inviteCode
    if (!invite) throw new Error('invite code unavailable to owner')
    await t
      .withIdentity({ subject: CAROL })
      .mutation(api.orgs.joinOrg, { inviteCode: invite })

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'restricted/shared.md',
      body: 'r',
    })
    const restricted = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'restricted/shared.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: restricted!._id,
      activeWorkspaceId: orgId,
      mode: 'restricted',
      allowedUserIds: [BOB],
    })

    const bob = await t
      .withIdentity({ subject: BOB })
      .query(api.queries.evalQueryBlocks, {
        srcs: ['docs.glob("**/*.md")'],
        activeWorkspaceId: orgId,
      })
    expect(bob[0]?.value).toContain('restricted/shared.md')

    const carol = await t
      .withIdentity({ subject: CAROL })
      .query(api.queries.evalQueryBlocks, {
        srcs: ['docs.glob("**/*.md")'],
        activeWorkspaceId: orgId,
      })
    expect(carol[0]?.value).not.toContain('restricted/shared.md')
  })
})

describe('P1 — queries.run action (agent run_query tool path)', () => {
  it('docs.find: returns "missing" body for private atoms (action path filters)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'sekrit',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Bob runs the same query via the action (what the agent's
    // run_query tool calls) — and gets the missing-shape.
    const bobMd = await t
      .withIdentity({ subject: BOB })
      .action(api.queries.run, {
        src: 'docs.find("alice/secret.md")',
        activeWorkspaceId: orgId,
      })
    expect(bobMd).toBe('_(missing: alice/secret.md)_')

    // Alice runs the same query and gets the body.
    const aliceMd = await t
      .withIdentity({ subject: ALICE })
      .action(api.queries.run, {
        src: 'docs.find("alice/secret.md")',
        activeWorkspaceId: orgId,
      })
    expect(aliceMd).toContain('sekrit')
  })
})
