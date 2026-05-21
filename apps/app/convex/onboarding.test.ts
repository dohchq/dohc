/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'

// SAFE backend verification (the path chosen after the dev-auth hole):
// convex-test runs the real Convex functions against an in-memory DB
// with NO auth bypass and NO live deployment. Re-verifies the Phase 1
// review hardening: the EG6 state machine + the server-enforced
// "never end empty" invariant.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_test'

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', {
      workspaceId: W,
      path,
      body,
      updatedAt: Date.now(),
      source: 'agent',
    })
  })
}

describe('EG6 — explicit onboarding state machine', () => {
  it('NEW → IN_PROGRESS on begin, and RESUMES (never restarts) on reload', async () => {
    const t = convexTest(schema, modules)
    expect(await t.query(internal.onboarding._state, { workspaceId: W })).toBe(
      'NEW',
    )
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    // a reload mid-onboarding must see IN_PROGRESS, not NEW (restart)
    // and not DONE (skip) — the exact EG6 bug, now fixed.
    expect(await t.query(internal.onboarding._state, { workspaceId: W })).toBe(
      'IN_PROGRESS',
    )
    await t.mutation(internal.onboarding._begin, { workspaceId: W }) // idempotent
    expect(await t.query(internal.onboarding._state, { workspaceId: W })).toBe(
      'IN_PROGRESS',
    )
  })

  it('.first() resilience: a duplicate row degrades, does not brick', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('onboarding', { workspaceId: W })
      await ctx.db.insert('onboarding', { workspaceId: W }) // stray dup
    })
    // .unique() would THROW here; .first() must not.
    await expect(
      t.query(internal.onboarding._state, { workspaceId: W }),
    ).resolves.toBe('IN_PROGRESS')
  })
})

describe('"never end empty" is a SERVER invariant (was prompt-hope)', () => {
  it('_complete THROWS on an empty vault', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
  })

  it('_complete THROWS with me.md but no query dashboard', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'me.md', '# Me\nfreelance designer')
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
  })

  it('_complete THROWS with a query dashboard but no me.md', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'dashboard.md', '# Dash\n```query\nentities.list("x")\n```')
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
  })

  it('_complete SUCCEEDS only with me.md AND a populated dashboard → DONE', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(t, 'me.md', '# Me\nfreelance designer {rate: 150}')
    await seedAtom(
      t,
      'dashboard.md',
      '# Cockpit\n{hours: 13}\n```query\nentities.list("booking")\n```',
    )
    await t.mutation(internal.onboarding._complete, { workspaceId: W })
    expect(await t.query(internal.onboarding._state, { workspaceId: W })).toBe(
      'DONE',
    )
  })
})

// ── P1 design v5.1 — the gate, progress, escape, and the lease ──────

const asW = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: W })

describe('P1 — deriveState precedence (DONE>DEFERRED>IN_PROGRESS>NEW)', () => {
  it('DONE wins even if deferredAt also set; deferredAt alone ⇒ DEFERRED', async () => {
    const t = convexTest(schema, modules)
    expect(
      await t.query(internal.onboarding._state, { workspaceId: W }),
    ).toBe('NEW')
    await t.run((ctx) =>
      ctx.db.insert('onboarding', { workspaceId: W, deferredAt: 1 }),
    )
    expect(
      await t.query(internal.onboarding._state, { workspaceId: W }),
    ).toBe('DEFERRED')
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query('onboarding')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', W))
        .first()
      await ctx.db.patch(r!._id, { completedAt: 2 }) // both set
    })
    expect(
      await t.query(internal.onboarding._state, { workspaceId: W }),
    ).toBe('DONE') // precedence: DONE > DEFERRED
  })
})

