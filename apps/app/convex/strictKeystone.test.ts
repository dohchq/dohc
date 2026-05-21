/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

// R2 — STRICT reviewed-by-default (holistic review C2/C3/M6).
// Capture is a byproduct of the WRITE (structural, not prompt-hope):
// every entity write — agent AND the PUBLIC pluginBridge — is
// withheld from shared windows until the owner EXPLICITLY confirms.

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const VIEWER = 'ws_viewer'
type T = ReturnType<typeof convexTest>
const asOwner = (t: T) => t.withIdentity({ subject: OWNER })
const asViewer = (t: T) => t.withIdentity({ subject: VIEWER })

async function windowOverHours(t: T): Promise<Id<'windows'>> {
  return await asOwner(t).mutation(api.windows.createWindow, {
    name: 'team',
    selectorKeys: ['hours'],
    aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
  })
}
const hoursVisible = async (t: T, w: Id<'windows'>) => {
  const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
  return r.ok === true && 'hours' in r.view
}
const capsFor = (t: T, ws: string, ref: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('captures').collect()).filter(
      (c: any) => c.workspaceId === ws && c.kind === 'entity' && c.ref === ref,
    ),
  )

describe('R2.1 — per-(entity,key): confirming one key never releases another (Codex CRITICAL)', () => {
  it('confirm an hours-window ⇒ a granted salary-window STILL withholds salary', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER,
      items: [{ type: 'person', slug: 'anna', data: { hours: 6, salary: 200000 } }],
    })
    const wHours = await asOwner(t).mutation(api.windows.createWindow, {
      name: 'hours', selectorKeys: ['hours'],
      aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
    })
    const wSalary = await asOwner(t).mutation(api.windows.createWindow, {
      name: 'salary', selectorKeys: ['salary'],
      aggregate: { key: 'salary', op: 'sum', as: 'tot_salary' },
    })
    await asOwner(t).mutation(api.windows.grant, { windowId: wHours, viewerWorkspaceId: VIEWER })
    await asOwner(t).mutation(api.windows.grant, { windowId: wSalary, viewerWorkspaceId: VIEWER })

    const keyVisible = async (w: Id<'windows'>, k: string) => {
      const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
      return r.ok === true && k in r.view
    }
    // both withheld initially
    expect(await keyVisible(wHours, 'hours')).toBe(false)
    expect(await keyVisible(wSalary, 'salary')).toBe(false)

    // owner reviews + confirms ONLY the hours window
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER, windowId: wHours,
    })
    expect(c).toMatchObject({ ok: true })

    expect(await keyVisible(wHours, 'hours')).toBe(true) // released
    expect(await keyVisible(wSalary, 'salary')).toBe(false) // NOT released — the fix
    // and salary stays blocked until ITS window is confirmed
    await t.mutation(internal.windows._confirmWithheldFor, { workspaceId: OWNER, windowId: wSalary })
    expect(await keyVisible(wSalary, 'salary')).toBe(true)
  })
})

describe('R2/C2 — every entity write is withheld until explicit confirm', () => {
  it('agent write (_upsertMany) ⇒ withheld through a granted window; confirm ⇒ flows', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER,
      items: [{ type: 'person', slug: 'anna', data: { hours: 6 } }],
    })
    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })

    // structural capture exists ⇒ withheld even WITH a grant
    expect(await hoursVisible(t, w)).toBe(false)

    // owner confirms at the edge → now flows
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(c).toMatchObject({ ok: true })
    expect(c.confirmed).toBeGreaterThanOrEqual(1)
    expect(await hoursVisible(t, w)).toBe(true)
  })

  it('a later _patch RE-withholds until re-confirmed', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER, items: [{ type: 'person', slug: 'anna', data: { hours: 6 } }],
    })
    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.mutation(internal.windows._confirmWithheldFor, { workspaceId: OWNER, windowId: w })
    expect(await hoursVisible(t, w)).toBe(true)

    await t.mutation(internal.entities._patch, {
      workspaceId: OWNER, type: 'person', slug: 'anna', data: { hours: 9 },
    })
    expect(await hoursVisible(t, w)).toBe(false) // change ⇒ re-withheld
    await t.mutation(internal.windows._confirmWithheldFor, { workspaceId: OWNER, windowId: w })
    expect(await hoursVisible(t, w)).toBe(true)
  })

  it('the PUBLIC pluginBridge write is ALSO structurally withheld (the C2 exploit path)', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).action(api.pluginBridge.mutate, {
      op: 'upsert', type: 'person', slug: 'anna', data: { hours: 999 },
    })
    const caps = await capsFor(t, OWNER, 'person/anna')
    expect(caps.length).toBe(1)
    expect(caps[0].status).toBe('auto') // withheld, not shareable
    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    expect(await hoursVisible(t, w)).toBe(false) // 999 does NOT leak
  })
})

