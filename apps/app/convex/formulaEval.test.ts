/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { internal, api } from './_generated/api'
import { parseInlineAtoms, type InlineAtom } from './inlineAtom'
import {
  evaluateFormula,
  type FormulaStore,
  type FileRec,
} from './formulaEval'

// atom-address-v1 §3 Phase-3 (3A) — evaluator. Pure core first
// (exhaustive), then end-to-end through the real single-pass query.

type Formula = Extract<InlineAtom, { kind: 'formula' }>
const F = (tok: string): Formula => {
  const a = parseInlineAtoms(tok)[0]
  if (!a || a.kind !== 'formula') throw new Error(`not a formula: ${tok}`)
  return a
}
const mkStore = (
  files: Array<{ fileId: string; kv: Record<string, Array<number | string | boolean>> }>,
): FormulaStore => ({
  files: files.map(
    (f): FileRec => ({
      fileId: f.fileId,
      segs: f.fileId.split('.'),
      byKey: new Map(Object.entries(f.kv)),
    }),
  ),
})

describe('evaluateFormula — pure core (§3/§4 fail-soft)', () => {
  const store = mkStore([
    { fileId: 'log.2025_07_01', kv: { billable: [4], hours: [6] } },
    { fileId: 'log.2025_07_14', kv: { billable: [4.5], hours: [8] } },
    { fileId: 'log.2025_08_02', kv: { billable: [2], hours: [3] } },
    { fileId: 'projects.acme', kv: { status: ['active'], budget: [8000] } },
    { fileId: 'projects.beta', kv: { status: ['done'], budget: [1000] } },
    { fileId: 'clients.acme', kv: { owed: [4500] } },
  ])

  it('sum over a glob; avg/min/max', () => {
    expect(evaluateFormula(F('{= sum(log.*.billable)}'), store)).toBe(10.5)
    expect(evaluateFormula(F('{= avg(log.*.hours)}'), store)).toBeCloseTo(17 / 3)
    expect(evaluateFormula(F('{= min(log.*.billable)}'), store)).toBe(2)
    expect(evaluateFormula(F('{= max(projects.*.budget)}'), store)).toBe(8000)
  })

  it('§2.2 date prefix-glob scopes the window', () => {
    expect(evaluateFormula(F('{= sum(log.2025_07_*.billable)}'), store)).toBe(8.5)
    expect(evaluateFormula(F('{= sum(log.2025_08_*.billable)}'), store)).toBe(2)
  })

  it('count = matched files; 0 is a real answer (not null)', () => {
    expect(evaluateFormula(F('{= count(log.*)}'), store)).toBe(3)
    expect(evaluateFormula(F('{= count(nope.*)}'), store)).toBe(0)
  })

  it('predicate filters; space- and where-forms; ordered ops numeric-only', () => {
    expect(evaluateFormula(F('{= count(projects.* status = active)}'), store)).toBe(1)
    expect(
      evaluateFormula(F('{= sum(projects.*.budget where status=active)}'), store),
    ).toBe(8000)
    expect(evaluateFormula(F('{= count(projects.* budget >= 5000)}'), store)).toBe(1)
    expect(evaluateFormula(F('{= count(projects.* status != active)}'), store)).toBe(1)
  })

  it('bare address names ONE value: 1⇒value, 0/>1⇒null', () => {
    expect(evaluateFormula(F('{= clients.acme.owed}'), store)).toBe(4500)
    expect(evaluateFormula(F('{= clients.acme.nope}'), store)).toBeNull()
    expect(evaluateFormula(F('{= log.*.billable}'), store)).toBeNull() // ambiguous
  })

  it('empty fileId glob ⇒ ALL files', () => {
    expect(evaluateFormula(F('{= sum(billable)}'), store)).toBe(10.5)
  })

  it('latest = value from the lexicographically-greatest fileId', () => {
    expect(evaluateFormula(F('{= latest(log.*.billable)}'), store)).toBe(2) // 2025_08_02
    expect(evaluateFormula(F('{= latest(log.2025_07_*.hours)}'), store)).toBe(8) // 07_14
  })

  it('fail-soft: 0 numeric operands ⇒ null (never authoritative 0)', () => {
    const s = mkStore([{ fileId: 'a.b', kv: { k: ['notnum'] } }])
    expect(evaluateFormula(F('{= sum(a.b.k)}'), s)).toBeNull()
    expect(evaluateFormula(F('{= avg(a.b.k)}'), s)).toBeNull()
    expect(evaluateFormula(F('{= max(a.b.k)}'), s)).toBeNull()
    // strings are NOT coerced (FROZEN): {k:"6"} never sums as 6
    const s2 = mkStore([{ fileId: 'a.b', kv: { k: ['6'] } }])
    expect(evaluateFormula(F('{= sum(a.b.k)}'), s2)).toBeNull()
  })

  it('* is single-segment (not **); seg count must match', () => {
    const s = mkStore([
      { fileId: 'log.a', kv: { x: [1] } },
      { fileId: 'log.a.b', kv: { x: [99] } }, // 3 segs — NOT matched by log.*
    ])
    expect(evaluateFormula(F('{= sum(log.*.x)}'), s)).toBe(1)
  })

  it('type preserved for a single bare value (string/number)', () => {
    const s = mkStore([{ fileId: 'c.x', kv: { name: ['Acme'], n: [7] } }])
    expect(evaluateFormula(F('{= c.x.name}'), s)).toBe('Acme')
    expect(evaluateFormula(F('{= c.x.n}'), s)).toBe(7)
  })
})

