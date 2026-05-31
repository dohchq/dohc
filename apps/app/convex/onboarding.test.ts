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

  it('_complete THROWS with .context/me.md but no source-backed cockpit', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '.context/me.md', '# Me\nfreelance designer')
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
  })

  it('_complete THROWS with a cockpit but no .context/me.md', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(
      t,
      'projects/acme.md',
      '# Acme\nProject status is {status: active}.',
    )
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<section>Active projects: {= count(projects.* status = active)}</section>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild the cockpit.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd one real project detail.',
    )
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
  })

  it('_complete THROWS with identity + cockpit but no setup run', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(t, '.context/me.md', '# Me\nfreelance designer {rate: 150}')
    await seedAtom(
      t,
      'projects/acme.md',
      '# Acme\nProject status is {status: active}.',
    )
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<section>Active projects: {= count(projects.* status = active)}</section>',
    )

    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/setup run/i)
  })

  it('_complete SUCCEEDS only with identity, sources, home.html, and setup run → DONE', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(t, '.context/me.md', '# Me\nfreelance designer {rate: 150}')
    await seedAtom(
      t,
      'projects/acme.md',
      '# Acme\nProject status is {status: active}. Budget is {budget: 8000}.',
    )
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<section><h1>Home</h1><p>Active projects: {= count(projects.* status = active)}</p></section>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild the project cockpit.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd the next project checkpoint.',
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
      hasCockpitView: false,
      hasSetupRun: false,
      sourceCount: 0,
      mePath: null,
      dashboardPath: null,
      cockpitPath: null,
      runPath: null,
    })
    await seedAtom(t, '.context/me.md', '# Me')
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>Active: {= count(projects.* status = active)}</p>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild a cockpit.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd detail.',
    )
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
      hasCockpitView: true,
      hasSetupRun: true,
      sourceCount: 1,
      mePath: '.context/me.md',
      dashboardPath: 'home.html',
      cockpitPath: 'home.html',
      runPath: '.runs/setup.md',
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
    await seedAtom(t, '.context/me.md', '# Me')
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>Active: {= count(projects.* status = active)}</p>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild a cockpit.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd detail.',
    )
    await t.mutation(internal.onboarding._complete, { workspaceId: W })
    expect(await asW(t).query(api.onboarding.state, {})).toBe('DONE')
  })

  it('completeIfReady flips an already-populated workspace from IN_PROGRESS to DONE', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(t, '.context/me.md', '# Me\nfreelance designer {rate: 150}')
    await seedAtom(
      t,
      'projects/acme.md',
      '# Acme\nProject status is {status: active}.',
    )
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>Active: {= count(projects.* status = active)}</p>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild a cockpit.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd detail.',
    )

    await asW(t).mutation(api.onboarding.completeIfReady, {})

    expect(await asW(t).query(api.onboarding.state, {})).toBe('DONE')
  })

  it('completeIfReady keeps the never-empty invariant for the client handoff', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })

    await expect(
      asW(t).mutation(api.onboarding.completeIfReady, {}),
    ).rejects.toThrow(/not populated/)
    expect(await asW(t).query(api.onboarding.state, {})).toBe('IN_PROGRESS')
  })
})

