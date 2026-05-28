/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'
import {
  normalizeFileId,
  splitFrontmatter,
  joinFrontmatter,
  extractFrontmatterId,
  injectFrontmatterId,
  decideAtomIdAction,
  reconcileAtomIdIndex,
  isHtmlAtomBody,
  formulaConcreteFileId,
  injectFrontmatterTitle,
  extractLeadingH1,
} from './atomId'

// atom-address-v1 Track-1 Phase-1 exit criteria (a) + (b1).
// Design: docs/strategy/atom-address-v1.md §1.1–1.4 (gate CLEARED v4).

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_test'

const idRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('atomIds').collect()).filter(
      (r) => r.workspaceId === W,
    ),
  )
const idRow = async (t: ReturnType<typeof convexTest>, fileId: string) =>
  (await idRows(t)).find((r) => r.fileId === fileId) ?? null
const bodyAt = (t: ReturnType<typeof convexTest>, path: string) =>
  t.run(async (ctx) => {
    const r = (await ctx.db.query('atoms').collect()).find(
      (a) => a.workspaceId === W && a.path === path,
    )
    return r?.body ?? null
  })

// ── PURE: normalization ─────────────────────────────────────────────
describe('normalizeFileId', () => {
  it('drops extension, lowercases, / → ., date - → _', () => {
    expect(normalizeFileId('logs/2025-07-14.md')).toBe('logs.2025_07_14')
    expect(normalizeFileId('Me.md')).toBe('me')
    expect(normalizeFileId('a/B/c.MD')).toBe('a.b.c')
  })
  it('collapses runs, trims, never empty', () => {
    expect(normalizeFileId('clients/Acme  Corp!.md')).toBe('clients.acme_corp')
    expect(normalizeFileId('---.md')).toBe('_')
    expect(normalizeFileId('projects/àçñ.md')).toBe('projects._')
  })
  it('is deterministic (pure function of the path)', () => {
    expect(normalizeFileId('logs/2025-07-14.md')).toBe(
      normalizeFileId('logs/2025-07-14.md'),
    )
  })
})

// ── PURE: byte-exact frontmatter split/join (b1) ────────────────────
describe('splitFrontmatter / joinFrontmatter — byte identity', () => {
  const cases = [
    'no frontmatter at all\n\n# Title',
    '---\nid: log.x\n---\n# Title\n',
    '---\nid: log.x\nname: Foo\n---\n\nblank line above kept\n',
    '---\r\nid: w\r\n---\r\n# crlf\r\n',
    '---\ntitle: only\n---', // no trailing newline / no body
    '', // empty
  ]
  for (const src of cases) {
    it(`round-trips byte-identical: ${JSON.stringify(src.slice(0, 24))}…`, () => {
      const { fm, rest } = splitFrontmatter(src)
      expect(joinFrontmatter(fm, rest)).toBe(src) // exact bytes
    })
  }
  it('rest carries zero frontmatter glyphs (b1 acceptance)', () => {
    const { fm, rest } = splitFrontmatter('---\nid: a\n---\n# Body')
    expect(fm).toBe('---\nid: a\n---\n')
    expect(rest).toBe('# Body')
    expect(rest.includes('---')).toBe(false)
    expect(rest.includes('id:')).toBe(false)
  })
})

// ── PURE: extract / inject ──────────────────────────────────────────
describe('extractFrontmatterId / injectFrontmatterId', () => {
  it('reads bare, quoted, returns null when absent/empty', () => {
    expect(extractFrontmatterId('---\nid: log.a\n---\n')).toBe('log.a')
    expect(extractFrontmatterId('---\nid: "log.b"\n---\n')).toBe('log.b')
    expect(extractFrontmatterId("---\nid: 'log.c'\n---\n")).toBe('log.c')
    expect(extractFrontmatterId('---\nname: x\n---\n')).toBeNull()
    expect(extractFrontmatterId('---\nid:   \n---\n')).toBeNull()
    expect(extractFrontmatterId('no fm here')).toBeNull()
  })
  it('injects as first field preserving other bytes; round-trips', () => {
    const out = injectFrontmatterId('---\nname: Foo\n---\n# B', 'log.z')
    expect(out).toBe('---\nid: log.z\nname: Foo\n---\n# B')
    expect(extractFrontmatterId(out)).toBe('log.z')
  })
  it('prepends a block when there is no frontmatter', () => {
    const out = injectFrontmatterId('# Just body', 'k')
    expect(out).toBe('---\nid: k\n---\n# Just body')
    expect(extractFrontmatterId(out)).toBe('k')
  })
})

