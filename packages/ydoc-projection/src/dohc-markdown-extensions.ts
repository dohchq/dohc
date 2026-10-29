// The dohc Markdown schema and tokenizers, without the Y.Doc conversions.
// Every surface that builds a dohc schema imports its definitions from here,
// so a fix to a tokenizer reaches the editor and the projection together.
import { Extension, Mark, Node, markInputRule } from '@tiptap/core'
import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { getDefaults, Lexer, Tokenizer, type Token, type Tokens } from 'marked'
import { preprocessTablePipes, Table } from '@tiptap/extension-table'
import { ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { sanitizeImageSrc } from './image-src.js'
import { TABLE_ROW_HEIGHTS_RE, tableRowHeight, tableRowHeights } from './table-row-heights.js'

function firstTokenMatch(src: string, pattern: RegExp): RegExpMatchArray | null {
  const match = src.match(pattern)
  return match?.index === 0 ? match : null
}

// marked asks each inline extension where it may start in the rest of a text
// before each run of plain text it reads, so a search to the end each time
// reads a paragraph of short runs, such as lines that end in hard breaks,
// quadratically. While a lexer reads a text between `enterInlineText` and
// `leaveInlineText`, each search answers from the match it last found in that
// text until the rest passes it.
export type InlineText = {
  text: string
  found?: Map<InlineStart, { from: number; match: number; at: number }>
  // The length of the rest at the lexer's current step, which the importer's
  // first tokenizer records.
  step: number
  searched?: Map<RestSearch, { from: number; at: number }>
  // The address the importer's text rule last found.
  email?: { from: number; at: number; start: number }
  // Where the run of characters an address's local part may hold, that the
  // importer's url rule last measured, ends, and whether an address's
  // domain follows.
  localPart?: { from: number; at: number; address: boolean }
  // The run of one character the importer last measured for marked's
  // emphasis, strikethrough or code span rule.
  run?: { start: number; end: number }
  // Where the white space that ends the text starts.
  blankEnd?: number
  // The text marked masks for its emphasis and strikethrough rules, how much
  // of it their own scans have read, and the rest at the step whose scan the
  // next step counts.
  masked?: string
  scanned?: number
  scanning?: number
}
const inlineTexts = new WeakMap<object, InlineText[]>()
// marked hands an extension's tokenizer the tokens of the text it reads.
const tokenTexts = new WeakMap<object, InlineText>()
// marked asks about the text it reads at each step, so the last lexer to
// enter or leave a text keeps the one it reads, and the last tokens given a
// text keep theirs until they leave it.
let lastLexer: object | undefined
let lastRead: InlineText | undefined
let lastTokens: object | undefined
let lastTokenRead: InlineText | undefined

export function enterInlineText(lexer: object, text: string, tokens: object): void {
  // Every field from the start, so each text has one shape whatever it holds.
  const read: InlineText = {
    text, found: undefined, step: -1, searched: undefined, email: undefined, localPart: undefined, run: undefined,
    blankEnd: undefined, masked: undefined, scanned: undefined, scanning: undefined,
  }
  const texts = inlineTexts.get(lexer)
  if (texts) texts.push(read)
  else inlineTexts.set(lexer, [read])
  tokenTexts.set(tokens, read)
  lastLexer = lexer
  lastRead = lastTokenRead = read
  lastTokens = tokens
}

export function leaveInlineText(lexer: object, tokens: object): void {
  const texts = inlineTexts.get(lexer)
  texts?.pop()
  tokenTexts.delete(tokens)
  lastLexer = lexer
  lastRead = texts?.at(-1)
  if (tokens === lastTokens) lastTokens = lastTokenRead = undefined
}

/** The text `lexer` is reading, when it records one. */
export function readingInlineText(lexer: object | undefined): InlineText | undefined {
  if (lexer === lastLexer) return lastRead
  return lexer ? inlineTexts.get(lexer)?.at(-1) : undefined
}

function tokenText(tokens: object): InlineText | undefined {
  return tokens === lastTokens ? lastTokenRead : tokenTexts.get(tokens)
}

/** Records `rest`, the rest of the text whose `tokens` a tokenizer is given, as the lexer's current step. */
export function stepInlineText(tokens: object, rest: string): void {
  const read = tokenText(tokens)
  if (read) read.step = rest.length
}

// A start pattern may capture the character before the start as its first
// group. Past the first character of a rest, `^` cannot match, and whether
// the pattern matches depends only on the text from that character on.
export type InlineStart = { first: RegExp; rest: RegExp }

export function inlineStart(pattern: RegExp): InlineStart {
  return { first: new RegExp(pattern.source, 'y'), rest: new RegExp(pattern.source, 'g') }
}

const ESCAPE_START = inlineStart(/\\/)
// The tokenizer alone decides whether a `[[` opens a wikilink. marked's text
// rule stops before every `[` anyway, so a run cut at any `[[` reads the same.
const WIKILINK_START = inlineStart(/\[\[/)
const INLINE_ATOM_START = inlineStart(/\{\{atom:/)
const HIGHLIGHT_START = inlineStart(/(^|[^\\=])==(?!\s)(?!=)/)
// Opening `$` must not be preceded by `\` (escaped) or another `$` (that is
// block/display `$$`), and must be followed by a non-space, non-`$`.
const MATH_INLINE_START = inlineStart(/(^|[^\\$])\$(?=[^\s$])/)

// Where `start` first matches `src`, the rest of the text `lexer` reads, as
// the pattern's own search would find it.
export function findInlineStart(lexer: object | undefined, src: string, start: InlineStart): number {
  const at = (match: RegExpExecArray) => match.index + (match[1]?.length ?? 0)
  start.first.lastIndex = 0
  const first = start.first.exec(src)
  if (first) return at(first)
  const read = readingInlineText(lexer)
  if (!read || read.text.length < src.length) {
    start.rest.lastIndex = 1
    const match = start.rest.exec(src)
    return match ? at(match) : -1
  }
  // The first match from `from` on is still the first from here on if this
  // search starts no earlier than that one and the match does not start
  // before it.
  const from = read.text.length - src.length + 1
  let found = read.found?.get(start)
  if (!found || found.from > from || (found.match >= 0 && found.match < from)) {
    start.rest.lastIndex = from
    const match = start.rest.exec(read.text)
    found = { from, match: match?.index ?? -1, at: match ? at(match) : -1 }
    read.found ??= new Map()
    read.found.set(start, found)
  }
  return found.match < 0 ? -1 : found.at - from + 1
}

// A tokenizer's search for where its token ends, which finds the same place
// from any start before it. marked tries a tokenizer at each place in a
// text, so a search to the end each time would read it quadratically. While
// the importer reads a text, each search answers from its last answer until
// the rest passes it.
export type RestSearch = (text: string, from: number) => number
type Searched = Map<RestSearch, { from: number; at: number }>

function searchFrom(text: string, searched: Searched, from: number, search: RestSearch): number {
  const found = searched.get(search)
  if (!found) {
    const at = search(text, from)
    searched.set(search, { from, at })
    return at
  }
  if (found.from > from || (found.at >= 0 && found.at < from)) {
    found.from = from
    found.at = search(text, from)
  }
  return found.at
}

/** `search` from `from` in `src`, the rest of the text `read` holds. */
export function searchInlineText(read: InlineText, src: string, from: number, search: RestSearch): number {
  const offset = read.text.length - src.length
  const at = searchFrom(read.text, read.searched ??= new Map(), offset + from, search)
  return at < 0 ? -1 : at - offset
}

function searchRest(src: string, tokens: object, from: number, search: RestSearch): number {
  const read = tokenText(tokens)
  return !read || read.text.length < src.length ? search(src, from) : searchInlineText(read, src, from, search)
}

export const nextCharacter = (character: string): RestSearch => (text, from) => text.indexOf(character, from)
const nextBrace = nextCharacter('}')

// marked cuts a paragraph wherever a block may start, and lexes each cut's
// rest anew, so the `$` of `$$$…` or each `$$` line of a paragraph is a step.
// A search to the end of the line or paragraph at each step would read it
// quadratically. While the importer lexes blocks between `enterBlockText` and
// `leaveBlockText`, each search answers from its last answer in that text
// until the rest passes it.
export type BlockText = {
  text: string
  tokens: Token[]
  searched?: Searched
  rest?: string
  heads?: Map<Token, string[]>
  // Whether marked's table rule has found no table at a step of this text.
  tableRefused?: boolean
}
const blockTexts = new WeakMap<object, BlockText[]>()
const tokenBlockTexts = new WeakMap<object, BlockText>()
// As for inline texts, the last lexer to enter or leave a block text keeps
// the one it reads, and the last tokens given one keep theirs.
let lastBlockLexer: object | undefined
let lastBlock: BlockText | undefined
let lastBlockTokens: object | undefined
let lastTokenBlock: BlockText | undefined

export function enterBlockText(lexer: object, text: string, tokens: Token[]): void {
  const read: BlockText = { text, tokens, searched: undefined, rest: undefined, heads: undefined, tableRefused: undefined }
  const texts = blockTexts.get(lexer)
  if (texts) texts.push(read)
  else blockTexts.set(lexer, [read])
  tokenBlockTexts.set(tokens, read)
  lastBlockLexer = lexer
  lastBlock = lastTokenBlock = read
  lastBlockTokens = tokens
}

export function leaveBlockText(lexer: object, tokens: Token[]): void {
  const texts = blockTexts.get(lexer)
  const read = texts?.pop()
  lastBlockLexer = lexer
  lastBlock = texts?.at(-1)
  if (read?.heads) for (const [token, head] of read.heads) token.raw = head.join('') + token.raw
  if (tokenBlock(tokens) === read) {
    tokenBlockTexts.delete(tokens)
    if (tokens === lastBlockTokens) lastBlockTokens = lastTokenBlock = undefined
  }
}

// The block text `lexer` reads.
function readingBlockText(lexer: object | undefined): BlockText | undefined {
  if (lexer === lastBlockLexer) return lastBlock
  return lexer ? blockTexts.get(lexer)?.at(-1) : undefined
}

function tokenBlock(tokens: object): BlockText | undefined {
  return tokens === lastBlockTokens ? lastTokenBlock : tokenBlockTexts.get(tokens)
}

// marked joins each piece of a cut paragraph onto the last with `raw +=`,
// after checking whether that raw ends in a newline, which copies the whole
// joined raw each time. Before each paragraph, the last one keeps only its
// last character, and its block text holds the rest until it ends.
export function shortenLastParagraph(lexer: object | undefined): void {
  const read = readingBlockText(lexer)
  const last = read?.tokens.at(-1)
  if (!read || last?.type !== 'paragraph' || last.raw.length < 2) return
  const head = read.heads?.get(last)
  if (head) head.push(last.raw.slice(0, -1))
  else (read.heads ??= new Map()).set(last, [last.raw.slice(0, -1)])
  last.raw = last.raw.slice(-1)
}

/** Records `rest`, the rest of the text whose `tokens` a block tokenizer is given, as the lexer's current step. */
export function stepBlockText(tokens: object, rest: string): void {
  const read = tokenBlock(tokens)
  if (read) read.rest = rest
}

/** The block text `lexer` reads, when `src` is the rest at its current step. */
export function steppedBlockText(lexer: object | undefined, src: string): BlockText | undefined {
  const read = readingBlockText(lexer)
  return read?.rest === src ? read : undefined
}

/** `search` from `from` in `src`, the rest of the text `read` holds. */
export function searchBlockText(read: BlockText, src: string, from: number, search: RestSearch): number {
  const offset = read.text.length - src.length
  const at = searchFrom(read.text, read.searched ??= new Map(), offset + from, search)
  return at < 0 ? -1 : at - offset
}

// marked asks where a block may start with the rest after the first
// character of its step.
function blockStartText(lexer: object | undefined, src: string): BlockText | undefined {
  const read = readingBlockText(lexer)
  return read?.rest?.length === src.length + 1 ? read : undefined
}

/** `search` from `from` in `src`, through `read` when it holds `src` as its rest. */
function searchBlockRest(read: BlockText | undefined, src: string, from: number, search: RestSearch): number {
  return read ? searchBlockText(read, src, from, search) : search(src, from)
}

// marked asks where a block may start only to cut the paragraph it is about
// to read, and that paragraph ends at the first line holding only spaces. A
// search past that line would read the rest of the document per paragraph.
const paragraphEnd: RestSearch = (text, from) => {
  let lineEnd = text.indexOf('\n', from)
  while (lineEnd >= 0) {
    let next = lineEnd + 1
    while (text[next] === ' ') next += 1
    if (next === text.length || text[next] === '\n') return lineEnd
    lineEnd = text.indexOf('\n', next)
  }
  return -1
}

// A marker at a line start after the first. Its line's newline is in the
// paragraph exactly when the whole marker is.
const mathBlockLine: RestSearch = (text, from) => text.indexOf('\n$$', from)

function mathBlockStart(this: { lexer?: object }, src: string): number {
  if (src.startsWith('$$')) return 0
  const read = blockStartText(this?.lexer, src)
  const line = searchBlockRest(read, src, 0, mathBlockLine)
  if (line < 0) return -1
  const end = searchBlockRest(read, src, 0, paragraphEnd)
  return end >= 0 && end < line ? -1 : line === 0 ? 0 : line + 1
}

// The newline before a line that starts a callout: up to three spaces, `>`,
// at most one white-space character and `[!`.
const calloutLine: RestSearch = (text, from) => {
  for (let marker = text.indexOf('[!', from); marker >= 0; marker = text.indexOf('[!', marker + 2)) {
    let quote = marker - 1
    if (/\s/u.test(text[quote] ?? '')) quote -= 1
    if (text[quote] !== '>') continue
    let lineStart = quote
    while (quote - lineStart < 3 && text[lineStart - 1] === ' ') lineStart -= 1
    if (lineStart - 1 >= from && text[lineStart - 1] === '\n') return lineStart - 1
  }
  return -1
}

function calloutStart(this: { lexer?: object }, src: string): number {
  let quote = 0
  while (quote < 3 && src[quote] === ' ') quote += 1
  if (src[quote] === '>' && (src.startsWith('[!', quote + 1) || (src.startsWith('[!', quote + 2) && /\s/u.test(src[quote + 1]!)))) return 0
  const read = blockStartText(this?.lexer, src)
  const line = searchBlockRest(read, src, 0, calloutLine)
  if (line < 0) return -1
  const end = searchBlockRest(read, src, 0, paragraphEnd)
  return end >= 0 && end < line ? -1 : line === 0 ? 0 : line + 1
}

// The first `]]` after a wikilink's `[[` that no backslash escapes. A run of
// backslashes cannot reach back past the `[[`, so whether one escapes a `]`
// does not depend on where the search starts.
function unescapedClosing(text: string, from: number): number {
  for (let at = text.indexOf(']]', from); at >= 0; at = text.indexOf(']]', at + 1)) {
    let backslashes = 0
    while (at - backslashes > from && text[at - backslashes - 1] === '\\') backslashes += 1
    if (backslashes % 2 === 0) return at
  }
  return -1
}

// A wikilink's `target`/`label` are delimited by `|` and closed by `]]`, so a
// value that itself contains `\`, `]`, or `|` must be backslash-escaped when
// serialized or it would re-parse as a truncated link (e.g. a mention labeled
// `Plan ]] Draft` would close the wikilink early). escape/unescape are inverses
// applied at renderMarkdown/parse time; the node attrs always hold the raw,
// human-readable value.
function escapeWikilinkPart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([\]|])/g, '\\$1')
}

function unescapeWikilinkPart(value: string): string {
  return value.replace(/\\([\\\]|])/g, '$1')
}

function splitWikilinkInner(inner: string): [string, string | null] {
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === '\\') {
      index += 1
      continue
    }
    if (inner[index] === '|') {
      return [
        unescapeWikilinkPart(inner.slice(0, index)),
        unescapeWikilinkPart(inner.slice(index + 1)),
      ]
    }
  }
  return [unescapeWikilinkPart(inner), null]
}

