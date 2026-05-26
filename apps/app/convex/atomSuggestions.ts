// M1 step 3.9.0 (multiplayer-and-h-followups §3 PR M3) —
// atomSuggestions: the agent-as-collaborator sidecar.
//
// Per Decision D (decorations + sidecar, NOT custom PM nodes):
// the agent writes a row here via suggest_in_doc; the editor's
// decoration plugin (3.9.1) subscribes via listPending and
// renders an inline bubble. The user clicks Accept (inlines
// the proposedText into atoms.body) or Reject (deletes row).
//
// Position semantics: rangeFrom/rangeTo are MARKDOWN-BODY
// offsets (NOT PM doc positions — those are a separate
// coordinate system that doesn't map 1:1 to atoms.body string
// indices). The agent reasons about markdown offsets natively
// (it reads body via read_atom). The editor decoration plugin
// renders the bubble at the approximate PM position; the bubble
// location is visually approximate but accept correctness
// comes from the expectedText CAS witness (3.9.3 — out-of-
// bounds rejected; drift since suggest_in_doc rejected).
// Under concurrent body edits the highlighted range may
// briefly desync; the CAS catches any drift before splice.

import { v } from 'convex/values'
import { mutation, query, internalMutation } from './_generated/server'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteAtomPath } from './atomAccess'
import type { Id } from './_generated/dataModel'

// Per-atom rate cap (codex HIGH 4 / plan §3 M3 cost caps).
// "Per-turn: hard cap on number of suggest_in_doc calls (e.g.
// 5)". Convex actions have no native turn boundary; we
// approximate with a per-atom-per-minute cap. Excess suggestions
// throw so the agent gets a structured error + the rest of the
// turn aborts gracefully.
const RECENT_WINDOW_MS = 60_000
const PER_ATOM_PER_MINUTE_CAP = 5
// Soft per-suggestion text cap (plan §3 M3: "total proposed
// chars (e.g. 5000)"). Per-suggestion equivalent: each one
// must be <= cap. A 5-call burst at 1000 chars each = 5000;
// matches the plan's per-turn budget without needing turn
// accounting.
const PER_SUGGESTION_CHAR_CAP = 1000
// Pending-suggestion lifespan. Resolved rows are kept briefly
// so other tabs see the "accepted by X" fade UI; after this
// they're garbage-collected lazily by listPending (which
// filters to status='pending' + recently resolved). Keeps the
// table from growing indefinitely.
const RESOLVED_KEEP_MS = 10_000

/** Internal mutation: actually write the suggestion row.
 *  Called by the suggest_in_doc agent tool after auth + cap
 *  checks. Separated from the tool so test setups can write
 *  rows directly without spinning up the agent runtime. */
