/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { unreviewedEntityRefs, CAPTURES_RETENTION_MS } from './captures'

// Phase 3 — the Convex adapter over the proven-pure resolveWindow.
// N=2 (real two-tenant) proof that the §6b binding upholds the pure
// core's fail-closed contract end-to-end: viewer strictly from auth,
// one transactional snapshot, revoke deletes ALL rows, the Phase-2
// reviewed-by-default gate is enforced through the join (not just in
// the unit test's hand-fed `unreviewed`).

const modules = import.meta.glob('./**/*.ts')

const OWNER = 'ws_owner'
const VIEWER = 'ws_viewer'
const STRANGER = 'ws_stranger'

type T = ReturnType<typeof convexTest>
const asOwner = (t: T) => t.withIdentity({ subject: OWNER })
const asViewer = (t: T) => t.withIdentity({ subject: VIEWER })
const asStranger = (t: T) => t.withIdentity({ subject: STRANGER })

/** Seed OWNER's desk: two people with scalar fields + one secret. */
async function seedOwnerDesk(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert('entities', {
      workspaceId: OWNER,
      type: 'person',
      slug: 'alice',
      data: { hours: 6, rate: 150, ssn: 'SECRET-PRIVATE' },
      updatedAt: 1,
    })
    await ctx.db.insert('entities', {
      workspaceId: OWNER,
      type: 'person',
      slug: 'bob',
      data: { hours: 4 },
      updatedAt: 1,
    })
    // VIEWER's own desk — must NEVER cross into a resolve of OWNER's window
    await ctx.db.insert('entities', {
      workspaceId: VIEWER,
      type: 'person',
      slug: 'mallory',
      data: { hours: 999 },
      updatedAt: 1,
    })
  })
}

/** OWNER creates a window over `hours`, renamed billed + summed. */
async function ownerCreatesWindow(t: T): Promise<Id<'windows'>> {
  return await asOwner(t).mutation(api.windows.createWindow, {
    name: 'client view',
    selectorKeys: ['hours'], // NOT rate, NOT ssn
    rename: { hours: 'billed' },
    aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
  })
}

describe('windows adapter — default deny', () => {
  it('no grant ⇒ viewer.resolve ⇒ DENY (and no desk leaked)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(r).toEqual({ ok: false, reason: 'DENY' })
    expect(JSON.stringify(r)).not.toContain('SECRET-PRIVATE')
    expect(JSON.stringify(r)).not.toContain('999')
  })

  it('unauthenticated resolve ⇒ throws (no anonymous read path)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await expect(
      t.query(api.windows.resolve, { windowId: w }),
    ).rejects.toThrow(/Not authenticated/)
  })

  it('owner resolving their OWN window ⇒ DENY (windows are cross-desk only)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, {
      windowId: w,
      viewerWorkspaceId: OWNER, // even an explicit self-grant
    }).catch(() => {}) // (self-grant is rejected; resolve still DENYs)
    const r = await asOwner(t).query(api.windows.resolve, { windowId: w })
    expect(r).toEqual({ ok: false, reason: 'DENY' })
  })

  it('a STRANGER who knows the windowId but has no grant ⇒ DENY', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, {
      windowId: w,
      viewerWorkspaceId: VIEWER,
    })
    // grant is for VIEWER; STRANGER guessing the real id still DENYs
    const r = await asStranger(t).query(api.windows.resolve, { windowId: w })
    expect(r).toEqual({ ok: false, reason: 'DENY' })
  })
})

describe('windows adapter — granted reads never over-expose', () => {
  it('granted viewer sees ONLY owner hours, reshaped — never rate/ssn/other desk', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, {
      windowId: w,
      viewerWorkspaceId: VIEWER,
    })
    const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
    // alice.hours=6 + bob.hours=4 → renamed `billed`, summed `team_hours`.
    // (Both atoms write the same renamed key; last wins for `billed`,
    // the aggregate is the real cross-entity proof.)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.view.team_hours).toBe(10)
      expect('billed' in r.view).toBe(true)
      expect('hours' in r.view).toBe(false) // renamed away
      expect('rate' in r.view).toBe(false) // not allowlisted
      expect('ssn' in r.view).toBe(false) // not allowlisted
    }
    const blob = JSON.stringify(r)
    expect(blob).not.toContain('SECRET-PRIVATE')
    expect(blob).not.toContain('150') // rate
    expect(blob).not.toContain('999') // viewer's OWN desk never crosses
  })
})

