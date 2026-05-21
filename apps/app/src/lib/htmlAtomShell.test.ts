import { describe, it, expect } from 'vitest'
import { HTML_ATOM_HEAD_STYLE } from './htmlAtomShell'

// html-atoms-v1 §2a — locks the curated, app-bundled, zero-network
// typographic shell: Inter 400+600 must be data:-base64-inlined as
// `@font-face`, and a calm typographic baseline must ship by
// default so html atoms are never "underwhelming". Server-only (the
// shell module reads woff2 via node:fs at module init).

describe('HTML_ATOM_HEAD_STYLE — §2a Inter + typographic baseline', () => {
  it('Inter regular (400) is base64-inlined as @font-face', () => {
    expect(HTML_ATOM_HEAD_STYLE).toContain("@font-face")
    expect(HTML_ATOM_HEAD_STYLE).toContain("font-family:'Inter'")
    expect(HTML_ATOM_HEAD_STYLE).toContain('font-weight:400')
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/src:url\("data:font\/woff2;base64,/)
  })

  it('Inter semibold (600) is base64-inlined as @font-face', () => {
    expect(HTML_ATOM_HEAD_STYLE).toContain('font-weight:600')
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

  it('ships a sane typographic baseline (no underwhelming default)', () => {
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/body\s*\{[^}]*font-family:'Inter'/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/h1\s*\{[^}]*font-size:26px/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/code\b/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/blockquote\b/)
    expect(HTML_ATOM_HEAD_STYLE).toMatch(/table\b/)
  })

  it('contains no `</style>` breakout (the shell sits inside a <style>)', () => {
    expect(HTML_ATOM_HEAD_STYLE.toLowerCase()).not.toContain('</style')
    expect(HTML_ATOM_HEAD_STYLE).not.toContain('<')
  })
})
