import { parseInlineAtoms, formatValueAtomText } from './inlineAtom'

// html-atoms-v1 §3 — the ONE `{= }` walk for an html atom, shared by
// the client nonce-harvest (HtmlAtomFrame, browser DOMParser) and the
// SERVER §2-B route resolution (jsdom). DOM-agnostic: takes a parsed
// `Document`, so there is exactly ONE impl + ONE parser
// (parseInlineAtoms, the FROZEN tokenizer — invariant §6). NEVER a
// regex over raw HTML, NEVER a Markdown parser (P3 dual-review FAIL).
//
// §3 rules realized structurally here:
//  - TEXT NODES ONLY. Attributes are never text nodes ⇒ "a {= } in
//    an attribute is NEVER resolved" holds BY CONSTRUCTION.
//  - skip raw-text / code contexts (a `{= }` in <script>/<style>/
//    <code>/<pre>/<textarea> is not display text the author means).
//  - resolution writes into `nodeValue` ⇒ the value is TEXT ⇒ the
//    DOM serializer escapes `& < >` ⇒ a resolved value containing
//    markup is inert BY CONSTRUCTION (stronger than hand-escaping;
//    the §3 "stays inert" guarantee, with no escape-list to get
//    wrong).

// Compared by localName.toUpperCase() so an SVG-namespaced <style>
// (tagName === "style", lowercase) is ALSO skipped (P4a dual-review
// FAIL: case/namespace miss let an author value into a live SVG
// stylesheet). TITLE included (a `{= }` in <title> is not display
// text + some parses keep it).
const SKIP_ANCESTORS = new Set([
  'SCRIPT',
  'STYLE',
  'PRE',
  'CODE',
  'TEXTAREA',
  'TEMPLATE',
  'NOSCRIPT',
  'TITLE',
])

// NodeFilter.SHOW_TEXT === 0x4. Use the NUMERIC constant, NOT the
// global `NodeFilter` — it is a DOM-window property, NOT a Node
// global; the server route runs `new JSDOM()` in plain Node where
// `NodeFilter` is undefined ⇒ the bare global threw on EVERY
// formula render (P4a dual-review FAIL-1, masked by the jsdom test
// env). The numeric whatToShow works in every DOM impl.
const SHOW_TEXT = 0x4

// A real display text node has a handful of formulas. A node with
// more is pathological (the FROZEN tokenizer's unclosed-`{=` scan is
// O(n²) — a Track-1-scoped intrinsic, NOT modified here): an O(n)
// pre-count bounds parseInlineAtoms work per node; over the bound we
// skip the node (its `{= }` stay literal — calm §4), never hang.
const MAX_NODE_FORMULAS = 256

function eachFormulaTextNode(
  doc: Document,
  fn: (t: Text, value: string) => void,
): void {
  const root = doc.body ?? doc.documentElement
  if (!root) return
  const walker = doc.createTreeWalker(root, SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = n.nodeValue ?? ''
    if (value.indexOf('{=') === -1) continue // cheap pre-filter
    // O(n) DoS guard: bound `{=` openers before the tokenizer runs.
    let count = 0
    for (
      let k = value.indexOf('{=');
      k !== -1 && count <= MAX_NODE_FORMULAS;
      k = value.indexOf('{=', k + 2)
    ) {
      count++
    }
    if (count > MAX_NODE_FORMULAS) continue // pathological — skip node
    let el = (n as Text).parentElement
    let skip = false
    while (el) {
      if (SKIP_ANCESTORS.has(el.localName.toUpperCase())) {
        skip = true
        break
      }
      el = el.parentElement
    }
    if (!skip) fn(n as Text, value)
  }
}

function formulaAtoms(text: string) {
  // flatMap narrows each atom to the formula variant in the kept
  // branch ⇒ the result is typed with .src/.start/.end.
  return parseInlineAtoms(text).flatMap((a) =>
    a.kind === 'formula' ? [a] : [],
  )
}

/** Canonical `.src` of every `{= }` formula in display text — the
 *  evalFormulas key + the editor's key (one key, one parser). */
export function harvestFormulaSrcsFromDoc(doc: Document): string[] {
  const out = new Set<string>()
  eachFormulaTextNode(doc, (_t, value) => {
    for (const a of formulaAtoms(value)) out.add(a.src)
  })
  return Array.from(out)
}

/** Substitute each `{= }` formula token in a TEXT NODE with
 *  `lookup(src)`. Mutates `doc` in place; the caller serializes
 *  (serialization escapes ⇒ markup-in-value inert). `lookup` MUST
 *  already be fail-soft (null/error ⇒ `—`); a raw error string must
 *  never reach here (same boundary as evalQueryBlocks). */
