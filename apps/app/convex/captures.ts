import {
  internalQuery,
  internalMutation,
  mutation,
} from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import { requireWorkspace } from './auth'
import { classifyAction } from './confirmTier'
import { parseInlineAtomsFromMarkdownWithStatus } from './inlineAtom'
import { isNonDataAtom } from './atomId'

// Phase 2 keystone engine — reviewed-by-default capture ledger.
// Pure data-layer + model-independent; convex-test verified.
//
// Invariants (re-review hardening):
//  • A capture row IMPLIES the value exists — recordCapture VERIFIES
//    the atom/entity is live before inserting (no ghost rows; not
//    prompt-hope that dohc "wrote it first").
//  • Status is LOAD-BEARING, not decorative: an UNREVIEWED value
//    (status auto | pending | rejected — i.e. anything that is NOT
//    `confirmed`) is withheld from every cross-desk window by
//    resolveWindow (the sole cross-person primitive). The withhold
//    decision is keyed off the PRESENCE of such a row, so that row is
//    a SECURITY ARTEFACT, not a transient digest entry.
//  • Phase-3 review fix: because the gate reads row PRESENCE of a
//    NON-confirmed row, such a row MUST be durable — it may NEVER be
//    purged while its target exists. Retention purges ONLY `confirmed`
//    rows. Purging a `confirmed` row is authz-NEUTRAL (a confirmed row
//    is not in the withhold set; the value keeps sharing, which is
//    correct — the owner confirmed it): retention only drops reviewed
//    history. Purging `auto`/`rejected` (the OLD behaviour) was a
//    time-delayed cross-tenant LEAK: after 30d the withheld value
//    silently became shareable. `confirmed` is the only purgeable
//    history.
//  • reject is a pure STATUS FLIP — it never deletes the host note
//    (which would nuke unrelated user prose) and never does a
//    lossy-ref delete. `rejected` is non-confirmed ⇒ never purged ⇒
//    the rejected value never propagates, permanently.

const PENDING_MAX = 200
// Per-status fail-closed cap for the cross-person unreviewed scan: if
// a desk somehow exceeds this many non-confirmed rows for one status,
// resolveWindow DENIES the whole window rather than risk missing a
// withheld ref (over-deny is the only acceptable failure direction).
const UNREVIEWED_CAP = 5000
// Only `confirmed` capture rows are retention-purgeable (see the
// LOAD-BEARING invariant above). Non-confirmed rows are NEVER purged.
// Same batched + self-rescheduling pattern as trash._purgeExpired.
export const CAPTURES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PURGE_BATCH = 100

function entityTypeSlug(ref: string): { type: string; slug: string } {
  const i = ref.indexOf('/')
  return i >= 0
    ? { type: ref.slice(0, i), slug: ref.slice(i + 1) }
    : { type: ref, slug: '' }
}

/** Record a byproduct capture. THROWS if the target value does not
 *  actually exist (kills ghost ledger rows) or if a create somehow
 *  classifies destructive (defensive — unreachable for kind:create). */
