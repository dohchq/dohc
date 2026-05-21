import { mutation, query, internalMutation } from './_generated/server'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { v } from 'convex/values'
import { requireWorkspace } from './auth'
import {
  unreviewedEntityRefs,
  unreviewedRefs,
  confirmEntityKey,
  confirmRefKey,
  refKey,
  isEntityKeyWithheld,
  isKeyWithheld,
} from './captures'
import {
  parseInlineAtomsFromMarkdownWithStatus,
  isSafeAtomPath,
  utf8Bytes,
  ATOM_TOTAL_BYTES_MAX,
} from './inlineAtom'
// Track-3 P1 — §6 retrofit: cross-desk gather / withheld /
// availableKeys all parse atom bodies for inline values; Track-2
// P1a's §6 audit silently MISSED these three sites (a `type: html`
// atom's `{k:v}` could cross a granted window unreviewed). The
// unified predicate closes the gap for BOTH html AND skill.
import { isNonDataAtom } from './atomId'
import {
  resolveWindowWithMeta,
  type StoredAtom,
  type WindowDef,
  type ResolveResult,
} from './resolveWindow'

// Phase 3 — the Convex adapter over the proven pure `resolveWindow`.
// Honors the §6b binding contract:
//  1. `resolve` derives the VIEWER only from requireWorkspace(ctx) —
//     never a client arg (windowId is a public reference, not an
//     identity; security is the grant check on the DERIVED viewer).
//  2. `resolve` is a QUERY (one transactional snapshot) — NOT an
//     action — so a revoke can't race between reads.
//  3. `revoke` deletes ALL matching grant rows (append-only table).
//  4. Phase-2 contract: unreviewed (non-confirmed) entities are
//     excluded at the SOURCE and their keys also fed to the pure
//     core's `unreviewed` gate (defence in depth).
// grant/revoke take a grantee workspace id BY DESIGN (the OWNER names
// who to share with; authz is owner == requireWorkspace). They don't
// return cross-tenant data — see the authzBoundary allowlist.

const SCAN_CAP = 5000

const isScalar = (x: unknown): x is string | number | boolean =>
  typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'

/** Owner defines a window over their own data. */
export const createWindow = mutation({
  args: {
    name: v.string(),
    selectorKeys: v.array(v.string()),
    rename: v.optional(v.record(v.string(), v.string())),
    aggregate: v.optional(
      v.object({
        key: v.string(),
        op: v.union(v.literal('sum'), v.literal('count')),
        as: v.string(),
      }),
    ),
  },
  handler: async (ctx, { name, selectorKeys, rename, aggregate }) => {
    const owner = await requireWorkspace(ctx)
    if (selectorKeys.length === 0) {
      throw new Error('a window must allowlist at least one key')
    }
    const shape: Record<string, unknown> = {}
    if (rename) shape.rename = rename
    if (aggregate) shape.aggregate = aggregate
    return await ctx.db.insert('windows', {
      ownerWorkspaceId: owner,
      name,
      selector: { keys: selectorKeys },
      shape,
      audience: {},
    })
  },
})

/** Owner lists their own windows. */
export const myWindows = query({
  args: {},
  handler: async (ctx) => {
    const owner = await requireWorkspace(ctx)
    const rows = await ctx.db
      .query('windows')
      .withIndex('by_owner', (q) => q.eq('ownerWorkspaceId', owner))
      .take(500)
    return rows.map((w) => ({
      id: w._id,
      name: w.name,
      selector: w.selector,
      shape: w.shape,
    }))
  },
})

/** Owner grants a window to a viewer. authz: only the window's owner
 *  (== requireWorkspace) can grant. Idempotent. */
export const grant = mutation({
  args: { windowId: v.id('windows'), viewerWorkspaceId: v.string() },
  handler: async (ctx, { windowId, viewerWorkspaceId }) => {
    const owner = await requireWorkspace(ctx)
    const win = await ctx.db.get(windowId)
    if (!win || win.ownerWorkspaceId !== owner) {
      throw new Error('not found or not your window')
    }
    if (viewerWorkspaceId === owner) {
      throw new Error('cannot grant a window to yourself')
    }
    const dup = await ctx.db
      .query('windowGrants')
      .withIndex('by_window_viewer', (q) =>
        q.eq('windowId', windowId).eq('viewerWorkspaceId', viewerWorkspaceId),
      )
      .first()
    if (!dup) {
      await ctx.db.insert('windowGrants', { windowId, viewerWorkspaceId })
    }
    return { ok: true }
  },
})

/** Owner revokes — deletes ALL matching grant rows (§6b.3:
 *  append-only ⇒ a stale duplicate must not survive revoke). */