function renderMarkdownImage(attrs: {
  alt?: unknown
  src?: unknown
  title?: unknown
}): string {
  const alt = escapeMarkdownLineBreaks(
    String(attrs.alt ?? '')
      .replaceAll('\\', '\\\\')
      .replaceAll('[', '\\[')
      .replaceAll(']', '\\]'),
  )
  const sanitizedSrc = sanitizeImageSrc(String(attrs.src ?? ''))
  // A destination with spaces is only valid CommonMark inside angle
  // brackets — without them the src would not re-parse and the round-trip
  // would break. Line breaks are handled by escapeMarkdownLineBreaks (they
  // become a literal "\n" sequence), so only inline whitespace matters here.
  const src = /[ \t]/.test(sanitizedSrc)
    ? `<${escapeMarkdownLineBreaks(
        sanitizedSrc
          .replaceAll('\\', '\\\\')
          .replaceAll('<', '\\<')
          .replaceAll('>', '\\>'),
      )}>`
    : escapeMarkdownLineBreaks(
        sanitizedSrc
          .replaceAll('\\', '\\\\')
          .replaceAll('(', '\\(')
          .replaceAll(')', '\\)'),
      )
  const title = typeof attrs.title === 'string' && attrs.title.length > 0
    ? ` "${escapeMarkdownLineBreaks(
        attrs.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
      )}"`
    : ''
  return `![${alt}](${src}${title})`
}

