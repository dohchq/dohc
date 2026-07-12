// "Export as HTML" / "Export as PDF" (ViewHeader's document menu) both
// render through this ONE pure function: a SELF-CONTAINED HTML document —
// title, the body rendered through the same tiptap schema the editor uses
// (markdownBodyToHtml, import-export.ts), and an inline print-quality
// stylesheet. No external assets (fonts, scripts, stylesheets) — the file
// has to open correctly on its own, offline, in any browser, and print
// identically through Electron's printToPDF. Pure and dependency-free
// beyond import-export.ts, so it's covered by ordinary unit tests instead of
// needing an Electron window.
import katex from 'katex'
import { parseFrontmatter, displayFrontmatterValue } from '../markdown/frontmatter'
import { markdownBodyToHtml } from './import-export'
import { KATEX_EXPORT_CSS } from './katexExportStyles'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// The document's display title: the `title` frontmatter key (same key
// PageIdentity.tsx reads/writes), falling back to the filename stem —
// the same Notion-style placeholder rule used everywhere else a title is
// shown.
export function resolveDocumentTitle(markdown: string, fallbackTitle: string): string {
  const { meta } = parseFrontmatter(markdown)
  const fromFrontmatter = displayFrontmatterValue(meta.title).trim()
  return fromFrontmatter.length > 0 ? fromFrontmatter : fallbackTitle
}

// Trimmed, self-contained, LIGHT-ONLY print theme: a warm-paper reading
// surface distinct from the app's sans-serif UI chrome — this is a document
// meant to be read/printed, not a copy of the editor's own styles.css (which
// is thousands of lines of app chrome this file has no business carrying).
// Selectors mirror the class/data-attribute names the custom tiptap nodes in
// extensions.ts actually render (dohc-wikilink-pill, dohc-callout,
// dohc-highlight, [data-type="taskItem"]) so structure fidelity survives
// the export.
const EXPORT_STYLE_CSS = `
  :root {
    color-scheme: light;
    --bg: #faf9f5;
    --panel: #f3f1ea;
    --panel-2: #ebe8e0;
    --line: #e4e1d8;
    --ink: #1c1b18;
    --muted: #55524a;
    --subtle: #7f7b6e;
    --accent: #2d342e;
    --success: #38684e;
    --warning: #8a6420;
    --danger: #a6402c;
    --match: #3a7ee9;
  }
  @page { margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
  }
  body {
    padding: 40px 56px 64px;
    font-family: 'Iowan Old Style', Charter, Georgia, 'Times New Roman', serif;
    font-size: 15px;
    line-height: 1.65;
  }
  .dohc-export-title {
    margin: 0 0 22px;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  h1, h2, h3, h4 { font-weight: 700; line-height: 1.25; }
  h1 { margin: 28px 0 12px; font-size: 26px; }
  h2 { margin: 24px 0 10px; font-size: 21px; }
  h3 { margin: 20px 0 8px; font-size: 17px; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 14px; }
  ul, ol { padding-left: 26px; }
  li > p { margin: 0; }
  a { color: var(--ink); }
  hr { margin: 24px 0; border: 0; border-top: 1px solid var(--line); }
  blockquote {
    margin: 0 0 14px;
    padding: 2px 0 2px 18px;
    border-left: 2px solid var(--accent);
    font-style: italic;
  }
  code {
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--panel-2);
    padding: 1px 5px;
    font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
    font-size: 0.85em;
  }
  pre {
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    padding: 14px 16px;
  }
  pre code { border: 0; background: transparent; padding: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: var(--panel); font-weight: 600; }
  ul[data-type="taskList"] { padding-left: 4px; list-style: none; }
  li[data-type="taskItem"] { display: flex; align-items: flex-start; gap: 8px; }
  li[data-type="taskItem"] > label { flex: 0 0 auto; margin-top: 4px; }
  li[data-type="taskItem"] input[type="checkbox"] { pointer-events: none; }
  li[data-type="taskItem"][data-checked="true"] > div {
    color: var(--muted);
    text-decoration: line-through;
    text-decoration-color: var(--line);
  }
  mark.dohc-highlight, .dohc-highlight {
    background: color-mix(in srgb, var(--warning) 30%, transparent);
    color: var(--ink);
    border-radius: 3px;
    padding: 0 2px;
  }
  .dohc-wikilink-pill {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel-2);
    padding: 0 8px;
    font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
    font-size: 0.8em;
    color: var(--ink);
  }
  .dohc-callout {
    --callout-accent: var(--match);
    margin: 16px 0;
    border: 1px solid color-mix(in srgb, var(--callout-accent) 26%, var(--line));
    border-left: 3px solid var(--callout-accent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--callout-accent) 8%, var(--bg));
    padding: 10px 14px;
  }
  .dohc-callout[data-callout-type="tip"] { --callout-accent: var(--success); }
  .dohc-callout[data-callout-type="info"] { --callout-accent: var(--match); }
  .dohc-callout[data-callout-type="warning"] { --callout-accent: var(--warning); }
  .dohc-callout[data-callout-type="danger"] { --callout-accent: var(--danger); }
  .dohc-callout[data-callout-type="quote"] { --callout-accent: var(--muted); }
  .dohc-callout[data-callout-title]:not([data-callout-title=""])::before {
    content: attr(data-callout-title);
    display: block;
    margin-bottom: 4px;
    font-weight: 700;
    text-transform: capitalize;
  }
  .dohc-callout-body > *:first-child { margin-top: 0; }
  .dohc-callout-body > *:last-child { margin-bottom: 0; }
`.trim()