describe('windows adapter — revoke is immediate and total (§6b.3)', () => {
  it('grant → resolve ok → revoke → resolve DENY', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    expect((await asViewer(t).query(api.windows.resolve, { windowId: w })).ok).toBe(true)
    await asOwner(t).mutation(api.windows.revoke, { windowId: w, viewerWorkspaceId: VIEWER })
    expect(await asViewer(t).query(api.windows.resolve, { windowId: w })).toEqual({
      ok: false,
      reason: 'DENY',
    })
  })

  it('revoke deletes ALL duplicate grant rows (append-only model)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    // simulate an append-only duplicate (two physical grant rows)
    await t.run(async (ctx) => {
      await ctx.db.insert('windowGrants', { windowId: w, viewerWorkspaceId: VIEWER })
      await ctx.db.insert('windowGrants', { windowId: w, viewerWorkspaceId: VIEWER })
    })
    expect((await asViewer(t).query(api.windows.resolve, { windowId: w })).ok).toBe(true)
    const { revoked } = await asOwner(t).mutation(api.windows.revoke, {
      windowId: w,
      viewerWorkspaceId: VIEWER,
    })
    expect(revoked).toBe(2)
    expect((await asViewer(t).query(api.windows.resolve, { windowId: w })).ok).toBe(false)
  })

  it('revoke is total ACROSS batches (Codex: 1001 dup rows → 0 survive)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    // pathological append-only duplicate storm (> the take() batch)
    await t.run(async (ctx) => {
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert('windowGrants', { windowId: w, viewerWorkspaceId: VIEWER })
      }
    })
    expect((await asViewer(t).query(api.windows.resolve, { windowId: w })).ok).toBe(true)
    const { revoked } = await asOwner(t).mutation(api.windows.revoke, {
      windowId: w,
      viewerWorkspaceId: VIEWER,
    })
    expect(revoked).toBe(1001) // paginated to TRUE exhaustion
    const left = await t.run(async (ctx) =>
      (await ctx.db.query('windowGrants').collect()).length,
    )
    expect(left).toBe(0)
    expect((await asViewer(t).query(api.windows.resolve, { windowId: w })).ok).toBe(false)
  })

  it('only the OWNER can grant/revoke their window', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await expect(
      asStranger(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: STRANGER }),
    ).rejects.toThrow(/not your window/)
    await expect(
      asViewer(t).mutation(api.windows.revoke, { windowId: w, viewerWorkspaceId: VIEWER }),
    ).rejects.toThrow(/not your window/)
  })

  it('self-grant is rejected', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await expect(
      asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: OWNER }),
    ).rejects.toThrow(/yourself/)
  })
})

describe('windows adapter — Phase-2 reviewed-by-default gate is ENFORCED via the join', () => {
  it('a non-confirmed entity capture withholds that entity (not its siblings); confirming releases it', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t) // alice{hours:6,…}  bob{hours:4}
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })

    // OWNER has a pending NO-KEY (legacy/whole-entity) capture for
    // person/alice. R2.2 per-(entity,key): a no-key row is the SAFE
    // direction — it over-withholds the WHOLE entity (every scalar key
    // of alice) but NEVER touches a sibling. The coarse pure-core
    // `${owner} ${key}` backstop that used to gate the whole `hours`
    // key across ALL entities was removed (Codex R2.1 HIGH #2: it
    // nullified per-key precision); bob is unaffected and flows.
    const capId = await t.run(async (ctx) =>
      ctx.db.insert('captures', {
        workspaceId: OWNER,
        kind: 'entity',
        ref: 'person/alice',
        summary: 'dohc updated alice.hours',
        tier: 'inline',
        status: 'pending',
        createdAt: 1,
      }),
    )

    // Granted — alice WITHHELD (whole entity), bob flows: team_hours = 4.
    const held = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(held.ok).toBe(true)
    if (held.ok) {
      expect('billed' in held.view).toBe(true) // bob's billed
      expect(held.view.team_hours).toBe(4) // ONLY bob; alice withheld
    }
    const heldBlob = JSON.stringify(held)
    expect(heldBlob).not.toContain('SECRET-PRIVATE') // alice.ssn
    expect(heldBlob).not.toContain('150') // alice.rate

    // Owner confirms alice's row → alice now flows through the SAME
    // window/grant: full cross-entity sum 6 + 4 = 10.
    await t.run(async (ctx) => ctx.db.patch(capId, { status: 'confirmed' }))
    const flowed = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(flowed.ok).toBe(true)
    if (flowed.ok) expect(flowed.view.team_hours).toBe(10)
  })

  it('REGRESSION (Codex CRITICAL): a non-confirmed capture survives retention purge — withheld value does NOT leak after 30d', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })

    // OLD (older than retention) non-confirmed captures touching the
    // shared entities — the OLD behaviour purged auto/rejected → leak.
    const old = Date.now() - CAPTURES_RETENTION_MS - 1000
    await t.run(async (ctx) => {
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/alice',
        summary: 's', tier: 'silent', status: 'auto', createdAt: old,
      })
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/bob',
        summary: 's', tier: 'digest', status: 'rejected', createdAt: old,
      })
    })
    await t.mutation(internal.captures._purgeCaptures, {})

    // Post-purge the withhold rows still exist → still withheld.
    const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect('billed' in r.view).toBe(false)
      expect(r.view.team_hours ?? 0).toBe(0)
    }
    expect(JSON.stringify(r)).not.toContain('SECRET-PRIVATE')
  })

  it('per-entity precision: a pending capture on entity B (different field) does NOT withhold entity A’s selected value', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', {
        workspaceId: OWNER, type: 'person', slug: 'anna',
        data: { hours: 7 }, updatedAt: 1,
      })
      await ctx.db.insert('entities', {
        workspaceId: OWNER, type: 'person', slug: 'ben',
        data: { salary: 200 }, updatedAt: 1, // 'salary' is NOT a selector key
      })
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/ben',
        summary: 's', tier: 'inline', status: 'pending', createdAt: 1,
      })
    })
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    const r = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.view.team_hours).toBe(7) // anna flows; ben's pending didn't nuke it
      expect('billed' in r.view).toBe(true)
    }
    expect(JSON.stringify(r)).not.toContain('200') // ben's salary never crosses
  })
})

