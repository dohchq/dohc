import {
  internalQuery,
  internalMutation,
  query,
  mutation,
} from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { v } from 'convex/values'
import { requireWorkspace } from './auth'
import { ORG_IDENTITY_PATH, PERSONAL_IDENTITY_PATH } from './inlineAtom'
// Track-3 P1 §6 retrofit: a skill or html atom's example ```query
// block falsely satisfied "vault has a populated dashboard" and
// flipped onboarding to MAINTENANCE incorrectly. Skip non-data
// atoms in the heuristic. (Codex r2 round-2 FAIL-§6.)
import {
  isHtmlAtomBody,
  isHtmlPath,
  isNonDataAtom,
  splitFrontmatter,
} from './atomId'

function randomLeaseOwner(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Explicit onboarding state (Phase 1 / Eng-EG6). The agent's tools
// drive transitions; the FRONTEND reads `state`/`progress` (public,
// owner-scoped) to gate the first-run experience and show live
// progress. Design: docs/strategy/onboarding-wedge-design.md (v5.1).
//
// Review hardening (carried from the original + the P1 design gate):
//  - readers use `.first()` not `.unique()`: a stray duplicate row
//    degrades gracefully instead of throwing and bricking onboarding.
//  - `_complete` enforces "never end empty" SERVER-SIDE (not prompt-
//    hope): refuses unless the canonical .context identity file AND a
//    populated dashboard exist.
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
  sourceCount: number
  hasCockpitView: boolean
  hasSetupRun: boolean
  hasDashboardWithQuery: boolean
  // P1 build-review fold (D6/D7 + Frame-6 handoff): the paths so the
  // wedge can SHOW the profile back (editable) + the hero artifact
  // assembling, and open the hero in <App/> at handoff (spec line
  // 263 — never an empty "Pick a page" frame at the wow moment).
  mePath: string | null
  cockpitPath: string | null
  runPath: string | null
  dashboardPath: string | null
}

export const PLACEHOLDER_SEED_MARKER = 'dohc:placeholder-seed'

function isPlaceholderSeed(body: string): boolean {
  return body.includes(PLACEHOLDER_SEED_MARKER)
}

function isRunPath(path: string): boolean {
  return /^\.?runs\//i.test(path)
}

function isSetupRunPath(path: string): boolean {
  return /^\.?runs\/setup\.md$/i.test(path)
}

function strippedBody(body: string): string {
  return splitFrontmatter(body ?? '').rest
}

function hasSourcesMetadata(body: string): boolean {
  const { fm } = splitFrontmatter(body ?? '')
  if (!fm) return false
  const inner = fm
    .replace(/^---[ \t]*\r?\n/, '')
    .replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '')
  return /^sources:[ \t]*(?:\S.*)?$/m.test(inner)
}

function hasLiveViewReference(body: string): boolean {
  const rest = strippedBody(body)
  return /{\s*=/.test(rest) || /```query\b/.test(rest)
}

function isCockpitPath(path: string): boolean {
  return /(^|\/)(home|dashboard|cockpit)\.html$/i.test(path)
}

function isSourceBackedCockpit(path: string, body: string): boolean {
  return (
    (isHtmlPath(path) || isHtmlAtomBody(body)) &&
    isCockpitPath(path) &&
    hasSourcesMetadata(body) &&
    hasLiveViewReference(body)
  )
}

function isRealSourceAtom(
  path: string,
  body: string,
  identityFile: string,
): boolean {
  return (
    path !== identityFile &&
    !path.startsWith('.context/') &&
    !isRunPath(path) &&
    !isPlaceholderSeed(body) &&
    !isNonDataAtom(path, body) &&
    strippedBody(body).trim().length > 0
  )
}

function isCompleteSetupRun(path: string, body: string): boolean {
  if (!isSetupRunPath(path) || isPlaceholderSeed(body)) return false
  const rest = strippedBody(body)
  return (
    /setup run/i.test(rest) &&
    /^##\s+objective\b/im.test(rest) &&
    /^##\s+sources?\b/im.test(rest) &&
    /^##\s+view\b/im.test(rest) &&
    /^##\s+next action\b/im.test(rest)
  )
}

/** org-plan §6 / §11-step-4 — workspace-kind branch. A workspace is an
 *  org iff its id matches a row in `orgs`; otherwise it's personal
 *  (workspaceId === WorkOS subject). Cached per call.
 *
 *  The identity-atom path differs by kind:
 *    personal → `.context/me.md`   (the user's about-themselves brief)
 *    org      → `.context/company.md` (the org's about-itself brief)
 *  This lets the same onboarding flow assemble the appropriate
 *  identity artifact without forking the whole pipeline. */
async function isOrgWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<boolean> {
  // orgs._id IS the workspace id for org workspaces. A personal
  // workspaceId is a WorkOS subject (e.g. `user_01ABC…`) — not a valid
  // Convex Id shape. `normalizeId` is the docs-blessed way to ask "is
  // this string a valid Id for this table" without a try/catch: it
  // returns the typed Id on hit, null on shape mismatch. Then a single
  // `db.get` confirms the row actually exists (defensive only — once
  // normalizeId returns an Id, get returns either the row or null).
  const orgId = ctx.db.normalizeId('orgs', workspaceId)
  if (orgId === null) return false
  const row = await ctx.db.get(orgId)
  return row !== null
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
  // Identity atom: personal ⇒ .context/me.md, org ⇒ .context/company.md.
  const identityFile = (await isOrgWorkspace(ctx, workspaceId))
    ? ORG_IDENTITY_PATH
    : PERSONAL_IDENTITY_PATH
  const me = atoms.find(
    (a) => a.path === identityFile && !isPlaceholderSeed(a.body),
  )
  const sourceAtoms = atoms.filter((a) =>
    isRealSourceAtom(a.path, a.body, identityFile),
  )
  const cockpits = atoms.filter(
    (a) => !isPlaceholderSeed(a.body) && isSourceBackedCockpit(a.path, a.body),
  )
  const setupRun = atoms.find((a) => isCompleteSetupRun(a.path, a.body))
  const legacyDashboards = atoms.filter(
    (a) =>
      !isPlaceholderSeed(a.body) &&
      !isNonDataAtom(a.path, a.body) &&
      a.body.includes('```query'),
  )
  const cockpit =
    cockpits.find((a) => /(^|\/)home\.html$/i.test(a.path)) ??
    cockpits.find((a) => /(^|\/)dashboard\.html$/i.test(a.path)) ??
    cockpits[0]
  // Compatibility aliases for the first-run handoff. The MVP floor is
  // now a source-backed HTML cockpit, but older UI callers still read
  // "dashboard" fields while this surface is being renamed.
  const legacyHero =
    cockpit ??
    legacyDashboards.find((a) =>
      /(^|\/)(dashboard|workspace|home|work|tracker)\b/i.test(a.path),
    ) ??
    legacyDashboards[0]
  const entities = await ctx.db
    .query('entities')
    .withIndex('by_workspace_type', (q) => q.eq('workspaceId', workspaceId))
    .take(200)
  return {
    entityCount: entities.length,
    hasMe: !!me,
    sourceCount: sourceAtoms.length,
    hasCockpitView: !!cockpit,
    hasSetupRun: !!setupRun,
    hasDashboardWithQuery: !!cockpit,
    mePath: me?.path ?? null,
    cockpitPath: cockpit?.path ?? null,
    runPath: setupRun?.path ?? null,
    dashboardPath: legacyHero?.path ?? null,
  }
}