export async function recordCapture(
  ctx: MutationCtx,
  args: {
    workspaceId: string
    kind: 'atom' | 'entity'
    ref: string
    summary: string
    shared?: boolean
    unsure?: boolean
  },
): Promise<{ tier: string; status: 'auto' | 'pending' }> {
  const tier = classifyAction({
    kind: 'create',
    target: args.kind,
    shared: args.shared,
    unsure: args.unsure,
  })
  if (tier === 'blocking') {
    throw new Error('capture: unexpected blocking tier for a create')
  }
  const status: 'auto' | 'pending' = tier === 'silent' ? 'auto' : 'pending'

  // 1. Target must exist — a capture row implies a real value.
  if (args.kind === 'atom') {
    const a = await ctx.db
      .query('atoms')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', args.workspaceId).eq('path', args.ref),
      )
      .unique()
    if (!a) throw new Error(`capture target not found: atom ${args.ref}`)
    // §6 unified (Track-3 P1): non-data atoms (html view, skill
    // instructions, legacy skills/-path) never
    // produce capture rows — same posture as the rest of §6.
    if (isNonDataAtom(a.path, a.body ?? '')) return { tier, status }
    // R3 §3 (Codex v3 HIGH) — folded EXACTLY like the entity branch
    // below: NEVER insert a no-`key` ref-wide atom row (it would be
    // the R2.2 dark-hole/lying-shared class for atoms). Parse the
    // note and ENSURE each inline VALUE is withheld per (path,key)
    // (idempotent via coalesce — atom writes already structurally
    // capture; this just makes the agent `capture` tool consistent).
    // The ONLY sanctioned no-`key` atom row is the §5 parse-fail
    // SENTINEL — recorded here too if the body won't parse, so a
    // capture of an unparseable note still fails CLOSED.
    const parsed = parseInlineAtomsFromMarkdownWithStatus(a.body ?? '')
    if (!parsed.ok) {
      await recordAtomParseFailSentinel(ctx, args.workspaceId, args.ref)
    } else {
      const seen = new Set<string>()
      for (const atom of parsed.atoms) {
        if (atom.kind !== 'value' || seen.has(atom.key)) continue
        seen.add(atom.key)
        await recordWriteCapture(
          ctx,
          args.workspaceId,
          'atom',
          args.ref,
          atom.key,
        )
      }
    }
    return { tier, status }
  }

  // ENTITY: R2.2 (Codex/subagent HIGH) — NEVER insert a no-`key`
  // ref-wide entity row (it would be a permanent whole-entity
  // dark-hole: unreleasable by per-(ref,key) consent, and would make
  // _confirmWithheldFor lie). Entity writes already structurally
  // capture per key; the agent `capture` tool here just ENSURES each
  // scalar field is withheld per-key (idempotent via coalesce).
  const { type, slug } = entityTypeSlug(args.ref)
  const e = await ctx.db
    .query('entities')
    .withIndex('by_workspace_type_slug', (q) =>
      q.eq('workspaceId', args.workspaceId).eq('type', type).eq('slug', slug),
    )
    .unique()
  if (!e) throw new Error(`capture target not found: entity ${args.ref}`)
  if (`${e.type}/${e.slug}` !== args.ref) {
    throw new Error(`non-canonical entity capture ref: ${args.ref}`)
  }
  const data = (e.data ?? {}) as Record<string, unknown>
  for (const [k, val] of Object.entries(data)) {
    if (
      typeof val === 'string' ||
      typeof val === 'number' ||
      typeof val === 'boolean'
    ) {
      await recordEntityWriteCapture(ctx, args.workspaceId, e.type, e.slug, k)
    }
  }
  return { tier, status }
}

/** Internal mutation wrapper for the agent's `capture` tool. Per-item
 *  errors are reported (not silently dropped); a missing target fails
 *  THAT item, not the batch. */
export const _record = internalMutation({
  args: {
    workspaceId: v.string(),
    items: v.array(
      v.object({
        kind: v.union(v.literal('atom'), v.literal('entity')),
        ref: v.string(),
        summary: v.string(),
        shared: v.optional(v.boolean()),
        unsure: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, { workspaceId, items }) => {
    const results: Array<{
      ref: string
      ok: boolean
      tier?: string
      status?: string
      error?: string
    }> = []
    for (const it of items) {
      try {
        const { tier, status } = await recordCapture(ctx, {
          workspaceId,
          kind: it.kind,
          ref: it.ref,
          summary: it.summary,
          shared: it.shared,
          unsure: it.unsure,
        })
        results.push({ ref: it.ref, ok: true, tier, status })
      } catch (e) {
        results.push({ ref: it.ref, ok: false, error: (e as Error).message })
      }
    }
    return results
  },
})

/** The digest: only `pending` captures. Bounded; reports truncation. */
export const _pending = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    const rows = await ctx.db
      .query('captures')
      .withIndex('by_workspace_status', (q) =>
        q.eq('workspaceId', workspaceId).eq('status', 'pending'),
      )
      .order('desc')
      .take(PENDING_MAX + 1)
    const truncated = rows.length > PENDING_MAX
    return {
      truncated,
      items: rows.slice(0, PENDING_MAX).map((r) => ({
        id: r._id,
        kind: r.kind,
        ref: r.ref,
        summary: r.summary,
        tier: r.tier,
        createdAt: r.createdAt,
      })),
    }
  },
})