export const revoke = mutation({
  args: { windowId: v.id('windows'), viewerWorkspaceId: v.string() },
  handler: async (ctx, { windowId, viewerWorkspaceId }) => {
    const owner = await requireWorkspace(ctx)
    const win = await ctx.db.get(windowId)
    if (!win || win.ownerWorkspaceId !== owner) {
      throw new Error('not found or not your window')
    }
    // Delete ALL matching rows, paginated to TRUE exhaustion (deleting
    // a row removes it from the index, so the next take() returns the
    // next undeleted batch). Terminates; complete for any row count —
    // not capped at one take(). grant is idempotent so this is ≤1
    // iteration in practice, but revoke must be total regardless.
    let revoked = 0
    for (;;) {
      const rows = await ctx.db
        .query('windowGrants')
        .withIndex('by_window_viewer', (q) =>
          q.eq('windowId', windowId).eq('viewerWorkspaceId', viewerWorkspaceId),
        )
        .take(500)
      if (rows.length === 0) break
      for (const r of rows) await ctx.db.delete(r._id)
      revoked += rows.length
    }
    return { revoked }
  },
})

/**
 * The ONE cross-desk gather+resolve path. Extracted so the Phase-4
 * cross-desk live-total reuses the SAME gather + SAME pure
 * resolveWindow core (no parallel logic — the Phase-3 anti-duplication
 * lesson). Viewer is ALWAYS passed in, derived by the caller from
 * requireWorkspace — never a client arg. Read-only; one snapshot.
 */
type WindowMeta = { result: ResolveResult; aggregateOperandCount: number }
// Frozen shared constant (Codex LOW): no caller mutates it, but freeze
// so a future one structurally cannot.
const DENY_META: WindowMeta = Object.freeze({
  result: Object.freeze({ ok: false as const, reason: 'DENY' as const }),
  aggregateOperandCount: 0,
}) as WindowMeta

/**
 * The SHARED owner-data gather (design v1 §4.3): the EXACT
 * confirmed-only source exclusion (entity unreviewed + atom
 * unreviewed / parse-fail / cap drops) the cross-desk viewer path
 * has always used. Returns the gathered `StoredAtom[]`, or `null`
 * when ANY fail-closed condition trips (callers map `null` → DENY).
 * Extracted VERBATIM so the viewer path stays byte-identical (the
 * locked T5 / fuzz / N=2 proofs still hold) AND the owner "Seen as:"
 * preview resolves over the IDENTICAL source — it can never show
 * more than a real viewer gets.
 */