async function completeWorkspaceOnboarding(
  ctx: MutationCtx,
  workspaceId: string,
) {
  const row = await onboardingRow(ctx, workspaceId)
  if (row?.completedAt) return null

  const p = await progressOf(ctx, workspaceId)
  if (!p.hasMe || p.sourceCount < 1 || !p.hasCockpitView) {
    const identityFile = (await isOrgWorkspace(ctx, workspaceId))
      ? ORG_IDENTITY_PATH
      : PERSONAL_IDENTITY_PATH
    throw new Error(
      `cannot finish onboarding: vault not populated yet ` +
        `(${identityFile}=${p.hasMe}, sources=${p.sourceCount}, source-backed-cockpit=${p.hasCockpitView}). ` +
      `Write source markdown, a populated source-backed home.html, and ${identityFile} first.`,
    )
  }
  if (!p.hasSetupRun) {
    throw new Error(
      'cannot finish onboarding: setup run missing. Write .runs/setup.md with objective, sources, view, and next action first.',
    )
  }
  if (row) await ctx.db.patch(row._id, { completedAt: Date.now() })
  else
    await ctx.db.insert('onboarding', {
      workspaceId,
      completedAt: Date.now(),
    })
  return null
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
 * independent of the model: requires the canonical .context identity
 * file AND a ```query dashboard. Throws otherwise so the agent cannot
 * finish empty.
 * Reuses `progressOf` so the gate's public `progress` can never lie.
 */
export const _complete = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    return completeWorkspaceOnboarding(ctx, workspaceId)
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
    const owner = randomLeaseOwner()
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
  // org-plan §5 + Jenny/ultrathink M3: pass activeWorkspaceId so the
  // Gate component sees the ACTIVE workspace's onboarding state. The
  // prior shape only ever returned personal's state, so an org user
  // who completed personal onboarding would be sent to <App/> for
  // their org even when org-onboarding hasn't run yet.
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }): Promise<OnboardingState> => {
    const ws = await requireWorkspace(ctx, activeWorkspaceId)
    return deriveState(await onboardingRow(ctx, ws))
  },
})

/** Owner-scoped live progress for the Stage-1 "your space is filling
 *  in" surface. Same helper as the never-empty invariant ⇒ the
 *  surface cannot claim more than the server will actually accept. */
export const progress = query({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }): Promise<OnboardingProgress> => {
    const ws = await requireWorkspace(ctx, activeWorkspaceId)
    return progressOf(ctx, ws)
  },
})

/** The quiet "explore on my own" escape. Sets `deferredAt` (distinct
 *  from `completedAt`) so the gate sends DONE|DEFERRED → App without
 *  faking completion and without touching the never-empty invariant
 *  (a deferred user is still resumable; `finish_onboarding` still
 *  requires a populated vault). Idempotent. */
export const defer = mutation({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const ws = await requireWorkspace(ctx, activeWorkspaceId)
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

/** Client recovery for a ready-but-still-IN_PROGRESS workspace.
 *  Fresh shared workspaces are seeded with the identity atom +
 *  dashboard before the client opens them. If the public progress
 *  invariant is already satisfied, the ready handoff can complete
 *  without waiting for an agent tool call. This reuses the exact same
 *  server floor as `_complete`; an empty workspace still cannot fake
 *  DONE. */
export const completeIfReady = mutation({
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const ws = await requireWorkspace(ctx, activeWorkspaceId)
    return completeWorkspaceOnboarding(ctx, ws)
  },
})
