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
import { mutation, query } from './_generated/server'
import { api } from './_generated/api'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import { parseDocId, prosemirrorSync } from './prosemirror'
import { sha256Hex } from './atomWriter'
import { serializeSnapshotToProjectedBody } from './collabProjectionSerializer'
import { roundtripMarkdown } from './markdownRoundtrip'
import { splitFrontmatter, joinFrontmatter } from './atomId'

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
        reason:
          | 'body-changed'
          | 'invalid-pm-json'
          | 'atom-not-found'
          // 6th-pass FIX #1: client submitted PM JSON that
          // doesn't round-trip to atom.body. Either client has
          // stale PM state or parser-drift; in both cases the
          // client should re-read atoms.body + re-parse before
          // retrying. Do NOT retry blindly — would loop.
          | 'pm-body-mismatch'
          // 6th-pass FIX #4: collabDocs row is frozen=true.
          // Client must show reload banner; not a retry signal.
          | 'frozen'
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

    // Codex 6th-pass BLOCKER #1: bind pmJsonStr to atom.body.
    // clientBodyHash alone only proves the client SAW the current
    // body; it doesn't prove the submitted PM JSON was DERIVED
    // from that body. Without this check, a stale/buggy client
    // can submit OLD pmJsonStr with the CURRENT hash; the server
    // accepts; rebootstrap clears needsRebootstrap; the NEXT
    // projection silently rolls back the OOB write. Auto-rebuild
    // becomes silent-rollback.
    //
    // The fix: serialize the submitted PM JSON server-side; verify
    // it canonicalize-roundtrips to atom.body. Hashes are compared
    // against a CANONICAL form (atom.body run through the same
    // remark pipeline) so trailing-newline drift doesn't false-
    // reject.
    const pmCheck = serializeSnapshotToProjectedBody(pmJsonStr, atom.body)
    if (!pmCheck.ok) {
      // Could be malformed JSON, unknown PM node, or remark crash.
      // Surface the reason directly — same shape as the fresh-
      // bootstrap path's invalid-pm-json handling below.
      if (pmCheck.reason === 'invalid-pm-json') {
        // 3.9.23 — diagnostic log so we can debug WHY parsing
        // failed without asking the user to repro.
        console.error('[bootstrap] invalid-pm-json', {
          docId,
          atomId: parsed.atomId,
          pmJsonStrPreview: pmJsonStr.slice(0, 200),
        })
        return { ok: false, reason: 'invalid-pm-json' }
      }
      // unknown-pm-node / serialize-failed → treat as PM mismatch
      // (client should investigate; not a retry condition).
      console.error('[bootstrap] serializeSnapshotToProjectedBody failed', {
        docId,
        atomId: parsed.atomId,
        reason: pmCheck.reason,
        detail: 'detail' in pmCheck ? pmCheck.detail : undefined,
      })
      return { ok: false, reason: 'pm-body-mismatch', serverBodyHash }
    }
    const { fm, rest: atomRest } = splitFrontmatter(atom.body)
    const canonicalAtomBody = joinFrontmatter(fm, roundtripMarkdown(atomRest))
    const canonicalAtomHash = await sha256Hex(canonicalAtomBody)
    // M1 step 3.9.24 — RELAXED CAS COMPARISON.
    //
    // Pre-3.9.24 the check was strict byte-equality:
    //   sha256(pmCheck.newBody) === sha256(canonicalAtomBody)
    //
    // pmCheck.newBody = fm + (PM → mdast → stringify)
    // canonicalAtomBody = fm + (rest → remark.parse → stringify)
    //
    // Two different parsers (Crepe + remark) → two different
    // mdasts for the SAME semantic content → two different
    // strings → spurious pm-body-mismatch on benign style
    // variation (whitespace, bullet style, escape choices).
    //
    // Fix: re-canonicalize the PM side through ONE MORE
    // roundtrip. roundtripMarkdown is idempotent for any input
    // remark can parse, so a single re-run normalizes
    // stylistic variants to the same fixed point. After the
    // re-roundtrip both sides have gone through the SAME
    // canonicalizer; byte-equality now means semantic
    // equivalence.
    //
    // Still catches real drift: if Crepe's PM contains
    // genuinely different content (user typed something
    // else), the canonical forms still differ. CAS protection
    // intact; just lenient about Crepe vs remark style.
    const { rest: pmRest } = splitFrontmatter(pmCheck.newBody)
    const pmCanonical = joinFrontmatter(fm, roundtripMarkdown(pmRest))
    const pmCanonicalHash = await sha256Hex(pmCanonical)
    if (pmCanonicalHash !== canonicalAtomHash) {
      // Submitted PM JSON does NOT round-trip to atom.body
      // even after re-canonicalization. Real content drift
      // (or a parser bug we need to fix).
      //
      // 3.9.23 — diagnostic log shows BOTH canonical forms
      // (first 400 chars + length) so the next time this
      // fires, server logs reveal exactly where Crepe + remark
      // diverge. 3.9.24 — also logs the strict-comparison
      // value so we can see if it was caught by re-canonicalize
      // or genuinely different.
      console.error('[bootstrap] pm-body-mismatch', {
        docId,
        atomId: parsed.atomId,
        pmCanonicalPreview: pmCanonical.slice(0, 400),
        pmCanonicalLen: pmCanonical.length,
        canonicalAtomPreview: canonicalAtomBody.slice(0, 400),
        canonicalAtomLen: canonicalAtomBody.length,
        pmRawPreview: pmCheck.newBody.slice(0, 400),
        wouldHaveFailedStrict:
          (await sha256Hex(pmCheck.newBody)) !== canonicalAtomHash,
      })
      return { ok: false, reason: 'pm-body-mismatch', serverBodyHash }
    }

    // Idempotency check: if a collabDocs row already exists for
    // this docId, four possibilities (post 6th-pass FIX #4):
    //
    //   1. frozen=true → return ok:false (reason:'frozen'). Client
    //      MUST show reload banner, not retry. Frozen-dominates
    //      invariant: if frozen is set, no rebootstrap path
    //      runs even if needsRebootstrap is also true.
    //   2. needsRebootstrap=true (and NOT frozen) → REBOOTSTRAP
    //      branch (3.8.0): submit at latestVersion+1, clear flag.
    //   3. Otherwise → alreadyBootstrapped (normal idempotency).
    //   4. No row → fresh bootstrap below.
    const existing = await ctx.db
      .query('collabDocs')
      .withIndex('by_docId', (q) => q.eq('docId', docId))
      .unique()
    if (existing && existing.frozen) {
      // Codex 6th-pass FIX #4: frozen dominates. Bootstrap returns
      // a distinct reason so the client knows to show the reload
      // banner instead of retrying (which would loop forever).
      return { ok: false, reason: 'frozen', serverBodyHash }
    }
    if (existing && !existing.needsRebootstrap) {
      return { ok: true, alreadyBootstrapped: true, serverBodyHash }
    }

    if (existing && existing.needsRebootstrap) {
      // Parse the PM JSON now so we can pass it to submitSnapshot.
      // (Defer JSON parse to right before we need it.)
      let pmJsonRebootstrap: object
      try {
        const parsed = JSON.parse(pmJsonStr) as object
        if (typeof parsed !== 'object' || parsed === null) {
          return { ok: false, reason: 'invalid-pm-json' }
        }
        pmJsonRebootstrap = parsed
      } catch {
        return { ok: false, reason: 'invalid-pm-json' }
      }

      // Find the latest version + submit a fresh snapshot at
      // version+1. Wrap the WHOLE block in try/catch so any
      // failure (collision with concurrent rebootstrap; component
      // unavailable; auth-revoked-mid-call) surfaces as
      // body-changed → client retries with a fresh body read.
      // Production semantics: retry with exponential backoff
      // gives the system a chance to converge.
      let newVersion: number
      try {
        const latestVersion = (await ctx.runQuery(
          api.prosemirror.latestVersion,
          { id: docId },
        )) as number | null
        newVersion = (latestVersion ?? 1) + 1

        await ctx.runMutation(api.prosemirror.submitSnapshot, {
          id: docId,
          version: newVersion,
          content: JSON.stringify(pmJsonRebootstrap),
        })
      } catch {
        // Possible causes:
        //   - Race with another rebootstrap (collision on the
        //     same version with different content)
        //   - prosemirror-sync component momentarily unavailable
        //     (very rare; transient infra)
        //   - Client closed mid-call (network teardown)
        // All paths: client retries on the body-changed signal.
        // If 3.7 already cleared baseBodyHash to serverBodyHash,
        // the retry will hit the alreadyBootstrapped path on a
        // subsequent attempt.
        return { ok: false, reason: 'body-changed', serverBodyHash }
      }

      // Snapshot landed. Clear the rebootstrap signal + reset
      // baseline. baseBodyHash was already updated by 3.7's
      // auto-rebuild path to serverBodyHash; we re-assert it
      // defensively (idempotent if equal).
      await ctx.db.patch(existing._id, {
        needsRebootstrap: false,
        baseBodyHash: serverBodyHash,
        projectedVersion: newVersion,
        lastProjectedHash: serverBodyHash,
        updatedAt: Date.now(),
      })
      return {
        ok: true,
        alreadyBootstrapped: false,
        serverBodyHash,
      }
    }

    // Below: existing fresh-bootstrap code path (no prior
    // collabDocs row).

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

