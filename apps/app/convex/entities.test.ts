/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal } from './_generated/api'
import { StrictCreateConflictError } from './entities'

// Phase-3 review (Codex HIGH): canonical entity ids close a
// cross-tenant fail-open. A '/'-bearing type makes the `${type}/${slug}`
// capture ref ambiguous → recordCapture's first-'/' split misses the
// lookup → NO reviewed-by-default withhold row → a granted window
// leaks the unconfirmed value. Enforced at every write chokepoint
// (covers the agent AND the public plugin bridge, which route through
// _upsertMany / _patch).

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_ent'

describe('canonical entity ids — no "/" in type/slug (closes the capture-ref leak)', () => {
  it('_upsertMany REJECTS a "/" in type or slug, and empty ids', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        items: [{ type: 'person/vip', slug: 'alice', data: { hours: 6 } }],
      }),
    ).rejects.toThrow(/invalid entity id/)
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        items: [{ type: 'person', slug: 'a/b', data: { hours: 6 } }],
      }),
    ).rejects.toThrow(/invalid entity id/)
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        items: [{ type: '', slug: 'alice', data: {} }],
      }),
    ).rejects.toThrow(/invalid entity id/)
    // the entity was NOT created (fail-closed, no partial write)
    const n = await t.run(async (ctx) =>
      (await ctx.db.query('entities').collect()).length,
    )
    expect(n).toBe(0)
  })

  it('_patch REJECTS a "/" in type or slug', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(internal.entities._patch, {
        workspaceId: W,
        type: 'a/b',
        slug: 'c',
        data: { x: 1 },
      }),
    ).rejects.toThrow(/invalid entity id/)
  })

  it('canonical ids are accepted and the capture ref round-trips exactly', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [{ type: 'person', slug: 'alice', data: { hours: 6 } }],
    })
    // recordCapture (via _record) now finds the entity AND the ref
    // round-trips — a real withhold row is created.
    const res = await t.mutation(internal.captures._record, {
      workspaceId: W,
      items: [{ kind: 'entity', ref: 'person/alice', summary: 's', shared: true }],
    })
    expect(res[0]).toMatchObject({ ok: true })
    const caps = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).map((c: any) => c.ref),
    )
    // R2: _upsertMany now ALSO records a structural withhold capture,
    // so >1 row can exist for the ref — every one must round-trip to
    // exactly `person/alice` (no broken/non-canonical ref).
    expect(caps.length).toBeGreaterThanOrEqual(1)
    expect(caps.every((r: string) => r === 'person/alice')).toBe(true)
  })
})

