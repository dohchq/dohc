import type {
  AnyExtension,
  JSONContent,
  MarkdownRendererHelpers,
} from '@tiptap/core'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import {
  renderTableToMarkdown,
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from '@tiptap/extension-table'
import { TaskList } from '@tiptap/extension-list'
import * as yaml from 'js-yaml'
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
import { backtickFence } from './markdown-fence.js'

const BODY_FIELD = 'body'
const PLAIN_TEXT_FIELD = 'plainText'
const FRONTMATTER_FIELD = 'frontmatter'
const META_FIELD = 'meta'
const FRONTMATTER_PRIORITY_KEYS = ['id', 'title', 'icon'] as const
const DOHC_SCHEMA_VERSION = 1
const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?([\s\S]*)$/
const PLAIN_TEXT_CONTENT_KIND = 'plain-text'
// GFM forbids block nodes inside table cells but permits inline raw HTML, so a
// multi-block ProseMirror cell uses a visible hard break instead of U+001F.
const GFM_TABLE_CELL_BLOCK_SEPARATOR = '<br>'

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

const MarkdownTable = Table.extend({
  renderMarkdown: (node, helpers) => {
    const tableHelpers: MarkdownRendererHelpers = {
      ...helpers,
      renderChildren: (nodes, separator) =>
        prepareRenderedTableCell(helpers.renderChildren(nodes, separator)),
    }
    return renderTableToMarkdown(
      node,
      tableHelpers,
      { cellLineSeparator: GFM_TABLE_CELL_BLOCK_SEPARATOR },
    )
  },
})

const extensions: AnyExtension[] = [
  ...dohcMarkdownExtensions,
  StarterKit,
  TaskList,
  DohcTaskItem,
  MarkdownTable,
  TableCell,
  TableHeader,
  TableRow,
]
const markdownManager = new MarkdownManager({
  extensions,
  indentation: { style: 'space', size: 2 },
})
const schema = getSchema(extensions)

type DohcMeta = { schemaVersion: number; contentKind?: 'plain-text' }

export function markdownToYDoc(markdown: string): Y.Doc {
  const { meta, body } = parseFrontmatter(markdown)
  const doc = new Y.Doc()

  writeMap(doc.getMap(FRONTMATTER_FIELD), meta)
  writeMap(doc.getMap(META_FIELD), { schemaVersion: DOHC_SCHEMA_VERSION })

  const bodyFragment = doc.getXmlFragment(BODY_FIELD)
  const tiptapJson = markdownManager.parse(body)
  prosemirrorJSONToYXmlFragment(schema, tiptapJson, bodyFragment)

  return doc
}

export function plainTextToYDoc(markdown: string): Y.Doc {
  const { meta, body } = parseFrontmatter(markdown)
  const doc = new Y.Doc()

  writeMap(doc.getMap(FRONTMATTER_FIELD), meta)
  writeMap(doc.getMap(META_FIELD), {
    schemaVersion: DOHC_SCHEMA_VERSION,
    contentKind: PLAIN_TEXT_CONTENT_KIND,
  })
  doc.getText(PLAIN_TEXT_FIELD).insert(0, body)

  return doc
}

export function yDocToMarkdown(doc: Y.Doc): string {
  const body = yDocBodyToMarkdown(doc).trimEnd()
  const frontmatter = orderFrontmatter(getDohcYDocFrontmatter(doc))

  if (Object.keys(frontmatter).length === 0) return body

  const yamlFrontmatter = yaml.dump(frontmatter, {
    lineWidth: -1,
    sortKeys: false,
  })

  return `---\n${yamlFrontmatter}---${body.startsWith('\n') ? '\n' : '\n\n'}${body}`
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

export function getDohcYDocBodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(BODY_FIELD)
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
  const bodyFragment = doc.getXmlFragment(BODY_FIELD)
  return yXmlFragmentToProseMirrorRootNode(
    bodyFragment,
    schema,
  ).toJSON() as JSONContent
}

export function serializeRichdocBody(root: JSONContent): string {
  const source = JSON.stringify(root)
  const sourceCharacters = new Set(source)
  const characterSentinels = new Map<string, string>()
  const codeBlocks = new Map<string, string>()
  const reservedTokens = new Set(
    source.match(/\uE000DOHC_[A-Z_]+_\d+\uE001/gu) ?? [],
  )
  let tokenIndex = 0
  const reserveToken = (kind: string): string => {
    let token: string
    do {
      token = `\uE000DOHC_${kind}_${tokenIndex}\uE001`
      tokenIndex += 1
    } while (reservedTokens.has(token))
    reservedTokens.add(token)
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

    if (node.type === 'codeBlock' && node.content?.length) {
      const token = reserveToken('CODE_BLOCK')
      codeBlocks.set(token, textContent(node.content))
      return { ...node, content: [{ type: 'text', text: token }] }
    }

    let content = insideTableCell
      ? node.content?.flatMap(prepareTableCellBlock)
      : node.content?.map(child => visit(child))
    if (content?.length) {
      content = renderInlineCodeRuns(
        content,
        characterSentinels,
        sourceCharacters,
      )
      content = protectMarkdownSyntax(
        content,
        characterSentinels,
        sourceCharacters,
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
  return rewriteCodeBlockFences(markdown, codeBlocks)
}

function protectMarkdownSyntax(
  content: JSONContent[],
  sentinels: Map<string, string>,
  sourceCharacters: ReadonlySet<string>,
): JSONContent[] {
  return content.map((node) => {
    if (typeof node.text !== 'string') return node
    return {
      ...node,
      text: replaceCharacters(
        node.text,
        sentinels,
        sourceCharacters,
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
  sourceCharacters: ReadonlySet<string>,
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
        replaceCharacters(value, entitySentinels, sourceCharacters),
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
  sourceCharacters: ReadonlySet<string>,
  pattern = /[&<>]/g,
): string {
  return value.replace(pattern, character => {
    const existing = replacements.get(character)
    if (existing) return existing

    const sentinel = reserveCharacterSentinel(sourceCharacters, replacements)
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
    const openingFence = opening && /(`{3,})([^`]*)$/.exec(opening)
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
    const fence = backtickFence(content, 3)
    const contentLines = content.split('\n').map(line =>
      line.length === 0 ? contentPrefix.trimEnd() : `${contentPrefix}${line}`,
    )
    output.push(
      `${openingPrefix}${fence}${language}`,
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

function reserveCharacterSentinel(
  sourceCharacters: ReadonlySet<string>,
  reserved: Map<string, string>,
): string {
  for (let codePoint = 0xE002; codePoint <= 0xF8FF; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint)
    if (
      !sourceCharacters.has(candidate)
      && !Array.from(reserved.values()).includes(candidate)
    ) {
      return candidate
    }
  }
  throw new Error('could not reserve a Markdown serialization sentinel')
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

function parseFrontmatter(src: string): {
  meta: Record<string, unknown>
  body: string
} {
  const match = FM_RE.exec(src)
  if (!match) return { meta: {}, body: src }

  const [, raw, rest] = match
  let meta: Record<string, unknown> = {}
  if (isEmptyFrontmatter(raw ?? '')) return { meta, body: rest ?? '' }
  try {
    const parsed = yaml.load(raw ?? '')
    if (parsed == null) return { meta: {}, body: src }
    if (!isFrontmatterMap(parsed)) return { meta: {}, body: src }
    meta = parsed
  } catch {
    return { meta: {}, body: src }
  }
  return { meta, body: rest ?? '' }
}

function isFrontmatterMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isEmptyFrontmatter(raw: string): boolean {
  return raw.split(/\r?\n/).every((line) => {
    const trimmed = line.trim()
    return !trimmed || trimmed.startsWith('#')
  })
}

function writeMap(map: Y.Map<unknown>, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    map.set(key, value)
  }
}

function mapToObject(map: Y.Map<unknown>): Record<string, unknown> {
  return Object.fromEntries(map.entries())
}

function orderFrontmatter(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}

  for (const key of FRONTMATTER_PRIORITY_KEYS) {
    if (Object.hasOwn(frontmatter, key)) ordered[key] = frontmatter[key]
  }

  for (const key of Object.keys(frontmatter).sort()) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = frontmatter[key]
  }

  return ordered
}