// The non-confirmed statuses. A capture is "unreviewed" (must NOT
// cross a person boundary) unless it is `confirmed`.
const NON_CONFIRMED = ['auto', 'pending', 'rejected'] as const

// Delete-drain batch for `clearAtomKeyCapture` (the only helper that
// scans the never-coalesced `confirmed` partition, which can grow
// with edit→confirm churn). take() is NOT a paginated query (no
// one-paginate-per-function limit) and deleting what we take drains
// completely — same idiom as windows.revoke.
const CAPTURE_DELETE_BATCH = 500

/**
 * THE single source of truth for the reviewed-by-default cross-person
 * gate (Phase-3 review: was a dead, divergent `_unreviewedKeys` that
 * the adapter never called and that used an incompatible key space).
 *
 * Returns the owner's set of unreviewed ENTITY refs (`type/slug`) —
 * windows project entity data, so the gate operates in the entity
 * namespace. A plain async helper (NOT a Convex function) so
 * windows.resolve calls it INSIDE its single query transaction (no
 * `ctx.runQuery` → no extra snapshot → no revoke/confirm TOCTOU).
 *
 * COMPLETE or FAIL-CLOSED: scans each non-confirmed status via the
 * `by_workspace_status` index up to `cap`+1. If any status overflows,
 * returns `{ overflow: true }` and the caller MUST DENY the whole
 * window — silently truncating a withhold set is a cross-tenant leak.
 * `recordCapture` validates entity refs against an exact
 * `by_workspace_type_slug` lookup, so a stored entity-capture ref is
 * provably `${type}/${slug}` of a real row — the adapter's
 * `${e.type}/${e.slug}` reconstruction matches exactly (no
 * casing/normalization drift).
 */
// R3 (design v4 §8): keyed by (kind, ref, key) — `kind` is a
// non-collidable LEADING segment so a note literally pathed
// `person/anna` (kind:'atom') and an entity `person/anna`
// (kind:'entity') are distinct AT THE GATE SET, not merely in the
// report. In-memory Set key only (never persisted) -- safe to change.
export const refKey = (
  kind: 'entity' | 'atom',
  ref: string,
  key: string,
) => `${kind}\u0000${ref}\u0000${key}`

type UnreviewedSets =
  | { overflow: true }
  | { overflow: false; wholeRefs: Set<string>; refKeys: Set<string> }

/**
 * THE single source of truth for the reviewed-by-default gate, PER
 * (kind, ref, key) (R2.1 + R3). KIND-PARTITIONED (R3 design v4 §4):
 * scans ONLY this `kind`'s non-confirmed rows via the
 * `by_workspace_kind_status` index, with its OWN `cap` — so an
 * atom-capture flood can never push the ENTITY partition past its
 * cap and DENY an unrelated entity window (and vice-versa). Returns:
 *  • `wholeRefs` — refs with a non-confirmed NO-`key` capture
 *    (legacy/agent-tool entity row, OR R3's parse-fail atom
 *    SENTINEL) ⇒ over-withhold the WHOLE ref (the safe direction).
 *  • `refKeys` — `refKey(kind,ref,key)` per non-confirmed (ref,key).
 * Withheld iff `wholeRefs.has(ref) || refKeys.has(refKey(kind,ref,
 * key))`. Scans ONLY non-confirmed (confirmed history can't hide a
 * withhold — Codex MED); COMPLETE or FAIL-CLOSED (overflow ⇒ caller
 * DENIES that kind's sources; for atoms the caller DROPS atom
 * sources, for entities it DENYs the window — R3 §4/§5).
 */
export async function unreviewedRefs(
  ctx: QueryCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  cap: number = UNREVIEWED_CAP,
): Promise<UnreviewedSets> {
  const wholeRefs = new Set<string>()
  const refKeys = new Set<string>()
  for (const status of NON_CONFIRMED) {
    const rows = await ctx.db
      .query('captures')
      .withIndex('by_workspace_kind_status', (q) =>
        q
          .eq('workspaceId', workspaceId)
          .eq('kind', kind)
          .eq('status', status),
      )
      .take(cap + 1)
    if (rows.length > cap) return { overflow: true }
    for (const r of rows) {
      if (typeof r.key === 'string') {
        refKeys.add(refKey(kind, r.ref, r.key))
      } else {
        wholeRefs.add(r.ref) // no key ⇒ whole-ref over-withhold
      }
    }
  }
  return { overflow: false, wholeRefs, refKeys }
}

