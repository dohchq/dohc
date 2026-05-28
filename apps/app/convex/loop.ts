import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'
import {
  parseInlineAtomsFromMarkdown,
  INTENT_PATH,
  ORG_IDENTITY_PATH,
  PERSONAL_IDENTITY_PATH,
} from './inlineAtom'
import { resolveLiveTotalValue } from './liveTotals'
import { isLegacySkillPath, isNonDataAtom } from './atomId'

// Phase 4 Unit 4b — the weekly reconcile loop. Intent vs reality →
// an ADVISORY proposed move, approved at the edge (reviewed-by-
// default). Composes, doesn't duplicate: intent = author-typed value
// atoms in .context/intent.md (markdown is truth), reality = the SAME
// resolveLiveTotalValue path as the editor's `{identifier}`. NEVER
// auto-applies anything (masterplan non-goal); a proposal is the
// owner's own loop artifact (its own table — never an atom/entity, so
// resolveWindow never sees it; no cross-desk path by construction).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// Epoch-week bucket — a STABLE, deterministic, calendar-edge-free
// idempotency key (the masterplan says "weekly", not "ISO week"). Two
// reconciles in the same 7-day bucket never double-propose.
const periodOf = (ts: number) => `w${Math.floor(ts / WEEK_MS)}`

// .context/intent.md value atom `{goal_<id>: n}` pairs with rollup `{<id>}`.
const GOAL_RE = /^goal_([A-Za-z_][A-Za-z0-9_]*)$/
const RECONCILE_FANOUT_PAGE = 200
const PENDING_PROPOSALS_MAX = 100

const GARDEN_SCAN_CAP = 5000
const GARDEN_ID = 'gardening:structure'
// Singleton/system notes are intentionally standalone — never flagged
// as orphans (that would be pure noise).
const NOT_ORPHAN = new Set([
  PERSONAL_IDENTITY_PATH,
  ORG_IDENTITY_PATH,
  INTENT_PATH,
])
// Track-3 P1: consolidated into the canonical `isLegacySkillPath`
// in convex/atomId.ts (single source — the §6 OR-compat term).
// (Local const removed; the import above + the §6.2 audit table.)
// Heuristic wikilink scan (advisory only — gardening suggestions are never
// data integrity or a cross-desk path; a regex is fine here, unlike the
// FROZEN atom grammar).
const WIKILINK = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
type NoteRow = { path: string; body?: string }

async function loadNotes(
  ctx: QueryCtx,
  workspaceId: string,
): Promise<{ overflow: true } | { overflow: false; notes: NoteRow[] }> {
  const rows = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(GARDEN_SCAN_CAP + 1)
  if (rows.length > GARDEN_SCAN_CAP) return { overflow: true } // fail-soft
  return {
    overflow: false,
    notes: rows.map((r) => ({ path: r.path, body: r.body })),
  }
}

/** Detect own-desk structural issues (orphans, exact duplicates).
 *  Advisory + heuristic; own-desk only (paths) — no cross-desk value,
 *  so its summary is SAFE to persist. Returns a concise summary or
 *  null (no issues / can't compute → fail-soft, no proposal). */
async function detectGardenIssues(
  ctx: QueryCtx,
  workspaceId: string,
): Promise<string | null> {
  const loaded = await loadNotes(ctx, workspaceId)
  if (loaded.overflow) return null // can't prove → don't propose
  const notes = loaded.notes.filter((n) => !isLegacySkillPath(n.path))
  if (notes.length === 0) return null

  // outbound + inbound wikilink degree (match on full path OR basename)
  const base = (p: string) => {
    const s = p.lastIndexOf('/')
    return (s >= 0 ? p.slice(s + 1) : p).replace(/\.md$/, '')
  }
  const linkedTo = new Set<string>()
  const outDeg = new Map<string, number>()
  for (const n of notes) {
    const targets = [...(n.body ?? '').matchAll(WIKILINK)].map((m) =>
      m[1].trim(),
    )
    outDeg.set(n.path, targets.length)
    for (const tgt of targets) linkedTo.add(tgt)
  }
  const orphans = notes
    .filter(
      (n) =>
        !NOT_ORPHAN.has(n.path) &&
        (outDeg.get(n.path) ?? 0) === 0 &&
        !linkedTo.has(n.path) &&
        !linkedTo.has(base(n.path)),
    )
    .map((n) => n.path)
    .sort()

  // exact-duplicate bodies (trimmed)
  const byBody = new Map<string, string[]>()
  for (const n of notes) {
    const k = (n.body ?? '').trim()
    if (!k) continue
    ;(byBody.get(k) ?? byBody.set(k, []).get(k)!).push(n.path)
  }
  const dups = [...byBody.values()]
    .filter((ps) => ps.length > 1)
    .map((ps) => ps.sort().join(' = '))
    .sort()

  if (orphans.length === 0 && dups.length === 0) return null
  const parts: string[] = []
  if (orphans.length)
    parts.push(
      `${orphans.length} orphan note(s) (no links in or out): ${orphans
        .slice(0, 20)
        .join(', ')}${orphans.length > 20 ? ', …' : ''} — link them in, or archive`,
    )
  if (dups.length)
    parts.push(
      `${dups.length} exact-duplicate group(s): ${dups
        .slice(0, 10)
        .join('; ')} — keep one`,
    )
  return `Tidy-up suggestion (advisory — dohc deletes nothing): ${parts.join(' | ')}`
}

