import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as Y from 'yjs'
import { getDohcYDocBodyFragment } from './body-fragment.js'
import { escapeHighlightMarkdown } from './dohc-markdown-extensions.js'
import {
  frontmatterYaml,
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  getDohcYDocPlainText,
  parseRichdocMarkdown,
  serializeRichdocBody,
} from './import-export.js'

// An agent reads a live document as Markdown and edits it by replacing text in
// that Markdown. The edit reaches the Y.Doc as the smallest change to the
// blocks it touches, computed the way the editor turns a keystroke into a
// Y.Doc change. Blocks outside the edit are never parsed back from Markdown,
// so a person typing elsewhere in the document keeps their text.
//
// Each top-level block is written as Markdown on its own and the blocks are
// joined with a blank line. That keeps every block's place in the text known,
// which is what lets an edit touch only its own blocks.

const BLOCK_SEPARATOR = '\n\n'

export interface DocumentEdit {
  /** Markdown that occurs exactly once in the document. Omit it to add `replacement` at the end. */
  find?: string
  replacement: string
}

interface RichLayout {
  kind: 'rich'
  frontmatter: string
  fragment: Y.XmlFragment
  blocks: ProseMirrorNode[]
  /** Each block's Markdown and where it sits in the body. */
  chunks: Array<{ markdown: string; start: number; end: number }>
  body: string
}

type Layout =
  | { kind: 'plain-text'; frontmatter: string; text: Y.Text; body: string }
  | RichLayout

/** The document as the Markdown an edit matches against. */
export function documentMarkdown(doc: Y.Doc): string {
  return withCopy(doc, (copy) => {
    const layout = layoutOf(copy)
    return layout.frontmatter + layout.body
  })
}

/**
 * The Y.Doc update that applies `edit` to `doc`, or null when the edit
 * changes nothing. `doc` itself is not changed. Throws when the edit cannot
 * apply; the message says what to do instead.
 */
export function documentEditUpdate(doc: Y.Doc, edit: DocumentEdit): Uint8Array | null {
  return withCopy(doc, (copy) => {
    const change = planEdit(layoutOf(copy), edit)
    if (!change) return null
    let update: Uint8Array | null = null
    const record = (next: Uint8Array): void => {
      update = update === null ? next : Y.mergeUpdates([update, next])
    }
    copy.on('update', record)
    try {
      copy.transact(() => change(copy))
    } finally {
      copy.off('update', record)
    }
    return update
  })
}

// Reading a Y.Doc as ProseMirror can delete elements the schema refuses. That
// happens on a copy, before the edit starts recording, so neither the caller's
// document nor the returned update carries it.
function withCopy<T>(doc: Y.Doc, read: (copy: Y.Doc) => T): T {
  const copy = new Y.Doc()
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    return read(copy)
  } finally {
    copy.destroy()
  }
}

function layoutOf(doc: Y.Doc): Layout {
  const values = getDohcYDocFrontmatter(doc)
  const frontmatter = Object.keys(values).length > 0
    ? `---\n${frontmatterYaml(values)}---\n\n`
    : ''
  const text = getDohcYDocPlainText(doc)
  if (text) return { kind: 'plain-text', frontmatter, text, body: text.toString() }
  const fragment = getDohcYDocBodyFragment(doc)
  const blocks: ProseMirrorNode[] = []
  yXmlFragmentToProseMirrorRootNode(fragment, getDohcProseMirrorSchema())
    .forEach((block) => { blocks.push(block) })
  const chunks: RichLayout['chunks'] = []
  let start = 0
  for (const block of blocks) {
    const markdown = blockMarkdown(block)
    chunks.push({ markdown, start, end: start + markdown.length })
    start += markdown.length + BLOCK_SEPARATOR.length
  }
  const body = chunks.map((chunk) => chunk.markdown).join(BLOCK_SEPARATOR)
  return { kind: 'rich', frontmatter, fragment, blocks, chunks, body }
}

function blockMarkdown(block: ProseMirrorNode): string {
  const root = escapeHighlightMarkdown({ type: 'doc', content: [block.toJSON()] })
  return serializeRichdocBody(root).replace(/\n+$/u, '')
}

