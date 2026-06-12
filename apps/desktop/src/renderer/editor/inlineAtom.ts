// Inline-atom parser — the single source of truth for the v0 grammar.
//
// Contract: docs/strategy/inline-atom-format-v0.md (FROZEN v0).
// This module is intentionally pure and dependency-free so the SAME
// parser is used by both the editor (decoration plugin) and the LLM
// eval harness — never a second, drifting implementation. It NEVER
// throws: anything that does not match is simply not an atom.

export type InlineAtomValueType = 'number' | 'boolean' | 'date' | 'string'

export type InlineAtom =
  | {
      kind: 'value'
      /** doc offset of the opening `{` within the parsed text */
      start: number
      /** doc offset just past the closing `}` */
      end: number
      /** exact source substring, `{`…`}` inclusive — preserved verbatim */
      raw: string
      key: string
      value: string | number | boolean
      valueType: InlineAtomValueType
    }
  | {
      kind: 'liveTotal'
      start: number
      end: number
      raw: string
      /** the bare identifier; dohc fills this — non-authoritative (UC-3) */
      key: string
    }
  | {
      // atom-address-v1 §2 (gate CLEARED v4) — an Excel-style formula:
      // a brace whose trimmed body begins with `=`. PARSE-ONLY in
      // Track-1 Phase 2 (no eval, no editor render — Phase 3). The
      // `=` sigil makes this unambiguous vs the FROZEN value/liveTotal
      // rules (§2.1) — `{e.g}`, `{sum(total)}`, `{a.b}` WITHOUT a
      // leading `=` are NOT atoms, exactly as v0.
      kind: 'formula'
      start: number
      end: number
      raw: string
      /** aggregate fn, or null ⇒ the bare address value itself */
      fn: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'latest' | null
      /** dotted address / glob (the target); `segments` = split on `.` */
      address: string
      segments: string[]
      /** optional filter — Phase 3 applies it */
      predicate: { key: string; op: string; value: string } | null
      /** exact expr text after `=` (trimmed) — Phase-3 eval input */
      src: string
    }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const NUMBER = /^-?\d+(\.\d+)?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

