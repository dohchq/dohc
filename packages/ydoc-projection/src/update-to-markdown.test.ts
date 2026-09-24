import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  getDohcYDocFrontmatter,
  markdownToYDoc,
  updateYDocToMarkdown,
  yDocToMarkdown,
} from './import-export.js'
import { getDohcYDocBodyFragment } from './body-fragment.js'

const base = '# Plan\n\nFirst paragraph.\n\nSecond paragraph.'

function paragraphText(doc: Y.Doc, index: number): Y.XmlText {
  const block = getDohcYDocBodyFragment(doc).get(index) as Y.XmlElement
  return block.get(0) as Y.XmlText
}

// Two replicas of one document, as the editor and the engine hold it.
function replicas(markdown: string): [Y.Doc, Y.Doc] {
  const first = markdownToYDoc(markdown)
  const second = new Y.Doc()
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
  return [first, second]
}

function exchange(left: Y.Doc, right: Y.Doc): void {
  const toRight = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right))
  const toLeft = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left))
  Y.applyUpdate(right, toRight)
  Y.applyUpdate(left, toLeft)
}

describe('updateYDocToMarkdown', () => {
  it('projects the new markdown and keeps the blocks it did not change', () => {
    const doc = markdownToYDoc(base)
    const untouched = getDohcYDocBodyFragment(doc).get(1)
    updateYDocToMarkdown(doc, '# Plan\n\nFirst paragraph.\n\nSecond paragraph, **rewritten**.')
    expect(yDocToMarkdown(doc)).toBe('# Plan\n\nFirst paragraph.\n\nSecond paragraph, **rewritten**.')
    expect(getDohcYDocBodyFragment(doc).get(1)).toBe(untouched)
  })

  it('keeps typing another replica made at the same time in an untouched block', () => {
    const [editor, engine] = replicas(base)
    const typing = paragraphText(editor, 1)
    typing.insert(typing.length, ' Typed meanwhile.')
    updateYDocToMarkdown(engine, '# Plan\n\nFirst paragraph.\n\nSecond paragraph, rewritten.')
    exchange(editor, engine)
    const expected = '# Plan\n\nFirst paragraph. Typed meanwhile.\n\nSecond paragraph, rewritten.'
    expect(yDocToMarkdown(editor)).toBe(expected)
    expect(yDocToMarkdown(engine)).toBe(expected)
  })

  it('keeps typing another replica made at the same time inside the changed block', () => {
    const [editor, engine] = replicas(base)
    const typing = paragraphText(editor, 2)
    typing.insert(typing.length, ' Typed meanwhile.')
    updateYDocToMarkdown(engine, '# Plan\n\nFirst paragraph.\n\nThe second paragraph.')
    exchange(editor, engine)
    expect(yDocToMarkdown(editor)).toBe(yDocToMarkdown(engine))
    expect(yDocToMarkdown(editor)).toContain('The second paragraph.')
    expect(yDocToMarkdown(editor)).toContain('Typed meanwhile.')
  })

  it('updates frontmatter and line endings', () => {
    const doc = markdownToYDoc('---\ntitle: A\nkeep: 1\n---\n\nBody')
    updateYDocToMarkdown(doc, '---\r\ntitle: B\r\nkeep: 1\r\ntags:\r\n  - x\r\n---\r\n\r\nBody\r\n')
    expect(getDohcYDocFrontmatter(doc)).toEqual({ keep: 1, tags: ['x'], title: 'B' })
    expect(yDocToMarkdown(doc)).toBe(
      yDocToMarkdown(markdownToYDoc('---\r\ntitle: B\r\nkeep: 1\r\ntags:\r\n  - x\r\n---\r\n\r\nBody\r\n')),
    )
    updateYDocToMarkdown(doc, 'Body')
    expect(getDohcYDocFrontmatter(doc)).toEqual({})
    expect(yDocToMarkdown(doc)).toBe('Body')
  })
})
