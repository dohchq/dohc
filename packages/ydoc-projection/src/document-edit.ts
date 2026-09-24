import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as Y from 'yjs'
import { getDohcYDocBodyFragment } from './body-fragment.js'
import { escapeHighlightMarkdown } from './dohc-markdown-extensions.js'
import {
  frontmatterYaml,
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  markdownToYDoc,
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
//
// These functions take and return encoded Y.Doc state, so a worker can run
// them away from the thread that holds the live document.

const BLOCK_SEPARATOR = '\n\n'

// What an agent can do when its edit would lose what a person types.
export const DOCUMENT_OPEN_REFUSAL =
  'Someone may be typing in this document, here or on a device it syncs to, and this edit ' +
  'would remove a block, join two blocks, or change a block\'s kind, such as a paragraph ' +
  'into a heading. Anything they type into that block meanwhile would be lost, so nothing ' +
  'changed. Instead, change only the text inside blocks and add new blocks; ask the person ' +
  'to make this change; or retry after they close the document.'

export interface DocumentEdit {
  /** Markdown that occurs exactly once in the document. Omit it to add `replacement` at the end. */
  find?: string
  replacement: string
}

export interface DocumentEditOptions {
  /**
   * Someone may be typing in the document. Text typed into a block survives
   * a change to the block's text, but not the block's removal or a change of
   * its kind, so such an edit is refused.
   */
  keepBlocks: boolean
}

interface Layout {
  frontmatter: string
  fragment: Y.XmlFragment
  /** The fragment's top-level elements, and the block each one reads as. */
  elements: Y.XmlElement[]
  blocks: ProseMirrorNode[]
  /** Each block's Markdown and where it sits in the body. */
  chunks: Array<{ markdown: string; start: number; end: number }>
  body: string
}

/** The document in `state` as the Markdown an edit matches against. */
export function documentMarkdown(state: Uint8Array): string {
  return withDoc(state, (doc) => markdownOfLayout(layoutOf(doc)))
}

/** A settled Markdown file as the Markdown an edit to it would match against. */
export function settledDocumentMarkdown(markdown: string): string {
  const doc = markdownToYDoc(markdown)
  try {
    return markdownOfLayout(layoutOf(doc))
  } finally {
    doc.destroy()
  }
}

/**
 * The Y.Doc update that applies `edit` to the document in `state`, or null
 * when the edit changes nothing. Throws when the edit cannot apply; the
 * message says what to do instead.
 */
export function documentEditUpdate(
  state: Uint8Array,
  edit: DocumentEdit,
  options: DocumentEditOptions,
): Uint8Array | null {
  return withDoc(state, (doc) => {
    // Reading the document can delete elements the schema refuses. That
    // happens before the edit starts recording, so the update never carries it.
    const change = planEdit(layoutOf(doc), edit)
    if (!change) return null
    let update: Uint8Array | null = null
    const record = (next: Uint8Array): void => {
      update = update === null ? next : Y.mergeUpdates([update, next])
    }
    let removesBlock = false
    doc.on('update', record)
    try {
      doc.transact((transaction) => {
        change(doc)
        if (options.keepBlocks) removesBlock = removesTextBlock(transaction)
      })
    } finally {
      doc.off('update', record)
    }
    if (removesBlock) {
      throw new Error(DOCUMENT_OPEN_REFUSAL)
    }
    return update
  })
}

/**
 * The update that writes the first text into a new document. The text is
 * the body only: frontmatter would reach the Y.Doc as body blocks, so it is
 * refused.
 */
export function documentCreateUpdate(
  state: Uint8Array,
  markdown: string,
  options: DocumentEditOptions,
): Uint8Array | null {
  const parsed = markdownToYDoc(markdown)
  try {
    if (Object.keys(getDohcYDocFrontmatter(parsed)).length > 0) {
      throw new Error('A new document starts without frontmatter. Write its body text only.')
    }
  } finally {
    parsed.destroy()
  }
  return documentEditUpdate(state, { replacement: markdown }, options)
}

function withDoc<T>(state: Uint8Array, read: (doc: Y.Doc) => T): T {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return read(doc)
  } finally {
    doc.destroy()
  }
}