// ── PURE: the §1.3 decision table ───────────────────────────────────
describe('decideAtomIdAction — the §1.3 table', () => {
  const P = 'p.md'
  it('no row ⇒ insert', () => {
    expect(
      decideAtomIdAction({ row: null, thisPath: P, oldPathLive: false, isRestore: false }).kind,
    ).toBe('insert')
  })
  it('bound to this path ⇒ noop (idempotent)', () => {
    expect(
      decideAtomIdAction({ row: { state: 'bound', path: P }, thisPath: P, oldPathLive: false, isRestore: false }).kind,
    ).toBe('noop')
  })
  it('bound elsewhere + old path GONE ⇒ rename', () => {
    expect(
      decideAtomIdAction({ row: { state: 'bound', path: 'old.md' }, thisPath: P, oldPathLive: false, isRestore: false }).kind,
    ).toBe('rename')
  })
  it('bound elsewhere + old path LIVE ⇒ collision(copy)', () => {
    const a = decideAtomIdAction({ row: { state: 'bound', path: 'old.md' }, thisPath: P, oldPathLive: true, isRestore: false })
    expect(a).toEqual({ kind: 'collision', reason: 'copy' })
  })
  it('released + restore ⇒ resurrect', () => {
    expect(
      decideAtomIdAction({ row: { state: 'released', path: null }, thisPath: P, oldPathLive: false, isRestore: true }).kind,
    ).toBe('resurrect')
  })
  it('released + ordinary write ⇒ collision(released) — silent-hijack-NEVER', () => {
    const a = decideAtomIdAction({ row: { state: 'released', path: null }, thisPath: P, oldPathLive: false, isRestore: false })
    expect(a).toEqual({ kind: 'collision', reason: 'released' })
  })
})

