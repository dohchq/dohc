// html-atoms-v1 §2a — the curated, app-bundled typographic shell.
// SERVER-ONLY (`node:fs` / `createRequire`). Imported ONLY by the
// §2-B route. The mono webfont is read ONCE at module init and
// base64-inlined (`data:font/woff2;base64,…`) into a fixed
// `@font-face`. The route then injects this `<style>` into the served
// doc's `<head>`. Exactly permitted by the §2-C header CSP (`style-src
// 'unsafe-inline'; font-src data:`). NEVER fetches over the network.
//
// dohc direction: body text uses the system sans stack (no webfont —
// the brand sans is a system face); code/metadata uses IBM Plex Mono,
// the one shipped brand webfont, inlined so atoms render offline. The
// baseline is warm paper + graphite ink so a freshly authored HTML
// atom already reads as a calm dohc document before any author CSS.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)

function inlineWoff2(spec: string): string {
  try {
    const buf = readFileSync(req.resolve(spec))
    return `data:font/woff2;base64,${buf.toString('base64')}`
  } catch {
    return '' // fail-soft: no font ⇒ system-mono fallback in CSS below
  }
}

const PLEX_MONO_400 = inlineWoff2(
  '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
)
const PLEX_MONO_500 = inlineWoff2(
  '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
)

const faceFor = (uri: string, weight: number): string =>
  uri
    ? `@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:${weight};font-display:swap;src:url("${uri}") format('woff2')}`
    : ''

// A calm, opinionated-but-safe typographic baseline in the dohc
// palette: html atoms are NEVER plain — they're properly typeset on
// warm paper even before the author touches CSS. Trusted (server-
// built), fixed. The §3 `{= }` walk SKIPs STYLE ancestors ⇒ this
// never resolves into.
export const HTML_ATOM_HEAD_STYLE = `${faceFor(PLEX_MONO_400, 400)}${faceFor(PLEX_MONO_500, 500)}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Aptos','Segoe UI',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;font-size:14.5px;line-height:1.55;color:#151515;background:#f7f6f1;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;padding:32px;max-width:72ch;margin:0 auto}
h1,h2,h3,h4{line-height:1.25;margin:1.5em 0 .5em;font-weight:600;color:#0a0a0a}
h1{font-size:26px}h2{font-size:20px}h3{font-size:17px}h4{font-size:15px}
p{margin:.75em 0}
a{color:#2d342e;text-decoration:underline;text-underline-offset:2px}
a:hover{color:#1c211d}
code,pre,kbd,samp{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
code{background:#ece9e1;padding:.1em .35em;border-radius:3px}
pre{background:#ece9e1;padding:12px 14px;border-radius:8px;overflow:auto;line-height:1.5}
pre code{background:none;padding:0}
img,svg,video{max-width:100%;height:auto;display:block}
hr{border:none;border-top:1px solid rgba(21,21,21,.12);margin:1.5em 0}
ul,ol{padding-left:1.4em}
li{margin:.25em 0}
blockquote{margin:1em 0;padding:.25em 0 .25em 1em;border-left:3px solid rgba(21,21,21,.22);color:#66635d}
table{border-collapse:collapse;margin:1em 0;font-variant-numeric:tabular-nums}
th,td{padding:.5em .75em;border-bottom:1px solid rgba(21,21,21,.12);text-align:left;vertical-align:top}
th{font-weight:600;color:#151515}
strong{font-weight:600}
.muted,.dim{color:#66635d}
`.trim()
