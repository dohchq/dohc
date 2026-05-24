/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import { register as registerProsemirrorComponent } from '@convex-dev/prosemirror-sync/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sha256Hex } from './atomWriter'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_m1cr'

// M1 step 3.7 — two-state conflict resolver. Replaces 3.6.3's
// "always freeze" placeholder with a three-way decision based on
// the relationship between three hashes. See collabProjection.ts
// for the full reasoning + math.
//
// Three cases:
//   A. FREEZE       — both sides moved; real conflict
//   B. AUTO-REBUILD — PM unchanged since baseline; OOB write is
//                     the new truth; signal client to rebootstrap
//   C. RE-BASELINE  — PM-derived output coincidentally matches
//                     current body; no real conflict
//
// CANONICAL-ROUNDTRIP NOTE: ser.newBody always ends in `\n`
// (remark-stringify behavior), but atoms.body from api.atoms.upsert
// may not. The FIRST projection after bootstrap therefore writes
// a cosmetically-changed body that becomes the canonical form;
// subsequent projections compare against that. Tests below do
// this initial canonicalizing projection where needed so the
// hashes line up the way real production lifecycle has them.

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
): Promise<{
  atomId: Id<'atoms'>
  finalBody: string
  docId: string
  baseHash: string
}> {
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
  return { atomId, finalBody, docId, baseHash }
}

function pmDocWithText(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
}

/** Read the canonical body after a projection (the form the
 *  serializer always produces; what subsequent compares should
 *  target). */
async function currentAtomBody(
  t: ReturnType<typeof convexTest>,
  atomId: Id<'atoms'>,
): Promise<string> {
  const atom = await t.run(async (ctx) => ctx.db.get(atomId))
  return atom!.body
}

describe('M1 step 3.7 — Case B: AUTO-REBUILD', () => {
  it('OOB write (frontmatter preserved) + PM unchanged ⇒ needsRebootstrap=true; NOT frozen', async () => {
    const t = convexTest(schema, modules)
    // M1 step 3.8.1.5 — case B now queries
    // components.prosemirrorSync.lib.latestVersion to defer when
    // the snapshot is stale. The query throws if the component
    // isn't registered. Registering with no snapshots yields
    // latestVersion=null → the gate skips → case B proceeds
    // normally (which is what this test wants to verify).
    registerProsemirrorComponent(t)
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomAndCollabDoc(
      t,
      orgId,
      't.md',
      'starting body',
    )

    // STEP 1: canonicalizing projection. PM matches what's in
    // atoms.body; first projection rewrites the body in canonical
    // form (trailing newline). baseBodyHash now = hash(canonical).
    const pmContent = pmDocWithText('starting body')
    await t.mutation(internal.collabProjection._projectSnapshotToBody, {
      docId,
      snapshotVersion: 2,
      snapshotContent: pmContent,
    })
    const canonicalBody = await currentAtomBody(t, atomId)
    const docsAfter1 = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docsAfter1[0]?.baseBodyHash).toBe(await sha256Hex(canonicalBody))

    // STEP 2: OOB write changes ONLY the rest, preserves frontmatter.
    // (Frontmatter is what splitFrontmatter would peel off canonicalBody.)
    const fmEnd = canonicalBody.indexOf('---\n', 4) + 4 // past closing ---\n
    const newRest = 'agent-rewrote\n'
    const oobBody = canonicalBody.slice(0, fmEnd) + newRest
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, { body: oobBody, updatedAt: Date.now() })
    })

    // STEP 3: project again with the SAME pmContent (PM unchanged).
    // newDerivedHash = hash(canonicalBody) (PM hasn't moved, fm
    // pulled from oobBody is the same as canonicalBody's fm)
    // currentBodyHash = hash(oobBody)
    // baseBodyHash = hash(canonicalBody)
    // newDerivedHash === baseBodyHash ⇒ AUTO-REBUILD.
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 5,
        snapshotContent: pmContent,
      },
    )
    expect(result).toMatchObject({ conflict: 'auto-rebuild' })

    // collabDocs: needsRebootstrap=true; NOT frozen; baseBodyHash
    // adopts the new oob body (so a subsequent projection after
    // rebootstrap doesn't re-trip on the same OOB write).
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.needsRebootstrap).toBe(true)
    expect(docs[0]?.frozen).toBe(false)
    expect(docs[0]?.lastConflictAt).toBeDefined()
    expect(docs[0]?.baseBodyHash).toBe(await sha256Hex(oobBody))

    // atoms.body untouched (OOB content survives)
    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(atom?.body).toBe(oobBody)
  })
})

