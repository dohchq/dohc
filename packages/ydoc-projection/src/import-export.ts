import type { AnyExtension, JSONContent } from '@tiptap/core'
import { Extension, flattenExtensions, getSchema, type Mark } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { getDefaults, Lexer, Marked, Tokenizer, type marked, type Token, type Tokens, type TokensList } from 'marked'
import { StarterKit } from '@tiptap/starter-kit'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  prosemirrorToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  DohcMarkdownTable,
  DohcTaskItem,
  dohcMarkdownExtensions,
  enterBlockText,
  enterInlineText,
  escapeHighlightMarkdown,
  findInlineStart,
  GFM_TABLE_CELL_BLOCK_SEPARATOR,
  inlineStart,
  leaveBlockText,
  leaveInlineText,
  MarkdownListItem,
  MarkdownOrderedList,
  DohcProjectedMarkdownLists,
  MarkdownParagraph,
  MarkdownTaskList,
  markdownListParseState,
  measureTableCellsAs,
  nextCharacter,
  nextLine,
  readingInlineText,
  readsTable,
  searchBlockText,
  searchInlineText,
  shortenLastParagraph,
  stepBlockText,
  steppedBlockText,
  stepInlineText,
  type InlineText,
  type RestSearch,
} from './dohc-markdown-extensions.js'
import { MarkdownNestingRefusal } from './markdown-nesting-refusal.js'
export { MarkdownNestingRefusal } from './markdown-nesting-refusal.js'
import { assertSupportedListMarkdown } from './list-markdown.js'
import { sanitizeImageSrc } from './image-src.js'
import { backtickFence, codeBlockFence } from './markdown-fence.js'
import { getDohcYDocBodyFragment } from './body-fragment.js'
import {
  FRONTMATTER_SOURCE_META_KEY,
  frontmatterBlockFor,
  MARKDOWN_CRLF_META_KEY,
  orderFrontmatter,
  parseFrontmatter,
} from './frontmatter.js'
import {
  frontmatterMapValues,
  recordFrontmatterSourceItems,
  writeFrontmatterMap,
  writtenFrontmatterKeys,
} from './frontmatter-map.js'

const PLAIN_TEXT_FIELD = 'plainText'
const FRONTMATTER_FIELD = 'frontmatter'
const META_FIELD = 'meta'
export const DOHC_SCHEMA_VERSION = 1
const PLAIN_TEXT_CONTENT_KIND = 'plain-text'
const PARSE_SENTINEL_RE = /\uE000DOHC_PARSE_\d+\uE001/gu
// The block escapes the serializer writes anywhere: references the parser
// reads as their character wherever they appear.
const BLOCK_ESCAPE_CODES = new Set([13, 35, 36, 41, 42, 43, 45, 46, 61, 91, 95, 96, 126, 160])
// A block escape, its once-encoded spelling, or a decimal reference to ASCII
// punctuation, a space, a tab, or a newline, which the serializer writes
// inside a tag.
const PARSE_REFERENCE_RE = new RegExp(
  `(?:&amp;|&AMP;|&#0{0,5}38;|&#[xX]0{0,4}26;)#(?:${[...BLOCK_ESCAPE_CODES].join('|')});`
    + '|&#(9|10|13|3[2-9]|4[0-7]|5[89]|6[0-4]|9[1-6]|12[3-6]|160);',
  'gu',
)
// The parse in progress: the references it set aside, by sentinel, and the
// sentinels that stand for the file's own `<` and `>`, in raw HTML or text,
// until its tag spans are read, so only the serializer's `&lt;` and `&gt;`
// open and close one.
let parseReferences: ReadonlyMap<string, string> = new Map()
let parseTabs: ReadonlyMap<string, string> = new Map()
let rawHtmlMarkup = { lt: '<', gt: '>', used: false }

// Raw HTML stays the text the file holds, references and all. Tiptap keeps it
// as text where there is no DOM, as in the engine, but reads it through the DOM
// in a browser, which drops a comment and turns tags into marks. A block of
// HTML becomes a paragraph of its source here, and an inline tag an `escape`
// token below.
const MarkdownHtml = Extension.create({
  name: 'markdownHtml',
  markdownTokenName: 'html',
  parseMarkdown: (token) => {
    const text = rawHtmlText(token.text || token.raw || '')
    return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : []
  },
})

// marked reads a link reference definition as a `def` token, which Tiptap
// drops. The engine's fold keeps the line as paragraph text, and so does
// this, so the person's line stays in the document and in the file, as it
// holds it. A link that uses the definition still resolves, because marked
// collects it while lexing.
const MarkdownDefinition = Extension.create({
  name: 'markdownDefinition',
  markdownTokenName: 'def',
  parseMarkdown: (token) => {
    const text = typeof token.dohcText === 'string'
      ? token.dohcText
      : sourceText(definitionText(token.raw ?? ''))
    return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : []
  },
})

function definitionText(raw: string): string {
  return raw.trimEnd().split('\n').map(line => line.trimStart()).join('\n')
}

// The serializer writes a definition the document holds as text as one tag
// span: each character that could read as syntax is a reference, and `&`,
// `<`, and `>` are Tiptap's entities, so no renderer reads syntax in it. A
// block that holds exactly those bytes for a text that reads as one whole
// definition is that text again. Any other block reads as it did, so a
// definition a person writes with `&#91;` keeps its link, and an escaped `\[`
// stays an escape.
//
// The block runs to its first blank line. A line holding a character the
// serializer writes as a reference ends the search. Each line that could end
// a paragraph holds one, so a block that is no definition costs no more than
// the paragraph marked reads in its place.
function escapedDefinition(src: string): (Tokens.Def & { dohcText: string }) | undefined {
  const opener = /^\uE000DOHC_PARSE_\d+\uE001/u.exec(src)
  if (!opener || parseReferences.get(opener[0]) !== '&#91;') return undefined
  let start = 0
  let end = lineEnd(src, 0)
  for (;;) {
    const line = src.slice(start, end).replace(/\uE000DOHC_PARSE_\d+\uE001|&(?:amp|lt|gt);/gu, '')
    if (DEFINITION_REFERENCE_RE.test(line)) return undefined
    if (end === src.length) break
    const next = lineEnd(src, end + 1)
    if (/^[ \t]*$/.test(src.slice(end + 1, next))) break
    start = end + 1
    end = next
  }
  const raw = src.slice(0, end)
  const written = restoreParseSentinels(raw, parseReferences)
  const text = written.replace(/&(?:#(\d+)|(amp|lt|gt));/g, (_entity, code: string | undefined, name: string) => (
    code ? String.fromCodePoint(Number(code)) : { amp: '&', lt: '<', gt: '>' }[name] ?? ''
  ))
  if (writtenDefinition(text) !== written) return undefined
  const definition = literalProbe.def(text)
  if (!definition || definitionText(definition.raw) !== text) return undefined
  return { ...definition, raw, dohcText: text }
}

// The characters a definition's text writes as references: the ASCII
// punctuation a tag span writes so, `&`, `<`, and `>`, and the paragraph's
// `\r` and NBSP.
const DEFINITION_REFERENCE_RE = /["-.:->@[-`{-~\r ]/

// The bytes the serializer writes for text it writes as references, a
// definition's or a link's, as a tag span whose last line ends the
// paragraph: a space that ends a line and a newline that ends an empty one
// are references too.
function writtenDefinition(text: string): string {
  return text.replace(/["-.:->@[-`{-~\r ]| (?=\n)|(?<=\n)\n/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character] ?? `&#${character.codePointAt(0)};`
  ))
}

function lineEnd(text: string, from: number): number {
  const at = text.indexOf('\n', from)
  return at < 0 ? text.length : at
}

// A link with no text that holds a line that would end its paragraph cannot
// be held as it is, so the serializer writes it as references, the way it
// writes a definition. A run of text that holds exactly those bytes, for a
// link marked reads with such a line, is that link's text again. Any other
// text, references and all, reads as it did.
//
// Each run is read once, from its first `&#91;&#93;&#40;`: its text, where
// each character sits in the source, the first character from each one on
// that the serializer would write otherwise, the first line or `\r` from each
// one on that `opensBlock` counts, and the reader for its links. So its
// candidates cost no more than the run.
type WrittenRun = {
  text: string
  at: number[]
  bad: number[]
  opens: number[]
  read: (link: number) => number
}
let writtenLinks: {
  openers: ReadonlySet<string>
  runs: Map<string, { run: WrittenRun; link: number; end?: number }>
  // The text marked last gave the tokenizer, as the tokens it lexes into
  // and its length, and for each such tokens how far from the text's end
  // the next sentinel starts, or 0 for none.
  tokens?: object
  length: number
  sentinels: WeakMap<object, number>
} = { openers: new Set(), runs: new Map(), tokens: undefined, length: -1, sentinels: new WeakMap() }
// What the serializer writes as a reference: the ASCII punctuation a tag
// span writes so, but `&`, `<`, and `>`, which are entities, and `\r` and
// NBSP.
const WRITTEN_REFERENCE_RE = /["-%'-.:;=@[-`{-~\r\u00a0]/
const WRITTEN_SENTINEL_AT = /\uE000DOHC_PARSE_\d+\uE001/uy
const WRITTEN_ENTITY_AT = /&(?:amp|lt|gt);/y

// The `&#91;` references that open a `&#91;&#93;&#40;` in the prepared file.
function writtenOpeners(prepared: string, references: ReadonlyMap<string, string>): Set<string> {
  const openers = new Set<string>()
  const sentinels = [...prepared.matchAll(PARSE_SENTINEL_RE)]
  for (let index = 0; index + 2 < sentinels.length; index += 1) {
    const run = sentinels.slice(index, index + 3)
    const adjacent = run.every((sentinel, at) => (
      at === 0 || run[at - 1].index + run[at - 1][0].length === sentinel.index
    ))
    const spelled = run.map(sentinel => references.get(sentinel[0])).join('')
    if (adjacent && spelled === '&#91;&#93;&#40;') openers.add(run[0][0])
  }
  return openers
}

function readWrittenRun(src: string): void {
  let text = ''
  const at: number[] = []
  const written: boolean[] = []
  const openers: Array<[number, string]> = []
  let index = 0
  while (index < src.length) {
    WRITTEN_SENTINEL_AT.lastIndex = index
    const sentinel = WRITTEN_SENTINEL_AT.exec(src)?.[0]
    WRITTEN_ENTITY_AT.lastIndex = index
    const entity = sentinel ? undefined : WRITTEN_ENTITY_AT.exec(src)?.[0]
    let character = src[index]
    if (sentinel) {
      const code = /^&#([1-9]\d*);$/.exec(parseReferences.get(sentinel) ?? '')?.[1]
      character = code ? String.fromCodePoint(Number(code)) : ''
      if (!WRITTEN_REFERENCE_RE.test(character) && character !== ' ' && character !== '\n') break
      if (character === '[') openers.push([text.length, sentinel])
    } else if (entity) {
      character = { '&amp;': '&', '&lt;': '<', '&gt;': '>' }[entity] ?? ''
    } else if (WRITTEN_REFERENCE_RE.test(character) || /[&<>]/.test(character)) {
      break
    }
    at.push(index)
    written.push(Boolean(sentinel ?? entity))
    text += character
    index += (sentinel ?? entity ?? character).length
  }
  at.push(index)
  const n = text.length
  const bad = new Array<number>(n + 1)
  const opens = new Array<number>(n + 1)
  bad[n] = n
  opens[n] = n
  for (let at = n - 1; at >= 0; at -= 1) {
    const character = text[at]
    const reference = WRITTEN_REFERENCE_RE.test(character)
      || /[&<>]/.test(character)
      || (character === ' ' && text[at + 1] === '\n')
      || (character === '\n' && text[at - 1] === '\n')
    bad[at] = reference === written[at] ? bad[at + 1] : at
    OPENS_LINE_RE.lastIndex = at
    opens[at] = (character === '\n' || character === '\r') && OPENS_LINE_RE.test(text)
      ? at
      : opens[at + 1]
  }
  const run = { text, at, bad, opens, read: emptyLinkReader(text) }
  for (const [link, sentinel] of openers) {
    if (text.startsWith('[](', link)) writtenLinks.runs.set(sentinel, { run, link })
  }
}

// Where the first sentinel in `src` starts. marked gives `start` the text it
// last gave the tokenizer, less its first character, and each later text it
// lexes into the same tokens ends that text. So one search holds for each
// until the text passes the sentinel it found.
function nextSentinel(src: string): number {
  const tokens = writtenLinks.length === src.length + 1 ? writtenLinks.tokens : undefined
  const rest = tokens && writtenLinks.sentinels.get(tokens)
  if (rest === 0) return -1
  const found = rest === undefined ? -1 : src.length - rest
  if (found >= 0 && src.startsWith('\uE000DOHC_', found)) return found
  const at = src.indexOf('\uE000DOHC_')
  if (tokens) writtenLinks.sentinels.set(tokens, at < 0 ? 0 : src.length - at)
  return at
}

// The link with no text the serializer wrote as references at the start of
// `src`, as the text it holds.
function writtenLink(
  src: string,
  tokens: object,
): { type: 'escape'; raw: string; text: string } | undefined {
  writtenLinks.tokens = tokens
  writtenLinks.length = src.length
  WRITTEN_SENTINEL_AT.lastIndex = 0
  const opener = WRITTEN_SENTINEL_AT.exec(src)?.[0]
  if (!opener || !writtenLinks.openers.has(opener)) return undefined
  if (!writtenLinks.runs.has(opener)) readWrittenRun(src)
  const found = writtenLinks.runs.get(opener)
  if (!found) return undefined
  const { run, link } = found
  found.end ??= run.read(link)
  const end = found.end
  if (end < 0 || run.bad[link] < end || run.opens[link] >= end) return undefined
  return {
    type: 'escape',
    raw: src.slice(0, run.at[end] - run.at[link]),
    text: fileAngles(run.text.slice(link, end)),
  }
}

// Tiptap trims a literal fragment's trailing whitespace. A pattern anchored
// at the end would read each white space run inside the text to its end.
function rawHtmlText(source: string): string {
  return sourceText(source.trimEnd())
}

// Source the document keeps as the text the file holds, with each reference
// as the file spells it.
function sourceText(source: string): string {
  return fileAngles(restoreParseSentinels(source, parseReferences))
}

// A `<` or `>` the file holds, in raw HTML or text, is no tag the serializer
// wrote, so it opens and closes no tag span. Tiptap reads `&lt;` and `&gt;`
// as the only `<` and `>` left, and those are the ones that do.
function fileAngles(text: string): string {
  const replaced = text.replaceAll('<', rawHtmlMarkup.lt).replaceAll('>', rawHtmlMarkup.gt)
  rawHtmlMarkup.used ||= replaced !== text
  return replaced
}

// A token's source in a gathered HTML run. A gathered run keeps its whole
// source as text, and its raw holds only the closing tag the lexer consumed.
function htmlRunSource(token: Token): string {
  const generic = token as Tokens.Generic
  return generic.dohcHtmlRun === true ? String(generic.text) : token.raw
}

// The open tags among a text's tokens, in a trie of their lowercased names,
// so a closing tag finds the earliest one it closes in one pass over its own
// name rather than over every token before it.
type OpenTagNode = { next: Map<string, OpenTagNode>; at: number[] }
const openTags = new WeakMap<object, { root: OpenTagNode; order: OpenTagNode[] }>()

function recordOpenTag(tokens: Token[], name: string): void {
  let tags = openTags.get(tokens)
  if (!tags) openTags.set(tokens, tags = { root: { next: new Map(), at: [] }, order: [] })
  let node = tags.root
  for (const character of name.toLowerCase()) {
    let next = node.next.get(character)
    if (!next) node.next.set(character, next = { next: new Map(), at: [] })
    node = next
  }
  // The lexer adds the open tag's token next.
  node.at.push(tokens.length)
  tags.order.push(node)
}

// Where the earliest open tag sits that `raw`, a closing tag, closes: one
// whose name, ignoring case, starts the closing name and ends at a word
// boundary. Forgets every open tag from there on, which the caller gathers.
function closeOpenTag(tokens: Token[], raw: string): number {
  const tags = openTags.get(tokens)
  const name = /^<\/\s*([\w-]+)/.exec(raw)
  if (!tags || !name) return -1
  const start = name[0].length - name[1].length
  let node: OpenTagNode | undefined = tags.root
  let opened = -1
  for (let end = start + 1; node && end <= name[0].length; end += 1) {
    node = node.next.get(raw[end - 1]!.toLowerCase())
    const at = node?.at[0]
    if (at !== undefined && (opened < 0 || at < opened) && /\w/.test(raw[end - 1]!) !== /\w/.test(raw[end] ?? '')) opened = at
  }
  while (opened >= 0 && (tags.order.at(-1)?.at.at(-1) ?? -1) >= opened) tags.order.pop()!.at.pop()
  return opened
}

const UNDERLINE_START = inlineStart(/\+\+/)
const EMPTY_LINK_START = inlineStart(/\[\]\(/)

// StarterKit's own underline, whose start search reads the rest of the text
// once, like each of ours. It is StarterKit's last mark, so marks keep their
// order.
const starterUnderline = flattenExtensions([StarterKit]).find((extension): extension is Mark => extension.name === 'underline')!
const MarkdownUnderline = starterUnderline.extend({
  markdownTokenizer: {
    ...starterUnderline.config.markdownTokenizer!,
    start(this: { lexer?: object }, src: string) {
      return findInlineStart(this.lexer, src, UNDERLINE_START)
    },
  },
})

// marked's GFM text rule stops before an email address by looking ahead
// through the email characters after each place it may stop, so a long run of
// them, such as `a*a*a*…`, cost quadratic time. The importer finds the first
// address the rule could stop before from the next `@` that follows an email
// character, searching the text once, and reads the rule without those two
// look-aheads only up to there. They see only the text marked gives the rule,
// so an `@` past the start of an extension does not count.
type LinearTextRule = { lead: RegExp; plain: RegExp; emailCharacter: RegExp }
const EMAIL_LOOKAHEAD = /\|(\[\^[^\]]*\])?\(\?=\[([^\]]*)\]\+@\)/g
const linearTextRules = new WeakMap<RegExp, LinearTextRule | null>()

function linearTextRule(rule: RegExp): LinearTextRule | null {
  let linear = linearTextRules.get(rule)
  if (linear === undefined) {
    const lead = /^\^\((?:\\.|[^)\\])*\)/.exec(rule.source)?.[0]
    const [atStart, afterOther, ...more] = [...rule.source.matchAll(EMAIL_LOOKAHEAD)]
    const characters = atStart?.[2]
    linear = lead && characters && !atStart[1] && afterOther?.[1] === `[^${characters}]` && afterOther[2] === characters && !more.length
      ? {
          lead: new RegExp(lead, rule.flags),
          plain: new RegExp(rule.source.replace(EMAIL_LOOKAHEAD, ''), rule.flags),
          emailCharacter: new RegExp(`[${characters}]`, 'y'),
        }
      : null
    linearTextRules.set(rule, linear)
  }
  return linear
}