describe('evalFormulas — end-to-end single-pass query', () => {
  const W = 'ws_test'
  const modules = import.meta.glob('./**/*.ts')

  it('resolves a PLURAL collection path (the 3C `logs.` not `log.` trap); collision excluded; owner-scoped', async () => {
    const t = convexTest(schema, modules)
    // PLURAL `logs/` — Phase-1 seeds `logs.2025_07_01` (NOT
    // singularized). The 3C prompt now teaches `logs.…`; this is the
    // exact make-or-break dashboard scenario (independent BLOCKER).
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/2025-07-01.md', body: '# Mon\n{billable: 4}', source: 'user',
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'logs/2025-07-02.md', body: '# Tue\n{billable: 5}', source: 'user',
    })
    await t.mutation(internal.atoms._upsertInternal, {
      workspaceId: W, path: 'clients/acme.md', body: '{owed: 4500}', source: 'user',
    })
    // a COLLISION dup hand-carrying clients.acme's id — must NOT
    // contribute (its refs are `—`, §1.3)
    await t.run(async (ctx) => {
      await ctx.db.insert('atoms', {
        workspaceId: W, path: 'evil.md',
        body: '---\nid: clients.acme\n---\n{owed: 999999}', updatedAt: 9,
      })
    })
    const as = t.withIdentity({ subject: W })
    // srcs are the CANONICAL post-`=` exprs (what the editor sends);
    // the query returns an ARRAY (Codex P3-fold: never an object
    // keyed by author-influenceable src).
    const r = await as.query(api.formulaEval.evalFormulas, {
      srcs: [
        'sum(logs.2025_07_*.billable)', // the prompt's exact shape
        'clients.acme.owed',
        'count(logs.*)',
        'sum(nope.*.x)',
        'not a formula',
        'sum(', // malformed
      ],
    })
    const m = new Map(r.map((e) => [e.src, e.value]))
    expect(m.get('sum(logs.2025_07_*.billable)')).toBe(9) // NOT a dead —
    expect(m.get('clients.acme.owed')).toBe(4500) // NOT 999999
    expect(m.get('count(logs.*)')).toBe(2)
    expect(m.get('sum(nope.*.x)')).toBeNull()
    expect(m.get('not a formula')).toBeNull()
    expect(m.get('sum(')).toBeNull()
  })

  it('Codex P3-fold regression: prototype-poison / _-leading src does NOT throw the query', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    // `__proto__` (object-key poison) and `_map.x` (a Convex object
    // field can't start with `_` → would throw the WHOLE query if the
    // return were keyed by src). Array return ⇒ safe; never-throws +
    // every src still gets its own element (value null).
    const r = await as.query(api.formulaEval.evalFormulas, {
      srcs: ['__proto__', 'constructor', '_map.x', 'sum(_secret.k)'],
    })
    const m = new Map(r.map((e) => [e.src, e.value]))
    expect(r.length).toBe(4)
    expect(m.get('__proto__')).toBeNull()
    expect(m.get('constructor')).toBeNull()
    expect(m.get('_map.x')).toBeNull()
    expect(m.get('sum(_secret.k)')).toBeNull()
  })

  it('BLOCKER regression: serializer-escaped markdown yields the SAME canonical src key', () => {
    // a legacy editor reserialized `_`/`*` escaped. The query side parses the
    // ESCAPED markdown; the widget parses the UNESCAPED doc text.
    // Both MUST produce the identical `.src` or the chip vanishes.
    const escaped = 'July: {= sum(logs.2025\\_07\\_\\*.billable)}'
    const plain = 'July: {= sum(logs.2025_07_*.billable)}'
    const fromEscaped = parseInlineAtoms(escaped).find((a) => a.kind === 'formula')
    const fromPlain = parseInlineAtoms(plain).find((a) => a.kind === 'formula')
    expect(fromEscaped && 'src' in fromEscaped ? fromEscaped.src : 'X').toBe(
      'sum(logs.2025_07_*.billable)',
    )
    expect((fromEscaped as { src: string }).src).toBe(
      (fromPlain as { src: string }).src,
    ) // ⇒ identical query/widget key, escape-invariant
  })

  it('is reactive-query shaped: deduped, capped, never throws on junk', async () => {
    const t = convexTest(schema, modules)
    const as = t.withIdentity({ subject: W })
    const many = Array.from({ length: 200 }, (_, i) => `sum(a${i}.*.x)`)
    const r = await as.query(api.formulaEval.evalFormulas, {
      srcs: [...many, 'sum(a0.*.x)'],
    })
    // ≤64 distinct evaluated; all fail-soft null (empty vault)
    expect(r.length).toBeLessThanOrEqual(64)
    expect(r.every((e) => e.value === null)).toBe(true)
  })
})
