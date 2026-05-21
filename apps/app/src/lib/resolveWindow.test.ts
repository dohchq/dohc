import { describe, it, expect } from 'vitest'
import {
  resolveWindow,
  unreviewedKey,
  type Stores,
  type StoredAtom,
  type WindowDef,
  type Grant,
} from './resolveWindow'

// T5 — the fail-closed property tests. tenancy-authz-v0.md §6 makes
// these a hard pre-Phase-3 blocker. They prove the ONLY cross-person
// read path is default-deny and cannot leak another desk or an
// unlisted key.

const alice = 'ws_alice'
const bob = 'ws_bob'
const carol = 'ws_carol'

const atoms: StoredAtom[] = [
  { ownerWorkspaceId: alice, key: 'hours', value: 6 },
  { ownerWorkspaceId: alice, key: 'rate', value: 150 },
  { ownerWorkspaceId: alice, key: 'ssn', value: 'SECRET-PRIVATE' },
  { ownerWorkspaceId: bob, key: 'hours', value: 99 },
  { ownerWorkspaceId: carol, key: 'hours', value: 42 },
]

const managerWindow: WindowDef = {
  id: 'w_mgr',
  ownerWorkspaceId: alice,
  selector: { keys: ['hours'] }, // NOT rate, NOT ssn
  shape: { aggregate: { key: 'hours', op: 'sum', as: 'team_hours' } },
}
const clientWindow: WindowDef = {
  id: 'w_client',
  ownerWorkspaceId: alice,
  selector: { keys: ['hours'] },
  shape: { rename: { hours: 'billed' } },
}
const windows = [managerWindow, clientWindow]

function stores(grants: Grant[]): Stores {
  return { windows, grants, atoms }
}

describe('reviewed-by-default gate is STRUCTURAL (Phase-2 keystone)', () => {
  it('an unreviewed (pending) shared value is withheld even WITH a grant', () => {
    const g: Grant[] = [{ windowId: 'w_client', viewerWorkspaceId: bob }]
    // alice's `hours` is captured-but-not-confirmed → must NOT cross
    // a desk, even though the window allowlists it and a grant exists.
    const r = resolveWindow(
      { windowId: 'w_client', viewerWorkspaceId: bob },
      { windows, grants: g, atoms, unreviewed: [unreviewedKey(alice, 'hours')] },
    )
    expect(r).toEqual({ ok: true, view: {} }) // granted, but the value is withheld
    // once confirmed (not in `unreviewed`) it flows normally:
    const r2 = resolveWindow(
      { windowId: 'w_client', viewerWorkspaceId: bob },
      { windows, grants: g, atoms, unreviewed: [] },
    )
    expect(r2).toEqual({ ok: true, view: { billed: 6 } })
  })
})

describe('T5 — default deny', () => {
  it('no grant ⇒ DENY', () => {
    expect(resolveWindow({ windowId: 'w_mgr', viewerWorkspaceId: bob }, stores([]))).toEqual({
      ok: false,
      reason: 'DENY',
    })
  })
  it('grant for a DIFFERENT viewer ⇒ DENY', () => {
    const r = resolveWindow(
      { windowId: 'w_mgr', viewerWorkspaceId: bob },
      stores([{ windowId: 'w_mgr', viewerWorkspaceId: carol }]),
    )
    expect(r.ok).toBe(false)
  })
  it('grant for a DIFFERENT window ⇒ DENY', () => {
    const r = resolveWindow(
      { windowId: 'w_mgr', viewerWorkspaceId: bob },
      stores([{ windowId: 'w_client', viewerWorkspaceId: bob }]),
    )
    expect(r.ok).toBe(false)
  })
  it('dangling grant to a missing window ⇒ DENY', () => {
    const r = resolveWindow(
      { windowId: 'w_ghost', viewerWorkspaceId: bob },
      stores([{ windowId: 'w_ghost', viewerWorkspaceId: bob }]),
    )
    expect(r.ok).toBe(false)
  })
  it('owner resolving their own window ⇒ DENY (windows are cross-desk only)', () => {
    const r = resolveWindow(
      { windowId: 'w_mgr', viewerWorkspaceId: alice },
      stores([{ windowId: 'w_mgr', viewerWorkspaceId: alice }]),
    )
    expect(r.ok).toBe(false)
  })
  it('revocation is immediate (grant removed ⇒ next call DENY)', () => {
    const live = [{ windowId: 'w_mgr', viewerWorkspaceId: bob }]
    expect(resolveWindow({ windowId: 'w_mgr', viewerWorkspaceId: bob }, stores(live)).ok).toBe(true)
    live.pop() // revoke
    expect(resolveWindow({ windowId: 'w_mgr', viewerWorkspaceId: bob }, stores(live)).ok).toBe(false)
  })
})

