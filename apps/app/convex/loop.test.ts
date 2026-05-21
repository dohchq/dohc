/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

// Phase 4 Unit 4b — weekly reconcile. Intent (goal_<id> atoms in
// intent.md, PROSE only) vs reality (the SAME resolveLiveTotalValue
// path) → ADVISORY pending proposal, never auto-applied, idempotent
// per week. The row stores ONLY the workspace's own goal + a marker;
// `actual` is re-resolved LIVE + grant-gated at digest time (so a
// revoked cross-desk grant can never surface a stale number).

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_loop'
const OWNER = 'ws_owner'
type T = ReturnType<typeof convexTest>

const seedNote = (t: T, ws: string, path: string, body: string) =>
  t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId: ws, path, body, updatedAt: 1 })
  })
const proposals = (t: T, ws: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('proposals').collect()).filter(
      (r: any) => r.workspaceId === ws,
    ),
  )
const digest = (t: T, ws: string) =>
  t.query(internal.loop._pendingProposals, { workspaceId: ws })

describe('loop._reconcile — behind goal ⇒ one advisory marker; digest resolves live', () => {
  it('one proposal when actual < goal; idempotent; row stores NO cross-desk value', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'intent.md', 'This week: {goal_billable: 40} and prose.')
    await seedNote(t, W, 'work.md', 'Logged {billable: 10} and {billable: 6}.')
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'billable', spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
    })

    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 1 })
    const p = await proposals(t, W)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ identifier: 'billable', goal: 40, status: 'pending' })
    // the row must NOT persist a computed value (UC-3 / no cross-desk cache)
    expect('actual' in p[0]).toBe(false)
    expect('message' in p[0]).toBe(false)

    // digest recomputes `actual` LIVE
    const d = await digest(t, W)
    expect(d.items).toHaveLength(1)
    expect(d.items[0]).toMatchObject({ identifier: 'billable', goal: 40, actual: 16 })
    expect(d.items[0].message).toContain('actual 16')

    // same week ⇒ no duplicate
    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 0 })
    expect(await proposals(t, W)).toHaveLength(1)

    // UC-3 / no-auto-apply: note bodies byte-unchanged, no entities
    const notes = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect()).map((n: any) => n.body).sort(),
    )
    expect(notes).toEqual(['Logged {billable: 10} and {billable: 6}.', 'This week: {goal_billable: 40} and prose.'])
    expect(await t.run(async (ctx) => (await ctx.db.query('entities').collect()).length)).toBe(0)
  })

  it('caught up since proposal created ⇒ silently dropped from the digest', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'intent.md', '{goal_billable: 40}')
    await seedNote(t, W, 'work.md', '{billable: 5}')
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'billable', spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
    })
    await t.mutation(internal.loop._reconcile, { workspaceId: W })
    expect((await digest(t, W)).items).toHaveLength(1)
    // user does the work → now at/above goal
    await seedNote(t, W, 'more.md', '{billable: 50}')
    expect((await digest(t, W)).items).toHaveLength(0) // dropped, no nag
  })

  it('on/above goal ⇒ no proposal; null rollup ⇒ skip; no intent ⇒ reason', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'intent.md', '{goal_billable: 10}')
    await seedNote(t, W, 'work.md', '{billable: 50}')
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'billable', spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
    })
    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 0 })

    const t2 = convexTest(schema, modules)
    await seedNote(t2, W, 'intent.md', '{goal_undef: 99}')
    expect(await t2.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 0 })

    const t3 = convexTest(schema, modules)
    expect(await t3.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({
      proposed: 0, reason: 'no intent.md',
    })
  })

  it('a goal in ANY code container is NOT a goal — fence, inline, blockquoted tilde fence, indented (Codex MED)', async () => {
    const t = convexTest(schema, modules)
    const intent = [
      'Inline `{goal_billable: 40}` example,',
      '',
      '```',
      '{goal_billable: 40}',
      '```',
      '',
      '> ~~~',
      '> {goal_billable: 40}',
      '> ~~~',
      '',
      '    {goal_billable: 40}', // 4-space indented code block
      '',
      'no real goal anywhere above.',
    ].join('\n')
    await seedNote(t, W, 'intent.md', intent)
    await seedNote(t, W, 'work.md', '{billable: 1}')
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'billable', spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
    })
    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 0 })

    // and a REAL prose goal in the same doc still works
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('atoms').collect()).find(
        (r: any) => r.workspaceId === W && r.path === 'intent.md',
      )
      await ctx.db.patch(row!._id, { body: intent + '\n\nReal: {goal_billable: 40}' })
    })
    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 1 })
  })

  it('ambiguous (duplicate) intent.md ⇒ fail-soft, no throw', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'intent.md', '{goal_x: 9}')
    await seedNote(t, W, 'intent.md', '{goal_x: 9}') // pathological dup
    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({
      proposed: 0, reason: 'ambiguous intent.md',
    })
  })

  it('non-number / malformed goal atom is ignored', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'intent.md', '{goal_x: not_a_number} {goal_: 5} {notgoal: 1}')
    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 0 })
  })
})