async function gatherWindowAtoms(
  ctx: QueryCtx,
  owner: string,
): Promise<StoredAtom[] | null> {
    // Owner's non-confirmed captures → entity refs to withhold.
    // SINGLE source of truth (captures.unreviewedEntityRefs), keyed in
    // the entity namespace, scanning durable non-confirmed rows.
    // COMPLETE or fail-closed: overflow ⇒ DENY the whole window
    // (silently truncating a withhold set is a cross-tenant leak).
    const ur = await unreviewedEntityRefs(ctx, owner)
    if (ur.overflow) return null
    const { wholeRefs, refKeys } = ur

    // Flatten owner entities → StoredAtom[]; EXCLUDE unreviewed
    // entities at the source. Also feed the pure core's owner+key
    // gate as a backstop (coarse over-withhold, NEVER over-share).
    // Entity scan is also fail-closed: > SCAN_CAP ⇒ DENY (can't prove
    // the withhold backstop is complete).
    const ents = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type', (q) => q.eq('workspaceId', owner))
      .take(SCAN_CAP + 1)
    if (ents.length > SCAN_CAP) {
      return null
    }
    const atoms: StoredAtom[] = []
    for (const e of ents) {
      const ref = `${e.type}/${e.slug}`
      const wholeWithheld = wholeRefs.has(ref)
      const data = (e.data ?? {}) as Record<string, unknown>
      for (const [k, val] of Object.entries(data)) {
        if (!isScalar(val)) continue
        // R2.2: PRECISE per-(ref,key) withhold at the SOURCE — a
        // withheld field is simply never put in `atoms`, so the pure
        // core cannot project/aggregate it. The old coarse
        // `${owner} ${key}` backstop is REMOVED: it over-withheld the
        // SAME key across ALL entities (collapsing the marquee
        // multi-person rollup the instant ONE sibling was
        // unconfirmed) — strictly harmful, not defence-in-depth, now
        // that the source exclusion is precise + complete +
        // fail-closed (unreviewedEntityRefs overflow ⇒ DENY_META).
        const withheld =
          wholeWithheld || refKeys.has(refKey('entity', ref, k))
        if (!withheld) {
          atoms.push({ ownerWorkspaceId: owner, key: k, value: val })
        }
      }
    }

    // R3 §4/§5/§6 — ALSO gather the owner's inline VALUE atoms from
    // note bodies (the masterplan headline: IC writes `{hours:6}` →
    // manager's granted cross-desk window/rollup). SAME single FROZEN
    // parser + SAME per-occurrence emission as the own-desk path
    // (liveTotals ownDesk) ⇒ byte-identical aggregation; the ONLY
    // difference is the per-(atom,path,key) reviewed-by-default gate,
    // applied ONLY here (cross-desk), never own-desk. KIND-PARTITIONED
    // + fail-closed: any atom-side overflow / parser failure / cap
    // DROPS ALL atom sources (every inline value withheld) but NEVER
    // DENYs the window — the proven entity view still returns, so an
    // atom-capture flood cannot DoS an entity window (Codex v3 HIGH).
    let atomSrc: StoredAtom[] | null = []
    const atomUr = await unreviewedRefs(ctx, owner, 'atom')
    if (atomUr.overflow) {
      atomSrc = null // fail-closed: drop atoms, keep entity view
    } else {
      const notes = await ctx.db
        .query('atoms')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', owner))
        .take(SCAN_CAP + 1)
      if (notes.length > SCAN_CAP) {
        atomSrc = null // note-count cap ⇒ can't prove completeness
      } else {
        const aWhole = atomUr.wholeRefs // parse-fail sentinel / legacy
        const aKeys = atomUr.refKeys
        let emitted = 0
        let totalBytes = 0
        for (const n of notes) {
          if (atomSrc === null) break
          // (Track-3 P1: MAP_PATH subsumed by isNonDataAtom below.)
          if (!isSafeAtomPath(n.path)) {
            atomSrc = null // R3 §8 — NUL path ⇒ fail-closed: drop all
            break
          }
          // Track-3 P1 §6 retrofit: non-data atoms (html view, skill
          // instructions, derived map, legacy `skills/*`) NEVER
          // contribute values to cross-desk gather. Closes the
          // Track-2 P1a latent gap honestly (deploy-note material).
          if (isNonDataAtom(n.path, n.body ?? '')) continue
          // R3 §5 third cap (Codex holistic MED): TOTAL parsed-bytes
          // budget BEFORE parsing this note — bounds the resolve txn
          // (note-count + per-note-byte alone allow ~1.2GB). Over ⇒
          // drop ALL atom sources (fail-closed, never a throw).
          totalBytes += utf8Bytes(n.body ?? '')
          if (totalBytes > ATOM_TOTAL_BYTES_MAX) {
            atomSrc = null
            break
          }
          // parse WITH STATUS. A parser failure means we CANNOT prove
          // the atom withhold set is complete for this desk ⇒ DROP
          // ALL atom sources (v4 §5 contract; Codex R3-build MED —
          // not a per-note `continue`). The entity view still
          // returns; the note also has a write-side parse-fail
          // sentinel. Caps are pre-checked in the WITH-status helper.
          const parsed = parseInlineAtomsFromMarkdownWithStatus(n.body ?? '')
          if (!parsed.ok) {
            atomSrc = null
            break
          }
          const pathWhole = aWhole.has(n.path)
          for (const a of parsed.atoms) {
            if (a.kind !== 'value') continue
            if (++emitted > SCAN_CAP) {
              atomSrc = null // emitted-atom cap ⇒ drop ALL (fail-closed)
              break
            }
            const withheld =
              pathWhole || aKeys.has(refKey('atom', n.path, a.key))
            if (!withheld) {
              atomSrc.push({
                ownerWorkspaceId: owner,
                key: a.key,
                value: a.value,
              })
            }
          }
        }
      }
    }
    if (atomSrc) for (const s of atomSrc) atoms.push(s)
    return atoms
}

function windowDef(
  windowId: Id<'windows'>,
  win: { ownerWorkspaceId: string; selector: unknown; shape: unknown },
): WindowDef {
  return {
    id: windowId,
    ownerWorkspaceId: win.ownerWorkspaceId,
    selector: win.selector as WindowDef['selector'],
    shape: win.shape as WindowDef['shape'],
  }
}

