import type { AnyExtension, JSONContent } from '@tiptap/core'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import yaml from 'js-yaml'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import { parseFrontmatter } from '../lib/frontmatter'
import { DOHC_V2_SCHEMA_VERSION } from './schema-contracts'
import { dohcMarkdownExtensions } from './dohc-markdown-extensions'

const BODY_FIELD = 'body'
const FRONTMATTER_FIELD = 'frontmatter'
const META_FIELD = 'meta'
const FRONTMATTER_PRIORITY_KEYS = ['id', 'title', 'icon'] as const

const extensions: AnyExtension[] = [
  ...dohcMarkdownExtensions,
  StarterKit,
  TableKit,
]
const markdownManager = new MarkdownManager({
  extensions,
  indentation: { style: 'space', size: 2 },
})
const schema = getSchema(extensions)

type DohcV2Meta = { schemaVersion: number }

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

export function yDocToMarkdown(doc: Y.Doc): string {
  const body = yDocBodyToMarkdown(doc).trimEnd()
  const frontmatter = orderFrontmatter(getDohcYDocFrontmatter(doc))

  if (Object.keys(frontmatter).length === 0) {
    return body
  }

  const yamlFrontmatter = yaml.dump(frontmatter, {
    lineWidth: -1,
    sortKeys: false,
  })

  return `---\n${yamlFrontmatter}---\n\n${body}`
}

export function roundTripMarkdown(markdown: string): string {
  return yDocToMarkdown(markdownToYDoc(markdown))
}

export function encodeDohcYDocUpdate(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc)
}

export function applyDohcYDocUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  return doc
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
  }
}

export function getDohcYDocBodyType(doc: Y.Doc): 'Y.XmlFragment' {
  const body = doc.getXmlFragment(BODY_FIELD)
  if (!(body instanceof Y.XmlFragment)) {
    throw new Error('dohc v2 body is not a Y.XmlFragment')
  }
  return 'Y.XmlFragment'
}

export function getDohcYDocBodyJSON(doc: Y.Doc): JSONContent {
  return yDocBodyToJSON(doc)
}

function yDocBodyToMarkdown(doc: Y.Doc): string {
  return markdownManager.serialize(yDocBodyToJSON(doc))
}

function yDocBodyToJSON(doc: Y.Doc): JSONContent {
  const bodyFragment = doc.getXmlFragment(BODY_FIELD)
  return yXmlFragmentToProseMirrorRootNode(
    bodyFragment,
    schema,
  ).toJSON() as JSONContent
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
    if (Object.hasOwn(frontmatter, key)) {
      ordered[key] = frontmatter[key]
    }
  }

  for (const key of Object.keys(frontmatter).sort()) {
    if (!Object.hasOwn(ordered, key)) {
      ordered[key] = frontmatter[key]
    }
  }

  return ordered
}
