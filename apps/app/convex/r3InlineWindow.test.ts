/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

// R3 — H4: inline `{key:value}` in a note → manager's granted
// cross-desk window/rollup, REVIEWED-BY-DEFAULT (design v4). Proven
// both directions (no-leak AND released-after-confirm) + the v4
// folds: structural capture at the upsert chokepoint, ordered-diff
// re-withhold, parse-fail sentinel lifecycle, move/delete clear,
// prose-only, own-desk≡cross-desk parity, atom-flood ≠ entity DoS.

const modules = import.meta.glob('./**/*.ts')
const OWNER = 'ws_owner'
const VIEWER = 'ws_viewer'
type T = ReturnType<typeof convexTest>
const asOwner = (t: T) => t.withIdentity({ subject: OWNER })
const asViewer = (t: T) => t.withIdentity({ subject: VIEWER })

async function hoursWindow(t: T): Promise<Id<'windows'>> {
  const w = await asOwner(t).mutation(api.windows.createWindow, {
    name: 'team',
    selectorKeys: ['hours'],
    aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
  })
  await asOwner(t).mutation(api.windows.grant, {
    windowId: w,
    viewerWorkspaceId: VIEWER,
  })
  return w
}
const teamHours = async (t: T, w: Id<'windows'>) => {
  const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
  return r.ok ? ((r.view.team_hours as number | undefined) ?? 0) : -1
}
const hoursVisible = async (t: T, w: Id<'windows'>) => {
  const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
  return r.ok === true && 'hours' in r.view
}
const atomCaps = (t: T, path: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('captures').collect()).filter(
      (c: any) =>
        c.workspaceId === OWNER && c.kind === 'atom' && c.ref === path,
    ),
  )