// Whether the transaction deleted a type that holds text or could: every
// XmlText, and every element except a leaf such as an image or a line break.
// Deleting characters inside a text keeps what others type around them.
function removesTextBlock(transaction: Y.Transaction): boolean {
  const schema = getDohcProseMirrorSchema()
  let removes = false
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
    if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentType)) return
    const type = struct.content.type
    const leaf = type instanceof Y.XmlElement && schema.nodes[type.nodeName]?.isLeaf === true
    if (!leaf) removes = true
  })
  return removes
}

function layoutOf(doc: Y.Doc): Layout {
  const values = getDohcYDocFrontmatter(doc)
  const frontmatter = Object.keys(values).length > 0
    ? `---\n${frontmatterYaml(values)}---\n\n`
    : ''
  const fragment = getDohcYDocBodyFragment(doc)
  const blocks: ProseMirrorNode[] = []
  yXmlFragmentToProseMirrorRootNode(fragment, getDohcProseMirrorSchema())
    .forEach((block) => { blocks.push(block) })
  // Read after the conversion, which deletes what the schema refuses.
  const elements = fragment.toArray()
  if (
    elements.length !== blocks.length ||
    elements.some((element, index) =>
      !(element instanceof Y.XmlElement) || element.nodeName !== blocks[index]!.type.name)
  ) {
    throw new Error('dohc could not read the blocks of this document.')
  }
  const chunks: Layout['chunks'] = []
  let start = 0
  for (const block of blocks) {
    const markdown = blockMarkdown(block)
    chunks.push({ markdown, start, end: start + markdown.length })
    start += markdown.length + BLOCK_SEPARATOR.length
  }
  const body = chunks.map((chunk) => chunk.markdown).join(BLOCK_SEPARATOR)
  return { frontmatter, fragment, elements: elements as Y.XmlElement[], blocks, chunks, body }
}

function markdownOfLayout(layout: Layout): string {
  return layout.frontmatter + layout.body
}

function blockMarkdown(block: ProseMirrorNode): string {
  const root = escapeHighlightMarkdown({ type: 'doc', content: [block.toJSON()] })
  return serializeRichdocBody(root).replace(/\n+$/u, '')
}

function planEdit(layout: Layout, edit: DocumentEdit): ((doc: Y.Doc) => void) | null {
  const replacement = edit.replacement.replaceAll('\r\n', '\n')
  if (edit.find === undefined) {
    if (replacement.trim() === '') return null
    // New blocks follow the last block with text, ahead of any empty
    // paragraph the person's cursor may sit in.
    let lastWithText = layout.chunks.length - 1
    while (lastWithText >= 0 && layout.chunks[lastWithText]!.markdown === '') lastWithText -= 1
    return blockChange(layout, lastWithText + 1, lastWithText, replacement)
  }
  const find = edit.find.replaceAll('\r\n', '\n')
  const at = uniqueMatch(markdownOfLayout(layout), find) - layout.frontmatter.length
  if (at < 0) {
    throw new Error("The text is in the document's frontmatter. Document edits change the body only.")
  }
  if (find === replacement) return null
  return planBlockEdit(layout, at, at + find.length, replacement)
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
// block that only meets the range at one edge. A match in a nonempty body
// always has a block at or beside it.
function planBlockEdit(
  layout: Layout,
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

// Replaces blocks first..last with the blocks `markdown` parses to; with
// last < first it inserts them before block `first`. y-prosemirror then
// changes the Y.Doc into that document. Every block outside the range is
// mapped to its own element, so y-prosemirror passes over it without
// comparing it, and a block whose Markdown reads back a little differently
// is never rewritten.
function blockChange(
  layout: Layout,
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
  const mapping = new Map<Y.XmlElement, ProseMirrorNode>()
  layout.elements.forEach((element, index) => {
    if (index < first || index > last) mapping.set(element, layout.blocks[index]!)
  })
  return (doc) => {
    updateYFragment(doc, layout.fragment, target, { mapping, isOMark: new Map() })
  }
}