function escapeMarkdownLineBreaks(value: string): string {
  return value
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
}

function imageAltText(token: {
  content?: unknown
  text?: unknown
  tokens?: Array<{ content?: unknown; text?: unknown; value?: unknown }>
}): string {
  if (Array.isArray(token.tokens)) {
    return token.tokens
      .map((child) => String(child.content ?? child.text ?? child.value ?? ''))
      .join('')
  }
  return String(token.content ?? token.text ?? '')
}

function imageTokenAttr(
  token: unknown,
  name: string,
  fallback: unknown,
): string {
  const attrGet = (token as { attrGet?: (name: string) => unknown }).attrGet
  const value = typeof attrGet === 'function' ? attrGet(name) : fallback
  return String(value ?? '')
}

export const DohcImage = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false
          return {
            src: sanitizeImageSrc(dom.getAttribute('src') || ''),
            alt: dom.getAttribute('alt') || '',
            title: dom.getAttribute('title') || null,
          }
        },
      },
    ]
  },

  renderHTML({ node }) {
    const attrs: Record<string, string> = {
      src: sanitizeImageSrc(String(node.attrs.src ?? '')),
      alt: String(node.attrs.alt ?? ''),
    }
    if (typeof node.attrs.title === 'string' && node.attrs.title.length > 0) {
      attrs.title = node.attrs.title
    }
    return ['img', attrs]
  },

  markdownTokenName: 'image',

  parseMarkdown: (token, helpers) =>
    helpers.createNode('image', {
      src: sanitizeImageSrc(imageTokenAttr(token, 'src', token.href)),
      alt: imageAltText(token),
      title: imageTokenAttr(token, 'title', token.title) || null,
    }),

  renderMarkdown: (node) => renderMarkdownImage(node.attrs ?? {}),
})

const DohcEscapedPunctuation = Node.create({
  name: 'escapedPunctuation',
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      value: { default: '' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-dohc-escaped-punctuation]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false
          const value = dom.getAttribute('data-dohc-escaped-punctuation')
          return value != null ? { value } : false
        },
      },
    ]
  },

  renderHTML({ node }) {
    return [
      'span',
      { 'data-dohc-escaped-punctuation': node.attrs.value },
      String(node.attrs.value ?? ''),
    ]
  },

  markdownTokenName: 'dohcEscape',

  markdownTokenizer: {
    name: 'dohcEscape',
    level: 'inline',
    start(this: { lexer?: object }, src: string) {
      return findInlineStart(this.lexer, src, ESCAPE_START)
    },
    tokenize(src) {
      const match = /^\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/.exec(src)
      if (!match) return undefined
      return { type: 'dohcEscape', raw: match[0], value: match[1] }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('escapedPunctuation', {
      value: token.value,
    }),

  renderMarkdown: (node) =>
    `\\${escapeMarkdownLineBreaks(String(node.attrs?.value ?? ''))}`,
})

const DohcWikilink = Node.create({
  name: 'wikilink',
  priority: 1000,
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      target: { default: '' },
      label: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-dohc-wikilink]' }]
  },

  renderHTML({ node }) {
    return [
      'span',
      {
        class: 'dohc-wikilink-pill',
        contenteditable: 'false',
        'data-wikilink-target': node.attrs.target,
        'data-dohc-wikilink': node.attrs.target,
        'data-dohc-wikilink-label': node.attrs.label,
      },
      node.attrs.label || node.attrs.target,
    ]
  },

  markdownTokenizer: {
    name: 'wikilink',
    level: 'inline',
    start(this: { lexer?: object }, src: string) {
      return findInlineStart(this.lexer, src, WIKILINK_START)
    },
    tokenize(src, tokens) {
      if (!src.startsWith('[[')) return undefined
      const closingIndex = searchRest(src, tokens, 2, unescapedClosing)
      if (closingIndex === -1) return undefined
      const raw = src.slice(0, closingIndex + 2)
      const [target, label] = splitWikilinkInner(raw.slice(2, -2))
      return { type: 'wikilink', raw, target, label }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('wikilink', {
      target: token.target,
      label: token.label ?? null,
    }),

  renderMarkdown: (node) => {
    const target = escapeWikilinkPart(String(node.attrs?.target ?? ''))
    const label = node.attrs?.label
    return label
      ? `[[${target}|${escapeWikilinkPart(String(label))}]]`
      : `[[${target}]]`
  },
})

const DohcInlineAtom = Node.create({
  name: 'inlineAtom',
  priority: 1000,
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      atomId: { default: '' },
      params: { default: '' },
      source: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-dohc-inline-atom]' }]
  },

  renderHTML({ node }) {
    return [
      'span',
      {
        'data-dohc-inline-atom': node.attrs.atomId,
        'data-dohc-inline-atom-params': node.attrs.params,
      },
      `{{${node.attrs.source || `atom:${node.attrs.atomId ?? ''}`}}}`,
    ]
  },

  markdownTokenizer: {
    name: 'inlineAtom',
    level: 'inline',
    start(this: { lexer?: object }, src: string) {
      return findInlineStart(this.lexer, src, INLINE_ATOM_START)
    },
    tokenize(src, tokens) {
      if (!src.startsWith('{{atom:')) return undefined
      // An atom ends at its first `}`, which must open its `}}`. Without one
      // there, the pattern below would backtrack through the whole rest.
      const brace = searchRest(src, tokens, 7, nextBrace)
      if (brace < 0 || src[brace + 1] !== '}') return undefined
      const match = firstTokenMatch(src.slice(0, brace + 2), /^\{\{atom:([^}\s]+)([^}]*)\}\}/)
      if (!match) return undefined
      const [raw, atomId = '', params = ''] = match
      return {
        type: 'inlineAtom',
        raw,
        atomId,
        params: params.trim(),
        source: raw.slice(2, -2),
      }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('inlineAtom', {
      atomId: token.atomId,
      params: token.params,
      source: token.source,
    }),

  renderMarkdown: (node) =>
    `{{${node.attrs?.source || `atom:${node.attrs?.atomId ?? ''}`}}}`,
})

// Obsidian callout syntax: a blockquote whose first line is `[!type]` with an
// optional fold flag (`-` folded, `+` open) and an optional title, e.g.
// `> [!note]- My title`. Unknown callout types are preserved verbatim (styled
// like a note but keeping the original type string) so nothing is ever dropped.
// The callout and display math are block nodes. One below the paragraph's
// priority of 1000 keeps the paragraph the block an empty document fills with:
// a callout holds `block+`, so filling with one would recurse without end, as
// a browser's HTML parse of `<!-- note -->` does. It stays above every
// default-priority tokenizer, so the block tokenizers register in the same order.
const CUSTOM_BLOCK_PRIORITY = 999

const DEFAULT_CALLOUT_TYPE = 'note'
const CALLOUT_HEADER_RE = /^\[!([^\]\n]+)\]([+-]?)[ \t]*(.*)$/
const CALLOUT_LINE_RE = /^ {0,3}>/

function stripBlockquotePrefix(line: string): string {
  return line.replace(/^ {0,3}> ?/, '')
}

function normalizeCalloutFold(value: unknown): '' | '-' | '+' {
  return value === '-' || value === '+' ? value : ''
}