/**
 * Entity wrapper — BYTE-IDENTICAL to the pre-R3 behaviour: same
 * entity rows (the old `by_workspace_status` scan + `kind!=='entity'`
 * skip is exactly `by_workspace_kind_status` with `kind:'entity'`),
 * same wholeRefs/refKeys, same overflow contract. Only difference:
 * the overflow count no longer includes atom rows (R3 §4 — the fix).
 */
export async function unreviewedEntityRefs(
  ctx: QueryCtx,
  workspaceId: string,
  cap: number = UNREVIEWED_CAP,
): Promise<UnreviewedSets> {
  return unreviewedRefs(ctx, workspaceId, 'entity', cap)
}

export const _confirm = internalMutation({
  args: { workspaceId: v.string(), captureId: v.id('captures') },
  handler: async (ctx, { workspaceId, captureId }) => {
    const row = await ctx.db.get(captureId)
    if (!row || row.workspaceId !== workspaceId) {
      return { ok: false as const, reason: 'not-found' }
    }
    // R2 (C3): a silent `auto` capture is non-confirmed and withheld;
    // it MUST be confirmable or the default path dark-holes sharing
    // forever. confirmed/rejected are terminal (no silent un-reject).
    if (row.status !== 'pending' && row.status !== 'auto') {
      return { ok: false as const, reason: `not-confirmable (${row.status})` }
    }
    await ctx.db.patch(captureId, { status: 'confirmed' })
    return { ok: true as const, ref: row.ref }
  },
})

/** Retention purge — ONLY `confirmed` rows (Phase-3 review fix).
 *  Non-confirmed (auto/pending/rejected) rows are the cross-person
 *  withhold signal and are NEVER purged while their target exists;
 *  deleting one is a time-delayed cross-tenant leak. Purging a
 *  `confirmed` row is authz-NEUTRAL (it is not in the withhold set —
 *  retention only drops reviewed history; shareability is unchanged).
 *  Batched + self-rescheduling (Convex tx limits). */
export const _purgeCaptures = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const cutoff = Date.now() - CAPTURES_RETENTION_MS
    // Paginate (cursor advances regardless of whether a row is
    // purgeable) so the NEVER-purged non-confirmed rows can't starve
    // the scan and block newer confirmed rows. Terminates (finite
    // pages); complete (every old row visited once).
    const page = await ctx.db
      .query('captures')
      .withIndex('by_createdAt', (q) => q.lt('createdAt', cutoff))
      .paginate({ numItems: PURGE_BATCH, cursor: cursor ?? null })
    let purged = 0
    for (const r of page.page) {
      if (r.status === 'confirmed') {
        await ctx.db.delete(r._id)
        purged++
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.captures._purgeCaptures, {
        cursor: page.continueCursor,
      })
    }
    return { purged, done: page.isDone }
  },
})

/** Reject = pure status flip. No destruction: with the resolveWindow
 *  gate, `rejected` already means "never propagates to anyone else".
 *  The owner's own copy stays (their desk, their data) — rejecting a
 *  capture must NOT silently delete the host note + unrelated prose. */
export const _reject = internalMutation({
  args: { workspaceId: v.string(), captureId: v.id('captures') },
  handler: async (ctx, { workspaceId, captureId }) => {
    const row = await ctx.db.get(captureId)
    if (!row || row.workspaceId !== workspaceId) {
      return { ok: false as const, reason: 'not-found' }
    }
    // R2 (C3): the owner can also reject a silent `auto` value
    // (kill it for sharing) — symmetric with _confirm.
    if (row.status !== 'pending' && row.status !== 'auto') {
      return { ok: false as const, reason: `not-rejectable (${row.status})` }
    }
    await ctx.db.patch(captureId, { status: 'rejected' })
    return { ok: true as const, ref: row.ref }
  },
})

// ── R2 — STRICT reviewed-by-default: capture is a byproduct of the
// WRITE, structural, not prompt-hope. The holistic review (C2) found
      // entity writes created no capture,
// so resolveWindow shared them unreviewed. These run inside the
// shared entity-write chokepoints (entities._upsertMany/_patch/
// _delete) so every entity mutation, from any caller, is gated.

