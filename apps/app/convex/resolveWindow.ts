// resolveWindow — the SOLE cross-person read primitive.
//
// Contract: docs/strategy/tenancy-authz-v0.md §4 + §6b. Pure
// authorization+projection core. Lives in `convex/` so the Phase-3
// adapter (`convex/windows.ts`) imports the SAME tested function —
// no parallel/dead copy. `src/lib/resolveWindow.ts` re-exports this
// for the UI + the existing T5 property tests. Nothing else may read
// another workspace's data; it has no free-text/DSL input, so the
// LLM-authored query path can never cross a desk boundary.

export type WorkspaceId = string

/** A stored author-typed value atom (the only thing a window exposes).
 *  `ownerWorkspaceId` is the desk it lives on. */
export type StoredAtom = {
  ownerWorkspaceId: WorkspaceId
  key: string
  value: string | number | boolean
}

/** Declarative window definition (data, not code). */
export type WindowDef = {
  id: string
  ownerWorkspaceId: WorkspaceId
  /** allowlist: ONLY these atom keys are ever exposed through it */
  selector: { keys: string[] }
  /** declarative reshape applied AFTER authz + selection */
  shape?: {
    rename?: Record<string, string>
    aggregate?: { key: string; op: 'sum' | 'count'; as: string }
  }
}

/** An explicit, revocable grant. Absence ⇒ DENY. */
export type Grant = { windowId: string; viewerWorkspaceId: WorkspaceId }

export type Stores = {
  windows: ReadonlyArray<WindowDef>
  grants: ReadonlyArray<Grant>
  atoms: ReadonlyArray<StoredAtom>
  /**
   * Reviewed-by-default gate (Phase 2 keystone, enforced HERE — the
   * sole cross-person primitive — so it is structural, not prompt-
   * hope). Each entry is `${ownerWorkspaceId} ${key}` for a value
   * whose capture is NOT yet confirmed. Such a value may live on the
   * owner's OWN desk but is withheld from EVERY cross-desk window
   * until confirmed.
   *
   * ADAPTER CONTRACT (§6b): convex/windows.ts MUST populate this from
   * `captures` where status != 'confirmed', AND additionally exclude
   * unreviewed entities at the source (defence in depth). The adapter
   * test asserts the join.
   */
  unreviewed?: ReadonlyArray<string>
}

export const unreviewedKey = (owner: string, key: string) =>
  `${owner} ${key}`

export type ResolveRequest = {
  windowId: string
  viewerWorkspaceId: WorkspaceId
}

export type ResolveResult =
  | { ok: false; reason: 'DENY' }
  | { ok: true; view: Record<string, string | number | boolean> }

const DENY: ResolveResult = { ok: false, reason: 'DENY' }

// Atom keys + rename targets are OWNER/LLM-authored data → untrusted.
const FORBIDDEN_KEY = new Set(['__proto__', 'prototype', 'constructor'])
const validPrincipal = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0
const safeKey = (k: unknown): k is string =>
  typeof k === 'string' && k.length > 0 && !FORBIDDEN_KEY.has(k)

// The fail-closed selection pipeline, extracted so the view AND a
// trustworthy source-count come from ONE function (no view-key
// archaeology — Phase-4 review). DENY semantics are byte-for-byte the
// same as before; resolveWindow's public contract is unchanged (T5 +
// fuzz + N=2 prove it).
type Selection =
  | { ok: false }
  | {
      ok: true
      rename: Record<string, string>
      aggregate?: { key: string; op: 'sum' | 'count'; as: string }
      selected: StoredAtom[]
    }