describe('unreviewedEntityRefs — COMPLETE or fail-closed (no silent truncation)', () => {
  it('overflow ⇒ {overflow:true} (caller MUST DENY); within cap ⇒ exact entity refs', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('captures', {
          workspaceId: OWNER, kind: 'entity', ref: `person/p${i}`,
          summary: 's', tier: 'inline', status: 'pending', createdAt: i,
        })
      }
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'atom', ref: 'note.md',
        summary: 's', tier: 'silent', status: 'auto', createdAt: 9,
      })
    })
    // (convert Set→sorted array INSIDE t.run — a Set is not a Convex
    // serializable value across the harness boundary)
    const conv = (r: Awaited<ReturnType<typeof unreviewedEntityRefs>>) =>
      r.overflow
        ? { overflow: true }
        : {
            overflow: false,
            wholeRefs: [...r.wholeRefs].sort(),
            refKeys: [...r.refKeys].sort(),
          }
    const over = await t.run(async (ctx) =>
      conv(await unreviewedEntityRefs(ctx as any, OWNER, 2)),
    )
    expect(over).toEqual({ overflow: true }) // 3 pending > cap 2 → fail-closed

    const ok = await t.run(async (ctx) =>
      conv(await unreviewedEntityRefs(ctx as any, OWNER, 50)),
    )
    // no-`key` entity captures ⇒ whole-entity withhold; atom excluded
    expect(ok).toEqual({
      overflow: false,
      wholeRefs: ['person/p0', 'person/p1', 'person/p2'],
      refKeys: [],
    })
  })
})

// P2 design v1 §4 — the PUBLIC consent surface wrappers. They must
// be byte-equivalent to the proven internal/viewer paths and add no
// new authz surface (workspace strictly from requireWorkspace).
describe('P2 consent surface — consentOverview', () => {
  it('standing per-window digest + grantees, reusing the withheldFor helpers; owner-scoped', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.run(async (ctx) =>
      ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/alice', key: 'hours',
        summary: 'dohc set alice.hours', tier: 'digest', status: 'pending', createdAt: 1,
      }),
    )
    const ov = await asOwner(t).query(api.windows.consentOverview, {})
    expect(ov.length).toBe(1)
    expect(ov[0]).toMatchObject({ name: 'client view', grantees: [VIEWER], truncated: false })
    expect(ov[0].entities).toEqual([
      { ref: 'person/alice', type: 'person', slug: 'alice', keys: ['hours'] },
    ])
    expect(ov[0].atoms).toEqual([])
    // a STRANGER sees only their own (empty) overview — never OWNER's
    expect(await asStranger(t).query(api.windows.consentOverview, {})).toEqual([])
    await expect(t.query(api.windows.consentOverview, {})).rejects.toThrow(
      /Not authenticated/,
    )
  })
})

