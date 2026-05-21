import { describe, it, expect } from 'vitest'
import {
  parseInlineAtoms,
  parseInlineAtomsFromMarkdown,
} from './inlineAtom'

// Every row of the normative table in
// docs/strategy/inline-atom-format-v0.md must hold here.

describe('inline-atom v0 — value atoms', () => {
  it('parses a number in surrounding prose', () => {
    const t = 'Logged {hours: 6} on Acme.'
    const [a] = parseInlineAtoms(t)
    expect(a).toMatchObject({ kind: 'value', key: 'hours', value: 6, valueType: 'number' })
    // round-trip: raw is the exact source span
    expect(t.slice(a.start, a.end)).toBe(a.raw)
    expect(a.raw).toBe('{hours: 6}')
  })

  it('parses integers and decimals', () => {
    expect(parseInlineAtoms('{rate: 150}')[0]).toMatchObject({ value: 150, valueType: 'number' })
    expect(parseInlineAtoms('{rate: 150.5}')[0]).toMatchObject({ value: 150.5, valueType: 'number' })
    expect(parseInlineAtoms('{delta: -3}')[0]).toMatchObject({ value: -3, valueType: 'number' })
  })

  it('parses booleans and ISO dates', () => {
    expect(parseInlineAtoms('{billable: true}')[0]).toMatchObject({ value: true, valueType: 'boolean' })
    expect(parseInlineAtoms('{due: 2026-05-17}')[0]).toMatchObject({ value: '2026-05-17', valueType: 'date' })
  })

  it('parses bare and quoted strings', () => {
    expect(parseInlineAtoms('{client: Acme Corp}')[0]).toMatchObject({ value: 'Acme Corp', valueType: 'string' })
    expect(parseInlineAtoms('{note: "client was difficult"}')[0]).toMatchObject({
      value: 'client was difficult',
      valueType: 'string',
    })
  })

  it('honours \\} escaping inside a string value', () => {
    const [a] = parseInlineAtoms('{note: "tricky \\} case"}')
    expect(a).toMatchObject({ kind: 'value', key: 'note', value: 'tricky } case' })
  })
})

describe('inline-atom v0 — live totals', () => {
  it('parses a bare identifier as a non-authoritative projection', () => {
    const [a] = parseInlineAtoms('Team total: {billable_this_week}')
    expect(a).toMatchObject({ kind: 'liveTotal', key: 'billable_this_week' })
  })
})

describe('inline-atom v0 — non-match is literal, never an error', () => {
  it('ignores escaped braces', () => {
    expect(parseInlineAtoms('the set \\{1,2,3\\} is math')).toEqual([])
  })
  it('ignores nesting / structure entirely', () => {
    expect(parseInlineAtoms('{a: {b: 1}}')).toEqual([])
  })
  it('ignores empty, keyless, and valueless braces', () => {
    expect(parseInlineAtoms('{}')).toEqual([])
    expect(parseInlineAtoms('{ : 5}')).toEqual([])
    expect(parseInlineAtoms('{key:}')).toEqual([])
    expect(parseInlineAtoms('{1bad: 2}')).toEqual([]) // key must start [A-Za-z_]
  })
  it('never throws on adversarial input', () => {
    for (const s of ['{', '}', '{{{', '}}}', '{a:{', '{:}', '\\{', '{a: }{']) {
      expect(() => parseInlineAtoms(s)).not.toThrow()
    }
  })
})

describe('inline-atom v0 — round-trip + multiplicity', () => {
  it('finds every atom and each raw is byte-exact', () => {
    const t = 'Logged {hours: 6} at {rate: 150} for {client: Acme}.'
    const atoms = parseInlineAtoms(t)
    expect(atoms).toHaveLength(3)
    for (const a of atoms) expect(t.slice(a.start, a.end)).toBe(a.raw)
  })

  it('round-trips: re-emitting raw spans reconstructs the source exactly', () => {
    const t = 'A {x: 1} B {flag: false} C {total_due}.'
    const atoms = parseInlineAtoms(t)
    let rebuilt = ''
    let cursor = 0
    for (const a of atoms) {
      rebuilt += t.slice(cursor, a.start) + a.raw
      cursor = a.end
    }
    rebuilt += t.slice(cursor)
    expect(rebuilt).toBe(t) // the doc model is never transformed
  })
})

describe('inline-atom v0 — round-trip survives serializer escaping (C2)', () => {
  it('unescapes \\_ in a live-total key (the marquee shape)', () => {
    // what Milkdown/remark emits after a save of {billable_this_week}
    const [a] = parseInlineAtoms('Team total: {billable\\_this\\_week}')
    expect(a).toMatchObject({ kind: 'liveTotal', key: 'billable_this_week' })
  })
  it('unescapes \\_ and \\* inside a value (no stray backslashes)', () => {
    expect(parseInlineAtoms('{client: Acme\\_Corp}')[0]).toMatchObject({
      key: 'client',
      value: 'Acme_Corp',
      valueType: 'string',
    })
    expect(parseInlineAtoms('{note: 5 \\* 7}')[0]).toMatchObject({
      value: '5 * 7',
    })
  })
  it('escaped braces in PROSE remain literal (not atoms)', () => {
    expect(parseInlineAtoms('the set \\{1,2,3\\} is math')).toEqual([])
  })
})

