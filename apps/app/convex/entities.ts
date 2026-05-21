import { ConvexError, v } from 'convex/values'
import {
  query,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { requireWorkspace } from './auth'
import { isCanonicalEntityId, assertCanonicalEntityId } from './entityId'
import { recordTrash, recordTrashCoalesced } from './trash'
import {
  recordEntityWriteCapture,
  clearEntityCaptures,
} from './captures'

// Canonical entity ids (Phase-3 review — Codex HIGH). `type` and
// `slug` are path segments: non-empty, no '/'. This makes the
// `${type}/${slug}` capture ref UNAMBIGUOUS (split on the single '/'),
// so the reviewed-by-default withhold ref is provably exact end to
// end. Without it, an entity like {type:"a/b", slug:"c"} makes
// recordCapture's first-'/' split miss the lookup → NO withhold row
// is created → a granted window leaks the unconfirmed value. Enforced
// at every write chokepoint (covers the agent AND the public plugin
// bridge, which both route through _upsertMany / _patch).
// The canonical-id rule now lives in the neutral `./entityId` module
// (no Convex/db imports) so entities.ts AND trash.ts both depend on
// IT, not on each other (kills the entities↔trash cycle — Codex LOW).
// Re-exported here for back-compat with existing importers.
export { isCanonicalEntityId, assertCanonicalEntityId }

// R2.1 — withhold is per (entity, KEY). On a write, capture only the
// scalar fields whose value actually changed (new key, or different
// scalar value). Non-scalar fields are never window-projected, so
// they need no capture.
const isScalar = (x: unknown): x is string | number | boolean =>
  typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'

function changedScalarKeys(prev: unknown, next: unknown): string[] {
  const p = (prev ?? {}) as Record<string, unknown>
  const n = (next ?? {}) as Record<string, unknown>
  const out: string[] = []
  for (const [k, val] of Object.entries(n)) {
    if (!isScalar(val)) continue
    if (!(k in p) || p[k] !== val) out.push(k)
  }
  return out
}

async function captureChangedKeys(
  ctx: Parameters<typeof recordEntityWriteCapture>[0],
  workspaceId: string,
  type: string,
  slug: string,
  prev: unknown,
  next: unknown,
): Promise<void> {
  for (const key of changedScalarKeys(prev, next)) {
    await recordEntityWriteCapture(ctx, workspaceId, type, slug, key)
  }
}

export const list = query({
  args: { type: v.optional(v.string()) },
  handler: async (ctx, { type }) => {
    const workspaceId = await requireWorkspace(ctx)
    if (type) {
      return await ctx.db
        .query('entities')
        .withIndex('by_workspace_type', (q) =>
          q.eq('workspaceId', workspaceId).eq('type', type),
        )
        .collect()
    }
    return await ctx.db
      .query('entities')
      .withIndex('by_workspace_type', (q) => q.eq('workspaceId', workspaceId))
      .collect()
  },
})

export const get = query({
  args: { type: v.string(), slug: v.string() },
  handler: async (ctx, { type, slug }) => {
    const workspaceId = await requireWorkspace(ctx)
    return await ctx.db
      .query('entities')
      .withIndex('by_workspace_type_slug', (q) =>
        q.eq('workspaceId', workspaceId).eq('type', type).eq('slug', slug),
      )
      .unique()
  },
})

// Internal helpers used by the agent's tools + query runtime.

export const _listByType = internalQuery({
  // atom-address-v1 §5.2 (Phase-4 precondition 1): an OPTIONAL
  // `limit` so the query-block eval path can BOUND this read
  // (unbounded `.collect()` run reactively per-keystroke is the
  // live-crash class). Omitted ⇒ unbounded, byte-identical to before
  // (zero regression for the agent / pluginBridge callers). When
  // given, take `limit+1` so the caller can detect + honestly
  // disclose truncation.
  args: {
    workspaceId: v.string(),
    type: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { workspaceId, type, limit }) => {
    const base = ctx.db
      .query('entities')
      .withIndex('by_workspace_type', (q) =>
        q.eq('workspaceId', workspaceId).eq('type', type),
      )
    const rows =
      limit === undefined ? await base.collect() : await base.take(limit + 1)
    return rows.map((r) => ({
      type: r.type,
      slug: r.slug,
      data: r.data,
      updatedAt: r.updatedAt,
    }))
  },
})

export const _find = internalQuery({
  args: { workspaceId: v.string(), type: v.string(), slug: v.string() },
  handler: async (ctx, { workspaceId, type, slug }) => {
    const row = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type_slug', (q) =>
        q.eq('workspaceId', workspaceId).eq('type', type).eq('slug', slug),
      )
      .unique()
    if (!row) return null
    return { type: row.type, slug: row.slug, data: row.data }
  },
})

