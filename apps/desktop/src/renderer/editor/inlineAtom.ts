// Inline-atom parser — the single source of truth for the v0 grammar.
//
// Contract: docs/strategy/inline-atom-format-v0.md (FROZEN v0).
// This module is intentionally pure and dependency-free so the SAME
// parser is used by both the editor (decoration plugin) and the LLM
// eval harness — never a second, drifting implementation. It NEVER
// throws: anything that does not match is simply not an atom.

export type InlineAtomValueType = 'number' | 'boolean' | 'date' | 'string'

export type InlineAtom =
  {
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

  const colon = body.indexOf(':')

  // Only explicit key/value captures are structured; bare identifiers and
  // expression-like braces remain ordinary prose.
  if (colon === -1) return null

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
