import type {
  AnyExtension,
  JSONContent,
  MarkdownRendererHelpers,
} from '@tiptap/core'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { getDefaults, Lexer, Marked, Tokenizer, type marked, type Tokens } from 'marked'
import { StarterKit } from '@tiptap/starter-kit'
import {
  escapeTableCellPipes,
  renderTableToMarkdown,
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from '@tiptap/extension-table'
import { OrderedList, ORDERED_LIST_MARKER_PATTERN, TaskList } from '@tiptap/extension-list'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  DohcTaskItem,
  dohcMarkdownExtensions,
  escapeHighlightMarkdown,
} from './dohc-markdown-extensions.js'
import { sanitizeImageSrc } from './image-src.js'
import { backtickFence, codeBlockFence } from './markdown-fence.js'
import { getDohcYDocBodyFragment } from './body-fragment.js'
import {
  FRONTMATTER_SOURCE_META_KEY,
  frontmatterBlockFor,
  recordFrontmatterSourceItems,
  writtenFrontmatterKeys,
  isFrontmatterMap,
  normalizeFrontmatterValue,
  orderFrontmatter,
  parseFrontmatter,
} from './frontmatter.js'

const PLAIN_TEXT_FIELD = 'plainText'
const FRONTMATTER_FIELD = 'frontmatter'
const META_FIELD = 'meta'
const DOHC_SCHEMA_VERSION = 1
const MARKDOWN_CRLF_META_KEY = 'dohcMarkdownCrlf'
const PLAIN_TEXT_CONTENT_KIND = 'plain-text'
// GFM forbids block nodes inside table cells but permits inline raw HTML, so a
// multi-block ProseMirror cell uses a visible hard break instead of U+001F.
const GFM_TABLE_CELL_BLOCK_SEPARATOR = '<br>'
const PARSE_SENTINEL_RE = /\uE000DOHC_PARSE_\d+\uE001/gu
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

function firstLine(source: string): string {
  const newline = source.indexOf('\n')
  return newline < 0 ? source : source.slice(0, newline)
}

const orderedListTokenizer = OrderedList.config.markdownTokenizer!
const taskListTokenizer = TaskList.config.markdownTokenizer!
const tableTokenizer = Table.config.markdownTokenizer!
const orderedListStart = new RegExp(`^(\\s*)(${ORDERED_LIST_MARKER_PATTERN})([.)])\\s+(.*)$`)

// Tiptap 3.29.2 splits the remaining document before rejecting unrelated
// blocks. Check only the first line, then leave eligible blocks to Tiptap.
const MarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...orderedListTokenizer,
    tokenize: (src, tokens, helpers) => {
      if (!orderedListStart.test(firstLine(src))) return undefined
      return orderedListTokenizer.tokenize(src, tokens, helpers)
    },
  },
})
const MarkdownTaskList = TaskList.extend({
  markdownTokenizer: {
    ...taskListTokenizer,
    tokenize: (src, tokens, helpers) => {
      // parseIndentedBlocks also accepts leading blank lines.
      const firstContent = src.search(/\S/)
      if (firstContent < 0) return undefined
      const line = firstLine(src.slice(firstContent))
      if (!/^([-+*])\s+\[([ xX])\]\s+(.*)$/.test(line)) return undefined
      return taskListTokenizer.tokenize(src, tokens, helpers)
    },
  },
})

// A resized row keeps its height in an HTML comment on the line above its
// table: `<!-- dohc:table row-heights=1:84,2:120 -->`. Row indexes count from
// the header row. GFM has no row-height syntax, Markdown renderers hide the
// comment, and the Rust projector writes the same bytes, so a local close
// that prunes the Y.Doc and reseeds from the file keeps the height.
const TABLE_ROW_HEIGHTS_RE =
  /^<!-- dohc:table row-heights=(\d+:\d+(?:,\d+:\d+)*) -->[ \t]*(?:\n+|$)/u
const tableParseMarkdown = Table.config.parseMarkdown!
type TableRowHeightsToken = Parameters<typeof tableParseMarkdown>[0] & {
  rowHeights?: [number, number][]
}

// The Rust projector reads the attribute through `attr_i64`, which accepts
// an integer or a trimmed integer string. Keep the same rule here so both
// projectors write the same annotation for the same Y.Doc.
function tableRowHeight(value: unknown): number | null {
  const height = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\s*[+-]?\d+\s*$/u.test(value)
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(height) && height > 0 ? height : null
}