// skills-commands-v1 §2-A.1 + §7 P2 step 5 (Track-3 P2b.2) — the
// MUTATION-LEVEL invariant under the runtime `requireDirectUser
// Authorization` gate (BELT + BRACE). When the caller is in a skill
// turn (`skillTurnState.depth > 0`) the tool-handler MUST pass
// `mode: 'strictCreate'`; that mode rejects, IN THE SAME TRANSACTION:
//   (a) same-batch duplicate `(type, slug)` items (round-4 Codex
//       FAIL-3: `[{slug:'acme'}, {slug:'acme'}]` defeats a handler
//       pre-check by inserting then overwriting within one call);
//   (b) any pre-existing DB row for any target `(type, slug)`
//       (round-5 indep FAIL-3 — the `create_entities` overwrite the
//       design forbids even for a skill that was given the SAFE
//       enable for it; "create" is additive, "update" is not).
// The mode is OPTIONAL; omitted ⇒ unchanged byte-identical upsert
// semantics for the agent's `update_entity` + pluginBridge
// `window.dohc.upsert` callers (no regression).
//
// P2b.2 fold (Codex F1): a plain `Error` subclass's custom fields
// (`.kind`, `.mode`, `.conflicts`) DO NOT survive the
// `ctx.runMutation` boundary — Convex's documented structured-error
// propagation path is `ConvexError.data`. The error class below
// EXTENDS `ConvexError` so the structured payload travels intact
// from `_upsertMany` (mutation) → `create_entities` tool handler
// (action) → tool result. The `.message` is the model-visible
// surface (AI-SDK `getErrorMessage(err)`); `.data` is the
// in-process structured discriminator the agent tool handler can
// branch on if richer surfacing is wanted.
export type StrictCreateConflictData = {
  kind: 'strict-create-conflict'
  mode: 'duplicate-in-batch' | 'pre-existing'
  conflicts: string[]
  message: string
}

function formatStrictCreateConflictMessage(
  mode: StrictCreateConflictData['mode'],
  conflicts: string[],
): string {
  return mode === 'duplicate-in-batch'
    ? `create_entities batch contains duplicate (type, slug) pair(s): ${conflicts.join(', ')}. A skill cannot upsert; each (type, slug) must appear at most once per batch.`
    : `create_entities cannot overwrite existing entit${conflicts.length === 1 ? 'y' : 'ies'}: ${conflicts.join(', ')}. A skill body is not authorized to mutate an existing entity — use update_entity (which requires direct user "yes" in a fresh chat turn).`
}