// The first `@` from `from` on in the text `read` holds that follows an email
// character, and where that run of email characters starts.
function nextAddress(read: InlineText, rule: LinearTextRule, from: number): { at: number; start: number } {
  const emailCharacter = (at: number) => {
    rule.emailCharacter.lastIndex = at
    return at >= 0 && rule.emailCharacter.test(read.text)
  }
  let found = read.email
  if (!found || found.from > from || (found.at >= 0 && found.at < from)) {
    let at = read.text.indexOf('@', from)
    while (at >= 0 && !emailCharacter(at - 1)) at = read.text.indexOf('@', at + 1)
    let start = at
    while (start > 0 && emailCharacter(start - 1)) start -= 1
    found = read.email = { from, at, start }
  }
  return found
}

// How much of `src` the text rule reads, or undefined to let marked's own rule
// read it.
function textEnd(tokenizer: Tokenizer, src: string): number | undefined {
  const read = readingInlineText(tokenizer.lexer)
  const rule = linearTextRule(tokenizer.rules.inline.text)
  // marked gives the rule a start of the step's rest.
  if (!read || !rule || read.step < src.length || read.step > read.text.length) return undefined
  const offset = read.text.length - read.step
  // The rule always reads its lead, then may stop before an address.
  const lead = rule.lead.exec(src)![0].length
  const address = nextAddress(read, rule, offset + lead + 1)
  let before = -1
  if (address.at >= 0 && address.at < offset + src.length) {
    // The email characters run from the end of the lead to the `@`.
    if (address.start <= offset + lead) return lead
    before = address.start - offset - 1
  }
  // Each other look-ahead of the rule stops within a few characters of where
  // the address would stop it.
  const end = rule.plain.exec(before < 0 ? src : src.slice(0, before + 8))![0].length
  return before >= 0 && end > before ? before + 1 : end
}

// marked 17's GFM url rule reads a link from its scheme or `www.`, or an
// address from its local part: a run of `[A-Za-z0-9._+-]` only an `@` may
// end. It read that run at each step, so a run cut at each `++`, as in
// `a++a++…`, cost quadratic time. The importer finds where the run ends once
// per text and tries the rule only where it can match.
const MARKED_URL_RULE = String.raw`^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])`
// A link matches as soon as its scheme or `www.` has a domain character
// after it, and fails at once without one.
const URL_LINK = /^(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)[a-zA-Z0-9-]/
const NOT_LOCAL_PART = /[^A-Za-z0-9._+-]/g
const URL_DOMAIN = /[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/y

// Whether a tokenizer's rule is the marked rule whose source the importer
// reads, remembering the last rule that was, since marked asks at each step.
function markedRule(matches: (source: string) => boolean): (rule: RegExp) => boolean {
  let known: RegExp | undefined
  return rule => rule === known || (matches(rule.source) && (known = rule) === rule)
}
const isMarkedUrl = markedRule(source => source === MARKED_URL_RULE)

function urlMayStart(tokenizer: Tokenizer, src: string): boolean {
  const read = readingInlineText(tokenizer.lexer)
  if (!isMarkedUrl(tokenizer.rules.inline.url) || !read || read.step !== src.length || URL_LINK.test(src)) return true
  const from = read.text.length - src.length
  let found = read.localPart
  if (!found || found.from > from || (found.at >= 0 && found.at < from)) {
    NOT_LOCAL_PART.lastIndex = from
    const at = NOT_LOCAL_PART.exec(read.text)?.index ?? -1
    URL_DOMAIN.lastIndex = at + 1
    found = read.localPart = { from, at, address: read.text[at] === '@' && URL_DOMAIN.test(read.text) }
  }
  return found.at > from && found.address
}

// marked's hard-break rule looks ahead through the white space after the
// break for the end of the text, so breaks between white space, such as a
// no-break space and `  \n` repeated, cost quadratic time. The text ends in
// white space from the same place at every break, found once per text.
const MARKED_BREAK_RULE = String.raw`^( {2,}|\\)\n(?!\s*$)`
const BREAK = /( {2,}|\\)\n/y
const isMarkedBreak = markedRule(source => source === MARKED_BREAK_RULE)

function hardBreak(tokenizer: Tokenizer, src: string): Tokens.Br | undefined {
  if (!isMarkedBreak(tokenizer.rules.inline.br)) return Tokenizer.prototype.br.call(tokenizer, src)
  // Only a space or a backslash starts a break.
  if (src[0] !== ' ' && src[0] !== '\\') return undefined
  const read = readingInlineText(tokenizer.lexer)
  if (!read || read.step !== src.length) return Tokenizer.prototype.br.call(tokenizer, src)
  BREAK.lastIndex = 0
  const raw = BREAK.exec(src)?.[0]
  read.blankEnd ??= read.text.trimEnd().length
  return raw && read.text.length - src.length + raw.length < read.blankEnd ? { type: 'br', raw } : undefined
}

// marked's emphasis and strikethrough rules scan the rest of the masked text
// for a closer each time a run of `*`, `_` or `~` opens. Each run their
// right-delimiter rule finds counts: one that only opens adds its length, and
// one that closes takes it away, until a closer takes the count to zero. A
// run that may do both closes, unless it breaks emphasis's rule of three, and
// strikethrough counts only runs as long as its opener. So a paragraph of
// openers, or of openers before one closer, such as `*a *a … a*`, cost
// quadratic time. The importer reads each masked text's runs once with the
// same rule, and runs marked's only where the count can reach zero.
//
// marked's rule finds the same runs from any start but its first branch,
// which matches only at the start and skips what it matches.
type Rules = Tokenizer['rules']
// A rule that finds nothing, at once. It is a RegExp like the rules it
// replaces, so marked's code that reads them sees one kind of object.
const NO_MATCH = /(?!)/y
type DelimiterRule = {
  opener: string
  runs: RegExp
  first: RegExp
  // Whether marked's rule may go on to scan, from its opener rule's match.
  // It also checks the character before the opener, which only stops it.
  opens: (open: RegExpExecArray | null) => boolean
  key: (opener: number) => number
  // A run's count for openers of one key, which may close them if above zero.
  count: (kinds: number, run: number, key: number) => number
}
const OPENS = 1
const CLOSES = 2
const RUN_KINDS = [0, CLOSES, CLOSES, OPENS, OPENS, OPENS | CLOSES, OPENS | CLOSES]
const EMPHASIS_RUNS = String.raw`(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))`
const UNDERSCORE_RUNS = String.raw`(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])`
const STRIKE_RUNS = String.raw`(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])`
const EMPHASIS_OPENER = String.raw`^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?`
const emphasisCount = (kinds: number, run: number, key: number) =>
  kinds === OPENS ? -run : kinds === (OPENS | CLOSES) && key && (key + run) % 3 === 0 ? 0 : run
const strikeCount = (kinds: number, run: number, key: number) =>
  run !== key ? 0 : kinds === OPENS ? -run : run
const emphasisOpens: DelimiterRule['opens'] = open => !!open && !!(open[1] || open[2] || open[3] || open[4])
const strikeOpens: DelimiterRule['opens'] = open => !!open
const DELIMITER_RULES = new Map<string, DelimiterRule>([
  [String.raw`^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|${EMPHASIS_RUNS}`, {
    opener: EMPHASIS_OPENER,
    runs: new RegExp(String.raw`[^*]+(?=[^*])|${EMPHASIS_RUNS}`, 'gu'),
    first: /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/uy,
    opens: emphasisOpens,
    key: opener => opener % 3,
    count: emphasisCount,
  }],
  [String.raw`^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|${UNDERSCORE_RUNS}`, {
    opener: EMPHASIS_OPENER,
    runs: new RegExp(String.raw`[^_]+(?=[^_])|${UNDERSCORE_RUNS}`, 'gu'),
    first: /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/uy,
    opens: emphasisOpens,
    key: opener => opener % 3,
    count: emphasisCount,
  }],
  [String.raw`^[^~]+(?=[^~])|${STRIKE_RUNS}`, {
    opener: String.raw`^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])`,
    runs: new RegExp(STRIKE_RUNS, 'gu'),
    first: /[^~]+(?=[^~])/uy,
    opens: strikeOpens,
    key: opener => opener,
    count: strikeCount,
  }],
])

// Each run of a masked text, and for each key, the counts summed before
// each run and the highest sum a closer from each run on reaches.
type DelimiterRuns = {
  starts: number[]
  kinds: number[]
  lengths: number[]
  sums: Map<number, { before: Float64Array; best: Float64Array }>
}
const maskedRuns = new WeakMap<InlineText, Map<DelimiterRule, DelimiterRuns>>()

function delimiterRuns(read: InlineText, masked: string, rule: DelimiterRule): DelimiterRuns {
  let cached = maskedRuns.get(read)
  if (!cached) maskedRuns.set(read, cached = new Map())
  let found = cached.get(rule)
  if (!found) {
    found = { starts: [], kinds: [], lengths: [], sums: new Map() }
    rule.runs.lastIndex = 0
    for (let match = rule.runs.exec(masked); match; match = rule.runs.exec(masked)) {
      let group = 1
      while (group < RUN_KINDS.length && !match[group]) group += 1
      const run = match[group]
      if (!run) continue
      found.starts.push(match.index + match[0].length - run.length)
      found.kinds.push(RUN_KINDS[group]!)
      found.lengths.push(run.length)
    }
    cached.set(rule, found)
  }
  return found
}

function delimiterSums(runs: DelimiterRuns, rule: DelimiterRule, key: number): { before: Float64Array; best: Float64Array } {
  let sums = runs.sums.get(key)
  if (!sums) {
    const total = runs.starts.length
    const before = new Float64Array(total + 1)
    for (let at = 0; at < total; at += 1) before[at + 1] = before[at]! + rule.count(runs.kinds[at]!, runs.lengths[at]!, key)
    const best = new Float64Array(total + 1)
    best[total] = -Infinity
    for (let at = total - 1; at >= 0; at -= 1) {
      best[at] = rule.count(runs.kinds[at]!, runs.lengths[at]!, key) > 0 ? Math.max(best[at + 1]!, before[at + 1]!) : best[at + 1]!
    }
    runs.sums.set(key, sums = { before, best })
  }
  return sums
}

// marked's opener rule reads the whole run of delimiters at each place in
// it, so a long run cost quadratic time too. Where the run ends is found once
// per run, and for a run longer than three the importer reads three of its
// delimiters and the character after them, which decide the rule the same
// way.
function runEnd(read: InlineText, at: number): number {
  const { text, run } = read
  if (run && run.start <= at && at < run.end && text[at] === text[run.start]) return run.end
  let end = at
  while (text[end] === text[at]) end += 1
  if (run) {
    run.start = at
    run.end = end
  } else read.run = { start: at, end }
  return end
}

// The rule for marked's opener and closer rules, checked once for each pair.
const delimiterRules = new WeakMap<RegExp, { opener: RegExp; rule: DelimiterRule | undefined }>()

function delimiterRule(opener: RegExp, closer: RegExp): DelimiterRule | undefined {
  let found = delimiterRules.get(closer)
  if (found?.opener !== opener) {
    const rule = DELIMITER_RULES.get(closer.source)
    found = { opener, rule: rule && closer.flags === 'gu' && opener.source === rule.opener ? rule : undefined }
    delimiterRules.set(closer, found)
  }
  return found.rule
}

// In an ordinary text each opener's closer follows soon, so marked's own
// scans read less than reading every run first. The importer lets them run
// until they have read as much as the text holds, and reads the runs then.
type Closing = 'none' | 'closer' | 'scan'

function mayClose(read: InlineText, rules: Rules, src: string): Closing {
  const { masked } = read
  const strike = src[0] === '~'
  const opener = strike ? rules.inline.delLDelim : rules.inline.emStrongLDelim
  const closer = strike ? rules.inline.delRDelim : src[0] === '_' ? rules.inline.emStrongRDelimUnd : rules.inline.emStrongRDelimAst
  const rule = delimiterRule(opener, closer)
  if (!rule || masked === undefined || read.step !== src.length) return 'closer'
  const offset = read.text.length - src.length
  const length = runEnd(read, offset) - offset
  if (length > 3 && !rule.opens(opener.exec(src.slice(0, 3) + src.slice(length, length + 2)))) return 'none'
  if ((read.scanned ?? 0) < read.text.length) return 'scan'
  // The rule scans the end of the masked text as long as the rest, past the
  // opener. Starting inside a character, it would read it differently.
  const from = Math.max(0, masked.length - src.length + length)
  const last = masked.charCodeAt(from - 1)
  if (last >= 0xd800 && last <= 0xdbff) return 'closer'
  rule.first.lastIndex = from
  const first = rule.first.exec(masked)
  const end = first ? from + first[0].length : from + 1
  const runs = delimiterRuns(read, masked, rule)
  let low = 0
  let high = runs.starts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (runs.starts[middle]! < end) low = middle + 1
    else high = middle
  }
  const { before, best } = delimiterSums(runs, rule, rule.key(length))
  return best[low]! - before[low]! >= length ? 'closer' : 'none'
}