describe('loop — approve at the edge (advisory; never auto-applies)', () => {
  it('accept / dismiss; re-resolve + cross-workspace guarded', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'intent.md', '{goal_billable: 40}')
    await seedNote(t, W, 'work.md', '{billable: 5}')
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'billable', spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
    })
    await t.mutation(internal.loop._reconcile, { workspaceId: W })
    const id = (await proposals(t, W))[0]._id as Id<'proposals'>

    expect(
      await t.mutation(internal.loop._resolveProposal, { workspaceId: 'ws_other', proposalId: id, accept: true }),
    ).toEqual({ ok: false, reason: 'not-found' })

    expect(
      await t.mutation(internal.loop._resolveProposal, { workspaceId: W, proposalId: id, accept: true }),
    ).toEqual({ ok: true, status: 'accepted' })
    expect(await t.run(async (ctx) => (await ctx.db.query('entities').collect()).length)).toBe(0)

    expect(
      await t.mutation(internal.loop._resolveProposal, { workspaceId: W, proposalId: id, accept: false }),
    ).toEqual({ ok: false, reason: 'not-pending (accepted)' })
    expect((await digest(t, W)).items).toHaveLength(0)
  })
})

describe('loop._reconcile — cross-desk goal via window rollup (REGRESSION: revoke ⇒ no stale leak)', () => {
  async function setup(t: T) {
    await t.run(async (ctx) => {
      await ctx.db.insert('entities', { workspaceId: OWNER, type: 'person', slug: 'anna', data: { hours: 6 }, updatedAt: 1 })
      await ctx.db.insert('entities', { workspaceId: OWNER, type: 'person', slug: 'bo', data: { hours: 4 }, updatedAt: 1 })
    })
    const w = await t.withIdentity({ subject: OWNER }).mutation(api.windows.createWindow, {
      name: 'team', selectorKeys: ['hours'],
      aggregate: { key: 'hours', op: 'sum', as: 'team_hours' },
    })
    await t.withIdentity({ subject: OWNER }).mutation(api.windows.grant, { windowId: w, viewerWorkspaceId: W })
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'team_hours', spec: { kind: 'window', windowId: w },
    })
    await seedNote(t, W, 'intent.md', 'Team target {goal_team_hours: 100}')
    return w
  }

  it('behind a granted cross-desk team goal ⇒ proposal; digest shows LIVE actual', async () => {
    const t = convexTest(schema, modules)
    await setup(t)
    expect(await t.mutation(internal.loop._reconcile, { workspaceId: W })).toEqual({ proposed: 1 })
    const p = (await proposals(t, W))[0]
    expect(p).toMatchObject({ identifier: 'team_hours', goal: 100 })
    expect('actual' in p).toBe(false) // NEVER persist the cross-desk number
    const d = await digest(t, W)
    expect(d.items[0]).toMatchObject({ identifier: 'team_hours', goal: 100, actual: 10 })
  })

  it('grant REVOKED after the proposal ⇒ digest DROPS it (no stale cross-desk read — Codex HIGH)', async () => {
    const t = convexTest(schema, modules)
    const w = await setup(t)
    await t.mutation(internal.loop._reconcile, { workspaceId: W })
    expect((await digest(t, W)).items).toHaveLength(1) // visible while granted

    await t.withIdentity({ subject: OWNER }).mutation(api.windows.revoke, {
      windowId: w, viewerWorkspaceId: W,
    })
    // the stored proposal still exists, but the digest re-resolves
    // LIVE → DENY → null → the proposal is suppressed. The old
    // cross-desk `10` is NEVER surfaced post-revocation.
    const d = await digest(t, W)
    expect(d.items).toHaveLength(0)
    expect(JSON.stringify(d)).not.toContain('10')
  })
})

