// M1 step 3 sub-commit 3.4 (multiplayer-and-h-followups §8 +
// Codex v3 CRITICAL #1) — the shared body-replacement helper
// the collab projection writer calls. Built by reading
// apps/app/convex/atoms.ts:77-244 (upsertAtomImpl) and mirroring
// its body-change branch with three deliberate behavior shifts:
//
//   1. No user-content-overwrite refusal. The agent-vs-user guard
//      doesn't apply — collab IS the multi-user write.
//   2. NO projection trash (Codex v3 critical #2 part 2). The v3
//      doc proposed uncoalesced recordTrash per projection; Codex
//      pointed out that at ~1500ms projection cadence during
//      active typing, this reintroduces the autosave-flood. Drop
//      it entirely — collab recovery flows through prosemirror-
//      sync's snapshot+delta history, not atom trash. Non-collab
//      writes still trash via the existing upsertAtomImpl chain.
//   3. `source: 'collab'` (Codex's explicit recommendation). The
//      atom's source attribution updates to 'collab' on every
//      projection, signaling the most-recent edit origin.
//
// Codex v3 CRITICAL #1 absorbed:
//   - Query by atomId via ctx.db.get(atomId) — NOT a path lookup.
//     A path lookup would write the wrong atom after a rename
//     mid-session.
//   - CAS witness against finalBody (POST seedAtomIdIntoBody),
//     NOT the pre-seed body. Otherwise the stored baseBodyHash
//     desyncs immediately because seeding can mutate the body.
//   - Verify the atom row's workspaceId matches what the caller
//     expects (defense-in-depth; the caller derives workspaceId
//     from the docId).