describe('inline-atom v0 — structure is not an atom (Codex #3/#4)', () => {
  it('rejects array-looking values', () => {
    expect(parseInlineAtoms('{tags: [a,b]}')).toEqual([])
  })
  it('rejects an escaped brace inside the body', () => {
    // contract: only \\} (a literal } in a string) is exempt; a { in
    // the body — even escaped — means it is structure, not an atom
    expect(parseInlineAtoms('{note: "left \\{ brace"}')).toEqual([])
  })
})

describe('inline-atom v0 — code safety is the caller’s job', () => {
  // The parser is pure text; "code is verbatim" is enforced by the
  // editor scoping the parser to prose text nodes only. This test
  // documents that contract: at the raw-string level a code-looking
  // atom still parses, so the editor MUST NOT feed it code spans.
  it('parses an atom even if wrapped in backticks (caller must scope)', () => {
    expect(parseInlineAtoms('`{hours: 6}`')).toHaveLength(1)
  })
})

describe('parseInlineAtomsFromMarkdown — prose-only via real CommonMark parser', () => {
  const keys = (md: string) =>
    parseInlineAtomsFromMarkdown(md)
      .filter((a) => a.kind === 'value')
      .map((a) => `${a.key}=${(a as { value: unknown }).value}`)
      .sort()

  it('recognises atoms in ordinary prose / headings / lists / blockquote / emphasis-wrapped', () => {
    expect(keys('Logged {hours: 6} today.')).toEqual(['hours=6'])
    expect(keys('# {rate: 150}')).toEqual(['rate=150'])
    expect(keys('- item {n: 2}')).toEqual(['n=2'])
    expect(keys('> quote {q: 1}')).toEqual(['q=1'])
    expect(keys('**{bold: 9}**')).toEqual(['bold=9']) // whole atom inside emphasis
    expect(keys('[Logged {hours: 6}](http://e)')).toEqual(['hours=6']) // link LABEL is prose
  })

  it('excludes EVERY CommonMark code container (Codex MED — under-mask closed)', () => {
    expect(keys('`{hours: 6}`')).toEqual([]) // inline code
    expect(keys('``{hours: 6}``')).toEqual([]) // double-backtick inline
    expect(keys('```\n{hours: 6}\n```')).toEqual([]) // fenced
    expect(keys('~~~\n{hours: 6}\n~~~')).toEqual([]) // tilde fence
    expect(keys('> ~~~\n> {hours: 6}\n> ~~~')).toEqual([]) // blockquoted tilde fence
    expect(keys('- ```\n  {hours: 6}\n  ```')).toEqual([]) // list-nested fence
    expect(keys('    {hours: 6}')).toEqual([]) // 4-space indented code
    expect(keys('\t{hours: 6}')).toEqual([]) // tab indented code
  })

  it('does NOT fabricate an atom across inline nodes (Codex MED join bug)', () => {
    // emphasis inside the braces splits the run — must NOT become hours=6
    expect(keys('{hours: *6*}')).toEqual([])
    // a link inside the braces must NOT become note="x"
    expect(keys('{note: [x](http://e)}')).toEqual([])
  })

  it('autolink / bare URL is not prose (no atom from the URL)', () => {
    expect(keys('<http://example.com/{hours:6}>')).toEqual([])
  })

  it('fail-soft: never throws; junk input ⇒ no atoms', () => {
    expect(parseInlineAtomsFromMarkdown('')).toEqual([])
    expect(() => parseInlineAtomsFromMarkdown(']]({[(*_~`')).not.toThrow()
  })
})

