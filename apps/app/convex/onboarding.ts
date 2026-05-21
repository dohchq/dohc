import {
  internalQuery,
  internalMutation,
  query,
  mutation,
} from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import { v } from 'convex/values'
import { requireWorkspace } from './auth'
import { regenerateMap } from './loop'
// Track-3 P1 §6 retrofit: a skill or html atom's example ```query
// block falsely satisfied "vault has a populated dashboard" and
// flipped onboarding to MAINTENANCE incorrectly. Skip non-data
// atoms in the heuristic. (Codex r2 round-2 FAIL-§6.)
import { isNonDataAtom } from './atomId'

// Explicit onboarding state (Phase 1 / Eng-EG6). The agent's tools
// drive transitions; the FRONTEND reads `state`/`progress` (public,
// owner-scoped) to gate the first-run experience and show live
// progress. Design: docs/strategy/onboarding-wedge-design.md (v5.1).
//
// Review hardening (carried from the original + the P1 design gate):
//  - readers use `.first()` not `.unique()`: a stray duplicate row
//    degrades gracefully instead of throwing and bricking onboarding.
//  - `_complete` enforces "never end empty" SERVER-SIDE (not prompt-
//    hope): refuses unless me.md AND a populated dashboard exist.
//  - the start LEASE is a single-document atomic CAS on THIS row's
//    own `kickoffAt`, kept fresh by an action-driven heartbeat;
//    recovery is staleness-only (survives a HARD process kill). No
//    cross-component read; no dependence on the agent message status.

export type OnboardingState = 'NEW' | 'IN_PROGRESS' | 'DONE' | 'DEFERRED'

type OnboardingRow = {
  completedAt?: number
  deferredAt?: number
} | null

/** THE single source of truth for state. Precedence (deliberate,
 *  deterministic): DONE > DEFERRED > IN_PROGRESS > NEW. Used by BOTH
 *  the internal `_state` (agent) and the public `state` (gate) so
 *  they can never disagree. */
export function deriveState(row: OnboardingRow): OnboardingState {
  if (!row) return 'NEW'
  if (row.completedAt) return 'DONE'
  if (row.deferredAt) return 'DEFERRED'
  return 'IN_PROGRESS'
}

async function onboardingRow(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
) {
  return ctx.db
    .query('onboarding')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .first()
}

export type OnboardingProgress = {
  entityCount: number
  hasMe: boolean
  hasDashboardWithQuery: boolean
  // P1 build-review fold (D6/D7 + Frame-6 handoff): the paths so the
  // wedge can SHOW the profile back (editable) + the hero artifact
  // assembling, and open the hero in <App/> at handoff (spec line
  // 263 — never an empty "Pick a page" frame at the wow moment).
  mePath: string | null
  dashboardPath: string | null
}

/** The SAME helper `_complete` uses, so the public `progress` query
 *  and the never-empty invariant can never desync. Bounded scans. */
export async function progressOf(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<OnboardingProgress> {
  const atoms = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .take(500)
  const me = atoms.find(
    (a) => a.path === 'me.md' || a.path.endsWith('/me.md'),
  )
  const dashboards = atoms.filter(
    (a) => !isNonDataAtom(a.path, a.body) && a.body.includes('```query'),
  )
  // Prefer a hero-named artifact (dashboard/workspace/home/work/...),
  // else the first ```query atom — dohc writes exactly one hero.
  const hero =
    dashboards.find((a) =>
      /(^|\/)(dashboard|workspace|home|work|tracker)\b/i.test(a.path),
    ) ?? dashboards[0]
  const entities = await ctx.db
    .query('entities')
    .withIndex('by_workspace_type', (q) => q.eq('workspaceId', workspaceId))
    .take(200)
  return {
    entityCount: entities.length,
    hasMe: !!me,
    hasDashboardWithQuery: !!hero,
    mePath: me?.path ?? null,
    dashboardPath: hero?.path ?? null,
  }
}

// ── internal (agent-driven) ─────────────────────────────────────────

export const _state = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) =>
    deriveState(await onboardingRow(ctx, workspaceId)),
})

export const _begin = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    if (!(await onboardingRow(ctx, workspaceId)))
      await ctx.db.insert('onboarding', { workspaceId })
    return null
  },
})

/**
 * Mark onboarding DONE — ONLY if the vault is genuinely populated.
 * The "never end empty" wedge promise is a DB invariant here,
 * independent of the model: requires `me.md` AND a ```query
 * dashboard. Throws otherwise so the agent cannot finish empty.
 * Reuses `progressOf` so the gate's public `progress` can never lie.
 */
