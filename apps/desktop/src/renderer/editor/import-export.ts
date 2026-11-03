import type { JSONContent } from '@tiptap/core'
// The renderer copies and shows a note's Markdown with the projection's own
// exporter, so it gives the bytes the worker's canonical fallback gives,
// line endings included.
export {yDocToArtifactMarkdown, yDocToMarkdown} from '@dohc/ydoc-projection'
import { getHTMLFromFragment } from '@tiptap/core'
import { getDohcProseMirrorSchema, parseRichdocMarkdown } from '@dohc/ydoc-projection'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import * as Y from 'yjs'

const BODY_FIELD = 'body'

const schema = getDohcProseMirrorSchema()

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
