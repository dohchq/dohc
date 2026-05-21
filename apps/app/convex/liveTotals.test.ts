/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

// Phase 4 Unit 4a — the live-total adapter. The load-bearing check:
// UC-3/EF4 — resolving a `{identifier}` is a pure READ; it must NEVER
// write a value into a note body. Cross-desk reuses the SAME
// resolveWindow core (reviewed-by-default + grant enforced there).

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const VIEWER = 'ws_viewer'
type T = ReturnType<typeof convexTest>
const asOwner = (t: T) => t.withIdentity({ subject: OWNER })
const asViewer = (t: T) => t.withIdentity({ subject: VIEWER })

const bodies = (t: T, ws: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('atoms').collect())
      .filter((r: any) => r.workspaceId === ws)
      .map((r: any) => r.body)
      .sort(),
  )

describe('liveTotals.resolve — ownDesk (markdown is truth; never written back)', () => {
  it('sums {key: n} value-atoms parsed from the caller’s OWN notes', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: VIEWER, path: 'a.md', body: 'Logged {billable: 6} on Acme.', updatedAt: 1 })
      await ctx.db.insert('atoms', { workspaceId: VIEWER, path: 'b.md', body: 'More {billable: 4}. Note {billable: "skip"}.', updatedAt: 1 })
      // another desk's note must never be summed
      await ctx.db.insert('atoms', { workspaceId: OWNER, path: 'x.md', body: '{billable: 999}', updatedAt: 1 })
    })
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER,
      identifier: 'billable_total',
      spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
    })

    const before = await bodies(t, VIEWER)
    const r = await asViewer(t).query(api.liveTotals.resolve, {
      identifier: 'billable_total',
    })
    expect(r).toEqual({ value: 10 }) // 6 + 4 ; string "skip" NOT coerced
    // UC-3: the note bodies are byte-identical after resolve.
    expect(await bodies(t, VIEWER)).toEqual(before)
  })

  it('count; and no-match ⇒ null (renders ___ , not a misleading 0)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: VIEWER, path: 'a.md', body: '{task: x} {task: y}', updatedAt: 1 })
    })
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'task_count', spec: { kind: 'ownDesk', op: 'count', key: 'task' },
    })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'task_count' })).toEqual({ value: 2 })

    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'nope', spec: { kind: 'ownDesk', op: 'sum', key: 'absent' },
    })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'nope' })).toEqual({ value: null })
  })

  it('undefined identifier / bad grammar / unauth ⇒ fail-soft (null / throw)', async () => {
    const t = convexTest(schema, modules)
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'never_defined' })).toEqual({ value: null })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'a-b' })).toEqual({ value: null })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: '__proto__' })).toEqual({ value: null })
    await expect(
      t.query(api.liveTotals.resolve, { identifier: 'x' }),
    ).rejects.toThrow(/Not authenticated/)
  })
})

describe('liveTotals.resolve — window (cross-desk, reuses resolveWindow)', () => {
  async function setupWindow(t: T): Promise<Id<'windows'>> {
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', { workspaceId: OWNER, type: 'person', slug: 'anna', data: { hours: 6 }, updatedAt: 1 })
      await ctx.db.insert('entities', { workspaceId: OWNER, type: 'person', slug: 'bo', data: { hours: 4 }, updatedAt: 1 })
    })
    return await asOwner(t).mutation(api.windows.createWindow, {
      name: 'team', selectorKeys: ['hours'],
      aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
    })
  }

  it('granted ⇒ the aggregate; revoked / no-grant ⇒ null (withheld, fail-soft)', async () => {
    const t = convexTest(schema, modules)
    const w = await setupWindow(t)
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'team_hours', spec: { kind: 'window', windowId: w },
    })

    // no grant yet → withheld → null
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'team_hours' })).toEqual({ value: null })

    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'team_hours' })).toEqual({ value: 10 })

    await asOwner(t).mutation(api.windows.revoke, { windowId: w, viewerWorkspaceId: VIEWER })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'team_hours' })).toEqual({ value: null })
  })

  it('a non-confirmed (unreviewed) capture withholds the cross-desk total even WITH a grant', async () => {
    const t = convexTest(schema, modules)
    const w = await setupWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'team_hours', spec: { kind: 'window', windowId: w },
    })
    // R2.2 per-(entity,key): a no-key row over-withholds ONLY its own
    // entity (the coarse cross-entity `${owner} ${key}` backstop was
    // removed — Codex R2.1 HIGH #2). To withhold the whole cross-desk
    // total, every contributing entity must be non-confirmed.
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/anna',
        summary: 's', tier: 'inline', status: 'pending', createdAt: 1,
      })
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/bo',
        summary: 's', tier: 'inline', status: 'pending', createdAt: 1,
      })
    })
    // both contributors withheld → no operands → withheld total (null)
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'team_hours' })).toEqual({ value: null })
  })
})

