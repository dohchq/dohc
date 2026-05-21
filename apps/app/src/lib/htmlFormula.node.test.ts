// NO `@vitest-environment jsdom` — this runs in the DEFAULT Node
// env, exactly like the production server route (`node
// .output/server`), where there is NO global `NodeFilter` and the
// DOM comes only from `new JSDOM(...)`. The jsdom-env suite
// (htmlFormula.test.ts) MASKED P4a FAIL-1 (bare global NodeFilter
// threw on every server formula render). This file is the
// regression floor for "works under real Node".
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  harvestFormulaSrcsFromDoc,
  resolveFormulasInDoc,
  resolveAtomsInDoc,
} from './htmlFormula'

// Production (`node .output/server`) has NO global `NodeFilter`
// (verified: plain Node CJS+ESM ⇒ undefined). vitest's node worker
// can be POLLUTED by a sibling `@vitest-environment jsdom` file
// (jsdom installs DOM globals on the shared worker) — the exact
// masking that hid P4a FAIL-1. So DELETE the global for this suite:
// the tests then run under the TRUE prod condition regardless of
// worker pollution, and a regression to the bare global throws.
const g = globalThis as Record<string, unknown>
let savedNodeFilter: unknown
beforeAll(() => {
  savedNodeFilter = g.NodeFilter
  delete g.NodeFilter
})
afterAll(() => {
  if (savedNodeFilter !== undefined) g.NodeFilter = savedNodeFilter
})

