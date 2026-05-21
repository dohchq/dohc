/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'

// atom-address-v1 §5.2 Phase-4 precondition 1 — the query-block eval
// path's internal list reads are BOUNDED (an unbounded scan run
// reactively per-keystroke is the live-crash class) and truncation
// is DISCLOSED honestly, never a silently-wrong authoritative number.
//
// The >QUERY_SCAN_CAP (5000) branch is pure slice/marker logic over a
// detected-truncated array; seeding 5001 rows in a unit test is
// impractical, so it is covered by (a) the bounding-primitive test
// below proving `limit` ⇒ take(limit+1) + detectable overflow at a
// small limit, and (b) the dual-review of the per-verb truncation
// strings. The non-truncated path is asserted byte-unchanged here.

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_test'

const ent = (
  t: ReturnType<typeof convexTest>,
  type: string,
  slug: string,
  data: Record<string, unknown>,
) =>
  t.run(async (ctx) => {
    await ctx.db.insert('entities', {
      workspaceId: W,
      type,
      slug,
      data,
      updatedAt: 1,
    })
  })

describe('Phase-4 precondition 1 — bounded internal list reads', () => {
  it('_listByType: omitted limit ⇒ unbounded (regression); limit ⇒ take(limit+1) detectable', async () => {
    const t = convexTest(schema, modules)
    await ent(t, 'person', 'a', { name: 'A' })
    await ent(t, 'person', 'b', { name: 'B' })
    await ent(t, 'person', 'c', { name: 'C' })
    // unbounded (every existing caller: agent / pluginBridge)
    const all = await t.query(internal.entities._listByType, {
      workspaceId: W,
      type: 'person',
    })
    expect(all.length).toBe(3)
    // bounded at 2 ⇒ take(3) ⇒ 3 rows back ⇒ caller sees 3 > 2 ⇒
    // truncation is DETECTABLE (the eval slices to cap + discloses)
    const capped = await t.query(internal.entities._listByType, {
      workspaceId: W,
      type: 'person',
      limit: 2,
    })
    expect(capped.length).toBe(3) // limit+1
    expect(capped.length > 2).toBe(true) // ⇒ truncated path fires
    // under the limit ⇒ NOT truncated
    const under = await t.query(internal.entities._listByType, {
      workspaceId: W,
      type: 'project',
      limit: 2,
    })
    expect(under.length).toBe(0)
  })

  it('_listInternal: same — omitted unbounded; limit bounds + detectable', async () => {
    const t = convexTest(schema, modules)
    for (const p of ['a.md', 'b.md', 'c.md']) {
      await t.mutation(internal.atoms._upsertInternal, {
        workspaceId: W,
        path: p,
        body: '# x',
        source: 'user',
      })
    }
    const all = await t.query(internal.atoms._listInternal, { workspaceId: W })
    expect(all.length).toBe(3) // unbounded — regression safety
    const capped = await t.query(internal.atoms._listInternal, {
      workspaceId: W,
      limit: 2,
    })
    expect(capped.length).toBe(3) // take(2+1) ⇒ overflow detectable
  })
})

describe('Phase-4 precondition — non-truncated eval byte-unchanged', () => {
  it('entities list / count / find: identical output under the cap', async () => {
    const t = convexTest(schema, modules)
    await ent(t, 'person', 'sam', { name: 'Sam', role: 'eng', fte: 100 })
    await ent(t, 'person', 'ana', { name: 'Ana', role: 'design', fte: 80 })
    const as = t.withIdentity({ subject: W })
    expect(await as.action(api.queries.run, { src: 'entities.list("person")' })).toBe(
      '- **Ana** — design · 80%\n- **Sam** — eng · 100%',
    )
    expect(await as.action(api.queries.run, { src: 'entities.count("person")' })).toBe(
      '2', // exact number, NOT a ≥N truncation marker (under cap)
    )
    expect(
      await as.action(api.queries.run, {
        src: 'entities.find("person", { role: design })',
      }),
    ).toContain('**Ana** (ana)')
    expect(
      await as.action(api.queries.run, {
        src: 'entities.find("person", { role: nope })',
      }),
    ).toBe('_(no match)_') // plain, NOT the truncated variant
  })

  it('vault.glob: matches under the cap, plain no-match', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'dashboard.md',
      body: '# d',
      source: 'user',
    })
    const as = t.withIdentity({ subject: W })
    expect(await as.action(api.queries.run, { src: 'vault.glob("dash*")' })).toBe(
      '- [[dashboard.md]]',
    )
    expect(await as.action(api.queries.run, { src: 'vault.glob("zzz*")' })).toBe(
      '_(no matches)_',
    )
  })

  it('still fail-soft on bad syntax (unchanged — Phase-4 render wraps this)', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    const r = await as.action(api.queries.run, { src: 'not a query' })
    expect(r.startsWith('_(query error')).toBe(true) // run's contract preserved
  })
})

