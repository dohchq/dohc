// v2 atomSuggestions: the agent-as-collaborator sidecar.
//
// Suggestions are anchored by Y.RelativePosition bytes created from
// the live Y.Doc. `expectedText` and optional prefix/suffix witnesses
// guard semantic intent; the anchors guard location through concurrent
// CRDT edits. Accepting a suggestion calls Hocuspocus' semantic API,
// which mutates the canonical Y.Doc. This module never splices
// `atoms.body`; that field is only the derived markdown projection.

import { v } from 'convex/values'
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteAtomPath } from './atomAccess'
import { extractFrontmatterId } from './atomId'
import type { Id } from './_generated/dataModel'

// Per-atom rate cap (codex HIGH 4 / plan §3 M3 cost caps).
// "Per-turn: hard cap on number of propose_replace_text calls (e.g.
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
 *  Called by semantic agent tools after auth + cap
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

function hocuspocusSemanticEnv(): { url: string; token: string } {
  const url = process.env.HOCUSPOCUS_ADMIN_URL
  const token = process.env.HOCUSPOCUS_ADMIN_TOKEN
  if (!url || !token) {
    throw new Error(
      'HOCUSPOCUS_ADMIN_URL and HOCUSPOCUS_ADMIN_TOKEN required for semantic suggestion accept',
    )
  }
  return { url, token }
}

export const _getSuggestionForSemanticAccept = internalQuery({
  args: {
    suggestionId: v.id('atomSuggestions'),
    activeWorkspaceId: v.optional(v.string()),
    subject: v.string(),
  },
  handler: async (ctx, { suggestionId, activeWorkspaceId, subject }) => {
    const workspaceId = activeWorkspaceId ?? subject
    if (workspaceId !== subject) {
      const membership = await ctx.db
        .query('memberships')
        .withIndex('by_org_workspace', (q) =>
          q.eq('orgId', workspaceId).eq('workspaceId', subject),
        )
        .unique()
      if (!membership) throw new Error(`Not a member of workspace ${workspaceId}`)
      if (membership.status !== undefined && membership.status !== 'active') {
        throw new Error(`Membership not active (status=${membership.status})`)
      }
    }

    const row = await ctx.db.get(suggestionId)
    if (!row) throw new Error('Suggestion not found.')
    if (row.workspaceId !== workspaceId) {
      throw new Error('Workspace mismatch.')
    }
    if (row.status !== 'pending') {
      // Idempotent: re-accepting a resolved suggestion is a
      // no-op (another tab beat us). Return the row so the
      // caller can update its UI consistently.
      return { state: 'already-resolved' as const }
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
    const atomId = extractFrontmatterId(atom.body)
    if (!atomId) throw new Error('Atom is missing a frontmatter id.')
    if (!row.anchorStart || !row.anchorEnd) {
      throw new Error('Suggestion is missing Y.RelativePosition anchors.')
    }

    return {
      state: 'pending' as const,
      workspaceId,
      atomId,
      anchorStart: row.anchorStart,
      anchorEnd: row.anchorEnd,
      proposedText: row.proposedText,
      expectedText: row.expectedText,
      expectedPrefix: row.expectedPrefix,
      expectedSuffix: row.expectedSuffix,
    }
  },
})

export const _markSuggestionApplyResult = internalMutation({
  args: {
    suggestionId: v.id('atomSuggestions'),
    status: v.union(
      v.literal('accepted'),
      v.literal('stale'),
      v.literal('needs-review'),
    ),
    resolvedByUserId: v.string(),
    resolvedByUserName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { suggestionId, status, resolvedByUserId, resolvedByUserName },
  ) => {
    const row = await ctx.db.get(suggestionId)
    if (!row || row.status !== 'pending') {
      return { ok: true as const, alreadyResolved: true }
    }
    await ctx.db.patch(suggestionId, {
      status,
      resolvedByUserId,
      resolvedByUserName,
      resolvedAt: Date.now(),
    })
    return { ok: true as const, alreadyResolved: false }
  },
})

type AcceptSuggestionResult =
  | { ok: true; alreadyResolved: boolean }
  | { ok: false; reason: 'stale' | 'needs-review' }

/** Accept a suggestion through the Hocuspocus semantic API.
 *
 * This never splices `atoms.body`. Hocuspocus mutates canonical Y.Doc
 * state and the projection worker later refreshes the markdown cache.
 *
 * Auth: P1 WRITE access on the atom. */
export const acceptSuggestion = action({
  args: {
    suggestionId: v.id('atomSuggestions'),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { suggestionId, activeWorkspaceId },
  ): Promise<AcceptSuggestionResult> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const subject = identity.subject
    const resolverName =
      typeof identity.name === 'string' && identity.name.length > 0
        ? identity.name
        : undefined
    const workspaceId = (await ctx.runQuery(
      internal.agent._resolveWorkspaceForCaller,
      { activeWorkspaceId },
    )) as string

    const suggestion = await ctx.runQuery(
      internal.atomSuggestions._getSuggestionForSemanticAccept,
      { suggestionId, activeWorkspaceId: workspaceId, subject },
    )
    if (suggestion.state === 'already-resolved') {
      return { ok: true as const, alreadyResolved: true }
    }

    const env = hocuspocusSemanticEnv()
    const response = await fetch(
      new URL('/apply/replaceRange', env.url).toString(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operationId: `acceptSuggestion:${suggestionId}`,
          workspaceId: suggestion.workspaceId,
          atomId: suggestion.atomId,
          actor: {
            userId: subject,
            actorKind: 'user',
            authzVersion: 1,
          },
          anchorStart: suggestion.anchorStart,
          anchorEnd: suggestion.anchorEnd,
          replacement: suggestion.proposedText,
          expectedText: suggestion.expectedText,
          expectedPrefix: suggestion.expectedPrefix,
          expectedSuffix: suggestion.expectedSuffix,
        }),
      },
    )
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; reason?: string }
      | null
    if (!response.ok || payload?.ok !== true) {
      const status =
        payload?.reason === 'needs-review'
          ? 'needs-review'
          : payload?.reason === 'stale-intent'
            ? 'stale'
            : null
      if (status) {
        await ctx.runMutation(internal.atomSuggestions._markSuggestionApplyResult, {
          suggestionId,
          status,
          resolvedByUserId: subject,
          resolvedByUserName: resolverName,
        })
        return { ok: false as const, reason: status }
      }
      throw new Error(
        `Hocuspocus semantic accept failed: ${response.status}${
          payload?.reason ? ` (${payload.reason})` : ''
        }`,
      )
    }

    return await ctx.runMutation(
      internal.atomSuggestions._markSuggestionApplyResult,
      {
        suggestionId,
        status: 'accepted',
        resolvedByUserId: subject,
        resolvedByUserName: resolverName,
      },
    )
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
