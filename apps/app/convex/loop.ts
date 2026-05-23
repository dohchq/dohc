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
import { parseInlineAtomsFromMarkdown, MAP_PATH } from './inlineAtom'
import { resolveLiveTotalValue } from './liveTotals'
import { isLegacySkillPath, isNonDataAtom } from './atomId'

// Phase 4 Unit 4b — the weekly reconcile loop. Intent vs reality →
// an ADVISORY proposed move, approved at the edge (reviewed-by-
// default). Composes, doesn't duplicate: intent = author-typed value
// atoms in intent.md (markdown is truth), reality = the SAME
// resolveLiveTotalValue path as the editor's `{identifier}`. NEVER
// auto-applies anything (masterplan non-goal); a proposal is the
// owner's own loop artifact (its own table — never an atom/entity, so
// resolveWindow never sees it; no cross-desk path by construction).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// Epoch-week bucket — a STABLE, deterministic, calendar-edge-free
// idempotency key (the masterplan says "weekly", not "ISO week"). Two
// reconciles in the same 7-day bucket never double-propose.
const periodOf = (ts: number) => `w${Math.floor(ts / WEEK_MS)}`

// intent.md value atom `{goal_<id>: n}` pairs with rollup `{<id>}`.
const GOAL_RE = /^goal_([A-Za-z_][A-Za-z0-9_]*)$/
const RECONCILE_FANOUT_PAGE = 200
const PENDING_PROPOSALS_MAX = 100