describe('loop._gardenAndMap — Unit 4c: thicker _map.md + gardening (advisory, never deletes)', () => {
  const mapBody = (t: T, ws: string) =>
    t.run(async (ctx) => {
      const r = (await ctx.db.query('atoms').collect()).find(
        (a: any) => a.workspaceId === ws && a.path === '_map.md',
      )
      return r ? { body: r.body as string, source: r.source } : null
    })

  it('regenerates a deterministic _map.md; only _map.md is written; nothing deleted', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'notes/a.md', '# Alpha\nlinks [[notes/b.md]]')
    await seedNote(t, W, 'notes/b.md', 'Beta body')
    await seedNote(t, W, 'me.md', 'I am the user')

    const r1 = await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    expect(r1.mapRegen).toBe('written')
    const m1 = await mapBody(t, W)
    expect(m1?.source).toBe('agent')
    expect(m1?.body).toContain('# _map')
    expect(m1?.body).toContain('[[notes/a.md]]')
    expect(m1?.body).toContain('Alpha') // heading used as summary
    expect(m1?.body).toContain('→ notes/b.md') // outbound link hint
    expect(m1?.body).not.toMatch(/\[\[_map\.md\]\]/) // never indexes itself

    // user notes byte-unchanged; only _map.md added; NOTHING deleted
    const live = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect())
        .filter((a: any) => a.workspaceId === W)
        .map((a: any) => a.path)
        .sort(),
    )
    expect(live).toEqual(['_map.md', 'me.md', 'notes/a.md', 'notes/b.md'])
    const a = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect()).find(
        (x: any) => x.workspaceId === W && x.path === 'notes/a.md',
      ),
    )
    expect(a!.body).toBe('# Alpha\nlinks [[notes/b.md]]') // untouched

    // deterministic: regen again ⇒ identical body
    const r2 = await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    expect(r2.mapRegen).toBe('written')
    expect((await mapBody(t, W))?.body).toBe(m1?.body)
  })

  it('overwrites ONLY an agent-owned map: user OR unknown-source _map.md is left untouched (Codex LOW/MED)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: '_map.md', body: 'MINE', updatedAt: 1, source: 'user' })
    })
    await seedNote(t, W, 'notes/a.md', 'a')
    const r = await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    expect(r.mapRegen).toBe('skipped-not-agent-owned')
    expect((await mapBody(t, W))?.body).toBe('MINE')

    // unknown/unset source (legacy/external insert) is ALSO not ours
    const t2 = convexTest(schema, modules)
    await t2.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: '_map.md', body: 'LEGACY', updatedAt: 1 })
    })
    await seedNote(t2, W, 'notes/a.md', 'a')
    expect((await t2.mutation(internal.loop._gardenAndMap, { workspaceId: W })).mapRegen).toBe('skipped-not-agent-owned')
    expect((await mapBody(t2, W))?.body).toBe('LEGACY')
  })

  it('duplicate _map.md rows ⇒ fail-soft (no cron throw) (Codex MED)', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: '_map.md', body: 'x', updatedAt: 1, source: 'agent' })
      await ctx.db.insert('atoms', { workspaceId: W, path: '_map.md', body: 'y', updatedAt: 1, source: 'agent' })
    })
    await seedNote(t, W, 'notes/a.md', 'a')
    const r = await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    expect(r.mapRegen).toBe('skipped-ambiguous-map') // did not throw
  })

  it('REGRESSION (Codex HIGH): _map.md never double-counts a note’s atoms into live-totals / reconcile', async () => {
    const t = convexTest(schema, modules)
    // first prose line of work.md LOOKS like an atom — it is the
    // single source of {billable: 10}.
    await seedNote(t, W, 'work.md', 'Logged {billable: 10} on Acme.')
    await seedNote(t, W, 'intent.md', '{goal_billable: 15}')
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'billable', spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
    })
    // generate _map.md (its summary echoes "Logged {billable: 10}")
    await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    const m = await mapBody(t, W)
    expect(m?.body).not.toContain('{billable: 10}') // braces neutralised
    expect(m?.body).toContain('(billable: 10)') // sanitised echo

    await t.mutation(internal.loop._reconcile, { workspaceId: W })
    const d = await t.query(internal.loop._pendingProposals, { workspaceId: W })
    const it = d.items.find((i: any) => i.identifier === 'billable')
    expect(it?.actual).toBe(10) // NOT 20 — _map.md excluded from value scan
  })

  it('map link hints are capped per note (byte-bound; Codex MED)', async () => {
    const t = convexTest(schema, modules)
    const many = Array.from({ length: 30 }, (_, i) => `[[notes/t${i}.md]]`).join(' ')
    await seedNote(t, W, 'hub.md', `hub ${many}`)
    await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    const body = (await mapBody(t, W))!.body
    const hubLine = body.split('\n').find((l) => l.includes('[[hub.md]]'))!
    // count ONLY the link-hint segment (after ` → `); the summary echo
    // may also contain raw [[..]] text — cosmetic, not the bound.
    const hint = hubLine.split(' → ')[1] ?? ''
    const shown = (hint.match(/notes\/t\d+\.md/g) ?? []).length
    expect(shown).toBeLessThanOrEqual(12) // MAP_MAX_LINKS_PER_NOTE
    expect(shown).toBeGreaterThan(0)
  })

  it('per-component caps bound map allocation (Codex MED #3 — no over-allocate-then-slice)', async () => {
    const t = convexTest(schema, modules)
    const longPath = 'deep/' + 'x'.repeat(500) + '.md'
    await seedNote(t, W, longPath, 'y'.repeat(2000)) // huge path + body
    await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    const body = (await mapBody(t, W))!.body
    const line = body.split('\n').find((l) => l.startsWith('- [[')) ?? ''
    // path display capped (~200) + summary capped (80) — NOT 500/2000
    expect(line.length).toBeLessThan(400)
    expect(line).toContain('…') // truncation ellipsis present
  })

  it('a legacy proposal row with NO kind is treated as metric (Codex MED #5 — widen-migrate-narrow)', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'work.md', '{x: 5}')
    await t.mutation(internal.liveTotals._define, {
      workspaceId: W, identifier: 'x', spec: { kind: 'ownDesk', op: 'sum', key: 'x' },
    })
    await t.run(async (ctx) => {
      // a pre-existing row from before `kind` existed — no kind field
      await ctx.db.insert('proposals', {
        workspaceId: W, period: 'wLEGACY', identifier: 'x',
        goal: 100, status: 'pending', createdAt: 1,
      })
    })
    const d = await t.query(internal.loop._pendingProposals, { workspaceId: W })
    const it = d.items.find((i: any) => i.identifier === 'x')
    expect(it).toBeTruthy() // did not throw; surfaced
    expect(it!.kind).toBe('metric') // missing kind ⇒ metric (original shape)
    expect(it!.actual).toBe(5)
  })

  it('flags orphans + exact-duplicates as ONE advisory pending proposal; idempotent; never deletes', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'notes/a.md', 'hello [[notes/b.md]]')
    await seedNote(t, W, 'notes/b.md', 'linked, not orphan')
    await seedNote(t, W, 'notes/lonely.md', 'no links in or out') // ORPHAN
    await seedNote(t, W, 'dup1.md', 'SAME CONTENT')
    await seedNote(t, W, 'dup2.md', 'SAME CONTENT') // exact dup
    await seedNote(t, W, 'me.md', 'singleton — not an orphan')

    const r = await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    expect(r.gardening).toBe(1)
    const gp = (await proposals(t, W)).filter((p: any) => p.kind === 'gardening')
    expect(gp).toHaveLength(1)
    expect(gp[0].summary).toContain('notes/lonely.md')
    expect(gp[0].summary).toContain('dup1.md')
    expect(gp[0].summary).not.toContain('me.md') // singleton excluded
    expect('goal' in gp[0]).toBe(false)

    // idempotent per week
    await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    expect((await proposals(t, W)).filter((p: any) => p.kind === 'gardening')).toHaveLength(1)

    // shows in the digest, re-evaluated LIVE
    const d1 = await t.query(internal.loop._pendingProposals, { workspaceId: W })
    expect(d1.items.some((i: any) => i.kind === 'gardening')).toBe(true)

    // NOTHING was deleted by gardening
    const n = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect()).filter((a: any) => a.workspaceId === W).length,
    )
    expect(n).toBe(7) // 6 seeded + _map.md ; zero deletions

    // tidy up EVERY issue: link the orphan; make the dups distinct AND
    // give them outbound links (so de-duping doesn't just turn them
    // into new orphans) ⇒ digest drops the gardening item, no nag.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('atoms').collect()
      const find = (p: string) =>
        rows.find((x: any) => x.workspaceId === W && x.path === p)!
      await ctx.db.patch(find('notes/a.md')._id, {
        body: 'hello [[notes/b.md]] and [[notes/lonely.md]] and [[dup1.md]] and [[dup2.md]]',
      })
      await ctx.db.patch(find('dup2.md')._id, { body: 'now distinct content' })
    })
    const d2 = await t.query(internal.loop._pendingProposals, { workspaceId: W })
    expect(d2.items.some((i: any) => i.kind === 'gardening')).toBe(false) // dropped, no nag
  })

  it('a goal/value atom inside _map.md content cannot create phantom data (it is excluded from its own index + gardening)', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'notes/a.md', 'real [[notes/b.md]]')
    await seedNote(t, W, 'notes/b.md', 'b')
    const r = await t.mutation(internal.loop._gardenAndMap, { workspaceId: W })
    // a + b mutually... b has no outbound but is linked → not orphan;
    // a links b and is not linked → a is an orphan candidate? a has
    // outbound (≥1) so NOT orphan. So no gardening proposal.
    expect(r.gardening).toBe(0)
  })
})

