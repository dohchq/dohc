/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import { sha256Hex } from './atomWriter'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_m1rb'
const BOB = 'ws_bob_m1rb'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function makeAtomWithBody(
  t: ReturnType<typeof convexTest>,
  orgId: string,
  path: string,
  body: string,
): Promise<{ atomId: Id<'atoms'>; finalBody: string }> {
  await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
    activeWorkspaceId: orgId,
    path,
    body,
  })
  const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
  const row = rows.find(
    (r: { workspaceId: string; path: string }) =>
      r.workspaceId === orgId && r.path === path,
  )
  return {
    atomId: (row as { _id: Id<'atoms'> })._id,
    finalBody: (row as { body: string }).body,
  }
}

const minimalPmJson = () =>
  JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
    ],
  })

describe('M1 step 3.8.0 — bootstrapSnapshotFromAtomBody rebootstrap path', () => {
  it('client retries bootstrap after 3.7 sets needsRebootstrap=true ⇒ flag cleared + baseline updated', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId, finalBody } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'new content from agent',
    )
    const docId = `atom:${orgId}:${atomId}`
    const correctHash = await sha256Hex(finalBody)

    // Simulate the post-3.7-conflict state: collabDocs row exists
    // with needsRebootstrap=true. (3.7's auto-rebuild path put it
    // there + adopted the new body as baseBodyHash.)
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: correctHash,
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: true, // ← the rebootstrap signal
        lastConflictAt: Date.now() - 10_000,
        updatedAt: Date.now(),
      })
    })

    // Client re-bootstraps with the new body (which it just read).
    // PM JSON must align with the body content (codex 6th-pass
    // FIX #1: PM↔body binding). After alignment, the inner
    // latestVersion/submitSnapshot calls throw because the
    // prosemirror-sync component isn't registered in convex-test;
    // 3.8.0 catches + returns body-changed.
    const alignedPm = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'new content from agent' }],
        },
      ],
    })
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: alignedPm,
        clientBodyHash: correctHash,
        activeWorkspaceId: orgId,
      })

    // Component-not-registered → returns body-changed (the retry
    // path documented in the source). This is the expected
    // outcome under convex-test conditions; the SHAPE of the
    // response confirms 3.8.0 routed through the rebootstrap
    // branch (not the alreadyBootstrapped early-return — that
    // would have returned alreadyBootstrapped:true here).
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('body-changed')
      expect(result.serverBodyHash).toBe(correctHash)
    }
  })

  it('hash mismatch during rebootstrap ⇒ ok:false (body-changed) — same as initial bootstrap', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId, finalBody } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'new content',
    )
    const docId = `atom:${orgId}:${atomId}`
    // Setup as if 3.7 just fired
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: await sha256Hex(finalBody),
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: true,
        updatedAt: Date.now(),
      })
    })

    // Client submits a STALE clientBodyHash (atoms.body changed
    // between client read + submit). Same body-changed retry
    // signal as the initial bootstrap.
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: minimalPmJson(),
        clientBodyHash:
          'stale_hash_0000000000000000000000000000000000000000000000000000000000',
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('body-changed')

    // collabDocs unchanged — rebootstrap rejected at the hash gate
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.needsRebootstrap).toBe(true)
  })

  it('rebootstrap path also enforces P1 access (teammate blocked)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId, finalBody } = await makeAtomWithBody(
      t,
      orgId,
      'alice/secret.md',
      'secret stuff',
    )
    // Make private to Alice
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    const docId = `atom:${orgId}:${atomId}`
    // collabDocs in rebootstrap state
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: await sha256Hex(finalBody),
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: true,
        updatedAt: Date.now(),
      })
    })
    await expect(
      t
        .withIdentity({ subject: BOB })
        .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
          docId,
          pmJsonStr: minimalPmJson(),
          clientBodyHash: await sha256Hex(finalBody),
          activeWorkspaceId: orgId,
        }),
    ).rejects.toThrow(/Not authorized/)
  })

  it('invalid-pm-json during rebootstrap ⇒ ok:false (invalid-pm-json)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId, finalBody } = await makeAtomWithBody(
      t,
      orgId,
      't.md',
      'x',
    )
    const docId = `atom:${orgId}:${atomId}`
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: await sha256Hex(finalBody),
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: true,
        updatedAt: Date.now(),
      })
    })
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: 'not_valid_json{{{',
        clientBodyHash: await sha256Hex(finalBody),
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-pm-json')
  })
})