export const _complete = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    const p = await progressOf(ctx, workspaceId)
    if (!p.hasMe || !p.hasDashboardWithQuery) {
      throw new Error(
        `cannot finish onboarding: vault not populated yet ` +
          `(me.md=${p.hasMe}, dashboard-with-query=${p.hasDashboardWithQuery}). ` +
          `Write a populated dashboard and me.md first.`,
      )
    }
    // ai-os-ideas #1 (the Map): a finished onboarding gets a living
    // navigable index, server-guaranteed (not prompt-hope), reusing
    // the loop's deterministic builder. regenerateMap handles its
    // KNOWN conditions (dup/overflow/not-owned) but its upsert (+ the
    // capture pipeline it triggers) can still throw for other
    // reasons. The Map is an ENHANCEMENT; finishing onboarding is the
    // make-or-break wedge — map-gen must NEVER abort finish. Wrap it:
    // on any failure, degrade silently (the weekly loop regenerates
    // _map.md anyway). Catching internally does NOT roll back this
    // mutation's transaction in Convex (only a thrown handler does).
    try {
      await regenerateMap(ctx, workspaceId)
    } catch {
      /* never block finish on the optional Map */
    }
    const row = await onboardingRow(ctx, workspaceId)
    if (row) await ctx.db.patch(row._id, { completedAt: Date.now() })
    else
      await ctx.db.insert('onboarding', {
        workspaceId,
        completedAt: Date.now(),
      })
    return null
  },
})

// ── the start LEASE (single-document atomic CAS + heartbeat) ────────
// design v5/v5.1: claim reads+writes ONLY this row in one serializable
// mutation (Convex OCC ⇒ exactly one concurrent winner; NO
// cross-component read). The running stream heartbeats `kickoffAt`
// every step AND (throttled) every delta — action-driven, so it STOPS
// the instant the process dies. Reclaim iff stale past STALE_MS, which
// bounds "no stream activity", not total run time ⇒ a live multi-
// minute run is never preempted; a hard-killed run recovers without
// any dependence on the library finalizing `failed`.

export const ONBOARDING_STALE_MS = 90_000

export const claimKickoff = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (
    ctx,
    { workspaceId },
  ): Promise<{ won: boolean; owner: string | null }> => {
    const row = await onboardingRow(ctx, workspaceId)
    const now = Date.now()
    const fresh =
      !!row &&
      !!row.kickoffAt &&
      now - row.kickoffAt <= ONBOARDING_STALE_MS
    if (fresh) return { won: false, owner: null }
    const owner = crypto.randomUUID()
    if (row)
      await ctx.db.patch(row._id, { kickoffAt: now, kickoffOwner: owner })
    else
      await ctx.db.insert('onboarding', {
        workspaceId,
        kickoffAt: now,
        kickoffOwner: owner,
      })
    return { won: true, owner }
  },
})

/** Action-driven heartbeat. Owner-guarded: a superseded run (whose
 *  owner nonce was overwritten by a later winner) MUST NOT keep the
 *  lease alive — so a stale-then-reclaimed thread can't be pinned by
 *  a zombie. No-ops if the owner no longer matches. */
export const heartbeat = internalMutation({
  args: { workspaceId: v.string(), owner: v.string() },
  handler: async (ctx, { workspaceId, owner }) => {
    const row = await onboardingRow(ctx, workspaceId)
    if (row && row.kickoffOwner === owner && !row.completedAt) {
      await ctx.db.patch(row._id, { kickoffAt: Date.now() })
    }
    return null
  },
})

// ── public (frontend gate + live progress + escape) ─────────────────

/** Owner-scoped first-run gate signal. Read-only. Returns undefined
 *  to the client only while auth/token bootstraps (Convex semantics);
 *  the gate treats undefined as "still loading". */
export const state = query({
  args: {},
  handler: async (ctx): Promise<OnboardingState> => {
    const ws = await requireWorkspace(ctx)
    return deriveState(await onboardingRow(ctx, ws))
  },
})

/** Owner-scoped live progress for the Stage-1 "your space is filling
 *  in" surface. Same helper as the never-empty invariant ⇒ the
 *  surface cannot claim more than the server will actually accept. */
export const progress = query({
  args: {},
  handler: async (ctx): Promise<OnboardingProgress> => {
    const ws = await requireWorkspace(ctx)
    return progressOf(ctx, ws)
  },
})

/** The quiet "explore on my own" escape. Sets `deferredAt` (distinct
 *  from `completedAt`) so the gate sends DONE|DEFERRED → App without
 *  faking completion and without touching the never-empty invariant
 *  (a deferred user is still resumable; `finish_onboarding` still
 *  requires a populated vault). Idempotent. */
export const defer = mutation({
  args: {},
  handler: async (ctx) => {
    const ws = await requireWorkspace(ctx)
    const row = await onboardingRow(ctx, ws)
    if (!row) {
      await ctx.db.insert('onboarding', {
        workspaceId: ws,
        deferredAt: Date.now(),
      })
    } else if (!row.completedAt && !row.deferredAt) {
      await ctx.db.patch(row._id, { deferredAt: Date.now() })
    }
    return null
  },
})
