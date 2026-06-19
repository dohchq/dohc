import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror'
import * as Y from 'yjs'
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  getDohcYDocPlainText,
  yDocToMarkdown,
  markdownToYDoc,
  plainTextToYDoc,
} from './import-export'

type ExpectedMarkdownFragment = string | RegExp

function yDocFromBody(content: JSONContent[]): Y.Doc {
  const doc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(
    getDohcProseMirrorSchema(),
    { type: 'doc', content },
    getDohcYDocBodyFragment(doc),
  )
  return doc
}

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

// The desktop editor's markdown round-trip is a VERBATIM copy of the live
// hocuspocus round-trip (schema parity is enforced by schema-parity.test.ts),
// so these mirror the server's import-export tests plus the editor-v2 corpus
// invariants the recon calls out (idempotency, frontmatter ordering, custom-
// node preservation). Inline fixtures keep the suite self-contained.
describe('desktop editor markdown round-trip', () => {
  it('keeps malformed frontmatter visible instead of dropping it', () => {
    const input = ['---', 'id: atom_1', 'bad: [unclosed', '---', '# Body'].join('\n')

    const doc = markdownToYDoc(input)
    const output = yDocToMarkdown(doc)

    expect(getDohcYDocFrontmatter(doc)).toEqual({})
    expect(output).toContain('id: atom_1')
    expect(output).toContain('bad: [unclosed')
    expect(output).toContain('# Body')
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

  it('keeps a blank separator between frontmatter and rich markdown body', () => {
    const input = ['---', 'id: note-1', '---', '', '# Plan'].join('\n')
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })

  it('is IDEMPOTENT: a second round-trip is a no-op (the byte-stable-on-disk gate)', () => {
    // The round-trip normalizes on the FIRST pass (list markers, escaping,
    // frontmatter key order) but must be stable thereafter — the desktop only
    // writes on real edits, so once === twice is what keeps disk bytes from
    // churning on every settle.
    const input = [
      '---',
      'title: Notes',
      'id: n1',
      'tags:',
      '  - a',
      '  - b',
      '---',
      '',
      '# Heading',
      '',
      'A paragraph with **bold** and a [[wiki/link|Label]] and an {rate: 150} atom.',
      '',
      '- one',
      '- two',
      '',
      '> a quote',
      '',
      '```ts',
      'const x = 1',
      '```',
    ].join('\n')

    const once = yDocToMarkdown(markdownToYDoc(input))
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('orders frontmatter id/title/icon first, then the rest alphabetically', () => {
    const input = [
      '---',
      'zeta: 1',
      'icon: star',
      'title: T',
      'alpha: 2',
      'id: the-id',
      '---',
      '',
      'body',
    ].join('\n')

    const output = yDocToMarkdown(markdownToYDoc(input))
    const keyOrder = output
      .split('\n')
      .filter((line) => /^[a-zA-Z]+:/.test(line))
      .map((line) => line.split(':')[0])
    expect(keyOrder).toEqual(['id', 'title', 'icon', 'alpha', 'zeta'])
  })

  it('preserves wikilinks and inline atoms across the round-trip (custom nodes)', () => {
    const output = yDocToMarkdown(
      markdownToYDoc('See [[notes/today|Today]] — budget {rate: 150} and {= a + b}.'),
    )
    expect(output).toContain('[[notes/today|Today]]')
    expect(output).toContain('{rate: 150}')
    expect(output).toContain('{= a + b}')
  })

  it('preserves task lists instead of degrading them to plain bullets', () => {
    const input = ['- [ ] write migration test', '- [x] keep checked item'].join('\n')
    const output = yDocToMarkdown(markdownToYDoc(input))
    expect(output).toContain('- [ ] write migration test')
    expect(output).toContain('- [x] keep checked item')
    expect(yDocToMarkdown(markdownToYDoc(output))).toBe(output)
  })

  it('exposes the body fragment (rich) and the plain-text field (plain) — the collab edit handles', () => {
    // The E4 collab rework binds Tiptap to the body XmlFragment and the server
    // migration reads the plainText Y.Text; these accessors are how each side
    // reaches the right field for a given content kind.
    const rich = markdownToYDoc('# Rich body\n')
    expect(getDohcYDocBodyFragment(rich).length).toBeGreaterThan(0)
    expect(getDohcYDocPlainText(rich)).toBeNull()

    const plain = plainTextToYDoc('plain body text')
    expect(getDohcYDocPlainText(plain)?.toString()).toBe('plain body text')
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
      // Backslashes in image attributes are escaped on serialization so
      // source meaning survives the rich editor round-trip.
      'Backslash image: ![diagram \\ one](assets\\diagram.png "Title \\ one").',
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
      '![diagram \\\\ one](assets\\\\diagram.png "Title \\\\ one")',
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

  it('escapes line breaks inside inline markdown node attributes', () => {
    const output = yDocToMarkdown(
      yDocFromBody([
        {
          type: 'paragraph',
          content: [
            {
              type: 'image',
              attrs: {
                alt: 'alt\ntext',
                src: 'assets/a\nb.png',
                title: 'title\r\nquote',
              },
            },
            { type: 'text', text: ' ' },
            { type: 'escapedPunctuation', attrs: { value: '\n' } },
          ],
        },
      ]),
    )

    expect(output).toBe(
      '![alt\\ntext](assets/a\\nb.png "title\\r\\nquote") \\\\n',
    )
  })

  it('strips unsafe image protocols while preserving http and relative images', () => {
    expectStableMarkdownRoundTrip(
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad](javascript:alert)',
        '![data](data:image/svg+xml;base64,PHN2Zz4=)',
      ].join('\n'),
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad]()',
        '![data]()',
      ],
    )
    expect(
      yDocToMarkdown(
        yDocFromBody([
          {
            type: 'paragraph',
            content: [
              {
                type: 'image',
                attrs: { alt: 'split', src: 'java\nscript:alert', title: null },
              },
            ],
          },
        ]),
      ),
    ).toBe('![split]()')
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
