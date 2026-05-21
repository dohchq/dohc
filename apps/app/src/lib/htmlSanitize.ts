// html-atoms-v1 §2 / §2-C — the SERVER-ONLY HTML sanitizer + the
// exact response-header builder for the §2-B render route (Track-2
// P2). SERVER-ONLY: this imports isomorphic-dompurify (→ jsdom)
// which MUST NEVER reach the client bundle — only the §2-B server
// route imports it (zero client bundle, per the v5 design). vitest
// (Node) imports it directly for the adversarial suite.
//
// SECURITY MODEL (v5, do not weaken): the iframe `sandbox=""` (no
// allow-scripts/same-origin/popups/top-nav/forms) + the real
// response-header CSP below are the PRIMARY, browser-enforced
// guarantees. This sanitizer is the §2-C defense-in-depth layer that
// is LOAD-BEARING only for the frame-self-nav vector (a missed
// `<meta refresh>`/`<base>`/non-fragment `<a>` could nav the frame
// to a CSP-less doc). Hence: a vetted dep (DOMPurify), pinned, with
// the adversarial suite in htmlSanitize.test.ts.
//
// DESIGN NOTE (P2 dual-review fold — Codex BLOCK):
// The first cut regex-extracted `<style>` from RAW HTML, then re-
// attached post-DOMPurify. That is UNSOUND: `<style>`/`</style>`
// can appear as literal text inside an ATTRIBUTE VALUE, so the
// regex hid `onclick=`/`href=` from DOMPurify and the swap-back
// resurrected them live (confirmed exec + §2-C nav bypass). The
// only sound way to identify a `<style>` element is to PARSE.
// DOMPurify (this jsdom build) keeps `<style>` iff
// ADD_TAGS:['style'] + FORCE_BODY:true (empirically verified);
// CSS is then scrubbed on the PARSED style node via a hook — never
// a regex over unparsed input. No placeholder/swap-back exists, so
// the String.prototype.replace `$&`/`$\``/`$'` reflection class is
// gone by construction.

import DOMPurify from 'isomorphic-dompurify'

/** The effective mXSS engine, read at runtime (the wrapper version
 *  is NOT the engine version — isomorphic-dompurify@3.14.0 bundles
 *  this). Asserted by the suite so a silent bump fails loudly + the
 *  P2 security review can validate it against the DOMPurify CVE
 *  feed. */
export const SANITIZER_ENGINE_VERSION: string = DOMPurify.version
export const SANITIZER_ENGINE = `dompurify@${SANITIZER_ENGINE_VERSION} (via isomorphic-dompurify@3.14.0)`

const MAX_HTML = 1 << 20 // 1 MiB — atoms are documents, not blobs
const MAX_STYLE = 1 << 18 // 256 KiB per <style> block (ReDoS cap)

// Non-`#` URLs are allowed ONLY as a data: image LOAD (never as a
// navigation target — that is enforced per-attribute in the
// uponSanitizeAttribute hook). Belt for non-data schemes; the hook
// is the attribute-context-aware source of truth.
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif)[;,]/i
const ALLOWED_URI = new RegExp(`^(?:#[^\\s]*|${DATA_IMAGE.source.slice(1)})`, 'i')

// URL-bearing attributes. Navigation sinks (a/area href, xlink:href)
// get FRAGMENT-ONLY; image-load attrs on img/image get data:image;
// everything else URL-bearing is dropped unless it is a `#`
// fragment. Closes the §2-C `data:image/svg+xml` frame-self-nav
// (a data: doc does NOT inherit the route CSP → script-free beacon).
const URL_ATTRS = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'data',
  'ping',
  'background',
  'lowsrc',
  'poster',
])
const IMAGE_TAGS = new Set(['img', 'image'])

/** Thin, linear, ReDoS-safe CSS scrub applied to the PARSED `<style>`
 *  node's textContent (NOT a regex over raw HTML — that was the
 *  unsound v1). Two distinct jobs, do NOT conflate their weight:
 *
 *  - LOAD-BEARING: the `<`→`\3C ` markup-breakout block. `<style>`
 *    is an HTML raw-text element — jsdom/browsers serialize its
 *    text WITHOUT entity-escaping, so an un-escaped `</style>` in
 *    the CSS WOULD break out into element context on re-parse.
 *    This must hold.
 *  - BEST-EFFORT BELT (NOT a security guarantee): the legacy-vector
 *    token swaps (expression()/-moz-binding/behavior:/js:/vb:/
 *    @import/@charset). These are LITERAL patterns and are
 *    deliberately defeatable by CSS escapes (`expressio\6e(`,
 *    `java\73cript:`) — the dual-review (r2, both reviewers)
 *    confirmed that is ACCEPTED, not a §2-C failure: those vectors
 *    are IE-dead (no modern exec) or network-only (closed by the
 *    header CSP `default-src 'none'`, the real network boundary).
 *    Do NOT "harden" this into a CSS parser — that is the
 *    gate-warned scope-creep; the sandbox + header CSP are the
 *    exec/network guarantees, never this function. */