export async function resolveWindowForViewer(
  ctx: QueryCtx,
  windowId: Id<'windows'>,
  viewer: string,
): Promise<WindowMeta> {
  const win = await ctx.db.get(windowId)
  if (!win) return DENY_META
  const owner = win.ownerWorkspaceId
  // ONE snapshot: only THIS viewer's grant rows for THIS window
  // (precise + bounded + fail-closed).
  const grants = await ctx.db
    .query('windowGrants')
    .withIndex('by_window_viewer', (q) =>
      q.eq('windowId', windowId).eq('viewerWorkspaceId', viewer),
    )
    .take(50)
  const atoms = await gatherWindowAtoms(ctx, owner)
  if (atoms === null) return DENY_META
  return resolveWindowWithMeta(
    { windowId, viewerWorkspaceId: viewer },
    {
      windows: [windowDef(windowId, win)],
      grants: grants.map((g) => ({
        windowId: g.windowId,
        viewerWorkspaceId: g.viewerWorkspaceId,
      })),
      atoms,
      // Source exclusion in the gather is now the SOLE, precise gate;
      // the pure core's coarse owner+key backstop is intentionally
      // fed nothing (see gatherWindowAtoms — it was net-harmful).
      unreviewed: [],
    },
  )
}

// design v1 §4.3 (build-time discovery). The pure core
// (convex/resolveWindow.ts) DENYs when `viewer === owner` AND
// requires an explicit grant. The owner's "Seen as:" preview is NOT
// a cross-person read, but the projected view is VIEWER-INDEPENDENT:
// `selected` filters by the OWNER workspace, never the viewer — the
// viewer id appears ONLY in those two authz gates. So the preview
// reuses the EXACT, untouched, tested `resolveWindowWithMeta` over
// the SAME `gatherWindowAtoms`, satisfying the grant + owner≠viewer
// gates with a SERVER-ONLY synthetic principal. A WorkOS subject is
// always a non-empty `user_…`/uuid-shaped token — it can NEVER equal
// this space-prefixed literal, and this constant is NEVER
// client-supplied (callers pass only `windowId`; `viewer` in the
// real path is strictly `requireWorkspace`). Real authz is the
// STRICT owner-equality check below: a foreign/forged windowId ⇒ DENY,
// identical to a missing grant. Chosen over refactoring the security
// core specifically so the locked viewer path has ZERO behaviour
// change (T5 / fuzz / N=2 still prove it).
const OWNER_PREVIEW_VIEWER = 'dohc:owner-preview'

export async function resolveWindowOwnerPreview(
  ctx: QueryCtx,
  windowId: Id<'windows'>,
  owner: string,
): Promise<WindowMeta> {
  const win = await ctx.db.get(windowId)
  if (!win || win.ownerWorkspaceId !== owner) return DENY_META
  const atoms = await gatherWindowAtoms(ctx, owner)
  if (atoms === null) return DENY_META
  return resolveWindowWithMeta(
    { windowId, viewerWorkspaceId: OWNER_PREVIEW_VIEWER },
    {
      windows: [windowDef(windowId, win)],
      grants: [{ windowId, viewerWorkspaceId: OWNER_PREVIEW_VIEWER }],
      atoms,
      unreviewed: [],
    },
  )
}

/**
 * Resolve a window for the AUTHENTICATED caller. Thin: viewer strictly
 * from requireWorkspace, then the shared gather+resolve path. Returns
 * the reshaped view or DENY.
 */
export const resolve = query({
  args: { windowId: v.id('windows') },
  handler: async (ctx, { windowId }) => {
    const viewer = await requireWorkspace(ctx)
    const { result } = await resolveWindowForViewer(ctx, windowId, viewer)
    return result
  },
})

// ── R2 consent-at-the-edge. Under STRICT reviewed-by-default every
// entity write is withheld until the owner confirms. The owner needs
// to SEE exactly what a window would expose that is still withheld,
// and confirm it as the deliberate sharing act (masterplan: "dohc
// asks when unsure" / "always visible who sees what"). Owner-only;
// own-desk only — never a cross-person read (no resolveWindow here;
// the owner is inspecting their OWN data before sharing it).

type WithheldItem = { ref: string; type: string; slug: string; keys: string[] }