describe('progressOf — new fields (sourceCount, hasCockpitView, hasSetupRun, paths)', () => {
  it('sourceCount counts real source atoms and excludes .context/, runs/, identity, and placeholders', async () => {
    const t = convexTest(schema, modules)
    // These should NOT count:
    await seedAtom(t, '.context/me.md', '# Me\n{rate: 150}') // identity file
    await seedAtom(t, '.context/intent.md', '# Intent\n{goal: build}') // .context/ prefix
    await seedAtom(t, '.runs/setup.md', '# Setup Run\n\n## Objective\nTest.\n\n## Sources\n- x\n\n## View\n- home.html\n\n## Next Action\nDo it.')
    // These SHOULD count:
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(t, 'logs/entry.md', '# Log\n{billable: 4.5}')

    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.sourceCount).toBe(2)
  })

  it('hasCockpitView is false when home.html lacks sources frontmatter', async () => {
    const t = convexTest(schema, modules)
    // home.html without sources: metadata is NOT a source-backed cockpit
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\n---\n<h1>Home</h1><p>Active: {= count(projects.* status = active)}</p>',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.hasCockpitView).toBe(false)
    expect(progress.cockpitPath).toBeNull()
  })

  it('hasCockpitView is false when home.html has sources but no live view reference', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<h1>Home</h1><p>Static content only.</p>',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.hasCockpitView).toBe(false)
  })

  it('hasCockpitView is true for dashboard.html (alternate cockpit path)', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '.context/me.md', '# Me\n{rate: 150}')
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(
      t,
      'dashboard.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>Active: {= count(projects.* status = active)}</p>',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.hasCockpitView).toBe(true)
    expect(progress.cockpitPath).toBe('dashboard.html')
  })

  it('cockpitPath prefers home.html over dashboard.html', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(
      t,
      'dashboard.html',
      '---\ntype: html\nsources:\n  - x.md\n---\n<p>{= count(x.* v = 1)}</p>',
    )
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - x.md\n---\n<p>{= count(x.* v = 1)}</p>',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.cockpitPath).toBe('home.html')
  })

  it('hasSetupRun is false when .runs/setup.md is missing the required headings', async () => {
    const t = convexTest(schema, modules)
    // Missing ## View and ## Next Action
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nTest.\n\n## Sources\n- x.md\n\nSome content.',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.hasSetupRun).toBe(false)
    expect(progress.runPath).toBeNull()
  })

  it('hasSetupRun is false when .runs/setup.md contains a placeholder seed marker', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\ndohc:placeholder-seed\n\n## Objective\nTest.\n\n## Sources\n- x\n\n## View\n- home.html\n\n## Next Action\nDo it.',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.hasSetupRun).toBe(false)
  })

  it('runPath is set when a complete .runs/setup.md exists', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild the cockpit.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd one real project detail.',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.runPath).toBe('.runs/setup.md')
    expect(progress.hasSetupRun).toBe(true)
  })

  it('dashboardPath falls back to a legacy markdown dashboard when no cockpit exists', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(
      t,
      'dashboard.md',
      '# Dashboard\n{hours: 13}\n```query\nentities.list("booking")\n```',
    )
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.dashboardPath).toBe('dashboard.md')
    // Legacy markdown dashboard does NOT set hasCockpitView
    expect(progress.hasCockpitView).toBe(false)
    expect(progress.cockpitPath).toBeNull()
  })

  it('sourceCount is 0 when the only atoms are .context/ files', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, '.context/me.md', '# Me\n{rate: 150}')
    await seedAtom(t, '.context/intent.md', '# Intent\n{goal: x}')
    const progress = await asW(t).query(api.onboarding.progress, {})
    expect(progress.sourceCount).toBe(0)
  })
})

describe('"never end empty" — additional floor cases', () => {
  it('_complete THROWS with source atoms + cockpit but an incomplete setup run (missing Next Action)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(t, '.context/me.md', '# Me\n{rate: 150}')
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>{= count(projects.* status = active)}</p>',
    )
    // Incomplete: missing ## Next Action
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n',
    )
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/setup run/i)
  })

  it('_complete THROWS when home.html has sources but no live formula', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(t, '.context/me.md', '# Me\n{rate: 150}')
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>No formula here, just static text.</p>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd detail.',
    )
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
  })

  it('_complete is idempotent for an already-DONE workspace', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(t, '.context/me.md', '# Me\n{rate: 150}')
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>{= count(projects.* status = active)}</p>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd detail.',
    )
    await t.mutation(internal.onboarding._complete, { workspaceId: W })
    // Second call should not throw
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).resolves.not.toThrow()
    expect(await t.query(internal.onboarding._state, { workspaceId: W })).toBe('DONE')
  })

  it('_complete THROWS when identity atom is a placeholder seed', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.onboarding._begin, { workspaceId: W })
    await seedAtom(
      t,
      '.context/me.md',
      '# Me\ndohc:placeholder-seed\n{rate: 150}',
    )
    await seedAtom(t, 'projects/acme.md', '# Acme\n{status: active}')
    await seedAtom(
      t,
      'home.html',
      '---\ntype: html\nsources:\n  - projects/acme.md\n---\n<p>{= count(projects.* status = active)}</p>',
    )
    await seedAtom(
      t,
      '.runs/setup.md',
      '# Setup Run\n\n## Objective\nBuild.\n\n## Sources\n- projects/acme.md\n\n## View\n- home.html\n\n## Next Action\nAdd detail.',
    )
    await expect(
      t.mutation(internal.onboarding._complete, { workspaceId: W }),
    ).rejects.toThrow(/not populated/)
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
