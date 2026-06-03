import { describe, it, expect } from 'vitest'
import { HTML_ATOM_HEAD_STYLE } from './htmlAtomShell'

// html-atoms-v1 §2a — locks the curated, app-bundled, zero-network
// typographic shell: IBM Plex Mono 400+500 must be data:-base64-inlined
// as `@font-face` (the one shipped brand webfont), body text uses the
// system sans stack, and a calm warm-paper baseline must ship by
// default so html atoms are never "underwhelming". Server-only (the
// shell module reads woff2 via node:fs at module init).

describe('HTML_ATOM_HEAD_STYLE — §2a dohc mono + typographic baseline', () => {
  it('IBM Plex Mono regular (400) is base64-inlined as @font-face', () => {
    expect(HTML_ATOM_HEAD_STYLE).toContain('@font-face')
    expect(HTML_ATOM_HEAD_STYLE).toContain("font-family:'IBM Plex Mono'")
    expect(HTML_ATOM_HEAD_STYLE).toContain('font-weight:400')
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/src:url\("data:font\/woff2;base64,/)
  })

  it('IBM Plex Mono medium (500) is base64-inlined as @font-face', () => {
    expect(HTML_ATOM_HEAD_STYLE).toContain('font-weight:500')
  })

  it('is ZERO-network: no http(s):/file:/data:image schemes anywhere', () => {
    expect(HTML_ATOM_HEAD_STYLE).not.toMatch(/https?:/)
    expect(HTML_ATOM_HEAD_STYLE).not.toContain('file:')
    expect(HTML_ATOM_HEAD_STYLE).not.toContain('data:image')
    // the only data: URI is data:font/woff2 (the @font-face src)
    expect(
      [...HTML_ATOM_HEAD_STYLE.matchAll(/data:/g)].every((m) =>
        HTML_ATOM_HEAD_STYLE.startsWith('data:font/woff2', m.index),
      ),
    ).toBe(true)
  })

  it('ships a sane dohc typographic baseline (system sans on warm paper)', () => {
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/body\s*\{[^}]*font-family:'Aptos'/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/body\s*\{[^}]*background:#f7f6f1/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/h1\s*\{[^}]*font-size:26px/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/code\b/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/blockquote\b/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/table\b/)
  })

  it('lets authored HTML fill the iframe instead of forcing a paper page column', () => {
    const bodyRule = HTML_ATOM_HEAD_STYLE.match(/\nbody\s*\{(?<rule>[^}]*)\}/)
      ?.groups?.rule

    expect(bodyRule).toContain('min-height:100vh')
    expect(bodyRule).not.toContain('padding:32px')
    expect(bodyRule).not.toContain('max-width:72ch')
    expect(bodyRule).not.toContain('margin:0 auto')
  })

  it('contains no `</style>` breakout (the shell sits inside a <style>)', () => {
    expect(HTML_ATOM_HEAD_STYLE.toLowerCase()).not.toContain('</style')
    expect(HTML_ATOM_HEAD_STYLE).not.toContain('<')
  })
})
