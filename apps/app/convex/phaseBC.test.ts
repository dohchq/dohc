/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

// Two distinct WorkOS subjects representing two different users / their
// personal workspaces. workspaceId === subject for personal workspaces
// (org-plan §5).
const A = 'ws_phaseBC_A'
const B = 'ws_phaseBC_B'

describe('Phase B (org-plan §5) — activeWorkspaceId threading', () => {
  it('omitting activeWorkspaceId defaults to the caller\'s personal workspace', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    // A creates a file in their personal workspace.
    await asA.mutation(api.atoms.upsert, {
      path: 'note.md',
      body: 'hello',
    })
    // A reads it back — no activeWorkspaceId arg ⇒ defaults to A's
    // personal workspace.
    const rows = await asA.query(api.atoms.list, {})
    expect(rows.find((r) => r.path === 'note.md')).toBeDefined()
  })

  it('a non-member supplying another user\'s personal workspaceId is rejected', async () => {
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    // B tries to query A's personal workspace by passing A's id as
    // activeWorkspaceId. A is NOT B and there is no membership row, so
    // requireWorkspace must throw.
    await expect(
      asB.query(api.atoms.list, { activeWorkspaceId: A }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('an org member can use the org workspaceId as activeWorkspaceId', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    const { orgId, inviteCode } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme',
    })
    await asB.mutation(api.orgs.joinOrg, { inviteCode })

    // A writes into the org workspace as Owner.
    await asA.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'shared/onboarding.md',
      body: 'welcome',
    })
    // B reads it as a Member — same org, same workspace.
    const rows = await asB.query(api.atoms.list, { activeWorkspaceId: orgId })
    expect(rows.find((r) => r.path === 'shared/onboarding.md')).toBeDefined()
  })

  it('cross-tenant isolation: A\'s personal atoms invisible to B even as org members', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    const { inviteCode } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme',
    })
    await asB.mutation(api.orgs.joinOrg, { inviteCode })

    // A writes into A's PERSONAL workspace (no activeWorkspaceId).
    await asA.mutation(api.atoms.upsert, {
      path: 'private.md',
      body: 'secret',
    })
    // B reads B's personal — doesn't see it (different tenant).
    const bPersonal = await asB.query(api.atoms.list, {})
    expect(bPersonal.find((r) => r.path === 'private.md')).toBeUndefined()
    // B asking for A's personal — rejected by requireWorkspace.
    await expect(
      asB.query(api.atoms.list, { activeWorkspaceId: A }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('after leaveOrg, the ex-member loses access to the org workspace', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    const { orgId, inviteCode } = await asA.mutation(api.orgs.createOrg, {
      name: 'Acme',
    })
    await asB.mutation(api.orgs.joinOrg, { inviteCode })
    // B can read while a member.
    expect(
      await asB.query(api.atoms.list, { activeWorkspaceId: orgId }),
    ).toBeDefined()
    // B leaves the org (A is still the sole Owner, so B leaving is fine).
    await asB.mutation(api.orgs.leaveOrg, { orgId })
    // B asking for the org now — rejected. Either signal is fine: a
    // soft-removed row throws "Membership not active (status=removed)";
    // a hard-removed row throws "Not a member of workspace …". Both
    // are fail-closed rejections.
    await expect(
      asB.query(api.atoms.list, { activeWorkspaceId: orgId }),
    ).rejects.toThrow(/Not a member of workspace|Membership not active/)
  })
})