// Unit 4c — the Map + gardening, folded into the weekly pass.
// R3 §6: MAP_PATH now imported from inlineAtom (single source of
// truth — was a private const here + a literal in liveTotals).
const MAP_SCAN_CAP = 5000
const GARDEN_ID = 'gardening:structure'
// Singleton/system notes are intentionally standalone — never flagged
// as orphans (that would be pure noise).
const NOT_ORPHAN = new Set([MAP_PATH, 'me.md', 'company.md', 'intent.md'])
// Track-3 P1: consolidated into the canonical `isLegacySkillPath`
// in convex/atomId.ts (single source — the §6 OR-compat term).
// (Local const removed; the import above + the §6.2 audit table.)
// Heuristic wikilink scan (advisory only — Map/gardening are
// suggestions, never data integrity or a cross-desk path; a regex is
// fine here, unlike the FROZEN atom grammar).
const WIKILINK = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
// Byte-bound the generated index so a big vault can't exceed Convex's
// document limit and throw inside the scheduled cron (Codex MED).
const MAP_MAX_LINKS_PER_NOTE = 12
const MAP_MAX_CHARS = 256_000
// Map summaries echo note text. Neutralise `{}` so a copied
// `Logged {billable: 10}` can NEVER be parsed as a real atom — the
// generated index must never be (or look like) a value source
// (Codex HIGH, defence in depth on top of excluding _map.md from
// value scans).
const firstProseLine = (body: string): string => {
  for (const raw of (body ?? '').split('\n')) {
    const line = raw
      .replace(/^#+\s*/, '')
      .replace(/\{/g, '(')
      .replace(/\}/g, ')')
      .trim()
    if (line) return line.length > 80 ? line.slice(0, 79) + '…' : line
  }
  return ''
}

type NoteRow = { path: string; body?: string; source?: string }

async function loadNotes(
  ctx: QueryCtx,
  workspaceId: string,
): Promise<{ overflow: true } | { overflow: false; notes: NoteRow[] }> {
  const rows = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(MAP_SCAN_CAP + 1)
  if (rows.length > MAP_SCAN_CAP) return { overflow: true } // fail-soft
  return {
    overflow: false,
    notes: rows.map((r) => ({ path: r.path, body: r.body, source: r.source })),
  }
}

/** Deterministic `_map.md` body for a fixed vault (folder → notes →
 *  one-line summary + outbound links). Generated artifact, clearly
 *  marked. */
function buildMapBody(notes: NoteRow[]): string {
  const indexed = notes
    .filter((n) => n.path !== MAP_PATH)
    .sort((a, b) => a.path.localeCompare(b.path))
  const byFolder = new Map<string, NoteRow[]>()
  for (const n of indexed) {
    const slash = n.path.lastIndexOf('/')
    const folder = slash >= 0 ? n.path.slice(0, slash) : '(root)'
    ;(byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(n)
  }
  // BUDGET-AWARE: accumulate with a running char budget and per-line
  // component caps; STOP before allocating past MAP_MAX_CHARS (Codex
  // MED — slicing AFTER join could allocate multi-GB first and OOM the
  // cron). Total allocation is bounded to ~MAP_MAX_CHARS by
  // construction.
  const cap = (s: string, n: number) =>
    s.length > n ? s.slice(0, n - 1) + '…' : s
  const out: string[] = [
    '# _map',
    '',
    '> Auto-maintained by dohc (regenerated weekly). This is a generated',
    "> index — edit your notes, not this file. Delete it and dohc",
    '> rebuilds it next pass.',
    '',
    `total notes: ${indexed.length}`,
    '',
  ]
  let used = out.reduce((a, l) => a + l.length + 1, 0)
  const TRUNC = '\n> … map truncated (vault too large for one index).\n'
  let truncated = false
  const tryPush = (line: string): boolean => {
    if (used + line.length + 1 > MAP_MAX_CHARS - TRUNC.length) {
      truncated = true
      return false
    }
    out.push(line)
    used += line.length + 1
    return true
  }
  outer: for (const folder of [...byFolder.keys()].sort()) {
    if (!tryPush(`## ${cap(folder, 200)}`) || !tryPush('')) break
    for (const n of byFolder.get(folder)!) {
      const summary = cap(firstProseLine(n.body ?? ''), 80)
      const links = [
        ...new Set(
          [...(n.body ?? '').matchAll(WIKILINK)].map((m) =>
            cap(m[1].trim(), 80),
          ),
        ),
      ].slice(0, MAP_MAX_LINKS_PER_NOTE)
      const linkHint = links.length ? ` → ${links.join(', ')}` : ''
      const line = `- [[${cap(n.path, 200)}]]${summary ? ` — ${summary}` : ''}${linkHint}`
      if (!tryPush(line)) break outer
    }
    if (!tryPush('')) break
  }
  let body = out.join('\n').trimEnd() + '\n'
  if (truncated) body += TRUNC
  return body
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
  const notes = loaded.notes.filter(
    (n) => n.path !== MAP_PATH && !isLegacySkillPath(n.path),
  )
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

/** Regenerate `_map.md`. Overwrites ONLY a dohc-authored map
 *  (`source==='agent'`); a user-authored OR unknown/legacy-source
 *  `_map.md` is left untouched (Codex LOW/MED — only overwrite what we
 *  provably own). Fail-soft on scan overflow and on a duplicate-row
 *  `_map.md` (a scheduled cron must NEVER throw — Codex MED). Reuses
 *  upsertAtomImpl ⇒ recoverability (prior map snapshotted to trash)
 *  for free. */
// Exported so onboarding._complete reuses the SAME deterministic
// builder (no parallel map logic — the anti-duplication discipline):
// a finished onboarding ALWAYS has a living Map (ai-os-ideas #1).
export async function regenerateMap(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<
  | 'written'
  | 'skipped-not-agent-owned'
  | 'skipped-ambiguous-map'
  | 'skipped-overflow'
> {
  // .take(2) (NOT .first()/.unique()): upsertAtomImpl does .unique()
  // internally and would THROW into the scheduled mutation on a
  // pathological duplicate (workspace,_map.md). Pre-detect + fail-soft.
  const existingRows = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q) =>
      q.eq('workspaceId', workspaceId).eq('path', MAP_PATH),
    )
    .take(2)
  if (existingRows.length > 1) return 'skipped-ambiguous-map'
  const existing = existingRows[0]
  // Only overwrite what we provably generated. source==='user' AND
  // any unknown/unset source ⇒ leave it (the editor always stamps
  // 'user' for user edits; a non-'agent' map is not ours to clobber).
  if (existing && existing.source !== 'agent') {
    return 'skipped-not-agent-owned'
  }
  const loaded = await loadNotes(ctx, workspaceId)
  if (loaded.overflow) return 'skipped-overflow'
  // file-org-v1 §2.3 (Track-4 D4.1a) — system atom path. Routes
  // through `_upsertSystem` which (1) bypasses the systemLocked
  // chokepoint with `allowSystemOverride:true` and (2) RE-ASSERTS
  // `systemLocked:true` on every refresh so an accidental flag
  // clear self-heals on the next loop tick. This is the SOLE
  // production caller of `_upsertSystem` (audit-by-grep enforced).
  await ctx.runMutation(internal.atoms._upsertSystem, {
    workspaceId,
    path: MAP_PATH,
    body: buildMapBody(loaded.notes),
    source: 'agent',
  })
  return 'written'
}

/**
 * Reconcile ONE workspace. Reads intent.md goals, resolves each
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
  reason?: 'no intent.md' | 'ambiguous intent.md'
}> {
    // .take(2) (not .unique()): a scheduled cron must NEVER throw on a
    // pathological duplicate (workspace,path) — fail-soft (Codex LOW).
    const intentRows = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', 'intent.md'),
      )
      .take(2)
    if (intentRows.length !== 1) {
      const reason =
        intentRows.length === 0
          ? ('no intent.md' as const)
          : ('ambiguous intent.md' as const)
      return { proposed: 0, reason }
    }
    const intent = intentRows[0]
    // Track-3 P1 r1-fold FAIL-2: if intent.md was authored as
    // `type: html`/`type: skill`/lives at a legacy `skills/*`
    // path (extremely unusual but adversarially reachable), it is
    // NOT a value source — the §6 unified contract says EVERY
    // value-scanner skips a non-data atom. Apply for consistency
    // (harmless named no-op for normal `intent.md`).
    if (isNonDataAtom(intent.path, intent.body ?? '')) {
      return { proposed: 0, reason: 'no intent.md' as const }
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
 * Unit 4c — fold the Map + gardening into the weekly pass for ONE
 * workspace. Regenerates `_map.md` (recoverable, never clobbers a
 * user-authored map) and, if there are own-desk structural issues,
 * upserts ONE idempotent advisory gardening proposal per
 * (workspace, epoch-week). NEVER deletes/auto-applies (masterplan
 * non-goal) — the only note write is the regenerated `_map.md`
 * (a generated index, not user prose), via `_upsertSystem` so the
 * prior map is snapshotted to trash AND the row stays `systemLocked`.
 */
async function gardenAndMapImpl(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<{ mapRegen: unknown; gardening: 0 | 1 }> {
    const mapRegen = await regenerateMap(ctx, workspaceId)

    const summary = await detectGardenIssues(ctx, workspaceId)
    if (!summary) return { mapRegen, gardening: 0 as const }

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
    if (existing) return { mapRegen, gardening: 0 as const }

    // Persist only own-desk structural facts (note paths) — no
    // cross-desk value (the Codex-HIGH cache concern was cross-desk
    // live-totals). Re-evaluated LIVE at digest, dropped when tidied.
    await ctx.db.insert('proposals', {
      workspaceId,
      period,
      identifier: GARDEN_ID,
      kind: 'gardening' as const,
      summary,
      status: 'pending',
      createdAt: Date.now(),
    })
    return { mapRegen, gardening: 1 as const }
}

export const _gardenAndMap = internalMutation({
  args: { workspaceId: v.string() },
  handler: (ctx, { workspaceId }) => gardenAndMapImpl(ctx, workspaceId),
})

// ── org-plan §5/§13 Phase C — DEBOUNCED `_map.md` regen ──────────────
//
// Goal: rapid edits coalesce to ONE regen per `REGEN_DEBOUNCE_MS`
// window per workspace, so the map "feels in sync" without the
// 7-day cron lag and without a regen-per-keystroke storm.
//
// Mechanism: `mapRegenSchedule` row per workspace tracks the next
// pending regen's `scheduledFor` timestamp + the scheduler job id.
// Triggers (atoms.upsert/move/remove + folders.create/move/remove)
// call `scheduleMapRegen`, which:
//   - if a pending schedule is still in the future → no-op (coalesce)
//   - else inserts/patches the row and schedules `_gardenAndMapDebounced`
//     for `now + REGEN_DEBOUNCE_MS`.
// The scheduled mutation deletes its own row (so the next trigger
// re-arms) and runs `gardenAndMapImpl`.

export const REGEN_DEBOUNCE_MS = 2_000

export async function scheduleMapRegen(
  ctx: MutationCtx,
  workspaceId: string,
): Promise<void> {
  const existing = await ctx.db
    .query('mapRegenSchedule')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .unique()
  const now = Date.now()
  // Already pending in the future ⇒ coalesce (do nothing).
  if (existing && existing.scheduledFor > now) return

  const scheduledFor = now + REGEN_DEBOUNCE_MS
  const jobId = await ctx.scheduler.runAfter(
    REGEN_DEBOUNCE_MS,
    internal.loop._gardenAndMapDebounced,
    { workspaceId },
  )
  if (existing) {
    await ctx.db.patch(existing._id, { scheduledFor, scheduledJobId: jobId })
  } else {
    await ctx.db.insert('mapRegenSchedule', {
      workspaceId,
      scheduledFor,
      scheduledJobId: jobId,
    })
  }
}

export const _gardenAndMapDebounced = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    // Delete the schedule row FIRST so a trigger arriving while regen
    // runs can re-arm immediately (otherwise the trigger would see the
    // row still present + scheduledFor <= now and would no-op the
    // wrong way, missing the regen). Workspace-scoped lookup; no
    // cross-tenant exposure.
    const row = await ctx.db
      .query('mapRegenSchedule')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .unique()
    if (row) await ctx.db.delete(row._id)
    return await gardenAndMapImpl(ctx, workspaceId)
  },
})

// ── P4 public surface (design loop-ux v2 §4) — owner-scoped wrappers;
// workspace STRICTLY from requireWorkspace (never a client arg —
// C1/L8). listPending/accept/dismiss delegate to the shared impls
// (agent path ≡ public path; loop.test.ts the proof). runNow is a
// NEW owner mutation calling the SAME two internals the agent
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
 * internals (`reconcileImpl` then `gardenAndMapImpl`) and returns
 * their RAW counts + reconcile's `reason`. Idempotent per epoch-week
 * (engine). ADVISORY: writes ONLY the `proposals` table + regenerates
 * the agent-owned `_map.md` — never user atoms/entities/user note
 * bodies. The panel may say "nothing new" ONLY when
 * `proposed === 0 && gardening === 0`.
 */
export const runNow = mutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    proposed: number
    gardening: 0 | 1
    reason?: 'no intent.md' | 'ambiguous intent.md'
  }> => {
    const ws = await requireWorkspace(ctx)
    const rec = await reconcileImpl(ctx, ws)
    const gm = await gardenAndMapImpl(ctx, ws)
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
 * schedules the FULL weekly pass (reconcile + map/gardening) per
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
      await ctx.scheduler.runAfter(0, internal.loop._gardenAndMap, {
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
