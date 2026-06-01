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
    // New org docs are private by default, so B can use the workspace
    // but does not see A's doc until A makes it company-visible.
    const privateRows = await asB.query(api.atoms.list, { activeWorkspaceId: orgId })
    expect(privateRows.find((r) => r.path === 'shared/onboarding.md')).toBeUndefined()

    const row = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'shared/onboarding.md'),
        )
        .unique(),
    )
    await asA.mutation(api.atomAccess.setAtomAccess, {
      atomId: row!._id,
      activeWorkspaceId: orgId,
      mode: null,
    })
    // B reads it as a Member once the doc is company-visible.
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

describe('Phase B.4 (org-plan §6 / §11-step-4) — onboarding workspace-kind branch', () => {
  it('personal workspace looks for .context/me.md; org workspace looks for .context/company.md', async () => {
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    const { orgId } = await asA.mutation(api.orgs.createOrg, { name: 'Acme' })

    // Personal: root me.md is ordinary now, and the org identity file
    // in .context is still the wrong identity file for personal.
    await asA.mutation(api.atoms.upsert, { path: 'me.md', body: 'old root profile' })
    await asA.mutation(api.atoms.upsert, {
      path: '.context/company.md',
      body: 'wrong file',
    })
    let personal = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, A)
    })
    expect(personal.hasMe).toBe(false)

    // Personal: writing .context/me.md ⇒ hasMe flips true.
    await asA.mutation(api.atoms.upsert, { path: '.context/me.md', body: 'about A' })
    personal = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, A)
    })
    expect(personal.hasMe).toBe(true)
    expect(personal.mePath).toBe('.context/me.md')

    // Org: root company.md is ordinary now, and .context/me.md is the
    // wrong identity file for org workspaces.
    await asA.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'company.md',
      body: 'old root company',
    })
    await asA.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: '.context/me.md',
      body: 'wrong file',
    })
    let org = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, orgId)
    })
    expect(org.hasMe).toBe(false)

    // Org: writing .context/company.md ⇒ org.hasMe flips true.
    await asA.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: '.context/company.md',
      body: 'about Acme',
    })
    org = await t.run(async (ctx) => {
      const { progressOf } = await import('./onboarding')
      return await progressOf(ctx, orgId)
    })
    expect(org.hasMe).toBe(true)
    expect(org.mePath).toBe('.context/company.md')
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

  it('agent action surfaces (Phase B.3 action-bridge) accept activeWorkspaceId without throwing', async () => {
    // Regression for the bug where sendMessage/startOnboarding threw
    // on non-undefined activeWorkspaceId (the pre-B.3 limitation).
    // Now they route through `_resolveWorkspaceForCaller` so org
    // workspaces work end-to-end. We can't easily test the streaming
    // path with convex-test, but we can prove the validator accepts
    // the arg (no throw on parse) by calling `_resolveWorkspaceForCaller`
    // directly, which is the bridge.
    const t = convexTest(schema, modules)
    const asA = t.withIdentity({ subject: A })
    // personal — undefined ⇒ returns the subject (personal id).
    const wsPersonal = await t.run(async (ctx) => {
      // Lifted: action proxies this via runQuery; we hit the internal
      // query the same way.
      const m = await import('./_generated/api')
      return await asA.query(m.internal.agent._resolveWorkspaceForCaller, {
        activeWorkspaceId: undefined,
      })
    })
    expect(wsPersonal).toBe(A)
    // org — supply orgId after joining; returns the org's id.
    const { orgId } = await asA.mutation(api.orgs.createOrg, {
      name: 'Bridge Co',
    })
    const wsOrg = await asA.query(internal.agent._resolveWorkspaceForCaller, {
      activeWorkspaceId: orgId,
    })
    expect(wsOrg).toBe(orgId)
  })

  it('agent.listMessages rejects cross-tenant spoofing on the WORKSPACE gate', async () => {
    // First gate: requireWorkspace rejects B passing A's personal id.
    // This proves the workspace check fires before the thread check.
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

  it('agent.listMessages also rejects on the THREAD gate (workspace ok, thread foreign)', async () => {
    // Second gate: even when the workspace gate passes, listMessages
    // must reject a threadId that doesn't belong to the caller's
    // workspace. Insert the threadRefs row directly to bypass
    // `dohcAgent.createThread` (convex-test cannot register the agent
    // component) — we only need the gate (`_assertOwnThread`) under
    // test, not the agent SDK plumbing.
    const t = convexTest(schema, modules)
    const asB = t.withIdentity({ subject: B })
    // A's thread row in A's personal workspace.
    await t.run(async (ctx) => {
      await ctx.db.insert('threadRefs', {
        workspaceId: A,
        threadId: 'thread_for_A',
      })
    })
    // B queries listMessages for B's OWN workspace, but supplies A's
    // threadId. Workspace gate passes (B is in B's personal). Thread
    // gate rejects: A's threadId isn't in B's threadRefs.
    await expect(
      asB.query(api.agent.listMessages, {
        threadId: 'thread_for_A',
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/thread does not belong to this workspace/)
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
          // Action surfaces can't ctx.db, so they route through
          // `_resolveWorkspaceForCaller` (an internalQuery that DOES
          // have db — see agent.ts). The runQuery proxy carries the
          // caller's auth context, so the gate is equivalent.
          !/runQuery\([\s\S]{0,80}_resolveWorkspaceForCaller[\s\S]{0,200}activeWorkspaceId/.test(
            body,
          ) &&
          // Shared-atom surfaces route through resolveShareAccess,
          // which is the shared read/write door and calls
          // requireWorkspace(ctx, activeWorkspaceId) before checking the
          // share grant. Treat that helper as equivalent to an inline
          // requireWorkspace call for this static audit.
          !/resolveShareAccess\s*\(\s*ctx\s*,[\s\S]{0,160}activeWorkspaceId/.test(
            body,
          ) &&
          // Action surfaces that explicitly refuse a non-undefined
          // activeWorkspaceId (queries.run still uses this shape — no
          // bridge yet) are also valid — the arg is GATED by the
          // throw and then ctx-default is used.
          !/activeWorkspaceId\s*!==\s*undefined[\s\S]{0,200}?throw/.test(body)
        ) {
          offenders.push(`${f.split('/convex/')[1]}: ${name} (${kind})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
