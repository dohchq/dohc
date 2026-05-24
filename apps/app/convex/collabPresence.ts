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
import { mutation, internalMutation, query } from './_generated/server'
import { components, internal } from './_generated/api'
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
 *  Codex 5th-pass BLOCKER #2 (M1 step 3.6.5): when a doc's session
 *  count reaches ZERO as a result of this reap, schedule a final
 *  projection from the latest snapshot. Without this, closing a
 *  tab before the 5s client snapshot debounce fires leaves
 *  atoms.body stale indefinitely (the next time anyone bootstraps,
 *  the snapshot they get is the last one the server received +
 *  the projection writer wrote — which may be older than the
 *  user's actual last keystroke).
 *
 *  Implementation: track docIds whose sessions were reaped; after
 *  the delete loop, for each tracked docId check if any sessions
 *  remain; if not, schedule a final _projectSnapshotToBody for the
 *  doc's current snapshot version (read from collabDocs +
 *  prosemirrorSync.latestVersion). */
export const _cleanupIdleSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PRESENCE_EXPIRY_MS
    const stale = await ctx.db
      .query('collabSessions')
      .withIndex('by_lastSeenAt', (q) => q.lt('lastSeenAt', cutoff))
      .take(500) // bound per-run; the next tick handles overflow

    // Track which docIds had sessions reaped — we'll check for
    // zero-survivors AFTER all deletes land.
    const affectedDocIds = new Set<string>()
    for (const row of stale) {
      affectedDocIds.add(row.docId)
      await ctx.db.delete(row._id)
    }

    // For each affected doc, schedule a final projection IF the
    // session count is now zero AND the doc has unprojected
    // snapshot deltas. The flush-on-zero is best-effort: if the
    // last snapshot the client managed to submit was already
    // projected, this is a no-op. If there's pending work, it
    // catches the tab-close-before-debounce case.
    let finalProjectionsScheduled = 0
    for (const docId of affectedDocIds) {
      const remaining = await ctx.db
        .query('collabSessions')
        .withIndex('by_docId', (q) => q.eq('docId', docId))
        .take(1)
      if (remaining.length > 0) continue // session count > 0; no flush needed
      // No live sessions — check if the doc has unprojected work.
      const doc = await ctx.db
        .query('collabDocs')
        .withIndex('by_docId', (q) => q.eq('docId', docId))
        .unique()
      if (!doc) continue
      if (doc.frozen) continue
      // Pull the latest snapshot the server has. If its version >
      // projectedVersion, there's work to flush. We CAN'T pass
      // snapshotContent here (we don't have it without calling
      // getSnapshot which reads from a separate component table);
      // instead we schedule a marker mutation that does the
      // fetch+project inline (sub-3.6.5 helper).
      await ctx.scheduler.runAfter(
        0,
        internal.collabPresence._finalProjectIdleDoc,
        { docId },
      )
      finalProjectionsScheduled++
    }

    return { reaped: stale.length, finalProjectionsScheduled }
  },
})

/** Final-projection helper. Reads the latest snapshot via
 *  prosemirrorSync's getSnapshot (the package's query, not getDoc
 *  — getSnapshot returns the EXACT stored snapshot without delta
 *  replay, so the 100-cap issue codex flagged doesn't apply).
 *  Then schedules a regular projection through the existing
 *  collabProjection pipeline. */
export const _finalProjectIdleDoc = internalMutation({
  args: { docId: v.string() },
  handler: async (ctx, { docId }) => {
    const doc = await ctx.db
      .query('collabDocs')
      .withIndex('by_docId', (q) => q.eq('docId', docId))
      .unique()
    if (!doc) return { skipped: 'no-collab-doc' as const }
    if (doc.frozen) return { skipped: 'frozen' as const }

    // Codex 6th-pass BLOCKER #2: use the COMPONENT primitive
    // (components.prosemirrorSync.lib.getSnapshot), NOT the
    // syncApi wrapper (api.prosemirror.getSnapshot). The wrapper
    // runs checkRead which calls requireWorkspace; cron-scheduled
    // mutations have NO user identity, so the syncApi path throws
    // "Not authenticated" + crashes the whole final-flush. The
    // primitive bypasses auth (we already authorized at the
    // collabDocs row level — its existence + non-frozen state
    // means a previously-authorized session created it).
    //
    // Same reason getDoc would be wrong even if it worked: it
    // runs the 100-delta-replay path. getSnapshot returns the
    // EXACT stored snapshot with no replay.
    const snap = (await ctx.runQuery(
      components.prosemirrorSync.lib.getSnapshot,
      { id: docId },
    )) as { content: string; version: number } | { content: null } | null
    if (!snap || snap.content === null) {
      return { skipped: 'no-snapshot' as const }
    }
    if (snap.version <= doc.projectedVersion) {
      return { skipped: 'nothing-newer' as const }
    }

    // Schedule the projection inline (no debounce — we're already
    // post-idle; goal is immediate flush).
    await ctx.scheduler.runAfter(
      0,
      internal.collabProjection._projectSnapshotToBody,
      {
        docId,
        snapshotVersion: snap.version,
        snapshotContent: snap.content,
      },
    )
    return { ok: true as const, scheduledFor: snap.version }
  },
})

// M1 step 3.8.2.1 — file tree presence query. Closes M1+M2
// acceptance criterion #2 ("File tree shows 'Alex is editing'
// while Alex has the editor open; clears within 90s of close").
//
// Returns the SET of atomIds in the active workspace with at
// least one un-expired collab session. The file tree subscribes
// and renders a presence indicator (dot / "live" badge) next
// to each atom.
//
// Shape: returns Array<Id<'atoms'>> (not Set; Convex's wire
// format prefers arrays). The client wraps in `new Set(...)`
// for O(1) lookups during render.
//
// Auth: workspace membership only. We DO NOT filter per-atom
// P1 read access here — that would require an N-way canReadAtom
// loop on every presence query, which is wasteful for the
// file-tree-decoration use case (the tree already P1-filters
// what it renders; an atomId only present in the result that
// the tree wouldn't render is invisible anyway). This is a
// deliberate cost/correctness trade-off; revisit if presence
// becomes a stronger oracle for restricted-atom existence.
export const getActiveAtomIds = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const cutoff = Date.now() - PRESENCE_EXPIRY_MS
    // Pull recent sessions globally then filter to docs in this
    // workspace. The by_lastSeenAt index is descending-friendly;
    // we take a generous slice (most workspaces have <100 active
    // collab sessions at peak) then in-memory filter.
    const recent = await ctx.db
      .query('collabSessions')
      .withIndex('by_lastSeenAt', (q) => q.gte('lastSeenAt', cutoff))
      .take(500)
    const atomIds = new Set<Id<'atoms'>>()
    for (const session of recent) {
      const parsed = parseDocId(session.docId)
      if (parsed.kind !== 'atom') continue
      if (parsed.workspaceId !== workspaceId) continue
      atomIds.add(parsed.atomId)
    }
    return Array.from(atomIds)
  },
})