describe('Phase C (org-plan §13) — debounced _map.md regen', () => {
  it('schedules a coalesced map regen on upsert', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })

    await asA.mutation(api.atoms.upsert, { path: 'a.md', body: 'A' })

    // A schedule row exists, scheduledFor ~2s in the future.
    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .collect()
    })
    expect(rows.length).toBe(1)
    expect(rows[0].scheduledFor).toBeGreaterThan(Date.now())
    expect(rows[0].scheduledFor).toBeLessThanOrEqual(Date.now() + 2_500)
  })

  it('rapid edits coalesce to ONE pending schedule (no extra row, scheduledFor stays put)', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })

    await asA.mutation(api.atoms.upsert, { path: 'a.md', body: 'A' })
    const first = await t.run(async (ctx) => {
      const r = await ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .unique()
      return r?.scheduledFor
    })
    // 9 more rapid edits inside the debounce window.
    for (let i = 0; i < 9; i++) {
      await asA.mutation(api.atoms.upsert, {
        path: `a.md`,
        body: `A v${i}`,
      })
    }
    const after = await t.run(async (ctx) => {
      return await ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .collect()
    })
    // Exactly one row — coalesced.
    expect(after.length).toBe(1)
    // scheduledFor unchanged (the second through tenth call no-op'd).
    expect(after[0].scheduledFor).toBe(first)
  })

  it('_gardenAndMapDebounced deletes the schedule row so the next edit re-arms', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })

    await asA.mutation(api.atoms.upsert, { path: 'a.md', body: 'A' })
    // Manually fire the debounced job (simulating scheduler firing).
    await t.mutation(internal.loop._gardenAndMapDebounced, { workspaceId: A })
    const cleared = await t.run(async (ctx) =>
      ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .collect(),
    )
    expect(cleared.length).toBe(0)

    // Next edit re-arms.
    await asA.mutation(api.atoms.upsert, { path: 'b.md', body: 'B' })
    const rearmed = await t.run(async (ctx) =>
      ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .collect(),
    )
    expect(rearmed.length).toBe(1)
  })

  it('schedules are per-workspace (concurrent edits in two workspaces never share)', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    await asA.mutation(api.atoms.upsert, { path: 'a.md', body: 'A' })
    await asB.mutation(api.atoms.upsert, { path: 'b.md', body: 'B' })

    const all = await t.run(async (ctx) =>
      ctx.db.query('mapRegenSchedule').collect(),
    )
    expect(all.length).toBe(2)
    const byWs = Object.fromEntries(all.map((r) => [r.workspaceId, r]))
    expect(byWs[A]).toBeDefined()
    expect(byWs[B]).toBeDefined()
  })

  it('atoms.move and atoms.remove both arm the debounced regen', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    await asA.mutation(api.atoms.upsert, { path: 'a.md', body: 'A' })
    await t.mutation(internal.loop._gardenAndMapDebounced, { workspaceId: A })

    await asA.mutation(api.atoms.move, { fromPath: 'a.md', toPath: 'b.md' })
    let row = await t.run(async (ctx) =>
      ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .unique(),
    )
    expect(row).not.toBeNull()
    await t.mutation(internal.loop._gardenAndMapDebounced, { workspaceId: A })

    await asA.mutation(api.atoms.remove, { path: 'b.md' })
    row = await t.run(async (ctx) =>
      ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', A))
        .unique(),
    )
    expect(row).not.toBeNull()
  })
})

describe('Phase B.4 (org-plan §6 / §11-step-4) — onboarding workspace-kind branch', () => {
  it('personal workspace looks for me.md; org workspace looks for company.md', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const { orgId } = await asA.mutation(api.orgs.createOrg, { name: 'Acme' })

    // Personal: writing company.md (the WRONG file for personal) ⇒
    // hasMe stays false because progressOf looks for me.md here.
    await asA.mutation(api.atoms.upsert, {
      path: 'company.md',
      body: 'wrong file',
    })
    let personal = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, A)
    })
    expect(personal.hasMe).toBe(false)

    // Personal: writing me.md ⇒ hasMe flips true.
    await asA.mutation(api.atoms.upsert, { path: 'me.md', body: 'about A' })
    personal = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, A)
    })
    expect(personal.hasMe).toBe(true)

    // Org: writing me.md (the WRONG file for org) ⇒ hasMe false there
    // because progressOf looks for company.md.
    await asA.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'me.md',
      body: 'wrong file',
    })
    let org = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, orgId)
    })
    expect(org.hasMe).toBe(false)

    // Org: writing company.md ⇒ org.hasMe flips true.
    await asA.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'company.md',
      body: 'about Acme',
    })
    org = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, orgId)
    })
    expect(org.hasMe).toBe(true)
  })
})

