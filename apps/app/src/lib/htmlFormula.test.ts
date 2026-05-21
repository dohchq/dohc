// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  harvestFormulaSrcsFromDoc,
  resolveFormulasInDoc,
  formulaValueToText,
} from './htmlFormula'

const doc = (html: string) =>
  new DOMParser().parseFromString(html, 'text/html')

// html-atoms-v1 §3 — the server resolution core (also the client
// harvest). The dispositive security property: a resolved value
// containing markup is INERT after serialization (text-node write +
// serializer escape), and a `{= }` in an ATTRIBUTE is NEVER touched.

describe('harvestFormulaSrcsFromDoc', () => {
  it('finds element-content formulas; de-dupes; skips attrs & code', () => {
    const d = doc(
      '<section><p>{= sum(logs.*.billable)}</p>' +
        '<span>{= count(p.*)}</span><i>{= sum(logs.*.billable)}</i>' +
        '<a title="{= secret.token}">x</a>' +
        '<code>{= not.this}</code><script>{= nor.this}</script></section>',
    )
    expect(harvestFormulaSrcsFromDoc(d).sort()).toEqual(
      ['count(p.*)', 'sum(logs.*.billable)'].sort(),
    )
  })
})

describe('resolveFormulasInDoc — substitution + inert-by-serialization', () => {
  it('substitutes the resolved value in element text', () => {
    const d = doc('<p>Acme owes {= clients.acme.owed} today.</p>')
    resolveFormulasInDoc(d, () => '1,234')
    expect(d.body.innerHTML).toBe('<p>Acme owes 1,234 today.</p>')
  })

  it('SECURITY: a value containing markup is ESCAPED (inert), not live', () => {
    const d = doc('<p>{= x}</p>')
    resolveFormulasInDoc(d, () => '<img src=x onerror=alert(1)></img><script>a</script>')
    const out = d.body.innerHTML
    expect(out).not.toMatch(/<img\b/i) // no live element
    expect(out).not.toMatch(/<script\b/i)
    expect(out).toContain('&lt;img') // present only as escaped text
    // and the live DOM has no injected element
    expect(d.querySelector('img')).toBeNull()
    expect(d.querySelector('script')).toBeNull()
  })

  it('§3: a {= } inside an ATTRIBUTE is NEVER resolved', () => {
    const d = doc('<a title="{= a.b}" href="#s">go {= c.d}</a>')
    resolveFormulasInDoc(d, () => 'RESOLVED')
    const a = d.querySelector('a')!
    expect(a.getAttribute('title')).toBe('{= a.b}') // untouched
    expect(a.textContent).toBe('go RESOLVED') // text node resolved
  })

  it('multiple tokens in one text node keep order; non-formula text intact', () => {
    const d = doc('<p>a {= one} b {= two} c</p>')
    const vals: Record<string, string> = { one: 'I', two: 'II' }
    resolveFormulasInDoc(d, (s) => vals[s] ?? '?')
    expect(d.body.textContent).toBe('a I b II c')
  })

  it('fail-soft: lookup returns the calm — and the page still renders', () => {
    const d = doc('<h1>Q3</h1><p>Total: {= sum(x.*.n)}</p>')
    resolveFormulasInDoc(d, () => '—')
    expect(d.body.innerHTML).toBe('<h1>Q3</h1><p>Total: —</p>')
  })

  it('skips <code>/<pre>/<style>/<script>/<textarea> contexts', () => {
    const d = doc(
      '<pre>{= keep.literal}</pre><style>{= s}</style><p>{= go}</p>',
    )
    resolveFormulasInDoc(d, () => 'R')
    expect(d.querySelector('pre')!.textContent).toBe('{= keep.literal}')
    expect(d.querySelector('p')!.textContent).toBe('R')
  })

  it('no formulas ⇒ DOM untouched', () => {
    const d = doc('<p>just text {x:1} {bare}</p>')
    const before = d.body.innerHTML
    resolveFormulasInDoc(d, () => 'X')
    expect(d.body.innerHTML).toBe(before)
  })
})

describe('formulaValueToText — the §3/Phase-4 fail-soft floor', () => {
  it('number/string → text; null/undefined → —', () => {
    expect(formulaValueToText(0)).toBe('0')
    expect(formulaValueToText(1234.5)).toBe('1234.5')
    expect(formulaValueToText('hi')).toBe('hi')
    expect(formulaValueToText(null)).toBe('—')
    expect(formulaValueToText(undefined)).toBe('—')
  })
})