describe('Phase-4 4B — evalQueryBlocks reactive query', () => {
  it('array shape; result md for valid; null (raw error NEVER surfaced) for errors; legit-empty is a string', async () => {
    const t = convexTest(schema, modules)
    await ent(t, 'person', 'sam', { name: 'Sam', role: 'eng' })
    const as = t.withIdentity({ subject: W })
    const r = await as.query(api.queries.evalQueryBlocks, {
      srcs: [
        'entities.list("person")', // valid → md string
        'entities.list("nobody")', // legit-empty → string `_(nothing)_`
        'not a query', // parse error → value:null
        'frobnicate.list("x")', // unknown ns → value:null
        'entities.list("person")', // dup → deduped
      ],
    })
    const m = new Map(r.map((e) => [e.src, e.value]))
    expect(Array.isArray(r)).toBe(true)
    expect(m.get('entities.list("person")')).toBe('- **Sam** — eng')
    expect(m.get('entities.list("nobody")')).toBe('_(nothing)_') // empty ≠ error
    // error ⇒ null; the raw `_(query error: …)_` / `_(unknown …)_`
    // string is NEVER on the wire (§5.2 strongest fail-soft boundary)
    expect(m.get('not a query')).toBeNull()
    expect(m.get('frobnicate.list("x")')).toBeNull()
    expect(r.length).toBe(4) // deduped
    expect(
      r.every((e) => typeof e.src === 'string' && !('error' in e)),
    ).toBe(true)
  })

  it('owner-scoped + capped, never throws on junk/poison', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    const many = Array.from({ length: 200 }, (_, i) => `entities.list("t${i}")`)
    const r = await as.query(api.queries.evalQueryBlocks, {
      srcs: [...many, '__proto__', '_x.y', 'entities.list("t0")'],
    })
    expect(r.length).toBeLessThanOrEqual(64) // MAX_QUERY_BLOCKS
    // every element is a safe {src,value} — array, no object-key poison
    expect(r.every((e) => 'src' in e && 'value' in e)).toBe(true)
  })

  it('Codex P4 dispositive: IN-namespace errors ⇒ value:null (raw text NEVER rendered)', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    const r = await as.query(api.queries.evalQueryBlocks, {
      srcs: [
        'entities.list()', // no type ⇒ in-namespace error
        'entities.bogus("person")', // unsupported verb
        'vault.bogus("x")', // unsupported verb
        'capacity.bogus()', // unsupported verb
        'capacity.heatmap({ window: not-a-window })', // empty window
      ],
    })
    const m = new Map(r.map((e) => [e.src, e.value]))
    // ALL → null; the raw `_(… requires a type)_` / `_(verb … not
    // implemented)_` / `_(empty window …)_` strings are NEVER on the
    // wire (§5.2 precond 2 — the Codex P4 FAIL).
    for (const [, v] of m) expect(v).toBeNull()
    expect(r.length).toBe(5)
  })

  it('Independent P4: vault.find is a DIGEST (frontmatter stripped); _map.md excluded', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'logs/2025-07-14.md',
      body: '# July 14\nLogged {billable: 4.5} on Acme.',
      source: 'user',
    })
    await t.run(async (ctx) => {
      // a real `_map.md` — glob `*` would match it but the filter
      // must exclude the derived index.
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: '_map.md',
        body: '# Map\n- [[logs/2025-07-14.md]]',
        updatedAt: 1,
      })
    })
    const as = t.withIdentity({ subject: W })
    const r = await as.query(api.queries.evalQueryBlocks, {
      srcs: [
        'vault.find("logs/2025-07-14.md")',
        'vault.find("_map.md")', // derived index — not findable
        'vault.glob("*.md")', // matches _map.md by pattern — filter must drop it
      ],
    })
    const m = new Map(r.map((e) => [e.src, e.value]))
    const find = m.get('vault.find("logs/2025-07-14.md")') as string
    expect(find).not.toContain('---\nid:') // frontmatter stripped (digest)
    expect(find).toContain('# July 14') // the actual content shows
    expect(m.get('vault.find("_map.md")')).toBe('_(missing: _map.md)_')
    // `*.md` matches `_map.md` by pattern; the exclusion filter must
    // drop it ⇒ no matches (logs/… has a slash, `*` is single-seg).
    expect(m.get('vault.glob("*.md")')).toBe('_(no matches)_')
  })

  it('Codex P4-fold-2: a 40-line note + trailing newline is NOT falsely "truncated"; >40 IS', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      // exactly 40 content lines + a trailing \n (split ⇒ 41 elems,
      // last empty). Raw insert (no Phase-1 frontmatter) so the body
      // is exactly these 40 lines.
      const forty = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n')
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'forty.md', body: forty + '\n', updatedAt: 1,
      })
      const fifty = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n')
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'fifty.md', body: fifty, updatedAt: 1,
      })
    })
    const as = t.withIdentity({ subject: W })
    const r = await as.query(api.queries.evalQueryBlocks, {
      srcs: ['vault.find("forty.md")', 'vault.find("fifty.md")'],
    })
    const m = new Map(r.map((e) => [e.src, e.value as string]))
    expect(m.get('vault.find("forty.md")')).not.toContain('truncated') // honest
    expect(m.get('vault.find("forty.md")')).toContain('L40')
    expect(m.get('vault.find("fifty.md")')).toContain('truncated') // really is
  })

  it('Codex P4-fold: digestBody is ReDoS-safe on a pathological frontmatter prefix', async () => {
    const t = convexTest(schema, modules)
    // a leading `---\n` then a huge whitespace run with NO closing
    // fence — the exact catastrophic-backtracking input. Raw insert
    // (bypass Phase-1 seeding) to land that exact body.
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W,
        path: 'evil.md',
        body: '---\n' + ' \n'.repeat(40000) + 'tail',
        updatedAt: 1,
      })
    })
    const as = t.withIdentity({ subject: W })
    const t0 = Date.now()
    const r = await as.query(api.queries.evalQueryBlocks, {
      srcs: ['vault.find("evil.md")'],
    })
    expect(Date.now() - t0).toBeLessThan(500) // linear, not quadratic hang
    expect(typeof r[0].value === 'string').toBe(true) // resolved, didn't throw
  })
})
