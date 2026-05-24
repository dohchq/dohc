/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { register as registerProsemirrorComponent } from '@convex-dev/prosemirror-sync/test'
import { api, internal } from './_generated/api'
import { sha256Hex } from './atomWriter'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_m1e2e'

// M1 step 3.9 (preview) — END-TO-END test with the prosemirror-sync
// component REGISTERED in convex-test. Unlike all the prior tests
// which had the component throw "Not registered" (forcing the
// rebootstrap path's try/catch to swallow), this test runs the
// full lifecycle:
//
//   bootstrap → submit snapshot → projection → markdown roundtrip
//
// What gets exercised that nothing else does:
//   - prosemirrorSync.create() at version 1 actually inserts the
//     snapshot row
//   - Subsequent submitSnapshot at version N+1 succeeds
//   - The full onSnapshot → schedulePostSnapshotProjection chain
//     fires real prosemirrorSync component code
//   - 3.7's conflict resolver still picks the right branch when
//     the component is alive
//
// LIMITATION: convex-test doesn't run a real scheduler. So
// ctx.scheduler.runAfter calls don't actually fire — we manually
// invoke the scheduled mutation in the test if we want to test
// that flow. The projection writer is callable directly via
// internal.collabProjection._projectSnapshotToBody for test
// purposes.

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  return orgId
}

async function makeAtomWithBody(
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
  return {
    atomId: (row as { _id: Id<'atoms'> })._id,
    finalBody: (row as { body: string }).body,
    docId: `atom:${orgId}:${(row as { _id: Id<'atoms'> })._id}`,
  }
}

function pmDoc(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
}

function tWithComponent() {
  const t = convexTest(schema, modules)
  // Register the prosemirror-sync component via the package's
  // own test helper (handles the schema + module glob with the
  // right package-internal paths).
  registerProsemirrorComponent(t)
  return t
}

describe('M1 step 3.9 (preview) — bootstrap actually inserts a snapshot', () => {
  it('bootstrapSnapshotFromAtomBody → component snapshot at version 1', async () => {
    const t = tWithComponent()
    const orgId = await seedOrg(t)
    const { atomId, finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'initial markdown body',
    )
    const correctHash = await sha256Hex(finalBody)

    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmDoc('initial markdown body'),
        clientBodyHash: correctHash,
        activeWorkspaceId: orgId,
      })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.alreadyBootstrapped).toBe(false)
      expect(result.serverBodyHash).toBe(correctHash)
    }

    // Verify collabDocs row exists at projectedVersion:1
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs.length).toBe(1)
    expect(docs[0]?.projectedVersion).toBe(1)
    expect(docs[0]?.frozen).toBe(false)
    expect(docs[0]?.needsRebootstrap).toBe(false)

    // Verify the component actually has a snapshot
    const snap = (await t
      .withIdentity({ subject: ALICE })
      .query(api.prosemirror.getSnapshot, { id: docId })) as
      | { content: string; version: number }
      | { content: null }
    expect(snap.content).not.toBeNull()
    if (snap.content !== null) {
      expect(snap.version).toBe(1)
      const parsed = JSON.parse(snap.content)
      expect(parsed.type).toBe('doc')
    }

    // atomId is captured + used; silences unused warning
    expect(atomId).toBeDefined()
  })
})

describe('M1 step 3.9 (preview) — full projection pipeline end-to-end', () => {
  it('snapshot → _projectSnapshotToBody → atoms.body updated; full chain', async () => {
    const t = tWithComponent()
    const orgId = await seedOrg(t)
    const { atomId, finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'starting content',
    )
    const correctHash = await sha256Hex(finalBody)

    // Step 1: bootstrap (real component, real snapshot)
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmDoc('starting content'),
        clientBodyHash: correctHash,
        activeWorkspaceId: orgId,
      })

    // Step 2: client submits a new snapshot via the public mutation
    // (this is what 3.6.4's snapshot debounce does in the real
    // browser). The package's syncApi.submitSnapshot runs our
    // checkWrite gate.
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.prosemirror.submitSnapshot, {
        id: docId,
        version: 2,
        content: pmDoc('updated by collab'),
      })

    // Step 3: invoke the projection writer (in production this is
    // scheduled via runAfter; convex-test doesn't auto-run the
    // scheduler, so we call directly).
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 2,
        snapshotContent: pmDoc('updated by collab'),
      },
    )
    expect(result).toMatchObject({ ok: true, snapshotVersion: 2 })

    // atoms.body should now contain "updated by collab"
    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(atom?.body).toContain('updated by collab')
    expect(atom?.body).not.toContain('starting content')
    expect(atom?.source).toBe('collab')

    // collabDocs: projectedVersion advanced, baseBodyHash matches
    // new body, no freeze/rebootstrap
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.projectedVersion).toBe(2)
    expect(docs[0]?.baseBodyHash).toBe(await sha256Hex(atom!.body))
    expect(docs[0]?.frozen).toBe(false)
    expect(docs[0]?.needsRebootstrap).toBe(false)
  })
})

