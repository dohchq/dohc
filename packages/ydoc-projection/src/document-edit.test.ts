import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { getDohcYDocBodyFragment } from './body-fragment.js'
import {
  documentEditUpdate,
  documentMarkdown,
  settledDocumentMarkdown,
  type DocumentEdit,
} from './document-edit.js'
import { getDohcProseMirrorSchema, markdownToYDoc, yDocToMarkdown } from './import-export.js'

const state = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc)
const markdownOf = (doc: Y.Doc) => documentMarkdown(state(doc))

function edited(doc: Y.Doc, edit: DocumentEdit): Y.Doc {
  const update = documentEditUpdate(state(doc), edit)
  if (update) Y.applyUpdate(doc, update)
  return doc
}

function editorDoc(content: unknown[]): Y.Doc {
  const doc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(
    getDohcProseMirrorSchema(),
    { type: 'doc', content },
    getDohcYDocBodyFragment(doc),
  )
  return doc
}

const paragraph = (text?: string) => text
  ? { type: 'paragraph', content: [{ type: 'text', text }] }
  : { type: 'paragraph' }

describe('documentMarkdown', () => {
  test('reads an ordinary document as its file does', () => {
    const markdown = '---\ntitle: Trip\n---\n\n# Kyoto\n\n- Day one\n- Day two\n\nA **bold** plan.'
    const doc = markdownToYDoc(markdown)
    expect(markdownOf(doc)).toBe(markdown)
    expect(markdownOf(doc)).toBe(yDocToMarkdown(doc))
    expect(settledDocumentMarkdown('# Kyoto\n\n* Day one\n')).toBe('# Kyoto\n\n- Day one')
  })
})