describe('R2/C3 — auto is confirmable / rejectable (no permanent dark-hole)', () => {
  it('_confirm and _reject accept a structural `auto` capture', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER, items: [{ type: 'person', slug: 'anna', data: { hours: 6 } }],
    })
    const id = (await capsFor(t, OWNER, 'person/anna'))[0]._id as Id<'captures'>
    expect(
      await t.mutation(internal.captures._confirm, { workspaceId: OWNER, captureId: id }),
    ).toMatchObject({ ok: true })

    const t2 = convexTest(schema, modules)
    await t2.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER, items: [{ type: 'person', slug: 'bo', data: { hours: 4 } }],
    })
    const id2 = (await capsFor(t2, OWNER, 'person/bo'))[0]._id as Id<'captures'>
    expect(
      await t2.mutation(internal.captures._reject, { workspaceId: OWNER, captureId: id2 }),
    ).toMatchObject({ ok: true })
  })
})

describe('R2 — consent report is ACCURATE (review MED: no lying "shared")', () => {
  it('a rejected-only ref is reported BLOCKED, not shared, and stays withheld', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER, items: [{ type: 'person', slug: 'anna', data: { hours: 6 } }],
    })
    const id = (await capsFor(t, OWNER, 'person/anna'))[0]._id as Id<'captures'>
    await t.mutation(internal.captures._reject, { workspaceId: OWNER, captureId: id })

    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER, windowId: w,
    })
    expect(c).toMatchObject({
      ok: true,
      confirmed: 0,
      sharedRefs: [],
      blockedRefs: ['person/anna'], // honestly reported as still blocked
    })
    expect(await hoursVisible(t, w)).toBe(false) // correctly withheld (fail-closed)
  })
})

describe('R2 — consent-at-the-edge (windows.withheldFor)', () => {
  it('owner-only; lists exactly the window’s withheld values', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER,
      items: [
        { type: 'person', slug: 'anna', data: { hours: 6, secret: 'x' } },
        { type: 'person', slug: 'bo', data: { rate: 9 } }, // no `hours`
      ],
    })
    const w = await windowOverHours(t)

    // a non-owner cannot inspect it
    expect(
      await asViewer(t).query(api.windows.withheldFor, { windowId: w }),
    ).toMatchObject({ ok: false, reason: 'not-your-window' })

    const r = await asOwner(t).query(api.windows.withheldFor, { windowId: w })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // only anna (has `hours`); only the `hours` key; NOT `secret`, NOT bo
      expect(r.items).toHaveLength(1)
      expect(r.items[0]).toMatchObject({ ref: 'person/anna', keys: ['hours'] })
    }
  })
})

describe('R2/M6 — delete clears captures; recreate is freshly withheld (no stale confirm leak)', () => {
  it('confirm → delete → recreate ⇒ the NEW value is withheld, not auto-shared by a stale confirm', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER, items: [{ type: 'person', slug: 'anna', data: { hours: 6 } }],
    })
    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.mutation(internal.windows._confirmWithheldFor, { workspaceId: OWNER, windowId: w })
    expect(await hoursVisible(t, w)).toBe(true)

    await t.mutation(internal.entities._delete, {
      workspaceId: OWNER, type: 'person', slug: 'anna',
    })
    expect(await capsFor(t, OWNER, 'person/anna')).toHaveLength(0) // M6: cleared

    // recreate the SAME type/slug with a DIFFERENT value
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER, items: [{ type: 'person', slug: 'anna', data: { hours: 1000 } }],
    })
    // must be WITHHELD again — the old confirm must NOT leak 1000
    expect(await hoursVisible(t, w)).toBe(false)
    const caps = await capsFor(t, OWNER, 'person/anna')
    expect(caps).toHaveLength(1)
    expect(caps[0].status).toBe('auto')
  })
})

