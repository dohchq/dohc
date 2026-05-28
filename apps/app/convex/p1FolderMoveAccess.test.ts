/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1fm'
const BOB = 'ws_bob_p1fm'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 (multiplayer-and-h-followups §6.5) — folders.move is the
// symmetric write surface to folders.remove: same recursive scan,
// same all-or-nothing posture, but TWO gates (source subtree
// readable + destination folder writable).

describe('P1 — folders.move gates', () => {
  it("source subtree gate: teammate cannot rename a folder containing a private atom", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'mix/secret.md',
      body: 's',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'mix/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.folders.move, {
        activeWorkspaceId: orgId,
        fromPath: 'mix',
        toPath: 'renamed',
      }),
    ).rejects.toThrow(/move this folder/)

    // Atom still at original path — no partial rename.
    const still = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'mix/secret.md'),
        )
        .unique(),
    )
    expect(still).not.toBeNull()
  })

  it("destination gate: teammate cannot move INTO a private folder", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    // Bob owns a folder he can read/write freely.
    await t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'bob/note.md',
      body: 'b',
    })
    // Alice locks down `alice/` as private.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: orgId,
      folderPath: 'alice',
      mode: 'private',
    })

    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.folders.move, {
        activeWorkspaceId: orgId,
        fromPath: 'bob',
        toPath: 'alice/bob',
      }),
    ).rejects.toThrow(/move into this destination/)
  })

  it('owner CAN rename their own folder of private atoms', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/a.md',
      body: 'a',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/a.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.folders.move, {
        activeWorkspaceId: orgId,
        fromPath: 'alice',
        toPath: 'alice-renamed',
      })
    expect(result.atomsMoved).toBeGreaterThan(0)
    const moved = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice-renamed/a.md'),
        )
        .unique(),
    )
    const movedAccess = await t.run(async (ctx) =>
      ctx.db
        .query('atomAccess')
        .withIndex('by_atom', (q) => q.eq('atomId', moved!._id))
        .unique(),
    )
    expect(movedAccess).toMatchObject({
      mode: 'private',
      ownerUserId: ALICE,
      allowedUserIds: [],
    })
  })

  it("non-restricted move: teammate renames freely (no access rows in subtree)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'shared/n.md',
      body: 'n',
    })
    const shared = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'shared/n.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: shared!._id,
      activeWorkspaceId: orgId,
      mode: null,
    })
    const result = await t
      .withIdentity({ subject: BOB })
      .mutation(api.folders.move, {
        activeWorkspaceId: orgId,
        fromPath: 'shared',
        toPath: 'shared-bob',
      })
    expect(result.atomsMoved).toBeGreaterThan(0)
  })
})