/**
 * Reconcile ONE workspace. Reads .context/intent.md goals, resolves each
 * paired live-total, and for a behind-goal metric upserts ONE pending
 * proposal — idempotent per (workspace, epoch-week, identifier). Pure
 * w.r.t. user data: only writes the `proposals` table, never a note
 * body / atom / entity (UC-3 + no-auto-apply hold).
 */
// Shared impl (P2 confirmWithheldForImpl precedent): the internal
// cron path AND the public owner path delegate here — ONE code path,
// behaviour-preserving; the locked loop.test.ts stays the proof.
async function reconcileImpl(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<{
  proposed: number
  reason?: 'no .context/intent.md' | 'ambiguous .context/intent.md'
}> {
    // .take(2) (not .unique()): a scheduled cron must NEVER throw on a
    // pathological duplicate (workspace,path) — fail-soft (Codex LOW).
    const intentRows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', INTENT_PATH),
      )
      .take(2)
    if (intentRows.length !== 1) {
      const reason =
        intentRows.length === 0
          ? ('no .context/intent.md' as const)
          : ('ambiguous .context/intent.md' as const)
      return { proposed: 0, reason }
    }
    const intent = intentRows[0]
    // Track-3 P1 r1-fold FAIL-2: if .context/intent.md was authored as
    // `type: html`/`type: skill`/lives at a legacy `skills/*`
    // path (extremely unusual but adversarially reachable), it is
    // NOT a value source — the §6 unified contract says EVERY
    // value-scanner skips a non-data atom. Apply for consistency
    // (harmless named no-op for normal `.context/intent.md`).
    if (isNonDataAtom(intent.path, intent.body ?? '')) {
      return { proposed: 0, reason: 'no .context/intent.md' as const }
    }

    const period = periodOf(Date.now())
    let proposed = 0
    const seen = new Set<string>()

    // PROSE ONLY — a goal inside a code block is not a goal (FROZEN
    // contract; Phase-4 review Codex MED).
    for (const atom of parseInlineAtomsFromMarkdown(intent.body ?? '')) {
      if (atom.kind !== 'value') continue
      const m = GOAL_RE.exec(atom.key)
      if (!m) continue
      if (typeof atom.value !== 'number' || !Number.isFinite(atom.value)) {
        continue // a goal must be a finite number
      }
      const identifier = m[1]
      if (seen.has(identifier)) continue // first goal_<id> wins
      seen.add(identifier)
      const goal = atom.value

      const actual = await resolveLiveTotalValue(ctx, workspaceId, identifier)
      if (actual === null) continue // can't compare → no proposal
      if (actual >= goal) continue // on/above goal → nothing to surface

      // Idempotent: one proposal per (workspace, period, identifier).
      // .first() (not .unique()): never throws; "already proposed
      // this week?" only needs existence.
      const existing = await ctx.db
        .query('proposals')
        .withIndex('by_workspace_period_identifier', (q) =>
          q
            .eq('workspaceId', workspaceId)
            .eq('period', period)
            .eq('identifier', identifier),
        )
        .first()
      if (existing) continue

      // Store ONLY the marker + the workspace's OWN goal. NEVER the
      // cross-desk `actual`/`message` (a cached cross-desk value would
      // survive grant revocation → leak; Codex HIGH). `actual` is
      // re-resolved LIVE + grant-gated at digest time.
      await ctx.db.insert('proposals', {
        workspaceId,
        period,
        identifier,
        kind: 'metric' as const,
        goal,
        status: 'pending',
        createdAt: Date.now(),
      })
      proposed++
    }
    return { proposed }
}

export const _reconcile = internalMutation({
  args: { workspaceId: v.string() },
  handler: (ctx, { workspaceId }) => reconcileImpl(ctx, workspaceId),
})