async function windowWithheldRefs(
  ctx: QueryCtx,
  owner: string,
  win: { selector?: unknown },
): Promise<{ overflow: true } | { overflow: false; items: WithheldItem[] }> {
  const sel = (win.selector ?? {}) as { keys?: unknown }
  const keys = Array.isArray(sel.keys) ? (sel.keys as string[]) : []
  if (keys.length === 0) return { overflow: false, items: [] }
  const allow = new Set(keys)

  const ur = await unreviewedEntityRefs(ctx, owner)
  if (ur.overflow) return { overflow: true }
  const { wholeRefs, refKeys } = ur

  const ents = await ctx.db
    .query('entities')
    .withIndex('by_workspace_type', (q) => q.eq('workspaceId', owner))
    .take(SCAN_CAP + 1)
  if (ents.length > SCAN_CAP) return { overflow: true }

  const items: WithheldItem[] = []
  for (const e of ents) {
    const ref = `${e.type}/${e.slug}`
    const data = (e.data ?? {}) as Record<string, unknown>
    // R2.1: only the selector keys whose (ref,key) is withheld (or
    // whole-entity withheld). Confirming these releases EXACTLY
    // these keys — not other keys of the same entity.
    const matched = Object.entries(data)
      .filter(
        ([k, v]) =>
          isScalar(v) &&
          allow.has(k) &&
          (wholeRefs.has(ref) || refKeys.has(refKey('entity', ref, k))),
      )
      .map(([k]) => k)
    if (matched.length > 0) {
      items.push({ ref, type: e.type, slug: e.slug, keys: matched })
    }
  }
  return { overflow: false, items }
}

// R3 §7 — inline-atom consent items, surfaced via the SAME typed
// enumeration. `ref` = raw note path. Bounded + fail-closed exactly
// like windowWithheldRefs (overflow ⇒ caller treats as truncated).
type AtomWithheldItem = { kind: 'atom'; ref: string; key: string }

async function windowWithheldAtoms(
  ctx: QueryCtx,
  owner: string,
  win: { selector?: unknown },
): Promise<
  { overflow: true } | { overflow: false; items: AtomWithheldItem[] }
> {
  const sel = (win.selector ?? {}) as { keys?: unknown }
  const keys = Array.isArray(sel.keys) ? (sel.keys as string[]) : []
  if (keys.length === 0) return { overflow: false, items: [] }
  const allow = new Set(keys)

  const ur = await unreviewedRefs(ctx, owner, 'atom')
  if (ur.overflow) return { overflow: true }
  const { wholeRefs, refKeys } = ur

  const notes = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', owner))
    .take(SCAN_CAP + 1)
  if (notes.length > SCAN_CAP) return { overflow: true }

  const items: AtomWithheldItem[] = []
  const seen = new Set<string>()
  let emitted = 0
  let totalBytes = 0
  for (const n of notes) {
    // (Track-3 P1: MAP_PATH subsumed by isNonDataAtom below.)
    // R3 (Codex R3-fold NEW MED): the consent enumeration MUST mirror
    // the gather's GLOBAL atom-source drop, or report ≠ resolution
    // (the R2.2-MED#5 lying-consent class for atoms). resolveWindow-
    // ForViewer drops ALL atom sources when ANY owner note is
    // NUL-pathed or unparseable; so here the SAME condition ⇒ the
    // whole atom consent is "overflow" (review says it can't safely
    // enumerate / confirm refuses) — never report a sibling atom as
    // "shared" while resolution withholds the entire atom partition.
    if (!isSafeAtomPath(n.path)) return { overflow: true }
    // Track-3 P1 §6 retrofit: skip non-data atoms (parallel to the
    // gather skip — symmetry ⇒ report ≡ resolution).
    if (isNonDataAtom(n.path, n.body ?? '')) continue
    // R3 §5 third cap — SAME total-bytes budget/accounting as the
    // gather (symmetry ⇒ report ≡ resolution: when the gather drops
    // all atoms on the byte budget, consent refuses identically).
    totalBytes += utf8Bytes(n.body ?? '')
    if (totalBytes > ATOM_TOTAL_BYTES_MAX) return { overflow: true }
    const parsed = parseInlineAtomsFromMarkdownWithStatus(n.body ?? '')
    if (!parsed.ok) return { overflow: true }
    const pathWhole = wholeRefs.has(n.path)
    for (const a of parsed.atoms) {
      if (a.kind !== 'value') continue
      // R3 (R3-fold² review): count the emitted-atom cap over EVERY
      // value-atom BEFORE the selector filter — EXACTLY as the gather
      // does (windows.ts resolveWindowForViewer). Filtering first made
      // consent's `emitted` a strict subset of the gather's, so a
      // high-volume desk could trip the gather's global drop while
      // consent stayed under cap ⇒ report ≠ resolution (the same
      // lying-consent class). Symmetric now (condition c).
      if (++emitted > SCAN_CAP) return { overflow: true }
      if (!allow.has(a.key)) continue
      const id = refKey('atom', n.path, a.key)
      if (seen.has(id)) continue
      if (pathWhole || refKeys.has(id)) {
        seen.add(id)
        items.push({ kind: 'atom', ref: n.path, key: a.key })
      }
    }
  }
  return { overflow: false, items }
}