// markdownBodyToHtml renders the math atom nodes (extensions.ts) as their raw
// TeX source — <span data-dohc-math-inline>$tex$</span> and
// <div data-dohc-math-block>$$tex$$</div> — which would print as literal
// dollar-delimited LaTeX. Typeset them with KaTeX so the export matches what
// the editor shows. renderToString is self-contained markup (no runtime
// script); the KaTeX layout CSS is inlined separately, font-file-free, so this
// stays a single offline document. Returns whether any math was found so the
// (large) KaTeX CSS is only inlined when a document actually uses math.
function typesetMath(content: DocumentFragment): boolean {
  let hasMath = false
  const typeset = (el: Element, displayMode: boolean, delimiterLength: number) => {
    hasMath = true
    const raw = el.textContent ?? ''
    const tex = raw.slice(delimiterLength, raw.length - delimiterLength)
    try {
      // throwOnError:false already renders parse errors as visible red TeX
      // rather than throwing; the catch is a belt-and-braces guard that keeps
      // the lossless raw TeX instead of dropping content if KaTeX ever throws.
      el.innerHTML = katex.renderToString(tex, { displayMode, throwOnError: false })
    } catch {
      // Leave the raw `$tex$` in place.
    }
  }
  content
    .querySelectorAll('[data-dohc-math-inline]')
    .forEach((el) => typeset(el, false, 1))
  content
    .querySelectorAll('[data-dohc-math-block]')
    .forEach((el) => typeset(el, true, 2))
  return hasMath
}

// EXPORT IMAGE CONTRACT — an exported document never reaches outside its own
// folder.
//
// The editor resolves a workspace-relative image src against the DOCUMENT's
// folder (imageSrc.ts) and serves the bytes over dohc-file://. An export has
// neither: the file is opened from wherever the user saved it (HTML), or from a
// throwaway temp dir (PDF — documentPdfExport writes the HTML to os.tmpdir()
// and loads it with `file://`). The only base an exported document actually has
// is its OWN directory, so its containment rule is stricter than the editor's:
//
//   http(s)                              → kept (a remote image is still remote)
//   plain path at/below the export dir   → kept ("assets/x.png" still resolves
//                                          when the HTML is saved beside the doc)
//   ANYTHING else                        → emitted with NO src
//
// "Anything else" is every src that could climb out of the export directory or
// name a local resource: `../` traversal (which a global-folder attachment src
// legitimately carries in the workspace, but which from a temp dir would point
// at the real filesystem), absolute and protocol-relative paths, and any
// non-http(s) scheme (data:, file:, dohc-file:). Those images render as their
// alt text. Nothing is dropped from the DOCUMENT — this only shapes the
// exported artifact; the markdown keeps its lossless src.
function isExportSafeImageSrc(src: string): boolean {
  const trimmed = src.trim()
  if (trimmed.length === 0) return false
  // Strip control chars/whitespace before sniffing, mirroring the sanitizer in
  // extensions.ts, so an obfuscated scheme ("java\nscript:") can't slip past.
  const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, '')
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(compact)?.[0]
  if (scheme) {
    const protocol = scheme.slice(0, -1).toLowerCase()
    return protocol === 'http' || protocol === 'https'
  }
  // Backslashes fold to '/' so a Windows-style `..\` traversal is caught too.
  const forCheck = compact.replace(/\\/g, '/')
  // Absolute ("/abs") and protocol-relative ("//host") both leave the export dir.
  if (forCheck.startsWith('/')) return false
  // Any `..` segment climbs above the exported file.
  return !/(^|\/)\.\.(\/|$)/.test(forCheck)
}

function containImages(content: DocumentFragment): void {
  content.querySelectorAll('img').forEach((img) => {
    if (!isExportSafeImageSrc(img.getAttribute('src') ?? '')) {
      // No src at all — not src="", which browsers re-request as the page's own
      // URL.
      img.removeAttribute('src')
    }
  })
}

// One DOM pass over the rendered body: typeset math, then contain image srcs.
// Runs in the same DOM-bearing context markdownBodyToHtml already requires
// (renderer / vitest jsdom), never in the main process.
function prepareExportedBodyHtml(bodyHtml: string): {
  html: string
  hasMath: boolean
} {
  const template = document.createElement('template')
  template.innerHTML = bodyHtml
  const hasMath = typesetMath(template.content)
  containImages(template.content)
  return { html: template.innerHTML, hasMath }
}

// Builds the full standalone HTML document. `markdown` is the WHOLE document
// source (frontmatter included, exactly what "Copy as Markdown" copies) —
// frontmatter drives the title; everything after it is the rendered body.
export function buildStandaloneDocumentHtml(
  markdown: string,
  fallbackTitle: string,
): string {
  const { body } = parseFrontmatter(markdown)
  const title = resolveDocumentTitle(markdown, fallbackTitle)
  const escapedTitle = escapeHtml(title)
  const { html: bodyHtml, hasMath } = prepareExportedBodyHtml(
    markdownBodyToHtml(body),
  )
  const style = hasMath
    ? `${EXPORT_STYLE_CSS}\n${KATEX_EXPORT_CSS}`
    : EXPORT_STYLE_CSS

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<style>${style}</style>
</head>
<body>
<h1 class="dohc-export-title">${escapedTitle}</h1>
${bodyHtml}
</body>
</html>
`
}