// ── BEHAVIOR (a): seed / rename / copy / tombstone / restore ────────
describe('Phase-1 exit (a) — rename-proof index behaviour', () => {
  it('seeds an id on create and binds the index', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W,
      path: 'logs/2025-07-14.md',
      body: '# Mon\n{billable: 4}',
      source: 'user',
    })
    expect(extractFrontmatterId((await bodyAt(t, 'logs/2025-07-14.md')) ?? '')).toBe(
      'logs.2025_07_14',
    )
    const row = await idRow(t, 'logs.2025_07_14')
    expect(row?.state).toBe('bound')
    expect(row?.path).toBe('logs/2025-07-14.md')
  })

  it('RENAME (move sequence): id stays, index rebinds, ref survives', async () => {
    const t = convexTest(schema, modules)
    const body = '---\nid: clients.acme\n---\n{owed: 500}'
    // create at the old path
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'a.md', body, updatedAt: 1 })
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'clients.acme', path: 'a.md', state: 'bound' })
    })
    // exact `move` ordering: insert new, THEN delete old, THEN reconcile
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'b.md', body, updatedAt: 2 })
      const old = (await ctx.db.query('atoms').collect()).find((r) => r.path === 'a.md')!
      await ctx.db.delete(old._id)
      const action = await reconcileAtomIdIndex(ctx, W, 'b.md', body, { isRestore: false })
      expect(action.kind).toBe('rename')
    })
    const row = await idRow(t, 'clients.acme')
    expect(row?.state).toBe('bound')
    expect(row?.path).toBe('b.md') // reference (id-based) survives the rename
  })

  it('COPY (old path still live) ⇒ loud collision, NOT rebound, NO inherit', async () => {
    const t = convexTest(schema, modules)
    const body = '---\nid: clients.acme\n---\nx'
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'a.md', body, updatedAt: 1 })
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'clients.acme', path: 'a.md', state: 'bound' })
      // a COPY: second live atom hand-carrying the same id
      await ctx.db.insert('atoms', { workspaceId: W, path: 'copy.md', body, updatedAt: 2 })
      const action = await reconcileAtomIdIndex(ctx, W, 'copy.md', body, { isRestore: false })
      expect(action).toEqual({ kind: 'collision', reason: 'copy' })
    })
    const row = await idRow(t, 'clients.acme')
    expect(row?.path).toBe('a.md') // original keeps the id — no hijack
    expect((await idRows(t)).length).toBe(1) // copy got NO index row
  })

  it('D4.14 — DELETE fully RELEASES the id (row removed); same-name recreate reclaims the clean id', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'note.md', body: '# n', source: 'user',
    })
    const fid = extractFrontmatterId((await bodyAt(t, 'note.md'))!)!
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'note.md' })
    // D4.14 — the index row is GONE (not tombstoned), so the id is free.
    expect(await idRow(t, fid)).toBeNull()
    // Recreate at the same path → reclaims the SAME clean id (no `_2`).
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'note.md', body: '# again', source: 'user',
    })
    expect(extractFrontmatterId((await bodyAt(t, 'note.md'))!)).toBe(fid)
  })

  it('RESTORE-from-trash re-establishes the id at the same path', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'r.md', body: '# r', source: 'user',
    })
    const fid = extractFrontmatterId((await bodyAt(t, 'r.md'))!)!
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'r.md' })
    const tr = await t.run(async (ctx) =>
      (await ctx.db.query('trash').collect()).filter((x) => x.workspaceId === W),
    )
    await t.mutation(internal.trash._restore, { workspaceId: W, trashId: tr[0]._id })
    // D4.14 — restore re-inserts the body (frozen id) → reconcile re-binds.
    const row = await idRow(t, fid)
    expect(row?.state).toBe('bound')
    expect(row?.path).toBe('r.md') // same logical file, address restored
  })

  it('D4.14 — a released (deleted) id is REUSABLE by a recreate (no permanent tombstone)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'x.md', body: '# x', source: 'user',
    })
    const fid = extractFrontmatterId((await bodyAt(t, 'x.md'))!)!
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'x.md' })
    // The id is free — a new file hand-carrying it binds cleanly
    // (insert, NOT a 'released' collision). User-chosen tradeoff:
    // a deleted name is reusable; a stale ref re-points to the new
    // file rather than rendering `—` forever.
    await t.run(async (ctx) => {
      const body = `---\nid: ${fid}\n---\nNEW`
      await ctx.db.insert('atoms', { workspaceId: W, path: 'reuse.md', body, updatedAt: 9 })
      const action = await reconcileAtomIdIndex(ctx, W, 'reuse.md', body, { isRestore: false })
      expect(action.kind).toBe('insert')
    })
    const row = await idRow(t, fid)
    expect(row?.state).toBe('bound')
    expect(row?.path).toBe('reuse.md')
  })

  it('deterministic _2 suffix on a normalization collision', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/a b.md', body: 'one', source: 'user',
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/a-b.md', body: 'two', source: 'user',
    })
    expect(extractFrontmatterId((await bodyAt(t, 'logs/a b.md'))!)).toBe('logs.a_b')
    expect(extractFrontmatterId((await bodyAt(t, 'logs/a-b.md'))!)).toBe('logs.a_b_2')
  })

  it('re-saving an addressed file that dropped its frontmatter re-injects its OWN id', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'keep.md', body: '# keep', source: 'user',
    })
    const fid = extractFrontmatterId((await bodyAt(t, 'keep.md'))!)!
    // agent rewrites the whole file WITHOUT frontmatter
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'keep.md', body: 'rewritten no fm', source: 'agent',
      allowUserOverwrite: true,
    })
    expect(extractFrontmatterId((await bodyAt(t, 'keep.md'))!)).toBe(fid) // same id, stable
    expect((await idRows(t)).filter((r) => r.fileId === fid).length).toBe(1)
  })
})