describe('T5 — allowed reads never over-expose', () => {
  it('manager window: only alice hours, aggregated; never rate/ssn, never bob/carol', () => {
    const r = resolveWindow(
      { windowId: 'w_mgr', viewerWorkspaceId: bob },
      stores([{ windowId: 'w_mgr', viewerWorkspaceId: bob }]),
    )
    expect(r).toEqual({ ok: true, view: { hours: 6, team_hours: 6 } })
    const blob = JSON.stringify(r)
    expect(blob).not.toContain('SECRET-PRIVATE') // ssn never exposed
    expect(blob).not.toContain('150') // rate not allowlisted
    expect(blob).not.toContain('99') // bob's desk never crosses
    expect(blob).not.toContain('42') // carol's desk never crosses
  })
  it('client window: alice hours renamed to billed, nothing else', () => {
    const r = resolveWindow(
      { windowId: 'w_client', viewerWorkspaceId: carol },
      stores([{ windowId: 'w_client', viewerWorkspaceId: carol }]),
    )
    expect(r).toEqual({ ok: true, view: { billed: 6 } })
  })
})

// STRICT provenance check (Finding 1 fix — no `typeof number` escape):
// every output value must trace to an OWNER atom with an allowlisted
// key, accounting for the two legitimate derived outputs.
function assertViewProvenance(
  view: Record<string, string | number | boolean>,
  win: WindowDef,
) {
  const allow = new Set(win.selector.keys)
  const agg = win.shape?.aggregate
  const rename = win.shape?.rename ?? {}
  for (const [k, v] of Object.entries(view)) {
    if (agg && k === agg.as) {
      const owned = atoms.filter(
        (a) =>
          a.ownerWorkspaceId === win.ownerWorkspaceId &&
          allow.has(a.key) &&
          a.key === agg.key,
      )
      const expected =
        agg.op === 'count'
          ? owned.length
          : owned.reduce((s, a) => s + (typeof a.value === 'number' ? a.value : 0), 0)
      expect(v).toBe(expected) // catches a cross-desk sum (147 ≠ 6)
      continue
    }
    const origKey =
      Object.entries(rename).find(([, to]) => to === k)?.[0] ?? k
    const traceable = atoms.some(
      (a) =>
        a.ownerWorkspaceId === win.ownerWorkspaceId &&
        allow.has(a.key) &&
        a.key === origKey &&
        a.value === v, // strict — no typeof escape
    )
    expect(traceable).toBe(true) // catches hours:99 (no alice atom == 99)
  }
}

describe('T5 — meta: the suite actually catches a leak (Finding 1)', () => {
  it('a deliberately leaky resolver FAILS the provenance invariant', () => {
    // bob's hours (99) + cross-desk sum (147) leaked through alice's
    // manager window. The OLD invariant passed this; the new one must
    // throw.
    const leaked = { hours: 99, team_hours: 147 }
    expect(() => assertViewProvenance(leaked, managerWindow)).toThrow()
  })
})