function calloutTitleForMarkdown(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

function findClosingHighlight(src: string): number {
  for (let index = 2; index < src.length - 1; index += 1) {
    if (src[index] === '\\') {
      index += 1
      continue
    }
    if (src[index] === '=' && src[index + 1] === '=') return index
  }
  return -1
}

// Every `=` inside highlighted text is backslash-escaped so the inline
// tokenizer's `\`-skipping in findClosingHighlight never mistakes it for a
// closing delimiter. Escaping only runs of `==` is not enough: a single `=`
// sitting next to the closing `==` (e.g. the highlight body `a=`) would
// serialize to `==a===`, whose first `==` scanned from the left closes the mark
// one char early. The base markdown manager renders a mark's inner text
// verbatim (only its opening/closing `==` delimiters come from renderMarkdown),
// so this escaping has to be applied to the highlight-marked text nodes before
// serialization — see escapeHighlightMarkdown below. Each `\=` round-trips back
// through the `dohcEscape` token (an escapedPunctuation node whose
// renderMarkdown re-emits `\=`), so once escaped the text carries no bare `=`.
function escapeHighlightBody(body: string): string {
  return body.replace(/=/g, '\\=')
}

function hasHighlightMark(node: JSONContent): boolean {
  return (node.marks ?? []).some((mark) => mark.type === 'highlight')
}

// Escape literal `==` inside every highlight-marked text node so a highlight
// applied over text containing `==` (only reachable via the toggle command,
// which wraps an arbitrary selection) serializes to an unambiguous, losslessly
// reversible `==a\=\=b==` instead of the ambiguous `==a==b==`. Returns a fresh
// tree; the input JSON is not mutated.
export function escapeHighlightMarkdown(node: JSONContent): JSONContent {
  const next: JSONContent = { ...node }
  if (typeof node.text === 'string' && hasHighlightMark(node)) {
    next.text = escapeHighlightBody(node.text)
  }
  if (Array.isArray(node.content)) {
    next.content = node.content.map(escapeHighlightMarkdown)
  }
  return next
}

// A `\=` inside a highlight must round-trip as a literal `=` in a plain text
// node — not as an escapedPunctuation atom, because the base manager closes and
// reopens marks around every inline atom, which would split the `==...==` span.
// We therefore decode `\=` to this private-use placeholder before tokenizing
// (so marked sees ordinary text, and no bare `==` can re-fire the highlight
// rule), then restore it to `=` in the parsed text nodes.
const HIGHLIGHT_EQUALS_PLACEHOLDER = '\uE010'

function restoreHighlightPlaceholders(nodes: JSONContent[]): JSONContent[] {
  return nodes.map((node) => {
    const next: JSONContent = { ...node }
    if (typeof node.text === 'string' && node.text.includes(HIGHLIGHT_EQUALS_PLACEHOLDER)) {
      next.text = node.text.split(HIGHLIGHT_EQUALS_PLACEHOLDER).join('=')
    }
    if (Array.isArray(node.content)) {
      next.content = restoreHighlightPlaceholders(node.content)
    }
    return next
  })
}

// Inline (non-block) node types this pipeline can emit. Loose inline children
// under a `block+` callout (e.g. a callout nested in a tight list item, where
// marked yields inline text tokens instead of a paragraph) must be wrapped in a
// paragraph or the projection drops them.
const INLINE_CALLOUT_CHILD_TYPES = new Set([
  'text',
  'hardBreak',
  'image',
  'escapedPunctuation',
  'wikilink',
  'inlineAtom',
])

type CalloutParseHelpers = {
  createNode: (
    type: string,
    attrs?: Record<string, unknown>,
    content?: JSONContent[],
  ) => JSONContent
}

function wrapLooseCalloutChildren(
  children: JSONContent[],
  helpers: CalloutParseHelpers,
): JSONContent[] {
  const result: JSONContent[] = []
  let run: JSONContent[] = []
  const flush = () => {
    if (run.length > 0) {
      result.push(helpers.createNode('paragraph', {}, run))
      run = []
    }
  }
  for (const child of children) {
    if (typeof child?.type === 'string' && INLINE_CALLOUT_CHILD_TYPES.has(child.type)) {
      run.push(child)
    } else {
      flush()
      result.push(child)
    }
  }
  flush()
  return result
}

// A line that begins a new block construct, so it must not be absorbed as a
// blockquote-style lazy-continuation line of the callout's trailing paragraph.
const CALLOUT_LAZY_BREAK_RE =
  /^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:```|~~~)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:\*[ \t]*){3,}$|<[a-zA-Z!/])/

// A code fence opener (```/~~~, up to 3 leading spaces, optional info string).
// Returns the fence run so the closer can be length/char-matched.
function calloutFenceOpener(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
  return match ? (match[1] ?? null) : null
}

// A fence closer: same character as the opener, at least as long, nothing but
// trailing whitespace after it.
function isCalloutFenceCloser(line: string, opener: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  if (!match) return false
  const fence = match[1] ?? ''
  return fence[0] === opener[0] && fence.length >= opener.length
}

const DohcCallout = Node.create({
  name: 'callout',
  priority: CUSTOM_BLOCK_PRIORITY,
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      calloutType: { default: DEFAULT_CALLOUT_TYPE },
      title: { default: '' },
      fold: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-dohc-callout]' }]
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        class: 'dohc-callout',
        'data-dohc-callout': '',
        'data-callout-type': String(node.attrs.calloutType ?? DEFAULT_CALLOUT_TYPE),
        'data-fold': normalizeCalloutFold(node.attrs.fold),
        'data-callout-title': String(node.attrs.title ?? ''),
      },
      ['div', { class: 'dohc-callout-body' }, 0],
    ]
  },

  // Block-level tokenizer so plain blockquotes (no `[!type]` first line) fall
  // through to the built-in blockquote tokenizer untouched — we only claim the
  // block when the header line matches, otherwise we return undefined.
  markdownTokenizer: {
    name: 'callout',
    level: 'block',
    start: calloutStart,
    tokenize(src, _tokens, helpers) {
      // The quote marker cannot reach past the first line.
      if (!CALLOUT_LINE_RE.test(src)) return undefined
      const newline = src.indexOf('\n')
      const first = newline < 0 ? src : src.slice(0, newline)
      const header = CALLOUT_HEADER_RE.exec(stripBlockquotePrefix(first))
      if (!header) return undefined
      const lines = src.split('\n')
      let count = 0
      // Track whether an open paragraph is currently continuable, so we only
      // absorb blockquote-style lazy-continuation lines (mirroring CommonMark).
      // A blank inner line, a heading/list/hr/html/nested-quote, or a fenced
      // code block all close the paragraph — only then must an unquoted line not
      // be pulled in. Tracking just "was the last line blank" wrongly absorbed
      // text after a fence/heading whose (non-blank) line left no paragraph open.
      let paragraphOpen = false
      // Non-null while inside a `>`-quoted fenced code block (holds the opener
      // run) so its content lines aren't mistaken for paragraph text.
      let openFence: string | null = null
      const applyInnerLine = (inner: string) => {
        if (openFence !== null) {
          if (isCalloutFenceCloser(inner, openFence)) openFence = null
          paragraphOpen = false
          return
        }
        const opener = calloutFenceOpener(inner)
        if (opener !== null) {
          openFence = opener
          paragraphOpen = false
        } else if (inner.trim() === '' || CALLOUT_LAZY_BREAK_RE.test(inner)) {
          paragraphOpen = false
        } else {
          paragraphOpen = true
        }
      }
      while (count < lines.length) {
        const line = lines[count] ?? ''
        if (CALLOUT_LINE_RE.test(line)) {
          if (count === 0) {
            // The header line reads as paragraph text (a directly following
            // unquoted line still lazily continues it, as before).
            paragraphOpen = true
          } else {
            applyInnerLine(stripBlockquotePrefix(line))
          }
          count += 1
          continue
        }
        if (
          count > 0 &&
          paragraphOpen &&
          line.trim() !== '' &&
          !CALLOUT_LAZY_BREAK_RE.test(line)
        ) {
          // Lazy continuation of the open paragraph — it stays open.
          count += 1
          continue
        }
        break
      }
      if (count === 0) return undefined
      const consumed = lines.slice(0, count)
      const inner = consumed.map(stripBlockquotePrefix)
      const [, calloutType = '', fold = '', title = ''] = header
      const body = inner.slice(1).join('\n')
      return {
        type: 'callout',
        raw: consumed.join('\n'),
        calloutType: calloutType.trim() || DEFAULT_CALLOUT_TYPE,
        fold: normalizeCalloutFold(fold),
        title: title.trim(),
        tokens: body.trim() ? helpers.blockTokens(body) : [],
      }
    },
  },

  parseMarkdown: (token, helpers) => {
    const parsed = token.tokens?.length ? helpers.parseChildren(token.tokens) : []
    const children = wrapLooseCalloutChildren(parsed, helpers)
    return helpers.createNode(
      'callout',
      {
        calloutType: token.calloutType ?? DEFAULT_CALLOUT_TYPE,
        title: token.title ?? '',
        fold: normalizeCalloutFold(token.fold),
      },
      children.length > 0 ? children : [helpers.createNode('paragraph', {}, [])],
    )
  },

  renderMarkdown: (node, helpers) => {
    const calloutType = String(node.attrs?.calloutType ?? DEFAULT_CALLOUT_TYPE)
    const fold = normalizeCalloutFold(node.attrs?.fold)
    const title = calloutTitleForMarkdown(node.attrs?.title)
    const header = `[!${calloutType}]${fold}${title ? ` ${title}` : ''}`
    const prefix = '>'
    const content = node.content ?? []
    const rendered = content.map((child, index) =>
      helpers.renderChild
        ? helpers.renderChild(child, index)
        : helpers.renderChildren([child]),
    )
    // A callout whose only content is an empty paragraph (e.g. a title-only
    // callout) has no body: emit just the header instead of a stray `>` line.
    if (!rendered.some((block) => block.trim() !== '')) {
      return `${prefix} ${header}`
    }
    const blocks = rendered.map((block) =>
      block
        .split('\n')
        .map((line) => (line.trim() === '' ? prefix : `${prefix} ${line}`))
        .join('\n'),
    )
    return `${prefix} ${header}\n${blocks.join(`\n${prefix}\n`)}`
  },
})