/**
 * The reviewed-by-default digest: this workspace's pending proposals,
 * each with `actual` RE-RESOLVED LIVE through the fully grant-gated
 * resolveLiveTotalValue (NEVER a stored snapshot — Codex HIGH). A
 * proposal silently drops from the digest if it is no longer
 * actionable: actual is null (grant revoked / withheld / unresolvable)
 * OR actual >= goal (caught up). So a revoked cross-desk grant can
 * never surface a stale cross-desk number here. Bounded; truncation
 * reported (truncation counted on the raw pending rows, before the
 * live filter, so it never under-reports "there is more").
 */
async function pendingProposalsImpl(
  ctx: QueryCtx,
  workspaceId: string,
) {
    const rows = await ctx.db
      .query('proposals')
      .withIndex('by_workspace_status', (q) =>
        q.eq('workspaceId', workspaceId).eq('status', 'pending'),
      )
      .order('desc')
      .take(PENDING_PROPOSALS_MAX + 1)
    const truncated = rows.length > PENDING_PROPOSALS_MAX
    const items: Array<{
      id: string
      kind: 'metric' | 'gardening'
      identifier: string
      message: string
      createdAt: number
      goal?: number
      actual?: number
    }> = []
    // Re-evaluate every kind LIVE; both drop when no longer applicable
    // (metric: revoked/withheld/caught-up; gardening: tidied up). The
    // digest is never stale and never serves a cross-desk snapshot.
    let gardenSummary: string | null | undefined
    for (const r of rows.slice(0, PENDING_PROPOSALS_MAX)) {
      if (r.kind === 'gardening') {
        if (gardenSummary === undefined) {
          gardenSummary = await detectGardenIssues(ctx, workspaceId)
        }
        if (!gardenSummary) continue // tidied up since → drop
        items.push({
          id: r._id,
          kind: 'gardening',
          identifier: r.identifier,
          message: gardenSummary,
          createdAt: r.createdAt,
        })
        continue
      }
      // metric
      if (typeof r.goal !== 'number') continue // malformed → drop
      const actual = await resolveLiveTotalValue(ctx, workspaceId, r.identifier)
      if (actual === null || actual >= r.goal) continue // stale/caught-up/un-entitled
      items.push({
        id: r._id,
        kind: 'metric',
        identifier: r.identifier,
        goal: r.goal,
        actual,
        message: `Behind on {${r.identifier}}: goal ${r.goal}, actual ${actual} (${r.goal - actual} to go). Review and decide — accepting is advisory, dohc changes nothing automatically.`,
        createdAt: r.createdAt,
      })
    }
    return { truncated, items }
}

export const _pendingProposals = internalQuery({
  args: { workspaceId: v.string() },
  handler: (ctx, { workspaceId }) => pendingProposalsImpl(ctx, workspaceId),
})

/**
 * Approve at the edge: accept or dismiss a pending proposal. Accept is
 * ADVISORY ONLY — it records the owner's decision and changes NO user
 * data (masterplan non-goal: no auto-apply). Workspace-scoped: cannot
 * act on another workspace's proposal.
 */
async function resolveProposalImpl(
  ctx: MutationCtx,
  workspaceId: string,
  proposalId: Id<'proposals'>,
  accept: boolean,
) {
    const row = await ctx.db.get(proposalId)
    if (!row || row.workspaceId !== workspaceId) {
      return { ok: false as const, reason: 'not-found' }
    }
    if (row.status !== 'pending') {
      return { ok: false as const, reason: `not-pending (${row.status})` }
    }
    await ctx.db.patch(proposalId, {
      status: accept ? 'accepted' : 'dismissed',
    })
    return { ok: true as const, status: accept ? 'accepted' : 'dismissed' }
}

export const _resolveProposal = internalMutation({
  args: {
    workspaceId: v.string(),
    proposalId: v.id('proposals'),
    accept: v.boolean(),
  },
  handler: (ctx, { workspaceId, proposalId, accept }) =>
    resolveProposalImpl(ctx, workspaceId, proposalId, accept),
})

/**
 * Fold gardening into the weekly pass for ONE workspace. If there are
 * own-desk structural issues, upsert ONE idempotent advisory gardening
 * proposal per (workspace, epoch-week). NEVER deletes or auto-applies.
 */