describe('P1 — public state/progress/defer (owner-scoped)', () => {
  it('state requires auth and reflects the row; unauth throws', async () => {
    const t = convexTest(schema, modules)
    await expect(t.query(api.onboarding.state, {})).rejects.toThrow()
    expect(await asW(t).query(api.onboarding.state, {})).toBe('NEW')
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    expect(await asW(t).query(api.onboarding.state, {})).toBe('IN_PROGRESS')
  })

  it('progress reuses the _complete helper (cannot desync from the invariant)', async () => {
    const t = convexTest(schema, modules)
    expect(await asW(t).query(api.onboarding.progress, {})).toEqual({
      entityCount: 0,
      hasMe: false,
      hasDashboardWithQuery: false,
      mePath: null,
      dashboardPath: null,
    })
    await seedAtom(t, 'me.md', '# Me')
    await seedAtom(t, 'dashboard.md', '```query\nentities.list("x")\n```')
    await t.run((ctx) =>
      ctx.db.insert('entities', {
        workspaceId: W,
        type: 'booking',
        slug: 'b1',
        data: {},
        updatedAt: 1,
      }),
    )
    expect(await asW(t).query(api.onboarding.progress, {})).toEqual({
      entityCount: 1,
      hasMe: true,
      hasDashboardWithQuery: true,
      mePath: 'me.md',
      dashboardPath: 'dashboard.md',
    })
  })

  it('defer ⇒ DEFERRED, never fakes DONE, leaves the never-empty invariant intact, idempotent', async () => {
    const t = convexTest(schema, modules)
    await asW(t).mutation(api.onboarding.defer, {})
    expect(await asW(t).query(api.onboarding.state, {})).toBe('DEFERRED')
    // deferral did NOT complete: _complete still refuses the empty vault
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
    await asW(t).mutation(api.onboarding.defer, {}) // idempotent
    expect(await asW(t).query(api.onboarding.state, {})).toBe('DEFERRED')
    // a deferred user who genuinely finishes still reaches DONE (DONE>DEFERRED)
    await seedAtom(t, 'me.md', '# Me')
    await seedAtom(t, 'd.md', '```query\nx\n```')
    await t.mutation(internal.onboarding._complete, { workspaceId: W })
    expect(await asW(t).query(api.onboarding.state, {})).toBe('DONE')
  })
})

describe('P1 — start LEASE: single-doc CAS + heartbeat + staleness recovery', () => {
  it('exactly one winner; a fresh (heartbeating) lease blocks; a HARD-killed (stale) lease is reclaimable', async () => {
    const t = convexTest(schema, modules)
    const c1 = await t.mutation(internal.onboarding.claimKickoff, {
      workspaceId: W,
    })
    expect(c1.won).toBe(true)
    expect(typeof c1.owner).toBe('string')
    // immediate 2nd claim ⇒ fresh lease ⇒ loses (no double-run)
    const c2 = await t.mutation(internal.onboarding.claimKickoff, {
      workspaceId: W,
    })
    expect(c2).toEqual({ won: false, owner: null })
    // heartbeat by the owner keeps it fresh ⇒ still blocked
    await t.mutation(internal.onboarding.heartbeat, {
      workspaceId: W,
      owner: c1.owner!,
    })
    expect(
      (await t.mutation(internal.onboarding.claimKickoff, { workspaceId: W }))
        .won,
    ).toBe(false)
    // a WRONG owner heartbeat is a no-op (a zombie can't pin the lease)
    await t.mutation(internal.onboarding.heartbeat, {
      workspaceId: W,
      owner: 'not-the-owner',
    })
    // simulate a HARD process kill: heartbeat stopped ⇒ lease ages out
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query('onboarding')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', W))
        .first()
      await ctx.db.patch(r!._id, { kickoffAt: Date.now() - 95_000 }) // > 90s
    })
    const c3 = await t.mutation(internal.onboarding.claimKickoff, {
      workspaceId: W,
    })
    expect(c3.won).toBe(true) // recovered WITHOUT any 'failed' status
    expect(c3.owner).not.toBe(c1.owner) // a fresh nonce ⇒ old owner's
    // heartbeat now no-ops (superseded), so the zombie can't revive it
    await t.mutation(internal.onboarding.heartbeat, {
      workspaceId: W,
      owner: c1.owner!,
    })
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query('onboarding')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', W))
        .first()
      // still owned by c3 (c1's heartbeat was ignored)
      expect(r!.kickoffOwner).toBe(c3.owner)
    })
  })
})