describe('R2/C2 — restore is the 4th entity-write chokepoint (no leak via trash)', () => {
  it('delete → restore ⇒ the restored entity is WITHHELD (fresh auto), not auto-shared', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER, items: [{ type: 'person', slug: 'anna', data: { hours: 6 } }],
    })
    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.mutation(internal.windows._confirmWithheldFor, { workspaceId: OWNER, windowId: w })
    expect(await hoursVisible(t, w)).toBe(true)

    await t.mutation(internal.entities._delete, {
      workspaceId: OWNER, type: 'person', slug: 'anna',
    })
    const trashId = await t.run(async (ctx) => {
      const row = (await ctx.db.query('trash').collect()).find(
        (r: any) => r.workspaceId === OWNER && r.kind === 'entity',
      )
      return row?._id
    })
    expect(trashId).toBeTruthy()
    const res = await t.mutation(internal.trash._restore, {
      workspaceId: OWNER, trashId: trashId as Id<'trash'>,
    })
    expect(res).toMatchObject({ ok: true })

    // restored ⇒ a fresh auto capture ⇒ withheld until re-confirmed;
    // the prior confirm must NOT leak the restored value.
    const caps = await capsFor(t, OWNER, 'person/anna')
    expect(caps).toHaveLength(1)
    expect(caps[0].status).toBe('auto')
    expect(await hoursVisible(t, w)).toBe(false)
  })
})

describe('R2 — coalescing (no row pile-up; re-withhold after confirm)', () => {
  it('repeat writes ⇒ one non-confirmed row; confirm then write ⇒ fresh auto', async () => {
    const t = convexTest(schema, modules)
    const write = () =>
      t.mutation(internal.entities._upsertMany, {
        workspaceId: OWNER, items: [{ type: 'person', slug: 'anna', data: { hours: Math.random() } }],
      })
    await write()
    await write()
    await write()
    let caps = await capsFor(t, OWNER, 'person/anna')
    expect(caps.filter((c: any) => c.status !== 'confirmed')).toHaveLength(1) // coalesced

    const id = caps[0]._id as Id<'captures'>
    await t.mutation(internal.captures._confirm, { workspaceId: OWNER, captureId: id })
    await write() // a change after confirm
    caps = await capsFor(t, OWNER, 'person/anna')
    expect(caps.filter((c: any) => c.status === 'auto')).toHaveLength(1) // re-withheld
  })
})

// ── R2.2 dual-re-review regression coverage ─────────────────────────
// Closes the gaps the R2.1 holistic re-review flagged: the removed
// coarse `${owner} ${key}` backstop must NOT collapse the same key
// across DIFFERENT entities (Finding 2), and the no-key / agent-tool
// path must be per-key — never a permanent whole-entity dark-hole with
// a lying "shared" report (Codex R2.1 HIGH #1 / Finding 3).

describe('R2.2/Finding-2 — same `hours` key across two entities is INDEPENDENT (no marquee collapse)', () => {
  it('confirming entity A’s hours neither releases NOR collapses entity B’s hours; partial sum is live, not 0/null', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER,
      items: [
        { type: 'person', slug: 'a', data: { hours: 6 } },
        { type: 'person', slug: 'b', data: { hours: 4 } },
      ],
    })
    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })

    const agg = async () => {
      const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
      return r.ok === true ? (r.view.team_hours as number | undefined) ?? null : null
    }
    // both structurally withheld → `hours` projects for NEITHER entity.
    // (At the windows.resolve layer the empty sum is the raw 0; the
    // liveTotals layer is what maps "no operands" → ___/null, proven in
    // liveTotals.test.ts. The withheld signal here is the absent key.)
    expect(await hoursVisible(t, w)).toBe(false)

    // confirm ONLY person/a's hours (its own per-(ref,key) auto row)
    const idA = (await capsFor(t, OWNER, 'person/a'))[0]._id as Id<'captures'>
    await t.mutation(internal.captures._confirm, { workspaceId: OWNER, captureId: idA })

    // A flows; B's SAME `hours` key is NOT released by A's confirm
    // (coarse cross-entity backstop removed — Codex R2.1 HIGH #2) and
    // NOT collapsed — the rollup re-resolves per-(entity,key) live.
    expect(await hoursVisible(t, w)).toBe(true) // A's hours projects
    expect(await agg()).toBe(6) // exactly A; partial, real, live (not 10, not 0)
    const stillB = await capsFor(t, OWNER, 'person/b')
    expect(stillB).toHaveLength(1)
    expect(stillB[0].status).toBe('auto') // B untouched by A's confirm

    // confirm B too → full cross-entity sum
    const idB = stillB[0]._id as Id<'captures'>
    await t.mutation(internal.captures._confirm, { workspaceId: OWNER, captureId: idB })
    expect(await agg()).toBe(10)
  })
})

