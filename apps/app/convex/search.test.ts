/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { TestConvex } from 'convex-test'

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_a'
const W2 = 'ws_b'

function seed(
  t: TestConvex<typeof schema>,
  workspaceId: string,
  path: string,
  body: string,
) {
  return t.mutation(internal.atoms._upsertInternal, {
    workspaceId,
    path,
    body,
    source: 'user',
  })
}

describe('search.run — empty query → recent', () => {
  it('returns recent docs, workspace-scoped', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'a.md', '# Alpha\nfirst')
    await seed(t, W, 'b.md', '# Beta\nsecond')
    await seed(t, W2, 'c.md', '# Gamma\nother workspace')
    const res = await t.withIdentity({ subject: W }).query(api.search.run, {
      query: '',
    })
    const paths = res.map((r) => r.path)
    expect(paths).toContain('a.md')
    expect(paths).toContain('b.md')
    expect(paths).not.toContain('c.md') // tenancy
  })
})

describe('search.run — full text', () => {
  it('finds md body, html visible text, and ascii-sketch text — scoped', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'clients/Acme.md', '# Acme Corp\nSigned the renewalcontract in Q3.')
    await seed(t, W, 'page.html', '<h1>Dash</h1><p>visiblehtmlword here</p>')
    // bare word in the sketch — convex-test tokenizes on whitespace only,
    // whereas real Convex also splits punctuation (so `[sketchnode]` would
    // match `sketchnode` in prod). The point: ascii-sketch text is indexed.
    await seed(t, W, 'arch.md', '```ascii\nsketchnode --> db\n```')
    await seed(t, W2, 'other.md', 'renewalcontract elsewhere')
    const as = t.withIdentity({ subject: W })

    const r1 = await as.query(api.search.run, { query: 'renewalcontract' })
    expect(r1.map((r) => r.path)).toEqual(['clients/Acme.md']) // only W's

    const r2 = await as.query(api.search.run, { query: 'visiblehtmlword' })
    expect(r2.map((r) => r.path)).toContain('page.html')

    const r3 = await as.query(api.search.run, { query: 'sketchnode' })
    expect(r3.map((r) => r.path)).toContain('arch.md')
  })

  it('ranks a title match above a body-only match (post-rank)', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'mentions.md', 'a doc that mentions widgetword in its body only')
    await seed(t, W, 'widgetword.md', '# Widgetword\nthe definitive page')
    const as = t.withIdentity({ subject: W })
    const r = await as.query(api.search.run, { query: 'widgetword' })
    expect(r[0].path).toBe('widgetword.md')
  })

  it('returns a highlighted snippet for the match', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'note.md', '# Note\nthe special uniqueterm lives here')
    const as = t.withIdentity({ subject: W })
    const r = await as.query(api.search.run, { query: 'uniqueterm' })
    const hit = r.find((x) => x.path === 'note.md')!
    expect(hit.snippet.some((p) => p.hit && /uniqueterm/i.test(p.s))).toBe(true)
  })

  it('legacy un-indexed atoms become searchable after backfill (the rollout self-heal)', async () => {
    const t = convexTest(schema, modules)
    // Direct insert (bypasses the search-aware write path) simulates an
    // atom created before the search feature shipped — searchText and
    // searchable are undefined. This is exactly the state of the user's
    // "Hotfix" file before backfill. In real Convex, such a row is simply
    // absent from search results; convex-test's index emulation can't
    // faithfully represent the pre-backfill state, so we jump straight to
    // running the workspace-scoped backfill (what `search.ensureIndexed`
    // schedules) and assert the atom is now findable.
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'legacy.md',
        body: '# Legacy\nHotfix deployed 2025-07-15.',
        updatedAt: 1,
      })
    })
    await t.mutation(internal.atoms._backfillSearch, { workspaceId: W })
    const r = await t
      .withIdentity({ subject: W })
      .query(api.search.run, { query: 'hotfix' })
    expect(r.map((x) => x.path)).toContain('legacy.md')
  })

  it('a rename reindexes — search follows the new basename, drops the old', async () => {
    const t = convexTest(schema, modules)
    await seed(t, W, 'oldname.md', '# Heading\nplain content')
    const as = t.withIdentity({ subject: W })
    expect(
      (await as.query(api.search.run, { query: 'oldname' })).map((r) => r.path),
    ).toContain('oldname.md')

    await as.mutation(api.atoms.move, { fromPath: 'oldname.md', toPath: 'newname.md' })

    expect(
      (await as.query(api.search.run, { query: 'newname' })).map((r) => r.path),
    ).toContain('newname.md')
    expect(
      (await as.query(api.search.run, { query: 'oldname' })).map((r) => r.path),
    ).not.toContain('newname.md')
  })
})
