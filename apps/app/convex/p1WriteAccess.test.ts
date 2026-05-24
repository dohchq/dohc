/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1w'
const BOB = 'ws_bob_p1w'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 (multiplayer-and-h-followups §6.5) — WRITE-path gate.
//
// Read filtering alone is not enough: without write enforcement a
// teammate who can't READ Alice's private atom can still OVERWRITE
// it (because they know the path — wikilinks, search hits before
// the access change, a guessed path). The same goes for create-in-
// folder: a teammate could plant a doc inside Alice's private
// folder.
//
// Notion-full §6.5 semantic: read == write at the per-atom layer.
// So `canWriteAtomPath` resolves to `canReadAtom` for an existing
// row, and to folder-cascade-only for creation.

describe('P1 — write path', () => {
  it('upsert OVERWRITE: teammate cannot clobber a private atom', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/notes.md',
      body: 'original content',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/notes.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Bob tries to overwrite the same path → reject.
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
        activeWorkspaceId: orgId,
        path: 'alice/notes.md',
        body: 'tampered content',
      }),
    ).rejects.toThrow(/access to write/)

    // Alice's original content is intact.
    const after = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/notes.md'),
        )
        .unique(),
    )
    expect(after?.body).toContain('original content')
    expect(after?.body).not.toContain('tampered')
  })

  it('upsert CREATE: teammate cannot plant in a private folder', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    // Alice marks the `alice` folder private (her ONLY).
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: orgId,
      folderPath: 'alice',
      mode: 'private',
    })

    // Bob tries to CREATE a new doc inside `alice/` — folder cascade
    // blocks (no existing atom to canReadAtom, so the creation
    // branch of canWriteAtomPath runs the folder walk).
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
        activeWorkspaceId: orgId,
        path: 'alice/planted.md',
        body: 'hi I am here',
      }),
    ).rejects.toThrow(/access to write/)

    // Bob CAN create elsewhere (no folder rule on the workspace root).
    await t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'bob/own.md',
      body: "bob's own doc",
    })
    const bobOwn = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'bob/own.md'),
        )
        .unique(),
    )
    expect(bobOwn).not.toBeNull()
  })

  it('remove: teammate cannot delete a private atom', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/private.md',
      body: 'still here',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/private.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.atoms.remove, {
        activeWorkspaceId: orgId,
        path: 'alice/private.md',
      }),
    ).rejects.toThrow(/access to delete/)

    // The atom is still there.
    const after = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/private.md'),
        )
        .unique(),
    )
    expect(after).not.toBeNull()
  })

  it('move: teammate cannot move a private atom OR move INTO a private folder', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    // Setup: a public source doc Bob CAN read, and a private
    // destination folder owned by Alice.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'public/movable.md',
      body: 'm',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: orgId,
      folderPath: 'alice',
      mode: 'private',
    })

    // Bob can read the source but the DESTINATION folder is private.
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.atoms.move, {
        activeWorkspaceId: orgId,
        fromPath: 'public/movable.md',
        toPath: 'alice/movable.md',
      }),
    ).rejects.toThrow(/access to move into this destination/)

    // Setup #2: Bob CAN move within his own area.
    await t.withIdentity({ subject: BOB }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'bob/old.md',
      body: 'b',
    })
    const moved = await t
      .withIdentity({ subject: BOB })
      .mutation(api.atoms.move, {
        activeWorkspaceId: orgId,
        fromPath: 'bob/old.md',
        toPath: 'bob/new.md',
      })
    expect(moved.ok).toBe(true)

    // Setup #3: a private SOURCE — Bob can't move Alice's private doc.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alicepriv/secret.md',
      body: 's',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alicepriv/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.atoms.move, {
        activeWorkspaceId: orgId,
        fromPath: 'alicepriv/secret.md',
        toPath: 'bob/stolen.md',
      }),
    ).rejects.toThrow(/access to move this atom/)
  })

  it('owner CAN write their own private atom (Notion-full self-permission)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'v1',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Alice writes again — should succeed.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'v2',
    })
    const after = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/secret.md'),
        )
        .unique(),
    )
    expect(after?.body).toContain('v2')
  })
})