// The importer decides at each step, in the extension marked tries right
// before its own rules, so marked calls its emphasis and strikethrough rules
// itself and nested emphasis takes no more of the stack than in marked. For
// a step whose opener can find no closer, their opener rules find nothing.
// Only a run of `*`, `_` or `~` can open, so this lasts the one step.
const DELIMITED = new Set(['em', 'strong', 'del'])
const unopenedRules = new WeakMap<Rules, Rules>()
let unopened: { tokenizer: Tokenizer; rules: Rules } | undefined
// How many texts a scan of marked's has read in, still to count. With none,
// and no rules to restore, only a step at a delimiter needs deciding.
let scans = 0

function skipUnclosed(lexer: Lexer, src: string, tokens: Token[]): void {
  if (!unopened && !scans && src[0] !== '*' && src[0] !== '_' && src[0] !== '~') return
  reopen()
  const read = readingInlineText(lexer)
  if (!read) return
  if (read.scanning !== undefined) {
    // marked's scan read to the closer of the token it made, or the rest.
    const token = tokens.at(-1)
    read.scanned = (read.scanned ?? 0) + (token && DELIMITED.has(token.type) ? read.scanning - src.length : read.scanning)
    read.scanning = undefined
    scans -= 1
  }
  const tokenizer = lexer.options.tokenizer
  if ((src[0] !== '*' && src[0] !== '_' && src[0] !== '~') || !tokenizer) return
  const { rules } = tokenizer
  const closing = mayClose(read, rules, src)
  if (closing === 'scan') {
    read.scanning = src.length
    scans += 1
  }
  if (closing !== 'none') return
  let skipping = unopenedRules.get(rules)
  if (!skipping) {
    skipping = { ...rules, inline: { ...rules.inline, emStrongLDelim: NO_MATCH, delLDelim: NO_MATCH } }
    unopenedRules.set(rules, skipping)
  }
  tokenizer.rules = skipping
  unopened = { tokenizer, rules }
}

function reopen(): void {
  if (!unopened) return
  unopened.tokenizer.rules = unopened.rules
  unopened = undefined
}

