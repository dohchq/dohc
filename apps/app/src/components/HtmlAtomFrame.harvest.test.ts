// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { harvestFormulaSrcs } from './HtmlAtomFrame'
import { ATOM_BODY_MAX_BYTES } from '../lib/inlineAtom'

// html-atoms-v1 §3 + P3 dual-review folds (FAIL-1 unbounded /
// FAIL-3 wrong-parser): the `{= }` harvest must walk REAL HTML text
// nodes (a Markdown parser misses `<div>{=…}</div>`), NEVER
// attributes, skip code/style/script, and be byte-bounded.

describe('harvestFormulaSrcs — HTML-correct, text-nodes-only, bounded', () => {
  it('FAIL-3: finds a formula in real HTML ELEMENT content', () => {
    expect(harvestFormulaSrcs('<div>{= clients.acme.owed}</div>')).toEqual([
      'clients.acme.owed',
    ])
  })

  it('finds formulas across nested elements; de-duplicates', () => {
    const r = harvestFormulaSrcs(
      '<section><h1>Q3</h1><p>July {= sum(logs.*.billable)}</p>' +
        '<span>{= count(projects.*)}</span><i>{= sum(logs.*.billable)}</i></section>',
    )
    expect(r.sort()).toEqual(
      ['count(projects.*)', 'sum(logs.*.billable)'].sort(),
    )
  })

  it('§3: a formula in an ATTRIBUTE is NEVER harvested', () => {
    expect(
      harvestFormulaSrcs('<a title="{= secret.token}" href="#x">go</a>'),
    ).toEqual([])
    expect(
      harvestFormulaSrcs('<img alt="{= a.b}" src="data:image/png;,">'),
    ).toEqual([])
  })

  it('skips script / style / pre / code / textarea / template / noscript', () => {
    const r = harvestFormulaSrcs(
      '<script>{= a.b}</script><style>{= c.d}</style>' +
        '<pre>{= e.f}</pre><code>{= g.h}</code>' +
        '<textarea>{= i.j}</textarea><template>{= k.l}</template>' +
        '<noscript>{= m.n}</noscript><p>{= real.one}</p>',
    )
    expect(r).toEqual(['real.one'])
  })

  it('FAIL-1: a body over ATOM_BODY_MAX_BYTES harvests nothing (bounded)', () => {
    const filler = 'x'.repeat(ATOM_BODY_MAX_BYTES + 1)
    const r = harvestFormulaSrcs(`<div>{= a.b}</div>${filler}`)
    expect(r).toEqual([]) // calm: route still renders; reactivity just off
  })

  it('no `{=` → fast empty; empty/garbage → empty, never throws', () => {
    expect(harvestFormulaSrcs('<h1>plain html</h1>')).toEqual([])
    expect(harvestFormulaSrcs('')).toEqual([])
    expect(() => harvestFormulaSrcs('<<<>>></p<svg<')).not.toThrow()
  })

  it('an escaped \\{= …} is not a formula (frozen-parser semantics)', () => {
    // Defers to the canonical parseInlineAtoms escape rule — no 2nd
    // notion of "is this a formula".
    expect(harvestFormulaSrcs('<p>\\{= a.b}</p>')).toEqual([])
  })
})