export const _createSuggestion = internalMutation({
  args: {
    atomId: v.id('atoms'),
    workspaceId: v.string(),
    rangeFrom: v.optional(v.number()),
    rangeTo: v.optional(v.number()),
    anchorStart: v.optional(v.string()),
    anchorEnd: v.optional(v.string()),
    proposedText: v.string(),
    instruction: v.string(),
    // M1 step 3.9.6 — SIGNED AGENT TOKEN (plan §3 M3 +
    // codex HIGH 2). authorIsAgent is derived from agentSecret
    // matching process.env.DOHC_AGENT_SECRET. A caller without
    // the env secret gets authorIsAgent=false regardless of
    // intent. Defense-in-depth: _createSuggestion is an
    // internalMutation (not exposed to clients), so the
    // direct-forge attack requires writing new server code;
    // the secret makes that attack require code review WITH
    // the env var, which is more auditable than a silent
    // flag toggle.
    //
    // 3.9.7 — codex 17th-pass [P2] cleanup: the prior
    // authorIsAgent caller-claim arg is dropped. authorIsAgent
    // is now derived solely from the verified secret; no
    // misleading caller-controlled field on the API surface.
    authorUserId: v.string(),
    /** 3.9.18 — cached display name from identity.name at
     *  create time. Stored on the row so listPending can
     *  return it for bubble rendering. Optional — agents
     *  may not have a usable name, and tests calling the
     *  internal mutation may not provide one. */
    authorUserName: v.optional(v.string()),
    /** Bearer token the caller claims as proof of agent runtime
     *  origin. Compared to process.env.DOHC_AGENT_SECRET. When
     *  missing or non-matching, authorIsAgent is forced to
     *  false. The env var is set on the Convex deployment;
     *  in dev/test (no env var) authorIsAgent is always false
     *  unless the test sets the same env value. */
    agentSecret: v.optional(v.string()),
    // 3.9.2 — CAS witness (see schema comment).
    expectedText: v.optional(v.string()),
    expectedPrefix: v.optional(v.string()),
    expectedSuffix: v.optional(v.string()),
    createdFromProjectionHash: v.optional(v.string()),
  },
  handler: async (
    ctx,
    {
      atomId,
      workspaceId,
      rangeFrom,
      rangeTo,
      anchorStart,
      anchorEnd,
      proposedText,
      instruction,
      authorUserId,
      authorUserName,
      agentSecret,
      expectedText,
      expectedPrefix,
      expectedSuffix,
      createdFromProjectionHash,
    },
  ): Promise<{ ok: true; id: Id<'atomSuggestions'> } | { ok: false; reason: string }> => {
    // 3.9.6 — verify the agent secret. Both sides of the
    // comparison must be non-empty for verification to
    // succeed (so an unset env var doesn't mean "anyone
    // can claim agent" — the secret has to BE set on the
    // deployment for the flag to ever fire true).
    const expectedSecret = process.env.DOHC_AGENT_SECRET
    const verifiedAgent =
      typeof expectedSecret === 'string' &&
      expectedSecret.length > 0 &&
      agentSecret === expectedSecret
    const authorIsAgent = verifiedAgent
    if (proposedText.length > PER_SUGGESTION_CHAR_CAP) {
      return {
        ok: false,
        reason: `Suggestion text exceeds ${PER_SUGGESTION_CHAR_CAP} chars.`,
      }
    }
    const hasAnchors =
      typeof anchorStart === 'string' && typeof anchorEnd === 'string'
    const hasLegacyRange =
      typeof rangeFrom === 'number' && typeof rangeTo === 'number'
    if (!hasAnchors && !hasLegacyRange) {
      return { ok: false, reason: 'Missing suggestion anchors.' }
    }
    if (
      hasLegacyRange &&
      (rangeFrom < 0 || rangeTo < rangeFrom)
    ) {
      return { ok: false, reason: 'Invalid range.' }
    }
    // Cap: count THIS author's PENDING suggestions on this atom
    // within the recent window. 3.9.2 [P2] — use the
    // by_atomId_status index so the scan is bounded to pending
    // rows only (resolved rows linger up to 10s for the fade UI
    // but shouldn't count against the cap).
    const since = Date.now() - RECENT_WINDOW_MS
    const recent = await ctx.db
      .query('atomSuggestions')
      .withIndex('by_atomId_status', (q) =>
        q.eq('atomId', atomId).eq('status', 'pending'),
      )
      .collect()
    const myRecent = recent.filter(
      (r) => r.authorUserId === authorUserId && r.createdAt >= since,
    )
    if (myRecent.length >= PER_ATOM_PER_MINUTE_CAP) {
      return {
        ok: false,
        reason: `Per-atom suggestion cap reached (${PER_ATOM_PER_MINUTE_CAP}/min). Pause and let the user respond.`,
      }
    }
    const id = await ctx.db.insert('atomSuggestions', {
      atomId,
      workspaceId,
      ...(hasLegacyRange ? { rangeFrom, rangeTo } : {}),
      ...(hasAnchors ? { anchorStart, anchorEnd } : {}),
      proposedText,
      instruction,
      authorIsAgent,
      authorUserId,
      authorUserName, // 3.9.18 — cached at insert time
      expectedText,
      expectedPrefix,
      expectedSuffix,
      createdFromProjectionHash,
      status: 'pending',
      createdAt: Date.now(),
    })
    return { ok: true, id }
  },
})

/** Subscription target for the decoration plugin. Returns the
 *  pending suggestions for an atom + recently resolved ones
 *  (within RESOLVED_KEEP_MS) so other tabs can fade the
 *  "accepted by Bob 2s ago" UI before the row vanishes.
 *
 *  Auth: P1 read access on the atom. Non-readers see []. */