describe('liveTotals.resolve — REGRESSION: rename target == aggregate `as` (Codex HIGH)', () => {
  it('the collision config returns the real value WITH data, and `___` (not a misleading 0) when withheld', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', { workspaceId: OWNER, type: 'person', slug: 'anna', data: { hours: 6 }, updatedAt: 1 })
      await ctx.db.insert('entities', { workspaceId: OWNER, type: 'person', slug: 'bo', data: { hours: 4 }, updatedAt: 1 })
    })
    // rename target 'team_hours' collides with the aggregate `as`
    // 'team_hours' — the exact shape that defeated the old view-key
    // heuristic into returning a misleading 0.
    const w = await asOwner(t).mutation(api.windows.createWindow, {
      name: 'collide',
      selectorKeys: ['hours'],
      rename: { hours: 'team_hours' },
      aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
    })
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'team_hours', spec: { kind: 'window', windowId: w },
    })

    // data flows → real sum (sourceCount ≥ 1, not view-key inference)
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'team_hours' })).toEqual({ value: 10 })

    // withheld → `___`, NEVER a misleading 0. R2.2 per-(entity,key):
    // withhold BOTH contributors (no-key rows over-withhold only their
    // own entity; the coarse cross-entity backstop was removed).
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/anna',
        summary: 's', tier: 'inline', status: 'pending', createdAt: 1,
      })
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/bo',
        summary: 's', tier: 'inline', status: 'pending', createdAt: 1,
      })
    })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'team_hours' })).toEqual({ value: null })
  })

  it('selector key != aggregate key (empty aggregate) ⇒ `___`, not a misleading 0 (Codex HIGH #2)', async () => {
    const t = convexTest(schema, modules)
    // entity has `name` (a crossing selector key) but NO `hours` —
    // the aggregate key. selected.length>=1 but ZERO aggregate
    // operands. The old sourceCount gate returned a misleading 0.
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', { workspaceId: OWNER, type: 'person', slug: 'anna', data: { name: 'Anna' }, updatedAt: 1 })
    })
    const w = await asOwner(t).mutation(api.windows.createWindow, {
      name: 'mismatch',
      selectorKeys: ['name'],
      aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
    })
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'team_hours', spec: { kind: 'window', windowId: w },
    })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'team_hours' })).toEqual({ value: null })

    // count over a non-present key is likewise unavailable cross-desk
    const w2 = await asOwner(t).mutation(api.windows.createWindow, {
      name: 'mismatch_count',
      selectorKeys: ['name'],
      aggregate: { key: 'hours', op: 'count', as: 'n_hours' },
    })
    await asOwner(t).mutation(api.windows.grant, { windowId: w2, viewerWorkspaceId: VIEWER })
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'n_hours', spec: { kind: 'window', windowId: w2 },
    })
    expect(await asViewer(t).query(api.liveTotals.resolve, { identifier: 'n_hours' })).toEqual({ value: null })
  })
})

describe('liveTotals._define — idempotent + loud on bad ids', () => {
  it('redefining updates; bad identifier/key throws', async () => {
    const t = convexTest(schema, modules)
    const a = await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'k', spec: { kind: 'ownDesk', op: 'sum', key: 'x' },
    })
    expect(a).toEqual({ ok: true, updated: false })
    const b = await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER, identifier: 'k', spec: { kind: 'ownDesk', op: 'count', key: 'x' },
    })
    expect(b).toEqual({ ok: true, updated: true })
    await expect(
      t.mutation(internal.liveTotals._define, {
        workspaceId: VIEWER, identifier: 'a-b', spec: { kind: 'ownDesk', op: 'sum', key: 'x' },
      }),
    ).rejects.toThrow(/invalid rollup identifier/)
    await expect(
      t.mutation(internal.liveTotals._define, {
        workspaceId: VIEWER, identifier: 'ok', spec: { kind: 'ownDesk', op: 'sum', key: 'a/b' },
      }),
    ).rejects.toThrow(/invalid rollup key/)
  })
})
