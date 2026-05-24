// M1 step 3 sub-commit 3.6.3 (multiplayer-and-h-followups §8 +
// codex 4th-pass key correction) — server-side integration point.
// onSnapshot fires → schedule _projectSnapshotToBody → that
// internalMutation pulls everything together:
//
//   1. Validate the snapshot version is fresh vs collabDocs.projectedVersion
//   2. Serialize PM JSON → markdown via collabProjectionSerializer
//      (3.6.2; preserves frontmatter; fail-loud on unknown nodes)
//   3. CAS + write via atomWriter.replaceAtomBodyForCollabProjection
//      (3.4; queries by atomId; finalBody hash; no projection trash)
//   4. On ok:true patch collabDocs + scheduleMapRegen
//   5. On ok:false (hash-mismatch / unknown-node / etc) freeze the
//      collab session via collabDocs.frozen=true
//
// CODEX 4TH-PASS KEY CORRECTION: pass the snapshotContent
// THROUGH the scheduled job (NOT call prosemirrorSync.getDoc).
// getDoc replays via getSteps which has a hard 100-delta cap that
// can return partial replay with only a warning. The snapshotContent
// we received in onSnapshot is the COMMITTED PM JSON at
// snapshotVersion — no replay needed.
//
// Conflict policy (3.6.3 placeholder): on any ok:false we
// just freeze. Sub-commit 3.7 implements the two-state policy
// (auto-rebuild via needsRebootstrap when PM has no unprojected
// edits; freeze + reload on true two-sided conflict).

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { internal } from './_generated/api'
import { parseDocId } from './prosemirror'
import {
  replaceAtomBodyForCollabProjection,
  sha256Hex,
} from './atomWriter'
import { serializeSnapshotToProjectedBody } from './collabProjectionSerializer'
import { scheduleMapRegen } from './loop'

// Debounce window between onSnapshot fire + actual projection.
// Coalesces bursts (multiple snapshots during active typing
// get reduced to one projection). 1500ms is the v3 default;
// tuneable.
const PROJECTION_DEBOUNCE_MS = 1500

/** Called by prosemirror.ts onSnapshot. Schedules a projection
 *  with cancel-on-newer semantics. Idempotent: if a projection
 *  for this docId is already queued for a NEWER (>=) version,
 *  this one no-ops. Exported (not internal*) because
 *  onSnapshot is itself a callback inside the syncApi config —
 *  the wrapper schedules from there. */
export async function schedulePostSnapshotProjection(
  ctx: {
    db: import('./_generated/server').MutationCtx['db']
    scheduler: import('./_generated/server').MutationCtx['scheduler']
  },
  docId: string,
  snapshotVersion: number,
  snapshotContent: string,
): Promise<void> {
  const parsed = parseDocId(docId)
  if (parsed.kind !== 'atom') return // share: docs handled later (M2+)

  // Read the collabDocs row. Two skip cases:
  //   - No row exists yet → first ever snapshot before bootstrap
  //     completed (or bootstrap is failing). Don't schedule;
  //     bootstrap will create the row with the initial snapshot.
  //   - Row exists but projectedVersion >= snapshotVersion: a
  //     later run already projected past this version.
  const doc = await ctx.db
    .query('collabDocs')
    .withIndex('by_docId', (q) => q.eq('docId', docId))
    .unique()
  if (!doc) return
  if (doc.projectedVersion >= snapshotVersion) return
  if (doc.frozen) return // conflict-frozen; client must reload

  // Cancel-on-newer: if a stale scheduled job is queued, cancel
  // it before re-scheduling. Two writes is cheaper than letting
  // both fire (the second would early-return via the version
  // check, but burns scheduler slots).
  //
  // Codex 5th-pass concern #5: cancel can fail because the job
  // already started. The running handler will later patch
  // scheduledJobId:undefined when it finishes. If we patch the
  // NEWER jobId here in between, the older handler's clear
  // would wipe our newer tracking. The atomic fix: capture the
  // pre-existing jobId, then patch ONLY if scheduledJobId still
  // equals it. The handler does the same check (patches only
  // if its own jobId is the current one).
  const previousJobId = doc.scheduledJobId

  if (previousJobId) {
    try {
      await ctx.scheduler.cancel(previousJobId)
    } catch {
      // Cancel can fail if the job already ran/completed — fine.
    }
  }

  const jobId = await ctx.scheduler.runAfter(
    PROJECTION_DEBOUNCE_MS,
    internal.collabProjection._projectSnapshotToBody,
    { docId, snapshotVersion, snapshotContent },
  )
  // Re-read the row to check ownership before patching: if a
  // CONCURRENT scheduler scheduled a newer job (and patched its
  // own id), we should NOT clobber that with our older job's id.
  // Convex mutations are transactional, so this re-read sees the
  // committed state at the start of OUR transaction; in practice
  // this serializes ordering, but the explicit check documents
  // the invariant + survives a hypothetical future change to
  // mutation isolation semantics.
  const fresh = await ctx.db.get(doc._id)
  if (fresh && fresh.scheduledJobId === previousJobId) {
    await ctx.db.patch(doc._id, {
      scheduledJobId: jobId,
      updatedAt: Date.now(),
    })
  }
}