// Obsidian/extended-CommonMark `==highlight==`. The base parser has no `==`
// rule, so we register a custom inline tokenizer (mirroring the wikilink hook)
// that requires flanking non-space characters so stray `=` and `a == b` never
// fire, and round-trips nested marks like `**==x==**`.
const DohcHighlight = Mark.create({
  name: 'highlight',

  parseHTML() {
    return [{ tag: 'mark' }, { tag: 'span[data-dohc-highlight]' }]
  },

  renderHTML() {
    return ['mark', { class: 'dohc-highlight', 'data-dohc-highlight': '' }, 0]
  },

  addInputRules() {
    return [
      markInputRule({
        find: /(?:^|\s)(==(?!\s)((?:[^=]+))==)$/,
        type: this.type,
      }),
    ]
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-h': () => this.editor.commands.toggleMark(this.name),
    }
  },

  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start(this: { lexer?: object }, src: string) {
      return findInlineStart(this.lexer, src, HIGHLIGHT_START)
    },
    tokenize(src, _tokens, helpers) {
      if (!src.startsWith('==')) return undefined
      if (src.length < 5) return undefined
      if (/\s/.test(src[2] ?? '')) return undefined
      const closing = findClosingHighlight(src)
      if (closing === -1) return undefined
      if (/\s/.test(src[closing - 1] ?? '')) return undefined
      const raw = src.slice(0, closing + 2)
      const inner = raw.slice(2, -2)
      if (!inner) return undefined
      const decoded = inner.replace(/\\=/g, HIGHLIGHT_EQUALS_PLACEHOLDER)
      return { type: 'highlight', raw, tokens: helpers.inlineTokens(decoded) }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.applyMark(
      'highlight',
      restoreHighlightPlaceholders(helpers.parseInline(token.tokens ?? [])),
    ),

  renderMarkdown: (node, helpers) => `==${helpers.renderChildren(node.content ?? [])}==`,
})

// Obsidian/Pandoc TeX math. Inline `$...$` and block `$$...$$` (single- or
// multi-line). Both are atom nodes carrying the raw TeX in a `tex` attr; the
// original `$`/`$$` delimiters are re-emitted verbatim so the round-trip is
// byte-identical. Rendering the TeX to KaTeX is a desktop-only concern
// (mathRender.ts) — these nodes stay pure so the projection package, which
// never paints a screen, has no KaTeX dependency.
//
// Inline flanking rules mirror Pandoc's `tex_math_dollars` so ordinary prose
// with dollar signs never turns into math:
//   - the opening `$` must be followed by a non-space, non-`$` character,
//   - the closing `$` must be preceded by a non-space character,
//   - the closing `$` must not be immediately followed by a digit.
// So `$5 and $6` and `a $ b` never fire, while `$x$` does. A backslash-escaped
// `\$` is left to the `dohcEscape` token (an escapedPunctuation node), so it
// stays a literal dollar and never opens or closes math — findClosingInlineMath
// skips `\`-escaped characters for the same reason.
function findClosingInlineMath(src: string): number {
  for (let index = 1; index < src.length; index += 1) {
    if (src[index] === '\\') {
      index += 1
      continue
    }
    if (src[index] === '$') return index
  }
  return -1
}

export const DohcMathInline = Node.create({
  name: 'mathInline',
  priority: 1000,
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      tex: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-dohc-math-inline]' }]
  },

  renderHTML({ node }) {
    return [
      'span',
      { class: 'dohc-math dohc-math-inline', 'data-dohc-math-inline': '' },
      `$${String(node.attrs.tex ?? '')}$`,
    ]
  },

  markdownTokenizer: {
    name: 'mathInline',
    level: 'inline',
    start(this: { lexer?: object }, src: string) {
      return findInlineStart(this.lexer, src, MATH_INLINE_START)
    },
    tokenize(src) {
      if (!src.startsWith('$')) return undefined
      const opening = src[1] ?? ''
      // Opening `$` must be followed by a non-space, non-`$` char (a leading
      // `$$` is block/display math, handled by the block tokenizer).
      if (opening === '' || opening === '$' || /\s/.test(opening)) return undefined
      const closing = findClosingInlineMath(src)
      if (closing === -1) return undefined
      // Closing `$` preceded by non-space, and not immediately followed by a
      // digit — so `$20 and $30` stays literal.
      if (/\s/.test(src[closing - 1] ?? '')) return undefined
      if (/\d/.test(src[closing + 1] ?? '')) return undefined
      const raw = src.slice(0, closing + 1)
      const tex = raw.slice(1, -1)
      if (!tex) return undefined
      return { type: 'mathInline', raw, tex }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('mathInline', { tex: token.tex }),

  renderMarkdown: (node) => `$${String(node.attrs?.tex ?? '')}$`,
})

export const DohcMathBlock = Node.create({
  name: 'mathBlock',
  priority: CUSTOM_BLOCK_PRIORITY,
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      tex: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-dohc-math-block]' }]
  },

  renderHTML({ node }) {
    return [
      'div',
      { class: 'dohc-math dohc-math-block', 'data-dohc-math-block': '' },
      `$$${String(node.attrs.tex ?? '')}$$`,
    ]
  },

  // Block-level tokenizer so a standalone `$$...$$` (single- or multi-line) is
  // its own block. The `tex` attr stores the exact text between the delimiters
  // — including any surrounding newlines — so `$$\nx\n$$` and `$$x$$` each
  // re-serialize byte-for-byte.
  markdownTokenizer: {
    name: 'mathBlock',
    level: 'block',
    start: mathBlockStart,
    tokenize(src) {
      if (!src.startsWith('$$')) return undefined
      const closing = src.indexOf('$$', 2)
      if (closing === -1) return undefined
      // The closing `$$` must end its line (or the document), so a mid-line
      // `$$x$$ trailing` is left as literal text instead of being sliced into
      // a stray block that would not round-trip.
      const afterClosing = src[closing + 2] ?? '\n'
      if (afterClosing !== '\n') return undefined
      const raw = src.slice(0, closing + 2)
      const tex = src.slice(2, closing)
      return { type: 'mathBlock', raw, tex }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('mathBlock', { tex: token.tex }),

  renderMarkdown: (node) => `$$${String(node.attrs?.tex ?? '')}$$`,
})

