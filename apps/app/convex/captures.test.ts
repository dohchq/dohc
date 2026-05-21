/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import { CAPTURES_RETENTION_MS } from './captures'

// Phase 2 keystone engine — data-layer, model-independent, no auth
// bypass. Re-review hardening verified here.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_test'
const liveAtoms = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('atoms').collect()).filter((r: any) => r.workspaceId === W),
  )
const liveEntities = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('entities').collect()).filter((r: any) => r.workspaceId === W),
  )
const pending = async (t: ReturnType<typeof convexTest>) =>
  (await t.query(internal.captures._pending, { workspaceId: W })).items
const seedAtom = (t: ReturnType<typeof convexTest>, path: string) =>
  t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId: W, path, body: 'b', updatedAt: 1, source: 'agent' })
  })

describe('recordCapture VERIFIES the target exists (no ghost rows)', () => {
  it('capture of a non-existent atom is rejected — NO ledger row created', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(internal.captures._record, {
      workspaceId: W,
      items: [{ kind: 'atom', ref: 'ghost.md', summary: 'x', shared: true }],
    })
    expect(res[0]).toMatchObject({ ok: false })
    expect(res[0].error).toMatch(/not found/)
    expect(await pending(t)).toEqual([]) // no phantom in the digest
  })

  it('capture of a real atom records it', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'log.md')
    const res = await t.mutation(internal.captures._record, {
      workspaceId: W,
      items: [{ kind: 'atom', ref: 'log.md', summary: '{hours: 6}' }],
    })
    expect(res[0]).toMatchObject({ ok: true, tier: 'silent', status: 'auto' })
  })
})

describe('routing — no-tax for private, review for shared', () => {
  it('private → silent/auto, NEVER surfaces in the digest', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'log.md')
    await t.mutation(internal.captures._record, {
      workspaceId: W,
      items: [{ kind: 'atom', ref: 'log.md', summary: 's' }],
    })
    expect(await pending(t)).toEqual([])
  })
  it('shared → digest; unsure → inline (classifyAction routing)', async () => {
    const t = convexTest(schema, modules)
    // R3 §3: capture is STRUCTURAL + per-(ref,key) for BOTH kinds (the
    // no-`key` agent-tool row was removed for entities in R2.2 and for
    // atoms here — it is the dark-hole/lying-shared class). `_record`
    // no longer materialises a tiered `pending` digest row, so the
    // `classifyAction` tier ROUTING is asserted via the API RETURN
    // (still the single source of that decision).
    await seedAtom(t, 'a.md')
    await seedAtom(t, 'b.md')
    const res = await t.mutation(internal.captures._record, {
      workspaceId: W,
      items: [
        { kind: 'atom', ref: 'a.md', summary: 'shared', shared: true },
        { kind: 'atom', ref: 'b.md', summary: 'unsure', unsure: true },
      ],
    })
    expect(res.every((r: any) => r.ok)).toBe(true)
    expect(res.map((r: any) => r.tier).sort()).toEqual(['digest', 'inline'])
  })
})

describe('confirm / reject', () => {
  it('confirm: pending→confirmed; cross-workspace + double rejected', async () => {
    const t = convexTest(schema, modules)
    // R3: `_record` no longer makes a no-`key` pending row. _confirm
    // semantics (confirmable→confirmed; double-confirm rejected;
    // cross-workspace not-found) are exercised on a real per-(ref,key)
    // pending row — the shape recordCapture/structural capture make.
    const id = await t.run((ctx) =>
      ctx.db.insert('captures', {
        workspaceId: W, kind: 'atom', ref: 'a.md', key: 'hours',
        summary: 's', tier: 'inline', status: 'pending', createdAt: 1,
      }),
    )
    expect(await t.mutation(internal.captures._confirm, { workspaceId: W, captureId: id })).toMatchObject({ ok: true })
    expect(await pending(t)).toEqual([]) // no longer pending
    expect(await t.mutation(internal.captures._confirm, { workspaceId: W, captureId: id })).toMatchObject({ ok: false })
    expect(await t.mutation(internal.captures._confirm, { workspaceId: 'other', captureId: id })).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('reject is a PURE STATUS FLIP — host atom/entity is NOT destroyed', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'note.md', body: 'dohc value + USER PROSE', updatedAt: 1, source: 'agent' })
      await ctx.db.insert('entities', { workspaceId: W, type: 'client', slug: 'acme', data: { rate: 150 }, updatedAt: 1 })
    })
    await t.mutation(internal.captures._record, {
      workspaceId: W,
      items: [
        { kind: 'atom', ref: 'note.md', summary: 'a', shared: true },
        { kind: 'entity', ref: 'client/acme', summary: 'b', shared: true },
      ],
    })
    for (const c of await pending(t)) {
      await t.mutation(internal.captures._reject, { workspaceId: W, captureId: c.id })
    }
    // the document-bomb is gone: nothing deleted, no trash row
    expect(await liveAtoms(t)).toHaveLength(1)
    expect(await liveEntities(t)).toHaveLength(1)
    const trash = await t.run(async (ctx) => (await ctx.db.query('trash').collect()).length)
    expect(trash).toBe(0)
    expect(await pending(t)).toEqual([]) // rejected leaves the digest
  })
})

