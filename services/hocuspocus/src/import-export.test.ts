import { describe, expect, it } from 'vitest'
import {
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  yDocToMarkdown,
  markdownToYDoc,
  plainTextToYDoc,
} from './import-export.js'

describe('hocuspocus markdown import/export', () => {
  it('keeps malformed frontmatter visible instead of dropping it', () => {
    const input = [
      '---',
      'id: atom_1',
      'bad: [unclosed',
      '---',
      '# Body',
    ].join('\n')

    const doc = markdownToYDoc(input)
    const output = yDocToMarkdown(doc)

    expect(getDohcYDocFrontmatter(doc)).toEqual({})
    expect(output).toContain('id: atom_1')
    expect(output).toContain('bad: [unclosed')
    expect(output).toContain('# Body')
  })

  it('keeps scalar and array frontmatter-looking blocks visible', () => {
    for (const [input, content] of [
      [['---', 'just a divider', '---', '# Body'].join('\n'), 'just a divider'],
      [['---', 'null', '---', '# Body'].join('\n'), 'null'],
      [['---', '- one', '---', '# Body'].join('\n'), '- one'],
    ] as const) {
      const doc = markdownToYDoc(input)
      const output = yDocToMarkdown(doc)

      expect(getDohcYDocFrontmatter(doc)).toEqual({})
      expect(output).toContain(content)
      expect(output).toContain('---')
      expect(output).toContain('# Body')
    }
  })

  it('imports query and dohc-query fences with info strings as query blocks', () => {
    const output = yDocToMarkdown(
      markdownToYDoc(
        [
          '```query render="text"',
          'tasks.list("open")',
          '```',
          '',
          '```dohc-query theme="dark"',
          'tasks.list("closed")',
          '```',
        ].join('\n'),
      ),
    )

    expect(output).toContain('```dohc-query render="text"')
    expect(output).toContain('```dohc-query theme="dark"')
  })

  it('preserves view source files as plain text instead of markdown prose', () => {
    const input = [
      '---',
      'id: views.workspace.src.app',
      '---',
      '',
      'import React from "react"',
      '',
      'export default function App() {',
      '  return <main>{items.map((item) => <span>{item}</span>)}</main>',
      '}',
    ].join('\n')

    const doc = plainTextToYDoc(input)
    const output = yDocToMarkdown(doc)

    expect(getDohcYDocMeta(doc)).toMatchObject({ contentKind: 'plain-text' })
    expect(output).toBe(input)
  })

  it('keeps an existing blank separator between frontmatter and rich markdown body', () => {
    const input = ['---', 'id: note-1', '---', '', '', '# Plan'].join('\n')
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })

  it('preserves task lists instead of degrading them to plain bullets', () => {
    const input = ['- [ ] migrate rich collab', '- [x] keep checked state'].join('\n')
    const output = yDocToMarkdown(markdownToYDoc(input))
    expect(output).toContain('- [ ] migrate rich collab')
    expect(output).toContain('- [x] keep checked state')
    expect(yDocToMarkdown(markdownToYDoc(output))).toBe(output)
  })
})