// ASCII punctuation (incl. braces) — used to recognise an escaped
// punctuation char in PROSE so it never opens an atom.
const ASCII_PUNCT = /[!-/:-@[-`{-~]/
// Round-trip-escapable set: ASCII punctuation EXCLUDING `{` and `}`.
// A markdown serializer (mdast-util-to-markdown, which markdown serializer
// uses) escapes `_ * \` [ ] …` to avoid accidental emphasis/links — so
// a saved `{billable_this_week}` comes back as `{billable\_this\_week}`.
// Inside an atom body we unescape these so the atom survives the
// round-trip. Braces are NOT in this set: serializers don't escape
// them, and an escaped brace inside a body is handled by the contract
// rule (only `\}` is a literal `}` in a string; `\{` ⇒ not an atom).
const ESCAPABLE = /[!-/:-@[-`|~]/
/** True if text[i] is a backslash escaping an ASCII-punct at i+1.
 *  Exported so the eval scorer's brace-scan uses the SAME prose-escape
 *  rule (no parser/scorer drift). */
function isEscaped(text: string, i: number): boolean {
  return (
    text[i] === '\\' && i + 1 < text.length && ASCII_PUNCT.test(text[i + 1])
  )
}

/**
 * Parse every inline atom in a run of prose text.
 *
 * The caller is responsible for the "code is verbatim" contract rule:
 * only pass prose text (never inline-code / code-block content).
 */
export function parseInlineAtoms(text: string): InlineAtom[] {
  const out: InlineAtom[] = []
  const len = text.length
  let i = 0

  while (i < len) {
    const ch = text[i]

    // An escaped punctuation char is literal and never opens an atom.
    if (isEscaped(text, i)) {
      i += 2
      continue
    }

    if (ch !== '{') {
      i += 1
      continue
    }

    // Candidate atom: scan to the first unescaped `}`. Any brace in
    // the body (escaped `\{`, or an unescaped `{`/extra `}`) ⇒ the
    // span is structure, not an atom (contract: no nesting; the only
    // brace exemption is `\}` = a literal `}` inside a string value).
    let j = i + 1
    let sawBrace = false
    let inner = ''
    let closed = -1

    while (j < len) {
      const c = text[j]
      const n = text[j + 1]
      if (c === '\\' && n === '}') {
        // contract: a literal `}` is allowed inside a string value
        inner += '}'
        j += 2
        continue
      }
      if (c === '\\' && n === '{') {
        // a brace in the body ⇒ not an atom (contract)
        sawBrace = true
        j += 2
        continue
      }
      if (c === '\\' && n !== undefined && ESCAPABLE.test(n)) {
        // markdown-serializer escape → unescape for round-trip
        inner += n
        j += 2
        continue
      }
      if (c === '{') {
        sawBrace = true
        j += 1
        continue
      }
      if (c === '}') {
        closed = j
        break
      }
      inner += c
      j += 1
    }

    if (closed === -1) {
      // no closing brace — `{` is literal text
      i += 1
      continue
    }
    if (sawBrace) {
      // a brace in the body ⇒ structure, not an atom; skip the span
      i = closed + 1
      continue
    }

    const atom = parseInner(inner, i, closed + 1, text.slice(i, closed + 1))
    if (atom) out.push(atom)
    // Whether it matched or not, the `{…}` span had no nested braces,
    // so there is nothing else to find inside it.
    i = closed + 1
  }

  return out
}

function parseInner(
  inner: string,
  start: number,
  end: number,
  raw: string,
): InlineAtom | null {
  const body = inner.trim()
  if (body.length === 0) return null

  // §2.1 precedence ROW 1 — a body beginning with `=` is a FORMULA,
  // and only then. Checked BEFORE the FROZEN colon/identifier rules
  // so the sigil can never be mis-read as a value/liveTotal, and a
  // no-sigil `{e.g}`/`{sum(total)}`/`{a.b}` stays exactly v0
  // (not-an-atom). Malformed formula ⇒ null (fail-soft, never throws).
  if (body[0] === '=') return parseFormula(body, start, end, raw)

  const colon = body.indexOf(':')

  // Live-total: a bare identifier, no colon.
  if (colon === -1) {
    if (!IDENT.test(body)) return null
    return { kind: 'liveTotal', start, end, raw, key: body }
  }

  // Value: key : scalar
  const key = body.slice(0, colon).trim()
  const rawValue = body.slice(colon + 1).trim()
  if (!IDENT.test(key) || rawValue.length === 0) return null

  // Contract: a value is exactly ONE scalar — never an array/object.
  // An unquoted value that looks like a list/array (`[a,b]`) is
  // structure → not an atom (block views handle structure).
  if (rawValue[0] === '[') return null

  // Quoted string — explicit string, no scalar coercion.
  const q = rawValue[0]
  if (
    (q === '"' || q === "'") &&
    rawValue.length >= 2 &&
    rawValue[rawValue.length - 1] === q
  ) {
    return {
      kind: 'value',
      start,
      end,
      raw,
      key,
      value: rawValue.slice(1, -1),
      valueType: 'string',
    }
  }

  if (NUMBER.test(rawValue)) {
    return {
      kind: 'value',
      start,
      end,
      raw,
      key,
      value: Number(rawValue),
      valueType: 'number',
    }
  }
  if (rawValue === 'true' || rawValue === 'false') {
    return {
      kind: 'value',
      start,
      end,
      raw,
      key,
      value: rawValue === 'true',
      valueType: 'boolean',
    }
  }
  if (DATE.test(rawValue)) {
    return { kind: 'value', start, end, raw, key, value: rawValue, valueType: 'date' }
  }
  // Bare string.
  return { kind: 'value', start, end, raw, key, value: rawValue, valueType: 'string' }
}

// atom-address-v1 §2 — the formula grammar (PARSE-ONLY, Phase 2).
// PURE, never throws: anything malformed ⇒ null (not an atom), per
// the frozen parser invariant. Phase 3 evaluates the returned AST;
// nothing here resolves, reads the DB, or renders.
//
//   formula := '=' WS* ( CALL | ADDRESS )
//   CALL    := FN '(' WS* ADDRESS ( WS+ ['where' WS+] PRED )? WS* ')'
//   FN      := sum | count | avg | min | max | latest
//   ADDRESS := SEG ('.' SEG)*          SEG := [A-Za-z0-9_]+'*'? | '*'
//   PRED    := KEY OP LITERAL          KEY := [A-Za-z_][A-Za-z0-9_]*
//   OP      := == | != | >= | <= | = | > | <
//
// DOC-RECONCILIATION (ALL FOUR surfaced for the Phase-2 dual review,
// like the Phase-1 digit-leading-fileid one — not silently guessed;
// disclosure-parity per the independent P2-build SHOULD-FIX). The doc
// is internally inconsistent / under-specified in four places; each
// resolved by the minimal forgiving reading, none requiring a
// design-gate re-entry (the doc's own examples force these):
//   1. PREDICATE SEPARATOR — §2's grammar comment writes
//      `where status=active`; example 264 writes
//      `projects.* status = active` (no `where`). Resolution:
//      whitespace is canonical; a leading `where ` is OPTIONALLY
//      accepted so BOTH doc spellings parse.
//   2. SEG GRAMMAR — SEG allows a leading digit + a trailing `*`
//      prefix-glob (`2025_07_*`) per the Phase-1 file-id namespace
//      and §2.2's date story (§1's strict `[A-Za-z_]…` KEY grammar
//      cannot express the doc's own dated examples).
//   3. OP SET — §2 line 259 lists `= != > < >= <=`. We ALSO accept
//      `==` as a forgiving alias of `=` (Excel/JS muscle memory);
//      the doc set is the canonical minimum, `==` is a superset.
//   4. KEY-LESS ADDRESS — §1 mandates `address := … '.' KEY` (a
//      trailing value-key), but §2's `count(projects.*)` example
//      (264) and `glob := address` (257) take a KEY-less address.
//      The parser accepts a KEY-less / `*`-terminal address
//      UNIFORMLY (it cannot, parse-only, know per-fn arity); the
//      final segment is intentionally NOT constrained to the frozen
//      KEY grammar here. Per-fn KEY-arity (count→files vs sum→a
//      numeric value-key) is a PHASE-3 eval concern, not a parse
//      one. This is faithful to §2's example, not a guess.
// Reviewers: bless or correct any of the four.
const FORMULA_FN = new Set([
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'latest',
])
// ReDoS-safe: a single char-class with one optional trailing `*` and
// `$` — no nested/ambiguous quantifier, linear.
const ADDR_SEG = /^(?:[A-Za-z0-9_]+\*?|\*)$/
// ReDoS-safe: `(.+)$` is GREEDY (linear), trimmed in code — NOT the
// prior lazy `(.+?)\s*$` whose `\s*…*?…\s*` partition backtracked
// (the project's documented humanizeQuery ReDoS class). The fn name
// and call structure are parsed STRUCTURALLY (indexOf/slice), never
// by a backtracking `^([a-z]+)\(\s*([\s\S]*?)\s*\)$` (Codex P2-build
// dispositive: that froze the editor on `{= sum(<many spaces>x}`).
const PRED_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|=|>|<)\s*(.+)$/s
const FN_NAME_RE = /^[a-z]{1,16}$/
// A formula is tens of chars; reject anything absurd (fail-soft —
// renders as literal text). Bounds every subsequent scan so even an
// O(n^2) regex over the remainder is trivially fast. Same posture as
// the humanizeQuery length-cap fix.
const FORMULA_MAX = 400

function validAddress(addr: string): string[] | null {
  if (addr.length === 0) return null
  const segs = addr.split('.')
  for (const s of segs) if (!ADDR_SEG.test(s)) return null
  return segs
}

function parseFormula(
  body: string,
  start: number,
  end: number,
  raw: string,
): InlineAtom | null {
  const src = body.slice(1).trim() // drop the leading `=`
  if (src.length === 0 || src.length > FORMULA_MAX) return null

  let fn: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'latest' | null = null
  let addressStr = src
  let predicate: { key: string; op: string; value: string } | null = null

  // STRUCTURAL call detection — linear (indexOf/slice/search), no
  // backtracking regex (Codex P2-build dispositive ReDoS fix).
  const lparen = src.indexOf('(')
  if (lparen === -1) {
    // bare address — a stray `)` with no `(` is malformed.
    if (src.includes(')')) return null
  } else {
    if (!src.endsWith(')')) return null
    const name = src.slice(0, lparen)
    if (!FN_NAME_RE.test(name) || !FORMULA_FN.has(name)) return null
    fn = name as 'sum' | 'count' | 'avg' | 'min' | 'max' | 'latest'
    const inside = src.slice(lparen + 1, src.length - 1).trim()
    if (inside.length === 0) return null
    // §2.3 "no nested calls / not Turing-complete" is enforced
    // STRUCTURALLY by validAddress (a `fn(...)`-shaped segment is not
    // a valid ADDR_SEG, so `sum(avg(x))` → addressStr `avg(x)` →
    // rejected). We do NOT blanket-ban parens here: a quoted
    // predicate value may legitimately contain `(`/`)`
    // (`note = "in (review)"`) — that was accepted pre-fold and the
    // blanket check wrongly regressed it (Codex P2-fold).
    // address = first whitespace-delimited token; an optional
    // (`where`-prefixed) predicate follows. Split STRUCTURALLY.
    const sp = inside.search(/\s/)
    if (sp === -1) {
      addressStr = inside
    } else {
      addressStr = inside.slice(0, sp)
      let predStr = inside.slice(sp + 1).trim()
      if (predStr.slice(0, 6).toLowerCase() === 'where ') {
        predStr = predStr.slice(6).trim()
      }
      const p = PRED_RE.exec(predStr)
      if (!p) return null
      let val = p[3].trim()
      if (
        val.length >= 2 &&
        (val[0] === '"' || val[0] === "'") &&
        val[val.length - 1] === val[0]
      ) {
        val = val.slice(1, -1)
      }
      predicate = { key: p[1], op: p[2], value: val }
    }
  }

  const segments = validAddress(addressStr)
  if (!segments) return null

  return {
    kind: 'formula',
    start,
    end,
    raw,
    fn,
    address: addressStr,
    segments,
    predicate,
    src,
  }
}

