import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { getDohcYDocBodyFragment } from './body-fragment.js'
import { documentCreateUpdate, documentEditUpdate, documentMarkdown, type DocumentEdit } from './document-edit.js'
import { getDohcProseMirrorSchema, markdownToYDoc, plainTextToYDoc, yDocToMarkdown } from './import-export.js'

function edited(doc: Y.Doc, edit: DocumentEdit): Y.Doc {
  const update = documentEditUpdate(doc, edit)
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
    expect(documentMarkdown(doc)).toBe(markdown)
    expect(documentMarkdown(doc)).toBe(yDocToMarkdown(doc))
  })
})

describe('documentEditUpdate', () => {
  test('replaces text and leaves the other blocks as they were', () => {
    const doc = markdownToYDoc('# Kyoto\n\nDay one: temples.\n\nDay two: markets.')
    const body = getDohcYDocBodyFragment(doc)
    const [heading, , dayTwo] = body.toArray()

    edited(doc, { find: 'temples', replacement: 'temples and tea' })

    expect(documentMarkdown(doc)).toBe('# Kyoto\n\nDay one: temples and tea.\n\nDay two: markets.')
    expect(body.get(0)).toBe(heading)
    expect(body.get(2)).toBe(dayTwo)
  })

  test('adds a section written as Markdown', () => {
    const doc = markdownToYDoc('# Itinerary\n\n## Thursday\n\nFly home.')
    edited(doc, {
      find: 'Fly home.',
      replacement: 'Fly home.\n\n## Friday 14\n\n- Sleep\n- Unpack',
    })
    expect(documentMarkdown(doc)).toBe(
      '# Itinerary\n\n## Thursday\n\nFly home.\n\n## Friday 14\n\n- Sleep\n- Unpack',
    )
  })

  test('adds text at the end when there is nothing to find', () => {
    const doc = editorDoc([paragraph('Notes'), paragraph()])
    edited(doc, { replacement: '## Next\n\nCall the hotel.' })
    expect(documentMarkdown(doc)).toBe('Notes\n\n## Next\n\nCall the hotel.\n\n')
    // The empty paragraph that held the cursor is still the last block.
    const body = getDohcYDocBodyFragment(doc)
    expect(body.get(body.length - 1)?.toString()).toBe('<paragraph></paragraph>')
  })

  test('fills an empty document', () => {
    const doc = editorDoc([paragraph()])
    edited(doc, { replacement: 'First line.' })
    expect(documentMarkdown(doc)).toBe('First line.')
  })

  test('removes a block replaced with nothing', () => {
    const doc = markdownToYDoc('Keep.\n\nDrop this.\n\nKeep too.')
    edited(doc, { find: '\n\nDrop this.', replacement: '' })
    expect(documentMarkdown(doc)).toBe('Keep.\n\nKeep too.')
  })

  test('refuses text it cannot find once', () => {
    const doc = markdownToYDoc('Tea.\n\nTea.')
    expect(() => documentEditUpdate(doc, { find: 'Coffee', replacement: 'x' }))
      .toThrow('not in the document')
    expect(() => documentEditUpdate(doc, { find: 'Tea', replacement: 'x' }))
      .toThrow('occurs 2 times')
  })

  test('refuses an edit of the frontmatter', () => {
    const doc = markdownToYDoc('---\ntitle: Trip\n---\n\nBody.')
    expect(() => documentEditUpdate(doc, { find: 'title: Trip', replacement: 'title: Tour' }))
      .toThrow('frontmatter')
  })

  test('answers null when nothing changes', () => {
    const doc = markdownToYDoc('Same.')
    expect(documentEditUpdate(doc, { find: 'Same', replacement: 'Same' })).toBeNull()
    expect(documentEditUpdate(doc, { replacement: '  ' })).toBeNull()
  })

  test('edits a plain-text document', () => {
    const doc = plainTextToYDoc('line one\nline two')
    edited(doc, { find: 'two', replacement: '2' })
    edited(doc, { replacement: 'line three' })
    expect(documentMarkdown(doc)).toBe('line one\nline 2\nline three')
  })

  test('leaves the caller document unchanged', () => {
    const doc = markdownToYDoc('Before.')
    const state = Y.encodeStateVector(doc)
    expect(documentEditUpdate(doc, { find: 'Before', replacement: 'After' })).not.toBeNull()
    expect(Y.encodeStateVector(doc)).toEqual(state)
  })
})

describe('documentCreateUpdate', () => {
  test('writes the first text into a document with no blocks', () => {
    const doc = new Y.Doc()
    const update = documentCreateUpdate(doc, '# Kyoto\n\n- Day one\n- Day two')
    Y.applyUpdate(doc, update!)
    expect(documentMarkdown(doc)).toBe('# Kyoto\n\n- Day one\n- Day two')
    expect(yDocToMarkdown(doc)).toBe('# Kyoto\n\n- Day one\n- Day two')
  })

  test('refuses frontmatter, which would land as body blocks', () => {
    expect(() => documentCreateUpdate(new Y.Doc(), '---\ntitle: Trip\n---\n\nBody.'))
      .toThrow('without frontmatter')
  })
})

describe('an edit merged with a person typing', () => {
  // The person's editor and the replica the edit reads start equal; each
  // then changes before seeing the other's change. The edit reaches both.
  function replicas(markdown: string): { person: Y.Doc; agent: Y.Doc } {
    const person = markdownToYDoc(markdown)
    const agent = new Y.Doc()
    Y.applyUpdate(agent, Y.encodeStateAsUpdate(person))
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

  test('keeps the person text in another block', () => {
    const { person, agent } = replicas('# Plan\n\nPerson writes here.\n\nAgent edits here.')
    const typed = typeAtEnd(person, 1, ' More from the person.')
    const edit = documentEditUpdate(agent, { find: 'Agent edits here.', replacement: 'Agent edited this.' })!

    Y.applyUpdate(person, edit)
    Y.applyUpdate(agent, edit)
    Y.applyUpdate(agent, typed)

    const expected = '# Plan\n\nPerson writes here. More from the person.\n\nAgent edited this.'
    expect(documentMarkdown(person)).toBe(expected)
    expect(documentMarkdown(agent)).toBe(expected)
  })

  test('keeps the person text in the block the agent edits', () => {
    const { person, agent } = replicas('Budget: 400 dollars for food')
    const typed = typeAtEnd(person, 0, ' and drinks')
    const edit = documentEditUpdate(agent, { find: '400', replacement: '450' })!

    Y.applyUpdate(person, edit)
    Y.applyUpdate(agent, edit)
    Y.applyUpdate(agent, typed)

    expect(documentMarkdown(person)).toBe('Budget: 450 dollars for food and drinks')
    expect(documentMarkdown(agent)).toBe(documentMarkdown(person))
  })

  test('keeps the person text when the agent adds a section at the end', () => {
    const { person, agent } = replicas('Intro.\n\nLast paragraph.')
    const typed = typeAtEnd(person, 1, ' Still typing.')
    const edit = documentEditUpdate(agent, { replacement: '## Added\n\nBy the agent.' })!

    Y.applyUpdate(person, edit)
    Y.applyUpdate(agent, edit)
    Y.applyUpdate(agent, typed)

    expect(documentMarkdown(person)).toBe(
      'Intro.\n\nLast paragraph. Still typing.\n\n## Added\n\nBy the agent.',
    )
    expect(documentMarkdown(agent)).toBe(documentMarkdown(person))
  })
})