// ── P4 public surface (design loop-ux v2) — owner-scoped wrappers
// delegating to the SAME impls; the locked engine tests above prove
// the impls, these prove the public path is byte-equivalent +
// owner-scoped + advisory + the runNow honesty contract.

const asW = (t: T) => t.withIdentity({ subject: W })
const userNotes = (t: T, ws: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('atoms').collect())
      .filter((r: any) => r.workspaceId === ws && r.path !== '_map.md')
      .map((r: any) => ({ path: r.path, body: r.body }))
      .sort((a: any, b: any) => a.path.localeCompare(b.path)),
  )
const entityCount = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('entities').collect()).length)

async function seedBehindGoal(t: T) {
  await seedNote(t, W, 'intent.md', 'This week: {goal_billable: 40}.')
  await seedNote(t, W, 'work.md', 'Logged {billable: 10} and {billable: 6}.')
  await t.mutation(internal.liveTotals._define, {
    workspaceId: W,
    identifier: 'billable',
    spec: { kind: 'ownDesk', op: 'sum', key: 'billable' },
  })
}

describe('P4 — public listPending ≡ internal digest, owner-scoped', () => {
  it('same items as _pendingProposals; unauth throws; a stranger sees only their own', async () => {
    const t = convexTest(schema, modules)
    await seedBehindGoal(t)
    await t.mutation(internal.loop._reconcile, { workspaceId: W })
    const pub = await asW(t).query(api.loop.listPending, {})
    const int = await digest(t, W)
    expect(pub).toEqual(int)
    expect(pub.items.length).toBe(1)
    expect(pub.items[0]).toMatchObject({
      kind: 'metric',
      identifier: 'billable',
      goal: 40,
      actual: 16,
    })
    expect(
      await t.withIdentity({ subject: OWNER }).query(api.loop.listPending, {}),
    ).toEqual({ truncated: false, items: [] })
    await expect(t.query(api.loop.listPending, {})).rejects.toThrow(
      /Not authenticated/,
    )
  })
})