// ── FOLD A (Codex P1-build dispositive): id CHANGE frees the stale
//    path-owner — no double-binding, no .unique() throw. D4.24: the
//    stale old-id row is DELETED (not tombstoned), so the old id is
//    reusable — typing an id away then back rebinds cleanly. ──────
describe('Phase-1 fold A — id change (b2 hand-edit) is clean', () => {
  it('changing the frontmatter id frees the old id (row deleted), binds the new, ≤1 bound/path', async () => {
    const t = convexTest(schema, modules)
    // seed: no fm ⇒ id "p"
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'p.md', body: '# p', source: 'user',
    })
    expect(extractFrontmatterId((await bodyAt(t, 'p.md'))!)).toBe('p')
    // user hand-edits the id (via ⟨⟩ source) to a NEW non-empty id
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'p.md', body: '---\nid: renamed\n---\n# p',
      source: 'user', allowUserOverwrite: true,
    })
    const rows = await idRows(t)
    const old = rows.find((r) => r.fileId === 'p')
    const neu = rows.find((r) => r.fileId === 'renamed')
    expect(old).toBeUndefined() // D4.24 — old id row DELETED (freed), not tombstoned
    expect(neu?.state).toBe('bound')
    expect(neu?.path).toBe('p.md')
    // invariant: exactly ONE bound row for this path
    expect(rows.filter((r) => r.state === 'bound' && r.path === 'p.md').length).toBe(1)
    // a later fm-dropping save must NOT throw and must re-inject the
    // CURRENT id ("renamed"), not mint a fresh one
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'p.md', body: 'no fm now',
      source: 'agent', allowUserOverwrite: true,
    })
    expect(extractFrontmatterId((await bodyAt(t, 'p.md'))!)).toBe('renamed')
    expect((await idRows(t)).filter((r) => r.state === 'bound' && r.path === 'p.md').length).toBe(1)
  })

  it('D4.24 — id changed AWAY then BACK rebinds cleanly (no phantom collision)', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'h.md', body: '---\nid: hello\n---\nx', source: 'user',
    })
    // change the id away…
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'h.md', body: '---\nid: hell\n---\nx',
      source: 'user', allowUserOverwrite: true,
    })
    // …then BACK to the original. Pre-D4.24 the freed id was a dead
    // `released` tombstone → this rebind was blocked → phantom
    // collision. Now the old id was DELETED, so it rebinds.
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'h.md', body: '---\nid: hello\n---\nx',
      source: 'user', allowUserOverwrite: true,
    })
    const adv = await as.query(api.atoms.idAdvisory, { path: 'h.md' })
    expect(adv.kind).toBeNull() // no phantom collision
    const rows = await idRows(t)
    const bound = rows.find((r) => r.fileId === 'hello')
    expect(bound?.state).toBe('bound')
    expect(bound?.path).toBe('h.md')
    // the intermediate id is fully gone (freed)
    expect(rows.find((r) => r.fileId === 'hell')).toBeUndefined()
  })
})

// ── FOLD B (Independent P1-build dispositive): the §1.4 advisory ──
describe('Phase-1 fold B — idAdvisory surfacing (required, not best-effort)', () => {
  it('reports suffixed / collision / null correctly (owner-scoped)', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    // clean file ⇒ no advisory
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'clean.md', body: '# c', source: 'user',
    })
    expect((await as.query(api.atoms.idAdvisory, { path: 'clean.md' })).kind).toBeNull()
    // two paths normalizing to the same id ⇒ 2nd is auto-suffixed
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/a b.md', body: '1', source: 'user',
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/a-b.md', body: '2', source: 'user',
    })
    const sfx = await as.query(api.atoms.idAdvisory, { path: 'logs/a-b.md' })
    expect(sfx).toEqual({ kind: 'suffixed', fileId: 'logs.a_b_2', wanted: 'logs.a_b' })
    // a hand-authored duplicate id (collision) ⇒ refs broken, flagged
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', { workspaceId: W, path: 'dup.md', body: '---\nid: logs.a_b\n---\nX', updatedAt: 9 })
    })
    const col = await as.query(api.atoms.idAdvisory, { path: 'dup.md' })
    expect(col.kind).toBe('collision')
    expect(col.fileId).toBe('logs.a_b')
  })
})