function scrubCss(css: string): string {
  let s = css.length > MAX_STYLE ? css.slice(0, MAX_STYLE) : css
  s = s.replace(/</g, '\\3C ') // kills </style>, <script, <!-- breakouts
  s = s
    .replace(/expression\s*\(/gi, 'blocked-expression(')
    .replace(/-moz-binding\b/gi, '-blocked-binding')
    .replace(/\bbehavior\s*:/gi, 'blocked-behavior:')
    .replace(/javascript\s*:/gi, 'blocked-javascript:')
    .replace(/vbscript\s*:/gi, 'blocked-vbscript:')
    .replace(/@import\b/gi, '@blocked-import')
    .replace(/@charset\b/gi, '@blocked-charset')
  return s
}

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  // DOMPurify's DEFAULT allow-list (NOT USE_PROFILES — that is a
  // restrictive subset that drops <style>). The default is the
  // cure53-fuzzed baseline whose core competency is mXSS defense
  // across HTML/SVG/MathML. ADD_TAGS:['style'] + FORCE_BODY:true is
  // the empirically-verified combination that makes this jsdom
  // DOMPurify keep a real (parsed) <style> element; its CSS is
  // scrubbed in the uponSanitizeElement hook. On top we FORBID the
  // §2 structural / nav / network tags + attrs.
  ADD_TAGS: ['style'],
  FORCE_BODY: true,
  FORBID_TAGS: [
    'script',
    'iframe',
    'object',
    'embed',
    'link',
    'base',
    'form',
    'meta',
    'noscript',
    'template',
    'frame',
    'frameset',
    'applet',
    'portal',
  ],
  FORBID_ATTR: [
    'srcset', // extra network surface
    'formaction',
    'ping',
    'http-equiv', // meta-refresh nav vector (belt; <meta> is forbidden)
    'background', // legacy network attr
    'lowsrc',
  ],
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  WHOLE_DOCUMENT: false, // a fragment; the route wraps it in our shell
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  RETURN_TRUSTED_TYPE: false,
  SANITIZE_DOM: true,
  KEEP_CONTENT: true, // drop the tag, keep its text (e.g. <script>txt)
}

// Hooks are pure functions of the parsed node ⇒ sanitizeAtomHtml
// stays deterministic. Registered ONCE, guarded by a flag stored on
// the isomorphic-dompurify SINGLETON (not a module-local `let`):
// the singleton persists across module re-evaluation (HMR / test
// re-import), so the guard must too — otherwise addHook would stack
// duplicates (security-safe per dual-review r2 — over-scrub at
// worst — but the guard removes the sharp edge). Never add per-call.
const HOOKS_FLAG = '__dohcHtmlAtomHooks'
type Guarded = typeof DOMPurify & { [HOOKS_FLAG]?: true }
function registerHooksOnce(): void {
  const dp = DOMPurify as Guarded
  if (dp[HOOKS_FLAG]) return
  dp[HOOKS_FLAG] = true

  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style') {
      // Parsed style node: textContent IS the CSS, unambiguously.
      try {
        node.textContent = scrubCss(node.textContent ?? '')
      } catch {
        node.textContent = ''
      }
    }
  })

  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName
    if (!URL_ATTRS.has(name)) return
    const v = String(data.attrValue ?? '').trim()
    if (v.startsWith('#')) return // in-page fragment: always safe
    const tag =
      typeof node.tagName === 'string' ? node.tagName.toLowerCase() : ''
    // Image LOAD (not a navigation): data: image is fine — it
    // cannot navigate the frame and the empty sandbox + CSP bound it.
    if (
      (name === 'src' || name === 'href' || name === 'xlink:href') &&
      IMAGE_TAGS.has(tag) &&
      DATA_IMAGE.test(v)
    ) {
      return
    }
    // Everything else URL-bearing (incl. data:image on a nav sink,
    // data:text/html, http(s):, same-origin paths) — drop the attr.
    data.keepAttr = false
  })
}
registerHooksOnce()

/**
 * Sanitize an HTML-atom body fragment for the §2-B route. PURE,
 * deterministic, never throws (DOMPurify returns '' on a hard
 * failure; we coerce). Real `<style>` elements (CSS scrubbed on the
 * parsed node) + inline `style=` + `data:` images are kept (D2:
 * rich CSS); script, on-event handlers, iframe, nav and network
 * tags/attrs are removed. This is the §2-C defense-in-depth layer —
 * NOT the primary guarantee (that is the sandbox + header CSP).
 */
export function sanitizeAtomHtml(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  const input = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html
  const out = DOMPurify.sanitize(input, CONFIG)
  return typeof out === 'string' ? out : String(out ?? '')
}

// The EXACT §2-C response policy. ZERO `'self'` in any RESOURCE-FETCH
// directive (the doc is an opaque sandbox origin — `'self'` there
// would be incoherent + a same-origin subresource hole, Codex r2).
// `frame-ancestors 'self'` is NOT a fetch directive: it governs WHO
// MAY EMBED the doc (anti-clickjacking — only our same-origin
// parent). Everything data:/inline ⇒ provably zero network of the
// rendered doc (Guarantee B, browser-enforced).
export const HTML_ATOM_CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  'img-src data:; ' +
  'font-src data:; ' +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'self'"

/** Headers the §2-B route MUST return with the sanitized document —
 *  EXACTLY the gate-cleared v5 §2-C policy, nothing improvised. Any
 *  hardening beyond this (e.g. a CSP `sandbox` directive) goes
 *  through the design + gate, not smuggled in here. */
export function htmlAtomResponseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': HTML_ATOM_CSP,
    'X-Content-Type-Options': 'nosniff',
  }
}
