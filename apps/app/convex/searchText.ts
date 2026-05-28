// Derived search fields for the `atoms` table — pure and server-safe
// (Convex isolates have NO DOM, so HTML→text is regex-based, not jsdom).
//
// Convex full-text search indexes ONE field, so we maintain a derived
// `searchText` (title-weighted + path + plaintext body) plus a `searchable`
// flag, recomputed at EVERY atom path/body write. See
// docs/development/search-plan.md and the audit test in
// src/__tests__/searchWriteAudit.test.ts.

import { MAP_PATH } from './inlineAtom'
import {
  splitFrontmatter,
  isHtmlAtomBody,
  isHtmlPath,
  deriveTitle,
} from './atomId'

// Cap indexed plaintext: `searchText` duplicates body bytes on the same
// row, so this avoids relevance dilution on huge docs.
export const MAX_PLAINTEXT = 128_000

// `searchText` lives on the same row as `body`, so body + searchText must
// stay under Convex's 1 MB document limit. We budget by UTF-8 BYTES (not
// JS chars — multibyte content like CJK is up to 4× larger), so a big body
// shrinks the indexed text and the write can never be the thing that trips
// the limit. ROW_BUDGET leaves headroom for the row's other small fields.
const ROW_BUDGET_BYTES = 900_000

const ENC = new TextEncoder()
const byteLen = (s: string): number => ENC.encode(s).length

/** Largest prefix of `s` that fits within `maxBytes` UTF-8 bytes. */
function sliceToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (byteLen(s) <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo)
}

function safeCodePoint(n: string): string {
  const code = Number(n)
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ' '
  try {
    return String.fromCodePoint(code)
  } catch {
    return ' '
  }
}

/** HTML → best-effort visible text (regex; no DOM in the Convex runtime). */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#0*39);/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(n))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Markdown → readable text. Light strip — keep words, headings, link text,
 *  and ASCII-sketch art (the ` ```ascii ` fence markers go, the art stays);
 *  don't over-normalize. */
export function markdownToText(md: string): string {
  return md
    .replace(/^[ \t]*```[^\n]*$/gm, '') // fence marker lines; keep inner content
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a) // wikilinks
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // ATX heading markers
    .replace(/^\s*>\s?/gm, '') // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, '') // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, '') // ordered list markers
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '') // horizontal rules
    .replace(/[*_~]{1,3}/g, '') // emphasis markers
    // NB: do NOT collapse runs of spaces — ASCII sketches rely on exact
    // alignment, and whitespace is irrelevant to search tokenization.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plaintext projection of an atom body, used for indexing AND snippets. */
export function atomPlaintext(path: string, body: string): string {
  const { rest } = splitFrontmatter(body ?? '')
  return isHtmlPath(path) || isHtmlAtomBody(body)
    ? htmlToText(rest)
    : markdownToText(rest)
}

/** Filename leaf without its extension (e.g. `clients/Acme.md` → `Acme`). */
export function basename(path: string): string {
  const leaf = path.split('/').pop() ?? path
  return leaf.replace(/\.[a-z0-9]+$/i, '') || leaf
}

/** Whether an atom appears in search. Excludes ONLY the derived index
 *  `_map.md`; INCLUDES html / markdown / user files. (Do NOT reuse
 *  `isNonDataAtom` — it excludes html atoms, which we must search.) */
export function isAtomSearchable(path: string): boolean {
  return path !== MAP_PATH
}

/** The derived fields to write on every atom path/body change. */
export function deriveSearchFields(
  path: string,
  body: string,
): { searchText: string; searchable: boolean } {
  if (!isAtomSearchable(path)) return { searchText: '', searchable: false }
  const title = deriveTitle(body, path) ?? basename(path)
  // Title ×3 + basename + path + plaintext. The repetition only nudges
  // Convex relevance; the query-side post-rank is the reliable title boost.
  const head = `${title}\n${title}\n${title}\n${basename(path)}\n${path}\n`
  // Bytes available for searchText so body + searchText < the doc limit.
  const budget = ROW_BUDGET_BYTES - byteLen(body)
  // Body alone is already huge → skip indexing rather than risk the write.
  if (budget <= 0) return { searchText: '', searchable: true }
  // Char-cap the plaintext first (bounds the byte-measuring cost), then
  // byte-trim the composed text to fit the budget exactly.
  const plain = atomPlaintext(path, body).slice(0, MAX_PLAINTEXT)
  const searchText = sliceToBytes(head + plain, budget)
  return { searchText, searchable: true }
}

/** Normalize a raw query into a Convex search string: lowercased, ≤16
 *  whitespace terms (Convex caps terms/query at 16). */
export function normalizeQuery(q: string): string {
  return (q ?? '')
    .toLowerCase()
    .split(/\s+/)
    // Drop punctuation-only tokens so a query like "???" yields no terms
    // (→ the caller shows recent docs instead of an empty FTS result).
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 16)
    .join(' ')
}

/** Split a normalized query into its terms. */
export function queryTerms(q: string): string[] {
  const n = normalizeQuery(q)
  return n ? n.split(' ') : []
}

export type SnippetPart = { s: string; hit: boolean }

/**
 * A highlighted snippet window around the first query-term match, returned
 * as escaped text parts (`hit` marks the matched runs). Never returns raw
 * HTML — the client wraps `hit` parts. Approximates Convex tokenization by
 * lowercasing + substring/prefix matching the terms.
 */
export function snippetParts(
  plain: string,
  query: string,
  window = 220,
): SnippetPart[] {
  const text = (plain ?? '').replace(/\s+/g, ' ').trim()
  const terms = queryTerms(query)
  if (!text) return []
  const lower = text.toLowerCase()
  let first = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i !== -1 && (first === -1 || i < first)) first = i
  }
  const start = first === -1 ? 0 : Math.max(0, first - 60)
  let slice = text.slice(start, start + window)
  if (start > 0) slice = '…' + slice
  if (start + window < text.length) slice = slice + '…'

  const sliceLower = slice.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const t of terms) {
    let from = 0
    for (;;) {
      const i = sliceLower.indexOf(t, from)
      if (i === -1) break
      ranges.push([i, i + t.length])
      from = i + t.length
    }
  }
  if (ranges.length === 0) return [{ s: slice, hit: false }]
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const parts: SnippetPart[] = []
  let pos = 0
  for (const [a, b] of merged) {
    if (a > pos) parts.push({ s: slice.slice(pos, a), hit: false })
    parts.push({ s: slice.slice(a, b), hit: true })
    pos = b
  }
  if (pos < slice.length) parts.push({ s: slice.slice(pos), hit: false })
  return parts
}
