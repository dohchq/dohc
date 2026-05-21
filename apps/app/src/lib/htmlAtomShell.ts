// html-atoms-v1 §2a — the curated, app-bundled typographic shell.
// SERVER-ONLY (`node:fs` / `createRequire`). Imported ONLY by the
// §2-B route. Fonts are read ONCE at module init and base64-inlined
// (`data:font/woff2;base64,…`) into a fixed `@font-face`. The route
// then injects this `<style>` into the served doc's `<head>`.
// Exactly permitted by the §2-C header CSP (`style-src
// 'unsafe-inline'; font-src data:`). NEVER fetches over the network
// — bundled woff2 from `@fontsource/inter` (SIL-OFL).
//
// Aesthetic direction (user, D1): Inter, modern, safe, generic that
// works. System mono for code (system fonts ⇒ no network).

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)

function inlineWoff2(spec: string): string {
  try {
    const buf = readFileSync(req.resolve(spec))
    return `data:font/woff2;base64,${buf.toString('base64')}`
  } catch {
    return '' // fail-soft: no font ⇒ system-sans fallback in CSS below
  }
}

const INTER_400 = inlineWoff2(
  '@fontsource/inter/files/inter-latin-400-normal.woff2',
)
const INTER_600 = inlineWoff2(
  '@fontsource/inter/files/inter-latin-600-normal.woff2',
)

const faceFor = (uri: string, weight: number): string =>
  uri
    ? `@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};font-display:swap;src:url("${uri}") format('woff2')}`
    : ''

// A calm, opinionated-but-safe typographic baseline. Goal (per the
// user's "safe/generic that works"): html atoms are NEVER plain /
// "underwhelming" — they're at least properly typeset, even before
// the author touches CSS. Trusted (server-built), fixed. The §3
// `{= }` walk SKIPs STYLE ancestors ⇒ this never resolves into.
export const HTML_ATOM_HEAD_STYLE = `${faceFor(INTER_400, 400)}${faceFor(INTER_600, 600)}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Inter',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14.5px;line-height:1.55;color:#0f172a;background:#fff;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;padding:32px;max-width:72ch;margin:0 auto}
h1,h2,h3,h4{line-height:1.25;margin:1.5em 0 .5em;font-weight:600}
h1{font-size:26px}h2{font-size:20px}h3{font-size:17px}h4{font-size:15px}
p{margin:.75em 0}
a{color:#2563eb;text-decoration:underline;text-underline-offset:2px}
a:hover{color:#1e40af}
code,pre,kbd,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
code{background:#f1f5f9;padding:.1em .35em;border-radius:3px}
pre{background:#f1f5f9;padding:12px 14px;border-radius:6px;overflow:auto;line-height:1.5}
pre code{background:none;padding:0}
img,svg,video{max-width:100%;height:auto;display:block}
hr{border:none;border-top:1px solid #e2e8f0;margin:1.5em 0}
ul,ol{padding-left:1.4em}
li{margin:.25em 0}
blockquote{margin:1em 0;padding:.25em 0 .25em 1em;border-left:3px solid #cbd5e1;color:#475569}
table{border-collapse:collapse;margin:1em 0;font-variant-numeric:tabular-nums}
th,td{padding:.5em .75em;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
th{font-weight:600;color:#334155}
strong{font-weight:600}
.muted,.dim{color:#64748b}
`.trim()