/** Owner-only: what THIS window would expose that is still withheld
 *  (pending the owner's explicit confirm). Read-only. R3 §7: `items`
 *  stays ENTITY-ONLY (byte-identical to R2 — same shape/assertions);
 *  inline-atom consent is the ADDITIVE `atoms` typed enumeration. */
export const withheldFor = query({
  args: { windowId: v.id('windows') },
  handler: async (ctx, { windowId }) => {
    const owner = await requireWorkspace(ctx)
    const win = await ctx.db.get(windowId)
    if (!win || win.ownerWorkspaceId !== owner) {
      return { ok: false as const, reason: 'not-your-window' as const }
    }
    const r = await windowWithheldRefs(ctx, owner, win)
    const ra = await windowWithheldAtoms(ctx, owner, win)
    const truncated = r.overflow || ra.overflow
    return {
      ok: true as const,
      truncated,
      items: r.overflow ? [] : r.items,
      atoms: ra.overflow ? [] : ra.items,
    }
  },
})

/** Owner-only consent: confirm EVERY value this window would expose
 *  that is currently withheld — the deliberate "share these" act.
 *  The SHARED impl (design v1 §4): called by BOTH the internal
 *  agent-tool path (`_confirmWithheldFor`) AND the public consent
 *  surface (`confirmWithheldFor`). ONE code path ⇒ the button and
 *  dohc do byte-identical things (the Phase-3 anti-duplication
 *  lesson). `workspaceId` is the OWNER, derived by each caller from
 *  requireWorkspace — never a client arg. Never auto-runs. */
async function confirmWithheldForImpl(
  ctx: MutationCtx,
  workspaceId: string,
  windowId: Id<'windows'>,
) {
    const win = await ctx.db.get(windowId)
    if (!win || win.ownerWorkspaceId !== workspaceId) {
      return { ok: false as const, reason: 'not-your-window' as const }
    }
    const r = await windowWithheldRefs(ctx, workspaceId, win)
    if (r.overflow) {
      return { ok: false as const, reason: 'too-many-to-enumerate' as const }
    }
    const ra = await windowWithheldAtoms(ctx, workspaceId, win)
    if (ra.overflow) {
      return { ok: false as const, reason: 'too-many-to-enumerate' as const }
    }
    // R2.1: confirm EXACTLY the (ref,key) pairs this window exposes
    // via `confirmEntityKey` — confirming `hours` never releases
    // `salary` (Codex CRITICAL). R2.2 (Codex MED #5): the consent
    // report MUST equal what `resolveWindowForViewer` actually does,
    // so it's derived per displayed (ref,key) from `isEntityKeyWithheld`
    // (the SAME rule resolution uses) AFTER confirming — a ref is
    // "shared" only if EVERY displayed key is now releasable. A
    // deliberate `rejected` (or a legacy no-`key` whole withhold)
    // keeps the ref `blocked`, never falsely "shared" ("always
    // visible who sees what" — the consent signal can't lie).
    let confirmed = 0
    const sharedRefs: string[] = []
    const blockedRefs: string[] = []
    for (const it of r.items) {
      let n = 0
      for (const k of it.keys) {
        n += await confirmEntityKey(ctx, workspaceId, it.type, it.slug, k)
      }
      confirmed += n
      // HONEST report (Codex MED #5 / earlier "no lying shared"): the
      // report MUST equal what resolveWindowForViewer will actually do.
      // A ref is "shared" ONLY if EVERY displayed key it exposes is
      // now releasable — i.e. none is still withheld. `confirmed > 0`
      // is NOT sufficient: a window over {hours,salary} where
      // `salary` is REJECTED (or a legacy no-`key` whole withhold
      // remains) confirms `hours` (n>0) yet `salary` stays withheld.
      // Re-derive per displayed (ref,key) from the SAME signal
      // resolution uses, so the consent report can never lie.
      let anyStillWithheld = false
      for (const k of it.keys) {
        if (await isEntityKeyWithheld(ctx, workspaceId, it.type, it.slug, k)) {
          anyStillWithheld = true
          break
        }
      }
      ;(anyStillWithheld ? blockedRefs : sharedRefs).push(it.ref)
    }

    // R3 §7 — ALSO confirm the inline-atom (path,key) this window
    // exposes. The legacy sharedRefs/blockedRefs arrays stay
    // ENTITY-ONLY (byte-identical R2 contract; zero collision
    // surface). Inline-atom consent is the ADDITIVE typed result,
    // with the SAME honest report≡resolution rule (isKeyWithheld).
    const sharedAtoms: AtomWithheldItem[] = []
    const blockedAtoms: AtomWithheldItem[] = []
    for (const it of ra.items) {
      confirmed += await confirmRefKey(
        ctx,
        workspaceId,
        'atom',
        it.ref,
        it.key,
      )
      const stillWithheld = await isKeyWithheld(
        ctx,
        workspaceId,
        'atom',
        it.ref,
        it.key,
      )
      ;(stillWithheld ? blockedAtoms : sharedAtoms).push(it)
    }

    return {
      ok: true as const,
      confirmed,
      sharedRefs,
      blockedRefs,
      sharedAtoms,
      blockedAtoms,
    }
}