export const listPending = query({
  args: {
    atomId: v.id('atoms'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { atomId, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return []
    const atom = await ctx.db.get(atomId)
    if (!atom) return []
    if (atom.workspaceId !== workspaceId) return []
    if (!(await canReadAtom(ctx, atomId, identity.subject))) return []

    // 3.9.2 [P2] — split the read so PENDING uses the
    // by_atomId_status index (hot path; common case is many
    // resolved + few pending). Recently-resolved still needs a
    // broader scan but the cutoff bounds it.
    const cutoff = Date.now() - RESOLVED_KEEP_MS
    const pending = await ctx.db
      .query('atomSuggestions')
      .withIndex('by_atomId_status', (q) =>
        q.eq('atomId', atomId).eq('status', 'pending'),
      )
      .collect()
    const recentlyResolved = (
      await ctx.db
        .query('atomSuggestions')
        .withIndex('by_atomId', (q) => q.eq('atomId', atomId))
        .collect()
    ).filter(
      (r) =>
        r.status !== 'pending' &&
        r.resolvedAt !== undefined &&
        r.resolvedAt >= cutoff,
    )
    return [...pending, ...recentlyResolved]
      .map((r) => ({
        _id: r._id,
        atomId: r.atomId,
        rangeFrom: r.rangeFrom,
        rangeTo: r.rangeTo,
        anchorStart: r.anchorStart,
        anchorEnd: r.anchorEnd,
        proposedText: r.proposedText,
        instruction: r.instruction,
        authorIsAgent: r.authorIsAgent,
        authorUserId: r.authorUserId,
        // 3.9.18 — display names for bubble UI
        authorUserName: r.authorUserName,
        status: r.status,
        resolvedByUserId: r.resolvedByUserId,
        resolvedByUserName: r.resolvedByUserName,
        resolvedAt: r.resolvedAt,
        createdAt: r.createdAt,
        // M1 step 3.9.5 — client decoration plugin needs
        // expectedText to text-search for the suggestion
        // anchor in the current PM doc (drift-robust
        // rendering). expectedText is required as of 3.9.3
        // for accept CAS; here it doubles as the render
        // anchor.
        expectedText: r.expectedText,
        expectedPrefix: r.expectedPrefix,
        expectedSuffix: r.expectedSuffix,
        createdFromProjectionHash: r.createdFromProjectionHash,
      }))
  },
})

/** Accept a suggestion.
 *
 * v2 hard gate: suggestions must mutate the canonical Y.Doc through
 * Hocuspocus semantic operations. This mutation intentionally refuses
 * to splice the derived `atoms.body` cache. Phase 1.8 wires the HTTP
 * semantic apply path and then this function can patch the row based on
 * the Hocuspocus result.
 *
 * Auth: P1 WRITE access on the atom. */
export const acceptSuggestion = mutation({
  args: {
    suggestionId: v.id('atomSuggestions'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { suggestionId, activeWorkspaceId },
  ): Promise<
    | { ok: true; alreadyResolved: boolean }
    | {
        ok: false
        reason: 'semantic-api-required'
        message: string
      }
  > => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const subject = identity.subject

    const row = await ctx.db.get(suggestionId)
    if (!row) throw new Error('Suggestion not found.')
    if (row.workspaceId !== workspaceId) {
      throw new Error('Workspace mismatch.')
    }
    if (row.status !== 'pending') {
      // Idempotent: re-accepting a resolved suggestion is a
      // no-op (another tab beat us). Return the row so the
      // caller can update its UI consistently.
      return { ok: true as const, alreadyResolved: true }
    }
    const atom = await ctx.db.get(row.atomId)
    if (!atom) throw new Error('Atom not found.')
    // P1 WRITE gate — only users who could ALSO edit this atom
    // directly may accept agent suggestions on it.
    if (
      !(await canWriteAtomPath(ctx, workspaceId, atom.path, subject))
    ) {
      throw new Error('Not authorized to edit this atom.')
    }

    return {
      ok: false,
      reason: 'semantic-api-required',
      message:
        'Suggestion accept must apply through the Hocuspocus semantic API.',
    }
  },
})

/** Reject a suggestion: mark the row 'rejected' + record who
 *  rejected it (audit). No atoms.body write.
 *
 *  Auth: P1 READ access is sufficient — anyone viewing the
 *  atom can dismiss an agent suggestion on it. (Stronger
 *  than no-auth; weaker than WRITE — matches the rejection
 *  semantics: it's a "go away" signal, not an edit.) */
export const rejectSuggestion = mutation({
  args: {
    suggestionId: v.id('atomSuggestions'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { suggestionId, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const subject = identity.subject
    // 3.9.18 — cache resolver display name for bubble UI
    const resolverName =
      typeof identity.name === 'string' && identity.name.length > 0
        ? identity.name
        : undefined

    const row = await ctx.db.get(suggestionId)
    if (!row) throw new Error('Suggestion not found.')
    if (row.workspaceId !== workspaceId) {
      throw new Error('Workspace mismatch.')
    }
    if (row.status !== 'pending') {
      return { ok: true as const, alreadyResolved: true }
    }
    if (!(await canReadAtom(ctx, row.atomId, subject))) {
      throw new Error('Not authorized.')
    }

    await ctx.db.patch(suggestionId, {
      status: 'rejected',
      resolvedByUserId: subject,
      resolvedByUserName: resolverName,
      resolvedAt: Date.now(),
    })
    return { ok: true as const, alreadyResolved: false }
  },
})