describe('Phase F (org-plan §14) — cross-tenant isolation × every Phase B surface', () => {
  it('atoms.upsert: a non-member cannot write into another workspace', async () => {
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    await expect(
      asB.mutation(api.atoms.upsert, {
        activeWorkspaceId: A,
        path: 'spoof.md',
        body: 'should never land',
      }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('folders.list: a non-member cannot enumerate another workspace\'s folders', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    await asA.mutation(api.folders.create, { path: 'private-team' })
    // B in their own workspace doesn't see it.
    expect(
      (await asB.query(api.folders.list, {})).find(
        (f) => f.path === 'private-team',
      ),
    ).toBeUndefined()
    // B trying to point at A's workspace ⇒ rejected.
    await expect(
      asB.query(api.folders.list, { activeWorkspaceId: A }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('search.run: workspace-scoped via the index AND gated by requireWorkspace', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const asB = t.withIdentity({ subject: B })
    await asA.mutation(api.atoms.upsert, {
      path: 'note.md',
      body: 'uniquesecrettoken in A',
    })
    // B searches their OWN workspace — no hit.
    const bResults = await asB.query(api.search.run, { query: 'uniquesecrettoken' })
    expect(bResults.find((r) => r.path === 'note.md')).toBeUndefined()
    // B spoofs A's workspaceId via activeWorkspaceId ⇒ rejected.
    await expect(
      asB.query(api.search.run, {
        query: 'uniquesecrettoken',
        activeWorkspaceId: A,
      }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('search.ensureIndexed: mutation is gated; spoofing rejected', async () => {
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    await expect(
      asB.mutation(api.search.ensureIndexed, { activeWorkspaceId: A }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('entities.list and entities.get reject cross-tenant spoofing', async () => {
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    await expect(
      asB.query(api.entities.list, { activeWorkspaceId: A }),
    ).rejects.toThrow(/Not a member of workspace/)
    await expect(
      asB.query(api.entities.get, {
        type: 'person',
        slug: 'foo',
        activeWorkspaceId: A,
      }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('atomShares.listSharedWithMe / listMyShares reject cross-tenant spoofing', async () => {
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    await expect(
      asB.query(api.atomShares.listSharedWithMe, { activeWorkspaceId: A }),
    ).rejects.toThrow(/Not a member of workspace/)
    await expect(
      asB.query(api.atomShares.listMyShares, { activeWorkspaceId: A }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('agent.listMessages rejects cross-tenant spoofing on the thread surface', async () => {
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    await expect(
      asB.query(api.agent.listMessages, {
        threadId: 'fake-thread-id',
        paginationOpts: { numItems: 10, cursor: null },
        activeWorkspaceId: A,
      }),
    ).rejects.toThrow(/Not a member of workspace/)
  })

  it('every public Convex fn that accepts activeWorkspaceId routes through requireWorkspace', async () => {
    // Static check: read the .ts files and ensure every public fn that
    // takes `activeWorkspaceId: v.optional(v.string())` also calls
    // requireWorkspace(ctx, activeWorkspaceId) in its handler body.
    // Catches the regression "added the arg but forgot to thread it."
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname)
    const files: string[] = []
    function walk(d: string) {
      for (const e of readdirSync(d)) {
        if (e === '_generated' || e.startsWith('.') || e === 'node_modules')
          continue
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.ts$/.test(e) && !e.endsWith('.test.ts')) files.push(p)
      }
    }
    walk(root)
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // Only PUBLIC fns (no `internalMutation|internalQuery|internalAction`).
      const re =
        /export\s+const\s+(\w+)\s*=\s*(mutation|query|action)\s*\(\{([\s\S]{0,800}?)handler:\s*async\s*\([^)]*\)\s*[^{]*\{([\s\S]{0,4000}?)^\s\s\},?$/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const [, name, kind, head, body] = m
        if (!/activeWorkspaceId\s*:\s*v\.optional/.test(head)) continue
        // The handler body must call requireWorkspace(ctx, activeWorkspaceId)
        // — anything else means the arg is dead and a caller spoofing
        // an org id would silently still read personal data.
        if (
          !/requireWorkspace\s*\(\s*ctx\s*,\s*(args\.)?activeWorkspaceId\s*\)/.test(
            body,
          ) &&
          // Action-context surfaces that explicitly refuse a non-undefined
          // activeWorkspaceId (queries.run, agent.sendMessage,
          // agent.startOnboarding) are also valid — the arg is GATED by
          // the throw and then ctx-default is used.
          !/activeWorkspaceId\s*!==\s*undefined[\s\S]{0,200}?throw/.test(body)
        ) {
          offenders.push(`${f.split('/convex/')[1]}: ${name} (${kind})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