export function resolveFormulasInDoc(
  doc: Document,
  lookup: (src: string) => string,
): void {
  eachFormulaTextNode(doc, (t, value) => {
    const atoms = formulaAtoms(value).sort((a, b) => a.start - b.start)
    if (atoms.length === 0) return
    let out = ''
    let cur = 0
    for (const a of atoms) {
      if (a.start < cur) continue // defensive: never overlap
      out += value.slice(cur, a.start) + lookup(a.src)
      cur = a.end
    }
    out += value.slice(cur)
    t.nodeValue = out
  })
}

/** number|string ⇒ text; null/undefined ⇒ the calm `—` (the §3 /
 *  Phase-4 fail-soft floor — a raw error NEVER on the wire). */
export function formulaValueToText(v: number | string | null | undefined): string {
  return v == null ? '—' : String(v)
}

// ─────────────────────────────────────────────────────────────────
// D4.10 — generalized atom walker. Same shape as
// `eachFormulaTextNode` above but uses a broader pre-filter that
// catches value atoms `{key: value}` in addition to formulas. Used
// by `resolveAtomsInDoc` below to render the editor-pill equivalent
// in HTML atoms (so `{clients: Acme}` renders as just "Acme" in
// the iframe, matching what the user sees in the markdown editor).
// ─────────────────────────────────────────────────────────────────

// `{` followed by `=`, an identifier start, or `\\` (for an escape
// inside a value) — matches both `{= sum(...)}` and `{key: value}`.
// `body { color: red }` (CSS with leading whitespace) is NOT
// matched because the char after `{` is a space, not `=`/ident.
const ATOM_HINT_RE = /\{[=A-Za-z_\\]/

// Bound atoms per text node (DoS class — see MAX_NODE_FORMULAS).
const MAX_NODE_ATOMS = 512

function eachAtomTextNode(
  doc: Document,
  fn: (t: Text, value: string) => void,
): void {
  const root = doc.body ?? doc.documentElement
  if (!root) return
  const walker = doc.createTreeWalker(root, SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = n.nodeValue ?? ''
    if (!ATOM_HINT_RE.test(value)) continue // cheap pre-filter
    // O(n) DoS guard (mirrors eachFormulaTextNode): bound `{`
    // openers so a pathological text node doesn't drive the parser
    // beyond its O(n²) unclosed-`{=` worst case.
    let count = 0
    for (
      let k = value.indexOf('{');
      k !== -1 && count <= MAX_NODE_ATOMS;
      k = value.indexOf('{', k + 1)
    ) {
      count++
    }
    if (count > MAX_NODE_ATOMS) continue
    let el = (n as Text).parentElement
    let skip = false
    while (el) {
      if (SKIP_ANCESTORS.has(el.localName.toUpperCase())) {
        skip = true
        break
      }
      el = el.parentElement
    }
    if (!skip) fn(n as Text, value)
  }
}

/** D4.10 — substitute ALL `{}` atoms (value + formula) in text
 *  nodes with their rendered text. `formulaLookup(src)` resolves
 *  `{= ... }` formulas; value atoms render via the shared
 *  `formatValueAtomText` formatter (same as the editor pill).
 *  `{identifier}` live-totals are LEFT AS LITERAL (legacy form —
 *  per the system prompt, do not author it; existing legacy bodies
 *  keep their bare text rather than breaking).
 *
 *  Same DOM contract as resolveFormulasInDoc: writes into
 *  `nodeValue` ⇒ the value is TEXT ⇒ the DOM serializer escapes
 *  `& < >` ⇒ a resolved value containing markup is inert by
 *  construction. */
export function resolveAtomsInDoc(
  doc: Document,
  formulaLookup: (src: string) => string,
): void {
  eachAtomTextNode(doc, (t, value) => {
    const atoms = parseInlineAtoms(value).sort((a, b) => a.start - b.start)
    if (atoms.length === 0) return
    let out = ''
    let cur = 0
    for (const a of atoms) {
      if (a.start < cur) continue // defensive: never overlap
      out += value.slice(cur, a.start)
      if (a.kind === 'formula') {
        out += formulaLookup(a.src)
      } else if (a.kind === 'value') {
        out += formatValueAtomText(a.value, a.valueType)
      } else {
        // liveTotal — keep literal source text. (Legacy form.)
        out += value.slice(a.start, a.end)
      }
      cur = a.end
    }
    out += value.slice(cur)
    t.nodeValue = out
  })
}