export class StrictCreateConflictError extends ConvexError<StrictCreateConflictData> {
  constructor(
    mode: StrictCreateConflictData['mode'],
    conflicts: string[],
  ) {
    const message = formatStrictCreateConflictMessage(mode, conflicts)
    super({
      kind: 'strict-create-conflict',
      mode,
      conflicts,
      message,
    })
    this.name = 'StrictCreateConflictError'
    // ConvexError defaults .message to JSON of the data payload;
    // override to the human-friendly form so AI-SDK's
    // `getErrorMessage(err)` surfaces clean text to the model.
    // Both `.message` AND `.data` survive `ctx.runMutation`.
    Object.defineProperty(this, 'message', {
      value: message,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }

  // Convenience accessors so existing call sites that branch on
  // `.kind` / `.mode` / `.conflicts` (the prior in-process API)
  // continue to compile. They read from `.data` (the propagated
  // payload) so the behavior is consistent across the boundary.
  get kind(): 'strict-create-conflict' {
    return this.data.kind
  }
  get mode(): StrictCreateConflictData['mode'] {
    return this.data.mode
  }
  get conflicts(): string[] {
    return this.data.conflicts
  }
}

export const _upsertMany = internalMutation({
  args: {
    workspaceId: v.string(),
    items: v.array(
      v.object({
        type: v.string(),
        slug: v.string(),
        data: v.any(),
      }),
    ),
    mode: v.optional(
      v.union(v.literal('upsert'), v.literal('strictCreate')),
    ),
  },
  handler: async (ctx, { workspaceId, items, mode }) => {
    const now = Date.now()
    let created = 0
    let updated = 0

    // PHASE 1 (strictCreate only): same-batch duplicate detection +
    // pre-existing row rejection, BEFORE any write. All-or-nothing
    // semantics — if any check fails the throw aborts the transaction
    // and Convex rolls back zero writes (no partial application).
    if (mode === 'strictCreate') {
      // Canonical-id assertion is per-item; do it here BEFORE the
      // duplicate scan so a malformed id surfaces first (smaller
      // blast-radius error).
      for (const it of items) assertCanonicalEntityId(it.type, it.slug)

      const seen = new Set<string>()
      const dupes: string[] = []
      for (const it of items) {
        const key = `${it.type}/${it.slug}`
        if (seen.has(key)) dupes.push(key)
        else seen.add(key)
      }
      if (dupes.length > 0) {
        throw new StrictCreateConflictError('duplicate-in-batch', dupes)
      }

      const preExisting: string[] = []
      for (const it of items) {
        const existing = await ctx.db
          .query('entities')
          .withIndex('by_workspace_type_slug', (q) =>
            q
              .eq('workspaceId', workspaceId)
              .eq('type', it.type)
              .eq('slug', it.slug),
          )
          .unique()
        if (existing) preExisting.push(`${it.type}/${it.slug}`)
      }
      if (preExisting.length > 0) {
        throw new StrictCreateConflictError('pre-existing', preExisting)
      }
      // Falls through into the standard loop; every item is guaranteed
      // NEW so the `existing` branch is dead code in this mode.
    }

    for (const it of items) {
      assertCanonicalEntityId(it.type, it.slug)
      const existing = await ctx.db
        .query('entities')
        .withIndex('by_workspace_type_slug', (q) =>
          q
            .eq('workspaceId', workspaceId)
            .eq('type', it.type)
            .eq('slug', it.slug),
        )
        .unique()
      const prevData = existing?.data
      if (existing) {
        // recoverability: overwriting an entity's data is destructive
        // of the prior value — snapshot before the patch (covers the
        // agent + the plugin-bridge `window.dohc.upsert` path).
        if (JSON.stringify(existing.data) !== JSON.stringify(it.data)) {
          await recordTrashCoalesced(ctx, {
            workspaceId,
            kind: 'entity',
            ref: `${it.type}/${it.slug} (pre-edit)`,
            payload: { type: it.type, slug: it.slug, data: existing.data },
          })
        }
        await ctx.db.patch(existing._id, { data: it.data, updatedAt: now })
        updated++
      } else {
        await ctx.db.insert('entities', {
          workspaceId,
          type: it.type,
          slug: it.slug,
          data: it.data,
          updatedAt: now,
        })
        created++
      }
      // R2.1 (C2, per-KEY): every entity write (agent AND public
      // pluginBridge route here) WITHHOLDS each CHANGED scalar field
      // from shared windows until the owner confirms THAT key.
      await captureChangedKeys(
        ctx,
        workspaceId,
        it.type,
        it.slug,
        prevData,
        it.data,
      )
    }
    return { created, updated }
  },
})

export const _patch = internalMutation({
  args: {
    workspaceId: v.string(),
    type: v.string(),
    slug: v.string(),
    data: v.any(),
  },
  handler: async (ctx, { workspaceId, type, slug, data }) => {
    assertCanonicalEntityId(type, slug)
    const existing = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type_slug', (q) =>
        q.eq('workspaceId', workspaceId).eq('type', type).eq('slug', slug),
      )
      .unique()
    if (!existing) throw new Error(`not found: ${type}/${slug}`)
    const merged = { ...(existing.data ?? {}), ...data }
    // Re-review HIGH: _patch is reachable from the PUBLIC plugin
    // bridge (window.dohc.patch) and the agent's update_entity tool
    // and overwrites existing keys' values — a destructive overwrite
    // that previously bypassed trash entirely. Snapshot prior data
    // (coalesced) before the patch.
    if (JSON.stringify(existing.data) !== JSON.stringify(merged)) {
      await recordTrashCoalesced(ctx, {
        workspaceId,
        kind: 'entity',
        ref: `${type}/${slug} (pre-edit)`,
        payload: { type, slug, data: existing.data },
      })
    }
    await ctx.db.patch(existing._id, { data: merged, updatedAt: Date.now() })
    // R2.1 (C2, per-KEY): re-withhold ONLY the keys whose scalar
    // value changed (confirming one key never released another).
    await captureChangedKeys(
      ctx,
      workspaceId,
      type,
      slug,
      existing.data,
      merged,
    )
  },
})

export const _delete = internalMutation({
  args: { workspaceId: v.string(), type: v.string(), slug: v.string() },
  handler: async (ctx, { workspaceId, type, slug }) => {
    const existing = await ctx.db
      .query('entities')
      .withIndex('by_workspace_type_slug', (q) =>
        q.eq('workspaceId', workspaceId).eq('type', type).eq('slug', slug),
      )
      .unique()
    if (existing) {
      await recordTrash(ctx, {
        workspaceId,
        kind: 'entity',
        ref: `${type}/${slug}`,
        payload: { type, slug, data: existing.data },
      })
      await ctx.db.delete(existing._id)
      // R2 (M6): the entity is gone — drop its capture rows so a
      // future recreate of this type/slug gets a FRESH withhold,
      // never inherits a stale one.
      await clearEntityCaptures(ctx, workspaceId, type, slug)
    }
  },
})

// `wipeAll` was DELETED (Phase-2 re-review): it had zero callers and,
// after being moved to internalMutation, called requireWorkspace in an
// internal ctx (no auth) → it would only ever throw. A no-snapshot
// total-wipe landmine with no purpose. Workspace reset, if ever
// needed, must go through the snapshotting delete paths.
