/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1rp'
const BOB = 'ws_bob_p1rp'
const CAROL = 'ws_carol_p1rp'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, {
    inviteCode,
  })
  await t.withIdentity({ subject: CAROL }).mutation(api.orgs.joinOrg, {
    inviteCode,
  })
  return orgId
}

describe('P1 read-path filtering — atoms.list', () => {
  it('private atom is hidden from non-owner members', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    // Alice creates two atoms; marks one private.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'public.md',
      body: 'public',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'private.md',
      body: 'private',
    })
    const privateAtom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'private.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: privateAtom!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Alice sees both atoms.
    const aliceList = await t
      .withIdentity({ subject: ALICE })
      .query(api.atoms.list, { activeWorkspaceId: orgId })
    expect(aliceList.map((r) => r.path).sort()).toEqual([
      'private.md',
      'public.md',
    ])

    // Bob (member, not owner) sees ONLY the public atom.
    const bobList = await t
      .withIdentity({ subject: BOB })
      .query(api.atoms.list, { activeWorkspaceId: orgId })
    expect(bobList.map((r) => r.path)).toEqual(['public.md'])
  })

  it('restricted atom is visible to owner + allowed only', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'draft.md',
      body: 'draft',
    })
    const draft = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'draft.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: draft!._id,
      activeWorkspaceId: orgId,
      mode: 'restricted',
      allowedUserIds: [BOB],
    })
    // Bob (allowed) sees it.
    expect(
      (
        await t
          .withIdentity({ subject: BOB })
          .query(api.atoms.list, { activeWorkspaceId: orgId })
      ).map((r) => r.path),
    ).toContain('draft.md')
    // Carol (not allowed) does NOT.
    expect(
      (
        await t
          .withIdentity({ subject: CAROL })
          .query(api.atoms.list, { activeWorkspaceId: orgId })
      ).map((r) => r.path),
    ).not.toContain('draft.md')
  })

  it('folder-restricted atoms are hidden from non-allowed members', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'hr/employees.md',
      body: 'sensitive',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'team/wins.md',
      body: 'public',
    })
    // Alice restricts hr/ folder to herself.
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomAccess.setFolderAccess, {
        folderPath: 'hr',
        activeWorkspaceId: orgId,
        mode: 'private',
      })
    // Bob sees team/ but NOT hr/.
    const bobPaths = (
      await t
        .withIdentity({ subject: BOB })
        .query(api.atoms.list, { activeWorkspaceId: orgId })
    ).map((r) => r.path)
    expect(bobPaths).toContain('team/wins.md')
    expect(bobPaths).not.toContain('hr/employees.md')
  })

  it('atoms.getByPath returns null for non-allowed viewers', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'secret.md',
      body: 'secret',
    })
    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: atom!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Alice gets the atom.
    expect(
      await t
        .withIdentity({ subject: ALICE })
        .query(api.atoms.getByPath, {
          activeWorkspaceId: orgId,
          path: 'secret.md',
        }),
    ).not.toBeNull()
    // Bob gets null.
    expect(
      await t
        .withIdentity({ subject: BOB })
        .query(api.atoms.getByPath, {
          activeWorkspaceId: orgId,
          path: 'secret.md',
        }),
    ).toBeNull()
  })
})

describe('P1 read-path filtering — search.run', () => {
  it('full-text search excludes private atoms from non-allowed viewers', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    // Alice writes a private atom containing a unique keyword.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'uniquesecretkw_alice content',
    })
    const a = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: a!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Alice finds it.
    const aliceResults = await t
      .withIdentity({ subject: ALICE })
      .query(api.search.run, {
        activeWorkspaceId: orgId,
        query: 'uniquesecretkw_alice',
      })
    expect(aliceResults.map((r) => r.path)).toContain('alice/secret.md')
    // Bob does NOT.
    const bobResults = await t
      .withIdentity({ subject: BOB })
      .query(api.search.run, {
        activeWorkspaceId: orgId,
        query: 'uniquesecretkw_alice',
      })
    expect(bobResults.map((r) => r.path)).not.toContain('alice/secret.md')
  })

  it('recent-docs (empty query) also filters by access', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'hi',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'public.md',
      body: 'hi',
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
    // Bob's recent-docs (1-char query falls to recent path).
    const bobRecent = await t
      .withIdentity({ subject: BOB })
      .query(api.search.run, { activeWorkspaceId: orgId, query: '' })
    expect(bobRecent.map((r) => r.path)).not.toContain('alice/secret.md')
    expect(bobRecent.map((r) => r.path)).toContain('public.md')
  })
})