/** Internal agent-tool path — unchanged contract; thin over the
 *  shared impl. */
export const _confirmWithheldFor = internalMutation({
  args: { workspaceId: v.string(), windowId: v.id('windows') },
  handler: (ctx, { workspaceId, windowId }) =>
    confirmWithheldForImpl(ctx, workspaceId, windowId),
})

/** PUBLIC consent surface (design v1 §4.2): the owner clicks "Share
 *  these N" without going through dohc. Owner STRICTLY from
 *  requireWorkspace — never a client arg. Byte-identical to the agent
 *  path (same `confirmWithheldForImpl`). */
export const confirmWithheldFor = mutation({
  args: { windowId: v.id('windows') },
  handler: async (ctx, { windowId }) => {
    const owner = await requireWorkspace(ctx)
    return confirmWithheldForImpl(ctx, owner, windowId)
  },
})

/** PUBLIC "Seen as:" (design v1 §4.3 + §4.3 build-discovery): the
 *  owner previews the EXACT reshaped value a granted viewer gets,
 *  without being a viewer. Owner STRICTLY from requireWorkspace;
 *  resolveWindowOwnerPreview enforces strict owner-equality and
 *  reuses the untouched viewer gather+core ⇒ can never show more
 *  than a real viewer. Returns the same `ResolveResult` as
 *  `resolve` (DENY for a foreign/forged windowId). */
export const previewWindow = query({
  args: { windowId: v.id('windows') },
  handler: async (ctx, { windowId }): Promise<ResolveResult> => {
    const owner = await requireWorkspace(ctx)
    const { result } = await resolveWindowOwnerPreview(ctx, windowId, owner)
    return result
  },
})

/** PUBLIC reciprocal "windows on me" (design v1 §4.4 / D4 Frame F):
 *  the windows OTHER people have granted to ME, each with the EXACT
 *  view I actually receive (the tested, grant-checked viewer path —
 *  zero new authz surface). Viewer STRICTLY from requireWorkspace.
 *  Bounded. */
export const windowsSharedWithMe = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireWorkspace(ctx)
    const grants = await ctx.db
      .query('windowGrants')
      .withIndex('by_viewer', (q) => q.eq('viewerWorkspaceId', viewer))
      .take(200)
    // De-dupe append-only grant rows by windowId (a stale duplicate
    // must not double-list the same window).
    const seen = new Set<string>()
    const out: Array<{
      windowId: Id<'windows'>
      name: string
      ownerWorkspaceId: string
      view: Record<string, string | number | boolean> | null
    }> = []
    for (const g of grants) {
      if (seen.has(g.windowId)) continue
      seen.add(g.windowId)
      const win = await ctx.db.get(g.windowId)
      if (!win) continue
      const { result } = await resolveWindowForViewer(
        ctx,
        g.windowId,
        viewer,
      )
      out.push({
        windowId: g.windowId,
        name: win.name,
        ownerWorkspaceId: win.ownerWorkspaceId,
        view: result.ok ? result.view : null,
      })
    }
    return out
  },
})

/** PUBLIC standing summary + per-window digest (design v1 §4.1 / D9
 *  visible inheritance + D5 batched digest) in ONE reactive read.
 *  Owner STRICTLY from requireWorkspace. Reuses the EXACT
 *  `windowWithheldRefs`/`windowWithheldAtoms` `withheldFor` uses
 *  (one impl — no parallel logic). Bounded: `.take(500)` windows,
 *  each withhold scan already capped + `truncated`-flagged so one
 *  heavy window degrades only its own row, never bricks the query. */