// R2.2 (Codex MED #4) — TRULY BOUNDED + complete: query the EXACT
// (ref, key, status) partition via `by_workspace_kind_ref_key_status`.
// No local key filter ⇒ not O(#keys-on-the-entity); after coalescing
// this partition is ≤1 row. Status-scoped ⇒ confirmed history can't
// hide a withhold row. Paginated only as defence-in-depth.
async function refKeyCaptureIds(
  ctx: MutationCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  ref: string,
  key: string,
  statuses: ReadonlyArray<'auto' | 'pending' | 'rejected'>,
): Promise<Array<import('./_generated/dataModel').Id<'captures'>>> {
  const ids: Array<import('./_generated/dataModel').Id<'captures'>> = []
  for (const status of statuses) {
    // EXACT 5-field index POINT (workspace+kind+ref+key+status all
    // pinned; ≤1 row after coalescing). A bounded `.collect()`, NOT
    // `.paginate()`: Convex permits only ONE paginated query per
    // function, and the write path (applyAtomCapture / recordCapture)
    // calls this helper MANY times per write — looping `.paginate()`
    // here threw "ran multiple paginated queries" on the live
    // deployment (convex-test does not enforce that limit, so the
    // remediation suite never caught it). `.collect()` is complete
    // (completeness is a withhold-set security invariant — a capped
    // `.take()` that truncated could leak) and is not subject to the
    // one-paginate rule.
    for (const r of await ctx.db
      .query('captures')
      .withIndex('by_workspace_kind_ref_key_status', (q) =>
        q
          .eq('workspaceId', workspaceId)
          .eq('kind', kind)
          .eq('ref', ref)
          .eq('key', key)
          .eq('status', status),
      )
      .collect()) {
      ids.push(r._id)
    }
  }
  return ids
}

/**
 * A no-`key` non-confirmed entity capture (legacy / pre-R2.1) ⇒ the
 * WHOLE entity is withheld and CANNOT be safely released by
 * per-(ref,key) consent (blanket-clearing a whole-entity "unreviewed"
 * marker from one window would reopen the cross-key CRITICAL). Used
 * to report the consent result HONESTLY (such a ref is blocked,
 * never "shared"). Post-R2.2 NO new no-key entity rows are created
 * (see recordCapture), so this only flags an inert legacy tail.
 */
export async function hasNoKeyWithhold(
  ctx: MutationCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  ref: string,
): Promise<boolean> {
  for (const status of NON_CONFIRMED) {
    // Exact (kind, ref, key:undefined, status) partition — a single
    // index probe per status, NOT a ref-wide scan filtered locally.
    const row = await ctx.db
      .query('captures')
      .withIndex('by_workspace_kind_ref_key_status', (q) =>
        q
          .eq('workspaceId', workspaceId)
          .eq('kind', kind)
          .eq('ref', ref)
          .eq('key', undefined)
          .eq('status', status),
      )
      .first()
    if (row) return true
  }
  return false
}

/** Entity wrapper — byte-identical to pre-R3. */
export async function hasNoKeyEntityWithhold(
  ctx: MutationCtx,
  workspaceId: string,
  type: string,
  slug: string,
): Promise<boolean> {
  return hasNoKeyWithhold(ctx, workspaceId, 'entity', `${type}/${slug}`)
}

/**
 * R2.1/2.2 — withhold ONE (entity, key) until the owner confirms
 * (C2), per-key so confirming `hours` never releases `salary`.
 * Coalesced: if an auto|pending capture already covers this
 * (ref,key), do nothing. Else supersede any STALE `rejected` row for
 * this (ref,key) — the value changed, so an old rejection of the
 * prior value no longer applies (corrected-after-reject is reviewable
 * again; folds M6) — then insert a fresh `auto`. Bounded; NEVER
 * throws into a write.
 */
export async function recordWriteCapture(
  ctx: MutationCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  ref: string,
  key: string,
): Promise<void> {
  const live = await refKeyCaptureIds(ctx, workspaceId, kind, ref, key, [
    'auto',
    'pending',
  ])
  if (live.length > 0) return // already withheld + in review — coalesce

  for (const id of await refKeyCaptureIds(ctx, workspaceId, kind, ref, key, [
    'rejected',
  ])) {
    await ctx.db.delete(id) // supersede stale rejection of the prior value
  }
  await ctx.db.insert('captures', {
    workspaceId,
    kind,
    ref,
    key,
    summary: `(auto) ${ref}.${key} written — withheld from shared windows until confirmed`,
    tier: 'silent',
    status: 'auto',
    createdAt: Date.now(),
  })
}

