import type { AnyExtension, JSONContent } from '@tiptap/core'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  orderFrontmatter,
  parseFrontmatter,
  stringifyFrontmatter,
} from '../markdown/frontmatter'
import { dohcMarkdownExtensions } from './extensions'

const BODY_FIELD = 'body'
const PLAIN_TEXT_FIELD = 'plainText'
const FRONTMATTER_FIELD = 'frontmatter'
const META_FIELD = 'meta'
const DOHC_V2_SCHEMA_VERSION = 1
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

  replaceMap(doc.getMap(FRONTMATTER_FIELD), meta)
  replaceMap(doc.getMap(META_FIELD), { schemaVersion: DOHC_V2_SCHEMA_VERSION })

  const bodyFragment = doc.getXmlFragment(BODY_FIELD)
  const tiptapJson = markdownManager.parse(body)
  prosemirrorJSONToYXmlFragment(schema, tiptapJson, bodyFragment)

  return doc
}

export function plainTextToYDoc(markdown: string): Y.Doc {
  const { meta, body } = parseFrontmatter(markdown)
  const doc = new Y.Doc()

  replaceMap(doc.getMap(FRONTMATTER_FIELD), meta)
  replaceMap(doc.getMap(META_FIELD), {
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

  return `---\n${stringifyFrontmatter(frontmatter)}---${
    body.startsWith('\n') ? '\n' : '\n\n'
  }${body}`
}

export function replaceYDocWithMarkdown(doc: Y.Doc, markdown: string): void {
  const { meta, body } = parseFrontmatter(markdown)
  doc.transact(() => {
    replaceMap(doc.getMap(FRONTMATTER_FIELD), meta)
    replaceMap(doc.getMap(META_FIELD), { schemaVersion: DOHC_V2_SCHEMA_VERSION })

    const bodyFragment = doc.getXmlFragment(BODY_FIELD)
    if (bodyFragment.length > 0) bodyFragment.delete(0, bodyFragment.length)
    const tiptapJson = markdownManager.parse(body)
    prosemirrorJSONToYXmlFragment(schema, tiptapJson, bodyFragment)
  })
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
  return markdownManager.serialize(yDocBodyToJSON(doc))
}

function yDocBodyToJSON(doc: Y.Doc): JSONContent {
  const bodyFragment = doc.getXmlFragment(BODY_FIELD)
  return yXmlFragmentToProseMirrorRootNode(
    bodyFragment,
    schema,
  ).toJSON() as JSONContent
}

function replaceMap(map: Y.Map<unknown>, values: Record<string, unknown>): void {
  for (const key of Array.from(map.keys())) {
    map.delete(key)
  }
  for (const [key, value] of Object.entries(values)) {
    map.set(key, value)
  }
}

function mapToObject(map: Y.Map<unknown>): Record<string, unknown> {
  return Object.fromEntries(map.entries())
}