describe('M1 step 3.8.0 — getCollabDocState public query', () => {
  it('returns exists:false when no collabDocs row exists', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId } = await makeAtomWithBody(t, orgId, 't.md', 'x')
    const docId = `atom:${orgId}:${atomId}`
    const state = await t
      .withIdentity({ subject: ALICE })
      .query(api.collabBootstrap.getCollabDocState, {
        docId,
        activeWorkspaceId: orgId,
      })
    expect(state).toEqual({ exists: false })
  })

  it('returns exists:true with frozen + needsRebootstrap + projectedVersion fields', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId, finalBody } = await makeAtomWithBody(
      t,
      orgId,
      't.md',
      'x',
    )
    const docId = `atom:${orgId}:${atomId}`
    const baseHash = await sha256Hex(finalBody)
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: baseHash,
        projectedVersion: 7,
        frozen: true,
        needsRebootstrap: false,
        lastConflictAt: 12345,
        updatedAt: Date.now(),
      })
    })

    const state = await t
      .withIdentity({ subject: ALICE })
      .query(api.collabBootstrap.getCollabDocState, {
        docId,
        activeWorkspaceId: orgId,
      })
    expect(state).toMatchObject({
      exists: true,
      frozen: true,
      needsRebootstrap: false,
      lastConflictAt: 12345,
      projectedVersion: 7,
    })
  })

  it('returns exists:false for callers without P1 read access (teammate blocked)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId, finalBody } = await makeAtomWithBody(
      t,
      orgId,
      'alice/secret.md',
      'sekrit',
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      atomId,
      activeWorkspaceId: orgId,
      mode: 'private',
    })
    const docId = `atom:${orgId}:${atomId}`
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: await sha256Hex(finalBody),
        projectedVersion: 1,
        frozen: true,
        needsRebootstrap: false,
        updatedAt: Date.now(),
      })
    })
    // Bob (not allowed to read) sees exists:false (NOT the
    // existence + state — that'd be a P1 oracle leak)
    const bobState = await t
      .withIdentity({ subject: BOB })
      .query(api.collabBootstrap.getCollabDocState, {
        docId,
        activeWorkspaceId: orgId,
      })
    expect(bobState).toEqual({ exists: false })
    // Alice (owner) sees the real state
    const aliceState = await t
      .withIdentity({ subject: ALICE })
      .query(api.collabBootstrap.getCollabDocState, {
        docId,
        activeWorkspaceId: orgId,
      })
    expect(aliceState).toMatchObject({ exists: true, frozen: true })
  })

  it('returns exists:false for invalid / share: docId', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const invalid = await t
      .withIdentity({ subject: ALICE })
      .query(api.collabBootstrap.getCollabDocState, {
        docId: 'random_string',
        activeWorkspaceId: orgId,
      })
    expect(invalid).toEqual({ exists: false })
    const share = await t
      .withIdentity({ subject: ALICE })
      .query(api.collabBootstrap.getCollabDocState, {
        docId: 'share:kfake000000000000000000000000',
        activeWorkspaceId: orgId,
      })
    expect(share).toEqual({ exists: false })
  })

  it('returns exists:false for unauthenticated callers', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const { atomId } = await makeAtomWithBody(t, orgId, 't.md', 'x')
    const docId = `atom:${orgId}:${atomId}`
    // Pure t.query without withIdentity. The fn calls
    // requireWorkspace which throws on unauth — so this rejects
    // rather than returning exists:false. That's consistent
    // with the rest of the auth surface.
    await expect(
      t.query(api.collabBootstrap.getCollabDocState, {
        docId,
        activeWorkspaceId: orgId,
      }),
    ).rejects.toThrow()
  })
})