import type { MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { applyAtomCapture } from './atomCapture'
import { reconcileAtomIdIndex, seedAtomIdIntoBody } from './atomId'
import { SystemLockError, UserLockError } from './atomLocks'
import { isSafeAtomPath } from './inlineAtom'
import { deriveSearchFields } from './searchText'

/** SHA-256 hex of a string. Used as the CAS witness for collab
 *  projection. Runs in Convex's V8 runtime via the Web Crypto
 *  SubtleCrypto API (supported in Convex actions + mutations).
 *
 *  Convex Note: ctx.runMutation runtime supports Web Crypto; this
 *  is safe to call from any mutation handler. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

export type CollabProjectionResult =
  | {
      ok: true
      finalBody: string
      newBaseBodyHash: string
      path: string
      workspaceId: string
    }
  | {
      ok: false
      reason: 'atom-not-found' | 'workspace-mismatch' | 'hash-mismatch'
    }

/** Write a new markdown body to an atom as a collab projection.
 *  Returns ok:false (NOT throws) on CAS/identity mismatches — the
 *  caller wants to surface a conflict, not crash. Throws on lock
 *  violations (those are policy decisions the caller must respect).
 *
 *  Caller responsibilities (handled in the projection writer,
 *  sub-commit 3.6):
 *    - schedule _map.md regen (mirrors atoms.upsert/remove pattern)
 *    - patch collabDocs.{baseBodyHash, projectedVersion} on success
 *    - on hash-mismatch, route through _handleCollabConflict */
export async function replaceAtomBodyForCollabProjection(
  ctx: MutationCtx,
  args: {
    /** Codex v3 critical #1: query by atomId, not by path. */
    atomId: Id<'atoms'>
    /** Defense-in-depth: caller derived this from the docId. */
    expectedWorkspaceId: string
    /** CAS witness — SHA-256 of atoms.body the caller observed
     *  at projection-start. Re-checked inside this mutation
     *  against the CURRENT body (catches the read-then-write
     *  race window). */
    expectedCurrentBodyHash: string
    /** The new markdown the collab session produced. Will pass
     *  through seedAtomIdIntoBody to derive the persisted form. */
    newBody: string
  },
): Promise<CollabProjectionResult> {
  // Resolve the atom by id, NOT by path. This is the line Codex
  // v3 critical #1 named — a path lookup would write the wrong
  // row after a rename mid-session.
  const existing = await ctx.db.get(args.atomId)
  if (!existing) {
    return { ok: false, reason: 'atom-not-found' }
  }

  // Defense-in-depth: the docId carries an authoritative
  // workspaceId; verify the actual row matches. If they ever
  // disagree, something is very wrong upstream (a parseDocId
  // bug, a manually-crafted docId, etc) — fail loud.
  if (existing.workspaceId !== args.expectedWorkspaceId) {
    return { ok: false, reason: 'workspace-mismatch' }
  }

  // Mirror upsertAtomImpl line 115 — NUL paths refused at every
  // write surface. The atom row in db shouldn't have one, but
  // belt-and-suspenders for the rename case.
  if (!isSafeAtomPath(existing.path)) {
    return { ok: false, reason: 'atom-not-found' }
  }

  // CAS RE-CHECK inside the mutation. The hash passed in was
  // computed at projection-start (caller); this re-check catches
  // a race where another write committed between projection-
  // start and this mutation. Codex v3 NEW issue: server-computed,
  // never trusted from any client.
  const currentBodyHash = await sha256Hex(existing.body)
  if (currentBodyHash !== args.expectedCurrentBodyHash) {
    return { ok: false, reason: 'hash-mismatch' }
  }

  // Seed the frontmatter id BEFORE deriving the final hash.
  // Mirrors upsertAtomImpl line 123. Idempotent: a body that
  // already has an id is returned unchanged. The hash we store
  // for the NEXT CAS check is sha256(finalBody) — Codex v3
  // critical #2 part 1 (was a v3 doc bug to hash pre-seed).
  const finalBody = await seedAtomIdIntoBody(
    ctx,
    args.expectedWorkspaceId,
    existing.path,
    args.newBody,
  )

  // Lock checks — Codex v3 question 6 confirmed: locks should
  // freeze collab projection. systemLocked never overridable
  // for collab (no allowSystemOverride); userLocked freezes
  // too (collab is NOT user-edit context).
  if (existing.systemLocked) throw new SystemLockError(existing.path, 'edit')
  if (existing.userLocked) throw new UserLockError(existing.path, 'edit')

  // DELIBERATELY NO recordTrash here (Codex v3 critical #2 part
  // 2). At ~1500ms projection cadence during active typing,
  // uncoalesced trash floods the table. Collab recovery flows
  // through prosemirror-sync's snapshot+delta history; that IS
  // the audit trail for multiplayer edits.

  // Mirror upsertAtomImpl's body+searchFields patch (lines
  // 206-213). source: 'collab' on every projection signals
  // the most-recent edit origin.
  const now = Date.now()
  await ctx.db.patch(existing._id, {
    body: finalBody,
    updatedAt: now,
    source: 'collab',
    ...deriveSearchFields(existing.path, finalBody),
  })

  // Mirror upsertAtomImpl's two side-effect calls (lines 217 +
  // 221-223). applyAtomCapture diffs inline values for the
  // captures/withhold system. reconcileAtomIdIndex keeps the
  // rename-proof index in step with the new body.
  await applyAtomCapture(
    ctx,
    args.expectedWorkspaceId,
    existing.path,
    existing.body,
    finalBody,
  )
  await reconcileAtomIdIndex(
    ctx,
    args.expectedWorkspaceId,
    existing.path,
    finalBody,
    { isRestore: false },
  )

  // NOTE: scheduleMapRegen happens OUTSIDE upsertAtomImpl in the
  // existing code (atoms.upsert / atoms.remove call it after the
  // impl returns). The projection writer (sub-commit 3.6) does
  // the same — keeps this helper free of the scheduler dep.

  const newBaseBodyHash = await sha256Hex(finalBody)
  return {
    ok: true,
    finalBody,
    newBaseBodyHash,
    path: existing.path,
    workspaceId: existing.workspaceId,
  }
}