function planEdit(layout: Layout, edit: DocumentEdit): ((doc: Y.Doc) => void) | null {
  const replacement = edit.replacement.replaceAll('\r\n', '\n')
  if (edit.find === undefined) {
    return replacement.trim() === '' ? null : planAppend(layout, replacement)
  }
  const find = edit.find.replaceAll('\r\n', '\n')
  const at = uniqueMatch(layout.frontmatter + layout.body, find) - layout.frontmatter.length
  if (at < 0) {
    throw new Error("The text is in the document's frontmatter. Document edits change the body only.")
  }
  if (find === replacement) return null
  if (layout.kind === 'plain-text') {
    const { text } = layout
    return () => {
      text.delete(at, find.length)
      if (replacement) text.insert(at, replacement)
    }
  }
  return planBlockEdit(layout, at, at + find.length, replacement)
}

function planAppend(layout: Layout, replacement: string): (doc: Y.Doc) => void {
  if (layout.kind === 'plain-text') {
    const { text, body } = layout
    const separator = body === '' || body.endsWith('\n') ? '' : '\n'
    return () => text.insert(body.length, separator + replacement)
  }
  // New blocks follow the last block with text, ahead of any empty paragraph
  // the person's cursor may sit in. A document of empty paragraphs takes the
  // new text in their place.
  const last = [...layout.chunks].reverse().find((chunk) => chunk.markdown !== '')
  if (!last) return blockChange(layout, 0, layout.blocks.length - 1, replacement)
  return planBlockEdit(layout, last.end, last.end, BLOCK_SEPARATOR + replacement)
}

function uniqueMatch(markdown: string, find: string): number {
  const first = markdown.indexOf(find)
  if (first < 0) {
    throw new Error('The text to replace is not in the document. Read the document again and copy the text exactly.')
  }
  let count = 1
  for (let at = markdown.indexOf(find, first + 1); at >= 0; at = markdown.indexOf(find, at + 1)) {
    count += 1
  }
  if (count > 1) {
    throw new Error(`The text to replace occurs ${count} times. Include more of the text around it so it occurs once.`)
  }
  return first
}

// Rewrites the blocks that the body range [start, end) touches, counting a
// block that only meets the range at one edge. A nonempty body always has a
// block at or beside any range in it.
function planBlockEdit(
  layout: RichLayout,
  start: number,
  end: number,
  replacement: string,
): (doc: Y.Doc) => void {
  const first = layout.chunks.findIndex((chunk) => chunk.end >= start)
  let last = first
  while (last + 1 < layout.chunks.length && layout.chunks[last + 1]!.start <= end) last += 1
  const from = Math.min(layout.chunks[first]!.start, start)
  const to = Math.max(layout.chunks[last]!.end, end)
  const markdown = layout.body.slice(from, start) + replacement + layout.body.slice(end, to)
  return blockChange(layout, first, last, markdown)
}

// Replaces blocks first..last with `markdown`, then lets y-prosemirror change
// the Y.Doc into that document. Blocks before and after the range are the
// Y.Doc's own, so it finds them unchanged and leaves them alone.
function blockChange(
  layout: RichLayout,
  first: number,
  last: number,
  markdown: string,
): (doc: Y.Doc) => void {
  const schema = getDohcProseMirrorSchema()
  const replacement: ProseMirrorNode[] = []
  if (markdown.trim() !== '') {
    schema.nodeFromJSON(parseRichdocMarkdown(markdown)).forEach((block) => {
      replacement.push(block)
    })
  }
  const blocks = [
    ...layout.blocks.slice(0, first),
    ...replacement,
    ...layout.blocks.slice(last + 1),
  ]
  const target = schema.topNodeType.createChecked(
    null,
    blocks.length > 0 ? blocks : [schema.nodes.paragraph!.create()],
  )
  return (doc) => {
    updateYFragment(doc, layout.fragment, target, { mapping: new Map(), isOMark: new Map() })
  }
}