// html-atoms-v1 §6 Track-2 P1 — the predicate + the enumerated
// value-scan skips (html is a VIEW, never a value-atom source).
describe('isHtmlAtomBody — pure (parallels MAP_PATH discipline)', () => {
  it('true for frontmatter type: html (bare / quoted / spaced / id-seeded)', () => {
    expect(isHtmlAtomBody('---\ntype: html\n---\n<h1>x</h1>')).toBe(true)
    expect(isHtmlAtomBody('---\ntype: "html"\n---\n<x/>')).toBe(true)
    expect(isHtmlAtomBody("---\ntype:'html'\n---\n<x/>")).toBe(true)
    expect(isHtmlAtomBody('---\ntype:   html\n---\n<x/>')).toBe(true)
    // a Phase-1-seeded html atom (id: line alongside type:) still true
    expect(
      isHtmlAtomBody('---\ntype: html\nid: report\n---\n<x/>'),
    ).toBe(true)
  })
  it('false for non-html / no-frontmatter / near-miss', () => {
    expect(isHtmlAtomBody('---\ntype: action\n---\nx')).toBe(false)
    expect(isHtmlAtomBody('---\nid: a\n---\n# md note')).toBe(false)
    expect(isHtmlAtomBody('# just markdown {hours: 6}')).toBe(false)
    expect(isHtmlAtomBody('---\ntype: htmlx\n---\nx')).toBe(false)
    expect(isHtmlAtomBody('not a {type: html} atom')).toBe(false) // inline, not fm
    expect(isHtmlAtomBody('')).toBe(false)
  })
  it('ReDoS-safe: leading --- + huge whitespace, no close ⇒ fast false', () => {
    const evil = '---\n' + ' \n'.repeat(40000) + 'type: html'
    const t0 = Date.now()
    expect(isHtmlAtomBody(evil)).toBe(false) // no closing fence ⇒ no fm
    expect(Date.now() - t0).toBeLessThan(50) // splitFrontmatter guard
  })
})

describe('§6 end-to-end — an html atom is NOT a value-atom source', () => {
  it('formulaEval (data plane): html-atom {k:v} excluded from {= sum}', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/2025-07-01.md',
      body: '# Mon\n{billable: 4}', source: 'user',
    })
    // an HTML atom that *also* contains a {billable: 999} token —
    // must NOT contribute to the sum (it is a view, not data).
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/dashboard.md',
      body: '---\ntype: html\n---\n<p>{billable: 999}</p>', source: 'user',
    })
    const as = t.withIdentity({ subject: W })
    const r = await as.query(api.formulaEval.evalFormulas, {
      srcs: ['sum(logs.*.billable)'],
    })
    expect(new Map(r.map((e) => [e.src, e.value])).get('sum(logs.*.billable)'))
      .toBe(4) // 4 only — the html atom's 999 is excluded
  })

  it('atomCapture (write chokepoint / cross-desk transitive): html write records NO captures', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'report.md',
      body: '---\ntype: html\n---\n<p>{owed: 5000} {client: Acme}</p>',
      source: 'user',
    })
    const caps = await t.run(async (ctx) =>
      (await ctx.db.query('captures').collect()).filter(
        (c) => c.workspaceId === W,
      ),
    )
    expect(caps.length).toBe(0) // no phantom captures ⇒ nothing can cross
  })
})

// ── D4.25 — tombstone-while-referenced (the silent-hijack fix) ──────
// Pure: which exact fileId (if any) does a formula CONCRETELY name?
// Only concrete (no-`*`, exact-segment) references create a reuse-
// hijack risk; globs / all-match aggregates re-include files
// correctly so they don't.
describe('formulaConcreteFileId', () => {
  const f = (
    fn: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'latest' | null,
    segments: string[],
  ) => ({ fn, segments })

  it('bare address names the file (all-but-last seg)', () => {
    expect(formulaConcreteFileId(f(null, ['clients', 'acme', 'owed']))).toBe(
      'clients.acme',
    )
  })
  it('aggregate over a concrete file → that fileId', () => {
    expect(
      formulaConcreteFileId(f('sum', ['clients', 'acme', 'billable'])),
    ).toBe('clients.acme')
  })
  it('count uses the WHOLE address as the file glob', () => {
    expect(formulaConcreteFileId(f('count', ['projects', 'acme']))).toBe(
      'projects.acme',
    )
  })
  it('a `*` glob is NOT a concrete reference', () => {
    expect(
      formulaConcreteFileId(f('sum', ['logs', '2025_07_*', 'billable'])),
    ).toBeNull()
    expect(formulaConcreteFileId(f('count', ['projects', '*']))).toBeNull()
  })
  it('an empty/all-match glob is NOT a concrete reference', () => {
    expect(formulaConcreteFileId(f('sum', ['billable']))).toBeNull()
  })
  it('empty segments → null', () => {
    expect(formulaConcreteFileId(f(null, []))).toBeNull()
  })
})

