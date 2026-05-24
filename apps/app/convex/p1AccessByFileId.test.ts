/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_p1abi'
const BOB = 'ws_bob_p1abi'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// P1 — fileId-keyed UI wrappers (getAtomAccessByFileId +
// setAtomAccessByFileId). The Share dialog has a fileId in hand,
// not the Convex row id; these spare it a two-step.

async function fileIdOf(t: ReturnType<typeof convexTest>, orgId: string, path: string) {
  // Use .collect() (no withIndex) — convex-test's typed db on the
  // ad-hoc t.run ctx doesn't surface user-table indexes the same way
  // the in-app QueryCtx does. Collecting + filtering is fine for a
  // test fixture (small dataset).
  const idRows = await t.run(async (ctx) => ctx.db.query('atomIds').collect())
  const bound = idRows.find(
    (r: { workspaceId: string; path: string | null }) =>
      r.workspaceId === orgId && r.path === path,
  )
  if (!bound) throw new Error(`no atomIds binding for ${path}`)
  return (bound as { fileId: string }).fileId
}

describe('P1 — getAtomAccessByFileId', () => {
  it('owner-default atom returns mode=org-default', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'team/n.md',
      body: 'n',
    })
    const fid = await fileIdOf(t, orgId, 'team/n.md')
    const got = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomAccess.getAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
      })
    expect(got).toEqual({
      mode: 'org-default',
      ownerUserId: null,
      allowedUserIds: [],
    })
  })

  it('private atom: owner sees mode=private; teammate sees null (gated)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/s.md',
      body: 's',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/s.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    const fid = await fileIdOf(t, orgId, 'alice/s.md')

    const alice = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomAccess.getAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
      })
    expect(alice?.mode).toBe('private')
    expect(alice?.ownerUserId).toBe(ALICE)

    const bob = await t
      .withIdentity({ subject: BOB })
      .query(api.atomAccess.getAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
      })
    // Bob can't see the atom, so he can't see its access record
    // either (the dialog would hide the access section for him —
    // correct UX: you can't manage what you can't see).
    expect(bob).toBeNull()
  })

  it('missing fileId returns null (never throws)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const got = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomAccess.getAtomAccessByFileId, {
        fileId: 'never.existed',
        activeWorkspaceId: orgId,
      })
    expect(got).toBeNull()
  })
})

describe('P1 — setAtomAccessByFileId', () => {
  it('makes an org-default atom private', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'team/n.md',
      body: 'n',
    })
    const fid = await fileIdOf(t, orgId, 'team/n.md')
    const res = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomAccess.setAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
        mode: 'private',
      })
    expect(res.ok).toBe(true)
    // Subsequent read confirms.
    const got = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomAccess.getAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
      })
    expect(got?.mode).toBe('private')
  })

  it('clears to org-default via mode:null', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'team/n.md',
      body: 'n',
    })
    const fid = await fileIdOf(t, orgId, 'team/n.md')
    // Set then clear.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccessByFileId, {
      fileId: fid,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    const res = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.atomAccess.setAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
        mode: null,
      })
    expect(res).toMatchObject({ ok: true, cleared: true })
    const got = await t
      .withIdentity({ subject: ALICE })
      .query(api.atomAccess.getAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
      })
    expect(got?.mode).toBe('org-default')
  })

  it("non-owner cannot change an existing access record", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'alice/x.md',
      body: 'x',
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'alice/x.md'),
        )
        .unique(),
    )
    // Alice locks it private.
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    const fid = await fileIdOf(t, orgId, 'alice/x.md')
    // Bob tries to hijack. The setAtomAccess "only owner can change"
    // rule fires (note: Bob can't even see the row via the getter,
    // but a malicious client could call the setter directly).
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.atomAccess.setAtomAccessByFileId, {
        fileId: fid,
        activeWorkspaceId: orgId,
        mode: null, // try to "un-private" Alice's atom
      }),
    ).rejects.toThrow(/current access owner/)
  })

  it('throws on missing fileId', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    await expect(
      t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccessByFileId, {
        fileId: 'no.such.file',
        activeWorkspaceId: orgId,
        mode: 'private',
      }),
    ).rejects.toThrow(/not found/)
  })
})