/** Entity wrapper — byte-identical to pre-R3. */
export async function recordEntityWriteCapture(
  ctx: MutationCtx,
  workspaceId: string,
  type: string,
  slug: string,
  key: string,
): Promise<void> {
  return recordWriteCapture(ctx, workspaceId, 'entity', `${type}/${slug}`, key)
}

/**
 * On entity DELETE, drop ALL of that ref's capture rows (M6). They
 * referenced a now-gone entity; a future recreate of the same
 * type/slug gets a FRESH non-confirmed capture (withheld until
 * re-confirmed — correct under strict), never a stale withhold or a
 * stale confirm. Bounded loop → complete, terminates.
 */
export async function clearCaptures(
  ctx: MutationCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  ref: string,
): Promise<void> {
  for (;;) {
    const rows = await ctx.db
      .query('captures')
      .withIndex('by_workspace_kind_ref', (q) =>
        q.eq('workspaceId', workspaceId).eq('kind', kind).eq('ref', ref),
      )
      .take(200)
    if (rows.length === 0) break
    for (const r of rows) await ctx.db.delete(r._id)
  }
}

/** Entity wrapper — byte-identical to pre-R3. */
export async function clearEntityCaptures(
  ctx: MutationCtx,
  workspaceId: string,
  type: string,
  slug: string,
): Promise<void> {
  return clearCaptures(ctx, workspaceId, 'entity', `${type}/${slug}`)
}

/**
 * R2.1 consent-at-the-edge release: confirm every non-confirmed
 * (auto|pending) capture for EXACTLY one (entity, key) — NOT the
 * whole ref (confirming `hours` must never release `salary`; Codex
 * CRITICAL). A no-`key` (legacy/agent-tool whole-entity) row is left
 * UNTOUCHED here — the per-window consent only releases the keys it
 * displayed. Complete (scans only non-confirmed; confirmed history
 * can't hide a row). Returns how many rows were confirmed (0 ⇒ the
 * (ref,key) was rejected-only or had nothing to release).
 */
export async function confirmRefKey(
  ctx: MutationCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  ref: string,
  key: string,
): Promise<number> {
  let confirmed = 0
  for (const id of await refKeyCaptureIds(ctx, workspaceId, kind, ref, key, [
    'auto',
    'pending',
  ])) {
    await ctx.db.patch(id, { status: 'confirmed' })
    confirmed++
  }
  return confirmed
}

/**
 * P2 consent surface (design v1 §4.5) — the per-`(ref,key)` "keep
 * private" the digest needs. The LINE-FOR-LINE MIRROR of
 * `confirmRefKey`: only `'confirmed'` → `'rejected'`. NOT new consent
 * semantics — the reject side of the confirm/reject duality the
 * engine already has (it only had a `captureId` entrypoint `_reject`,
 * which the withheld digest cannot supply). Every locked invariant
 * holds BY CONSTRUCTION, for the SAME reasons `confirmRefKey`'s do:
 *  • terminal-status guard — the scan set is `['auto','pending']`
 *    ONLY ⇒ a `confirmed` row is never seen (no confirmed→rejected
 *    un-share) and an existing `rejected` row is a no-op (idempotent;
 *    rejected-is-terminal preserved).
 *  • per-`(ref,key)` granularity — `refKeyCaptureIds` is keyed by the
 *    EXACT `(kind,ref,key)` ⇒ rejecting `hours` never touches
 *    `salary`; a legacy no-`key` whole-ref row is NOT matched (the
 *    same exclusion `confirmRefKey` relies on).
 *  • report ≡ resolution — `isKeyWithheld` already treats `rejected`
 *    as withheld ⇒ a rejected key stays out of every window and is
 *    honestly reported `blocked`, never "shared".
 * Returns how many rows were rejected (0 ⇒ nothing non-confirmed to
 * reject — already confirmed/rejected, or nothing captured).
 */