describe('documentEditUpdate', () => {
  test('replaces text and leaves the other blocks as they were', () => {
    const doc = markdownToYDoc('# Kyoto\n\nDay one: temples.\n\nDay two: markets.')
    const body = getDohcYDocBodyFragment(doc)
    const [heading, dayOne, dayTwo] = body.toArray()

    edited(doc, { find: 'temples', replacement: 'temples and tea' })

    expect(markdownOf(doc)).toBe('# Kyoto\n\nDay one: temples and tea.\n\nDay two: markets.')
    expect(body.toArray()).toEqual([heading, dayOne, dayTwo])
  })

  test('adds a section written as Markdown', () => {
    const doc = markdownToYDoc('# Itinerary\n\n## Thursday\n\nFly home.')
    edited(doc, {
      find: 'Fly home.',
      replacement: 'Fly home.\n\n## Friday 14\n\n- Sleep\n- Unpack',
    })
    expect(markdownOf(doc)).toBe(
      '# Itinerary\n\n## Thursday\n\nFly home.\n\n## Friday 14\n\n- Sleep\n- Unpack',
    )
  })

  test('adds text after the last block with text, ahead of trailing empty paragraphs', () => {
    const doc = editorDoc([paragraph('Notes'), paragraph()])
    const cursorBlock = getDohcYDocBodyFragment(doc).get(1)
    edited(doc, { replacement: '## Next\n\nCall the hotel.' })
    expect(markdownOf(doc)).toBe('Notes\n\n## Next\n\nCall the hotel.\n\n')
    const body = getDohcYDocBodyFragment(doc)
    expect(body.get(body.length - 1)).toBe(cursorBlock)
  })

  test('adds text to a document with no blocks and to one with only an empty paragraph', () => {
    expect(markdownOf(edited(new Y.Doc(), { replacement: 'First line.' }))).toBe('First line.')
    expect(markdownOf(edited(editorDoc([paragraph()]), { replacement: 'First line.' })))
      .toBe('First line.\n\n')
  })

  test('removes a block', () => {
    const doc = edited(markdownToYDoc('Keep.\n\nDrop this.\n\nKeep too.'), { find: '\n\nDrop this.', replacement: '' })
    expect(markdownOf(doc)).toBe('Keep.\n\nKeep too.')
  })

  test('refuses text it cannot find once', () => {
    const doc = state(markdownToYDoc('Tea.\n\nTea.'))
    expect(() => documentEditUpdate(doc, { find: 'Coffee', replacement: 'x' }))
      .toThrow('not in the document')
    expect(() => documentEditUpdate(doc, { find: 'Tea', replacement: 'x' }))
      .toThrow('occurs 2 times')
  })

  test('refuses an edit of the frontmatter', () => {
    const doc = state(markdownToYDoc('---\ntitle: Trip\n---\n\nBody.'))
    expect(() => documentEditUpdate(doc, { find: 'title: Trip', replacement: 'title: Tour' }))
      .toThrow('frontmatter')
  })

  test('answers null when nothing changes', () => {
    const doc = state(markdownToYDoc('Same.'))
    expect(documentEditUpdate(doc, { find: 'Same', replacement: 'Same' })).toBeNull()
    expect(documentEditUpdate(doc, { replacement: '  ' })).toBeNull()
  })

  // A block written by the engine's own Markdown projection can lack
  // attributes the editor schema defaults, such as an ordered list's start.
  // Reading it back fills the default in, and the edit must not write that
  // into a block it does not touch.
  test('leaves blocks outside the edit untouched when their stored attributes differ from the schema', () => {
    const doc = markdownToYDoc('1. one\n2. two\n\nEdit me.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
    const body = getDohcYDocBodyFragment(doc)
    const list = body.get(0) as Y.XmlElement
    list.removeAttribute('start')
    const table = body.get(2) as Y.XmlElement
    const cell = ((table.get(0) as Y.XmlElement).get(0) as Y.XmlElement)
    for (const name of Object.keys(cell.getAttributes())) cell.removeAttribute(name)
    const touched: string[] = []
    list.observeDeep(() => touched.push('list'))
    table.observeDeep(() => touched.push('table'))

    edited(doc, { find: 'Edit me.', replacement: 'Edited.' })

    expect(markdownOf(doc)).toContain('Edited.')
    expect(touched).toEqual([])
    expect(list.getAttribute('start')).toBeUndefined()
  })
})

describe('an edit merged with a person typing', () => {
  // The person's editor and the replica the edit reads start equal; each
  // then changes before seeing the other's change. The edit reaches both.
  function replicas(markdown: string): { person: Y.Doc; agent: Y.Doc } {
    const person = markdownToYDoc(markdown)
    const agent = new Y.Doc()
    Y.applyUpdate(agent, state(person))
    return { person, agent }
  }

  function typeAtEnd(doc: Y.Doc, blockIndex: number, text: string): Uint8Array {
    let update: Uint8Array | null = null
    const record = (next: Uint8Array) => { update = next }
    doc.on('update', record)
    const block = getDohcYDocBodyFragment(doc).get(blockIndex) as Y.XmlElement
    const run = block.get(0) as Y.XmlText
    run.insert(run.length, text)
    doc.off('update', record)
    return update!
  }

  function merge(markdown: string, blockIndex: number, typed: string, edit: DocumentEdit): string {
    const { person, agent } = replicas(markdown)
    const typing = typeAtEnd(person, blockIndex, typed)
    const update = documentEditUpdate(state(agent), edit)!
    Y.applyUpdate(person, update)
    Y.applyUpdate(agent, update)
    Y.applyUpdate(agent, typing)
    expect(markdownOf(agent)).toBe(markdownOf(person))
    return markdownOf(person)
  }

  test('keeps the person text in another block', () => {
    expect(merge(
      '# Plan\n\nPerson writes here.\n\nAgent edits here.',
      1,
      ' More from the person.',
      { find: 'Agent edits here.', replacement: 'Agent edited this.' },
    )).toBe('# Plan\n\nPerson writes here. More from the person.\n\nAgent edited this.')
  })

  test('keeps the person text in the block the agent edits', () => {
    expect(merge('Budget: 400 dollars for food', 0, ' and drinks', { find: '400', replacement: '450' }))
      .toBe('Budget: 450 dollars for food and drinks')
  })

  test('keeps the person text when the agent adds a section at the end', () => {
    expect(merge('Intro.\n\nLast paragraph.', 1, ' Still typing.', { replacement: '## Added\n\nBy the agent.' }))
      .toBe('Intro.\n\nLast paragraph. Still typing.\n\n## Added\n\nBy the agent.')
  })

  test('keeps the person text when the agent splits the block they type in', () => {
    const merged = merge('Budget: 400 dollars', 0, ' PERSON', {
      find: 'Budget: 400 dollars',
      replacement: 'Budget:\n\n400 dollars',
    })
    expect(merged).toContain('PERSON')
    expect(merged).toContain('400 dollars')
  })
})