async function gardenImpl(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<{ gardening: 0 | 1 }> {
    const summary = await detectGardenIssues(ctx, workspaceId)
    if (!summary) return { gardening: 0 as const }

    const period = periodOf(Date.now())
    const existing = await ctx.db
      .query('proposals')
      .withIndex('by_workspace_period_identifier', (q) =>
        q
          .eq('workspaceId', workspaceId)
          .eq('period', period)
          .eq('identifier', GARDEN_ID),
      )
      .first()
    if (existing) return { gardening: 0 as const }

    // Persist only own-desk structural facts (note paths). Re-evaluated
    // LIVE at digest, dropped when tidied.
    await ctx.db.insert('proposals', {
      workspaceId,
      period,
      identifier: GARDEN_ID,
      kind: 'gardening' as const,
      summary,
      status: 'pending',
      createdAt: Date.now(),
    })
    return { gardening: 1 as const }
}

export const _garden = internalMutation({
  args: { workspaceId: v.string() },
  handler: (ctx, { workspaceId }) => gardenImpl(ctx, workspaceId),
})

// ── P4 public surface (design loop-ux v2 §4) — owner-scoped wrappers;
// workspace STRICTLY from requireWorkspace (never a client arg —
// C1/L8). listPending/accept/dismiss delegate to the shared impls
// (agent path ≡ public path; loop.test.ts the proof). runNow is a
// NEW owner mutation calling the SAME internals the agent
// run_loop body calls, returning their RAW results.

/** Owner's pending advisory digest (live-resolved + grant-gated by
 *  the shared impl — cannot desync from the engine). */
export const listPending = query({
  args: {},
  handler: async (ctx) => {
    const ws = await requireWorkspace(ctx)
    return pendingProposalsImpl(ctx, ws)
  },
})

/** Accept (advisory: pure status flip — writes NO user data). */
export const accept = mutation({
  args: { proposalId: v.id('proposals') },
  handler: async (ctx, { proposalId }) => {
    const ws = await requireWorkspace(ctx)
    return resolveProposalImpl(ctx, ws, proposalId, true)
  },
})

/** Dismiss (terminal for THIS proposal; a still-behind goal yields a
 *  fresh proposal next epoch-week — engine behaviour, not silenced). */
export const dismiss = mutation({
  args: { proposalId: v.id('proposals') },
  handler: async (ctx, { proposalId }) => {
    const ws = await requireWorkspace(ctx)
    return resolveProposalImpl(ctx, ws, proposalId, false)
  },
})

/**
 * Run the weekly pass NOW for the caller's OWN workspace — the
 * clickable twin of the agent `run_loop` tool (NOT a body-extract:
 * that tool's body returns a formatted string). Calls the SAME two
 * internals (`reconcileImpl` then `gardenImpl`) and returns
 * their RAW counts + reconcile's `reason`. Idempotent per epoch-week
 * (engine). ADVISORY: writes ONLY the `proposals` table — never user
 * atoms/entities/user note bodies. The panel may say "nothing new"
 * ONLY when `proposed === 0 && gardening === 0`.
 */
export const runNow = mutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    proposed: number
    gardening: 0 | 1
    reason?: 'no .context/intent.md' | 'ambiguous .context/intent.md'
  }> => {
    const ws = await requireWorkspace(ctx)
    const rec = await reconcileImpl(ctx, ws)
    const gm = await gardenImpl(ctx, ws)
    // OMIT `reason` on the success path — Convex objects must not
    // carry an explicit `undefined` field (Codex blocker); the
    // contract is `reason?` (absent), not `reason: undefined`.
    return rec.reason
      ? { proposed: rec.proposed, gardening: gm.gardening, reason: rec.reason }
      : { proposed: rec.proposed, gardening: gm.gardening }
  },
})

/**
 * Weekly cron fan-out. Enumerates the `onboarding` table (one row per
 * active workspace — the existing per-workspace registry) and
 * schedules the FULL weekly pass (reconcile + gardening) per
 * workspace. Batched + self-rescheduling (same terminating + complete
 * pattern as captures._purgeCaptures). Both are idempotent per
 * epoch-week, so a duplicate onboarding row double-scheduling is
 * absorbed harmlessly.
 */
export const _reconcileAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('onboarding')
      .paginate({ numItems: RECONCILE_FANOUT_PAGE, cursor: cursor ?? null })
    for (const row of page.page) {
      await ctx.scheduler.runAfter(0, internal.loop._reconcile, {
        workspaceId: row.workspaceId,
      })
      await ctx.scheduler.runAfter(0, internal.loop._garden, {
        workspaceId: row.workspaceId,
      })
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.loop._reconcileAll, {
        cursor: page.continueCursor,
      })
    }
    return { scheduled: page.page.length, done: page.isDone }
  },
})