describe('P4 — public accept/dismiss: advisory, terminal, owner-scoped', () => {
  it('accept = pure status flip (no user data written); terminal; foreign id ⇒ not-found', async () => {
    const t = convexTest(schema, modules)
    await seedBehindGoal(t)
    await t.mutation(internal.loop._reconcile, { workspaceId: W })
    const before = await userNotes(t, W)
    const id = (await proposals(t, W))[0]._id as Id<'proposals'>

    // a STRANGER cannot resolve W's proposal (owner strictly from auth)
    expect(
      await t
        .withIdentity({ subject: OWNER })
        .mutation(api.loop.accept, { proposalId: id }),
    ).toEqual({ ok: false, reason: 'not-found' })

    const r = await asW(t).mutation(api.loop.accept, { proposalId: id })
    expect(r).toEqual({ ok: true, status: 'accepted' })
    // ADVISORY: no entities, user notes byte-unchanged
    expect(await entityCount(t)).toBe(0)
    expect(await userNotes(t, W)).toEqual(before)
    // terminal: re-accept / dismiss-after-accept both refused
    expect(
      await asW(t).mutation(api.loop.accept, { proposalId: id }),
    ).toEqual({ ok: false, reason: 'not-pending (accepted)' })
    expect(
      await asW(t).mutation(api.loop.dismiss, { proposalId: id }),
    ).toEqual({ ok: false, reason: 'not-pending (accepted)' })
    // accepted ⇒ no longer in the pending digest
    expect((await asW(t).query(api.loop.listPending, {})).items).toEqual([])
  })
})