// atom-address-v1 §2 — the `=`-sigil formula (PARSE-ONLY, Phase 2).
// v0 blocks above are byte-untouched; these only add v1 coverage.
describe('atom-address-v1 §2 — formula parsing', () => {
  const one = (t: string) => parseInlineAtoms(t)[0]
  // narrowed accessor for formula-only fields (predicate/src/fn)
  const f = (t: string) => {
    const a = parseInlineAtoms(t)[0]
    if (!a || a.kind !== 'formula') throw new Error(`not a formula: ${t}`)
    return a
  }

  it('bare address (no fn) — the value itself', () => {
    expect(one('Acme owes {= clients.acme.owed} now.')).toMatchObject({
      kind: 'formula',
      fn: null,
      address: 'clients.acme.owed',
      segments: ['clients', 'acme', 'owed'],
      predicate: null,
    })
  })

  it('each aggregate fn over a glob address', () => {
    expect(one('{= sum(log.*.billable)}')).toMatchObject({
      kind: 'formula', fn: 'sum', address: 'log.*.billable',
      segments: ['log', '*', 'billable'], predicate: null,
    })
    expect(one('{= latest(log.*.hours)}')).toMatchObject({ kind: 'formula', fn: 'latest' })
    expect(one('{= avg(p.*.score)}')).toMatchObject({ kind: 'formula', fn: 'avg' })
  })

  it('§2.2 date prefix-glob segment', () => {
    expect(one('{= sum(log.2025_07_*.billable)}')).toMatchObject({
      kind: 'formula', fn: 'sum', segments: ['log', '2025_07_*', 'billable'],
    })
  })

  it('predicate — space-separated AND `where`-prefixed both parse (doc reconciliation)', () => {
    expect(one('{= count(projects.* status = active)}')).toMatchObject({
      kind: 'formula', fn: 'count', address: 'projects.*',
      predicate: { key: 'status', op: '=', value: 'active' },
    })
    expect(one('{= sum(projects.*.budget where status=active)}')).toMatchObject({
      kind: 'formula', fn: 'sum', address: 'projects.*.budget',
      predicate: { key: 'status', op: '=', value: 'active' },
    })
    expect(f('{= count(t.* n >= 3)}').predicate).toEqual({ key: 'n', op: '>=', value: '3' })
    expect(f('{= count(t.* s != "x y")}').predicate).toEqual({ key: 's', op: '!=', value: 'x y' })
    // a quoted predicate value may contain parens — accepted
    // pre-fold; the ReDoS structural rewrite must not regress it
    expect(f('{= count(p.* note = "in (review)")}').predicate).toEqual({
      key: 'note', op: '=', value: 'in (review)',
    })
    // …but a real nested call is still rejected (§2.3) via validAddress
    expect(parseInlineAtoms('{= sum(avg(x))}')).toEqual([])
    expect(parseInlineAtoms('{= sum(avg(x) where k=1)}')).toEqual([])
  })

  it('§2.1 precedence — NO sigil ⇒ exactly v0 (zero manufactured slop)', () => {
    // these were not-atoms in v0 and MUST stay not-atoms
    expect(parseInlineAtoms('see {e.g} and {i.e.}')).toEqual([])
    expect(parseInlineAtoms('{sum(total)}')).toEqual([])
    expect(parseInlineAtoms('{a.b}')).toEqual([])
    // a value atom is still a value atom (frozen, unaffected)
    expect(one('{hours: 6}')).toMatchObject({ kind: 'value', key: 'hours', value: 6 })
    // a bare identifier is still kind:'liveTotal' (Codex #5 — kind
    // strings unchanged for v0)
    expect(one('{billable_total}')).toMatchObject({ kind: 'liveTotal', key: 'billable_total' })
  })

  it('malformed ⇒ not an atom (fail-soft, never throws)', () => {
    expect(parseInlineAtoms('{= }')).toEqual([])
    expect(parseInlineAtoms('{=}')).toEqual([])
    expect(parseInlineAtoms('{= sum(}')).toEqual([])
    expect(parseInlineAtoms('{= sum()}')).toEqual([])
    expect(parseInlineAtoms('{= !!}')).toEqual([])
    expect(parseInlineAtoms('{= notafn(a.b)}')).toEqual([])
    expect(parseInlineAtoms('{= a..b}')).toEqual([])
    expect(() => parseInlineAtoms('{= sum(((}')).not.toThrow()
  })

  it('ReDoS-safe: pathological unterminated call returns fast, never hangs (Codex P2)', () => {
    // The exact prior-FAIL class: `{= sum(<thousands of spaces>x}` —
    // the old backtracking CALL_RE took 2.1s @2k / >5s @4k. Linear
    // structural parsing must fail-soft in well under a frame.
    const evil = `{= sum(${' '.repeat(20000)}x}`
    const t0 = Date.now()
    expect(parseInlineAtoms(evil)).toEqual([]) // not an atom
    expect(Date.now() - t0).toBeLessThan(50)
    // also the length cap: an absurdly long but well-formed-looking
    // formula is fail-soft (not an atom), not a hang
    expect(parseInlineAtoms(`{= sum(a.${'b'.repeat(5000)})}`)).toEqual([])
  })

  it('raw span is the exact verbatim token (UC-3 source of truth)', () => {
    const t = 'x {= sum(log.*.billable)} y'
    const a = f(t)
    expect(t.slice(a.start, a.end)).toBe(a.raw)
    expect(a.raw).toBe('{= sum(log.*.billable)}')
    expect(a.src).toBe('sum(log.*.billable)')
  })

  it('prose-only: a formula inside a code fence is NOT parsed', () => {
    const md = 'text\n\n```\n{= sum(log.*.billable)}\n```\n'
    expect(parseInlineAtomsFromMarkdown(md).filter((x) => x.kind === 'formula')).toEqual([])
    expect(
      parseInlineAtomsFromMarkdown('Live: {= clients.acme.owed} ok')
        .some((x) => x.kind === 'formula'),
    ).toBe(true)
  })
})
