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
  return markdownManager.serialize(escapeHighlightMarkdown(yDocBodyToJSON(doc)))
}

function yDocBodyToJSON(doc: Y.Doc): JSONContent {
  const bodyFragment = doc.getXmlFragment(BODY_FIELD)
  return yXmlFragmentToProseMirrorRootNode(
    bodyFragment,
    schema,
  ).toJSON() as JSONContent
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
