/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import { resolveAtomAccess } from './atomAccess'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1'
const BOB = 'ws_bob_p1'
const CAROL = 'ws_carol_p1'

// Seed helper: creates an org, makes Alice the Owner, joins Bob and
// Carol as Members. Returns the orgId.
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

// Insert an atom directly into the db (skips the access-aware upsert
// surface; bypasses the org-membership write check — which is fine for
// tests that exercise the resolver in isolation).
async function insertAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '# test',
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('atoms', {
      workspaceId,
      path,
      body,
      updatedAt: Date.now(),
    })
  })
}

describe('resolveAtomAccess (P1 §6.5)', () => {
  it('org-default — any active member can read (no atomAccess row)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'team/notes.md')
    // Bob (member) reads — allowed via org-default.
    const result = await t.run(async (ctx) =>
      resolveAtomAccess(ctx, atomId, BOB),
    )
    expect(result).toEqual({ allowed: true, mode: 'org-default' })
  })

  it('atom private — only the owner reads; others denied', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'alice/secret.md')
    // Alice marks it private.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Alice reads.
    expect(
      await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, ALICE)),
    ).toMatchObject({ allowed: true, mode: 'private', ownerUserId: ALICE })
    // Bob does NOT.
    expect(
      await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, BOB)),
    ).toMatchObject({ allowed: false, reason: 'atom-private' })
  })

  it('atom restricted — owner + listed read; others denied', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'shared/draft.md')
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'restricted',
      allowedUserIds: [BOB],
    })
    // Alice (owner) + Bob (allowed) read.
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, ALICE))).allowed,
    ).toBe(true)
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, BOB))).allowed,
    ).toBe(true)
    // Carol (not on list) denied.
    expect(
      await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, CAROL)),
    ).toMatchObject({ allowed: false, reason: 'atom-restricted' })
  })

  it('folder cascade — restricted folder blocks atoms inside', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'hr/employees.md')
    // Alice restricts the hr/ folder to Alice + Bob.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      folderPath: 'hr',
      activeWorkspaceId: orgId,
      mode: 'restricted',
      allowedUserIds: [BOB],
    })
    // Alice + Bob read.
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, ALICE))).allowed,
    ).toBe(true)
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, BOB))).allowed,
    ).toBe(true)
    // Carol blocked.
    expect(
      await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, CAROL)),
    ).toMatchObject({ allowed: false, reason: 'folder-restricted' })
  })

  it('atom-level access OVERRIDES folder cascade', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'hr/public-policies.md')
    // Folder restricted to Alice.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      folderPath: 'hr',
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // But this specific atom is restricted to a wider list.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'restricted',
      allowedUserIds: [BOB, CAROL],
    })
    // All three read (atom override wins; folder doesn't restrict it).
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, ALICE))).allowed,
    ).toBe(true)
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, BOB))).allowed,
    ).toBe(true)
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, CAROL))).allowed,
    ).toBe(true)
  })

  it('folder cascade — DEEPEST folder wins', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'projects/alpha/spec.md')
    // projects/ is open to all (no row).
    // projects/alpha is restricted to Alice.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      folderPath: 'projects/alpha',
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Alice reads; Bob blocked by the deeper folder rule.
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, ALICE))).allowed,
    ).toBe(true)
    expect(
      await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, BOB)),
    ).toMatchObject({ allowed: false, reason: 'folder-private' })
  })

  it('tombstoned atom — invisible to ALL (including former owner)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'alice/notes.md')
    // Alice marks it private; then Alice leaves the org (would tombstone).
    // Simulate tombstone directly.
    await t.run(async (ctx) => {
      await ctx.db.insert('atomTombstones', {
        atomId,
        workspaceId: orgId,
        reason: 'member-departed',
        tombstonedAt: Date.now(),
        originalOwnerUserId: ALICE,
      })
    })
    // ALL principals denied — Alice (former owner), Bob (member), Carol.
    for (const who of [ALICE, BOB, CAROL]) {
      const r = await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, who))
      expect(r).toMatchObject({ allowed: false, reason: 'tombstoned' })
    }
  })

  it('recovered tombstone — atom visible per the Owner-chosen access', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'alice/leaving.md')
    // Tombstone the atom.
    await t.run(async (ctx) => {
      await ctx.db.insert('atomTombstones', {
        atomId,
        workspaceId: orgId,
        reason: 'member-departed',
        tombstonedAt: Date.now(),
        originalOwnerUserId: ALICE,
      })
    })
    // Owner (Alice is the creator-Owner from seedOrgWithMembers) recovers
    // it to org-default visibility.
    await t.withIdentity({ subject: ALICE }).mutation(
      api.atomAccess.recoverTombstonedAtom,
      {
        atomId,
        activeWorkspaceId: orgId,
        newAccessMode: 'org-default',
      },
    )
    // Now visible to everyone (no atomAccess row → org-default).
    for (const who of [ALICE, BOB, CAROL]) {
      expect(
        (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, who)))
          .allowed,
      ).toBe(true)
    }
  })

  it('only the access owner can change the access (not other members)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'alice/note.md')
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Bob tries to hijack — fails.
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.atomAccess.setAtomAccess, {
        atomId,
        activeWorkspaceId: orgId,
        mode: 'private',
      }),
    ).rejects.toThrow(/Only the current access owner/)
  })

  it("private mode rejects non-empty allowedUserIds (must use restricted)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'alice/note.md')
    await expect(
      t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
        atomId,
        activeWorkspaceId: orgId,
        mode: 'private',
        allowedUserIds: [BOB],
      }),
    ).rejects.toThrow(/private mode/)
  })

  it('clearing access (mode: null) reverts to org-default', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'alice/note.md')
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Confirm restricted first.
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, BOB))).allowed,
    ).toBe(false)
    // Alice clears.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: null,
    })
    // Bob can read again.
    expect(
      (await t.run(async (ctx) => resolveAtomAccess(ctx, atomId, BOB))).allowed,
    ).toBe(true)
  })

  it('recoverTombstonedAtom requires Owner role', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const atomId = await insertAtom(t, orgId, 'departed/note.md')
    await t.run(async (ctx) => {
      await ctx.db.insert('atomTombstones', {
        atomId,
        workspaceId: orgId,
        reason: 'member-departed',
        tombstonedAt: Date.now(),
        originalOwnerUserId: ALICE,
      })
    })
    // Bob (Member) cannot recover.
    await expect(
      t.withIdentity({ subject: BOB }).mutation(
        api.atomAccess.recoverTombstonedAtom,
        {
          atomId,
          activeWorkspaceId: orgId,
          newAccessMode: 'org-default',
        },
      ),
    ).rejects.toThrow(/Requires Owner/)
  })
})