// marked's link rule reads a destination to the `)` that ends the link, and
// its tag rule a comment, an instruction, a declaration or a CDATA section to
// its end. With none in the rest of the text, each opener read the rest for
// nothing.
const nextParenthesis = nextCharacter(')')
const nextText = (end: string): RestSearch => (text, from) => text.indexOf(end, from)
const TAG_ENDS: Array<{ opener: RegExp; from: number; end: RestSearch }> = [
  // `<!-->` and `<!--->` are whole comments.
  { opener: /^<!--(?!-?>)/, from: 4, end: nextText('-->') },
  { opener: /^<\?/, from: 2, end: nextText('?>') },
  { opener: /^<!\[CDATA\[/, from: 9, end: nextText(']]>') },
  { opener: /^<![a-zA-Z]/, from: 3, end: nextCharacter('>') },
]

function linkMayClose(read: InlineText | undefined, src: string): boolean {
  return !read || read.step !== src.length || !(src.startsWith('[') || src.startsWith('!['))
    || searchInlineText(read, src, 0, nextParenthesis) >= 0
}

// marked's code span rule reads the rest of the text for a run of backticks
// as long as its opener. With none left, each opener read the rest for
// nothing.
const closingTicks = new Map<number, RestSearch>()

function codeMayClose(read: InlineText | undefined, src: string): boolean {
  if (!read || read.step !== src.length || !src.startsWith('`')) return true
  const offset = read.text.length - src.length
  const opener = runEnd(read, offset) - offset
  let search = closingTicks.get(opener)
  if (!search) {
    search = (text, from) => {
      for (let at = text.indexOf('`', from); at >= 0;) {
        let end = at
        while (text[end] === '`') end += 1
        if (end - at === opener && text[at - 1] !== '`') return at
        at = text.indexOf('`', end)
      }
      return -1
    }
    closingTicks.set(opener, search)
  }
  // The span holds at least one character.
  return searchInlineText(read, src, opener + 1, search) >= 0
}

function tagMayClose(read: InlineText | undefined, src: string): boolean {
  // Each opener in `TAG_ENDS` starts `<!` or `<?`.
  if (!read || read.step !== src.length || src[0] !== '<' || (src[1] !== '!' && src[1] !== '?')) return true
  const tag = TAG_ENDS.find(({ opener }) => opener.test(src))
  return !tag || searchInlineText(read, src, tag.from, tag.end) >= 0
}

// marked's setext rule reads a paragraph's lines up to an underline, and
// stops before a line that could interrupt the paragraph, or at a character
// its `.` does not match. Where the rest of a block text holds no underline
// before either, it reads them at each step for nothing. The importer finds
// all three once per block text, with the interrupting lines taken from
// marked's own rule.
type SetextRule = { underline: RestSearch; interrupt: RestSearch; blocker: RestSearch }
const SETEXT_RULE = /^\^\(\?!(.+)\)\(\(\?:\.\|\\n\(\?!\\s\*\?\\n\|\1\)\)\+\?\)\\n \{0,3\}\(=\+\|-\+\) \*\(\?:\\n\+\|\$\)$/
const setextRules = new WeakMap<RegExp, SetextRule | null>()
const firstMatch = (pattern: RegExp): RestSearch => (text, from) => {
  pattern.lastIndex = from
  return pattern.exec(text)?.index ?? -1
}

function setextRule(rule: RegExp): SetextRule | null {
  let setext = setextRules.get(rule)
  if (setext === undefined) {
    const interrupts = SETEXT_RULE.exec(rule.source)?.[1]
    setext = interrupts && !rule.flags
      ? {
          underline: firstMatch(/\n {0,3}(?:=+|-+) *(?:\n|$)/g),
          interrupt: firstMatch(new RegExp(`\\n(?=\\s*?\\n|${interrupts})`, 'g')),
          blocker: firstMatch(/[\r\p{Zl}\p{Zp}]/gu),
        }
      : null
    setextRules.set(rule, setext)
  }
  return setext
}

// marked's table rule reads its header line to the newline before trying
// the delimiter row, so a long line cut at each `$` read it at each cut. It
// also reads every row before it checks the header against the delimiter
// row, which decide alone whether it reads a table, so lines that each start
// no table, such as `|` and `| - |` repeated, read the rest at each line.
// Once it finds no table in a block text, it checks those two lines first.
const TABLE_RULE_START = String.raw`^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+`
const TABLE_DELIMITER_START = / {0,3}(?:\| *)?:?-/y
const isMarkedTable = markedRule(source => source.startsWith(TABLE_RULE_START))
// Its own search, so its answers stay apart from the first line's.
const nextDelimiterEnd = nextCharacter('\n')

// marked's paragraph rule ends a paragraph before a line that starts a table,
// and its look-ahead reads all of that table's rows first, so paragraphs
// before rows that each could start a table, such as `|` and `| - |`
// repeated, read the rest at each paragraph. The rows may be empty, so the
// look-ahead matches exactly when the first two lines and the newline or end
// after them do. The importer reads paragraphs with marked's rule without the
// rows, which matches the same text.
const TABLE_ROWS = String.raw`(?:\n((?:(?! *\n|`
const paragraphRules = new WeakMap<RegExp, RegExp>()

function paragraphRule(rules: Rules): RegExp {
  const { paragraph, table } = rules.block
  let found = paragraphRules.get(paragraph)
  if (!found) {
    const own = table.source.slice(1)
    const rows = own.indexOf(TABLE_ROWS)
    const at = paragraph.source.indexOf(own)
    found = table.source.startsWith(TABLE_RULE_START) && rows > 0 && at >= 0 && at === paragraph.source.lastIndexOf(own)
      ? new RegExp(paragraph.source.slice(0, at) + own.slice(0, rows) + String.raw`(?:\n|$)` + paragraph.source.slice(at + own.length), paragraph.flags)
      : paragraph
    paragraphRules.set(paragraph, found)
  }
  return found
}

const extensions: AnyExtension[] = [
  MarkdownHtml,
  MarkdownDefinition,
  ...dohcMarkdownExtensions,
  StarterKit.configure({ listItem: false, orderedList: false, paragraph: false, underline: false }),
  MarkdownUnderline,
  MarkdownParagraph,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
  DohcTaskItem,
  DohcMarkdownTable,
  TableCell,
  TableHeader,
  TableRow,
]
// marked keeps a `def` token only for the first definition of a label and
// discards a later one without a token. Each later one gets a numbered tag
// that starts with `]`, which no reference can name, since a label cannot
// start with an unescaped `]`. So marked keeps its token too, and the line
// stays as text. The count lives with each lexer, so each tag costs one check.
const repeatedDefinitions = new WeakMap<object, number>()
//
// Tiptap applies a link's destination and title to the link's text, so a
// link with no text, as in `[](https://example.com "title")`, vanishes. The
// engine's fold keeps it as text, and so does this: the link becomes an
// `escape` token, which Tiptap keeps as the text the file holds. The
// serializer reads definitions with the same probe.
const literalProbe = new Tokenizer()
literalProbe.lexer = new Lexer({ ...getDefaults(), tokenizer: literalProbe })
const markdownParser = new Marked({
  extensions: [{
    name: 'dohcEmptyLink',
    level: 'inline',
    start(src) {
      return findInlineStart(this.lexer, src, EMPTY_LINK_START)
    },
    tokenizer(src, tokens) {
      // marked tries every inline extension before its own rules, so this
      // runs at each step that reaches marked's rules, such as its text and
      // url rules.
      stepInlineText(tokens, src)
      skipUnclosed(this.lexer, src, tokens)
      if (!src.startsWith('[](') || !linkMayClose(readingInlineText(this.lexer), src)) return undefined
      const link = literalProbe.link(src)
      return link?.type === 'link'
        ? { type: 'escape', raw: link.raw, text: sourceText(link.raw) }
        : undefined
    },
  }, {
    // A link with no text the serializer wrote as references. marked's text
    // rule stops at the `_` each sentinel holds, so only the first sentinel
    // can start this text, and a later one is found when the text reaches it.
    name: 'dohcWrittenLink',
    level: 'inline',
    start: (src) => {
      if (writtenLinks.openers.size === 0) return undefined
      const at = nextSentinel(src)
      if (at < 0) return undefined
      WRITTEN_SENTINEL_AT.lastIndex = at
      const sentinel = WRITTEN_SENTINEL_AT.exec(src)?.[0]
      return sentinel && writtenLinks.openers.has(sentinel) ? at : undefined
    },
    tokenizer: writtenLink,
  }, {
    // The lexer's own tag rule reads the tag, so a raw `<a>` or `<pre>` still
    // changes how marked reads the text after it. Tiptap reads an opening tag
    // through its closing tag as one fragment, so the Markdown between them
    // stays text. A closing tag gathers that run back from the earliest open
    // tag it closes, the way Tiptap matches them.
    name: 'dohcHtmlTag',
    level: 'inline',
    tokenizer(src, tokens) {
      if (!src.startsWith('<')) return undefined
      // marked tries this before the extension that records each step.
      stepInlineText(tokens, src)
      const tag = this.lexer.options.tokenizer?.tag(src)
      if (!tag) return undefined
      const { raw } = tag
      const text = rawHtmlText(raw)
      // The tag patterns are Tiptap's own.
      if (/^<\/[\s]*[\w-]+/i.test(raw)) {
        const opened = closeOpenTag(tokens, raw)
        if (opened < 0) return { type: 'escape', raw, text }
        const run = rawHtmlText(tokens.splice(opened).map(htmlRunSource).join('') + raw)
        return { type: 'escape', raw, text: run, dohcHtmlRun: true }
      }
      const open = /^<[\s]*([\w-]+)(\s|>|\/|$)/i.exec(raw)
      if (open && !raw.endsWith('/>')) recordOpenTag(tokens, open[1]!)
      return { type: 'escape', raw, text }
    },
  }, {
    // marked tries every block extension before its own rules, so this runs
    // at each step that reaches them.
    name: 'dohcBlockStep',
    level: 'block',
    tokenizer(src, tokens) {
      stepBlockText(tokens, src)
      return undefined
    },
  }],
  hooks: {
    emStrongMask: maskedText,
  },
})

// marked wraps each tokenizer its options give it in a function that copies
// its arguments, at every step that reaches the rule, so the importer's rules
// go on its tokenizer itself.
markdownParser.defaults.tokenizer = Object.assign(new Tokenizer(), {
  table(this: Tokenizer, src: string) {
    const read = steppedBlockText(this.lexer, src)
    if (read && isMarkedTable(this.rules.block.table)) {
      const line = searchBlockText(read, src, 0, nextLine)
      TABLE_DELIMITER_START.lastIndex = line + 1
      if (line < 0 || !TABLE_DELIMITER_START.test(src)) return undefined
      if (read.tableRefused) {
        const second = searchBlockText(read, src, line + 1, nextDelimiterEnd)
        if (!readsTable(src.slice(0, second < 0 ? undefined : second), this.rules.block.table)) return undefined
      }
    }
    const table = Tokenizer.prototype.table.call(this, src)
    if (read && !table) read.tableRefused = true
    return table
  },
  lheading(this: Tokenizer, src: string) {
    const read = steppedBlockText(this.lexer, src)
    const rule = read && setextRule(this.rules.block.lheading)
    if (read && rule) {
      const underline = searchBlockText(read, src, 1, rule.underline)
      if (underline < 0) return undefined
      const interrupt = searchBlockText(read, src, 0, rule.interrupt)
      const blocker = searchBlockText(read, src, 0, rule.blocker)
      if ((interrupt >= 0 && interrupt < underline) || (blocker >= 0 && blocker < underline)) return undefined
    }
    return Tokenizer.prototype.lheading.call(this, src)
  },
  // marked's own paragraph tokenizer, with the importer's paragraph rule.
  paragraph(this: Tokenizer, src: string): Tokens.Paragraph | undefined {
    shortenLastParagraph(this.lexer)
    const cap = paragraphRule(this.rules).exec(src)
    if (!cap) return undefined
    const paragraph = cap[1]!
    const text = paragraph.charAt(paragraph.length - 1) === '\n' ? paragraph.slice(0, -1) : paragraph
    return { type: 'paragraph', raw: cap[0], text, tokens: this.lexer.inline(text) }
  },
  def(this: Tokenizer, src: string) {
    const escaped = escapedDefinition(src)
    const token = escaped ?? Tokenizer.prototype.def.call(this, src)
    if (!token || (!escaped && !Object.hasOwn(this.lexer.tokens.links, token.tag))) return token
    const count = (repeatedDefinitions.get(this.lexer) ?? 0) + 1
    repeatedDefinitions.set(this.lexer, count)
    token.tag = `]${count}`
    return token
  },
  // Each inline rule's opener starts with one of its characters.
  link(this: Tokenizer, src: string) {
    if (src[0] !== '[' && src[0] !== '!') return undefined
    return linkMayClose(readingInlineText(this.lexer), src) ? Tokenizer.prototype.link.call(this, src) : undefined
  },
  tag(this: Tokenizer, src: string) {
    if (src[0] !== '<') return undefined
    return tagMayClose(readingInlineText(this.lexer), src) ? Tokenizer.prototype.tag.call(this, src) : undefined
  },
  codespan(this: Tokenizer, src: string) {
    if (src[0] !== '`') return undefined
    return codeMayClose(readingInlineText(this.lexer), src) ? Tokenizer.prototype.codespan.call(this, src) : undefined
  },
  url(this: Tokenizer, src: string) {
    return urlMayStart(this, src) ? Tokenizer.prototype.url.call(this, src) : undefined
  },
  br(this: Tokenizer, src: string) {
    return hardBreak(this, src)
  },
  inlineText(this: Tokenizer, src: string) {
    const end = textEnd(this, src)
    const token = end === undefined
      ? Tokenizer.prototype.inlineText.call(this, src)
      : { type: 'text' as const, raw: src.slice(0, end), text: src.slice(0, end), escaped: this.lexer.state.inRawBlock }
    if (token) token.text = fileAngles(token.text)
    return token
  },
} satisfies Partial<Tokenizer>)

// Before the emphasis rules read a text, marked masks each reference to a
// defined link, then each escape, then each link, code span and tag, by
// copying the whole text around each one, so a paragraph of `\[` or `[x]`
// cost quadratic time. The importer gives marked's masking loops rules that
// find nothing, and masks the text once in the emphasis hook marked calls
// right after them, with marked's own rules and replacements.
const unmaskedRules = new WeakMap<Rules, Rules>()
let masking: { links: object | undefined; read: InlineText | undefined; tokenizer: Tokenizer; rules: Rules } | undefined

// Each text asks, so the rules last asked for answer at once.
let lastUnmasked: { rules: Rules; found: Rules } | undefined

function unmasked(rules: Rules): Rules {
  if (lastUnmasked?.rules === rules) return lastUnmasked.found
  let found = unmaskedRules.get(rules)
  if (!found) {
    found = { ...rules, inline: { ...rules.inline, reflinkSearch: NO_MATCH, anyPunctuation: NO_MATCH, blockSkip: NO_MATCH } }
    unmaskedRules.set(rules, found)
  }
  lastUnmasked = { rules, found }
  return found
}

// Each match of `pattern` in `text` replaced as `mask` gives, in one copy.
function maskEach(text: string, pattern: RegExp, mask: (match: RegExpExecArray) => [number, string] | undefined): string {
  const masked: string[] = []
  let kept = 0
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const replaced = mask(match)
    if (!replaced) continue
    masked.push(text.slice(kept, replaced[0]), replaced[1])
    kept = match.index + match[0].length
  }
  if (!masked.length) return text
  masked.push(text.slice(kept))
  return masked.join('')
}

function maskedText(text: string): string {
  if (!masking) return text
  const { links, read, rules } = masking
  const { reflinkSearch, anyPunctuation, blockSkip } = rules.inline
  unmask()
  let source = text
  // A reference's mask keeps the text's length, and marked's next search
  // starts past it, so later matches read the same characters.
  if (links && definesLink(links) && source.includes('[')) {
    source = maskEach(source, reflinkSearch, match => Object.hasOwn(links, match[0].slice(match[0].lastIndexOf('[') + 1, -1))
      ? [match.index, `[${'a'.repeat(match[0].length - 2)}]`]
      : undefined)
  }
  if (source.includes('\\')) {
    source = maskEach(source, anyPunctuation, match => {
      // marked searches on from where the escape ended in the text before it
      // shortened it, so past an escaped astral character it skips one more.
      anyPunctuation.lastIndex += match[0].length - 2
      return [match.index, '++']
    })
  }
  // These masks keep the length too, and none could start right after a code
  // span.
  if (/[[`<]/.test(source)) {
    source = maskEach(source, blockSkip, match => {
      const offset = match[2] ? match[2].length : 0
      return [match.index + offset, `[${'a'.repeat(match[0].length - offset - 2)}]`]
    })
  }
  // The emphasis and strikethrough rules scan this text.
  if (read) read.masked = source
  return source
}

function definesLink(links: object): boolean {
  for (const _ in links) return true
  return false
}

// Block lexing must protect content tabs from list indentation expansion, but
// inline lexing must see whitespace when it decides emphasis boundaries.
class ContentTabLexer<ParserOutput = string, RendererOutput = string> extends Lexer<ParserOutput, RendererOutput> {
  blockTokens(src: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[]
  blockTokens(src: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList
  blockTokens(src: string, tokens: Token[] = [], lastParagraphClipped = false): Token[] {
    lexing.read += src.length
    if (lexing.read > lexing.budget) throw new MarkdownNestingRefusal('lexing')
    if (lexing.depth === MAX_LEXING_DEPTH) throw new MarkdownNestingRefusal('depth')
    lexing.depth += 1
    enterBlockText(this, src, tokens)
    try {
      return super.blockTokens(src, tokens, lastParagraphClipped)
    } finally {
      lexing.depth -= 1
      leaveBlockText(this, tokens)
    }
  }

  // Emphasis, strikethrough and links lex their text through here again.
  inlineTokens(src: string, tokens: Token[] = []): Token[] {
    if (lexing.inline === MAX_INLINE_DEPTH) throw new MarkdownNestingRefusal('depth')
    lexing.inline += 1
    const text = parseTabs.size ? restoreParseSentinels(src, parseTabs) : src
    enterText(this, text, tokens)
    try {
      return super.inlineTokens(text, tokens)
    } finally {
      lexing.inline -= 1
      leaveText(this, tokens)
    }
  }
}

// These sit outside the lexer's own frame, which nested emphasis repeats on
// the stack at each level.
function enterText<ParserOutput, RendererOutput>(lexer: Lexer<ParserOutput, RendererOutput>, text: string, tokens: Token[]): void {
  enterInlineText(lexer, text, tokens)
  reopen()
  const tokenizer = lexer.options.tokenizer
  const rules = lexer.options.hooks === markdownParser.defaults.hooks ? tokenizer?.rules : undefined
  if (!tokenizer || !rules) return
  // marked's masks change only a text with an escape, a bracket, a code span
  // or a tag. Any other text is its own masked text, and marked's loops read
  // it once.
  if (!MASKED_CHARACTER.test(text)) {
    readingInlineText(lexer)!.masked = text
    return
  }
  tokenizer.rules = unmasked(rules)
  masking = { links: lexer.tokens.links, read: readingInlineText(lexer), tokenizer, rules }
}
const MASKED_CHARACTER = /[\\[`<]/

function leaveText<ParserOutput, RendererOutput>(lexer: Lexer<ParserOutput, RendererOutput>, tokens: Token[]): void {
  unmask()
  reopen()
  // A scan the text's last step began counts nowhere.
  const read = readingInlineText(lexer)
  if (read?.scanning !== undefined) {
    read.scanning = undefined
    scans -= 1
  }
  leaveInlineText(lexer, tokens)
}

// The emphasis hook restores the rules once marked's masking loops end, so
// this restores them only when they threw.
function unmask(): void {
  if (!masking) return
  masking.tokenizer.rules = masking.rules
  masking = undefined
}
markdownParser.Lexer = ContentTabLexer

const markdownManager = new MarkdownManager({
  marked: markdownParser as unknown as typeof marked,
  extensions,
  indentation: { style: 'space', size: 2 },
})
let projectedManager: MarkdownManager | undefined
function projectedMarkdownManager(): MarkdownManager {
  return projectedManager ??= new MarkdownManager({
    marked: markdownParser as unknown as typeof marked,
    extensions: extensions.map(extension => extension.name === 'dohcMarkdownLists' ? DohcProjectedMarkdownLists : extension),
    indentation: { style: 'space', size: 2 },
  })
}
const schema = getSchema(extensions)

type DohcMeta = { schemaVersion: number; contentKind?: 'plain-text' }

export function markdownToYDoc(
  markdown: string,
  options: { clientID?: number; reading?: 'source' | 'projection' } = {},
): Y.Doc {
  const usesCrlf = markdown.includes('\r\n')
  const { meta, body, frontmatterSource } = parseFrontmatter(markdown, usesCrlf)
  const doc = new Y.Doc()
  if (options.clientID !== undefined) doc.clientID = options.clientID

  writeFrontmatterMap(doc.getMap(FRONTMATTER_FIELD), meta)
  writeFrontmatterMap(doc.getMap(META_FIELD), {
    schemaVersion: DOHC_SCHEMA_VERSION,
    ...(usesCrlf ? { [MARKDOWN_CRLF_META_KEY]: true } : {}),
    ...(frontmatterSource === undefined
      ? {}
      : { [FRONTMATTER_SOURCE_META_KEY]: frontmatterSource }),
  })
  if (frontmatterSource !== undefined) {
    recordFrontmatterSourceItems(doc.getMap(FRONTMATTER_FIELD), doc.getMap(META_FIELD))
  }

  const bodyFragment = getDohcYDocBodyFragment(doc)
  const tiptapJson = parseRichdocMarkdown(
    usesCrlf ? body.replaceAll('\r\n', '\n') : body, options.reading,
  )
  writeBodyFragment(tiptapJson, bodyFragment)

  return doc
}

// Yjs fills an element outside a document with one argument spread, which
// overflows the stack past about 124,000 children on a main thread and 498,000
// in a worker.
const MAX_DETACHED_CHILDREN = 10_000

/**
 * `prosemirrorJSONToYXmlFragment`, except that an element with more children
 * than Yjs can spread goes in empty and is filled once it is in the document.
 * The tree is the same; only the order Yjs numbers its items in differs.
 */
export function writeBodyFragment(json: JSONContent, fragment: Y.XmlFragment): void {
  const source = schema.nodeFromJSON(json)
  const fills: { path: number[]; node?: ProseMirrorNode }[] = []
  const path: number[] = []
  const detach = (node: ProseMirrorNode): ProseMirrorNode => {
    const wide = path.length > 0 && node.childCount > MAX_DETACHED_CHILDREN
      && yChildIndex(node, node.childCount) > MAX_DETACHED_CHILDREN
    const fill: (typeof fills)[number] | undefined = wide ? { path: [...path] } : undefined
    if (fill) fills.push(fill)
    let children: ProseMirrorNode[] | undefined
    node.forEach((child, _offset, index) => {
      path.push(index)
      const next = detach(child)
      path.pop()
      if (next !== child) (children ??= node.children.slice())[index] = next
    })
    const filled = children ? node.copy(Fragment.from(children)) : node
    if (!fill) return filled
    fill.node = filled
    return node.copy()
  }
  prosemirrorToYXmlFragment(detach(source), fragment)
  for (const { path, node } of fills) {
    let parent = source
    let target = fragment
    for (const index of path) {
      target = target.get(yChildIndex(parent, index)) as Y.XmlElement
      parent = parent.child(index)
    }
    updateYFragment(fragment.doc!, target, node, { mapping: new Map(), isOMark: new Map() })
  }
}

/** y-prosemirror keeps a run of text nodes as one child. */
function yChildIndex(parent: ProseMirrorNode, index: number): number {
  let children = 0
  for (let at = 0; at < index; at += 1) {
    if (!parent.child(at).isText || at === 0 || !parent.child(at - 1).isText) children += 1
  }
  return children
}

// The live document contract's limits: quotes inside quotes, and nodes inside
// nodes, below the document's own.
const MAX_QUOTE_DEPTH = 120
const MAX_STRUCTURE_DEPTH = 128
// How many times its own length, or 256 KiB if that is more, a note in the
// source reading may give block lexing. marked lexes each container's text
// again for each one inside it, and again for each lazy or setext
// continuation, so this bounds the work depth adds within the limits.
const LEXING_BUDGET = 16
const LEXING_FLOOR = 256 * 1024
// Block lexing nested this deep reads text inside a node deeper than the
// limit: the top level and a table's own text each add a level no node does.
// The preflight refuses such notes first; this keeps any it misses off the
// end of the stack.
const MAX_LEXING_DEPTH = MAX_STRUCTURE_DEPTH + 2
// Inline lexing nests at most this deep: a block's text and 15 levels of
// emphasis or strikethrough inside it. Each level lexes its text again, so
// this bounds the time a note full of them takes. The serializer's output
// nests at most 7 deep.
const MAX_INLINE_DEPTH = 16

/**
 * A note the live document contract does not read as rich text, because its
 * containers nest past the contract's limits (`depth`), or because lexing
 * them would pass the lexing budget (`lexing`).
 */

// The block lexing the parse in progress has done and may do, and how deeply
// block and inline lexing each nest now.
let lexing = { read: 0, budget: Infinity, depth: 0, inline: 0 }

// The containers that open a line before its text, as marked reads them, and
// where its text starts. A quote takes up to three spaces, `>` and one space
// or tab. A list item takes up to three spaces, its marker and the spaces
// after it, with marked's tab stops from its item's first line on, unless
// more than four make its text indented code; a bullet's item also takes a
// task box. A marker after only quotes, on a line that may continue a
// paragraph, opens nothing unless it could interrupt one. A thematic break
// ends the line's containers. Counting stops past either limit. `containers`
// gets each container in order: a quote as -1 less the spaces before its `>`,
// and an item as the width of its marker and the spaces after it, or one
// space if its text is blank or indented code.
function lineContainers(line: string, continues: boolean, containers?: number[]): LineContainers {
  let text = line
  let at = 0
  let quotes = 0
  let depth = 0
  let listed = false
  // Where the run of one character, besides white space, that ends the line
  // starts, once a marker could start a thematic break.
  let uniform = -1
  while (quotes <= MAX_QUOTE_DEPTH && depth <= MAX_STRUCTURE_DEPTH) {
    let start = at
    while (start - at < 3 && text[start] === ' ') start += 1
    const first = text[start]
    if (first === '>') {
      containers?.push(at - start - 1)
      at = start + 1
      if (text[at] === ' ' || text[at] === '\t') at += 1
      quotes += 1
      depth += 1
      continue
    }
    let end = start
    let ordered = ''
    if (first === '-' || first === '+' || first === '*') {
      if (first !== '+') {
        if (uniform < 0) uniform = uniformEnd(text)
        if (start >= uniform && thematicBreak(text, start)) break
      }
      end += 1
    } else {
      while (end - start < 9 && text[end]! >= '0' && text[end]! <= '9') end += 1
      if (end === start || (text[end] !== '.' && text[end] !== ')')) break
      ordered = text.slice(start, end)
      end += 1
    }
    if (end < text.length && text[end] !== ' ' && text[end] !== '\t') break
    if (!listed && text.includes('\t', end)) {
      let expanded = ''
      for (let index = end, column = end - at; index < text.length; index += 1) {
        const width = text[index] === '\t' ? 4 - (column % 4) : 1
        expanded += text[index] === '\t' ? ' '.repeat(width) : text[index]
        column += width
      }
      text = text.slice(0, end) + expanded
      uniform = -1
    }
    let content = end
    while (text[content] === ' ') content += 1
    const blank = content === text.length
    if (!listed && continues && (blank || (ordered !== '' && ordered !== '1'))) break
    depth += 2
    listed = true
    if (blank || content - end > 4) {
      containers?.push(end + 1 - at)
      if (blank) at = content
      break
    }
    containers?.push(content - at)
    at = content
    if (!ordered && text[at] === '[' && ' xX'.includes(text[at + 1] ?? '_') && text[at + 2] === ']' && text[at + 3] === ' ') {
      let box = at + 3
      while (text[box] === ' ') box += 1
      if (box === text.length) break
      at = box
    }
  }
  return { quotes, depth, text, at }
}
type LineContainers = { quotes: number; depth: number; text: string; at: number }

// Where the run of the line's last character, with white space, starts.
function uniformEnd(text: string): number {
  let index = text.length - 1
  while (index >= 0 && (text[index] === ' ' || text[index] === '\t')) index -= 1
  const last = text[index]
  while (index >= 0 && (text[index] === last || text[index] === ' ' || text[index] === '\t')) index -= 1
  return index + 1
}

// Whether three of `start`'s character follow it, in a run of only them and
// white space.
function thematicBreak(text: string, start: number): boolean {
  let count = 0
  for (let index = start; index < text.length && count < 3; index += 1) if (text[index] === text[start]) count += 1
  return count === 3
}

function blankFrom(text: string, at: number): boolean {
  for (let index = at; index < text.length; index += 1) if (text[index] !== ' ' && text[index] !== '\t') return false
  return true
}

// Whether a line's text from `at` leaves no paragraph for the next line to
// continue: it is blank, a heading or a thematic break, or indented code after
// a line that `continues` none.
function endsParagraph(text: string, at: number, continues: boolean): boolean {
  if (blankFrom(text, at)) return true
  if (text.startsWith('    ', at)) return !continues
  let start = at
  while (start - at < 3 && text[start] === ' ') start += 1
  const first = text[start]
  if (first === '#') {
    let end = start
    while (end - start < 7 && text[end] === '#') end += 1
    return end - start < 7 && (end === text.length || text[end] === ' ' || text[end] === '\t')
  }
  return (first === '-' || first === '*' || first === '_') && start >= uniformEnd(text) && thematicBreak(text, start)
}

// Whether a line that starts with `first` may open a container or a literal
// region.
function mayOpen(first: string | undefined): boolean {
  return first === ' ' || first === '>' || first === '-' || first === '+' || first === '*' || first === '`' || first === '~'
    || first === '<' || first === '$' || first === '[' || (first !== undefined && first >= '0' && first <= '9')
}

// A literal region a line opened: the containers each later line keeps, as
// `lineContainers` lists them, and where a line's text within them ends the
// region, or -1 while it goes on. A fence or an HTML block holds text marked
// never reads as containers, until its closing line or the end of the
// containers it opened in.
type LiteralRegion = { containers: number[]; ends: (text: string) => number }

// What a line's text follows: another block, a paragraph it may continue, or
// a paragraph an item it is not indented into may hold it in lazily.
type Follows = 'block' | 'paragraph' | 'lazy'
// The HTML that ends an item a line is not indented into, by marked's rule.
const ITEM_ENDING_HTML = literalProbe.rules.other.htmlBeginRegex(1)

// What a line opens at its text: a literal region, the index of the last line
// of a display math block, a definition, or an HTML block closed on its own
// line with no paragraph after it, or nothing. Each opens only where marked's
// own rule reads one. `rest` is the line's text within the containers earlier
// lines opened, `opened` reads the containers it opens itself, and
// `containers` lists both. After a paragraph, only a fence or an HTML block
// that may interrupt it opens. Where an item may hold the line lazily, only
// what marked's item rule ends the item for opens: a fence, or an HTML block
// that starts with a tag name and a later `>`, or with `<!--`.
function literalRegion(lines: string[], index: number, rest: string, opened: LineContainers, containers: number[], follows: Follows): LiteralRegion | number | undefined {
  const { text, at } = opened
  let start = at
  while (start - at < 3 && text[start] === ' ') start += 1
  const first = text[start]
  if (first !== '`' && first !== '~' && first !== '<' && first !== '$' && first !== '[') return undefined
  // marked expanded tabs before the text.
  if (text !== rest) return undefined
  if (first === '`' || first === '~') {
    let end = start
    while (text[end] === first) end += 1
    if (end - start < 3 || (first === '`' && text.includes('`', end))) return undefined
    const run = text.slice(start, end)
    return { containers, ends: line => fenceCloses(line, run) ? line.length : -1 }
  }
  if (first === '<') {
    const open = text.slice(start)
    if (follows === 'lazy' && !ITEM_ENDING_HTML.test(open)) return undefined
    const html = literalProbe.rules.block.html.exec(`${open}\n`)
    if (!html) return undefined
    const [, name, comment, block] = html
    if (follows === 'paragraph' && !name && comment === undefined && !block) return undefined
    const [end, from] = name ? [`</${name.toLowerCase()}>`, name.length + 1]
      : comment !== undefined ? ['-->', 4]
      : open.startsWith('<?') ? ['?>', 2]
      : /^<!\[CDATA\[/iu.test(open) ? [']]>', 9]
      : open.startsWith('<!') ? ['>', 2]
      : ['', 0]
    if (!end) return { containers, ends: line => blankFrom(line, 0) ? line.length : -1 }
    // A tag's or a comment's block takes the rest of its closing line; text
    // after any other closer starts a paragraph.
    const whole = !!name || comment !== undefined
    const close = (name ? open.toLowerCase() : open).indexOf(end, from)
    if (close >= 0 || (comment !== undefined && (open[4] === '>' || open.startsWith('->', 4)))) {
      return whole || blankFrom(open, close + end.length) ? index : undefined
    }
    return {
      containers,
      ends: line => {
        const close = (name ? line.toLowerCase() : line).indexOf(end)
        return close < 0 ? -1 : whole ? line.length : close + end.length
      },
    }
  }
  if (follows !== 'block') return undefined
  const following = (line: number) => index + line < lines.length ? within(lines[index + line], containers) : undefined
  if (first === '$') {
    // A math block opens with `$$` at its line's text and ends at the next
    // `$$`, which must end its line.
    if (start > at || text[start + 1] !== '$' || text.includes('$$', start + 2)) return undefined
    for (let line = 1; ; line += 1) {
      const inner = following(line)
      if (inner === undefined) return undefined
      const close = inner.indexOf('$$')
      if (close >= 0) return close + 2 === inner.length ? index + line : undefined
    }
  }
  const end = definitionEnd(text, start, following)
  return end ? index + end : undefined
}

// The text a line holds within the first `count` of `containers`, or
// undefined once it leaves them. A quote needs its `>`; an item holds a blank
// line, or one indented to its text.
function within(line: string, containers: readonly number[], count = containers.length): string | undefined {
  let text: string | undefined = line
  for (let index = 0; index < count && text !== undefined; index += 1) text = inside(text, containers[index])
  return text
}

function inside(text: string, container: number): string | undefined {
  let at = 0
  if (container < 0) {
    while (at < 3 && text[at] === ' ') at += 1
    if (text[at] !== '>') return undefined
    at += text[at + 1] === ' ' || text[at + 1] === '\t' ? 2 : 1
  } else {
    while (at < container && text[at] === ' ') at += 1
    if (at < container && !blankFrom(text, at)) return undefined
  }
  return text.slice(at)
}

// Whether a line closes a fence its opener's `run` opened: up to three
// spaces, the run, more fence characters and spaces.
function fenceCloses(text: string, run: string): boolean {
  if (!text.includes(run)) return false
  let close = 0
  while (close < 3 && text[close] === ' ') close += 1
  if (!text.startsWith(run, close)) return false
  close += run.length
  while (text[close] === '`' || text[close] === '~') close += 1
  while (text[close] === ' ') close += 1
  return close === text.length
}

// The line a definition starting at `start` ends on, counted from its first,
// as marked's rule reads it. `following` reads a later line within the
// definition's containers. Where marked could read a longer definition than
// this finds, this reads a shorter one or none.
function definitionEnd(text: string, start: number, following: (line: number) => string | undefined): number | undefined {
  // A label on the first line, with more than white space in it.
  let at = start + 1
  let label = false
  for (; text[at] !== ']'; at += 1) {
    const character = text[at]
    if (character === undefined || character === '[') return undefined
    if (character.trim()) label = true
    if (character === '\\') at += 1
  }
  if (!label || text[at + 1] !== ':') return undefined
  let line = 0
  let rest = text
  at += 2
  while (rest[at] === ' ') at += 1
  if (at === rest.length) {
    const destination = following(1)
    if (destination === undefined) return undefined
    line = 1
    rest = destination
    at = 0
    while (rest[at] === ' ' || rest[at] === '\t') at += 1
  }
  if (rest[at] === '<') {
    at = rest.indexOf('>', at) + 1
    if (at === 0) return undefined
  } else {
    if (!rest[at]?.trim()) return undefined
    while (rest[at]?.trim()) at += 1
  }
  // A title follows a space, or starts the next line.
  let spaces = at
  while (rest[spaces] === ' ') spaces += 1
  if (spaces < rest.length) return spaces > at ? titleEnd(rest, spaces, line, following) : undefined
  const next = following(line + 1)
  let title = 0
  while (next?.[title] === ' ' || next?.[title] === '\t') title += 1
  return (next === undefined ? undefined : titleEnd(next, title, line + 1, following)) ?? (line || undefined)
}

// The line a definition's title starting at `at` on `line` closes on, with
// only spaces after it.
function titleEnd(text: string, at: number, line: number, following: (line: number) => string | undefined): number | undefined {
  const opener = text[at]
  if (opener !== '"' && opener !== "'" && opener !== '(') return undefined
  const closer = opener === '(' ? ')' : opener
  let from = at + 1
  for (;;) {
    for (let index = from; index < text.length; index += 1) {
      const character = text[index]
      if (opener === '(' && character === '(') return undefined
      // marked's title may hold a `"` right after a backslash.
      if (character !== closer || (closer === '"' && text[index - 1] === '\\')) continue
      let end = index + 1
      while (text[end] === ' ') end += 1
      return end === text.length ? line : undefined
    }
    const next = following(line + 1)
    // A single-quoted title holds no blank line.
    if (next === undefined || (opener === "'" && next === '')) return undefined
    line += 1
    text = next
    from = 0
  }
}

// Refused before marked reads it, outside text it would hold literally.
function assertNestingWithinLimits(markdown: string, lines: string[]): void {
  // marked reads a lone `\r` as a line break too.
  if (markdown.includes('\r')) lines = markdown.split(/\r\n?|\n/u)
  let literal: LiteralRegion | undefined
  let continues = false
  // The containers earlier lines opened that may hold this line, as
  // `lineContainers` lists them.
  let held: number[] = []
  // Whether the last line opened the item `held` ends with and left no
  // paragraph in it.
  let ended = false
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    const after = ended
    ended = false
    if (literal) {
      const text = within(line, literal.containers)
      if (text !== undefined) {
        const end = literal.ends(text)
        if (end >= 0) literal = undefined
        continues = end < 0 || !blankFrom(text, end)
        continue
      }
      literal = undefined
    }
    const blank = blankFrom(line, 0)
    const first = line[0]
    if (!held.length && !mayOpen(first)) {
      continues = !endsParagraph(line, 0, continues)
      continue
    }
    // The line's text within the containers that hold it. An item the line
    // leaves ends after a blank line or a first line that left no paragraph,
    // or where the line opens a block; otherwise it may hold the line lazily,
    // and still holds the next.
    let kept = 0
    let rest = line
    for (; kept < held.length; kept += 1) {
      const text = inside(rest, held[kept])
      if (text === undefined) break
      rest = text
    }
    const item = kept < held.length && held[kept] >= 0
    const fresh = item && ((after && kept === held.length - 1) || blankFrom(within(lines[at - 1], held, kept) ?? '.', 0))
    // Those containers, then the ones the line opens.
    const containers = held.slice(0, kept)
    let region: LiteralRegion | number | undefined
    if (mayOpen(first)) {
      const opened = lineContainers(line, continues, held.length ? undefined : containers)
      if (opened.quotes > MAX_QUOTE_DEPTH || opened.depth > MAX_STRUCTURE_DEPTH) throw new MarkdownNestingRefusal('depth')
      const inner: LineContainers = held.length ? lineContainers(rest, continues && !item, containers) : opened
      const follows: Follows = item ? fresh || containers.length > kept ? 'block' : 'lazy'
        : continues && inner.depth === inner.quotes ? 'paragraph' : 'block'
      region = literalRegion(lines, at, rest, inner, containers, follows)
      continues = !endsParagraph(inner.text, inner.at, continues)
      ended = !continues && containers.length > kept && containers[containers.length - 1] >= 0
    } else continues = !endsParagraph(line, 0, continues)
    const opens = containers.length > kept
    if (kept < held.length ? blank || fresh || opens || region !== undefined : opens) {
      held = containers.length > MAX_LEXING_DEPTH ? containers.slice(0, MAX_LEXING_DEPTH) : containers
    }
    if (typeof region === 'number') {
      at = region
      continues = false
    } else literal = region
  }
}

export function parseRichdocMarkdown(markdown: string, reading: 'source' | 'projection' = 'source'): JSONContent {
  const reservedSentinels = new Set(
    markdown.match(PARSE_SENTINEL_RE) ?? [],
  )
  const entitySentinels = new Map<string, string>()
  let sentinelIndex = 0
  const reserveSentinel = (): string => {
    let sentinel: string
    do {
      sentinel = `\uE000DOHC_PARSE_${sentinelIndex}\uE001`
      sentinelIndex += 1
    } while (reservedSentinels.has(sentinel))
    reservedSentinels.add(sentinel)
    return sentinel
  }
  const sentinelFor = (value: string): string => {
    const sentinel = reserveSentinel()
    entitySentinels.set(sentinel, value)
    return sentinel
  }

  // Canonical list indentation must not make Marked expand a content tab.
  const projectionTabs = new Map<string, string>()
  const preserveTabs = (text: string) => text.replace(/\t/gu, () => {
    const sentinel = reserveSentinel()
    projectionTabs.set(sentinel, '\t')
    return sentinel
  })
  assertNestingWithinLimits(markdown, markdown.split('\n'))
  markdown = assertSupportedListMarkdown(markdown, reading === 'source' && markdown.includes('\t') ? preserveTabs : undefined)
  if (reading === 'projection' && markdown.includes('\t')) {
    markdown = preserveTabs(markdown)
  }

  // A block escape reads as its character anywhere, as does a leading space or
  // tab. Any other reference reads so only inside a tag the text holds.
  const tagReferences = new Set<string>()
  const itemWhitespaceEntities = new Set<string>()
  const prepared = markdown.replace(
    PARSE_REFERENCE_RE,
    (entity, code: string | undefined, offset: number, source: string) => {
      if (markdownCharacterIsEscaped(source, offset)) return entity
      const sentinel = sentinelFor(entity)
      const leading = (code === '9' || code === '32')
        && (offset === 0 || source[offset - 1] === '\n')
      if ((code === '9' || code === '32') && source[offset - 1] === ' '
      && (reading === 'projection'
        ? /^ *(?:> *)*(?:(?:[-+*]|\d{1,9}[.)]) (?:\[[ xX]\] )?)?$/u
        : /^ *$/u).test(source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset))) itemWhitespaceEntities.add(sentinel)
      if (code && !BLOCK_ESCAPE_CODES.has(Number(code)) && !leading) {
        tagReferences.add(sentinel)
      }
      return sentinel
    },
  )
  const markup = { lt: reserveSentinel(), gt: reserveSentinel(), used: false }
  const markupEntities = [[markup.lt, '<'], [markup.gt, '>']] as const
  const encodedEntities = new Map([...entitySentinels, ...markupEntities, ...projectionTabs])
  const tagEntities = new Map([
    ...Array.from(
      entitySentinels,
      ([sentinel, entity]) => [sentinel, decodeBlockEntity(entity)] as const,
    ),
    ...markupEntities,
    ...projectionTabs,
  ])
  const decodedEntities = new Map(
    Array.from(tagEntities, ([sentinel, value]) => [
      sentinel,
      tagReferences.has(sentinel) ? encodedEntities.get(sentinel) ?? value : value,
    ] as const),
  )
  parseReferences = entitySentinels
  parseTabs = projectionTabs
  rawHtmlMarkup = markup
  writtenLinks = {
    openers: writtenOpeners(prepared, entitySentinels),
    runs: new Map(),
    tokens: undefined,
    length: -1,
    sentinels: new WeakMap(),
  }
  let parsed: JSONContent
  try {
    // Include escaped and multiline labels, including definitions inside quotes.
    markdownListParseState.references = markdown.includes(']:')
    // The projection reads only what the serializer writes, so a live note
    // can always settle.
    lexing = { read: 0, budget: reading === 'source' ? LEXING_BUDGET * Math.max(prepared.length, LEXING_FLOOR) : Infinity, depth: 0, inline: 0 }
    parsed = (reading === 'projection' ? projectedMarkdownManager() : markdownManager).parse(prepared)
  } finally {
    lexing = { read: 0, budget: Infinity, depth: 0, inline: 0 }
    parseReferences = new Map()
    parseTabs = new Map()
    markdownListParseState.references = true
    rawHtmlMarkup = { lt: '<', gt: '>', used: false }
    writtenLinks = { openers: new Set(), runs: new Map(), tokens: undefined, length: -1, sentinels: new WeakMap() }
  }
  return ensureListItemParagraphs(
    entitySentinels.size || markup.used || projectionTabs.size
      ? restoreBlockEntityParseSentinels(parsed, { decodedEntities, encodedEntities, tagEntities, itemWhitespaceEntities })
      : parsed,
  )
}

// A list item's schema starts with a paragraph. Tiptap hands an item whose
// first block is a table straight through, and the Y.Doc conversion then
// drops the item. An annotated table is the first block of an item whose
// paragraph was empty, so give such an item its paragraph back.
function ensureListItemParagraphs(node: JSONContent, depth = -1, quoteDepth = 0): JSONContent {
  const quotes = quoteDepth + (node.type === 'blockquote' ? 1 : 0)
  if (depth > MAX_STRUCTURE_DEPTH || quotes > MAX_QUOTE_DEPTH) throw new MarkdownNestingRefusal('depth')
  if (node.type === 'image' && node.attrs) node.attrs.src = sanitizeImageSrc(String(node.attrs.src ?? ''))
  const content = node.content
  if (!content) return node
  for (const child of content) ensureListItemParagraphs(child, depth + 1, quotes)
  const needsParagraph = (node.type === 'listItem' || node.type === 'taskItem')
    && content[0]?.type !== 'paragraph'
  if (needsParagraph) content.unshift({ type: 'paragraph' })
  return node
}

function markdownCharacterIsEscaped(source: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function decodeBlockEntity(entity: string): string {
  const raw = /^&#(\d+);$/.exec(entity)
  if (raw) return String.fromCodePoint(Number(raw[1]))

  const encoded = /^(?:&amp;|&AMP;|&#0{0,5}38;|&#[xX]0{0,4}26;)(#\d+;)$/.exec(entity)
  if (encoded) return `&${encoded[1]}`
  throw new Error(
    `could not decode a Markdown block-escape entity sentinel: ${entity}`,
  )
}

type ParseReferences = {
  itemWhitespaceEntities: ReadonlySet<string>
  // Each reference's spelling, for code, links, and literal attributes.
  encodedEntities: Map<string, string>
  // Each reference read where the text holds no tag.
  decodedEntities: Map<string, string>
  // Each reference read as its character, inside a tag the text holds.
  tagEntities: Map<string, string>
}

// Where a text node sits in its block's tag span, if the block has one.
type TextSpan = { start: number; end: number; from: number }

function restoreBlockEntityParseSentinels(
  node: JSONContent,
  references: ParseReferences,
  insideCodeBlock = false,
  span?: TextSpan,
  insideItem = false,
): JSONContent {
  const { decodedEntities, encodedEntities, tagEntities, itemWhitespaceEntities } = references
  insideItem ||= node.type === 'listItem' || node.type === 'taskItem'
  const restored = node
  const insideCode = insideCodeBlock
    || node.type === 'codeBlock'
    || node.marks?.some(mark => mark.type === 'code')
  const textSentinels = typeof node.text === 'string'
    ? node.text.match(PARSE_SENTINEL_RE) ?? []
    : []
  const autolink = textSentinels.length > 0
    && node.marks?.some(mark => {
      if (mark.type !== 'link' || typeof mark.attrs?.href !== 'string') {
        return false
      }
      const hrefSentinels = new Set(
        mark.attrs.href.match(PARSE_SENTINEL_RE) ?? [],
      )
      return textSentinels.some(sentinel => hrefSentinels.has(sentinel))
    })
  if (typeof node.text === 'string') {
    restored.text = insideCode || autolink
      ? restoreParseSentinels(node.text, encodedEntities)
      : node.text.replace(PARSE_SENTINEL_RE, (sentinel, at: number) => {
          const inTag = span !== undefined
            && span.from + at >= span.start
            && span.from + at < span.end
          return (inTag || (insideItem && itemWhitespaceEntities.has(sentinel) && (at === 0 || node.text![at - 1] === '\n')) ? tagEntities : decodedEntities).get(sentinel) ?? sentinel
        })
  }
  if (node.attrs) {
    const preservesLiteralAttributes = node.type === 'codeBlock'
      || node.type === 'mathInline'
      || node.type === 'mathBlock'
      || node.type === 'wikilink'
      || node.type === 'inlineAtom'
      || node.type === 'callout'
    const attributes = restoreAttributeSentinels(
      node.attrs,
      preservesLiteralAttributes ? encodedEntities : decodedEntities,
    )
    if (node.type === 'image') {
      attributes.src = sanitizeImageSrc(String(attributes.src ?? ''))
    }
    restored.attrs = attributes
  }
  if (node.marks) {
    restored.marks = node.marks.map(mark => ({
      ...mark,
      ...(mark.attrs
        ? {
            attrs: restoreAttributeSentinels(
              mark.attrs,
              autolink && mark.type === 'link'
                ? encodedEntities
                : decodedEntities,
            ),
          }
        : {}),
    }))
  }
  if (node.content) {
    const tag = rawHtmlSpan(node.content)
    let from = 0
    restored.content = node.content.map((child, index) => {
      const childSpan = tag && { start: tag.start, end: tag.end, from }
      from += tag?.texts[index]?.length ?? 0
      return restoreBlockEntityParseSentinels(child, references, insideCode, childSpan, insideItem)
    })
  }
  return restored
}

function restoreAttributeSentinels(
  attributes: Record<string, unknown>,
  replacements: Map<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name,
      restoreAttributeValueSentinels(value, replacements),
    ]),
  )
}

function restoreAttributeValueSentinels(
  value: unknown,
  replacements: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    return restoreParseSentinels(value, replacements)
  }
  if (Array.isArray(value)) {
    return value.map(item => restoreAttributeValueSentinels(item, replacements))
  }
  if (value && typeof value === 'object') {
    return restoreAttributeSentinels(
      value as Record<string, unknown>,
      replacements,
    )
  }
  return value
}

function restoreParseSentinels(
  value: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return value.replace(
    PARSE_SENTINEL_RE,
    sentinel => replacements.get(sentinel) ?? sentinel,
  )
}

export function plainTextToYDoc(markdown: string): Y.Doc {
  const { meta, body, frontmatterSource } = parseFrontmatter(markdown, false)
  const doc = new Y.Doc()

  writeFrontmatterMap(doc.getMap(FRONTMATTER_FIELD), meta)
  writeFrontmatterMap(doc.getMap(META_FIELD), {
    schemaVersion: DOHC_SCHEMA_VERSION,
    contentKind: PLAIN_TEXT_CONTENT_KIND,
    ...(frontmatterSource === undefined
      ? {}
      : { [FRONTMATTER_SOURCE_META_KEY]: frontmatterSource }),
  })
  if (frontmatterSource !== undefined) {
    recordFrontmatterSourceItems(doc.getMap(FRONTMATTER_FIELD), doc.getMap(META_FIELD))
  }
  doc.getText(PLAIN_TEXT_FIELD).insert(0, body)

  return doc
}

export function yDocToMarkdown(doc: Y.Doc): string {
  const body = yDocBodyToMarkdown(doc).trimEnd()
  const frontmatter = orderFrontmatter(getDohcYDocFrontmatter(doc))
  const internalMeta = doc.getMap(META_FIELD)
  const usesCrlf = internalMeta.get(MARKDOWN_CRLF_META_KEY) === true
    && internalMeta.get('contentKind') !== PLAIN_TEXT_CONTENT_KIND
  const restoreLineEndings = (markdown: string): string => (
    usesCrlf ? markdown.replaceAll('\n', '\r\n') : markdown
  )

  return `${frontmatterBlockFor(
    frontmatter,
    internalMeta.get(FRONTMATTER_SOURCE_META_KEY),
    body,
    usesCrlf ? '\r\n' : '\n',
    writtenFrontmatterKeys(doc.getMap(FRONTMATTER_FIELD), internalMeta),
  )}${restoreLineEndings(body)}`
}

export function getDohcYDocFrontmatter(doc: Y.Doc): Record<string, unknown> {
  return frontmatterMapValues(doc.getMap(FRONTMATTER_FIELD))
}

export function getDohcYDocMeta(doc: Y.Doc): DohcMeta {
  const meta = frontmatterMapValues(doc.getMap(META_FIELD))
  return {
    schemaVersion:
      typeof meta.schemaVersion === 'number'
        ? meta.schemaVersion
        : DOHC_SCHEMA_VERSION,
    contentKind:
      meta.contentKind === PLAIN_TEXT_CONTENT_KIND
        ? PLAIN_TEXT_CONTENT_KIND
        : undefined,
  }
}

export function getDohcYDocPlainText(doc: Y.Doc): Y.Text | null {
  return getDohcYDocMeta(doc).contentKind === PLAIN_TEXT_CONTENT_KIND
    ? doc.getText(PLAIN_TEXT_FIELD)
    : null
}

export function getDohcProseMirrorSchema() {
  return schema
}

function yDocBodyToMarkdown(doc: Y.Doc): string {
  const plainText = getDohcYDocPlainText(doc)
  if (plainText) return plainText.toString()
  return serializeRichdocBody(escapeHighlightMarkdown(yDocBodyToJSON(doc)))
}

function yDocBodyToJSON(doc: Y.Doc): JSONContent {
  const bodyFragment = getDohcYDocBodyFragment(doc)
  return yXmlFragmentToProseMirrorRootNode(
    bodyFragment,
    schema,
  ).toJSON() as JSONContent
}

export function serializeRichdocBody(root: JSONContent): string {
  const source = JSON.stringify(root)
  const characterSentinels = new Map<string, string>()
  const leadingWhitespaceSentinels = new Map<string, string>()
  const blockEscapeSentinels = new Map<string, string>()
  const codeBlocks = new Map<string, string>()
  const reservedTokens = new Set(
    source.match(/\uE000DOHC(?:[A-Z_]+_\d+|CHARACTER\d+)\uE001/gu) ?? [],
  )
  let tokenIndex = 0
  const reserveToken = (kind: string): string => {
    let token: string
    do {
      token = kind === 'CHARACTER'
        ? `\uE000DOHCCHARACTER${tokenIndex}\uE001`
        : `\uE000DOHC_${kind}_${tokenIndex}\uE001`
      tokenIndex += 1
    } while (reservedTokens.has(token))
    reservedTokens.add(token)
    return token
  }
  const encodeLeadingWhitespace = (value: ' ' | '\t'): string => {
    const existing = leadingWhitespaceSentinels.get(value)
    if (existing) return existing

    const token = reserveToken('LEADING_WHITESPACE')
    leadingWhitespaceSentinels.set(value, token)
    return token
  }
  const encodeBlockEscape = (value: string): string => {
    const existing = blockEscapeSentinels.get(value)
    if (existing) return existing

    const token = reserveToken('BLOCK_ESCAPE')
    blockEscapeSentinels.set(value, token)
    return token
  }
  // An empty link the parser keeps as the file holds it reads back only from
  // the same bytes, so its `&`, `<`, `>`, and NBSP are written as they are,
  // and so is each line it starts, which no block opener or indent escape
  // then reads. A link with a line that would end the paragraph cannot be
  // written as it is, so it is written as references, the way a definition
  // is, which the parser reads back as the same link text. A highlight's own
  // `\=` stays as it is, for the highlight to read. Each of its lines is
  // written whole, so no later escape reads it.
  const asWritten = (text: string, highlighted: boolean): string => {
    if (!opensBlock(text)) {
      return replaceCharacters(
        text,
        characterSentinels,
        () => reserveToken('CHARACTER'),
        /[&<>\u00a0]|(?<=\n)[^\n\r]/g,
      )
    }
    const written = highlighted
      ? text.split('\\=').map(writtenDefinition).join('\\=')
      : writtenDefinition(text)
    return replaceCharacters(
      written,
      characterSentinels,
      () => reserveToken('CHARACTER'),
      /[^\n]+/g,
    )
  }

  function visit(node: JSONContent, insideTableCell = false, parentType = ''): JSONContent {
    if (node.type === 'table' && node.content?.length) {
      return {
        ...node,
        content: node.content.map((row, rowIndex) => ({
          ...row,
          content: row.content?.map(cell => ({
            ...cell,
            type: rowIndex === 0 ? 'tableHeader' : cell.type,
            content: cell.content?.flatMap(prepareTableCellBlock),
          })),
        })),
      }
    }

    if (node.type === 'codeBlock') {
      const token = reserveToken('CODE_BLOCK')
      codeBlocks.set(token, textContent(node.content ?? []))
      return { ...node, content: [{ type: 'text', text: token }] }
    }

    let content = insideTableCell
      ? node.content?.flatMap(prepareTableCellBlock)
      : node.content?.map(child => visit(child, false, node.type))
    if (content?.length) {
      const definition = node.type === 'paragraph' && isDefinitionParagraph(content)
      // A definition reads back as plain text, so an empty link in it is
      // written as other text is. A block definition is one tag span.
      content = escapeRawHtmlPunctuation(
        content,
        encodeBlockEscape,
        insideTableCell,
        definition ? undefined : asWritten,
        definition && !insideTableCell,
      )
      if (node.type === 'paragraph') {
        content = escapeLeadingMarkdownBlockSyntax(
          content,
          encodeLeadingWhitespace,
          encodeBlockEscape,
          definition,
        )
        if ((parentType === 'doc' || parentType === 'listItem' || parentType === 'taskItem')
          && content[0]?.text?.startsWith(' ') && !content[0].marks?.some(mark => mark.type === 'code')) {
          const rest = content[0].text.slice(1)
          content = [{ type: 'text', text: encodeLeadingWhitespace(' ') }, ...(rest ? [{ ...content[0], text: rest }] : []), ...content.slice(1)]
        }
      }
      content = renderInlineCodeRuns(
        content,
        characterSentinels,
        () => reserveToken('CHARACTER'),
      )
      content = protectMarkdownSyntax(
        content,
        characterSentinels,
        () => reserveToken('CHARACTER'),
      )
    }

    return content ? { ...node, content } : { ...node }
  }

  function prepareTableCellBlock(node: JSONContent): JSONContent[] {
    if (node.type !== 'codeBlock') return [visit(node, true)]

    return textContent(node.content ?? []).split('\n').map(line =>
      visit({
        type: 'paragraph',
        content: line.length > 0
          ? [{
              type: 'text',
              text: line,
              marks: [{ type: 'code' }],
            }]
          : [],
      }),
    )
  }

  const prepared = visit(root)
  const restorations = [
    new Map(Array.from(
      characterSentinels,
      ([character, sentinel]) => [sentinel, character] as const,
    )),
    new Map(Array.from(
      blockEscapeSentinels,
      ([character, sentinel]) => [
        sentinel,
        `&#${character.codePointAt(0)};`,
      ] as const,
    )),
    new Map(Array.from(
      leadingWhitespaceSentinels,
      ([whitespace, sentinel]) => [
        sentinel,
        whitespace === ' ' ? '&#32;' : '&#9;',
      ] as const,
    )),
  ]
  const restore = (markdown: string): string =>
    restorations.reduce(restoreCharacterSentinels, markdown)
  // Table cells still hold sentinels while they render, so each is padded
  // to the width it has once they are restored.
  let markdown = measureTableCellsAs(
    text => restore(text).length,
    () => markdownManager.serialize(prepared),
  )
  if (prepared.content?.[0]?.type === 'horizontalRule') {
    markdown = '***' + markdown.slice(3)
  }
  return rewriteCodeBlockFences(restore(markdown), codeBlocks)
}

function escapeLeadingIndentedCode(
  content: JSONContent[],
  encodeLeadingWhitespace: (value: ' ' | '\t') => string,
): JSONContent[] {
  const replacements = new Map<number, Map<number, string>>()
  let leadingColumn: number | null = 0
  let leadingWhitespace: Array<readonly [number, number, ' ' | '\t']> = []

  for (const [nodeIndex, node] of content.entries()) {
    if (node.type === 'hardBreak') {
      leadingColumn = 0
      leadingWhitespace = []
      continue
    }
    if (
      typeof node.text !== 'string'
      || node.marks?.some(mark => mark.type === 'code')
    ) {
      leadingColumn = null
      leadingWhitespace = []
      continue
    }

    for (let offset = 0; offset < node.text.length; offset += 1) {
      const character = node.text[offset]
      if (character === '\n') {
        leadingColumn = 0
        leadingWhitespace = []
        continue
      }
      if (leadingColumn === null) continue
      if (character !== ' ' && character !== '\t') {
        leadingColumn = null
        leadingWhitespace = []
        continue
      }

      leadingWhitespace.push([nodeIndex, offset, character])
      leadingColumn += character === ' '
        ? 1
        : 4 - (leadingColumn % 4)
      if (leadingColumn < 4) continue

      for (const [index, [whitespaceNodeIndex, whitespaceOffset, whitespace]]
        of leadingWhitespace.entries()) {
        const nodeReplacements = replacements.get(whitespaceNodeIndex) ?? new Map()
        nodeReplacements.set(
          whitespaceOffset,
          index === 0 ? encodeLeadingWhitespace(whitespace) : whitespace,
        )
        replacements.set(whitespaceNodeIndex, nodeReplacements)
      }
      leadingColumn = null
      leadingWhitespace = []
    }
  }

  if (replacements.size === 0) return content
  return content.flatMap((node, nodeIndex) => {
    const nodeReplacements = replacements.get(nodeIndex)
    if (!nodeReplacements || typeof node.text !== 'string') return [node]

    const output: JSONContent[] = []
    let chunkStart = 0
    for (const [offset, replacement] of nodeReplacements) {
      if (offset > chunkStart) {
        output.push({ ...node, text: node.text.slice(chunkStart, offset) })
      }
      output.push({ type: 'text', text: replacement })
      chunkStart = offset + 1
    }
    if (chunkStart < node.text.length) {
      output.push({ ...node, text: node.text.slice(chunkStart) })
    }
    return output
  })
}

function escapePostNewlineMarkdownBlockOpeners(
  content: JSONContent[],
  encodeBlockEscape: (value: string) => string,
): JSONContent[] {
  type Replacement = { readonly text: string; readonly preserveMarks: boolean }
  const replacements = new Map<number, Map<number, Replacement>>()
  let capturesLine = false
  let line = ''
  let positions: Array<readonly [number, number]> = []
  let lineBreakPosition: readonly [number, number] | null = null

  const addReplacement = (
    [nodeIndex, offset]: readonly [number, number],
    replacement: Replacement,
  ): void => {
    const nodeReplacements = replacements.get(nodeIndex) ?? new Map()
    nodeReplacements.set(offset, replacement)
    replacements.set(nodeIndex, nodeReplacements)
  }

  const finishLine = (): void => {
    if (capturesLine) {
      const escapeIndexes = leadingMarkdownBlockEscapeIndexes(line)
      // The line break keeps its marks, so a mark across it stays one.
      if (escapeIndexes.length > 0 && lineBreakPosition) {
        addReplacement(lineBreakPosition, { text: '\n', preserveMarks: true })
      }
      for (const escapeIndex of escapeIndexes) {
        const position = positions[escapeIndex]
        if (!position) continue
        addReplacement(position, {
          text: encodeBlockEscape(line[escapeIndex] ?? ''),
          preserveMarks: true,
        })
      }
    }
    line = ''
    positions = []
  }

  for (const [nodeIndex, node] of content.entries()) {
    if (
      typeof node.text !== 'string'
      || node.marks?.some(mark => mark.type === 'code')
    ) {
      finishLine()
      capturesLine = false
      lineBreakPosition = null
      continue
    }
    for (let offset = 0; offset < node.text.length; offset += 1) {
      const character = node.text[offset]
      if (character === '\n') {
        finishLine()
        capturesLine = true
        lineBreakPosition = [nodeIndex, offset]
        continue
      }
      if (!capturesLine) continue
      line += character
      positions.push([nodeIndex, offset])
    }
  }
  finishLine()

  if (replacements.size === 0) return content
  return content.flatMap((node, nodeIndex) => {
    const nodeReplacements = replacements.get(nodeIndex)
    if (!nodeReplacements || typeof node.text !== 'string') return [node]

    const output: JSONContent[] = []
    let chunkStart = 0
    for (const [offset, replacement] of nodeReplacements) {
      if (offset > chunkStart) {
        output.push({ ...node, text: node.text.slice(chunkStart, offset) })
      }
      output.push(replacement.preserveMarks
        ? { ...node, text: replacement.text }
        : { type: 'text', text: replacement.text })
      chunkStart = offset + 1
    }
    if (chunkStart < node.text.length) {
      output.push({ ...node, text: node.text.slice(chunkStart) })
    }
    return output
  })
}

function escapeLeadingMarkdownBlockSyntax(
  content: JSONContent[],
  encodeLeadingWhitespace: (value: ' ' | '\t') => string,
  encodeBlockEscape: (value: string) => string,
  definition: boolean,
): JSONContent[] {
  const output: JSONContent[] = []
  let lineStart = true
  const escapedContent = escapePostNewlineMarkdownBlockOpeners(
    escapeParagraphWhitespace(content, encodeBlockEscape),
    encodeBlockEscape,
  )
  const preparedContent = escapeLeadingIndentedCode(
    escapedContent,
    encodeLeadingWhitespace,
  )

  for (let index = 0; index < preparedContent.length;) {
    const node = preparedContent[index]
    if (typeof node.text === 'string' && !node.marks?.length) {
      const run: JSONContent[] = []
      while (
        index < preparedContent.length
        && typeof preparedContent[index].text === 'string'
        && !preparedContent[index].marks?.length
      ) {
        run.push(preparedContent[index])
        index += 1
      }
      output.push(...escapeTextRunBlockOpeners(
        run,
        lineStart,
        encodeLeadingWhitespace,
        encodeBlockEscape,
        definition && output.length === 0,
      ))
      lineStart = run.at(-1)?.text?.endsWith('\n') === true
      continue
    }

    output.push(node)
    lineStart = node.type === 'hardBreak'
    index += 1
  }
  return output
}

// Whether a paragraph is plain text that marked reads back as the one link
// reference definition it holds, as the parser keeps a definition.
function isDefinitionParagraph(content: JSONContent[]): boolean {
  const [node] = content
  if (content.length !== 1 || typeof node.text !== 'string' || node.marks?.length) return false
  if (!node.text.startsWith('[')) return false
  const raw = literalProbe.def(node.text)?.raw
  return raw !== undefined && definitionText(raw) === node.text
}

function escapeParagraphWhitespace(
  content: JSONContent[],
  encodeBlockEscape: (value: string) => string,
): JSONContent[] {
  return content.map(node => (
    typeof node.text === 'string'
    && /[\r\u00a0]/.test(node.text)
    && !node.marks?.some(mark => mark.type === 'code')
      // Task-list parsing treats a literal NBSP as indentation, not content.
      ? { ...node, text: node.text.replace(/[\r\u00a0]/g, encodeBlockEscape) }
      : node
  ))
}

// With `definition`, the `[` that starts the run is written as `&#91;`, the
// reference later lines already use, which the parser reads back as text,
// not as an escape node. So a definition the parser keeps as text reopens as
// the same text.
function escapeTextRunBlockOpeners(
  run: JSONContent[],
  startsLine: boolean,
  encodeLeadingWhitespace: (value: ' ' | '\t') => string,
  encodeBlockEscape: (value: string) => string,
  definition: boolean,
): JSONContent[] {
  const text = run.map(node => node.text ?? '').join('')
  const escapeOffsets = new Set<number>()
  const whitespaceReplacements = new Map<number, string>()
  let lineStart = startsLine ? 0 : text.indexOf('\n') + 1
  while (lineStart > 0 || startsLine) {
    const lineEnd = text.indexOf('\n', lineStart)
    const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    const leadingWhitespace = indentedCodeLeadingWhitespace(line)
    if (leadingWhitespace) {
      whitespaceReplacements.set(
        lineStart,
        encodeLeadingWhitespace(leadingWhitespace),
      )
    } else {
      for (const escapeIndex of leadingMarkdownBlockEscapeIndexes(line)) {
        escapeOffsets.add(lineStart + escapeIndex)
      }
    }
    if (lineEnd < 0) break
    lineStart = lineEnd + 1
    startsLine = false
  }
  if (escapeOffsets.size === 0 && whitespaceReplacements.size === 0) return run

  const output: JSONContent[] = []
  let offset = 0
  for (const node of run) {
    const nodeText = node.text ?? ''
    let chunkStart = 0
    for (let index = 0; index < nodeText.length; index += 1) {
      const absoluteIndex = offset + index
      const whitespaceReplacement = whitespaceReplacements.get(absoluteIndex)
      if (!escapeOffsets.has(absoluteIndex) && !whitespaceReplacement) continue
      if (index > chunkStart) {
        output.push({ ...node, text: nodeText.slice(chunkStart, index) })
      }
      output.push(whitespaceReplacement
        ? { ...node, text: whitespaceReplacement }
        : definition && absoluteIndex === 0
          ? { ...node, text: encodeBlockEscape('[') }
          : {
              type: 'escapedPunctuation',
              attrs: { value: nodeText[index] },
            })
      chunkStart = index + 1
    }
    if (chunkStart < nodeText.length) {
      output.push({ ...node, text: nodeText.slice(chunkStart) })
    }
    offset += nodeText.length
  }
  return output
}

function indentedCodeLeadingWhitespace(text: string): ' ' | '\t' | null {
  let column = 0
  for (const character of text) {
    if (character === ' ') column += 1
    else if (character === '\t') column += 4 - (column % 4)
    else break
    if (column >= 4) return text[0] === '\t' ? '\t' : ' '
  }
  return null
}

function leadingMarkdownBlockEscapeIndexes(text: string): number[] {
  const indent = /^( {0,3})/.exec(text)?.[1].length ?? 0
  const rest = text.slice(indent)

  if (/^#{1,6}(?:[\t ]|$)/.test(rest)) return [indent]
  if (/^\$\$/.test(rest)) return [indent, indent + 1]
  if (/^[-+*](?:[\t ]|$)/.test(rest)) return [indent]
  if (/^(?:`{3,}|~{3,})/.test(rest)) return [indent]
  const thematicBreak =
    /^(?:-(?:[\t ]*-){2,}|\*(?:[\t ]*\*){2,}|_(?:[\t ]*_){2,})[\t ]*$/
  if (thematicBreak.test(rest)) {
    return [indent]
  }
  if (/^(?:=+|-+)[\t ]*$/.test(rest)) return [indent]
  if (/^!\[/.test(rest)) return [indent + 1]
  // A link with no text starts no definition, and the parser reads it as text.
  if (/^\[(?!\]\()/.test(rest)) return [indent]
  const ordered = /^(\d{1,9})([.)])(?:[\t ]|$)/.exec(rest)
  if (ordered) return [indent + ordered[1].length]
  return []
}

// The tag span of a block's inline content: from its first tag to its last
// `>`, across marks, with each node's share of the text. Code is not part of
// it. The serializer writes references inside it and the parser reads them,
// where only the serializer's `&lt;` and `&gt;` open and close one. So a tag
// the serializer writes as a real one, a table cell's `<br>`, is not a bound.
// Nor is a `<` or `>` in an empty link the serializer writes as it is.
function rawHtmlSpan(
  content: JSONContent[],
  realTag?: string,
  emptyLinks?: Array<Array<[number, number]>>,
): { texts: string[]; start: number; end: number } | undefined {
  const texts = content.map(node => (
    typeof node.text === 'string' && !node.marks?.some(mark => mark.type === 'code')
      ? node.text
      : ''
  ))
  const joined = emptyLinks
    ? texts.map((text, index) => mapRanges(text, emptyLinks[index], 0, part => part.replace(/[<>]/g, '\0'))).join('')
    : texts.join('')
  const bounds = realTag ? joined.replaceAll(realTag, '\0'.repeat(realTag.length)) : joined
  const start = bounds.search(/<[!/?A-Za-z]/)
  const end = bounds.lastIndexOf('>') + 1
  return start < 0 || end <= start ? undefined : { texts, start, end }
}

// Tiptap writes a text's `<`, `>`, and `&` as `&lt;`, `&gt;`, and `&amp;`, so
// raw HTML kept as text no longer reads as HTML when the file reopens, and the
// syntax it kept literal, from emphasis to atoms, links, and escapes, would
// read again. In the tag span, every other ASCII punctuation character but the
// `!`, `/`, and `?` that open a tag is written as a reference the parser reads
// back as that character, and so is a space that ends a line, which would make
// a line break. An empty line would end the paragraph, so its newline is one
// too. A line of spaces or tabs already starts or ends with one. A highlight's
// own `\=` stays as written.
//
// The parser keeps a link with no text as the text the file holds, so outside
// the span the serializer writes one as it is, through `asWritten`. Inside the
// span its `[` is a reference, so it reads back as the span's other text does.
//
// With `whole`, all of the text is the span, as for a definition the parser
// keeps as text.
function escapeRawHtmlPunctuation(
  content: JSONContent[],
  encodeBlockEscape: (value: string) => string,
  insideTableCell: boolean,
  asWritten: ((text: string, highlighted: boolean) => string) | undefined,
  whole = false,
): JSONContent[] {
  const linkRanges = (node: JSONContent): Array<[number, number]> => (
    asWritten && typeof node.text === 'string' && !node.marks?.some(mark => mark.type === 'code')
      ? emptyLinkRanges(node.text)
      : []
  )
  const write = (node: JSONContent) => (part: string): string => (
    asWritten
      ? asWritten(part, node.marks?.some(mark => mark.type === 'highlight') === true)
      : part
  )
  // A link written as references holds no `[` once written, so it is no
  // link here either, and its references bound no span.
  let emptyLinks = content.map(linkRanges)
  if (emptyLinks.some((ranges, index) => ranges.some(
    ([from, to]) => opensBlock((content[index].text ?? '').slice(from, to)),
  ))) {
    content = content.map((node, index) => {
      const text = node.text ?? ''
      const ranges = emptyLinks[index].filter(([from, to]) => opensBlock(text.slice(from, to)))
      return ranges.length ? { ...node, text: mapRanges(text, ranges, 0, write(node)) } : node
    })
    emptyLinks = content.map(linkRanges)
  }
  const writeEmptyLinks = (node: JSONContent, index: number): JSONContent => (
    emptyLinks[index].length
      ? { ...node, text: mapRanges(node.text ?? '', emptyLinks[index], 0, write(node)) }
      : node
  )
  const tag = whole
    ? { texts: content.map(node => node.text ?? ''), start: 0, end: Infinity }
    : rawHtmlSpan(
        content,
        insideTableCell ? GFM_TABLE_CELL_BLOCK_SEPARATOR : undefined,
        emptyLinks,
      )
  if (!tag) return content.map(writeEmptyLinks)
  const { texts, start, end } = tag
  const joined = texts.join('')
  let offset = 0
  return content.map((node, index) => {
    const text = texts[index]
    const from = Math.max(start - offset, 0)
    const to = Math.min(end - offset, text.length)
    const at = offset + from
    offset += text.length
    if (from >= to) return writeEmptyLinks(node, index)
    const punctuation = node.marks?.some(mark => mark.type === 'highlight')
      ? /\\=|["-%'-.:;=@[-`{-~]| |\n/g
      : /["-%'-.:;=@[-`{-~]| |\n/g
    const html = text.slice(from, to).replace(punctuation, (character, position: number) => {
      if (character.length > 1) return character
      // The space's newline, or the newline's line, can sit in the next or
      // previous node.
      if (character === ' ' && (at + position + 1 >= end || joined[at + position + 1] !== '\n')) {
        return character
      }
      if (character === '\n' && joined[at + position - 1] !== '\n') return character
      return encodeBlockEscape(character)
    })
    const ranges = emptyLinks[index]
    return {
      ...node,
      text: mapRanges(text.slice(0, from), ranges, 0, write(node)) + html
        + mapRanges(text.slice(to), ranges, to, write(node)),
    }
  })
}

// Whether a link with no text holds a line that would end the paragraph it
// is in, written as it is: after at most three spaces, a character that can
// open a block or a table's delimiter row, `1.` or `1)`, or nothing but
// spaces. A `\r` counts too: marked reads it as a newline, and the `&#13;`
// that keeps it one would stay a reference in a link written as it is. It
// errs toward yes, since such a link is written as references, which read
// back the same. The engine's projector decides the same way.
export function opensBlock(link: string): boolean {
  return OPENS_BLOCK_RE.test(link)
}
const OPENS_BLOCK_RE = /\r|\n(?: {0,3}(?:[#$>*+\-_=`~<|:]|1[.)])| *(?:\n|$))/
const OPENS_LINE_RE = new RegExp(OPENS_BLOCK_RE.source, 'y')

// Where `text` holds a link with no text, as the parser reads one: marked's
// inline `link` rule and `Tokenizer.link` checks, from `[](`. The parser asks
// marked at each `[](`, which reads the rest of the text each time. This
// reads the same rule once across the text, so a run of candidates that fail
// costs no more than the text it spans. The importer's tests compare the two
// readings.
export function emptyLinkRanges(text: string): Array<[number, number]> {
  let at = text.indexOf('[](')
  if (at < 0) return []
  const read = emptyLinkReader(text)
  const ranges: Array<[number, number]> = []
  while (at >= 0) {
    const end = read(at)
    if (end < 0) {
      at = text.indexOf('[](', at + 1)
    } else {
      ranges.push([at, end])
      at = text.indexOf('[](', end)
    }
  }
  return ranges
}

const TITLE_CLOSE: Record<string, string> = { '"': '"', "'": "'", '(': ')' }

// A run of bare destination text, which every candidate whose destination
// starts in it shares: where it stops, its last two `)`, and what the rule
// reads after it, each found once.
type BareRun = {
  start: number
  stop: number
  close: number
  previousClose: number
  tail?: number
  shapes: Map<number, [number, number]>
  walk?: ParenthesisWalk
}

// marked's `findClosingBracket` for each candidate whose destination starts
// in a run: its first unmatched `)` and its depth, in candidate order, and the
// depth at the run's stop and at its last `)`.
type ParenthesisWalk = {
  solids: number[]
  lowers: number[]
  depths: number[]
  stopDepth: number
  closeDepth: number
  next: number
}

// A title's scan from a start: the first delimiter no backslash escapes, the
// close after it, and the last escaped delimiter whose close succeeds.
type TitleScan = { start: number; end: number; close: number; escaped: number; escapedClose: number }

// The end of the link with no text at each `[](` in `text`, or -1, read in
// order. marked's rule, after `[](`, is `\s*`, a destination
// `<(?:\\.|[^\n<>\\])+>` or `[^ \t\n\x00-\x1f]*`, an optional title after
// `[ \t]+(?:\n[ \t]*)?|\n[ \t]*`, then `\s*\)`. Its regex tries the longest
// choices first, so each step names the first choice that succeeds.
//
// The reader keeps no table of the text. Each candidate scans its own
// leading whitespace, and an angle destination stops at the next `<`. Work
// that candidates share sits in memos that only move forward: the bare run,
// and each delimiter's title scan for each of three streams of title starts
// that only grow. A run whose destinations hold `)` is walked once. So the
// work is linear in the text, and the storage is linear in the candidates
// of one run. Every character it reads goes through `charAt` or
// `charCodeAt`, which the tests count.
function emptyLinkReader(text: string): (link: number) => number {
  const n = text.length
  const char = (index: number) => text.charAt(index)
  const space = (index: number) => index < n && /\s/.test(char(index))
  const stops = (index: number) => {
    const code = text.charCodeAt(index)
    return code === 32 || code <= 31
  }
  const tabEnd = (index: number) => {
    let at = index
    while (char(at) === ' ' || char(at) === '\t') at += 1
    return at
  }
  // `\s*\)` from an index: the end of the `)`, or -1.
  const closeAt = (index: number) => {
    let at = index
    while (space(at)) at += 1
    return char(at) === ')' ? at + 1 : -1
  }
  const trimEnd = (index: number) => {
    let at = index
    while (at > 0 && space(at - 1)) at -= 1
    return at
  }

  const titles = new Map<number, TitleScan>()
  const title = (at: number, stream: number): number => {
    const opener = char(at)
    const delimiter = TITLE_CLOSE[opener]
    if (!delimiter) return -1
    const key = stream * 3 + '"\'('.indexOf(opener)
    const from = at + 1
    let scan = titles.get(key)
    if (!scan || from < scan.start || from > scan.end) {
      scan = { start: from, end: n, close: -1, escaped: -1, escapedClose: -1 }
      for (let index = from; index < n;) {
        const character = char(index)
        if (character === '\\' && char(index + 1) === delimiter) {
          const close = closeAt(index + 2)
          if (close >= 0) {
            scan.escaped = index + 1
            scan.escapedClose = close
          }
          index += 2
        } else if (character === delimiter) {
          scan.end = index
          scan.close = closeAt(index + 1)
          break
        } else {
          index += 1
        }
      }
      titles.set(key, scan)
    }
    if (scan.close >= 0) return scan.close
    return scan.escaped > from ? scan.escapedClose : -1
  }
  // After a destination: the end of the title and `)`, or of `)` alone.
  const tail = (end: number, stream: number): number => {
    const spaced = tabEnd(end)
    const at = char(spaced) === '\n' ? tabEnd(spaced + 1) : spaced > end ? spaced : -1
    const titled = at >= 0 ? title(at, stream) : -1
    return titled >= 0 ? titled : closeAt(end)
  }
  // Where an angle destination's characters stop.
  const angled = (index: number) => {
    let at = index
    while (at < n) {
      const character = char(at)
      if (character === '\\') {
        if (at + 1 >= n || /[\n\r\u2028\u2029]/.test(char(at + 1))) return at
        at += 2
      } else if (character === '\n' || character === '<' || character === '>') {
        return at
      } else {
        at += 1
      }
    }
    return at
  }

  let run: BareRun | undefined
  const bareRun = (solid: number): BareRun => {
    if (run && run.start <= solid && solid <= run.stop) return run
    let stop = solid
    let close = -1
    let previousClose = -1
    for (; stop < n && !stops(stop); stop += 1) {
      if (char(stop) === ')') {
        previousClose = close
        close = stop
      }
    }
    run = { start: solid, stop, close, previousClose, shapes: new Map() }
    return run
  }
  const walk = (bare: BareRun): ParenthesisWalk => {
    const solids = [bare.start]
    const lowers = [n]
    const depths = [0]
    const open = [0]
    let depth = 0
    let closeDepth = 0
    for (let index = bare.start; index < bare.stop;) {
      const character = char(index)
      const step = character === '\\' ? 2 : 1
      if (index <= bare.close && bare.close < index + step) closeDepth = depth
      if (character === '(') {
        depth += 1
        if (char(index - 1) === ']' && char(index - 2) === '[') {
          let solid = index + 1
          while (space(solid)) solid += 1
          if (solid < bare.stop) {
            solids.push(solid)
            lowers.push(n)
            depths.push(depth)
            open.push(solids.length - 1)
          }
        }
      } else if (character === ')') {
        depth -= 1
        while (open.length > 0 && depths[open[open.length - 1]] > depth) {
          lowers[open.pop() as number] = index
        }
      }
      index += step
    }
    return { solids, lowers, depths, stopDepth: depth, closeDepth, next: 0 }
  }

  // marked's checks on the destination from `from` to `to`: in angles it ends
  // with an unescaped `>`, and with unbalanced parentheses the link ends at
  // the first unmatched `)`, cut `4 + index` from the link's start even after
  // leading whitespace, then trimmed.
  const checked = (link: number, solid: number, from: number, to: number, end: number): number => {
    if (to <= solid) return end
    let shape = run?.shapes.get(to)
    if (!shape) {
      const stop = trimEnd(to)
      let slashes = 0
      while (char(stop - 2 - slashes) === '\\') slashes += 1
      shape = [stop, slashes]
      if (run && (to === run.stop || to === run.close)) run.shapes.set(to, shape)
    }
    const [stop, slashes] = shape
    if (char(solid) === '<') {
      return char(stop - 1) === '>' && Math.min(slashes, stop - 1 - solid) % 2 === 0 ? end : -1
    }
    // A bare destination ends at its run's stop or last `)`.
    const bare = run as BareRun
    const close = to === bare.stop ? bare.close : bare.previousClose
    if (close < from) return end
    const walked = bare.walk ??= walk(bare)
    while (walked.solids[walked.next] < solid) walked.next += 1
    const at = walked.next
    if (walked.lowers[at] < to) return trimEnd(link + 4 + walked.lowers[at] - from)
    const depth = to === bare.stop ? walked.stopDepth : walked.closeDepth
    return depth > walked.depths[at] ? -1 : end
  }

  return (link) => {
    const after = link + 3
    let solid = after
    while (space(solid)) solid += 1
    // Carried back from the position after each whitespace one: where its
    // bare destination stops and what follows, where spaces and tabs end,
    // and where they end after the nearest newline.
    let stop = -1
    let tailed = -1
    let tabs = solid
    let newline = -1
    for (let from = solid; from >= after; from -= 1) {
      if (from === solid) {
        if (char(from) === '<') {
          const close = angled(from + 1)
          if (close > from + 1 && char(close) === '>') {
            const end = tail(close + 1, 2)
            if (end >= 0) return checked(link, solid, from, close + 1, end)
          }
        }
        const bare = bareRun(solid)
        stop = bare.stop
        tailed = bare.tail ??= tail(stop, 0)
      } else {
        const following = tabs
        const character = char(from)
        if (character !== ' ' && character !== '\t') tabs = from
        if (character === '\n') newline = following
        if (stops(from)) {
          stop = from
          const at = char(tabs) === '\n' ? newline : tabs > from ? tabs : -1
          const titled = at >= 0 ? title(at, 1) : -1
          tailed = titled >= 0 ? titled : char(solid) === ')' ? solid + 1 : -1
        }
      }
      if (tailed >= 0) return checked(link, solid, from, stop, tailed)
      // A shorter bare destination can end where `\s*\)` succeeds. Whitespace
      // that reaches a `)` would already have closed the link at the stop, so
      // that is the run's last `)`.
      const close = stop >= solid ? (run as BareRun).close : -1
      if (close >= from) return checked(link, solid, from, close, close + 1)
    }
    return -1
  }
}

// `text`, which starts at `base` in its node, with each part a sorted range
// covers passed through `map`.
function mapRanges(
  text: string,
  ranges: Array<[number, number]>,
  base: number,
  map: (part: string) => string,
): string {
  let output = ''
  let cursor = 0
  for (const [rangeFrom, rangeTo] of ranges) {
    const from = Math.max(rangeFrom - base, cursor)
    const to = Math.min(rangeTo - base, text.length)
    if (from >= to) continue
    output += text.slice(cursor, from) + map(text.slice(from, to))
    cursor = to
  }
  return output + text.slice(cursor)
}

function protectMarkdownSyntax(
  content: JSONContent[],
  sentinels: Map<string, string>,
  reserveSentinel: () => string,
): JSONContent[] {
  return content.map((node) => {
    if (typeof node.text !== 'string') return node
    return {
      ...node,
      text: replaceCharacters(
        node.text,
        sentinels,
        reserveSentinel,
        /[\\`*_[\]~]/g,
      ),
    }
  })
}

function textContent(content: JSONContent[]): string {
  return content.map(node =>
    typeof node.text === 'string' ? node.text : textContent(node.content ?? []),
  ).join('')
}

function renderInlineCodeRuns(
  content: JSONContent[],
  entitySentinels: Map<string, string>,
  reserveSentinel: () => string,
): JSONContent[] {
  const output: JSONContent[] = []
  for (let index = 0; index < content.length;) {
    const node = content[index]
    if (!isInlineCodeText(node)) {
      output.push(node)
      index += 1
      continue
    }

    let end = index + 1
    let value = node.text ?? ''
    while (end < content.length && sameInlineCodeMark(node, content[end])) {
      value += content[end].text ?? ''
      end += 1
    }
    const marks = node.marks?.filter(mark => mark.type !== 'code')
    output.push({
      ...node,
      text: renderInlineCode(
        replaceCharacters(value, entitySentinels, reserveSentinel),
      ),
      marks: marks?.length ? marks : undefined,
    })
    index = end
  }
  return output
}

function replaceCharacters(
  value: string,
  replacements: Map<string, string>,
  reserveSentinel: () => string,
  pattern = /[&<>]/g,
): string {
  return value.replace(pattern, character => {
    const existing = replacements.get(character)
    if (existing) return existing

    const sentinel = reserveSentinel()
    replacements.set(character, sentinel)
    return sentinel
  })
}

function isInlineCodeText(node: JSONContent): boolean {
  return node.type === 'text'
    && typeof node.text === 'string'
    && (node.marks ?? []).some(mark => mark.type === 'code')
}

function sameInlineCodeMark(left: JSONContent, right: JSONContent): boolean {
  if (!isInlineCodeText(right)) return false
  const leftCode = left.marks?.find(mark => mark.type === 'code')
  const rightCode = right.marks?.find(mark => mark.type === 'code')
  return JSON.stringify(leftCode?.attrs ?? {}) === JSON.stringify(rightCode?.attrs ?? {})
}

function renderInlineCode(value: string): string {
  const fence = backtickFence(value, 1)
  const hasEdgeBacktick = value.startsWith('`') || value.endsWith('`')
  const hasEdgeSpace = value.startsWith(' ') || value.endsWith(' ')
  const padding = hasEdgeBacktick || (hasEdgeSpace && !/^ *$/.test(value))
    ? ' '
    : ''
  return `${fence}${padding}${value}${padding}${fence}`
}

function rewriteCodeBlockFences(
  markdown: string,
  codeBlocks: Map<string, string>,
): string {
  const lines = markdown.split('\n')
  const output: string[] = []
  let restoredBlocks = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const tokenMatch = /(\uE000DOHC_CODE_BLOCK_\d+\uE001)$/.exec(line)
    const token = tokenMatch?.[1]
    const content = token ? codeBlocks.get(token) : undefined
    if (content === undefined) {
      output.push(line)
      continue
    }

    const opening = output.pop()
    const closing = lines[index + 1]
    const openingFence = opening && /(`{3})(.*)$/.exec(opening)
    const closingFence = closing && /(`{3,})([ \t]*)$/.exec(closing)
    if (!opening || !openingFence || !closing || !closingFence || !tokenMatch) {
      throw new Error('could not restore a fenced code block serialization sentinel')
    }

    const openingPrefix = opening.slice(0, openingFence.index)
    const serializedContentPrefix = line.slice(0, tokenMatch.index)
    const serializedClosingPrefix = closing.slice(0, closingFence.index)
    const listContinuationPrefix = continuationPrefixForListMarker(openingPrefix)
    const contentPrefix = listContinuationPrefix ?? serializedContentPrefix
    const closingPrefix = listContinuationPrefix ?? serializedClosingPrefix
    const language = openingFence[2]
    const fence = codeBlockFence(content, language)
    const info = language.startsWith(fence[0]) ? ` ${language}` : language
    const blankPrefix = /^\s*$/.test(contentPrefix) ? contentPrefix : contentPrefix.trimEnd()
    const contentLines = content.split('\n').map(line =>
      line.length === 0 ? blankPrefix : `${contentPrefix}${line}`,
    )
    output.push(
      `${openingPrefix}${fence}${info}`,
      ...contentLines,
      `${closingPrefix}${fence}${closingFence[2]}`,
    )
    restoredBlocks += 1
    index += 1
  }

  if (restoredBlocks !== codeBlocks.size) {
    throw new Error('could not find every fenced code block serialization sentinel')
  }

  return output.join('\n')
}

function continuationPrefixForListMarker(prefix: string): string | null {
  const taskItem = /^(.*?)([-+*]) \[[ xX]\] $/.exec(prefix)
  if (taskItem) return `${taskItem[1]}  `

  const listItem = /^(.*?)([-+*]|\d+[.)]) $/.exec(prefix)
  if (!listItem) return null
  return `${listItem[1]}${' '.repeat(listItem[2].length + 1)}`
}

function restoreCharacterSentinels(
  markdown: string,
  replacements: Map<string, string>,
): string {
  if (replacements.size === 0) return markdown
  // Every sentinel the serializer reserves has this shape, so one pass finds
  // them all, however many there are.
  return markdown.replace(
    /\uE000DOHC(?:[A-Z_]+_\d+|CHARACTER\d+)\uE001/gu,
    sentinel => replacements.get(sentinel) ?? sentinel,
  )
}

/** Whether a Markdown file's reader takes the start of `markdown` as frontmatter, even an empty one. */
export function startsWithFrontmatter(markdown: string): boolean {
  return parseFrontmatter(markdown, false).body !== markdown
}