function tableRowHeightsAnnotation(rows: JSONContent[]): string {
  const pairs: string[] = []
  rows.forEach((row, index) => {
    const height = tableRowHeight(row.attrs?.height)
    if (height !== null) pairs.push(`${index}:${height}`)
  })
  return pairs.length ? `<!-- dohc:table row-heights=${pairs.join(',')} -->` : ''
}

// Table.start only inspects the first two lines. Avoid splitting the full
// remaining document while probing ordinary blocks.
function tableStart(src: string): number {
  const newline = src.indexOf('\n')
  if (newline < 0) return -1
  const second = src.indexOf('\n', newline + 1)
  const prefix = second < 0 ? src : src.slice(0, second)
  return (tableTokenizer.start as (source: string) => number)(prefix)
}

// Finds the table under an annotation with marked's table rule and nothing
// else. Lexing the rest of the document would re-enter this tokenizer for
// every later annotation, and even a plain lexer would parse every block
// after the table, so a run of annotations would cost quadratic time. GFM
// rows are one line each, which Tiptap's raw reconstruction gets wrong when
// a cell holds a pipe inside inline code.
function tableUnderAnnotation(rest: string): Tokens.Table | undefined {
  const tokenizer = new Tokenizer()
  // The lexer gives the tokenizer its GFM rules and the inline queue the
  // table rule fills.
  tokenizer.lexer = new Lexer({ ...getDefaults(), tokenizer })
  const table = tokenizer.table(rest)
  if (table) return table
  // A header cell with a pipe inside inline code needs Tiptap's escaping
  // before marked can count its cells. Only that first line can change.
  const newline = rest.indexOf('\n')
  const header = newline < 0 ? rest : rest.slice(0, newline)
  if (!header.includes('`') || !header.includes('|')) return undefined
  const escaped = escapeTableCellPipes(header)
  if (escaped === header) return undefined
  return tokenizer.table(escaped + rest.slice(header.length))
}