// Row height is editor layout metadata. It lives on the canonical Y.Doc so a
// resized table remains stable across collaborative edits and reloads. GFM
// has no row-height syntax, so the Markdown projectors write it in an HTML
// comment above the table. HTML import/export keeps it through
// data-row-height.
export const DohcTableRowHeight = Extension.create({
  name: 'dohcTableRowHeight',

  addGlobalAttributes() {
    return [
      {
        types: ['tableRow'],
        attributes: {
          height: {
            default: null,
            parseHTML: (element) => {
              const raw = element.getAttribute('data-row-height') ?? element.style.height
              const height = Number.parseFloat(raw)
              return Number.isFinite(height) && height > 0 ? Math.round(height) : null
            },
            renderHTML: (attributes) => {
              const height = Number(attributes.height)
              if (!Number.isFinite(height) || height <= 0) return {}
              const rounded = Math.round(height)
              return {
                'data-row-height': String(rounded),
                style: `height: ${rounded}px`,
              }
            },
          },
        },
      },
    ]
  },
})

// A bare TaskItem takes `paragraph+`, which makes an indented list under a
// checkbox schema-invalid — the Y.Doc conversion then drops the whole task
// list. `nested: true` widens it to `paragraph block*`. Every dohc
// schema registers this extension so the editor and the conversions agree.
export const DohcTaskItem = TaskItem.extend({
  renderMarkdown: (node, helpers) => renderItemBlocks(node, helpers,
    `- [${node.attrs?.checked ? 'x' : ' '}] `, 2),
}).configure({ nested: true })

// dohc owns the `code` token instead of StarterKit's CodeBlock, whose
// parseMarkdown accepts a token only when its raw text starts at column 0 with
// ``` or ~~~. CommonMark allows a fence opener indented up to 3 spaces, so that
// test rejects a legal fence — and because no other handler claims `code`, the
// whole block (fence and body) is dropped from the document.
export const DohcCodeBlock = Extension.create({
  name: 'dohcCodeBlock',
  priority: 1000,

  markdownTokenName: 'code',

  parseMarkdown: (token, helpers) =>
    helpers.createNode(
      'codeBlock',
      { language: token.lang || null },
      token.text ? [helpers.createTextNode(token.text)] : [],
    ),
})

// Standalone editor managers must also wait for later reference definitions.
export const markdownListParseState = { references: true }

function markdownLists(projected = false) {
  const tokenizer = new Tokenizer()
  tokenizer.lexer = new Lexer({ ...getDefaults(), tokenizer })
  tokenizer.lexer.blockTokens = () => Object.assign([], { links: {} })
  return Extension.create({
  name: 'dohcMarkdownLists', priority: 1001, markdownTokenName: 'list',
  markdownTokenizer: { name: 'list', level: 'block', start: () => -1, tokenize(src, _tokens, helpers) {
    if (!' -+*0123456789'.includes(src[0]) || !/^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]|\n|$)/u.test(src)) return undefined
    // Ordinary tight items need only inline lexing. A following root paragraph
    // cannot continue the list across a blank; indented bodies stay on Marked.
    // Reference labels wait for later definitions through block lexing.
    const flatTasks = /^([-+*]) \[[ xX]\] [A-Za-z][^\n\t]*(?:\n\1 \[[ xX]\] [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u.exec(src)
    const flat = flatTasks ?? /^([-+*]) [A-Za-z][^\n\t]*(?:\n\1 [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u.exec(src)
      ?? /^[0-9]{1,9}([.)]) [A-Za-z][^\n\t]*(?:\n[0-9]{1,9}\1 [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u.exec(src)
    if (flat && (!markdownListParseState.references || !flat[0].includes('['))) {
      const raw = flat[0]
      const ordered = /^[0-9]/u.test(raw)
      const lines = raw.split('\n')
      return {
        type: 'list', raw, ordered, start: ordered ? Number.parseInt(raw, 10) : '', loose: false,
        items: lines.map((line, at) => {
          const body = line.slice(flatTasks ? 6 : ordered ? line.indexOf(' ') + 1 : 2)
          const text = at === lines.length - 1 ? body.trimEnd() : body
          return {
            type: 'list_item', raw: line + (at < lines.length - 1 ? '\n' : ''),
            task: !!flatTasks, ...(flatTasks ? { checked: line[3].toLowerCase() === 'x' } : {}),
            loose: false, text,
            tokens: [{ type: 'paragraph', raw: text, text, tokens: /^[A-Za-z ]+$/u.test(text)
              ? [{ type: 'text', raw: text, text }]
              : helpers.inlineTokens(text) }],
          }
        }),
      }
    }
    if (/^(?:(?:[-+*]|[0-9]{1,9}[.)]) (?![ \t]*(?:\n|$))[^\n\[]+(?:\n|$))+(?:\n|$)(?![ \t\n0-9*+-])/u.test(src)) return undefined
    // Marked otherwise strips a checkbox from ordered item text as GFM tasks.
    tokenizer.options.gfm = !/^ {0,3}[0-9]/u.test(src)
    const list = tokenizer.list(src)
    if (!list) return undefined
    for (const item of list.items) {
      const task = /^\[([ xX])\][ \t]*(?:\n|$)/u.exec(item.text)
      if (!list.ordered && task) { item.task = true; item.checked = task[1].toLowerCase() === 'x'; item.text = item.text.slice(task[0].length) }
      item.tokens = helpers.blockTokens(item.text) as Tokens.ListItem['tokens']
    }
    return list
  } },
  parseMarkdown: (token, helpers) => {
    if (token.type !== 'list') return []
    const lists: JSONContent[] = []
    let separate = false
    for (const item of token.items ?? []) {
      const emptyTask = /^[ ]*[-+*] \[([ xX])\] *\n?$/u.exec(item.raw ?? '')
      const task = item.task || !!emptyTask
      const type = token.ordered ? 'orderedList' : task ? 'taskList' : 'bulletList'
      let list = lists.at(-1)
      if (list?.type !== type || (projected && separate)) {
        list = { type, ...(token.ordered ? { attrs: { start: Number(projected ? /^[ ]*([0-9]+)/u.exec(item.raw ?? '')?.[1] ?? token.start ?? 1 : token.start ?? 1) } } : {}), content: [] }
        lists.push(list)
      }
      separate = /\n[ \t]*\n$/u.test(item.raw ?? '')
      const tokens = (emptyTask ? [] : item.tokens ?? []).map(block => block.type === 'text'
        ? { ...block, type: 'paragraph' } : block)
      const content = (helpers.parseBlockChildren ?? helpers.parseChildren)(tokens)
      if (content[0]?.type !== 'paragraph' || (/^[ \t]*\n/u.test(item.text ?? '') && /^[ ]*(?:[-+*]|[0-9]{1,9}[.)])(?: \[([ xX])\])? *\n/u.test(item.raw ?? ''))) content.unshift({ type: 'paragraph' })
      list.content!.push({
        type: task ? 'taskItem' : 'listItem',
        ...(task ? { attrs: { checked: emptyTask ? emptyTask[1].toLowerCase() === 'x' : !!item.checked } } : {}), content,
      })
    }
    return lists
  },
})

}
const DohcMarkdownLists = markdownLists()
export const DohcProjectedMarkdownLists = markdownLists(true)

export const dohcMarkdownExtensions = [
  DohcImage,
  DohcEscapedPunctuation,
  DohcWikilink,
  DohcInlineAtom,
  DohcCallout,
  DohcHighlight,
  DohcMathInline,
  DohcMathBlock,
  DohcTableRowHeight,
  DohcCodeBlock,
  DohcMarkdownLists,
]

// GFM forbids block nodes inside table cells but permits inline raw HTML, so a
// multi-block ProseMirror cell uses a visible hard break instead of U+001F.
export const GFM_TABLE_CELL_BLOCK_SEPARATOR = '<br>'
function prepareRenderedTableCell(markdown: string): string {
  // Raw inline HTML is the canonical representation of cell block boundaries.
  // The importer represents those tags as text, so normalize them before the
  // table renderer measures the cell again.
  markdown = markdown
    .replaceAll('&amp;lt;br&amp;gt;', GFM_TABLE_CELL_BLOCK_SEPARATOR)
    .replaceAll('&lt;br&gt;', GFM_TABLE_CELL_BLOCK_SEPARATOR)
  let output = ''
  let precedingBackslashes = 0

  for (const character of markdown) {
    if (character === '|' && precedingBackslashes % 2 === 0) {
      output += '\\'
    }
    output += character
    precedingBackslashes = character === '\\' ? precedingBackslashes + 1 : 0
  }

  return output
}

let tableCellWidth = (text: string): number => text.length
/** Renders with table cells measured by `width`, for text that is written differently than it renders. */
export function measureTableCellsAs<T>(width: (text: string) => number, render: () => T): T {
  const previous = tableCellWidth
  tableCellWidth = width
  try {
    return render()
  } finally {
    tableCellWidth = previous
  }
}

// Tiptap's `renderTableToMarkdown`, with each cell measured by `tableCellWidth`.
function renderTableToMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  const rows = (node.content ?? []).map(row => (row.content ?? []).map(cell => {
    const raw = cell.content && cell.content.length > 1
      ? cell.content.map(child => helpers.renderChildren(child)).join(GFM_TABLE_CELL_BLOCK_SEPARATOR)
      : cell.content ? helpers.renderChildren(cell.content) : ''
    const text = raw.split(GFM_TABLE_CELL_BLOCK_SEPARATOR).join('\n')
      .replace(/[ \t]*\r?\n[ \t]*/g, GFM_TABLE_CELL_BLOCK_SEPARATOR)
      .replace(/\s+/g, ' ')
      .trim()
    const align: unknown = cell.attrs?.align
    return {
      text,
      width: tableCellWidth(text),
      isHeader: cell.type === 'tableHeader',
      align: align === 'left' || align === 'right' || align === 'center' ? align : null,
    }
  }))
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) return ''
  const columns = Array.from({ length: columnCount }, (_, index) => index)
  const widths = columns.map(index => rows.reduce((width, row) => Math.max(width, row[index]?.width ?? 0), 3))
  const alignments = columns.map(index => rows.find(row => row[index]?.align)?.[index]?.align ?? null)
  const hasHeader = rows[0].some(cell => cell.isHeader)
  const line = (row: typeof rows[number] | undefined) => `| ${columns.map(index => {
    const cell = row?.[index]
    return (cell?.text ?? '') + ' '.repeat(Math.max(0, widths[index] - (cell?.width ?? 0)))
  }).join(' | ')} |\n`
  const delimiter = `| ${columns.map(index => {
    const dashes = '-'.repeat(widths[index])
    const alignment = alignments[index]
    if (alignment === 'left') return `:${dashes}`
    if (alignment === 'right') return `${dashes}:`
    if (alignment === 'center') return `:${dashes}:`
    return dashes
  }).join(' | ')} |\n`
  return `\n${line(hasHeader ? rows[0] : undefined)}${delimiter}${(hasHeader ? rows.slice(1) : rows).map(line).join('')}`
}

