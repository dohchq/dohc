/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1a'
const BOB = 'ws_bob_p1a'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 (multiplayer-and-h-followups §6.5) — adjacent surfaces:
//   • atoms.idAdvisory — leaks atom EXISTENCE + fileId for a path
//     the viewer can't read. Collapse to the missing-shape.
//   • folders.create / _createInternal — must obey folder cascade
//     so a teammate can't mkdir inside your private folder.

describe('P1 — atoms.idAdvisory (existence-oracle plug)', () => {
  it("teammate gets `kind:null` for a private atom (identical to missing)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'p',
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

    // Bob asking about the same path gets the SAME shape as a
    // non-existent path: { kind: null, fileId: null, wanted: null }.
    const bob = await t
      .withIdentity({ subject: BOB })
      .query(api.atoms.idAdvisory, {
        activeWorkspaceId: orgId,
        path: 'alice/secret.md',
      })
    expect(bob).toEqual({ kind: null, fileId: null, wanted: null })

    // A path that genuinely doesn't exist returns the same shape —
    // proves Bob can't distinguish "exists but private" from "absent".
    const bobMissing = await t
      .withIdentity({ subject: BOB })
      .query(api.atoms.idAdvisory, {
        activeWorkspaceId: orgId,
        path: 'alice/never-existed.md',
      })
    expect(bobMissing).toEqual(bob)
  })

  it('owner still gets the real advisory (no false hiding for the actor)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/secret.md',
      body: 'p',
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
    const alice = await t
      .withIdentity({ subject: ALICE })
      .query(api.atoms.idAdvisory, {
        activeWorkspaceId: orgId,
        path: 'alice/secret.md',
      })
    // Alice gets back the actual fileId — not the missing shape.
    expect(alice.fileId).not.toBeNull()
  })
})

describe('P1 — folders.create + _createInternal cascade', () => {
  it("teammate cannot create a folder inside a private parent folder", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)

    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: orgId,
      folderPath: 'alice',
      mode: 'private',
    })

    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.folders.create, {
        activeWorkspaceId: orgId,
        path: 'alice/sub',
      }),
    ).rejects.toThrow(/access to create folders/)

    // Owner can.
    const id = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.folders.create, {
        activeWorkspaceId: orgId,
        path: 'alice/sub',
      })
    expect(id).toBeTruthy()
  })

  it("agent's _createInternal: viewerSubject=teammate blocked, system path unconditional", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: orgId,
      folderPath: 'alice',
      mode: 'private',
    })

    // Agent invocation as Bob — must reject.
    await expect(
      t.mutation(internal.folders._createInternal, {
        workspaceId: orgId,
        path: 'alice/sub',
        viewerSubject: BOB,
      }),
    ).rejects.toThrow(/access to create folders/)

    // System invocation (no viewerSubject) — unconditional, succeeds.
    const id = await t.mutation(internal.folders._createInternal, {
      workspaceId: orgId,
      path: 'alice/sub-system',
    })
    expect(id).toBeTruthy()
  })

  it("non-restricted folder: teammate CAN create freely", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    // No folderAccess row — org-default; Bob creates fine.
    const id = await t
      .withIdentity({ subject: BOB })
      .mutation(api.folders.create, {
        activeWorkspaceId: orgId,
        path: 'shared/team',
      })
    expect(id).toBeTruthy()
  })
})