// ── D4.25 — tombstone-while-referenced INTEGRATION ──────────────────
describe('D4.25 — delete/id-change tombstones a referenced id, frees an unreferenced one', () => {
  it('delete a REFERENCED file → id TOMBSTONED; recreate is suffixed (no hijack)', async () => {
    const t = convexTest(schema, modules)
    // alpha.md (id alpha) + ref.md with a concrete formula {= alpha.x}
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'alpha.md', body: '---\nid: alpha\n---\n{x: 5}', source: 'user',
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'ref.md', body: 'Owed: {= alpha.x }', source: 'user',
    })
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'alpha.md' })
    // referenced → tombstoned, NOT deleted
    const row = await idRow(t, 'alpha')
    expect(row?.state).toBe('released')
    expect(row?.path).toBeNull()
    // recreate at alpha.md → suffixed (alpha is taken/tombstoned) → no hijack
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'alpha.md', body: '{x: 999}', source: 'user',
    })
    expect(extractFrontmatterId((await bodyAt(t, 'alpha.md')) ?? '')).toBe('alpha_2')
  })

  it('delete an UNREFERENCED file → id FREED (row deleted); recreate reclaims it', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'beta.md', body: '---\nid: beta\n---\n{x: 5}', source: 'user',
    })
    // a glob formula somewhere — must NOT pin beta (it re-includes correctly)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'ref.md', body: '{= sum(beta_*.x) }', source: 'user',
    })
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'beta.md' })
    expect(await idRow(t, 'beta')).toBeNull() // freed
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'beta.md', body: '{x: 9}', source: 'user',
    })
    expect(extractFrontmatterId((await bodyAt(t, 'beta.md')) ?? '')).toBe('beta') // clean
  })

  it('id-change away from a REFERENCED id → old id tombstoned', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'note.md', body: '---\nid: gamma\n---\n{x: 1}', source: 'user',
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'ref.md', body: '{= gamma.x }', source: 'user',
    })
    // change note.md's id away from gamma
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'note.md', body: '---\nid: delta\n---\n{x: 1}',
      source: 'user', allowUserOverwrite: true,
    })
    const old = await idRow(t, 'gamma')
    expect(old?.state).toBe('released') // referenced → tombstoned, not freed
  })
})

// ── D4.26 — reconcile/release degrade on a corrupt double-row ────────
describe('D4.26 — index ops never throw on a duplicate (ws,fileId) row', () => {
  it('reconcile picks the bound row instead of .unique()-throwing', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'd.md', body: '---\nid: dup\n---\nx', updatedAt: 1,
      })
      // CORRUPTION: two bound rows for the same (ws,fileId)
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'dup', path: 'd.md', state: 'bound' })
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'dup', path: 'd.md', state: 'bound' })
    })
    // must NOT throw (was: .unique() throws on 2 rows, killing the write)
    const action = await t.run(async (ctx) =>
      reconcileAtomIdIndex(ctx, W, 'd.md', '---\nid: dup\n---\nx', { isRestore: false }),
    )
    expect(action.kind).toBe('noop') // bound to this path already
  })

  it('release-on-delete does not throw on a duplicate row', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'e.md', body: '---\nid: dd\n---\nx', source: 'user',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'dd', path: 'e.md', state: 'bound' })
    })
    // delete must not throw despite the dup row
    await t.mutation(internal.atoms._removeInternal, { workspaceId: W, path: 'e.md' })
    expect(true).toBe(true)
  })
})