export const _projectSnapshotToBody = internalMutation({
  args: {
    docId: v.string(),
    snapshotVersion: v.number(),
    snapshotContent: v.string(),
  },
  handler: async (ctx, { docId, snapshotVersion, snapshotContent }) => {
    const parsed = parseDocId(docId)
    if (parsed.kind !== 'atom') return { skipped: 'non-atom-doc' as const }

    const doc = await ctx.db
      .query('collabDocs')
      .withIndex('by_docId', (q) => q.eq('docId', docId))
      .unique()
    if (!doc) return { skipped: 'no-collab-doc' as const }
    if (doc.projectedVersion >= snapshotVersion) {
      return { skipped: 'already-projected' as const }
    }
    if (doc.frozen) return { skipped: 'frozen' as const }
    if (doc.needsRebootstrap) return { skipped: 'needs-rebootstrap' as const }

    // Codex 5th-pass concern #5: capture the scheduledJobId we
    // observed at the start of this handler. When we patch
    // scheduledJobId:undefined below (clearing the schedule
    // marker), we ONLY do it if the row still carries the same
    // id we saw. If a newer schedule took ownership during our
    // handler, leaving its id intact prevents this older
    // handler from wiping out the newer schedule's tracking.
    const ownedJobId = doc.scheduledJobId

    // Tiny helper: clear scheduledJobId only if we OWN it. Caller
    // computes the rest of the patch + we merge with the
    // ownership-conditional clear.
    const buildClearPatch = async (): Promise<{ scheduledJobId?: undefined }> => {
      const fresh = await ctx.db.get(doc._id)
      // Only clear if the row still carries our jobId; otherwise
      // a newer schedule owns this slot — leave it alone.
      if (fresh && fresh.scheduledJobId === ownedJobId) {
        return { scheduledJobId: undefined }
      }
      return {}
    }

    const atom = await ctx.db.get(parsed.atomId)
    if (!atom) {
      // Atom deleted while collab session was active. Mark frozen
      // for now; sub-commit 3.7 will route through the
      // gentler auto-rebuild path if appropriate (here it's not —
      // there's no atom to rebuild from).
      await ctx.db.patch(doc._id, {
        frozen: true,
        lastConflictAt: Date.now(),
        ...(await buildClearPatch()),
        updatedAt: Date.now(),
      })
      return { skipped: 'atom-deleted' as const, frozen: true }
    }

    // Serialize PM JSON → markdown body (preserves frontmatter
    // from atom.body — codex 4th-pass concern #1). Fail-loud on
    // unknown PM nodes (codex 4th-pass concern #2).
    const ser = serializeSnapshotToProjectedBody(snapshotContent, atom.body)
    if (!ser.ok) {
      // Freeze — 3.7 will add a more sophisticated policy. For
      // now: any serialize failure is a freeze; user reloads.
      await ctx.db.patch(doc._id, {
        frozen: true,
        lastConflictAt: Date.now(),
        ...(await buildClearPatch()),
        updatedAt: Date.now(),
      })
      return {
        skipped: 'serialize-failed' as const,
        reason: ser.reason,
        detail: ser.detail,
        frozen: true,
      }
    }

    // If the serialized markdown matches the current body byte-for-
    // byte, nothing to write — just advance projectedVersion (so
    // we don't re-fire on the same snapshot). Common case for
    // idempotency under bursty typing.
    if (ser.newBody === atom.body) {
      await ctx.db.patch(doc._id, {
        projectedVersion: snapshotVersion,
        ...(await buildClearPatch()),
        updatedAt: Date.now(),
      })
      return { skipped: 'no-change' as const }
    }

    // Route through the shared body writer. atomWriter does the
    // FULL upsertAtomImpl side-effect chain (Codex v3 critical
    // #1+#2 absorbed) + the CAS re-check internally.
    const result = await replaceAtomBodyForCollabProjection(ctx, {
      atomId: parsed.atomId,
      expectedWorkspaceId: parsed.workspaceId,
      expectedCurrentBodyHash: doc.baseBodyHash,
      newBody: ser.newBody,
    })

    if (!result.ok) {
      // hash-mismatch / atom-not-found / workspace-mismatch.
      // Freeze for now; 3.7 splits hash-mismatch into auto-rebuild
      // vs freeze based on whether PM has unprojected edits.
      await ctx.db.patch(doc._id, {
        frozen: true,
        lastConflictAt: Date.now(),
        ...(await buildClearPatch()),
        updatedAt: Date.now(),
      })
      return {
        skipped: 'write-failed' as const,
        reason: result.reason,
        frozen: true,
      }
    }

    // SUCCESS — patch collabDocs to record the new baseline.
    await ctx.db.patch(doc._id, {
      baseBodyHash: result.newBaseBodyHash,
      lastProjectedHash: result.newBaseBodyHash,
      projectedVersion: snapshotVersion,
      ...(await buildClearPatch()),
      updatedAt: Date.now(),
    })

    // Map regen — mirrors atoms.upsert / atoms.remove pattern
    // (lives OUTSIDE upsertAtomImpl + atomWriter).
    await scheduleMapRegen(ctx, parsed.workspaceId)

    return { ok: true as const, snapshotVersion }
  },
})

// Re-export so prosemirror.ts onSnapshot can call this helper
// without a circular dep. Just a marker — implementation lives
// above.
export { sha256Hex }