export async function rejectRefKey(
  ctx: MutationCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  ref: string,
  key: string,
): Promise<number> {
  let rejected = 0
  for (const id of await refKeyCaptureIds(ctx, workspaceId, kind, ref, key, [
    'auto',
    'pending',
  ])) {
    await ctx.db.patch(id, { status: 'rejected' })
    rejected++
  }
  return rejected
}

/**
 * PUBLIC owner-scoped "keep private" (design v1 §4.5). Workspace is
 * derived STRICTLY from `requireWorkspace` — never a client arg (the
 * C1/L8 lesson) — so no caller can reject another desk's captures.
 * Args are the `(kind,ref,key)` the digest row already exposes.
 * Idempotent; terminal.
 */
export const rejectKey = mutation({
  args: {
    kind: v.union(v.literal('entity'), v.literal('atom')),
    ref: v.string(),
    key: v.string(),
  },
  handler: async (ctx, { kind, ref, key }) => {
    const owner = await requireWorkspace(ctx)
    const rejected = await rejectRefKey(ctx, owner, kind, ref, key)
    return { ok: true as const, rejected }
  },
})

/** Entity wrapper — byte-identical to pre-R3. */
export async function confirmEntityKey(
  ctx: MutationCtx,
  workspaceId: string,
  type: string,
  slug: string,
  key: string,
): Promise<number> {
  return confirmRefKey(ctx, workspaceId, 'entity', `${type}/${slug}`, key)
}

/**
 * R2.2 (Codex MED #5) — would `resolveWindowForViewer` STILL withhold
 * this (entity, key)? EXACTLY mirrors `unreviewedEntityRefs`'s rule
 * (`wholeRefs.has(ref) || refKeys.has(refKey(ref,key))`) so the
 * consent report cannot diverge from resolution: a no-`key` whole
 * withhold OR ANY non-confirmed row (auto|pending|REJECTED) for this
 * exact (ref,key) ⇒ still withheld. The `rejected` arm is the bug
 * fix: confirming an `hours` window with `salary` REJECTED must NOT
 * report the ref "shared" — salary is still withheld. Bounded.
 */
export async function isKeyWithheld(
  ctx: MutationCtx,
  workspaceId: string,
  kind: 'entity' | 'atom',
  ref: string,
  key: string,
): Promise<boolean> {
  if (await hasNoKeyWithhold(ctx, workspaceId, kind, ref)) return true
  const remaining = await refKeyCaptureIds(ctx, workspaceId, kind, ref, key, [
    'auto',
    'pending',
    'rejected',
  ])
  return remaining.length > 0
}

/** Entity wrapper — byte-identical to pre-R3. */
export async function isEntityKeyWithheld(
  ctx: MutationCtx,
  workspaceId: string,
  type: string,
  slug: string,
  key: string,
): Promise<boolean> {
  return isKeyWithheld(ctx, workspaceId, 'entity', `${type}/${slug}`, key)
}

// ── R3 — inline-atom capture (design v4 §1/§3/§5) ───────────────────
// `ref` for kind:'atom' is the RAW note path, verbatim — NEVER through
// entityTypeSlug (its first-`/` split would mis-namespace `a/b.md`).

/** Reserved summary marking the §5 parse-fail SENTINEL — the ONE
 *  sanctioned no-`key` atom row. Distinct from a legacy/unreleasable
 *  no-key row: it has the clean-reparse supersede lifecycle below. */
export const ATOM_PARSE_FAIL = '__parse_fail__'

/** Atom per-(path,key) structural withhold (thin kind:'atom' wrapper
 *  — coalesced auto, supersedes stale rejected; same contract as the
 *  entity equivalent). `ref` = raw note path verbatim. */
export async function recordAtomWriteCapture(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
  key: string,
): Promise<void> {
  return recordWriteCapture(ctx, workspaceId, 'atom', path, key)
}

/** Delete ALL capture rows for one atom note path (M6 — delete/move/
 *  wipe). Removes the sentinel too. */
export async function clearAtomCaptures(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
): Promise<void> {
  return clearCaptures(ctx, workspaceId, 'atom', path)
}

/** Delete every capture row for an EXACT (atom, path, key) — used
 *  when a key disappears from a note body (no value to project ⇒ no
 *  withhold needed; a future re-add re-withholds fresh). All statuses
 *  (a stale confirmed must not let a re-added value auto-flow). */