// M1 step 3.8.0 — public query the client subscribes to so it
// can react to conflict-resolver signals from 3.7:
//   - frozen=true → show reload banner (real conflict)
//   - needsRebootstrap=true → tear down + re-bootstrap from
//     atoms.body (auto-rebuild after OOB write while PM was idle)
//
// The actual client-side rebootstrap UX wiring (useQuery +
// useEffect chain in collab-sync.ts) is sub-commit 3.8.1, which
// needs browser testing to land safely. This query is the SHAPE
// the client subscribes to; the server-side rebootstrap
// mutation handling (above) is what makes the client's
// bootstrapSnapshotFromAtomBody retry succeed.
//
// Auth: same P1 gate as recordCollabPresence. Non-readers can't
// observe collab state (defense-in-depth; they shouldn't have
// the docId in the first place).
export const getCollabDocState = query({
  args: {
    docId: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { docId, activeWorkspaceId },
  ): Promise<
    | {
        exists: false
      }
    | {
        exists: true
        frozen: boolean
        needsRebootstrap: boolean
        lastConflictAt: number | null
        projectedVersion: number
      }
  > => {
    const parsed = parseDocId(docId)
    if (parsed.kind === 'invalid') return { exists: false }
    // share: docs aren't supported in v1; report no state.
    if (parsed.kind !== 'atom') return { exists: false }

    // Workspace membership (canonical per authz tripwire)
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    if (workspaceId !== parsed.workspaceId) return { exists: false }
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return { exists: false }

    // P1 access — caller must be allowed to READ the atom to
    // observe its collab state.
    if (!(await canReadAtom(ctx, parsed.atomId, identity.subject))) {
      return { exists: false }
    }

    const doc = await ctx.db
      .query('collabDocs')
      .withIndex('by_docId', (q) => q.eq('docId', docId))
      .unique()
    if (!doc) return { exists: false }

    return {
      exists: true,
      frozen: doc.frozen,
      needsRebootstrap: doc.needsRebootstrap,
      lastConflictAt: doc.lastConflictAt ?? null,
      projectedVersion: doc.projectedVersion,
    }
  },
})