describe('T5 — hardening edges (subagent findings 2–4)', () => {
  it('__proto__ / forbidden atom key ⇒ DENY (not silent drop)', () => {
    const evilAtoms: StoredAtom[] = [
      { ownerWorkspaceId: alice, key: '__proto__', value: 'pwn' },
    ]
    const win: WindowDef = {
      id: 'w_evil',
      ownerWorkspaceId: alice,
      selector: { keys: ['__proto__'] },
    }
    const r = resolveWindow(
      { windowId: 'w_evil', viewerWorkspaceId: bob },
      { windows: [win], grants: [{ windowId: 'w_evil', viewerWorkspaceId: bob }], atoms: evilAtoms },
    )
    expect(r.ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it('array-shaped `shape` ⇒ DENY (typeof [] is object — must fail closed)', () => {
    const win = {
      id: 'w_arr',
      ownerWorkspaceId: alice,
      selector: { keys: ['hours'] },
      shape: [] as unknown,
    } as WindowDef
    const r = resolveWindow(
      { windowId: 'w_arr', viewerWorkspaceId: bob },
      { windows: [win], grants: [{ windowId: 'w_arr', viewerWorkspaceId: bob }], atoms },
    )
    expect(r.ok).toBe(false)
  })
  it("empty / non-string viewer ⇒ DENY (unauthenticated principal)", () => {
    expect(
      resolveWindow(
        { windowId: 'w_mgr', viewerWorkspaceId: '' },
        stores([{ windowId: 'w_mgr', viewerWorkspaceId: '' }]),
      ).ok,
    ).toBe(false)
  })
  it('duplicate window id ⇒ DENY (array order must not decide security)', () => {
    const safe: WindowDef = { id: 'dup', ownerWorkspaceId: alice, selector: { keys: ['hours'] } }
    const evil: WindowDef = { id: 'dup', ownerWorkspaceId: carol, selector: { keys: ['hours'] } }
    const r = resolveWindow(
      { windowId: 'dup', viewerWorkspaceId: bob },
      { windows: [safe, evil], grants: [{ windowId: 'dup', viewerWorkspaceId: bob }], atoms },
    )
    expect(r.ok).toBe(false)
  })
  it('revoke must delete ALL matching grant rows (append-only model)', () => {
    const dup = [
      { windowId: 'w_mgr', viewerWorkspaceId: bob },
      { windowId: 'w_mgr', viewerWorkspaceId: bob },
    ]
    expect(resolveWindow({ windowId: 'w_mgr', viewerWorkspaceId: bob }, stores(dup)).ok).toBe(true)
    // revoke-by-(window,viewer) deletes the SET, not one row
    const revoked = dup.filter(
      (g) => !(g.windowId === 'w_mgr' && g.viewerWorkspaceId === bob),
    )
    expect(resolveWindow({ windowId: 'w_mgr', viewerWorkspaceId: bob }, stores(revoked)).ok).toBe(false)
  })
})

describe('T5 — fuzz: no random principal ever leaks a foreign desk', () => {
  it('2000 random combos uphold the STRICT invariant', () => {
    const ids = [alice, bob, carol, 'ws_d', 'ws_e', 'ws_x', '', 'WS_ALICE']
    const winIds = ['w_mgr', 'w_client', 'w_ghost', 'dup']
    let allows = 0
    for (let n = 0; n < 2000; n++) {
      const viewer = ids[Math.floor(Math.random() * ids.length)]
      const windowId = winIds[Math.floor(Math.random() * winIds.length)]
      const roll = Math.random()
      const g: Grant[] =
        roll < 0.5
          ? // exact-match grant for THIS request → exercises real allows
            [{ windowId, viewerWorkspaceId: viewer }]
          : roll < 0.8
            ? // random (usually mismatched) grant → exercises denies
              [
                {
                  windowId: winIds[Math.floor(Math.random() * winIds.length)],
                  viewerWorkspaceId: ids[Math.floor(Math.random() * ids.length)],
                },
              ]
            : [] // no grant at all
      const r = resolveWindow({ windowId, viewerWorkspaceId: viewer }, stores(g))
      if (r.ok) {
        allows++
        expect(
          g.some((x) => x.windowId === windowId && x.viewerWorkspaceId === viewer),
        ).toBe(true)
        const win = windows.find((w) => w.id === windowId)!
        expect(win.ownerWorkspaceId).not.toBe(viewer)
        assertViewProvenance(r.view, win) // STRICT (Finding 1 fixed)
        expect(JSON.stringify(r.view)).not.toContain('SECRET-PRIVATE')
      }
    }
    expect(allows).toBeGreaterThan(50) // fuzz is not statistically empty
  })
})