export const consentOverview = query({
  args: {},
  handler: async (ctx) => {
    const owner = await requireWorkspace(ctx)
    const wins = await ctx.db
      .query('windows')
      .withIndex('by_owner', (q) => q.eq('ownerWorkspaceId', owner))
      .take(500)
    const windows = []
    for (const win of wins) {
      const grants = await ctx.db
        .query('windowGrants')
        .withIndex('by_window', (q) => q.eq('windowId', win._id))
        .take(200)
      const grantees = Array.from(
        new Set(grants.map((g) => g.viewerWorkspaceId)),
      )
      const r = await windowWithheldRefs(ctx, owner, win)
      const ra = await windowWithheldAtoms(ctx, owner, win)
      const truncated = r.overflow || ra.overflow
      windows.push({
        windowId: win._id,
        name: win.name,
        grantees,
        truncated,
        // entity (ref,key) the digest will offer to share
        entities: r.overflow ? [] : r.items,
        // inline-atom (path,key) — additive, same typed shape
        atoms: ra.overflow ? [] : ra.items,
      })
    }
    return windows
  },
})

/**
 * P3 design v1.3 §4 — the distinct scalar keys the owner *could*
 * window over, to populate the builder's key-picker (never a blank
 * box). This is a SIBLING scan of `gatherWindowAtoms`' raw source
 * iteration — the design's EXPECTED path (that function is
 * T5/fuzz/N=2-locked; re-extracting its inner loop risks the
 * emitted-cap-before-filter symmetry + two-tier null signalling).
 * It uses the IDENTICAL primitives — `isScalar`, the FAIL-CLOSED
 * `parseInlineAtomsFromMarkdownWithStatus` (NOT the fail-soft
 * variant), the SAME `SCAN_CAP` / `ATOM_TOTAL_BYTES_MAX` /
 * `isSafeAtomPath` / `MAP_PATH` — but DELIBERATELY OMITS the
 * reviewed-by-default exclusion: the owner is designing a window
 * over their OWN desk, so an unconfirmed key is still a valid thing
 * to put in a window (the gate fires later, at cross-desk resolve).
 * ⇒ `keys` is a strict SUPERSET of anything any window could ever
 * carry (the §7.5 equivalence test). Two-tier fail-closed, mapped
 * (own-desk read — no DENY concept) to `truncated: true`: an
 * entity-tier cap still returns the atom keys and vice-versa; it
 * NEVER throws and NEVER reads another desk. Owner-only.
 */
export const availableKeys = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ keys: string[]; truncated: boolean }> => {
    const owner = await requireWorkspace(ctx)
    const keys = new Set<string>()
    let truncated = false

    // entity-tier: scalar fields of the owner's entities
    const ents = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type', (q) => q.eq('workspaceId', owner))
      .take(SCAN_CAP + 1)
    if (ents.length > SCAN_CAP) truncated = true
    for (const e of ents.slice(0, SCAN_CAP)) {
      const data = (e.data ?? {}) as Record<string, unknown>
      for (const [k, val] of Object.entries(data)) {
        if (isScalar(val)) keys.add(k)
      }
    }

    // atom-tier: inline value-atom keys (SAME caps/parser as the
    // gather). Any atom-tier cap ⇒ stop the atom scan, keep what we
    // have, flag truncated (entity keys above are unaffected — the
    // gather's R3 kind-partition mirrored on the read side).
    const notes = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', owner))
      .take(SCAN_CAP + 1)
    if (notes.length > SCAN_CAP) truncated = true
    let emitted = 0
    let totalBytes = 0
    for (const n of notes.slice(0, SCAN_CAP)) {
      // Track-3 P1 §6 retrofit: availableKeys must also skip
      // non-data atoms (html/skill/legacy-skills bodies are NOT
      // value sources; MAP_PATH subsumed).
      if (isNonDataAtom(n.path, n.body ?? '')) continue
      if (!isSafeAtomPath(n.path)) {
        truncated = true
        break
      }
      totalBytes += utf8Bytes(n.body ?? '')
      if (totalBytes > ATOM_TOTAL_BYTES_MAX) {
        truncated = true
        break
      }
      const parsed = parseInlineAtomsFromMarkdownWithStatus(n.body ?? '')
      if (!parsed.ok) {
        truncated = true
        break
      }
      for (const a of parsed.atoms) {
        if (a.kind !== 'value') continue
        if (++emitted > SCAN_CAP) {
          truncated = true
          break
        }
        keys.add(a.key)
      }
      if (emitted > SCAN_CAP) break
    }

    return { keys: [...keys].sort(), truncated }
  },
})

/**
 * P3 §4 — the honest v0 identity primitive. Returns ONLY the
 * caller's own workspace id (the WorkOS subject) so a user can copy
 * it and hand it to whoever will window them in. No directory, no
 * enumeration, no argument: zero cross-tenant surface (it can only
 * ever return *your own* id, and a workspace id is inert — only a
 * window's own owner can grant it; receiving an id grants nothing).
 */
export const whoami = query({
  args: {},
  handler: async (ctx): Promise<string> => requireWorkspace(ctx),
})
