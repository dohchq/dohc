import type { AnyExtension, JSONContent } from '@tiptap/core'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import yaml from 'js-yaml'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  dohcMarkdownExtensions,
  escapeHighlightMarkdown,
} from './dohc-markdown-extensions.js'

const BODY_FIELD = 'body'
const PLAIN_TEXT_FIELD = 'plainText'
const FRONTMATTER_FIELD = 'frontmatter'
const META_FIELD = 'meta'
const FRONTMATTER_PRIORITY_KEYS = ['id', 'title', 'icon'] as const
const DOHC_V2_SCHEMA_VERSION = 1
const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?([\s\S]*)$/
const PLAIN_TEXT_CONTENT_KIND = 'plain-text'

const extensions: AnyExtension[] = [
  ...dohcMarkdownExtensions,
  StarterKit,
  TaskList,
  TaskItem,
  TableKit,
]
const markdownManager = new MarkdownManager({
  extensions,
  indentation: { style: 'space', size: 2 },
})
const schema = getSchema(extensions)

type DohcV2Meta = { schemaVersion: number; contentKind?: 'plain-text' }

export function markdownToYDoc(markdown: string): Y.Doc {
  const { meta, body } = parseFrontmatter(markdown)
  const doc = new Y.Doc()

  writeMap(doc.getMap(FRONTMATTER_FIELD), meta)
  writeMap(doc.getMap(META_FIELD), { schemaVersion: DOHC_V2_SCHEMA_VERSION })

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
    schemaVersion: DOHC_V2_SCHEMA_VERSION,
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

export function getDohcYDocMeta(doc: Y.Doc): DohcV2Meta {
  const meta = mapToObject(doc.getMap(META_FIELD))
  return {
    schemaVersion:
      typeof meta.schemaVersion === 'number'
        ? meta.schemaVersion
        : DOHC_V2_SCHEMA_VERSION,
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

function serializeRichdocBody(root: JSONContent): string {
  const source = JSON.stringify(root)
  const tablePipeSentinel = unusedSupplementaryCodePoint(source)
  const inlineCode = new Map<string, string>()
  const codeBlocks = new Map<string, string>()
  const reservedTokens = new Set<string>()
  let tokenIndex = 0
  const reserveToken = (kind: string): string => {
    let token: string
    do {
      token = `\uE000DOHC_${kind}_${tokenIndex}\uE001`
      tokenIndex += 1
    } while (source.includes(token) || reservedTokens.has(token))
    reservedTokens.add(token)
    return token
  }

  const visit = (node: JSONContent): JSONContent => {
    if (node.type === 'codeBlock' && node.content?.length) {
      const token = reserveToken('CODE_BLOCK')
      codeBlocks.set(token, textContent(node.content))
      return { ...node, content: [{ type: 'text', text: token }] }
    }

    let content = node.content?.map(visit)

    if (node.type === 'table' && content?.length) {
      content = content.map((row, rowIndex) => ({
        ...row,
        content: row.content?.map(cell => ({
          ...cell,
          type: rowIndex === 0 ? 'tableHeader' : cell.type,
          content: replaceText(cell.content, '|', tablePipeSentinel),
        })),
      }))
    } else if (content?.length) {
      content = replaceInlineCodeRuns(content, value => {
        const token = reserveToken('INLINE_CODE')
        inlineCode.set(token, renderInlineCode(value))
        return token
      })
    }

    return content ? { ...node, content } : { ...node }
  }

  const prepared = visit(root)
  let markdown = markdownManager.serialize(prepared)
  markdown = markdown.replaceAll(tablePipeSentinel, '\\|')
  for (const [token, rendered] of inlineCode) {
    markdown = markdown.replace(`\`${token}\``, rendered)
  }
  return rewriteCodeBlockFences(markdown, codeBlocks)
}

function textContent(content: JSONContent[]): string {
  return content.map(node =>
    typeof node.text === 'string' ? node.text : textContent(node.content ?? []),
  ).join('')
}

function replaceText(
  content: JSONContent[] | undefined,
  needle: string,
  replacement: string,
): JSONContent[] | undefined {
  return content?.map(node => ({
    ...node,
    text: typeof node.text === 'string'
      ? node.text.replaceAll(needle, replacement)
      : node.text,
    content: replaceText(node.content, needle, replacement),
  }))
}

function replaceInlineCodeRuns(
  content: JSONContent[],
  tokenFor: (value: string) => string,
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
    output.push({ ...node, text: tokenFor(value) })
    index = end
  }
  return output
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
  for (const [token, content] of codeBlocks) {
    const tokenLine = lines.findIndex(line => line.endsWith(token))
    if (tokenLine <= 0 || tokenLine + 1 >= lines.length) continue
    const prefix = lines[tokenLine].slice(0, -token.length)
    const opening = lines[tokenLine - 1]
    if (!opening.startsWith(`${prefix}\`\`\``)) continue
    const language = opening.slice(prefix.length + 3)
    const fence = backtickFence(content, 3)
    const contentLines = content.split('\n').map(line =>
      line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`,
    )
    lines.splice(
      tokenLine - 1,
      3,
      `${prefix}${fence}${language}`,
      ...contentLines,
      `${prefix}${fence}`,
    )
  }
  return lines.join('\n')
}

function backtickFence(value: string, minimum: number): string {
  const longest = Array.from(value.matchAll(/`+/g))
    .reduce((max, match) => Math.max(max, match[0].length), 0)
  return '`'.repeat(Math.max(minimum, longest + 1))
}

function unusedSupplementaryCodePoint(source: string): string {
  for (let codePoint = 0xF0000; codePoint <= 0xFFFFD; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint)
    if (!source.includes(candidate)) return candidate
  }
  throw new Error('could not reserve a table-pipe serialization sentinel')
}

function parseFrontmatter(src: string): {
  meta: Record<string, unknown>
  body: string
} {
  const match = FM_RE.exec(src)
  if (!match) return { meta: {}, body: src }

  const [, raw, rest] = match
  let meta: Record<string, unknown> = {}
  try {
    const parsed = yaml.load(raw ?? '')
    if (parsed == null) {
      return isEmptyFrontmatter(raw ?? '')
        ? { meta, body: rest ?? '' }
        : { meta: {}, body: src }
    }
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