describe('M1 step 3.7 — Case C: RE-BASELINE via no-change fast path', () => {
  it('OOB write produces exactly what PM would emit ⇒ no-change (label) + baseline updated', async () => {
    // The Case C scenario where ser.newBody === atom.body is
    // caught by the `no-change` early return BEFORE the explicit
    // conflict resolver fires. The behavior is the same as
    // Case C re-baseline: baseBodyHash updates; no freeze; no
    // rebootstrap signal. The 3.7 update extends the no-change
    // path to also patch baseBodyHash (was: just projectedVersion).
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, docId, baseHash } = await makeAtomAndCollabDoc(
      t,
      orgId,
      't.md',
      'v1',
    )

    // First canonicalizing projection so the body is in canonical
    // form (and baseBodyHash matches that form).
    await t.mutation(internal.collabProjection._projectSnapshotToBody, {
      docId,
      snapshotVersion: 2,
      snapshotContent: pmDocWithText('v1'),
    })
    const canonicalV1 = await currentAtomBody(t, atomId)
    const canonicalV1Hash = await sha256Hex(canonicalV1)

    // OOB write a body that is EXACTLY what PM would emit for
    // "v2-coincidence" (compute it via a dry-run serialize using
    // the public helper).
    const { serializeSnapshotToProjectedBody } = await import(
      './collabProjectionSerializer'
    )
    const dryRun = serializeSnapshotToProjectedBody(
      pmDocWithText('v2-coincidence'),
      canonicalV1,
    )
    expect(dryRun.ok).toBe(true)
    if (!dryRun.ok) return
    const pmDerivedBody = dryRun.newBody
    await t.run(async (ctx) => {
      await ctx.db.patch(atomId, {
        body: pmDerivedBody,
        updatedAt: Date.now(),
      })
    })
    expect(canonicalV1Hash).not.toBe(await sha256Hex(pmDerivedBody))

    // Project: ser.newBody (using NEW atom.body's fm, which is
    // unchanged from canonical) === atom.body (== pmDerivedBody).
    // The no-change fast path fires + re-baselines.
    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 5,
        snapshotContent: pmDocWithText('v2-coincidence'),
      },
    )
    expect(result).toMatchObject({ skipped: 'no-change' })

    // collabDocs: baseBodyHash updates to currentBodyHash;
    // projectedVersion advances; NOT frozen; NOT needsRebootstrap.
    // The 3.7 fix to no-change adds baseBodyHash + lastProjectedHash
    // updates to this path (was: only projectedVersion advanced).
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.baseBodyHash).toBe(await sha256Hex(pmDerivedBody))
    expect(docs[0]?.lastProjectedHash).toBe(await sha256Hex(pmDerivedBody))
    expect(docs[0]?.projectedVersion).toBe(5)
    expect(docs[0]?.frozen).toBe(false)
    expect(docs[0]?.needsRebootstrap).toBe(false)
    // baseHash from initial bootstrap is no longer the witness
    expect(docs[0]?.baseBodyHash).not.toBe(baseHash)
  })
})

describe('M1 step 3.7 — no-OOB-write path still works (regression)', () => {
  it('clean projection (no OOB) advances projectedVersion + writes body', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomAndCollabDoc(
      t,
      orgId,
      't.md',
      'v1 content',
    )

    const result = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: 5,
        snapshotContent: pmDocWithText('v2 collab content'),
      },
    )
    expect(result).toMatchObject({ ok: true, snapshotVersion: 5 })

    const atom = await t.run(async (ctx) => ctx.db.get(atomId))
    expect(atom?.body).toContain('v2 collab content')
    expect(atom?.body).not.toContain('v1 content')

    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.frozen).toBe(false)
    expect(docs[0]?.needsRebootstrap).toBe(false)
    expect(docs[0]?.projectedVersion).toBe(5)
  })
})

describe('M1 step 3.7 — projection writer no longer trips on canonical drift', () => {
  it('two back-to-back projections produce no spurious conflict (3.7 no-change baseline fix)', async () => {
    // The 3.7 no-change path also updates baseBodyHash now. This
    // prevents a previously-latent bug where the FIRST projection
    // canonicalized the body, but baseBodyHash wasn't updated on
    // a same-PM second projection. The second would see
    // baseBodyHash != currentBodyHash and falsely route through
    // the conflict resolver.
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    const { atomId, docId } = await makeAtomAndCollabDoc(
      t,
      orgId,
      't.md',
      'v1',
    )
    const pmContent = pmDocWithText('v1')

    // First projection: canonicalizes
    const r1 = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 2, snapshotContent: pmContent },
    )
    expect(r1).toMatchObject({ ok: true })

    // Second projection with same PM: should be no-change
    const r2 = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 3, snapshotContent: pmContent },
    )
    expect(r2).toMatchObject({ skipped: 'no-change' })

    // Third projection with same PM: still no-change (baseBodyHash
    // updated by step 2, so no false conflict)
    const r3 = await t.mutation(
      internal.collabProjection._projectSnapshotToBody,
      { docId, snapshotVersion: 4, snapshotContent: pmContent },
    )
    expect(r3).toMatchObject({ skipped: 'no-change' })

    // No freezes, no rebootstrap signals
    const docs = await t.run(async (ctx) =>
      ctx.db.query('collabDocs').collect(),
    )
    expect(docs[0]?.frozen).toBe(false)
    expect(docs[0]?.needsRebootstrap).toBe(false)
    expect(docs[0]?.projectedVersion).toBe(4)
  })
})