describe('R3 — inline atom → cross-desk window, reviewed-by-default', () => {
  it('IC note {hours:6} is WITHHELD from a granted window until the owner confirms; then it flows', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'log.md',
      body: 'Worked {hours: 6} today.',
    })
    const w = await hoursWindow(t)

    // structural capture at the upsert chokepoint ⇒ withheld
    expect(await hoursVisible(t, w)).toBe(false)
    expect(await teamHours(t, w)).toBe(0)
    const caps = await atomCaps(t, 'log.md')
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatchObject({ key: 'hours', status: 'auto' })

    // owner confirms at the edge ⇒ the SAME window now exposes it
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(c.ok).toBe(true)
    expect(c.sharedRefs).toEqual([]) // legacy arrays stay ENTITY-ONLY
    expect(c.blockedRefs).toEqual([])
    expect(c.sharedAtoms).toEqual([{ kind: 'atom', ref: 'log.md', key: 'hours' }])
    expect(await hoursVisible(t, w)).toBe(true)
    expect(await teamHours(t, w)).toBe(6)
  })

  it('cross-desk live-total (window spec) ALSO gets the confirmed inline value (the rollup headline)', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'a.md',
      body: '{hours: 4}',
    })
    const w = await hoursWindow(t)
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER,
      identifier: 'team_hours',
      spec: { kind: 'window', windowId: w },
    })
    // withheld ⇒ no operands ⇒ ___ (null), never a misleading 0
    expect(
      await asViewer(t).query(api.liveTotals.resolve, {
        identifier: 'team_hours',
      }),
    ).toEqual({ value: null })

    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(
      await asViewer(t).query(api.liveTotals.resolve, {
        identifier: 'team_hours',
      }),
    ).toEqual({ value: 4 })
  })

  it('reject ⇒ stays withheld and is HONESTLY reported blocked (never shared)', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'log.md',
      body: '{hours: 6}',
    })
    const w = await hoursWindow(t)
    const id = (await atomCaps(t, 'log.md'))[0]._id as Id<'captures'>
    await t.mutation(internal.captures._reject, {
      workspaceId: OWNER,
      captureId: id,
    })
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(c.sharedAtoms).toEqual([]) // rejected ⇒ NOT shared
    expect(c.blockedAtoms).toEqual([
      { kind: 'atom', ref: 'log.md', key: 'hours' },
    ])
    expect(await hoursVisible(t, w)).toBe(false) // resolution agrees
  })

  it('edit value after confirm ⇒ RE-withheld; reorder duplicate keys ⇒ RE-withheld (ordered diff)', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'log.md',
      body: '{hours: 6}',
    })
    const w = await hoursWindow(t)
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await teamHours(t, w)).toBe(6)

    // edit the value ⇒ structural re-withhold (coalesced auto)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'log.md',
      body: '{hours: 9}',
    })
    expect(await hoursVisible(t, w)).toBe(false)

    // reorder duplicate keys: a NON-aggregate window projects
    // last-occurrence-wins, so a reorder changes the shared view and
    // MUST re-withhold even though a multiset would look unchanged.
    const sw = await asOwner(t).mutation(api.windows.createWindow, {
      name: 's',
      selectorKeys: ['status'],
    })
    await asOwner(t).mutation(api.windows.grant, {
      windowId: sw,
      viewerWorkspaceId: VIEWER,
    })
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 's.md',
      body: 'a {status: "old"} then {status: "new"}',
    })
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: sw,
    })
    let rv = await asViewer(t).query(api.windows.resolve, { windowId: sw })
    expect(rv.ok && rv.view.status).toBe('new') // last wins
    // swap the two occurrences — multiset identical, ORDER flipped
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 's.md',
      body: 'a {status: "new"} then {status: "old"}',
    })
    rv = await asViewer(t).query(api.windows.resolve, { windowId: sw })
    expect(rv.ok && 'status' in rv.view).toBe(false) // re-withheld
  })

  it('rename (atoms.move) and trash-restore ⇒ value is FRESH-withheld at the new/restored path (not a bypass)', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'log.md',
      body: '{hours: 6}',
    })
    const w = await hoursWindow(t)
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await teamHours(t, w)).toBe(6)

    // rename ⇒ old path cleared, new path fresh-withheld
    await asOwner(t).mutation(api.atoms.move, {
      fromPath: 'log.md',
      toPath: 'log2.md',
    })
    expect(await atomCaps(t, 'log.md')).toHaveLength(0)
    expect(await hoursVisible(t, w)).toBe(false) // moved value re-withheld
    const moved = await atomCaps(t, 'log2.md')
    expect(moved).toHaveLength(1)
    expect(moved[0].status).toBe('auto')

    // confirm at new path ⇒ flows again
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await teamHours(t, w)).toBe(6)

    // delete ⇒ captures cleared; restore ⇒ fresh-withheld
    await asOwner(t).mutation(api.atoms.remove, { path: 'log2.md' })
    expect(await atomCaps(t, 'log2.md')).toHaveLength(0)
    const trashId = await t.run(async (ctx) => {
      // the REMOVE snapshot has ref===path; the MOVE snapshot has
      // ref `log.md (moved→log2.md)` — pick the remove one explicitly.
      const row = (await ctx.db.query('trash').collect()).find(
        (r: any) =>
          r.workspaceId === OWNER && r.kind === 'atom' && r.ref === 'log2.md',
      )
      return row?._id
    })
    await t.mutation(internal.trash._restore, {
      workspaceId: OWNER,
      trashId: trashId as Id<'trash'>,
    })
    const rc = await atomCaps(t, 'log2.md')
    expect(rc).toHaveLength(1)
    expect(rc[0].status).toBe('auto') // restored ⇒ withheld, not auto-shared
    expect(await hoursVisible(t, w)).toBe(false)
  })

  it('PROSE-ONLY: {hours:6} inside a fenced code block is NEVER captured or projected', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'doc.md',
      body: 'Example:\n\n```\n{hours: 999}\n```\n\nNo real atom here.',
    })
    const w = await hoursWindow(t)
    expect(await atomCaps(t, 'doc.md')).toHaveLength(0) // not captured
    // even confirming the window can't surface a non-atom
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await hoursVisible(t, w)).toBe(false)
    const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(JSON.stringify(r)).not.toContain('999')
  })

  it('parse-fail SENTINEL: an over-cap body withholds the WHOLE note; a clean re-save supersedes it and per-key confirm releases (NOT a dark-hole)', async () => {
    const t = convexTest(schema, modules)
    const huge = 'x'.repeat(300 * 1024) // > ATOM_BODY_MAX_BYTES (256KB)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'big.md',
      body: `${huge} {hours: 6}`,
    })
    const w = await hoursWindow(t)
    const caps = await atomCaps(t, 'big.md')
    expect(caps).toHaveLength(1)
    expect(caps[0].summary).toBe('__parse_fail__') // the sentinel
    expect(caps[0].key).toBeUndefined() // the ONE sanctioned no-key row
    expect(await hoursVisible(t, w)).toBe(false) // whole note withheld

    // R3 (Codex R3-fold): while ANY owner note is unparseable the
    // gather GLOBALLY drops atom sources, so the consent path mirrors
    // that — it REFUSES to enumerate/confirm (never falsely "shared";
    // report ≡ resolution). The owner must fix the note first.
    const c1 = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(c1).toMatchObject({ ok: false, reason: 'too-many-to-enumerate' })
    expect(await hoursVisible(t, w)).toBe(false) // resolution withholds

    // clean re-save ⇒ sentinel superseded, per-(path,key) recorded
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'big.md',
      body: '{hours: 6}',
    })
    const caps2 = await atomCaps(t, 'big.md')
    expect(caps2).toHaveLength(1)
    expect(caps2[0]).toMatchObject({ key: 'hours', status: 'auto' })
    expect(caps2.some((c: any) => c.summary === '__parse_fail__')).toBe(false)

    // …and now a normal confirm RELEASES it — proves not a dark-hole
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await teamHours(t, w)).toBe(6)
  })

  it('report ≡ resolution: an unparseable note alongside a CLEAN withheld atom ⇒ confirm refuses (never falsely shares the clean one) — Codex R3-fold NEW MED', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'good.md',
      body: '{hours: 6}',
    })
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'bad.md',
      body: `${'x'.repeat(300 * 1024)} {hours: 9}`, // over-cap ⇒ sentinel
    })
    const w = await hoursWindow(t)
    // gather GLOBALLY drops atom sources (bad.md unparseable) ⇒ even
    // good.md/hours is withheld in resolution.
    expect(await hoursVisible(t, w)).toBe(false)
    // the consent path MUST mirror that — it refuses to enumerate /
    // confirm, so good.md/hours is NEVER reported as newly shared
    // while resolution is withholding it (report ≡ resolution).
    const wf: any = await asOwner(t).query(api.windows.withheldFor, {
      windowId: w,
    })
    expect(wf.truncated).toBe(true)
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(c).toMatchObject({ ok: false, reason: 'too-many-to-enumerate' })
    expect(await hoursVisible(t, w)).toBe(false)
    // fix the bad note ⇒ consent works again, clean atom releasable
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'bad.md',
      body: '{hours: 9}',
    })
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await teamHours(t, w)).toBe(15) // 6 + 9, both released
  })

  it('emitted-atom cap is SYMMETRIC (condition c): a high-volume desk drops all atoms in resolution AND refuses consent (no false shared) — dual-review residual', async () => {
    const t = convexTest(schema, modules)
    // ~6000 value-atoms across 3 notes (each < ATOM_MAX_PER_NOTE,
    // bodies tiny), NONE matching the window's `hours` selector,
    // plus one CLEAN withheld `hours` atom. The gather counts EVERY
    // value-atom ⇒ trips SCAN_CAP ⇒ drops ALL atom sources. Consent
    // must count the SAME way (post-fix) ⇒ refuse, never report the
    // clean `hours` atom as shareable while resolution withholds it.
    const bulk = Array.from({ length: 1999 }, (_, i) => `{k${i}: 1}`).join(' ')
    for (const p of ['b1.md', 'b2.md', 'b3.md']) {
      await asOwner(t).mutation(api.atoms.upsert, { path: p, body: bulk })
    }
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'good.md',
      body: '{hours: 6}',
    })
    const w = await hoursWindow(t)
    expect(await hoursVisible(t, w)).toBe(false) // gather drops ALL atoms
    const wf: any = await asOwner(t).query(api.windows.withheldFor, {
      windowId: w,
    })
    expect(wf.truncated).toBe(true) // consent mirrors the global drop
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(c).toMatchObject({ ok: false, reason: 'too-many-to-enumerate' })
    expect(await hoursVisible(t, w)).toBe(false) // still withheld
  })

  it('TOTAL-bytes cap (R3 §5 third cap, Codex holistic MED): a huge desk drops all atoms + refuses consent — bounded, fail-closed', async () => {
    const t = convexTest(schema, modules)
    // 40 notes × ~230KB = ~9MB > ATOM_TOTAL_BYTES_MAX (8MB), each
    // note < ATOM_BODY_MAX_BYTES (256KB) and count < SCAN_CAP — so
    // ONLY the new total-bytes cap can catch this. + one clean atom.
    const filler = 'x '.repeat(115 * 1024) // ~230KB, no atoms
    for (let i = 0; i < 40; i++) {
      await asOwner(t).mutation(api.atoms.upsert, {
        path: `big${i}.md`,
        body: filler,
      })
    }
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'good.md',
      body: '{hours: 6}',
    })
    const w = await hoursWindow(t)
    expect(await hoursVisible(t, w)).toBe(false) // total-bytes ⇒ drop all
    const wf: any = await asOwner(t).query(api.windows.withheldFor, {
      windowId: w,
    })
    expect(wf.truncated).toBe(true) // consent mirrors the bounded drop
    const c = await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(c).toMatchObject({ ok: false, reason: 'too-many-to-enumerate' })
  })

  it('NUL note path rejected at the MOVE write surface too (R3 §8, Codex holistic LOW)', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'ok.md',
      body: '{hours: 6}',
    })
    await expect(
      asOwner(t).mutation(api.atoms.move, {
        fromPath: 'ok.md',
        toPath: 'a\u0000b.md',
      }),
    ).rejects.toThrow(/U\+0000|invalid atom path/)
    // the original is untouched (move rejected atomically)
    expect(await atomCaps(t, 'ok.md')).toHaveLength(1)
  })

  it('own-desk ≡ cross-desk parity: same note, the rollup number matches after confirm', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'a.md',
      body: '{hours: 6} and later {hours: 4}',
    })
    // OWN-DESK total (ungated — owner reading own data)
    await t.mutation(internal.liveTotals._define, {
      workspaceId: OWNER,
      identifier: 'mine',
      spec: { kind: 'ownDesk', op: 'sum', key: 'hours' },
    })
    expect(
      await asOwner(t).query(api.liveTotals.resolve, { identifier: 'mine' }),
    ).toEqual({ value: 10 }) // 6 + 4, every occurrence

    // CROSS-DESK via a granted window, after confirm — must MATCH
    const w = await hoursWindow(t)
    await t.mutation(internal.liveTotals._define, {
      workspaceId: VIEWER,
      identifier: 'team_hours',
      spec: { kind: 'window', windowId: w },
    })
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(
      await asViewer(t).query(api.liveTotals.resolve, {
        identifier: 'team_hours',
      }),
    ).toEqual({ value: 10 })
  })

  it('atom-capture flood DROPS atom sources but the ENTITY window still resolves (atom flood ≠ entity DoS)', async () => {
    const t = convexTest(schema, modules)
    // a confirmed entity value in a window
    await t.mutation(internal.entities._upsertMany, {
      workspaceId: OWNER,
      items: [{ type: 'person', slug: 'anna', data: { hours: 7 } }],
    })
    const w = await hoursWindow(t)
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await teamHours(t, w)).toBe(7)

    // overflow the ATOM partition with > UNREVIEWED_CAP non-confirmed
    // atom rows. The entity partition is scanned INDEPENDENTLY, so the
    // entity window must STILL resolve (never DENY) — atoms just drop.
    await t.run(async (ctx) => {
      for (let i = 0; i < 5001; i++) {
        await ctx.db.insert('captures', {
          workspaceId: OWNER,
          kind: 'atom',
          ref: `n${i}.md`,
          key: 'hours',
          summary: 's',
          tier: 'silent',
          status: 'auto',
          createdAt: 1,
        })
      }
    })
    expect(await teamHours(t, w)).toBe(7) // entity view byte-identical
  })

  it('seed WIPE clears prior-seed ghost atom captures (Codex v3 MED); seeded inline values are strict-by-construction confirmed', async () => {
    const t = convexTest(schema, modules)
    const atomCapsAll = () =>
      t.run((ctx) =>
        ctx.db
          .query('captures')
          .collect()
          .then((cs: any[]) =>
            cs.filter((c) => c.kind === 'atom' && c.workspaceId === OWNER),
          ),
      )

    await t.mutation(internal.seed.loadCapacityDemo, { workspaceId: OWNER })
    // every atom capture the seed DID create is explicitly CONFIRMED
    // (strict-by-construction — the curated demo is pre-shared, not an
    // unenforced exemption). (The capacity demo's atoms are HTML block
    // views, so this set may be empty — the invariant still holds.)
    const seeded = await atomCapsAll()
    expect(seeded.every((c: any) => c.status === 'confirmed')).toBe(true)

    // Simulate a prior-seed GHOST: a stray non-confirmed atom capture
    // for a note the next seed will wipe. R3-3 §1 requires the wipe to
    // clearAtomCaptures per wiped atom (Codex v3 MED — entity wipe
    // already did; atom wipe did NOT before this fold).
    await t.run((ctx) =>
      ctx.db.insert('captures', {
        workspaceId: OWNER,
        kind: 'atom',
        ref: 'ghost.md',
        key: 'hours',
        summary: 'stale ghost',
        tier: 'silent',
        status: 'auto',
        createdAt: 1,
      }),
    )
    await t.run((ctx) =>
      ctx.db.insert('atoms', {
        workspaceId: OWNER,
        path: 'ghost.md',
        body: '{hours: 1}',
        updatedAt: 1,
        source: 'user',
      }),
    )

    await t.mutation(internal.seed.loadCapacityDemo, { workspaceId: OWNER })
    const after = await atomCapsAll()
    // the ghost is GONE (wipe cleared it) — no pile-up, no stale
    // withhold surviving a re-seed.
    expect(after.some((c: any) => c.ref === 'ghost.md')).toBe(false)
    expect(after.every((c: any) => c.status === 'confirmed')).toBe(true)
  })

  it('ATOM-ONLY window: withheldFor reports items:[] but atoms:[…] (the data the agent review/confirm tools MUST surface — Codex R3-build HIGH)', async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.atoms.upsert, {
      path: 'log.md',
      body: '{hours: 6}',
    })
    const w = await hoursWindow(t)
    const r: any = await asOwner(t).query(api.windows.withheldFor, {
      windowId: w,
    })
    expect(r.ok).toBe(true)
    // entity arrays are EMPTY (no entities) — a tool that only checks
    // `items.length === 0` would WRONGLY say "nothing withheld" and
    // then confirm would still release the atom. The fix bases the
    // decision on items AND atoms.
    expect(r.items).toEqual([])
    expect(r.atoms).toEqual([{ kind: 'atom', ref: 'log.md', key: 'hours' }])
  })

  it('NUL note path is REJECTED at the write surface and never crosses (R3 §8)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      asOwner(t).mutation(api.atoms.upsert, {
        path: 'a\u0000b.md',
        body: '{hours: 6}',
      }),
    ).rejects.toThrow(/U\+0000|invalid atom path/)
    // a pre-existing NUL-path note (inserted out-of-band) fails CLOSED
    // at the gather — its value never crosses a granted window.
    await t.run((ctx) =>
      ctx.db.insert('atoms', {
        workspaceId: OWNER,
        path: 'x\u0000y.md',
        body: '{hours: 9}',
        updatedAt: 1,
        source: 'user',
      }),
    )
    const w = await hoursWindow(t)
    await t.mutation(internal.windows._confirmWithheldFor, {
      workspaceId: OWNER,
      windowId: w,
    })
    expect(await hoursVisible(t, w)).toBe(false)
    const rr = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(JSON.stringify(rr)).not.toContain('9')
  })
})
