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
export function isEscaped(text: string, i: number): boolean {
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

/**
 * Parse a formula from its CANONICAL `src` (the post-`=` expr the
 * parser produces — already unescaped). The escape-invariant key for
 * on-view eval (Phase-3 dual-review BLOCKER): the raw `{= … }` token
 * differs escaped (markdown source, `2025\_07\_\*`) vs unescaped
 * (ProseMirror doc text), but `.src` is identical from BOTH because
 * parseInlineAtoms unescapes during the brace scan. So query-side and
 * widget-side both key by `.src`. Pure; null if not a valid formula.
 */
export function parseFormulaFromSrc(src: string): InlineAtom | null {
  return parseFormula('=' + src, 0, 0, '')
}

// ── Prose-only scanning (FROZEN contract: "Atoms are recognised only
// in prose text — never inside inline code spans or fenced/code
// blocks. Implementations apply the parser to text nodes only.")
//
// The editor gets this from ProseMirror text nodes (skipping code
// marks). Server-side scanners (live-total rollups, the weekly
// reconcile) MUST get the SAME guarantee or `{billable: 999}` /
// `{goal_x: 1}` inside ANY code container becomes phantom data.
//
// Phase-4 review (Codex MED): a regex code-masker is whack-a-mole —
// it under-masked tilde fences in blockquotes/lists and indented
// code blocks (exactly the brittle hand-rolled markdown the
// inline-atom contract exists to avoid). So use the canonical
// micromark CommonMark parser (`mdast-util-from-markdown`, a locked
// transitive dep of remark-gfm) and feed the SINGLE atom parser ONLY
// real text nodes — skipping `code` (fenced + indented), `inlineCode`
// and `html`. Robust for every CommonMark code container, no
// edge-case chase. (Tracked: promote mdast-util-from-markdown to a
// direct package.json dependency — currently relied on via the
// remark-gfm lock entry.)
import { fromMarkdown } from 'mdast-util-from-markdown'

type MdNode = {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/**
 * The SINGLE FROZEN parser, run INDEPENDENTLY per CommonMark `text`
 * node — NEVER on a joined string. Phase-4 review (Codex MED): joining
 * text across inline children (emphasis, links) fabricates/corrupts
 * atoms — `{hours: *6*}` would split into `{hours: ` + `6` + `}` and
 * rejoin into a clean false `hours=6`. By the FROZEN grammar an atom
 * always lies within ONE text node, so per-node parsing loses nothing
 * real and cannot forge across nodes. Skips `code` (fenced +
 * indented), `inlineCode`, `html`, and autolinks (a `<url>` whose text
 * == its url is not prose). Mirrors the editor's "atoms live in text
 * nodes, skip code marks" recognition.
 *
 * NOTE: returned atom start/end are per-text-node, NOT document
 * offsets — server callers use only kind/key/value (live-total
 * rollups, the weekly reconcile); the editor has its own ProseMirror
 * walk and does not call this. This is the single correct entry point
 * for server-side markdown body scanning.
 */
/** The tree walk — prose-only (skips code/inlineCode/html, autolink
 *  URLs). Pure; never throws (parse already succeeded). */
function parseInlineAtomsFromTree(root: MdNode): InlineAtom[] {
  const atoms: InlineAtom[] = []
  const walk = (n: MdNode): void => {
    if (n.type === 'code' || n.type === 'inlineCode' || n.type === 'html') {
      return
    }
    // autolink / bare URL: a link whose sole child text equals its url
    if (
      n.type === 'link' &&
      typeof n.url === 'string' &&
      n.children?.length === 1 &&
      n.children[0]?.type === 'text' &&
      n.children[0]?.value === n.url
    ) {
      return
    }
    if (n.type === 'text' && typeof n.value === 'string') {
      for (const a of parseInlineAtoms(n.value)) atoms.push(a)
      return
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  return atoms
}

/**
 * STRICT parse — THROWS if `fromMarkdown` fails. The structural
 * capture / cross-desk gather MUST be able to tell "parsed clean,
 * zero atoms" from "could not parse" (Codex R3-build HIGH: the
 * fail-soft variant below swallows a throw to `[]`, which would make
 * the parse-fail SENTINEL never fire and let a clean-looking empty
 * result clear an existing sentinel). Do NOT use in a rollup/cron.
 */
export function parseInlineAtomsFromMarkdownStrict(md: string): InlineAtom[] {
  const root = fromMarkdown(md ?? '') as unknown as MdNode
  return parseInlineAtomsFromTree(root)
}

/** FAIL-SOFT — never throws (returns `[]` on a parse error). The
 *  correct entry point ONLY for own-desk reads (rollups/cron/loop):
 *  there is no gate there, so over-reading [] is harmless. The
 *  cross-desk gather + structural capture use the WITH-STATUS helper
 *  (which wraps the STRICT parser) so a parse error fails CLOSED. */
export function parseInlineAtomsFromMarkdown(md: string): InlineAtom[] {
  try {
    return parseInlineAtomsFromMarkdownStrict(md)
  } catch {
    return [] // never throw into a rollup/cron — fail-soft
  }
}

// ── R3 — inline-atom → cross-desk window (design v4) ────────────────

/**
 * THE single canonical name of the dohc-generated index note. It is a
 * DERIVED artifact (echoes other notes' text) — NEVER a source of
 * value atoms (double-count guard, Phase-4 Codex HIGH). One exported
 * constant so the own-desk gather, the cross-desk gather, AND the
 * structural write-capture all exclude the SAME path (no drift —
 * R3 §6; previously a literal in liveTotals + a private const in loop).
 */
// D4.10 — shared formatter for a value-atom's `.value` field in
// rendered contexts (editor pill + server-side HTML substitution).
// Mirrors the editor's pill rendering so the HTML view shows the
// same text the user sees while editing.
//   - finite numbers → round to 2 decimals
//   - booleans      → "yes" / "no"
//   - date strings  → pass through (already YYYY-MM-DD)
//   - everything else → String(v)
export function formatValueAtomText(
  v: string | number | boolean,
  valueType: InlineAtomValueType,
): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(Math.round(v * 100) / 100)
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (valueType === 'date' && typeof v === 'string') return v
  return String(v)
}

export const CONTEXT_DIR = '.context'
export const MAP_PATH = `${CONTEXT_DIR}/_map.md`
export const PERSONAL_IDENTITY_PATH = `${CONTEXT_DIR}/me.md`
export const ORG_IDENTITY_PATH = `${CONTEXT_DIR}/company.md`
export const INTENT_PATH = `${CONTEXT_DIR}/intent.md`

/** R3 §5 — write-path / gather caps. `fromMarkdown` is O(bytes), so
 *  the structural capture diff and the cross-desk gather must bound
 *  body size BEFORE parsing. Generous but finite; over-cap fails
 *  closed (write ⇒ parse-fail SENTINEL; gather ⇒ DROP atom sources). */
export const ATOM_BODY_MAX_BYTES = 256 * 1024
export const ATOM_MAX_PER_NOTE = 2000
/** R3 §5 — the THIRD cap (Codex holistic MED): a TOTAL parsed-bytes
 *  budget across all of a desk's notes, enforced BEFORE parsing each.
 *  note-count + per-note-byte alone permit ~SCAN_CAP×256KB ≈ 1.2GB of
 *  markdown in one resolve transaction. Over-budget ⇒ DROP atom
 *  sources (gather) / overflow (consent) — fail-closed, never a throw
 *  escaping the rollup/loop fail-soft contract. */
export const ATOM_TOTAL_BYTES_MAX = 8 * 1024 * 1024

/** UTF-8 byte length — the SINGLE accounting both the gather and the
 *  consent enumeration use (symmetry: report ≡ resolution). */
export function utf8Bytes(s: string): number {
  return typeof Buffer !== 'undefined'
    ? Buffer.byteLength(s, 'utf8')
    : new TextEncoder().encode(s).length
}

/**
 * R3 §8 — `refKey(kind,ref,key)` uses `U+0000` as its in-memory Set
 * delimiter; for kind:'atom' `ref` is the RAW note path (free-form,
 * unlike canonical entity ids). A path containing the NUL delimiter
 * could (with a pathological key) alias a different (path,key) in the
 * gate set. So a NUL note path is REJECTED at the write/agent surface
 * and FAILS CLOSED (skipped ⇒ its values never cross) at gather/
 * report. (Keys are IDENT-grammar so this is defence-in-depth, but
 * the design mandates the explicit guard rather than an implicit
 * argument — Codex R3-build.)
 */
export function isSafeAtomPath(path: string): boolean {
  return !path.includes('\u0000')
}

/**
 * R3 §5 — parse WITH STATUS (NOT the swallow-to-`[]`
 * `parseInlineAtomsFromMarkdown`, which is fail-SOFT and correct only
 * for own-desk reads). The structural write-capture MUST distinguish
 * "parsed clean, zero atoms" from "could not parse / too big" — the
 * latter fails CLOSED (a parse-fail sentinel withholds the whole
 * note), never silently records no withhold (that would be the
 * C2-for-atoms leak). `ok:false` ⇒ caller records the sentinel.
 */
export function parseInlineAtomsFromMarkdownWithStatus(
  md: string,
):
  | { ok: true; atoms: InlineAtom[] }
  | { ok: false; reason: 'too-big' | 'parse-error' } {
  const text = md ?? ''
  // byte length (UTF-8) — a few huge notes must fail closed too, not
  // just many notes (row-count alone doesn't bound parse cost).
  if (
    (typeof Buffer !== 'undefined'
      ? Buffer.byteLength(text, 'utf8')
      : new TextEncoder().encode(text).length) > ATOM_BODY_MAX_BYTES
  ) {
    return { ok: false, reason: 'too-big' }
  }
  let atoms: InlineAtom[]
  try {
    // STRICT (no-swallow) — a real `fromMarkdown` throw MUST surface
    // as ok:false so the parse-fail sentinel fires (Codex R3-build
    // HIGH: the fail-soft variant returns [] on a throw, which would
    // be indistinguishable from "clean, zero atoms").
    atoms = parseInlineAtomsFromMarkdownStrict(text)
  } catch {
    return { ok: false, reason: 'parse-error' }
  }
  if (atoms.length > ATOM_MAX_PER_NOTE) return { ok: false, reason: 'too-big' }
  return { ok: true, atoms }
}

/**
 * R3 §2 — the ORDERED per-key occurrence sequence of `kind:'value'`
 * atoms. NOT a multiset: `resolveWindow` projects same-key atoms in
 * parse order (last wins for a non-aggregate window), so reordering
 * `{status:old}{status:new}` → `{status:new}{status:old}` flips the
 * shared view and MUST re-withhold. The canonical token
 * `${valueType}\u0000${value}` also catches value-type flips
 * (`{h:6}`→`{h:"6"}`) which change a `sum`. Aggregates (sum/count)
 * are order-free so own-desk parity still holds. liveTotal atoms are
 * NOT values — excluded (they are non-authoritative placeholders).
 */
export function atomValueKeySeq(atoms: InlineAtom[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const a of atoms) {
    if (a.kind !== 'value') continue
    const tok = `${a.valueType}\u0000${String(a.value)}`
    const seq = m.get(a.key)
    if (seq) seq.push(tok)
    else m.set(a.key, [tok])
  }
  return m
}

/** Ordered-sequence equality for one key's occurrence list. */
export function atomSeqEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