function firstLine(source: string): string {
  const newline = source.indexOf('\n')
  return newline < 0 ? source : source.slice(0, newline)
}

const tableTokenizer = Table.config.markdownTokenizer!

// Use marked's CommonMark item-body lexer; Tiptap's ordered-list tokenizer
// accepts letter markers and strips only two columns from child blocks.
export const MarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    name: 'orderedList', level: 'block', start: () => -1, tokenize: () => undefined,
  },
})
export const MarkdownListItem = ListItem.extend({
  renderMarkdown: (node, helpers, context) => {
    const start = Number(context.meta?.parentAttrs?.start ?? 1)
    const prefix = context.parentType === 'orderedList'
      ? `${Math.min(999_999_999, start + (context.index || 0))}. ` : '- '
    return renderItemBlocks(node, helpers, prefix, prefix.length)
  },
})

function renderItemBlocks(node: JSONContent, helpers: MarkdownRendererHelpers, prefix: string, indent: number): string {
  const [first, ...children] = node.content ?? []
  const firstText = helpers.renderChildren(first ? [first] : []).replace(/^[ \t]*$/u, '')
  const emptyMarker = node.type === 'listItem' && firstText === ''
  let output = prefix + firstText.replaceAll('\n', '\n' + ' '.repeat(indent))
  children.forEach((child, index) => {
    let content = (helpers.renderChild?.(child, index + 1) ?? helpers.renderChildren([child]))
    if (index === 0 && emptyMarker) content = content.replace(/^\n/u, '')
    const rendered = content.split('\n').map(line => ' '.repeat(indent) + line).join('\n')
    const firstLine = content.split('\n', 1)[0]
    const previous = index === 0 ? first : children[index - 1]
    const interrupts = child.type === 'orderedList' ? /^1\. [ \t]*[^ \t]/u.test(firstLine)
      : child.type !== 'bulletList' || firstLine.replace(/[ \t]+$/u, '') !== '-'
    const separate = child.type === 'paragraph' || child.type === 'horizontalRule' || child.type === 'mathBlock'
      || (['paragraph', 'mathBlock', 'table', 'blockquote', 'callout'].includes(previous?.type ?? '') && !interrupts)
    const boundary = separate || (['blockquote', 'callout'].includes(previous?.type ?? '') && ['blockquote', 'callout'].includes(child.type ?? ''))
      || (previous?.type === child.type && ['bulletList', 'orderedList', 'taskList'].includes(child.type ?? ''))
    output += (boundary && !(index === 0 && emptyMarker) ? '\n\n' : '\n') + rendered
  })
  return output
}
export const MarkdownTaskList = TaskList.extend({
  // DohcMarkdownLists groups items before Tiptap's task-only list splitter.
  markdownTokenName: 'list',
  markdownTokenizer: {
    name: 'taskList', level: 'block', start: () => -1, tokenize: () => undefined,
  },
})

const tableParseMarkdown = Table.config.parseMarkdown!
type TableRowHeightsToken = Parameters<typeof tableParseMarkdown>[0] & {
  rowHeights?: [number, number][]
}

function tableRowHeightsAnnotation(rows: JSONContent[]): string {
  const pairs: string[] = []
  rows.forEach((row, index) => {
    const height = tableRowHeight(row.attrs?.height)
    if (height !== null) pairs.push(`${index}:${height}`)
  })
  return pairs.length ? `<!-- dohc:table row-heights=${pairs.join(',')} -->` : ''
}

export const nextLine = nextCharacter('\n')
// The same search from the second line on, so its answer stays apart from
// the first line's.
const nextLineAfter: RestSearch = (text, from) => text.indexOf('\n', from)
const nextPipe = nextCharacter('|')

// Table.start only inspects the first two lines, and finds a table only when
// the first holds a pipe. Avoid splitting the full remaining document while
// probing ordinary blocks.
function tableStart(this: { lexer?: object }, src: string): number {
  if (TABLE_ROW_HEIGHTS_RE.test(src)) return 0
  const read = blockStartText(this?.lexer, src)
  const newline = searchBlockRest(read, src, 0, nextLine)
  if (newline < 0) return -1
  const pipe = searchBlockRest(read, src, 0, nextPipe)
  if (pipe < 0 || pipe > newline) return -1
  const second = searchBlockRest(read, src, newline + 1, nextLineAfter)
  const prefix = second < 0 ? src : src.slice(0, second)
  return (tableTokenizer.start as (source: string) => number)(prefix)
}

// One tokenizer reads each table on its own. Its lexer gives it its GFM
// rules, and holds the inline queue each table fills until the read ends.
const tableReader = new Tokenizer()
tableReader.lexer = new Lexer({ ...getDefaults(), tokenizer: tableReader })

function readTable(text: string): Tokens.Table | undefined {
  try {
    return tableReader.table(text)
  } finally {
    tableReader.lexer.inlineQueue.length = 0
  }
}

// Tiptap escapes only the pipes of a line that also holds a backtick.
function escapedTablePipes(text: string): string {
  return text.includes('`') ? preprocessTablePipes(text) : text
}

// The table marked's rule reads from `head`, the first two lines of a text,
// as `leadingTable` would choose it. Whether it reads one depends only on
// those lines, so a text whose first two lines are no table costs only them.
function headTable(head: string): Tokens.Table | undefined {
  const escaped = escapedTablePipes(head)
  return (escaped === head ? undefined : readTable(escaped)) ?? readTable(head)
}

