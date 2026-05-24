/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sha256Hex } from './atomWriter'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_m1cp3'

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  return orgId
}

async function makeAtomAndCollabDoc(
  t: ReturnType<typeof convexTest>,
  orgId: string,
  path: string,
  body: string,
): Promise<{ atomId: Id<'atoms'>; finalBody: string; docId: string }> {
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
  const atomId = (row as { _id: Id<'atoms'> })._id
  const finalBody = (row as { body: string }).body
  const docId = `atom:${orgId}:${atomId}`

  // Pre-create collabDocs row (simulates a successful bootstrap)
  const baseHash = await sha256Hex(finalBody)
  await t.run(async (ctx) => {
    await ctx.db.insert('collabDocs', {
      docId,
      atomId,
      workspaceId: orgId,
      baseBodyHash: baseHash,
      projectedVersion: 1,
      frozen: false,
      needsRebootstrap: false,
      updatedAt: Date.now(),
    })
  })
  return { atomId, finalBody, docId }
}

// Helper: build a PM doc JSON string with the given top-level
// paragraph text content.
function pmDocWithText(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
}

// M1 step 3 sub-commit 3.6.3 — integration of:
//   - atomWriter (3.4) — the write helper
//   - serializer (3.6.2) — PM → markdown
//   - collabDocs (3.3) — projection state
// via the _projectSnapshotToBody internalMutation. End-to-end
// over the projection lifecycle.

describe('M1 step 3.6.3 — _projectSnapshotToBody happy path', () => {
  it('writes the projected body + advances collabDocs.projectedVersion', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomAndCollabDoc(
      t,
      orgId,
      'team/notes.md',
      'initial content',
    )
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 5,
        snapshotContent: pmDocWithText('new collab content'),
      },
    )
    expect(result).toMatchObject({ ok: true, snapshotVersion: 5 })

    // atoms.body was patched + source = 'collab'
    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(atom?.body).toContain('new collab content')
    expect(atom?.body).not.toContain('initial content')
    expect(atom?.source).toBe('collab')

    // collabDocs.projectedVersion advanced; baseBodyHash matches new body
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs.length).toBe(1)
    expect(docs[0]?.projectedVersion).toBe(5)
    expect(docs[0]?.baseBodyHash).toBe(await sha256Hex(atom!.body))
    expect(docs[0]?.lastProjectedHash).toBe(docs[0]?.baseBodyHash)
    expect(docs[0]?.frozen).toBe(false)
  })

  it('PRESERVES frontmatter from atoms.body (codex 4th-pass concern #1)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    // Atom with rich frontmatter that collab must preserve
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'team/rich.md',
      body: '---\nid: team.rich\ntitle: Team Plan\nicon: target\ntype: dashboard\n---\noriginal prose\n',
    })
    const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
    const row = rows.find(
      (r: { path: string; workspaceId: string }) =>
        r.path === 'team/rich.md' && r.workspaceId === orgId,
    )
    const atomId = (row as { _id: Id<'atoms'> })._id
    const finalBody = (row as { body: string }).body
    const docId = `atom:${orgId}:${atomId}`
    const baseHash = await sha256Hex(finalBody)

    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: baseHash,
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: false,
        updatedAt: Date.now(),
      })
    })

    await t.mutation(internal.collabProjection._projectSnapshotToBody, {
      docId,
      snapshotVersion: 2,
      snapshotContent: pmDocWithText('totally new prose'),
    })

    const after = await t.run(async (ctx) => ctx.db.get(atomId))
    // Every frontmatter key survives byte-identical
    expect(after?.body).toContain('id: team.rich')
    expect(after?.body).toContain('title: Team Plan')
    expect(after?.body).toContain('icon: target')
    expect(after?.body).toContain('type: dashboard')
    // The prose is updated
    expect(after?.body).toContain('totally new prose')
    expect(after?.body).not.toContain('original prose')
  })

  it('no-change snapshot ⇒ skipped:no-change (avoid redundant write)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    // Create the atom; capture its body
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'idempotent.md',
      // Whitespace-stable single line, so remark-stringify produces
      // identical output round-trip
      body: 'unchanged\n',
    })
    const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
    const row = rows.find(
      (r: { path: string; workspaceId: string }) =>
        r.path === 'idempotent.md' && r.workspaceId === orgId,
    )
    const atomId = (row as { _id: Id<'atoms'> })._id
    const docId = `atom:${orgId}:${atomId}`
    const baseHash = await sha256Hex((row as { body: string }).body)
    await t.run(async (ctx) => {
      await ctx.db.insert('collabDocs', {
        docId,
        atomId,
        workspaceId: orgId,
        baseBodyHash: baseHash,
        projectedVersion: 1,
        frozen: false,
        needsRebootstrap: false,
        updatedAt: Date.now(),
      })
    })

    // PM doc whose serialized output matches the current atom body
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 2,
        snapshotContent: pmDocWithText('unchanged'),
      },
    )
    expect(result).toMatchObject({ skipped: 'no-change' })

    // projectedVersion still advances (avoid re-fire on same snapshot)
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.projectedVersion).toBe(2)
  })
})