describe('P2 consent surface — public confirmWithheldFor ≡ the agent path', () => {
  it('owner shares without dohc; the granted viewer then receives EXACTLY what the agent path would release', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.run(async (ctx) =>
      ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/alice', key: 'hours',
        summary: 's', tier: 'digest', status: 'pending', createdAt: 1,
      }),
    )
    // before: alice.hours withheld ⇒ only bob flows ⇒ team_hours = 4
    const before = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(before.ok && before.view.team_hours).toBe(4)
    // owner clicks "Share these N" (public, no dohc)
    const res = await asOwner(t).mutation(api.windows.confirmWithheldFor, { windowId: w })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.confirmed).toBeGreaterThan(0)
      expect(res.sharedRefs).toContain('person/alice')
      expect(res.blockedRefs).toEqual([])
    }
    // after: alice flows ⇒ 6 + 4 = 10 — identical to internal _confirmWithheldFor
    const after = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(after.ok && after.view.team_hours).toBe(10)
    // owner-scoped: a STRANGER can't confirm OWNER's window
    expect(
      await asStranger(t).mutation(api.windows.confirmWithheldFor, { windowId: w }),
    ).toEqual({ ok: false, reason: 'not-your-window' })
  })
})

describe('P2 consent surface — previewWindow "Seen as:" (D4)', () => {
  it('owner preview is BYTE-IDENTICAL to a real granted viewer (never shows more); non-owner ⇒ DENY', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await t.run(async (ctx) =>
      ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/alice', key: 'hours',
        summary: 's', tier: 'digest', status: 'pending', createdAt: 1,
      }),
    )
    const viewerView = await asViewer(t).query(api.windows.resolve, { windowId: w })
    const ownerPrev = await asOwner(t).query(api.windows.previewWindow, { windowId: w })
    expect(ownerPrev).toEqual(viewerView) // preview ≡ resolution, exactly
    expect(ownerPrev.ok).toBe(true)
    if (ownerPrev.ok) expect(ownerPrev.view.team_hours).toBe(4) // alice withheld
    const blob = JSON.stringify(ownerPrev)
    expect(blob).not.toContain('SECRET-PRIVATE') // alice.ssn
    expect(blob).not.toContain('150') // alice.rate (not allowlisted)
    // not-the-owner ⇒ DENY (identical to a missing grant)
    expect(
      await asStranger(t).query(api.windows.previewWindow, { windowId: w }),
    ).toEqual({ ok: false, reason: 'DENY' })
    await expect(
      t.query(api.windows.previewWindow, { windowId: w }),
    ).rejects.toThrow(/Not authenticated/)
  })
})

describe('P2 consent surface — windowsSharedWithMe (D4 Frame F, reciprocal)', () => {
  it('lists windows granted TO me with the EXACT view I receive; appears on grant, gone on revoke', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    const w = await ownerCreatesWindow(t)
    expect(await asViewer(t).query(api.windows.windowsSharedWithMe, {})).toEqual([])
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    const mine = await asViewer(t).query(api.windows.windowsSharedWithMe, {})
    expect(mine.length).toBe(1)
    expect(mine[0]).toMatchObject({
      windowId: w, name: 'client view', ownerWorkspaceId: OWNER,
    })
    expect(mine[0].view?.team_hours).toBe(10) // nothing withheld: alice6 + bob4
    // a STRANGER has no windows on them
    expect(await asStranger(t).query(api.windows.windowsSharedWithMe, {})).toEqual([])
    // revoke ⇒ it disappears from the reciprocal list
    await asOwner(t).mutation(api.windows.revoke, { windowId: w, viewerWorkspaceId: VIEWER })
    expect(await asViewer(t).query(api.windows.windowsSharedWithMe, {})).toEqual([])
  })
})

// ── P3 — windows + sharing UX, clickable (design windows-ux v1.3) ──

describe('P3 — whoami (honest v0 identity primitive)', () => {
  it('returns ONLY the caller’s own workspace id; unauth throws', async () => {
    const t = convexTest(schema, modules)
    expect(await asOwner(t).query(api.windows.whoami, {})).toBe(OWNER)
    expect(await asViewer(t).query(api.windows.whoami, {})).toBe(VIEWER)
    await expect(t.query(api.windows.whoami, {})).rejects.toThrow(
      /Not authenticated/,
    )
  })
})