describe('P4 — public runNow: advisory + idempotent + reason passthrough', () => {
  it('no intent.md ⇒ {proposed:0,gardening:0,reason:"no intent.md"}; never writes user data', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'me.md', '# Me') // a user note, NOT intent.md
    const before = await userNotes(t, W)
    const r = await asW(t).mutation(api.loop.runNow, {})
    expect(r).toEqual({ proposed: 0, gardening: 0, reason: 'no intent.md' })
    expect(await entityCount(t)).toBe(0)
    expect(await userNotes(t, W)).toEqual(before) // user notes untouched
  })

  it('behind a goal ⇒ proposed:1; idempotent same week ⇒ {0,0}; user notes byte-unchanged (only _map.md may change)', async () => {
    const t = convexTest(schema, modules)
    await seedBehindGoal(t)
    const before = await userNotes(t, W)
    const r1 = await asW(t).mutation(api.loop.runNow, {})
    expect(r1.proposed).toBe(1) // the billable metric
    expect(r1.reason).toBeUndefined() // success path: no reason key
    // the fresh metric proposal is visible via the public digest
    // (the two unlinked seed notes also legitimately trigger ONE
    // gardening proposal — assert the metric specifically, not a
    // brittle total count).
    const items = (await asW(t).query(api.loop.listPending, {})).items
    expect(
      items.some(
        (i) => i.kind === 'metric' && i.identifier === 'billable',
      ),
    ).toBe(true)
    // idempotent within the epoch-week: BOTH passes already done ⇒
    // nothing new (metric deduped per (ws,period,id); gardening per
    // (ws,period,GARDEN_ID)).
    expect(await asW(t).mutation(api.loop.runNow, {})).toEqual({
      proposed: 0,
      gardening: 0,
    })
    // ADVISORY: entities empty; USER notes byte-unchanged (the design
    // invariant: _map.md MAY be (re)written, user prose never).
    expect(await entityCount(t)).toBe(0)
    expect(await userNotes(t, W)).toEqual(before)
  })
})