describe('htmlFormula under REAL Node (production path: new JSDOM)', () => {
  it('FAIL-1: harvest + resolve work with NO global NodeFilter', () => {
    const dom = new JSDOM('<!doctype html><body><p>Owed {= a.b}</p></body>')
    const doc = dom.window.document
    expect(harvestFormulaSrcsFromDoc(doc)).toEqual(['a.b']) // would ReferenceError pre-fix
    resolveFormulasInDoc(doc, () => '1,234')
    expect(dom.serialize()).toContain('Owed 1,234')
  })

  it('markup in a resolved value is escaped/inert after serialize', () => {
    const dom = new JSDOM('<!doctype html><body><p>{= x}</p></body>')
    resolveFormulasInDoc(
      dom.window.document,
      () => '</p><img src=x onerror=alert(1)><script>a</script>',
    )
    const out = dom.serialize()
    expect(out).not.toMatch(/<img\b/i)
    expect(out).not.toMatch(/<script\b/i)
    expect(dom.window.document.querySelector('img')).toBeNull()
  })

  it('FAIL-2: a leading <style> in body survives the wrap-shaped parse', () => {
    const dom = new JSDOM(
      '<!doctype html><html><head><title>v</title></head>' +
        '<body><style>.k{color:red}</style><p>{= a.b}</p></body></html>',
    )
    resolveFormulasInDoc(dom.window.document, () => '42')
    const out = dom.serialize()
    expect(out).toContain('<style>.k{color:red}</style>') // NOT lost
    expect(out).toContain('<p>42</p>')
  })

  it('FAIL-3: SVG-namespaced <style> and <title> are skipped', () => {
    const dom = new JSDOM(
      '<!doctype html><body><svg><style>{= css.x}</style>' +
        '<text>{= label}</text></svg>' +
        '<div><title>{= t}</title><p>{= shown}</p></div></body>',
    )
    const doc = dom.window.document
    resolveFormulasInDoc(doc, () => 'V')
    expect(doc.querySelector('svg style')!.textContent).toBe('{= css.x}') // skipped
    expect(doc.querySelector('svg text')!.textContent).toBe('V') // resolved
    expect(doc.querySelector('title')!.textContent).toBe('{= t}') // skipped
    expect(doc.querySelector('p')!.textContent).toBe('V') // resolved
  })

  it('FAIL-3 harvest: SVG <style>/<title> srcs are NOT harvested', () => {
    const dom = new JSDOM(
      '<!doctype html><body><svg><style>{= a.skip}</style></svg>' +
        '<title>{= b.skip}</title><p>{= c.keep}</p></body>',
    )
    expect(harvestFormulaSrcsFromDoc(dom.window.document)).toEqual([
      'c.keep',
    ])
  })

  // ─────────────────────────────────────────────────────────────
  // D4.10 — resolveAtomsInDoc handles BOTH value atoms `{key: v}`
  // and formulas `{= ...}` in one pass. Mirrors the editor's pill
  // rendering so HTML atoms show the same text the user sees while
  // editing.
  // ─────────────────────────────────────────────────────────────

  it('D4.10: substitutes value atoms with just the value text', () => {
    const dom = new JSDOM(
      '<!doctype html><body><p>Client: {clients: Acme Corp}</p></body>',
    )
    resolveAtomsInDoc(dom.window.document, () => '—')
    expect(dom.serialize()).toContain('Client: Acme Corp')
    expect(dom.serialize()).not.toContain('{clients:')
  })

  it('D4.10: number values round to 2 decimals; booleans → yes/no', () => {
    const dom = new JSDOM(
      '<!doctype html><body>' +
        '<p>Rate: {rate: 130.456}</p>' +
        '<p>Active: {active: true}</p>' +
        '<p>Billable: {billable: false}</p>' +
        '</body>',
    )
    resolveAtomsInDoc(dom.window.document, () => '—')
    const out = dom.serialize()
    expect(out).toContain('Rate: 130.46')
    expect(out).toContain('Active: yes')
    expect(out).toContain('Billable: no')
  })

  it('D4.10: substitutes value atoms AND formulas in one pass', () => {
    const dom = new JSDOM(
      '<!doctype html><body>' +
        '<table><tr><td>{clients: Acme}</td><td>{rate: 130}</td></tr></table>' +
        '<p>Total billable: {= sum(logs.*.billable)} hrs</p>' +
        '</body>',
    )
    resolveAtomsInDoc(dom.window.document, (s) =>
      s === 'sum(logs.*.billable)' ? '9.5' : '—',
    )
    const out = dom.serialize()
    expect(out).toContain('<td>Acme</td>')
    expect(out).toContain('<td>130</td>')
    expect(out).toContain('Total billable: 9.5 hrs')
  })

  it('D4.10: value atoms in <style>/<code> stay literal (skip ancestors)', () => {
    const dom = new JSDOM(
      '<!doctype html><body>' +
        '<style>body {color: red}</style>' +
        '<code>{key: val}</code>' +
        '<p>{clients: Acme}</p>' +
        '</body>',
    )
    const doc = dom.window.document
    resolveAtomsInDoc(doc, () => '—')
    expect(doc.querySelector('style')!.textContent).toBe('body {color: red}')
    expect(doc.querySelector('code')!.textContent).toBe('{key: val}')
    expect(doc.querySelector('p')!.textContent).toBe('Acme')
  })

  it('D4.10: liveTotal `{identifier}` stays literal (legacy form)', () => {
    const dom = new JSDOM(
      '<!doctype html><body><p>Legacy: {billable}</p></body>',
    )
    resolveAtomsInDoc(dom.window.document, () => 'X')
    // Bare `{identifier}` is the legacy liveTotal — left as-is so
    // existing bodies don't break; new authoring uses `{= …}`.
    expect(dom.serialize()).toContain('Legacy: {billable}')
  })

  it('DoS guard: a pathological many-`{=` node returns fast, no hang', () => {
    // 50k unclosed `{=` in one text node — O(n²) in the FROZEN
    // tokenizer ⇒ many seconds WITHOUT the O(n) pre-count guard.
    const dom = new JSDOM(
      `<!doctype html><body><p>${'{='.repeat(50000)}</p>` +
        '<span>{= real.one}</span></body>',
    )
    const t0 = Date.now()
    const srcs = harvestFormulaSrcsFromDoc(dom.window.document)
    expect(Date.now() - t0).toBeLessThan(1000) // guarded ⇒ ms
    expect(srcs).toEqual(['real.one']) // pathological node skipped; real kept
  })
})