describe('P3 — availableKeys (key-picker source)', () => {
  it('owner-scoped distinct scalar keys (entity + inline), INCLUDES unconfirmed (no reviewed-by-default exclusion); no cross-desk leak', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', {
        workspaceId: OWNER, type: 'person', slug: 'alice',
        data: { hours: 6, rate: 150, tags: ['x'] /* non-scalar → ignored */ },
        updatedAt: 1,
      })
      await ctx.db.insert('atoms', {
        workspaceId: OWNER, path: 'work/today.md',
        body: 'log {billable: 4} and {mood: "ok"}', updatedAt: 1, source: 'agent',
      })
      // an UNCONFIRMED capture on alice.hours must NOT hide 'hours'
      // from the picker — the owner designs over their OWN desk; the
      // reviewed-by-default gate fires later, at cross-desk resolve.
      await ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/alice', key: 'hours',
        summary: 's', tier: 'digest', status: 'pending', createdAt: 1,
      })
      // a DIFFERENT desk — must never leak into OWNER's picker
      await ctx.db.insert('entities', {
        workspaceId: VIEWER, type: 'person', slug: 'm',
        data: { secret: 'X' }, updatedAt: 1,
      })
    })
    const r = await asOwner(t).query(api.windows.availableKeys, {})
    expect(r).toEqual({
      keys: ['billable', 'hours', 'mood', 'rate'], // sorted distinct; 'tags' non-scalar out; 'secret' other-desk out; 'hours' present despite pending
      truncated: false,
    })
    expect(await asStranger(t).query(api.windows.availableKeys, {})).toEqual({
      keys: [], truncated: false,
    })
    await expect(t.query(api.windows.availableKeys, {})).rejects.toThrow(
      /Not authenticated/,
    )
  })

  it('availableKeys ⊇ every SOURCE key a granted window actually resolves (§7.5 equivalence gate)', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t) // alice{hours,rate,ssn} bob{hours} (+viewer’s own)
    const w = await ownerCreatesWindow(t)
    await asOwner(t).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: VIEWER })
    await asOwner(t).mutation(api.windows.confirmWithheldFor, { windowId: w })
    const res = await asViewer(t).query(api.windows.resolve, { windowId: w })
    expect(res.ok).toBe(true) // 'hours' actually crosses
    const ak = await asOwner(t).query(api.windows.availableKeys, {})
    // the picker offers every source key on the desk — a strict
    // superset of anything any window could carry.
    for (const k of ['hours', 'rate', 'ssn']) expect(ak.keys).toContain(k)
  })
})

describe('P3 — confirm is per-(ref,key) GLOBAL: a brand-new window over an already-confirmed key crosses IMMEDIATELY (v1-HIGH)', () => {
  it('confirm K via W1 → create NEW W2 over K → grant W2 → viewer sees K with NO re-confirm', async () => {
    const t = convexTest(schema, modules)
    await seedOwnerDesk(t)
    await t.run(async (ctx) =>
      ctx.db.insert('captures', {
        workspaceId: OWNER, kind: 'entity', ref: 'person/alice', key: 'hours',
        summary: 's', tier: 'digest', status: 'pending', createdAt: 1,
      }),
    )
    const w1 = await ownerCreatesWindow(t) // ['hours'] → billed, sum team_hours
    await asOwner(t).mutation(api.windows.grant, { windowId: w1, viewerWorkspaceId: VIEWER })
    // before confirm: alice.hours withheld ⇒ only bob ⇒ team_hours = 4
    const before = await asViewer(t).query(api.windows.resolve, { windowId: w1 })
    expect(before.ok && before.view.team_hours).toBe(4)
    // owner confirms via W1 — confirm is per-(ref,key) and GLOBAL
    await asOwner(t).mutation(api.windows.confirmWithheldFor, { windowId: w1 })

    // a BRAND-NEW window W2 over the SAME key, granted, with NO
    // confirmWithheldFor(W2) — it must cross immediately.
    const w2 = await asOwner(t).mutation(api.windows.createWindow, {
      name: 'second view',
      selectorKeys: ['hours'],
      aggregate: { key: 'hours', op: 'sum', as: 'total' },
    })
    await asOwner(t).mutation(api.windows.grant, { windowId: w2, viewerWorkspaceId: VIEWER })
    const w2view = await asViewer(t).query(api.windows.resolve, { windowId: w2 })
    expect(w2view.ok).toBe(true)
    if (w2view.ok) expect(w2view.view.total).toBe(10) // alice6+bob4, NO re-confirm on W2
    // …and it lights up on the viewer's reciprocal list reactively
    const mine = await asViewer(t).query(api.windows.windowsSharedWithMe, {})
    expect(mine.map((m) => m.name).sort()).toEqual([
      'client view',
      'second view',
    ])
  })
})
