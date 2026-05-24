// M1 step 3 sub-commit 3.3 (multiplayer-and-h-followups §8) —
// presence + cleanup for active collab sessions. Heartbeat-based,
// NOT tab-close events (Codex v2 fix #8: tab close is unreliable
// signal; presence by explicit ping is the correctness mechanism).
//
// Two mutations:
//   - recordCollabPresence: public, called by each tab ~every 30s
//   - _cleanupIdleSessions: internal, scheduled cron every 60s
//
// Cron cadence matches the 90s presence-expiry promise — no
// 6.5min lag like v2's 5min cron. Codex v3 review confirmed this.

import { v } from 'convex/values'
import { mutation, internalMutation } from './_generated/server'
import { parseDocId } from './prosemirror'
import { requireWorkspace } from './auth'
import { canReadAtom } from './atomAccess'
import { resolveShareAccess } from './atomShares'
import type { Id } from './_generated/dataModel'

// Presence expiry: a session is considered idle if its lastSeenAt
// is older than this. Tied to the client heartbeat cadence (30s)
// with a 3x margin for network jitter / brief disconnects.
const PRESENCE_EXPIRY_MS = 90_000

/** Heartbeat ping from each active tab. Updates the session row's
 *  lastSeenAt; creates the row on first call.
 *
 *  Auth: P1 read access on the doc — non-readable callers can't
 *  even mark themselves as present (they shouldn't be subscribed
 *  to the doc anyway, but defense-in-depth). Same gate as
 *  prosemirror.ts's checkRead. */
export const recordCollabPresence = mutation({
  args: {
    docId: v.string(),
    clientId: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { docId, clientId, activeWorkspaceId }) => {
    const parsed = parseDocId(docId)
    if (parsed.kind === 'invalid') {
      throw new Error('Invalid document id.')
    }

    // Workspace membership gate — canonical entry point. The
    // tripwire (apps/app/src/lib/authzBoundary.test.ts) requires
    // every public fn accepting activeWorkspaceId to route
    // through requireWorkspace(ctx, activeWorkspaceId). For the
    // atom branch we ALSO cross-check that the workspace
    // membership matches the docId's embedded workspaceId (the
    // docId is authoritative for THIS doc).
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)

    // Auth identity for P1 / share gates
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error('Not authenticated')
    const subject = identity.subject

    if (parsed.kind === 'share') {
      const access = await resolveShareAccess(ctx, parsed.shareId)
      if (!access) throw new Error('Not authorized.')
    } else {
      if (workspaceId !== parsed.workspaceId) {
        throw new Error('Workspace mismatch.')
      }
      if (!(await canReadAtom(ctx, parsed.atomId, subject))) {
        throw new Error('Not authorized.')
      }
    }

    const now = Date.now()
    const existing = await ctx.db
      .query('collabSessions')
      .withIndex('by_docId_clientId', (q) =>
        q.eq('docId', docId).eq('clientId', clientId),
      )
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now })
      return { ok: true as const, session: existing._id }
    }
    const sessionId = await ctx.db.insert('collabSessions', {
      docId,
      clientId,
      userId: subject,
      lastSeenAt: now,
    })
    return { ok: true as const, session: sessionId }
  },
})

/** Internal cleanup: reap rows whose lastSeenAt is older than the
 *  expiry. Runs every 60s via cron (see crons.ts). Returns the
 *  reaped count for ops/debug.
 *
 *  Side effects deferred: when a doc's session-count reaches zero,
 *  schedule a final projection (sub-commit 3.6 wires this) and
 *  optionally mark the doc for snapshot pruning. v3.3 only reaps;
 *  the projection-trigger landing comes with the projection
 *  writer. */
export const _cleanupIdleSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PRESENCE_EXPIRY_MS
    const stale = await ctx.db
      .query('collabSessions')
      .withIndex('by_lastSeenAt', (q) => q.lt('lastSeenAt', cutoff))
      .take(500) // bound per-run; the next tick handles overflow
    for (const row of stale) {
      await ctx.db.delete(row._id)
    }
    return { reaped: stale.length }
  },
})