describe('retention purge — ONLY confirmed (Phase-3 keystone-leak fix)', () => {
  it('purges old CONFIRMED only; KEEPS old auto/pending/rejected (durable withhold signal)', async () => {
    const t = convexTest(schema, modules)
    const old = Date.now() - CAPTURES_RETENTION_MS - 1000
    await t.run(async (ctx) => {
      // non-confirmed = the cross-person withhold signal → MUST survive
      await ctx.db.insert('captures', { workspaceId: W, kind: 'atom', ref: 'old_auto', summary: 's', tier: 'silent', status: 'auto', createdAt: old })
      await ctx.db.insert('captures', { workspaceId: W, kind: 'atom', ref: 'old_pending', summary: 's', tier: 'digest', status: 'pending', createdAt: old })
      await ctx.db.insert('captures', { workspaceId: W, kind: 'atom', ref: 'old_rejected', summary: 's', tier: 'digest', status: 'rejected', createdAt: old })
      // confirmed = blessed history → the ONLY purgeable row
      await ctx.db.insert('captures', { workspaceId: W, kind: 'atom', ref: 'old_confirmed', summary: 's', tier: 'digest', status: 'confirmed', createdAt: old })
      await ctx.db.insert('captures', { workspaceId: W, kind: 'atom', ref: 'fresh', summary: 's', tier: 'silent', status: 'auto', createdAt: Date.now() })
    })
    const r = await t.mutation(internal.captures._purgeCaptures, {})
    expect(r).toMatchObject({ purged: 1, done: true }) // ONLY old_confirmed
    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).map((c: any) => c.ref).sort(),
    )
    // The leak fix: a never-confirmed value's withhold row OUTLIVES
    // retention — it does NOT silently become shareable after 30d.
    expect(remaining).toEqual(['fresh', 'old_auto', 'old_pending', 'old_rejected'])
  })
})

// P2 design v1 §4.5 — the per-(ref,key) "keep private" the consent
// digest needs. rejectRefKey is the LINE-FOR-LINE mirror of
// confirmRefKey; every locked invariant must hold BY CONSTRUCTION.
describe('rejectRefKey / public rejectKey — symmetric to confirmRefKey', () => {
  const rows = (t: ReturnType<typeof convexTest>, ws = W) =>
    t.run(async (ctx) =>
      (await ctx.db.query('captures').collect())
        .filter((c: any) => c.workspaceId === ws)
        .map((c: any) => ({ ref: c.ref, key: c.key, status: c.status })),
    )

  it('per-(ref,key): rejecting `hours` never touches `salary` or a no-`key` row', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', { workspaceId: W, kind: 'entity', ref: 'person/anna', key: 'hours', summary: 's', tier: 'digest', status: 'auto', createdAt: 1 })
      await ctx.db.insert('captures', { workspaceId: W, kind: 'entity', ref: 'person/anna', key: 'salary', summary: 's', tier: 'digest', status: 'pending', createdAt: 1 })
      // legacy whole-entity no-`key` row for the SAME ref — must be untouched
      await ctx.db.insert('captures', { workspaceId: W, kind: 'entity', ref: 'person/anna', summary: 's', tier: 'silent', status: 'auto', createdAt: 1 })
    })
    const n = await t.withIdentity({ subject: W }).mutation(api.captures.rejectKey, {
      kind: 'entity', ref: 'person/anna', key: 'hours',
    })
    expect(n).toEqual({ ok: true, rejected: 1 })
    // sorted by String(key): 'hours' < 'salary' < 'undefined' (no-key)
    expect((await rows(t)).sort((a, b) => `${a.key}`.localeCompare(`${b.key}`))).toEqual([
      { ref: 'person/anna', key: 'hours', status: 'rejected' }, // exactly this
      { ref: 'person/anna', key: 'salary', status: 'pending' }, // sibling untouched
      { ref: 'person/anna', key: undefined, status: 'auto' }, // no-key untouched
    ])
  })

  it('terminal guard: a CONFIRMED row is NEVER flipped to rejected (no un-share)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', { workspaceId: W, kind: 'atom', ref: 'note.md', key: 'k', summary: 's', tier: 'digest', status: 'confirmed', createdAt: 1 })
    })
    const n = await t.withIdentity({ subject: W }).mutation(api.captures.rejectKey, {
      kind: 'atom', ref: 'note.md', key: 'k',
    })
    expect(n).toEqual({ ok: true, rejected: 0 }) // nothing non-confirmed to reject
    expect(await rows(t)).toEqual([{ ref: 'note.md', key: 'k', status: 'confirmed' }])
  })

  it('idempotent: rejecting an already-rejected (ref,key) is a no-op', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', { workspaceId: W, kind: 'atom', ref: 'n.md', key: 'k', summary: 's', tier: 'digest', status: 'rejected', createdAt: 1 })
    })
    const a = await t.withIdentity({ subject: W }).mutation(api.captures.rejectKey, { kind: 'atom', ref: 'n.md', key: 'k' })
    expect(a).toEqual({ ok: true, rejected: 0 })
    expect(await rows(t)).toEqual([{ ref: 'n.md', key: 'k', status: 'rejected' }])
  })

  it('cross-workspace: rejectKey only ever touches the CALLER’s captures', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', { workspaceId: W, kind: 'entity', ref: 'r', key: 'k', summary: 's', tier: 'digest', status: 'auto', createdAt: 1 })
      await ctx.db.insert('captures', { workspaceId: 'ws_other', kind: 'entity', ref: 'r', key: 'k', summary: 's', tier: 'digest', status: 'auto', createdAt: 1 })
    })
    await t.withIdentity({ subject: W }).mutation(api.captures.rejectKey, { kind: 'entity', ref: 'r', key: 'k' })
    expect(await rows(t, W)).toEqual([{ ref: 'r', key: 'k', status: 'rejected' }])
    expect(await rows(t, 'ws_other')).toEqual([{ ref: 'r', key: 'k', status: 'auto' }]) // foreign untouched
  })

  it('unauthenticated rejectKey throws (no anonymous write path)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.rejectKey, { kind: 'entity', ref: 'r', key: 'k' }),
    ).rejects.toThrow()
  })
})
