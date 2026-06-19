import { describe, expect, it } from 'vitest'
import {
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  yDocToMarkdown,
  markdownToYDoc,
  plainTextToYDoc,
} from './import-export.js'

type ExpectedMarkdownFragment = string | RegExp

function expectStableMarkdownRoundTrip(
  input: string,
  expectedFragments: ExpectedMarkdownFragment[],
): string {
  const once = yDocToMarkdown(markdownToYDoc(input))
  const twice = yDocToMarkdown(markdownToYDoc(once))
  expect(twice).toBe(once)
  for (const fragment of expectedFragments) {
    if (typeof fragment === 'string') {
      expect(once).toContain(fragment)
    } else {
      expect(once).toMatch(fragment)
    }
  }
  return once
}

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

  it('covers CommonMark block and inline constructs without semantic loss', () => {
    const input = [
      '# ATX heading',
      '',
      'Setext heading',
      '--------------',
      '',
      '---',
      '',
      '> Quote level one',
      '>',
      '> - quoted bullet',
      '',
      '1. ordered',
      '2. ordered again',
      '   - nested bullet',
      '',
      'A paragraph with **bold**, *emphasis*, ***both***, `code`,',
      '[a link](https://example.com), and ![diagram](assets/diagram.png "Architecture").',
      '',
      '```ts',
      'const answer = 42',
      '```',
    ].join('\n')

    expectStableMarkdownRoundTrip(input, [
      '# ATX heading',
      '## Setext heading',
      '---',
      '> Quote level one',
      '> - quoted bullet',
      '1. ordered',
      '2. ordered again',
      '- nested bullet',
      '**bold**',
      '*emphasis*',
      '***both***',
      '`code`',
      '[a link](https://example.com)',
      '![diagram](assets/diagram.png "Architecture")',
      '```ts\nconst answer = 42\n```',
    ])
  })

  it('preserves CommonMark escaped punctuation instead of dropping literal characters', () => {
    expectStableMarkdownRoundTrip(
      [
        '\\# not a heading',
        '1\\. not an ordered list',
        '\\* not a bullet',
        'literal \\*not emphasis* and \\[not a link](/somewhere)',
        '\\`not code`',
      ].join('\n'),
      [
        '\\# not a heading',
        '1\\. not an ordered list',
        '\\* not a bullet',
        'literal \\*not emphasis*',
        '\\[not a link](/somewhere)',
        '\\`not code`',
      ],
    )
  })

  it('covers GFM tables, task lists, and strikethrough', () => {
    expectStableMarkdownRoundTrip(
      [
        '| Metric | Value |',
        '| --- | ---: |',
        '| apples | 10 |',
        '| oranges | 2 |',
        '',
        '- [ ] write the migration',
        '- [x] keep completed work visible',
        '',
        '~~obsolete note~~',
      ].join('\n'),
      [
        '| Metric  | Value |',
        '| ------- | -----: |',
        '| apples  | 10    |',
        '| oranges | 2     |',
        '- [ ] write the migration',
        '- [x] keep completed work visible',
        '~~obsolete note~~',
      ],
    )
  })

  it('keeps Obsidian-style power-user syntax stable as text or custom nodes', () => {
    expectStableMarkdownRoundTrip(
      [
        '---',
        'tags:',
        '  - alpha/beta',
        'aliases:',
        '  - Today',
        '---',
        '',
        '# Daily note',
        '',
        'See [[Projects/dohc#Graph view|graph plan]] and [[Notes/Ideas#^block-ref]].',
        'Embed stays visible: ![[assets/chart.png]].',
        '',
        '> [!note]+ Launch callout',
        '> Body with #work/deep and ==highlighted text==.',
        '',
        '%% private drafting note %%',
        '',
        'Footnote ref[^1].',
        '',
        '[^1]: Footnote body.',
      ].join('\n'),
      [
        'aliases:\n  - Today',
        'tags:\n  - alpha/beta',
        '[[Projects/dohc#Graph view|graph plan]]',
        '[[Notes/Ideas#^block-ref]]',
        '![[assets/chart.png]]',
        '> [!note]+ Launch callout',
        '#work/deep',
        '==highlighted text==',
        '%% private drafting note %%',
        'Footnote ref[^1].',
        '[^1]: Footnote body.',
      ],
    )
  })
})