export async function clearAtomKeyCapture(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
  key: string,
): Promise<void> {
  const STATUSES = ['auto', 'pending', 'rejected', 'confirmed'] as const
  for (const status of STATUSES) {
    // `.take(BATCH)` DELETE-DRAIN, NOT `.collect()` and NOT
    // `.paginate()` (Codex review): the `confirmed` partition is the
    // ONE non-coalesced status — recordWriteCapture only coalesces
    // auto|pending, so repeated edit→confirm of the same (path,key)
    // accumulates many `confirmed` rows. `.collect()` of that is
    // unbounded; `.paginate()` is illegal here (this runs in the
    // per-key write loop ⇒ many calls/mutation). Deleting what we
    // took means the next `.take()` returns the next batch ⇒
    // terminates, complete, bounded per iteration — the same pattern
    // windows.revoke uses for an unbounded append-only delete.
    for (;;) {
      const rows = await ctx.db
        .query('captures')
        .withIndex('by_workspace_kind_ref_key_status', (q) =>
          q
            .eq('workspaceId', workspaceId)
            .eq('kind', 'atom')
            .eq('ref', path)
            .eq('key', key)
            .eq('status', status),
        )
        .take(CAPTURE_DELETE_BATCH)
      if (rows.length === 0) break
      for (const r of rows) await ctx.db.delete(r._id)
    }
  }
}

/** R3 §5 — coalesce the ONE path-wide parse-fail SENTINEL (kind:'atom',
 *  no `key`, status:'auto', reserved summary). No pile-up: if a
 *  sentinel already exists for this path, do nothing. While it exists
 *  the WHOLE note is withheld (no-key ⇒ wholeRefs) and honestly
 *  `blocked`. Cleared by a clean re-parse (see below) or
 *  clearAtomCaptures (delete/move/wipe). */
export async function recordAtomParseFailSentinel(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
): Promise<void> {
  for (const status of NON_CONFIRMED) {
    const existing = await ctx.db
      .query('captures')
      .withIndex('by_workspace_kind_ref_key_status', (q) =>
        q
          .eq('workspaceId', workspaceId)
          .eq('kind', 'atom')
          .eq('ref', path)
          .eq('key', undefined)
          .eq('status', status),
      )
      .first()
    if (existing) return // already whole-note withheld — coalesce
  }
  await ctx.db.insert('captures', {
    workspaceId,
    kind: 'atom',
    ref: path,
    summary: ATOM_PARSE_FAIL,
    tier: 'silent',
    status: 'auto',
    createdAt: Date.now(),
  })
}

/** R3 §5 — remove the parse-fail sentinel (the ONLY no-`key` atom
 *  row) on a clean re-parse, BEFORE recording per-(path,key) rows.
 *  Returns true if one was present (⇒ caller forces all-keys-changed
 *  recovery so the fixed note is re-withheld per key, never a
 *  dark-hole). Targets ONLY the reserved sentinel summary — never a
 *  per-key row. */
export async function clearAtomParseFailSentinel(
  ctx: MutationCtx,
  workspaceId: string,
  path: string,
): Promise<boolean> {
  let found = false
  for (const status of NON_CONFIRMED) {
    // EXACT index point (no-`key` sentinel partition) — bounded
    // `.collect()`, NOT `.paginate()`: this runs FIRST in
    // applyAtomCapture, before the per-key recordCapture loop, so a
    // looped `.paginate()` here was the FIRST of several paginated
    // queries in the write mutation and threw on the live deploy
    // ("ran multiple paginated queries"). convex-test never enforced
    // the one-paginate-per-function rule ⇒ the remediation suite
    // passed while every live agent write failed.
    for (const r of await ctx.db
      .query('captures')
      .withIndex('by_workspace_kind_ref_key_status', (q) =>
        q
          .eq('workspaceId', workspaceId)
          .eq('kind', 'atom')
          .eq('ref', path)
          .eq('key', undefined)
          .eq('status', status),
      )
      .collect()) {
      if (r.summary === ATOM_PARSE_FAIL) {
        await ctx.db.delete(r._id)
        found = true
      }
    }
  }
  return found
}
