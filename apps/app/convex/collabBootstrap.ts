// M1 step 3 sub-commit 3.5 (multiplayer-and-h-followups §8) —
// bootstrap mutation. The first client to open a doc in multiplayer
// mode calls this; the server records the initial snapshot via
// prosemirrorSync.create + creates the collabDocs row that tracks
// projection state going forward.
//
// SPLIT OF RESPONSIBILITY (per v4 architecture decision):
//   - Client parses atoms.body → PM JSON using the cached Crepe
//     schema (from sub-commit 3.2). Server never parses markdown.
//   - Client submits {pmJsonStr, clientBodyHash, docId} to this
//     mutation.
//   - Server re-reads atoms.body, computes its own hash, and
//     accepts ONLY if the hashes match (otherwise the body changed
//     between client read + submission; client retries).
//
// CAS-FIRST (Codex v3 NEW issue + v4 fix): the bootstrap is just
// like every other write — the server-computed hash is the witness;
// client-supplied data is data, not authority.

import { v } from 'convex/values'
import { mutation } from './_generated/server'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import { parseDocId, prosemirrorSync } from './prosemirror'
import { sha256Hex } from './atomWriter'

export const bootstrapSnapshotFromAtomBody = mutation({
  args: {
    docId: v.string(),
    /** PM JSON the client built by parsing atoms.body through the
     *  cached Crepe schema. Submitted as JSON string + parsed
     *  server-side (so a malformed JSON throws cleanly). */
    pmJsonStr: v.string(),
    /** Hash of the atoms.body the client used to derive pmJsonStr.
     *  Server re-reads atoms.body + compares; mismatch ⇒ body
     *  changed; client retries with the new body. */
    clientBodyHash: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { docId, pmJsonStr, clientBodyHash, activeWorkspaceId },
  ): Promise<
    | {
        ok: true
        alreadyBootstrapped: boolean
        serverBodyHash: string
      }
    | {
        ok: false
        reason: 'body-changed' | 'invalid-pm-json' | 'atom-not-found'
        serverBodyHash?: string
      }
  > => {
    const parsed = parseDocId(docId)
    if (parsed.kind === 'invalid') {
      throw new Error('Invalid document id.')
    }
    if (parsed.kind === 'share') {
      // Cross-workspace shared atoms come in M2+. v1 bootstrap is
      // atom-only — owner's workspace is the source of truth.
      throw new Error('share: docId bootstrap is not yet supported')
    }

    // Workspace membership (canonical per authz tripwire)
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    if (workspaceId !== parsed.workspaceId) {
      throw new Error('Workspace mismatch.')
    }
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')

    // P1 access — caller must be allowed to READ the atom to
    // bootstrap a collab session on it.
    if (!(await canReadAtom(ctx, parsed.atomId, identity.subject))) {
      throw new Error('Not authorized.')
    }

    const atom = await ctx.db.get(parsed.atomId)
    if (!atom) return { ok: false, reason: 'atom-not-found' }
    if (atom.workspaceId !== workspaceId) {
      return { ok: false, reason: 'atom-not-found' }
    }

    // CAS: server-computed hash is authoritative. Codex v3 NEW
    // issue called out client-supplied hashes as untrustable.
    const serverBodyHash = await sha256Hex(atom.body)
    if (serverBodyHash !== clientBodyHash) {
      // Body changed between client read + submission. Client
      // should retry with the fresh body. Bounded retry policy
      // lives client-side (per v3 architecture Q5: bounded retry
      // fine; no lock unless retries prove noisy).
      return { ok: false, reason: 'body-changed', serverBodyHash }
    }

    // Idempotency check: if a collabDocs row already exists for
    // this docId, another client beat us to bootstrap. Return
    // alreadyBootstrapped:true — the package's snapshot has been
    // created; our local prosemirrorSync.create would either
    // silently accept (identical content) or throw (divergent).
    // Skip the call entirely; caller proceeds to its normal
    // post-bootstrap flow (fetch snapshot, subscribe to deltas).
    const existing = await ctx.db
      .query('collabDocs')
      .withIndex('by_docId', (q) => q.eq('docId', docId))
      .unique()
    if (existing) {
      return { ok: true, alreadyBootstrapped: true, serverBodyHash }
    }

    // Parse the PM JSON the client built. Server doesn't trust
    // structure — we let prosemirrorSync.create attempt the insert;
    // if the JSON is malformed it'll throw and we surface that
    // as a clean error rather than crashing the mutation.
    let pmJson: object
    try {
      pmJson = JSON.parse(pmJsonStr) as object
      if (typeof pmJson !== 'object' || pmJson === null) {
        return { ok: false, reason: 'invalid-pm-json' }
      }
    } catch {
      return { ok: false, reason: 'invalid-pm-json' }
    }

    // Submit the initial snapshot. The package's `create` writes
    // at version 1 (verified by Codex v3). On identical-content
    // duplicate it silently accepts; on divergent duplicate (race
    // where another client bootstrapped with different PM JSON)
    // it THROWS — that's a determinism bug. For v1 we let the
    // throw propagate so it surfaces in logs; the second client's
    // bootstrap fails loud. Future hardening: canonicalize
    // server-side before submit.
    await prosemirrorSync.create(ctx, docId, pmJson)

    // Insert the collabDocs row. baseBodyHash is the
    // server-computed hash we verified above. projectedVersion
    // starts at 1 (matching the snapshot we just created).
    await ctx.db.insert('collabDocs', {
      docId,
      atomId: parsed.atomId,
      workspaceId,
      baseBodyHash: serverBodyHash,
      projectedVersion: 1,
      frozen: false,
      needsRebootstrap: false,
      updatedAt: Date.now(),
    })

    return { ok: true, alreadyBootstrapped: false, serverBodyHash }
  },
})