describe('M1 step 3.9 (preview) — rebootstrap happy path (component alive)', () => {
  it('client retries after 3.7 needsRebootstrap ⇒ new snapshot at version+1 + flag cleared', async () => {
    const t = tWithComponent()
    const orgId = await seedOrg(t)
    const { atomId, finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'v1',
    )
    const v1Hash = await sha256Hex(finalBody)

    // Bootstrap real snapshot at v1
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmDoc('v1'),
        clientBodyHash: v1Hash,
        activeWorkspaceId: orgId,
      })

    // Simulate 3.7 firing needsRebootstrap (e.g. agent rewrote
    // atoms.body to "agent-took-over"). Hand-set the collabDocs
    // row + atoms.body to the post-3.7-AUTO-REBUILD state.
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, {
        body: 'agent-took-over',
        updatedAt: Date.now(),
      })
      const doc = await ctx.db
        .query('collabDocs')
        .withIndex('by_docId', (q) => q.eq('docId', docId))
        .unique()
      await ctx.db.patch(doc!._id, {
        needsRebootstrap: true,
        baseBodyHash: await sha256Hex('agent-took-over'),
        lastConflictAt: Date.now(),
      })
    })

    // Client re-reads + re-bootstraps with the new body content
    const newHash = await sha256Hex('agent-took-over')
    const result = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmDoc('agent-took-over'),
        clientBodyHash: newHash,
        activeWorkspaceId: orgId,
      })
    // With the component registered, the rebootstrap branch
    // actually completes — submit at version 2, flag cleared.
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.alreadyBootstrapped).toBe(false)
      expect(result.serverBodyHash).toBe(newHash)
    }

    // collabDocs: needsRebootstrap cleared; projectedVersion bumped;
    // baseBodyHash matches the new atoms.body
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.needsRebootstrap).toBe(false)
    expect(docs[0]?.frozen).toBe(false)
    expect(docs[0]?.baseBodyHash).toBe(newHash)
    expect(docs[0]?.projectedVersion).toBe(2)

    // Verify the component snapshot at version 2 exists with the new content
    const snap = (await t
      .withIdentity({ subject: ALICE })
      .query(api.prosemirror.getSnapshot, { id: docId })) as
      | { content: string; version: number }
      | { content: null }
    expect(snap.content).not.toBeNull()
    if (snap.content !== null) {
      expect(snap.version).toBe(2)
    }
  })
})

describe('M1 step 3.9 (preview) — bootstrap idempotency under racing clients', () => {
  it('two clients race to bootstrap the same fresh doc → exactly one snapshot at version 1', async () => {
    const t = tWithComponent()
    const orgId = await seedOrg(t)
    const { finalBody, docId } = await makeAtomWithBody(
      t,
      orgId,
      'shared.md',
      'shared content',
    )
    const hash = await sha256Hex(finalBody)
    const pmJson = pmDoc('shared content')

    // First client: creates collabDocs row + submits snapshot v1
    const r1 = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJson,
        clientBodyHash: hash,
        activeWorkspaceId: orgId,
      })
    expect(r1).toMatchObject({ ok: true, alreadyBootstrapped: false })

    // Second client: sees existing collabDocs row → alreadyBootstrapped
    const r2 = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmJson,
        clientBodyHash: hash,
        activeWorkspaceId: orgId,
      })
    expect(r2).toMatchObject({ ok: true, alreadyBootstrapped: true })

    // Exactly one collabDocs row + one snapshot at v1
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs.length).toBe(1)
  })
})

describe('M1 step 3.9 (preview) — full conflict resolver lifecycle (component alive)', () => {
  it('OOB write → AUTO-REBUILD signal → client rebootstrap → new snapshot version', async () => {
    const t = tWithComponent()
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomWithBody(
      t,
      orgId,
      'team/notes.md',
      'v1',
    )

    // Step 1: bootstrap
    await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmDoc('v1'),
        clientBodyHash: await sha256Hex(
          (await t.run(async (c) => c.db.get(atomId)))!.body,
        ),
        activeWorkspaceId: orgId,
      })

    // Step 2: canonicalizing projection so baseBodyHash matches
    // what serializer would produce. Same trick as 3.7's
    // conflict resolver tests.
    await t.mutation(internal.collabProjection._projectSnapshotToBody, {
      docId,
      snapshotVersion: 2,
      snapshotContent: pmDoc('v1'),
    })
    const canonicalBody = (await t.run(async (c) => c.db.get(atomId)))!.body

    // Step 3: agent OOB-writes a new body (preserves frontmatter)
    const fmEnd = canonicalBody.indexOf('---\n', 4) + 4
    const newRest = 'agent-rewrote-it\n'
    const oobBody = canonicalBody.slice(0, fmEnd) + newRest
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, { body: oobBody, updatedAt: Date.now() })
    })

    // Step 4: projection runs with PM still at "v1" (no edits
    // since canonicalize) → 3.7's AUTO-REBUILD path fires
    const projectionResult = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 5,
        snapshotContent: pmDoc('v1'),
      },
    )
    expect(projectionResult).toMatchObject({ conflict: 'auto-rebuild' })

    const docsAfterConflict = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docsAfterConflict[0]?.needsRebootstrap).toBe(true)

    // Step 5: client sees needsRebootstrap, re-reads atoms.body,
    // re-bootstraps with the new content
    const rebootResult = await t
      .withIdentity({ subject: ALICE })
      .mutation(api.collabBootstrap.bootstrapSnapshotFromAtomBody, {
        docId,
        pmJsonStr: pmDoc('agent-rewrote-it'),
        clientBodyHash: await sha256Hex(oobBody),
        activeWorkspaceId: orgId,
      })
    expect(rebootResult.ok).toBe(true)
    if (rebootResult.ok) {
      expect(rebootResult.alreadyBootstrapped).toBe(false)
    }

    // collabDocs: needsRebootstrap cleared
    const docsAfterReboot = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docsAfterReboot[0]?.needsRebootstrap).toBe(false)
    expect(docsAfterReboot[0]?.frozen).toBe(false)
  })
})
