import type { JSONContent } from '@tiptap/core'
export {yDocToArtifactMarkdown} from '@dohc/ydoc-projection'
import { getHTMLFromFragment } from '@tiptap/core'
import {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  getDohcYDocPlainText,
  parseRichdocMarkdown,
  serializeRichdocBody,
} from '@dohc/ydoc-projection'
import { escapeHighlightMarkdown } from '@dohc/ydoc-projection/markdown-extensions'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as Y from 'yjs'
import { frontmatterBlockFor } from '@dohc/ydoc-projection/frontmatter'
import { writtenFrontmatterKeys } from '@dohc/ydoc-projection/frontmatter-map'
import { orderFrontmatter } from '../markdown/frontmatter'

const BODY_FIELD = 'body'
const FRONTMATTER_FIELD = 'frontmatter'
const META_FIELD = 'meta'

const schema = getDohcProseMirrorSchema()

export function yDocToMarkdown(doc: Y.Doc): string {
  const body = yDocBodyToMarkdown(doc).trimEnd()
  const frontmatter = orderFrontmatter(getDohcYDocFrontmatter(doc))
  // The frontmatter text the settle keeps, so the source view shows it too.
  const meta = doc.getMap(META_FIELD)
  const written = writtenFrontmatterKeys(doc.getMap(FRONTMATTER_FIELD), meta)
  return `${frontmatterBlockFor(frontmatter, meta.get('dohcFrontmatterSource'), body, '\n', written)}${body}`
}

// Renders BODY markdown (post-frontmatter — split a full document string
// with parseFrontmatter first) to HTML through the projection's parser and
// schema, the same ones the editor and Y.Doc conversions use, so custom nodes
// (wikilinks, callouts, highlight marks, task lists) render via their own
// renderHTML — never a generic/lossy fallback. Used by the document export
// menu (documentExport.ts). Needs a DOM (`document` global): true in the
// renderer and under vitest's jsdom environment, never in the main process.
export function markdownBodyToHtml(body: string): string {
  const node = ProseMirrorNode.fromJSON(schema, parseRichdocMarkdown(body))
  return getHTMLFromFragment(node.content, schema)
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

// undefined for an empty or frontmatter-only body (no first XML element
// there) so the caller falls back to its normal empty-doc path instead of
// handing tiptap a schema-invalid seed — `schema.nodeFromJSON` builds a node
// from this JSON without validating it, so a content-less seed would create
// an empty document with no paragraph for the placeholder or the initial
// selection to land in.
//
// Walks the Y.XmlFragment's first-element chain directly rather than
// converting the whole body to a ProseMirror tree first (yDocBodyToJSON) and
// discarding everything but one path — this runs on every collab mount, so
// its cost is proportional to the path depth, not the document size.
export function getDohcYDocSelectionSeed(doc: Y.Doc): JSONContent | undefined {
  const first = firstXmlElementChild(doc.getXmlFragment(BODY_FIELD))
  return first ? { type: 'doc', content: [xmlElementToSelectionSeed(first)] } : undefined
}

// Y.XmlFragment children can be Y.XmlElement, Y.XmlText, or Y.XmlHook — only
// an element has a nodeName/content path to descend into, so text (and any
// hook) is skipped in child order, matching `firstNodePath`'s prior rule.
function firstXmlElementChild(parent: Y.XmlFragment): Y.XmlElement | null {
  for (let i = 0; i < parent.length; i += 1) {
    const child = parent.get(i)
    if (child instanceof Y.XmlElement) return child
  }
  return null
}

function xmlElementToSelectionSeed(element: Y.XmlElement): JSONContent {
  const attrs = element.getAttributes()
  const child = firstXmlElementChild(element)
  return {
    type: element.nodeName,
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(child ? { content: [xmlElementToSelectionSeed(child)] } : {}),
  }
}
