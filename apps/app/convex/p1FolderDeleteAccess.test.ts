/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1fd'
const BOB = 'ws_bob_p1fd'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 (multiplayer-and-h-followups §6.5) — recursive folder delete
// is the worst-case partial-delete surface. A teammate calling
// folders.remove on a folder containing a private atom must NOT
// be able to erase that atom along with the rest; the all-or-
// nothing posture (same as the existing lock pre-scan) refuses
// the whole op with a clear error.

describe('P1 — folders.remove subtree access gate', () => {
  it("teammate cannot delete a folder containing a teammate's private atom", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    // The folder is org-default (anyone can see + delete in
    // principle), but contains a private atom owned by Alice.
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'shared/public-note.md',
      body: 'p',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'shared/alice-secret.md',
      body: 's',
    })
    const secret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'shared/alice-secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: secret!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Bob tries to delete the whole `shared` folder.
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.folders.remove, {
        activeWorkspaceId: orgId,
        path: 'shared',
      }),
    ).rejects.toThrow(/access to delete this folder/)

    // BOTH atoms are still there — proves the refuse-whole posture
    // (a partial-delete that took public-note.md would be the wrong
    // fail mode and is forbidden).
    const stillPublic = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'shared/public-note.md'),
        )
        .unique(),
    )
    const stillSecret = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'shared/alice-secret.md'),
        )
        .unique(),
    )
    expect(stillPublic).not.toBeNull()
    expect(stillSecret).not.toBeNull()
  })

  it('owner CAN delete their own folder + its private atoms', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/a.md',
      body: 'a',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/b.md',
      body: 'b',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/b.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })

    // Alice deletes the folder — she owns the private atom, so the
    // pre-scan passes for her.
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.folders.remove, {
        activeWorkspaceId: orgId,
        path: 'alice',
      })
    const gone = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/a.md'),
        )
        .unique(),
    )
    expect(gone).toBeNull()
  })

  it("_removeInternal: viewerSubject=teammate blocked, system path unconditional", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'mix/secret.md',
      body: 's',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'mix/secret.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    // Agent caller as Bob — reject.
    await expect(
      t.mutation(internal.folders._removeInternal, {
        workspaceId: orgId,
        path: 'mix',
        viewerSubject: BOB,
      }),
    ).rejects.toThrow(/access to delete this folder/)
    // System caller (no subject) — unconditional, succeeds.
    const result = await t.mutation(internal.folders._removeInternal, {
      workspaceId: orgId,
      path: 'mix',
    })
    expect(result).toBeTruthy()
  })

  it('non-restricted folder: teammate deletes freely (no access rows)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'common/x.md',
      body: 'x',
    })
    const common = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'common/x.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: common!._id,
      activeWorkspaceId: orgId,
      mode: null,
    })
    // Bob deletes — passes (no atomAccess / folderAccess in subtree).
    const result = await t
      .withIdentity({ subject: BOB })
      .mutation(api.folders.remove, {
        activeWorkspaceId: orgId,
        path: 'common',
      })
    expect(result).toBeTruthy()
  })
})