describe('P1 read-path filtering — htmlAtoms.getRenderable', () => {
  it('returns null for non-allowed viewers (route → 404)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    // Create an HTML atom with frontmatter id.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'private-dash.html',
      body: '---\nid: privatedash\n---\n<h1>Private Dashboard</h1>',
    })
    const html = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'private-dash.html'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: html!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Alice gets the HTML.
    const aliceHtml = await t
      .withIdentity({ subject: ALICE })
      .query(api.htmlAtoms.getRenderable, {
        atomId: 'privatedash',
        activeWorkspaceId: orgId,
      })
    expect(aliceHtml).not.toBeNull()
    expect(aliceHtml?.html).toContain('Private Dashboard')
    // Bob gets null (route maps to 404 per the M5 fail-closed pattern).
    const bobHtml = await t
      .withIdentity({ subject: BOB })
      .query(api.htmlAtoms.getRenderable, {
        atomId: 'privatedash',
        activeWorkspaceId: orgId,
      })
    expect(bobHtml).toBeNull()
  })
})

describe('P1 tombstone cascade — removeMember + leaveOrg', () => {
  it('removeMember tombstones the departing member private atoms', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    // Bob creates a private atom in the org.
    await t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'bob/private.md',
      body: 'bob secret',
    })
    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'bob/private.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: BOB }).mutation(api.atomAccess.setAtomAccess, {
      atomId: atom!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Alice (Owner) removes Bob.
    await t.withIdentity({ subject: ALICE }).mutation(api.orgs.removeMember, {
      orgId,
      memberWorkspaceId: BOB,
    })
    // Tombstone row exists for Bob's atom.
    const tomb = await t.run(async (ctx) =>
      ctx.db
        .query('atomTombstones')
        .withIndex('by_atom', (q) => q.eq('atomId', atom!._id))
        .unique(),
    )
    expect(tomb).not.toBeNull()
    expect(tomb?.originalOwnerUserId).toBe(BOB)
    expect(tomb?.recoveredAt).toBeUndefined()
    // Even Alice (Owner) can't see it now — tombstone makes it
    // invisible to ALL until recovery (decision P1-C / P1-B).
    const aliceList = await t
      .withIdentity({ subject: ALICE })
      .query(api.atoms.list, { activeWorkspaceId: orgId })
    expect(aliceList.map((r) => r.path)).not.toContain('bob/private.md')
  })

  it('leaveOrg tombstones the caller private atoms', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    // Bob writes a private note + leaves.
    await t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'bob/note.md',
      body: 'b',
    })
    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'bob/note.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: BOB }).mutation(api.atomAccess.setAtomAccess, {
      atomId: atom!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await t.withIdentity({ subject: BOB }).mutation(api.orgs.leaveOrg, { orgId })
    // Tombstoned.
    const tomb = await t.run(async (ctx) =>
      ctx.db
        .query('atomTombstones')
        .withIndex('by_atom', (q) => q.eq('atomId', atom!._id))
        .unique(),
    )
    expect(tomb?.originalOwnerUserId).toBe(BOB)
  })

  it('Owner recovery restores access per the chosen mode', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'bob/note.md',
      body: 'b',
    })
    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'bob/note.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: BOB }).mutation(api.atomAccess.setAtomAccess, {
      atomId: atom!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.orgs.removeMember, {
      orgId,
      memberWorkspaceId: BOB,
    })
    // Owner recovers to org-default.
    await t.withIdentity({ subject: ALICE }).mutation(
      api.atomAccess.recoverTombstonedAtom,
      {
        atomId: atom!._id,
        activeWorkspaceId: orgId,
        newAccessMode: 'org-default',
      },
    )
    // Now visible to everyone in the org (Alice, Carol).
    const aliceList = await t
      .withIdentity({ subject: ALICE })
      .query(api.atoms.list, { activeWorkspaceId: orgId })
    expect(aliceList.map((r) => r.path)).toContain('bob/note.md')
    const carolList = await t
      .withIdentity({ subject: CAROL })
      .query(api.atoms.list, { activeWorkspaceId: orgId })
    expect(carolList.map((r) => r.path)).toContain('bob/note.md')
  })
})