describe('M1 step 3.6.3 — skip paths', () => {
  it('no collabDocs row ⇒ skipped:no-collab-doc (bootstrap not done)', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await t.withIdentity({ subject: ALICE }).mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'team/n.md',
      body: 'x',
    })
    const rows = await t.run(async (ctx) => ctx.db.query('atoms').collect())
    const row = rows.find(
      (r: { path: string }) => r.path === 'team/n.md',
    )
    const atomId = (row as { _id: Id<'atoms'> })._id
    const docId = `atom:${orgId}:${atomId}`

    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 1, snapshotContent: pmDocWithText('x') },
    )
    expect(result).toMatchObject({ skipped: 'no-collab-doc' })
  })

  it('projectedVersion already at/past snapshotVersion ⇒ skipped:already-projected', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { docId } = await makeAtomAndCollabDoc(t, orgId, 't.md', 'x')
    // collabDocs starts at projectedVersion:1 in makeAtomAndCollabDoc
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 1, snapshotContent: pmDocWithText('y') },
    )
    expect(result).toMatchObject({ skipped: 'already-projected' })
  })

  it('frozen collab session ⇒ skipped:frozen', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { docId } = await makeAtomAndCollabDoc(t, orgId, 't.md', 'x')
    // Manually freeze
    await t.run(async (ctx) => {
      const doc = await ctx.db
        .query('collabDocs')
        .filter((q) => q.eq(q.field('docId'), docId))
        .unique()
      if (doc) await ctx.db.patch(doc._id, { frozen: true })
    })
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 5, snapshotContent: pmDocWithText('y') },
    )
    expect(result).toMatchObject({ skipped: 'frozen' })
  })

  it('non-atom docId (share:) ⇒ skipped:non-atom-doc', async () => {
    const t = convexTest(schema, modules)
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId: 'share:kfake000000000000000000000000',
        snapshotVersion: 1,
        snapshotContent: pmDocWithText('x'),
      },
    )
    expect(result).toMatchObject({ skipped: 'non-atom-doc' })
  })
})

describe('M1 step 3.6.3 — freeze paths (placeholder for sub-commit 3.7)', () => {
  it('unknown PM node in snapshot ⇒ freezes collab session + records lastConflictAt', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { docId } = await makeAtomAndCollabDoc(t, orgId, 't.md', 'x')
    const badPm = JSON.stringify({
      type: 'doc',
      content: [{ type: 'someUnknownCrepeFeature' }],
    })
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 5, snapshotContent: badPm },
    )
    expect(result).toMatchObject({
      skipped: 'serialize-failed',
      reason: 'unknown-pm-node',
      frozen: true,
    })

    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.frozen).toBe(true)
    expect(docs[0]?.lastConflictAt).toBeDefined()
    expect(docs[0]?.projectedVersion).toBe(1) // NOT advanced on failure
  })

  it('hash mismatch (OOB write) ⇒ freezes collab session', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomAndCollabDoc(
      t,
      orgId,
      't.md',
      'starting body',
    )

    // Simulate an OOB write: agent (or another tab) writes the
    // atom body directly, bypassing collab. collabDocs.baseBodyHash
    // is now stale.
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, {
        body: 'agent-injected content',
        updatedAt: Date.now(),
      })
    })

    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 5,
        snapshotContent: pmDocWithText('collab proposed content'),
      },
    )
    expect(result).toMatchObject({
      skipped: 'write-failed',
      reason: 'hash-mismatch',
      frozen: true,
    })

    // atoms.body was NOT overwritten by collab (agent's write survives)
    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(atom?.body).toContain('agent-injected content')
    expect(atom?.body).not.toContain('collab proposed content')

    // collabDocs frozen + lastConflictAt set
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.frozen).toBe(true)
    expect(docs[0]?.lastConflictAt).toBeDefined()
  })

  it('atom deleted while session active ⇒ freezes', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomAndCollabDoc(t, orgId, 't.md', 'x')
    // Manually delete the atom (simulate concurrent delete)
    await t.run(async (ctx) => {
      await ctx.db.delete(atomId)
    })
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 5, snapshotContent: pmDocWithText('y') },
    )
    expect(result).toMatchObject({
      skipped: 'atom-deleted',
      frozen: true,
    })
  })
})
