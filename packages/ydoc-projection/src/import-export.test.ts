import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror'
import * as Y from 'yjs'
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  yDocToMarkdown,
  markdownToYDoc,
  plainTextToYDoc,
  serializeRichdocBody,
} from './import-export.js'

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

function yDocBodyJSON(doc: Y.Doc): JSONContent {
  return yXmlFragmentToProseMirrorRootNode(
    getDohcYDocBodyFragment(doc),
    getDohcProseMirrorSchema(),
  ).toJSON() as JSONContent
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

  it('preserves website source files as plain text instead of markdown prose', () => {
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

  it('preserves retired document-computation syntax as inert markdown', () => {
    const input = [
      'Retired expressions stay literal: {{formula:SUM(hours)}} and {= 1 + 2}.',
      '',
      '```query',
      'from tasks',
      '```',
      '',
      '```dohc-query',
      'sum(hours)',
      '```',
    ].join('\n')

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

  it('keeps a workspace-relative image byte-identical through the round-trip', () => {
    const input = '![alt](assets/pic.png "t")'
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    // And a second pass is stable.
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(input)
  })

  it('round-trips a relative image path containing spaces via angle brackets', () => {
    const input = '![alt](<my folder/pic 1.png>)'
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    // And a second pass is stable.
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(input)
  })

  it('strips unsafe image protocols while PRESERVING relative parent-traversal (lossless), http, and relative images', () => {
    expectStableMarkdownRoundTrip(
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad](javascript:alert)',
        '![case-variant](JavaScript:alert)',
        '![data](data:image/svg+xml;base64,PHN2Zz4=)',
        // CONTRACT: forward-slash `..` traversal is now preserved verbatim —
        // agents author upward-relative asset links (global-folder attachments).
        // Rendering containment lives in the resolver, not the sanitizer.
        '![parent](../secret/diagram.png)',
        '![escape](../../outside.png)',
        '![absolute](/etc/diagram.png)',
        '![protocol-relative](//evil.example.com/diagram.png)',
      ].join('\n'),
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad]()',
        '![case-variant]()',
        '![data]()',
        '![parent](../secret/diagram.png)',
        '![escape](../../outside.png)',
        '![absolute]()',
        '![protocol-relative]()',
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
    // Backslash traversal (a Windows-style `..\secret\pic.png`) stays BLOCKED:
    // backslashes are folded to '/' before the check and a `..` backslash path
    // is never legitimate authored markdown (unlike a forward-slash `../`,
    // which is now preserved above). Driven through the node attrs directly so
    // the raw backslashes reach the sanitizer verbatim.
    expect(
      yDocToMarkdown(
        yDocFromBody([
          {
            type: 'paragraph',
            content: [
              {
                type: 'image',
                attrs: { alt: 'backslash', src: '..\\secret\\pic.png', title: null },
              },
            ],
          },
        ]),
      ),
    ).toBe('![backslash]()')
  })

  // PARITY FIXTURE. sanitizeImageSrc is implemented TWICE — apps/desktop's
  // editor/extensions.ts and packages/ydoc-projection's
  // dohc-markdown-extensions.ts — because neither package may import the other.
  // This table is duplicated VERBATIM in the other package's import-export test
  // and is what keeps the two copies from drifting: any change to the image-src
  // contract has to change both implementations AND both tables, or one side
  // goes red. Driven through the node attrs (not markdown source) so each input
  // reaches the sanitizer exactly as written.
  const IMAGE_SRC_CONTRACT: ReadonlyArray<{ src: string; markdown: string }> = [
    // KEPT — relative asset paths (the ordinary case).
    { src: 'assets/pic.png', markdown: '![x](assets/pic.png)' },
    { src: './assets/pic.png', markdown: '![x](./assets/pic.png)' },
    // KEPT — forward-slash parent traversal, losslessly: the global-folder
    // attachment mode authors exactly this. Containment is downstream (the
    // resolver refuses to serve an escaping path; the export drops it).
    { src: '../assets/pic.png', markdown: '![x](../assets/pic.png)' },
    { src: '../../outside.png', markdown: '![x](../../outside.png)' },
    // KEPT — remote images.
    { src: 'https://example.com/x.png', markdown: '![x](https://example.com/x.png)' },
    { src: 'http://example.com/x.png', markdown: '![x](http://example.com/x.png)' },
    // DROPPED — every non-http(s) scheme, however obfuscated.
    { src: 'javascript:alert(1)', markdown: '![x]()' },
    { src: 'JavaScript:alert(1)', markdown: '![x]()' },
    { src: 'java\nscript:alert(1)', markdown: '![x]()' },
    { src: 'data:image/svg+xml;base64,PHN2Zz4=', markdown: '![x]()' },
    { src: 'file:///etc/passwd', markdown: '![x]()' },
    { src: 'dohc-file://ws/x.png', markdown: '![x]()' },
    // DROPPED — absolute and protocol-relative.
    { src: '/etc/pic.png', markdown: '![x]()' },
    { src: '//evil.example.com/x.png', markdown: '![x]()' },
    // DROPPED — backslash-obfuscated traversal (never authored markdown).
    { src: '..\\secret\\pic.png', markdown: '![x]()' },
    { src: 'a\\..\\..\\b.png', markdown: '![x]()' },
    // DROPPED — empty / whitespace-only.
    { src: '', markdown: '![x]()' },
    { src: '   ', markdown: '![x]()' },
  ]

  it('pins the image-src contract (parity fixture — duplicated in the sibling package)', () => {
    for (const { src, markdown } of IMAGE_SRC_CONTRACT) {
      expect(
        yDocToMarkdown(
          yDocFromBody([
            {
              type: 'paragraph',
              content: [{ type: 'image', attrs: { alt: 'x', src, title: null } }],
            },
          ]),
        ),
      ).toBe(markdown)
    }
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

  it('escapes literal table-cell pipes before computing column widths', () => {
    const doc = yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }],
              },
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Other' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'left | right' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'stable' }] }],
              },
            ],
          },
        ],
      },
    ])

    expect(yDocToMarkdown(doc)).toBe([
      '',
      '| Value         | Other  |',
      '| ------------- | ------ |',
      '| left \\| right | stable |',
    ].join('\n'))
  })

  it('promotes a headerless table first row instead of inserting a blank row', () => {
    const doc = yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'row' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'row' }] }],
              },
            ],
          },
        ],
      },
    ])

    expect(yDocToMarkdown(doc)).toBe([
      '',
      '| first  | row |',
      '| ------ | --- |',
      '| second | row |',
    ].join('\n'))
  })

  it('projects multi-block table cells with a GFM inline break and no controls', () => {
    const output = yDocToMarkdown(yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'H' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'first' }],
                },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'second' }],
                },
              ],
            }],
          },
        ],
      },
    ]))

    expect(output).toBe([
      '',
      '| H               |',
      '| --------------- |',
      '| first<br>second |',
    ].join('\n'))
    expect(output).not.toContain('\u001F')
    expect(output).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u)
  })

  it('round-trips per-column GFM alignment (left/center/right) losslessly', () => {
    // Phase 1 assumed per-column alignment was inexpressible; it is not. The
    // `align` cell attr (set by tableControls' column grip menu) serializes to
    // the delimiter row and parses back, so a mixed-alignment table — left
    // (`:---`), center (`:---:`), right (`---:`), and default (`---`) — is
    // byte-stable across the round-trip.
    const once = expectStableMarkdownRoundTrip(
      [
        '| L | C | R | D |',
        '| :--- | :---: | ---: | --- |',
        '| a | b | c | d |',
      ].join('\n'),
      ['| :--- | :---: | ---: | --- |'],
    )
    expect(once).toContain('| L')
    expect(once).toContain('| a')
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

  it('round-trips ordinary fenced code blocks without dropping them', () => {
    expectStableMarkdownRoundTrip(
      ['```js', 'const x = 1;', '```', '', '```', 'no language here', '```', ''].join('\n'),
      ['```js\nconst x = 1;\n```', 'no language here'],
    )
  })

  it('uses collision-free block and inline code delimiters', () => {
    const doc = yDocFromBody([
      {
        type: 'codeBlock',
        attrs: { language: 'js' },
        content: [{ type: 'text', text: 'before\n```\nafter' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a`b', marks: [{ type: 'code' }] },
          { type: 'text', text: ' / ' },
          { type: 'text', text: '`edge`', marks: [{ type: 'code' }] },
          { type: 'text', text: ' / ' },
          { type: 'text', text: ' spaced ', marks: [{ type: 'code' }] },
          { type: 'text', text: ' / ' },
          { type: 'text', text: '   ', marks: [{ type: 'code' }] },
        ],
      },
    ])

    expect(yDocToMarkdown(doc)).toBe([
      '````js',
      'before',
      '```',
      'after',
      '````',
      '',
      '``a`b`` / `` `edge` `` / `  spaced  ` / `   `',
    ].join('\n'))
  })

  it('keeps HTML-special characters raw inside inline code', () => {
    const markdown = 'Compare `<tag> && value > 1` without entity expansion.'
    expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
  })

  it.each([
    {
      context: 'the first block of a bullet item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [{ type: 'text', text: 'const bullet = true' }],
          }],
        }],
      }],
      markdown: ['- ```js', '  const bullet = true', '  ```'].join('\n'),
    },
    {
      context: 'the first block of an ordered item',
      content: [{
        type: 'orderedList',
        attrs: { start: 1 },
        content: [{
          type: 'listItem',
          content: [{
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [{ type: 'text', text: 'const ordered = true' }],
          }],
        }],
      }],
      markdown: ['1. ```js', '   const ordered = true', '   ```'].join('\n'),
    },
    {
      context: 'the first block of a nested list item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'parent' }],
            },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                content: [{
                  type: 'codeBlock',
                  attrs: { language: 'js' },
                  content: [{ type: 'text', text: 'const nested = true' }],
                }],
              }],
            },
          ],
        }],
      }],
      markdown: [
        '- parent',
        '  - ```js',
        '    const nested = true',
        '    ```',
      ].join('\n'),
    },
    {
      context: 'a blockquote',
      content: [{
        type: 'blockquote',
        content: [{
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'const quoted = true' }],
        }],
      }],
      markdown: ['> ```js', '> const quoted = true', '> ```'].join('\n'),
    },
    {
      context: 'a callout',
      content: [{
        type: 'callout',
        attrs: { calloutType: 'note', fold: '', title: 'Code' },
        content: [{
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'const callout = true' }],
        }],
      }],
      markdown: [
        '> [!note] Code',
        '> ```js',
        '> const callout = true',
        '> ```',
      ].join('\n'),
    },
    {
      context: 'the first block of a task item',
      content: [{
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: false },
          content: [{
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [{ type: 'text', text: 'const task = true' }],
          }],
        }],
      }],
      markdown: ['- [ ] ```js', '  const task = true', '  ```'].join('\n'),
    },
    {
      context: 'a later block of a list item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'introduction' }],
            },
            {
              type: 'codeBlock',
              attrs: { language: 'js' },
              content: [{ type: 'text', text: 'const later = true' }],
            },
          ],
        }],
      }],
      markdown: [
        '- introduction',
        '  ```js',
        '  const later = true',
        '  ```',
      ].join('\n'),
    },
    {
      context: 'a blockquote nested in a list item',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'quote' }],
            },
            {
              type: 'blockquote',
              content: [{
                type: 'codeBlock',
                attrs: { language: 'js' },
                content: [{ type: 'text', text: 'const nestedQuote = true' }],
              }],
            },
          ],
        }],
      }],
      markdown: [
        '- quote',
        '  > ```js',
        '  > const nestedQuote = true',
        '  > ```',
      ].join('\n'),
    },
  ])('round-trips fenced code inside $context without leaking sentinels', ({ content, markdown }) => {
    const once = serializeRichdocBody({ type: 'doc', content }).trimEnd()
    expect(once).toBe(markdown)
    expect(once).not.toContain('DOHC_CODE_BLOCK')
  })

  it.each([
    {
      value: 'left | right',
      markdown: [
        '| Value | Other |',
        '| ----- | ----- |',
        '| `left \\| right` | stable |',
      ].join('\n'),
    },
    {
      value: 'a`b | c',
      markdown: [
        '| Value | Other |',
        '| ----- | ----- |',
        '| ``a`b \\| c`` | stable |',
      ].join('\n'),
    },
  ])('round-trips inline code containing table pipes: $value', ({ markdown }) => {
    const once = yDocToMarkdown(markdownToYDoc(markdown))
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
    expect(once).toContain(markdown.split('\n')[2])

    const table = yDocBodyJSON(markdownToYDoc(once)).content?.[0]
    expect(table?.content?.[1].content).toHaveLength(2)
    expect(table?.content?.[1].content?.[0]).toMatchObject({
      content: [{
        content: [{
          type: 'text',
          text: markdown.includes('a`b') ? 'a`b | c' : 'left | right',
          marks: [{ type: 'code' }],
        }],
      }],
    })
  })

  it('projects many inline-code spans without leaking or corrupting reserved tokens', () => {
    const markdown = Array.from(
      { length: 500 },
      (_, index) => `span-${index}: \`value-${index}\``,
    ).join('\n\n')

    const once = yDocToMarkdown(markdownToYDoc(markdown))
    expect(once).toBe(markdown)
    expect(once).not.toContain('DOHC_INLINE_CODE')
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
  })

  it.each([
    {
      context: 'a bullet item',
      markdown: '- bullet ``a`b | c``',
    },
    {
      context: 'an ordered item',
      markdown: '1. ordered ``a`b | c``',
    },
    {
      context: 'a nested list item',
      markdown: ['- parent', '  - nested ``a`b | c``'].join('\n'),
    },
    {
      context: 'a blockquote',
      markdown: '> quote ``a`b | c``',
    },
    {
      context: 'a callout',
      markdown: ['> [!note] Inline', '> body ``a`b | c``'].join('\n'),
    },
    {
      context: 'a task item',
      markdown: '- [ ] task ``a`b | c``',
    },
    {
      context: 'a heading',
      markdown: '# heading ``a`b | c``',
    },
  ])('round-trips inline code inside $context without placeholder-sensitive output', ({ markdown }) => {
    const once = yDocToMarkdown(markdownToYDoc(markdown))
    expect(once).toBe(markdown)
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
  })

  it('preserves user private-use codepoints when reserving serialization sentinels', () => {
    const tableSentinel0 = String.fromCodePoint(0xF0000)
    const tableSentinel1 = String.fromCodePoint(0xF0001)
    const blockToken0 = '\uE000DOHC_CODE_BLOCK_0\uE001'
    const blockToken1 = '\uE000DOHC_CODE_BLOCK_1\uE001'
    const inlineToken3 = '\uE000DOHC_INLINE_CODE_3\uE001'
    const inlineToken4 = '\uE000DOHC_INLINE_CODE_4\uE001'
    const inlineEntitySentinels = '\uE002\uE003\uE004'
    const doc = yDocFromBody([
      {
        type: 'codeBlock',
        attrs: { language: 'txt' },
        content: [{ type: 'text', text: `${blockToken0} ${blockToken1}` }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{
                  type: 'paragraph',
                  content: [{
                    type: 'text',
                    text: `${tableSentinel0} | ${tableSentinel1}`,
                  }],
                }],
              },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [{
          type: 'text',
          text: `${inlineToken3} ${inlineToken4} ${inlineEntitySentinels} <&>`,
          marks: [{ type: 'code' }],
        }],
      },
    ])

    const markdown = yDocToMarkdown(doc)
    expect(markdown).toContain(`${blockToken0} ${blockToken1}`)
    expect(markdown).toContain(`${tableSentinel0} \\| ${tableSentinel1}`)
    expect(markdown).toContain(
      `\`${inlineToken3} ${inlineToken4} ${inlineEntitySentinels} <&>\``,
    )
    expect(markdown).not.toContain(String.fromCodePoint(0xF0002))
  })

  it('round-trips Obsidian callouts across every core type, fold flag, and title state', () => {
    const once = expectStableMarkdownRoundTrip(
      [
        '> [!note] Titled note',
        '> note body',
        '',
        '> [!tip]',
        '> untitled tip body',
        '',
        '> [!info]+ Explicitly open',
        '> info body',
        '',
        '> [!warning]- Folded warning',
        '> hidden until expanded',
        '',
        '> [!danger] Danger zone',
        '> danger body',
        '',
        '> [!quote] A quote callout',
        '> quoted body',
      ].join('\n'),
      [
        '> [!note] Titled note',
        '> [!tip]',
        '> [!info]+ Explicitly open',
        '> [!warning]- Folded warning',
        '> [!danger] Danger zone',
        '> [!quote] A quote callout',
        '> hidden until expanded',
      ],
    )
    expect(once).toContain('> untitled tip body')
  })

  it('preserves unknown callout types verbatim instead of dropping them', () => {
    expectStableMarkdownRoundTrip(
      ['> [!custom-thing]- Secret label', '> body text'].join('\n'),
      ['> [!custom-thing]- Secret label', '> body text'],
    )
  })

  it('preserves callout titles that contain brackets', () => {
    expectStableMarkdownRoundTrip(
      ['> [!note] Title with ] bracket', '> body'].join('\n'),
      ['> [!note] Title with ] bracket'],
    )
  })

  it('round-trips callouts that contain lists and code blocks', () => {
    expectStableMarkdownRoundTrip(
      [
        '> [!info] With blocks',
        '> - first',
        '> - second',
        '>',
        '> ```ts',
        '> const x = 1',
        '> ```',
      ].join('\n'),
      [
        '> [!info] With blocks',
        '> - first',
        '> - second',
        '> ```ts',
        '> const x = 1',
        '> ```',
      ],
    )
  })

  it('leaves a plain blockquote (no callout header) as an ordinary blockquote', () => {
    const once = expectStableMarkdownRoundTrip(
      ['> just a quote', '> second line'].join('\n'),
      ['> just a quote', '> second line'],
    )
    expect(once).not.toContain('[!')
  })

  it('round-trips ==highlight== including adjacent and nested marks', () => {
    const once = expectStableMarkdownRoundTrip(
      'Plain ==highlighted== then ==one== ==two== adjacent, plus **==bold highlight==** and ==**inner bold**==.',
      ['==highlighted==', '==one==', '==two=='],
    )
    expect(once).toContain('bold highlight')
    expect(once).toContain('inner bold')
  })

  it('does not fire highlight on stray or spaced equals', () => {
    expectStableMarkdownRoundTrip(
      'Prose a == b stays literal and a lone = sign too.',
      ['a == b stays literal'],
    )
  })

  it('round-trips a callout nested inside a list item without dropping it', () => {
    const input = ['- item', '  > [!note] In list', '  > body'].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('keeps a list item and a following callout distinct (nested callout survives)', () => {
    const input = [
      '- item',
      '  > [!note] In list',
      '  > body',
      '',
      '- second',
    ].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    // The blank line between tight list items normalizes away, but the nested
    // callout and both list items survive, and the result is idempotent.
    expect(once).toContain('> [!note] In list')
    expect(once).toContain('> body')
    expect(once).toContain('- item')
    expect(once).toContain('- second')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('emits a title-only callout without a stray trailing > line', () => {
    expect(yDocToMarkdown(markdownToYDoc('> [!note] Just a title'))).toBe(
      '> [!note] Just a title',
    )
    expect(yDocToMarkdown(markdownToYDoc('> [!tip]'))).toBe('> [!tip]')
    expect(yDocToMarkdown(markdownToYDoc('> [!warning]- Folded title'))).toBe(
      '> [!warning]- Folded title',
    )
  })

  it('absorbs a lazy-continuation line into the callout instead of reflowing it out', () => {
    const input = ['> [!note] Title', '> first line', 'lazy continuation'].join(
      '\n',
    )
    const once = yDocToMarkdown(markdownToYDoc(input))
    // First pass normalizes the lazy line to a `>`-prefixed body line inside the
    // callout (rather than reflowing it into a separate paragraph)...
    expect(once).toBe(
      ['> [!note] Title', '> first line', '> lazy continuation'].join('\n'),
    )
    // ...and the normalized form is byte-stable thereafter.
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('losslessly round-trips a highlight applied over text containing ==', () => {
    const highlighted = (text: string): Y.Doc =>
      yDocFromBody([
        {
          type: 'paragraph',
          content: [{ type: 'text', text, marks: [{ type: 'highlight' }] }],
        },
      ])
    // The concrete escaped form is unambiguous and reversible.
    expect(yDocToMarkdown(highlighted('a==b'))).toBe('==a\\=\\=b==')
    // A lone `=` adjacent to the closing delimiter must also be escaped, or the
    // mark would close one char early (`==a=` → `==a===`).
    expect(yDocToMarkdown(highlighted('a='))).toBe('==a\\===')
    for (const text of [
      'a==b',
      'a ==b== c',
      'a==b==c',
      '==edge==',
      'trailing==',
      'x = y',
      'a=',
      '=lead',
      'a=b=',
      'plain',
    ]) {
      const once = yDocToMarkdown(highlighted(text))
      const twice = yDocToMarkdown(markdownToYDoc(once))
      expect(twice, `text=${JSON.stringify(text)}`).toBe(once)
      // The highlight is preserved as a single `==...==` span, never split.
      expect(once.startsWith('=='), `text=${JSON.stringify(text)}`).toBe(true)
      expect(once.endsWith('=='), `text=${JSON.stringify(text)}`).toBe(true)
    }
  })

  it('keeps adversarial raw == sequences literal and byte-stable', () => {
    for (const input of ['==a ==b== c==', 'a ==b==c== d', '==x==y==z==']) {
      const once = yDocToMarkdown(markdownToYDoc(input))
      expect(once, `input=${JSON.stringify(input)}`).toBe(input)
      const twice = yDocToMarkdown(markdownToYDoc(once))
      expect(twice, `input=${JSON.stringify(input)}`).toBe(once)
    }
  })

  it('round-trips inline $...$ TeX math byte-for-byte', () => {
    const input = 'Euler: $e^{i\\pi} + 1 = 0$ is neat.'
    const once = expectStableMarkdownRoundTrip(input, ['$e^{i\\pi} + 1 = 0$'])
    expect(once).toBe(input)
  })

  it('round-trips a single-line $$...$$ block byte-for-byte', () => {
    const input = '$$E = mc^2$$'
    const once = expectStableMarkdownRoundTrip(input, ['$$E = mc^2$$'])
    expect(once).toBe(input)
  })

  it('round-trips a multi-line $$...$$ block byte-for-byte', () => {
    const input = [
      '$$',
      '\\sum_{i=0}^n i = \\frac{n(n+1)}{2}',
      'E = mc^2',
      '$$',
    ].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe(input)
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('escapes wikilink delimiters in a mention label so it round-trips', () => {
    const doc = yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'wikilink',
            attrs: { target: 'notes/plan', label: 'Plan ]] Draft | v2' },
          },
        ],
      },
    ])
    // `]` and `|` in the label are backslash-escaped so the closing `]]` and the
    // target/label separator aren't matched early.
    const once = yDocToMarkdown(doc)
    expect(once).toBe('[[notes/plan|Plan \\]\\] Draft \\| v2]]')
    // Re-parsing unescapes the label and re-serializing reproduces it verbatim
    // (a truncated re-parse would drop the tail and diverge here).
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('round-trips an empty $$$$ block', () => {
    const input = '$$$$'
    const once = expectStableMarkdownRoundTrip(input, ['$$$$'])
    expect(once).toBe(input)
  })

  it('keeps escaped \\$ literal instead of opening math', () => {
    const input = 'Price is \\$5 and \\$6 today.'
    const once = expectStableMarkdownRoundTrip(input, ['\\$5', '\\$6'])
    expect(once).toBe(input)
  })

  it('does not fire inline math on prose dollar amounts like $5 and $6', () => {
    const input = 'I have $5 and $6 in my wallet.'
    const once = expectStableMarkdownRoundTrip(input, ['$5 and $6'])
    expect(once).toBe(input)
  })

  it('round-trips inline math adjacent to marks', () => {
    // A mark that WRAPS a childless inline atom is dropped by the base markdown
    // manager (applyMarkToContent only attaches marks to text nodes) — this is
    // shared by every inline atom (image, inlineAtom, wikilink), not a
    // math quirk. Marks ADJACENT to math round-trip cleanly, which is the case
    // that matters in practice.
    const input = 'Adjacent **bold** and $x^2$ and *emphasis* stay put.'
    const once = expectStableMarkdownRoundTrip(input, [
      '**bold**',
      '$x^2$',
      '*emphasis*',
    ])
    expect(once).toBe(input)
  })

  it('leaves a mid-paragraph $$x$$ with trailing text literal', () => {
    const input = 'inline $$x$$ trailing stays literal'
    const once = expectStableMarkdownRoundTrip(input, ['$$x$$ trailing'])
    expect(once).toBe(input)
  })

  it('detects a mid-line wikilink whose label contains an escaped delimiter', () => {
    const doc = yDocFromBody([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'wikilink', attrs: { target: 'notes/plan', label: 'Plan ]] Draft' } },
          { type: 'text', text: ' here' },
        ],
      },
    ])
    const once = yDocToMarkdown(doc)
    expect(once).toBe('See [[notes/plan|Plan \\]\\] Draft]] here')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('does not absorb text after a fenced code block inside a callout', () => {
    const input = ['> [!note]', '> ```', '> code', '> ```', 'outside'].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    // `outside` is a plain top-level paragraph, not a lazy `>`-prefixed body line.
    expect(once).toMatch(/^outside$/m)
    expect(once).not.toContain('> outside')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })

  it('does not absorb text after a heading inside a callout', () => {
    const input = ['> [!note]', '> # Section', 'outside'].join('\n')
    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toMatch(/^outside$/m)
    expect(once).not.toContain('> outside')
    const twice = yDocToMarkdown(markdownToYDoc(once))
    expect(twice).toBe(once)
  })
})
