/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_map'
type T = ReturnType<typeof convexTest>

const seedNote = (t: T, ws: string, path: string, body: string) =>
  t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId: ws, path, body, updatedAt: 1 })
  })

const mapBody = (t: T, ws: string) =>
  t.run(async (ctx) => {
    const r = (await ctx.db.query('atoms').collect()).find(
      (a: any) => a.workspaceId === ws && a.path === '.context/_map.md',
    )
    return r
      ? {
          body: r.body as string,
          source: r.source,
          systemLocked: r.systemLocked,
        }
      : null
  })

describe('map regeneration', () => {
  it('regenerates a deterministic .context/_map.md without changing user notes', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'notes/a.md', '# Alpha\nlinks [[notes/b.md]]')
    await seedNote(t, W, 'notes/b.md', 'Beta body')
    await seedNote(t, W, '.context/me.md', 'I am the user')

    const r1 = await t.mutation(internal.map._regenerateMapForWorkspace, {
      workspaceId: W,
    })
    expect(r1.mapRegen).toBe('written')
    const m1 = await mapBody(t, W)
    expect(m1?.source).toBe('agent')
    expect(m1?.systemLocked).toBeFalsy()
    expect(m1?.body).toContain('# _map')
    expect(m1?.body).toContain('[[notes/a.md]]')
    expect(m1?.body).toContain('Alpha')
    expect(m1?.body).toContain('-> notes/b.md')
    expect(m1?.body).not.toMatch(/\[\[_map\.md\]\]/)

    const live = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect())
        .filter((a: any) => a.workspaceId === W)
        .map((a: any) => a.path)
        .sort(),
    )
    expect(live).toEqual([
      '.context/_map.md',
      '.context/me.md',
      'notes/a.md',
      'notes/b.md',
    ])
    const a = await t.run(async (ctx) =>
      (await ctx.db.query('atoms').collect()).find(
        (x: any) => x.workspaceId === W && x.path === 'notes/a.md',
      ),
    )
    expect(a!.body).toBe('# Alpha\nlinks [[notes/b.md]]')

    const r2 = await t.mutation(internal.map._regenerateMapForWorkspace, {
      workspaceId: W,
    })
    expect(r2.mapRegen).toBe('written')
    expect((await mapBody(t, W))?.body).toBe(m1?.body)

    await t.withIdentity({ subject: W }).mutation(api.atoms.remove, {
      path: '.context/_map.md',
    })
    expect(await mapBody(t, W)).toBeNull()
  })

  it('overwrites only an agent-owned map', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: '.context/_map.md',
        body: 'MINE',
        updatedAt: 1,
        source: 'user',
      })
    })
    await seedNote(t, W, 'notes/a.md', 'a')
    const r = await t.mutation(internal.map._regenerateMapForWorkspace, {
      workspaceId: W,
    })
    expect(r.mapRegen).toBe('skipped-not-agent-owned')
    expect((await mapBody(t, W))?.body).toBe('MINE')

    const t2 = convexTest(schema, modules)
    await t2.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: '.context/_map.md',
        body: 'LEGACY',
        updatedAt: 1,
      })
    })
    await seedNote(t2, W, 'notes/a.md', 'a')
    expect(
      (
        await t2.mutation(internal.map._regenerateMapForWorkspace, {
          workspaceId: W,
        })
      ).mapRegen,
    ).toBe('skipped-not-agent-owned')
    expect((await mapBody(t2, W))?.body).toBe('LEGACY')
  })

  it('duplicate .context/_map.md rows fail soft', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: '.context/_map.md',
        body: 'x',
        updatedAt: 1,
        source: 'agent',
      })
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: '.context/_map.md',
        body: 'y',
        updatedAt: 1,
        source: 'agent',
      })
    })
    await seedNote(t, W, 'notes/a.md', 'a')
    const r = await t.mutation(internal.map._regenerateMapForWorkspace, {
      workspaceId: W,
    })
    expect(r.mapRegen).toBe('skipped-ambiguous-map')
  })

  it('map summaries neutralize value-looking braces', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'work.md', 'Logged {billable: 10} on Acme.')
    await t.mutation(internal.map._regenerateMapForWorkspace, {
      workspaceId: W,
    })
    const m = await mapBody(t, W)
    expect(m?.body).not.toContain('{billable: 10}')
    expect(m?.body).toContain('(billable: 10)')
  })

  it('map link hints are capped per note', async () => {
    const t = convexTest(schema, modules)
    const many = Array.from({ length: 30 }, (_, i) => `[[notes/t${i}.md]]`).join(
      ' ',
    )
    await seedNote(t, W, 'hub.md', `hub ${many}`)
    await t.mutation(internal.map._regenerateMapForWorkspace, {
      workspaceId: W,
    })
    const body = (await mapBody(t, W))!.body
    const hubLine = body.split('\n').find((l) => l.includes('[[hub.md]]'))!
    const hint = hubLine.split(' -> ')[1] ?? ''
    const shown = (hint.match(/notes\/t\d+\.md/g) ?? []).length
    expect(shown).toBeLessThanOrEqual(12)
    expect(shown).toBeGreaterThan(0)
  })

  it('per-component caps bound map allocation', async () => {
    const t = convexTest(schema, modules)
    const longPath = 'deep/' + 'x'.repeat(500) + '.md'
    await seedNote(t, W, longPath, 'y'.repeat(2000))
    await t.mutation(internal.map._regenerateMapForWorkspace, {
      workspaceId: W,
    })
    const body = (await mapBody(t, W))!.body
    const line = body.split('\n').find((l) => l.startsWith('- [[')) ?? ''
    expect(line.length).toBeLessThan(400)
    expect(line).toContain('...')
  })

  it('regenerates and clears duplicate schedule rows without throwing', async () => {
    const t = convexTest(schema, modules)
    await seedNote(t, W, 'notes/a.md', 'Alpha')
    await t.run(async (ctx) => {
      await ctx.db.insert('mapRegenSchedule', {
        workspaceId: W,
        scheduledFor: 1,
      })
      await ctx.db.insert('mapRegenSchedule', {
        workspaceId: W,
        scheduledFor: 2,
      })
    })

    await expect(
      t.mutation(internal.map._regenerateMapDebounced, { workspaceId: W }),
    ).resolves.toMatchObject({ mapRegen: 'written' })
    expect(await mapBody(t, W)).not.toBeNull()
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('mapRegenSchedule')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', W))
        .collect(),
    )
    expect(rows).toEqual([])
  })
})