function selectForWindow(req: ResolveRequest, stores: Stores): Selection {
  if (
    !validPrincipal(req.viewerWorkspaceId) ||
    !validPrincipal(req.windowId)
  ) {
    return { ok: false }
  }

  const granted = stores.grants.some(
    (g) =>
      g.windowId === req.windowId &&
      g.viewerWorkspaceId === req.viewerWorkspaceId,
  )
  if (!granted) return { ok: false }

  const matches = stores.windows.filter((w) => w.id === req.windowId)
  if (matches.length !== 1) return { ok: false }
  const win = matches[0]

  if (
    !validPrincipal(win.ownerWorkspaceId) ||
    !win.selector ||
    !Array.isArray(win.selector.keys)
  ) {
    return { ok: false }
  }
  const sh = win.shape
  if (
    sh != null &&
    (typeof sh !== 'object' ||
      Array.isArray(sh) ||
      (sh.rename != null &&
        (typeof sh.rename !== 'object' || Array.isArray(sh.rename))) ||
      (sh.aggregate != null &&
        (typeof sh.aggregate !== 'object' ||
          typeof sh.aggregate.key !== 'string' ||
          (sh.aggregate.op !== 'sum' && sh.aggregate.op !== 'count') ||
          typeof sh.aggregate.as !== 'string')))
  ) {
    return { ok: false }
  }

  if (win.ownerWorkspaceId === req.viewerWorkspaceId) return { ok: false }

  if (!win.selector.keys.every(safeKey)) return { ok: false }
  const rename = win.shape?.rename ?? {}
  if (!Object.values(rename).every(safeKey)) return { ok: false }
  if (win.shape?.aggregate && !safeKey(win.shape.aggregate.as)) {
    return { ok: false }
  }

  const allow = new Set(win.selector.keys)
  if (allow.size === 0) return { ok: false }
  const unreviewed = new Set(stores.unreviewed ?? [])
  const selected = stores.atoms.filter(
    (a) =>
      a.ownerWorkspaceId === win.ownerWorkspaceId &&
      safeKey(a.key) &&
      allow.has(a.key) &&
      !unreviewed.has(unreviewedKey(a.ownerWorkspaceId, a.key)),
  )
  return { ok: true, rename, aggregate: win.shape?.aggregate, selected }
}

/**
 * resolveWindow + a trustworthy `sourceCount` (how many allowlisted,
 * reviewed source atoms actually crossed). The cross-desk live-total
 * uses sourceCount — NOT the projected view's keys — to decide
 * "meaningful value vs withheld/empty" (a rename target colliding
 * with the aggregate `as` makes view-key inference unsound).
 */
export function resolveWindowWithMeta(
  req: ResolveRequest,
  stores: Stores,
): { result: ResolveResult; aggregateOperandCount: number } {
  const s = selectForWindow(req, stores)
  if (!s.ok) return { result: DENY, aggregateOperandCount: 0 }

  // View construction is BYTE-IDENTICAL to Phase-3 resolveWindow
  // (T5 + fuzz + N=2 remain a valid behaviour-preservation proof).
  const view: Record<string, string | number | boolean> = Object.create(null)
  for (const a of s.selected) view[s.rename[a.key] ?? a.key] = a.value

  // aggregateOperandCount = how many atoms ACTUALLY fed the aggregate
  // (key === agg.key; for `sum`, finite numbers only). The cross-desk
  // live-total gates on THIS, not selected.length — a window can
  // select keys that are not the aggregate key, leaving the aggregate
  // empty (=> a misleading authoritative 0). Phase-4 review, Codex
  // HIGH: this closes the whole empty-aggregate class (key mismatch,
  // rename/as collision, all-withheld) in one place.
  let aggregateOperandCount = 0
  const agg = s.aggregate
  if (agg) {
    const vals = s.selected
      .filter((a) => a.key === agg.key)
      .map((a) => a.value)
    if (agg.op === 'count') {
      view[agg.as] = vals.length
      aggregateOperandCount = vals.length
    } else {
      view[agg.as] = vals.reduce<number>(
        (acc, v) => acc + (typeof v === 'number' ? v : 0),
        0,
      )
      aggregateOperandCount = vals.filter(
        (v) => typeof v === 'number' && Number.isFinite(v),
      ).length
    }
  }

  return { result: { ok: true, view }, aggregateOperandCount }
}

/**
 * The whole security boundary, in one fail-closed function. DENY
 * unless an explicit grant for exactly this (window, viewer). On
 * allow, returns ONLY the owner's allowlisted, reviewed atoms,
 * reshaped per `shape`. Never another desk, never an unlisted key,
 * never an unreviewed value. (Thin wrapper — behaviour unchanged.)
 */
export function resolveWindow(
  req: ResolveRequest,
  stores: Stores,
): ResolveResult {
  return resolveWindowWithMeta(req, stores).result
}