describe('R2.2/Finding-3 — no-key / agent-tool path is per-key, never a lying dark-hole', () => {
  it('the agent `capture` tool on a multi-key entity ENSURES per-key rows — it never creates a no-key row', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER,
      items: [{ type: 'person', slug: 'anna', data: { hours: 6, salary: 200000 } }],
    })
    // agent follows its prompt and records the ENTITY ref (no key)
    const res = await t.mutation(internal.captures._record, {
      workspaceId: OWNER,
      items: [{ kind: 'entity', ref: 'person/anna', summary: 'dohc touched anna' }],
    })
    expect(res[0]).toMatchObject({ ref: 'person/anna', ok: true })

    const caps = await capsFor(t, OWNER, 'person/anna')
    // exactly one row PER scalar key (idempotent coalesce), and NOT ONE
    // of them is the no-key whole-entity dark-hole.
    expect(caps.every((c: any) => typeof c.key === 'string' && c.key.length > 0)).toBe(true)
    expect(caps.some((c: any) => c.key === undefined || c.key === null || c.key === '')).toBe(false)
    expect([...new Set(caps.map((c: any) => c.key))].sort()).toEqual(['hours', 'salary'])
  })

  it('a LEGACY no-key row is reported BLOCKED (never falsely "shared") and stays withheld', async () => {
    const t = convexTest(schema, modules)
    // simulate pre-R2.2 legacy data: an entity + a no-`key` ref-wide
    // capture row, written directly (bypassing the per-key chokepoint).
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', {
        workspaceId: OWNER, type: 'person', slug: 'zed',
        data: { hours: 5 }, updatedAt: 1,
      })
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/zed',
        summary: 'legacy no-key', tier: 'inline', status: 'auto', createdAt: 1,
      })
    })
    const w = await windowOverHours(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })

    // per-(ref,key) confirm cannot release a no-key row → the report
    // must HONESTLY say blocked, never claim it shared (Codex R2.1 #1).
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER, windowId: w,
    })
    expect(c).toMatchObject({ ok: true, sharedRefs: [] })
    expect(c.blockedRefs).toContain('person/zed')
    expect(await hoursVisible(t, w)).toBe(false) // fail-closed: still withheld
  })

  it('MIXED ref (hours=auto, salary=rejected) ⇒ reported BLOCKED, never falsely "shared" (Codex R2.2 MED #5)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER,
      items: [{ type: 'person', slug: 'anna', data: { hours: 6, salary: 200000 } }],
    })
    // owner deliberately REJECTS salary; hours stays auto (withheld).
    const rows = await capsFor(t, OWNER, 'person/anna')
    const salaryRow = rows.find((c: any) => c.key === 'salary')!._id as Id<'captures'>
    await t.mutation(internal.captures._reject, { workspaceId: OWNER, captureId: salaryRow })

    // ONE window exposes BOTH keys.
    const w = await asOwner(t).mutation(api.windows.createWindow, {
      name: 'mixed', selectorKeys: ['hours', 'salary'],
      aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
    })
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })

    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER, windowId: w,
    })
    // hours WAS confirmed (n>0) — but salary is still rejected/withheld,
    // so the ref is BLOCKED, NOT shared. The OLD logic (n>0 && !no-key)
    // would have lied "shared" here. Report ≡ resolution.
    expect(c.ok).toBe(true)
    expect(c.confirmed).toBeGreaterThan(0)
    expect(c.sharedRefs).not.toContain('person/anna')
    expect(c.blockedRefs).toContain('person/anna')

    // resolution agrees: hours released, salary STILL withheld.
    const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect('hours' in r.view).toBe(true)
      expect('salary' in r.view).toBe(false)
    }
    expect(JSON.stringify(r)).not.toContain('200000')
  })
})