/** Whether `rule`, when it is marked's own table rule, may read a table from `head`, the first two lines of a text. */
export function readsTable(head: string, rule: RegExp): boolean {
  return tableReader.rules.block.table !== rule || !!readTable(head)
}

// Finds the table at the start of `rest` with marked's table rule and nothing
// else, and returns its lines as that rule read them. Lexing the rest of the
// document would re-enter this tokenizer for every later table, and even a
// plain lexer would parse every block after the table, so a run of tables
// would cost quadratic time. GFM rows are one line each, which Tiptap's raw
// reconstruction gets wrong when a cell holds a pipe inside inline code.
//
// The importer reads a table the way Tiptap's tokenizer does: first with the
// pipes inside code spans escaped, and only when that is no table, from the
// raw text with marked's own rule. The two can count a row's cells
// differently, so this reads the same text. An escape never starts or ends a
// line, so marked's rule spans the same lines of either text, and only those
// lines are read.
function leadingTable(
  rest: string,
): { table: Tokens.Table; lines: string[]; source: string[] } | undefined {
  const own = tableReader.rules.block.table.exec(rest)?.[0].replace(/\n+$/u, '')
  if (own === undefined) return undefined
  const escaped = escapedTablePipes(own)
  for (const text of escaped === own ? [own] : [escaped, own]) {
    const table = readTable(text)
    // The header, the delimiter, and each row take one line.
    const count = 2 + (table?.rows.length ?? 0)
    if (table) return { table, lines: text.split('\n', count), source: own.split('\n', count) }
  }
  return undefined
}

// A table row's cells as marked splits them: at each unescaped pipe, without
// the empty cells outside a leading or trailing pipe.
function tableRowCells(row: string): string[] {
  const cells: string[] = []
  let start = 0
  let backslashes = 0
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === '|' && backslashes % 2 === 0) {
      cells.push(row.slice(start, index))
      start = index + 1
    }
    backslashes = row[index] === '\\' ? backslashes + 1 : 0
  }
  cells.push(row.slice(start))
  if (!cells[0]?.trim()) cells.shift()
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop()
  return cells
}

// The lines of the table at the start of `rest`, joined. marked drops the
// cells of a row past its header's count, so a row whose extra cells hold
// text ends the table instead, and that text stays in the document.
// Otherwise a file, or a preserved source, could hold text its document
// lacks. Without a cut, `cells` counts the most cells up to the last with
// text in any row.
function leadingTableText(rest: string): { text: string; cut: boolean; cells: number } | undefined {
  const read = leadingTable(rest)
  if (!read) return undefined
  const { table, lines, source: raw } = read
  let cells = 0
  for (let row = 2; row < lines.length; row += 1) {
    const rowCells = tableRowCells(lines[row])
    let last = 0
    for (let at = 0; at < rowCells.length; at += 1) {
      if (!rowCells[at]!.trim()) continue
      if (at >= table.header.length) return { text: raw.slice(0, row).join('\n'), cut: true, cells }
      last = at + 1
    }
    cells = Math.max(cells, last)
  }
  return { text: raw.join('\n'), cut: false, cells }
}

// Where the probe last read a table it did not cut and returned nothing, with
// no pipe Tiptap's tokenizer would escape: from `start` to `end` of the block
// text, with no row holding text past `cells` cells. A later probe whose first
// two lines end inside it reads the rest of the same rows, so with no table in
// those lines, or at least `cells` header cells, it returns nothing too.
const tableProbes = new WeakMap<BlockText, { start: number; end: number; cells: number }>()

// Only a line after the first that could be a delimiter row can start a
// table, so ordinary blocks skip the table probe.
const TABLE_DELIMITER_RE = /^[ \t|:]*-[ \t|:-]*$/u
// The second line of `src`, and where it ends.
function secondLine(src: string, read: BlockText | undefined): { second: string; end: number } {
  const holds = read && read.text.length >= src.length ? read : undefined
  const first = searchBlockRest(holds, src, 0, nextLine)
  if (first < 0) return { second: '', end: src.length }
  const second = searchBlockRest(holds, src, first + 1, nextLineAfter)
  const end = second < 0 ? src.length : second
  return { second: src.slice(first + 1, end), end }
}

// Remembers a probe that read rows but returned nothing.
function probedNoTable(read: BlockText | undefined, extent: { text: string; cells: number } | undefined, start: number): undefined {
  if (read && extent && escapedTablePipes(extent.text) === extent.text) {
    tableProbes.set(read, { start, end: start + extent.text.length, cells: extent.cells })
  }
  return undefined
}

export const DohcMarkdownTable = Table.extend({
  markdownTokenizer: {
    ...tableTokenizer,
    start: tableStart,
    tokenize: (src, tokens, helpers) => {
      const annotation = TABLE_ROW_HEIGHTS_RE.exec(src)
      const prefix = annotation?.[0] ?? ''
      const rest = src.slice(prefix.length)
      const read = annotation ? undefined : tokenBlock(tokens)
      const { second, end } = secondLine(rest, read)
      // marked's table rule takes a delimiter row only with a pipe or colon,
      // and its first two lines decide whether it reads a table.
      const head = (annotation || TABLE_DELIMITER_RE.test(second)) && /[:|]/.test(second) ? headTable(rest.slice(0, end)) : undefined
      if (!annotation && !head) return undefined
      const start = read ? read.text.length - rest.length : -1
      const probed = read && tableProbes.get(read)
      if (probed && probed.start <= start && start + end <= probed.end && (!head || head.header.length >= probed.cells)) return undefined
      const extent = head ? leadingTableText(rest) : undefined
      if (!annotation && !extent?.cut) {
        // Tiptap's tokenizer reads a table only when its second line is a
        // delimiter row with a pipe, and here it reads only the table's own
        // lines. Given the text up to the next blank line, it would read every
        // line after the table too, and when a code span there holds a pipe,
        // count the line after the table as one of its own.
        if (!extent || !second.includes('|')) return probedNoTable(read, extent, start)
        const table = tableTokenizer.tokenize(extent.text, tokens, helpers)
        if (!table?.raw) return probedNoTable(read, extent, start)
        // The newline after the last row belongs to the table, as in marked.
        return { ...table, raw: table.raw + (rest[table.raw.length] === '\n' ? '\n' : '') }
      }
      // An annotation belongs to the table that starts right after it. With
      // no table there it stays an ordinary HTML comment for marked.
      if (!extent) return undefined
      const table = helpers.blockTokens(extent.text)[0]
      if (table?.type !== 'table') return undefined
      // The newline after the last row belongs to the table, as in marked.
      const raw = prefix + extent.text + (extent.text.length < rest.length ? '\n' : '')
      const rowHeights = annotation ? tableRowHeights(annotation[1]) : []
      return { ...table, raw, rowHeights }
    },
  },
  parseMarkdown: (token: TableRowHeightsToken, helpers) => {
    const table = tableParseMarkdown(token, helpers) as JSONContent
    const rows = table.content ?? []
    for (const [index, height] of token.rowHeights ?? []) {
      const row = rows[index]
      if (row) row.attrs = { ...row.attrs, height }
    }
    return table
  },
  renderMarkdown: (node, helpers) => {
    const tableHelpers: MarkdownRendererHelpers = {
      ...helpers,
      renderChildren: (nodes, separator) =>
        prepareRenderedTableCell(helpers.renderChildren(nodes, separator)),
    }
    // The table renderer includes its own trailing newline, while the
    // document renderer also joins sibling blocks with `\n\n`. Returning both
    // would put two blank lines between a table and its next sibling.
    const table = renderTableToMarkdown(node, tableHelpers).replace(/\n$/u, '')
    return table ? tableRowHeightsAnnotation(node.content ?? []) + table : table
  },
})

// Tiptap's paragraph returns a lone image without its paragraph, for a block
// image. The dohc image is inline, so keep the paragraph around it.
export const MarkdownParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens ?? []
    return tokens.length === 1 && tokens[0]?.type === 'image'
      ? helpers.createNode('paragraph', undefined, helpers.parseInline(tokens))
      : Paragraph.config.parseMarkdown!(token, helpers)
  },
})