export const DohcMarkdownTable = Table.extend({
  markdownTokenizer: {
    ...tableTokenizer,
    start: (src: string) => (TABLE_ROW_HEIGHTS_RE.test(src) ? 0 : tableStart(src)),
    tokenize: (src, tokens, helpers) => {
      const annotation = TABLE_ROW_HEIGHTS_RE.exec(src)
      if (!annotation) return tableTokenizer.tokenize(src, tokens, helpers)
      // The annotation belongs to the table that starts right after it. With
      // no table there it stays an ordinary HTML comment for marked.
      const rest = src.slice(annotation[0].length)
      const extent = tableUnderAnnotation(rest)
      if (!extent) return undefined
      // The header, the delimiter, and each row take one line.
      let end = rest.length
      for (let line = 2 + extent.rows.length, cursor = 0; line > 0; line -= 1) {
        const newline = rest.indexOf('\n', cursor)
        if (newline < 0) break
        if (line === 1) end = newline
        cursor = newline + 1
      }
      const text = rest.slice(0, end)
      const table = helpers.blockTokens(text)[0]
      if (table?.type !== 'table') return undefined
      // The newline after the last row belongs to the table, as in marked.
      const raw = annotation[0] + text + (end < rest.length ? '\n' : '')
      const rowHeights: [number, number][] = []
      for (const pair of annotation[1].split(',')) {
        const [index, height] = pair.split(':').map(Number)
        if (Number.isSafeInteger(index) && tableRowHeight(height) !== null) {
          rowHeights.push([index, height])
        }
      }
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
    // Tiptap's table renderer includes its own trailing newline, while the
    // document renderer also joins sibling blocks with `\n\n`. Returning both
    // would put two blank lines between a table and its next sibling.
    const table = renderTableToMarkdown(
      node,
      tableHelpers,
      { cellLineSeparator: GFM_TABLE_CELL_BLOCK_SEPARATOR },
    ).replace(/\n$/u, '')
    return table ? tableRowHeightsAnnotation(node.content ?? []) + table : table
  },
})

const extensions: AnyExtension[] = [
  ...dohcMarkdownExtensions,
  StarterKit.configure({ orderedList: false }),
  MarkdownOrderedList,
  MarkdownTaskList,
  DohcTaskItem,
  DohcMarkdownTable,
  TableCell,
  TableHeader,
  TableRow,
]
const markdownManager = new MarkdownManager({
  marked: new Marked() as unknown as typeof marked,
  extensions,
  indentation: { style: 'space', size: 2 },
})
const schema = getSchema(extensions)

type DohcMeta = { schemaVersion: number; contentKind?: 'plain-text' }

export function markdownToYDoc(markdown: string): Y.Doc {
  const usesCrlf = markdown.includes('\r\n')
  const { meta, body, frontmatterSource } = parseFrontmatter(markdown, usesCrlf)
  const doc = new Y.Doc()

  writeMap(doc.getMap(FRONTMATTER_FIELD), meta)
  writeMap(doc.getMap(META_FIELD), {
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
    usesCrlf ? body.replaceAll('\r\n', '\n') : body,
  )
  prosemirrorJSONToYXmlFragment(schema, tiptapJson, bodyFragment)

  return doc
}

function parseRichdocMarkdown(markdown: string): JSONContent {
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

  const prepared = markdown
    .replace(
      /(?:(?:&amp;|&AMP;|&#0{0,5}38;|&#[xX]0{0,4}26;)#(?:13|35|36|41|42|43|45|46|61|91|95|96|126|160);|&#(?:13|35|36|41|42|43|45|46|61|91|95|96|126|160);)/gu,
      (entity, offset: number, source: string) => (
        markdownCharacterIsEscaped(source, offset)
          ? entity
          : sentinelFor(entity)
      ),
    )
    .replace(
      /^&#(?:32|9);/gmu,
      entity => sentinelFor(entity),
    )
  const parsed = markdownManager.parse(prepared)
  const encodedEntities = entitySentinels
  const decodedEntities = new Map(
    Array.from(
      encodedEntities,
      ([sentinel, entity]) => [sentinel, decodeBlockEntity(entity)] as const,
    ),
  )
  return ensureListItemParagraphs(
    restoreBlockEntityParseSentinels(parsed, decodedEntities, encodedEntities),
  )
}

// A list item's schema starts with a paragraph. Tiptap hands an item whose
// first block is a table straight through, and the Y.Doc conversion then
// drops the item. An annotated table is the first block of an item whose
// paragraph was empty, so give such an item its paragraph back.
function ensureListItemParagraphs(node: JSONContent): JSONContent {
  const content = node.content?.map(ensureListItemParagraphs)
  if (!content) return node
  const needsParagraph = (node.type === 'listItem' || node.type === 'taskItem')
    && content[0]?.type !== 'paragraph'
  return { ...node, content: needsParagraph ? [{ type: 'paragraph' }, ...content] : content }
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

function restoreBlockEntityParseSentinels(
  node: JSONContent,
  decodedEntities: Map<string, string>,
  encodedEntities: Map<string, string>,
  insideCodeBlock = false,
): JSONContent {
  const restored: JSONContent = { ...node }
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
    restored.text = restoreParseSentinels(
      node.text,
      insideCode || autolink ? encodedEntities : decodedEntities,
    )
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
    restored.content = node.content.map(child =>
      restoreBlockEntityParseSentinels(
        child,
        decodedEntities,
        encodedEntities,
        insideCode,
      ),
    )
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
  replacements: Map<string, string>,
): string {
  return value.replace(
    PARSE_SENTINEL_RE,
    sentinel => replacements.get(sentinel) ?? sentinel,
  )
}

export function plainTextToYDoc(markdown: string): Y.Doc {
  const { meta, body, frontmatterSource } = parseFrontmatter(markdown, false)
  const doc = new Y.Doc()

  writeMap(doc.getMap(FRONTMATTER_FIELD), meta)
  writeMap(doc.getMap(META_FIELD), {
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
  return mapToObject(doc.getMap(FRONTMATTER_FIELD))
}

export function getDohcYDocMeta(doc: Y.Doc): DohcMeta {
  const meta = mapToObject(doc.getMap(META_FIELD))
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

  function visit(node: JSONContent, insideTableCell = false): JSONContent {
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
      : node.content?.map(child => visit(child))
    if (content?.length) {
      if (node.type === 'paragraph') {
        content = escapeLeadingMarkdownBlockSyntax(
          content,
          encodeLeadingWhitespace,
          encodeBlockEscape,
        )
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
  let markdown = markdownManager.serialize(prepared)
  markdown = restoreCharacterSentinels(
    markdown,
    new Map(Array.from(
      characterSentinels,
      ([character, sentinel]) => [sentinel, character] as const,
    )),
  )
  markdown = restoreCharacterSentinels(
    markdown,
    new Map(Array.from(
      blockEscapeSentinels,
      ([character, sentinel]) => [
        sentinel,
        `&#${character.codePointAt(0)};`,
      ] as const,
    )),
  )
  markdown = restoreCharacterSentinels(
    markdown,
    new Map(Array.from(
      leadingWhitespaceSentinels,
      ([whitespace, sentinel]) => [
        sentinel,
        whitespace === ' ' ? '&#32;' : '&#9;',
      ] as const,
    )),
  )
  return rewriteCodeBlockFences(markdown, codeBlocks)
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
      if (escapeIndexes.length > 0 && lineBreakPosition) {
        addReplacement(lineBreakPosition, { text: '\n', preserveMarks: false })
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

function escapeTextRunBlockOpeners(
  run: JSONContent[],
  startsLine: boolean,
  encodeLeadingWhitespace: (value: ' ' | '\t') => string,
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
  if (/^\[/.test(rest)) return [indent]
  const ordered = /^(\d{1,9})([.)])(?:[\t ]|$)/.exec(rest)
  if (ordered) return [indent + ordered[1].length]
  return []
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
  const matcher = new RegExp(
    Array.from(replacements.keys(), escapeRegExp).join('|'),
    'gu',
  )
  return markdown.replace(matcher, sentinel => replacements.get(sentinel) ?? sentinel)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeMap(
  map: Y.Map<unknown>,
  values: Record<string, unknown>,
  escapeSharedBigIntKeys = false,
): void {
  for (const [key, value] of Object.entries(values)) {
    map.set(
      escapeSharedBigIntKeys ? escapeSharedBigIntKey(key) : key,
      frontmatterValueNeedsSharedType(value)
        ? frontmatterValueToY(value)
        : frontmatterValueToAny(value),
    )
  }
}

function frontmatterValueNeedsSharedType(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(frontmatterValueNeedsSharedType)
  if (!isFrontmatterMap(value)) return false
  // Yjs dispatches plain values through `value.constructor`; lib0's plain-map
  // decoder assigns `__proto__` through its setter. Shared types preserve both keys.
  return Object.hasOwn(value, 'constructor')
    || Object.hasOwn(value, '__proto__')
    || Object.values(value).some(frontmatterValueNeedsSharedType)
}

function frontmatterValueToAny(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(frontmatterValueToAny)
  if (!isFrontmatterMap(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, frontmatterValueToAny(child)]),
  )
}

const FRONTMATTER_SHARED_BIGINT_KEY = '$dohcBigInt'
// The sentinel spelling and every extra-`$` escape depth of it. Literal keys
// spelled this way gain one `$` when a shared map is built and lose one when
// it is read, so only a real sentinel ever carries the unescaped key.
const SHARED_BIGINT_KEY_SPELLING = /^\$+dohcBigInt$/

function escapeSharedBigIntKey(key: string): string {
  return SHARED_BIGINT_KEY_SPELLING.test(key) ? `$${key}` : key
}

function unescapeSharedBigIntKey(key: string): string {
  return key.startsWith('$$') && SHARED_BIGINT_KEY_SPELLING.test(key)
    ? key.slice(1)
    : key
}

function frontmatterValueToY(value: unknown): unknown {
  if (typeof value === 'bigint') {
    // Y.Map stores bigint through ContentAny, while Y.Array rejects bigint as
    // a direct item in Yjs 13. Keep the exact value in Any instead of changing
    // its scalar kind to a collaborative text node.
    const integer = new Y.Map<unknown>()
    integer.set(FRONTMATTER_SHARED_BIGINT_KEY, value)
    return integer
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>()
    array.insert(0, value.map(frontmatterValueToY))
    return array
  }
  if (isFrontmatterMap(value)) {
    const map = new Y.Map<unknown>()
    writeMap(map, value, true)
    return map
  }
  return value
}

function yFrontmatterValueToPlain(value: unknown): unknown {
  if (
    value instanceof Y.Map
    && value.size === 1
    && typeof value.get(FRONTMATTER_SHARED_BIGINT_KEY) === 'bigint'
  ) {
    return value.get(FRONTMATTER_SHARED_BIGINT_KEY)
  }
  if (value instanceof Y.Map) return mapToObject(value, true)
  if (value instanceof Y.Array) {
    return value.toArray().map(yFrontmatterValueToPlain)
  }
  // No writer puts Y.Text in frontmatter (bigints ride the shared singleton
  // map); a foreign one degrades to its visible string instead of throwing.
  if (value instanceof Y.Text) return value.toString()
  return normalizeFrontmatterValue(value)
}

function mapToObject(
  map: Y.Map<unknown>,
  unescapeSharedBigIntKeys = false,
): Record<string, unknown> {
  return Object.fromEntries(
    Array.from(map.entries(), ([key, child]) => [
      unescapeSharedBigIntKeys ? unescapeSharedBigIntKey(key) : key,
      yFrontmatterValueToPlain(child),
    ] as const).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  )
}