// ── D4.27 — index verifier/repair + defensive read ──────────────────
describe('D4.27 — verifyAndRepairAtomIds rebuilds from bodies', () => {
  it('drops orphan/stale/double rows + binds each body id', async () => {
    const t = convexTest(schema, modules)
    // real atom with body id 'real'
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'r.md', body: '---\nid: real\n---\nx', updatedAt: 1,
      })
      // CORRUPT index: orphan released, stale bound to wrong fileId,
      // a double — and crucially NO correct bound 'real' row.
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'ghost', path: null, state: 'released' })
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'wrong', path: 'r.md', state: 'bound' })
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'wrong', path: 'r.md', state: 'bound' })
    })
    const res = await t.mutation(internal.atoms.verifyAndRepairAtomIds, { workspaceId: W })
    expect(res.deleted).toBe(3)
    expect(res.bound).toBe(1)
    const rows = await idRows(t)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ fileId: 'real', path: 'r.md', state: 'bound' })
  })
})

describe('D4.27 — formula resolution distrusts a stale index (defensive read)', () => {
  it('skips an atom whose body id mismatches the index fileId', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    // body claims id 'real' with {x: 5}; index BINDS the path to 'fake'
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'm.md', body: '---\nid: real\n---\n{x: 5}', updatedAt: 1,
      })
      await ctx.db.insert('atomIds', { workspaceId: W, fileId: 'fake', path: 'm.md', state: 'bound' })
    })
    // a formula referencing the INDEX id 'fake' must NOT inherit m.md's
    // value (the body says 'real', not 'fake') → fail-soft to null.
    const rows = await as.query(api.formulaEval.evalFormulas, { srcs: ['fake.x'] })
    expect(rows[0]?.value).toBeNull()
  })
})

// ── D4.29 — legacy body-H1 → frontmatter title (pure + migration) ───
describe('injectFrontmatterTitle / extractLeadingH1', () => {
  it('extracts a leading # H1 + strips it (and one blank line)', () => {
    expect(extractLeadingH1('# Dashboard\n\nbody')).toEqual({
      title: 'Dashboard',
      bodyWithoutH1: 'body',
    })
  })
  it('returns null when content does not start with #', () => {
    expect(extractLeadingH1('intro\n# later')).toBeNull()
  })
  it('adds title after id, preserving other fm + body', () => {
    expect(injectFrontmatterTitle('---\nid: x\n---\nbody', 'My Page')).toBe(
      '---\nid: x\ntitle: My Page\n---\nbody',
    )
  })
  it('replaces an existing title', () => {
    expect(injectFrontmatterTitle('---\nid: x\ntitle: Old\n---\nb', 'New')).toBe(
      '---\nid: x\ntitle: New\n---\nb',
    )
  })
  it('quotes a colon-bearing title', () => {
    expect(injectFrontmatterTitle('---\nid: x\n---\nb', 'a: b')).toBe(
      '---\nid: x\ntitle: "a: b"\n---\nb',
    )
  })
})

describe('D4.29 — migrateBodyTitlesToFrontmatter', () => {
  it('lifts a legacy body # H1 into title: and strips the body H1', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'dash.md', body: '---\nid: dash\n---\n# Dashboard\n\nlive numbers', updatedAt: 1,
      })
    })
    const res = await t.mutation(internal.atoms.migrateBodyTitlesToFrontmatter, { workspaceId: W })
    expect(res.migrated).toBe(1)
    const body = (await bodyAt(t, 'dash.md')) ?? ''
    expect(body).toContain('title: Dashboard')
    expect(body).not.toContain('# Dashboard') // de-duplicated
    expect(body).toContain('live numbers')
  })

  it('de-dups a page that has BOTH title: and a body # H1', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'h.md', body: '---\nid: h\ntitle: Hello\n---\n# Hello\nx', updatedAt: 1,
      })
    })
    const res = await t.mutation(internal.atoms.migrateBodyTitlesToFrontmatter, { workspaceId: W })
    expect(res.deduped).toBe(1)
    const body = (await bodyAt(t, 'h.md')) ?? ''
    expect(body).not.toContain('# Hello')
    expect(body).toContain('title: Hello')
  })

  it('leaves an html atom (.html path) untouched', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'p.html', body: '---\nid: p\n---\n# Heading in html', updatedAt: 1,
      })
    })
    await t.mutation(internal.atoms.migrateBodyTitlesToFrontmatter, { workspaceId: W })
    expect((await bodyAt(t, 'p.html')) ?? '').toContain('# Heading in html')
  })
})