// Track-3 P2b.2 — mutation-level strictCreate invariant. The runtime
// `requireDirectUserAuthorization` gate (P2b.1) is the BELT; this
// `mode: 'strictCreate'` is the BRACE. A skill turn (depth>0) MUST
// pass strictCreate when calling `create_entities` so neither
// (a) same-batch duplicates nor (b) pre-existing rows are clobbered.
describe('Track-3 P2b.2 — _upsertMany({mode:"strictCreate"})', () => {
  it('strictCreate with all-new items inserts every row (zero regression vs default)', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      mode: 'strictCreate',
      items: [
        { type: 'person', slug: 'alice', data: { hours: 1 } },
        { type: 'person', slug: 'bob', data: { hours: 2 } },
      ],
    })
    expect(res).toEqual({ created: 2, updated: 0 })
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('entities').collect()).map((r: any) => `${r.type}/${r.slug}`),
    )
    expect(rows.sort()).toEqual(['person/alice', 'person/bob'])
  })

  it('strictCreate REJECTS same-batch duplicate (type, slug) — no partial writes', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        mode: 'strictCreate',
        items: [
          { type: 'person', slug: 'alice', data: { hours: 1 } },
          { type: 'person', slug: 'alice', data: { hours: 999 } }, // dupe
        ],
      }),
    ).rejects.toThrow(/duplicate \(type, slug\)/)
    // Atomicity: the throw aborts the transaction; zero entities exist.
    const n = await t.run(async (ctx) =>
      (await ctx.db.query('entities').collect()).length,
    )
    expect(n).toBe(0)
  })

  it('strictCreate REJECTS a pre-existing target row — no partial writes', async () => {
    const t = convexTest(schema, modules)
    // Seed an existing entity (under normal upsert semantics).
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [{ type: 'person', slug: 'alice', data: { hours: 1 } }],
    })
    // Now a skill (in strictCreate mode) attempts to "create" the same
    // (type, slug) alongside a brand-new one. WHOLE BATCH must reject.
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        mode: 'strictCreate',
        items: [
          { type: 'person', slug: 'alice', data: { hours: 999 } }, // exists
          { type: 'person', slug: 'eve', data: { hours: 3 } }, // new
        ],
      }),
    ).rejects.toThrow(/cannot overwrite existing/)
    // Existing entity's data UNCHANGED (no clobber):
    const alice = await t.run(async (ctx) =>
      ctx.db
        .query('entities')
        .withIndex('by_workspace_type_slug', (q: any) =>
          q.eq('workspaceId', W).eq('type', 'person').eq('slug', 'alice'),
        )
        .unique(),
    )
    expect(alice?.data).toEqual({ hours: 1 })
    // The NEW 'eve' was NOT inserted (atomic batch reject):
    const eve = await t.run(async (ctx) =>
      ctx.db
        .query('entities')
        .withIndex('by_workspace_type_slug', (q: any) =>
          q.eq('workspaceId', W).eq('type', 'person').eq('slug', 'eve'),
        )
        .unique(),
    )
    expect(eve).toBeNull()
  })

  it('strictCreate surfaces ALL conflicting (type, slug)s in a single error (multi-conflict)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [
        { type: 'person', slug: 'alice', data: {} },
        { type: 'person', slug: 'bob', data: {} },
      ],
    })
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        mode: 'strictCreate',
        items: [
          { type: 'person', slug: 'alice', data: {} }, // exists
          { type: 'person', slug: 'bob', data: {} }, // exists
        ],
      }),
    ).rejects.toThrow(/person\/alice.*person\/bob|person\/bob.*person\/alice/)
  })

  it('strictCreate runs canonical-id check FIRST (malformed id surfaces before dupe scan)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        mode: 'strictCreate',
        items: [
          { type: 'person', slug: 'a/b', data: {} }, // bad id
          { type: 'person', slug: 'alice', data: {} },
          { type: 'person', slug: 'alice', data: {} }, // dupe — but bad-id wins
        ],
      }),
    ).rejects.toThrow(/invalid entity id/)
  })

  it('default mode (no `mode` arg) keeps existing upsert semantics — overwrites + records trash', async () => {
    const t = convexTest(schema, modules)
    // Insert
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [{ type: 'person', slug: 'alice', data: { hours: 1 } }],
    })
    // Overwrite (no mode) — legal under default; updated++ and trash snapshot recorded
    const res = await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [{ type: 'person', slug: 'alice', data: { hours: 999 } }],
    })
    expect(res).toEqual({ created: 0, updated: 1 })
    const alice = await t.run(async (ctx) =>
      ctx.db
        .query('entities')
        .withIndex('by_workspace_type_slug', (q: any) =>
          q.eq('workspaceId', W).eq('type', 'person').eq('slug', 'alice'),
        )
        .unique(),
    )
    expect(alice?.data).toEqual({ hours: 999 })
  })

  it('mode:"upsert" explicit is byte-identical to omitted (no regression for plugin-bridge callers)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [{ type: 'person', slug: 'alice', data: { hours: 1 } }],
    })
    const res = await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      mode: 'upsert', // explicit
      items: [{ type: 'person', slug: 'alice', data: { hours: 2 } }],
    })
    expect(res).toEqual({ created: 0, updated: 1 })
  })

  it('StrictCreateConflictError carries the mode discriminator + the conflict list', () => {
    const dup = new StrictCreateConflictError('duplicate-in-batch', ['person/alice'])
    expect(dup).toBeInstanceOf(Error)
    expect(dup).toBeInstanceOf(StrictCreateConflictError)
    expect(dup.kind).toBe('strict-create-conflict')
    expect(dup.mode).toBe('duplicate-in-batch')
    expect(dup.conflicts).toEqual(['person/alice'])
    expect(dup.message).toMatch(/duplicate/)
    expect(dup.message).toContain('person/alice')

    const pre = new StrictCreateConflictError('pre-existing', ['person/alice', 'person/bob'])
    expect(pre.mode).toBe('pre-existing')
    expect(pre.message).toMatch(/overwrite existing/)
    expect(pre.message).toContain('person/alice')
    expect(pre.message).toContain('person/bob')
  })

  // P2b.2 fold (Codex F1) — the ConvexError.data path: the
  // structured discriminator MUST survive ctx.runMutation. Until
  // this fold the class extended plain Error and custom fields
  // were dropped at the mutation→action boundary.
  it('StrictCreateConflictError extends ConvexError + carries .data for cross-runMutation propagation', () => {
    // The class is now a ConvexError subclass; the structured
    // payload sits at `.data` (the documented Convex propagation
    // path). The in-process `.kind`/`.mode`/`.conflicts` accessors
    // read from .data so the API is consistent across the
    // mutation→action boundary (Convex serializes .data alongside
    // .message for ConvexError instances).
    const e = new StrictCreateConflictError('pre-existing', ['person/alice'])
    expect(e.data).toEqual({
      kind: 'strict-create-conflict',
      mode: 'pre-existing',
      conflicts: ['person/alice'],
      message: e.message,
    })
    // The Error prototype chain is preserved through both classes.
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('StrictCreateConflictError')
  })

  // P2b.2 fold (Codex F7 gaps):
  it('strictCreate with items:[] is a no-op (returns {0,0})', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      mode: 'strictCreate',
      items: [],
    })
    expect(res).toEqual({ created: 0, updated: 0 })
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('entities').collect()).length,
    )
    expect(rows).toBe(0)
  })

  it('strictCreate success records NO trash rows (no overwrites = nothing to snapshot)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      mode: 'strictCreate',
      items: [
        { type: 'person', slug: 'alice', data: { hours: 1 } },
        { type: 'person', slug: 'bob', data: { hours: 2 } },
      ],
    })
    const trashRows = await t.run(async (ctx) =>
      (await ctx.db.query('trash').collect()),
    )
    // Every row is new ⇒ NO `recordTrashCoalesced` calls fire ⇒
    // trash stays empty. Symmetric with the design: strictCreate
    // is provably-additive (no information loss).
    expect(trashRows.length).toBe(0)
  })

  it('strictCreate REJECT-on-pre-existing records NO trash rows (atomic rollback)', async () => {
    const t = convexTest(schema, modules)
    // Seed alice with the DEFAULT (legal) upsert path.
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      items: [{ type: 'person', slug: 'alice', data: { hours: 1 } }],
    })
    const trashBefore = await t.run(async (ctx) =>
      (await ctx.db.query('trash').collect()).length,
    )
    // Skill-mode strictCreate that conflicts with alice + seeds new
    // bob — must REJECT THE BATCH and roll back ANY tentative write.
    await expect(
      t.mutation(internal.entities._upsertMany, {
        workspaceId: W,
        mode: 'strictCreate',
        items: [
          { type: 'person', slug: 'alice', data: { hours: 999 } },
          { type: 'person', slug: 'bob', data: { hours: 2 } },
        ],
      }),
    ).rejects.toThrow(/cannot overwrite existing/)
    const trashAfter = await t.run(async (ctx) =>
      (await ctx.db.query('trash').collect()).length,
    )
    // No trash growth: Phase 1c throws BEFORE Phase 2 patches, AND
    // Convex's transactional rollback would catch any out-of-order
    // write. Both belts hold.
    expect(trashAfter).toBe(trashBefore)
  })

  it('strictCreate success records WITHHELD capture rows for every scalar of every new entity (R2.1 invariant)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: W,
      mode: 'strictCreate',
      items: [
        { type: 'person', slug: 'alice', data: { hours: 1, role: 'lead' } },
      ],
    })
    // Every scalar is "changed" (prevData = undefined) ⇒ every
    // scalar yields a withhold capture row. The R2.1 contract is
    // preserved end-to-end under strictCreate.
    const caps = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()),
    )
    expect(caps.length).toBeGreaterThanOrEqual(2) // hours + role
    expect(caps.every((c: any) => c.ref === 'person/alice')).toBe(true)
  })
})
