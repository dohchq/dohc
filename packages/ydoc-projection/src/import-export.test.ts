import { describe, expect, it, vi } from 'vitest'
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

describe('Y.Doc markdown import/export', () => {
  it('keeps comment-only frontmatter empty under the js-yaml 5 parser', () => {
    const input = ['---', '# metadata', '', '---', '# Body'].join('\n')
    const doc = markdownToYDoc(input)

    expect(getDohcYDocFrontmatter(doc)).toEqual({})
    expect(yDocToMarkdown(doc)).toBe('# Body')
  })

  it('keeps literal punctuation and explicit escapes byte-stable', () => {
    const input = 'internal_name [label] and \\*literal asterisks\\*'
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })

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

  it('decodes numeric block entities once without changing code', () => {
    expectStableMarkdownRoundTrip(
      'literal &amp;#35; and `&#35;`',
      ['literal &amp;#35; and `&#35;`'],
    )
  })

  it('decodes encoded ampersands once without changing code content', () => {
    for (const encoded of ['&#38;#35;', '&AMP;#35;']) {
      const doc = markdownToYDoc(`literal ${encoded}`)
      expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
        .toBe('literal &#35;')
      expect(yDocToMarkdown(doc)).toBe('literal &amp;#35;')
    }

    expectStableMarkdownRoundTrip(
      '`&#38;#35;` and `&AMP;#35;`',
      ['`&#38;#35;` and `&AMP;#35;`'],
    )
    expectStableMarkdownRoundTrip(
      '```txt\n&#38;#35;\n&AMP;#35;\n&#35;\n```',
      ['&#38;#35;', '&AMP;#35;', '&#35;'],
    )
  })

  it('leaves Markdown-escaped entity ampersands for the parser', () => {
    for (const [markdown, tail] of [
      [String.raw`\&#35;`, '#35;'],
      [String.raw`\&amp;#35;`, 'amp;#35;'],
    ]) {
      const doc = markdownToYDoc(markdown)
      expect(yDocBodyJSON(doc).content?.[0]?.content).toMatchObject([
        { type: 'escapedPunctuation', attrs: { value: '&' } },
        { type: 'text', text: tail },
      ])
      expect(yDocToMarkdown(doc)).toBe(markdown)
      expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
    }

    expect(yDocToMarkdown(markdownToYDoc(String.raw`\\&#35;`)))
      .toBe(String.raw`\\#`)
    expect(yDocToMarkdown(markdownToYDoc(String.raw`\\&amp;#35;`)))
      .toBe(String.raw`\\&amp;#35;`)
  })

  it('matches the locked parser numeric-reference digit limits', () => {
    for (const encoded of ['&#0000038;#35;', '&#x000026;#35;']) {
      const doc = markdownToYDoc(`literal ${encoded}`)
      expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
        .toBe('literal &#35;')
    }

    for (const encoded of ['&#00000038;#35;', '&#x0000026;#35;']) {
      const doc = markdownToYDoc(`literal ${encoded}`)
      expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
        .toBe(`literal ${encoded}`)
    }
  })

  it('does not reuse a sentinel produced by a numeric reference', () => {
    const doc = markdownToYDoc('protected &#35; literal &#57346;')

    expect(yDocBodyJSON(doc).content?.[0]?.content?.[0]?.text)
      .toBe('protected # literal &#57346;')
  })

  it('preserves protected entities inside angle autolinks', () => {
    const url = 'https://example.test/a&#35;b'
    const body = yDocBodyJSON(markdownToYDoc(`<${url}>`))
    const text = body.content?.[0]?.content?.[0]

    expect(text?.text).toBe(url)
    expect(text?.marks?.find(mark => mark.type === 'link')?.attrs?.href).toBe(url)
    expect(yDocToMarkdown(markdownToYDoc(`<${url}>`))).toContain('&#35;')
  })

  it('decodes protected entities outside actual angle autolinks', () => {
    const encodedUrl = 'https://example.test/a&#35;b'
    const decodedUrl = 'https://example.test/a#b'
    const link = yDocBodyJSON(markdownToYDoc(`[label](<${encodedUrl}>)`))
    expect(link.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.href)
      .toBe(decodedUrl)

    const image = yDocBodyJSON(markdownToYDoc(`![alt](<${encodedUrl}>)`))
    expect(image.content?.find(node => node.type === 'image')?.attrs?.src)
      .toBe(decodedUrl)

    const title = yDocBodyJSON(markdownToYDoc(
      `[label](https://example.test "<${encodedUrl}>")`,
    ))
    expect(title.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.title)
      .toBe(`<${decodedUrl}>`)

    const identicalLabel = yDocBodyJSON(markdownToYDoc(
      `[${encodedUrl}](${encodedUrl})`,
    ))
    const identicalText = identicalLabel.content?.[0]?.content?.[0]
    expect(identicalText?.text).toBe(decodedUrl)
    expect(identicalText?.marks?.[0]?.attrs?.href).toBe(decodedUrl)

    const equalTextAndHref = yDocBodyJSON(markdownToYDoc(
      '[https://example.test](https://example.test "title &#35;")',
    ))
    expect(equalTextAndHref.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.title)
      .toBe('title #')

    const escaped = yDocBodyJSON(markdownToYDoc(`\\<${encodedUrl}>`))
    expect(JSON.stringify(escaped)).toContain(encodedUrl)
  })

  it('preserves protected entities in bare GFM autolinks', () => {
    const url = 'www.example.test/a&#35;b'
    const body = yDocBodyJSON(markdownToYDoc(url))
    const text = body.content?.[0]?.content?.[0]

    expect(text?.text).toBe(url)
    expect(text?.marks?.[0]?.attrs?.href).toBe(`http://${url}`)
  })

  it('reserves an entity sentinel when the source uses every BMP private-use character', () => {
    const privateUse = Array.from(
      { length: 0xF8FF - 0xE002 + 1 },
      (_, index) => String.fromCodePoint(0xE002 + index),
    ).join('')
    const body = yDocBodyJSON(markdownToYDoc(`${privateUse}&#35;`))

    expect(body.content?.[0]?.content?.map(node => node.text ?? '').join(''))
      .toBe(`${privateUse}#`)

    const sourceToken = '\uE000DOHC_PARSE_0\uE001'
    const collision = yDocBodyJSON(markdownToYDoc(`${sourceToken}&#35;`))
    expect(collision.content?.[0]?.content?.map(node => node.text ?? '').join(''))
      .toBe(`${sourceToken}#`)
  })

  it('serializes protected characters when the Y.Doc uses every BMP private-use character', () => {
    const privateUse = Array.from(
      { length: 0xF8FF - 0xE002 + 1 },
      (_, index) => String.fromCodePoint(0xE002 + index),
    ).join('')
    const markdown = yDocToMarkdown(yDocFromBody([{
      type: 'paragraph',
      content: [{ type: 'text', text: `${privateUse}*` }],
    }]))

    expect(markdown).toContain(privateUse)
    expect(markdown).not.toContain('DOHCCHARACTER')
  })

  it('keeps leading-whitespace entities literal inside code', () => {
    const inline = markdownToYDoc('`before\n&#32;space\n&#9;tab`')
    expect(yDocBodyJSON(inline).content?.[0]?.content?.[0]?.text)
      .toContain('&#32;space')
    expect(yDocBodyJSON(inline).content?.[0]?.content?.[0]?.text)
      .toContain('&#9;tab')

    const fenced = markdownToYDoc(
      '```txt\n&#32;space\n&#9;tab\n```',
    )
    expect(yDocBodyJSON(fenced).content?.[0]?.content?.[0]?.text)
      .toBe('&#32;space\n&#9;tab')
    expectStableMarkdownRoundTrip(
      '```txt\n&#32;space\n&#9;tab\n```',
      ['&#32;space', '&#9;tab'],
    )
  })

  it('restores parse sentinels in node and mark attributes', () => {
    const doc = markdownToYDoc([
      '[link](https://example.com/a&#35;b "title &#38;#35;")',
      '',
      '![image](assets/a&#35;b.png "image &AMP;#35;")',
      '',
      'inline $x=&#35;1$ and $y=&#38;#35;2$',
      '',
      '$$x=&#35;1$$',
      '',
      '$$y=&#38;#35;2$$',
      '',
      '```lang&#35;',
      'raw entity',
      '```',
      '',
      '```lang&#38;#35;',
      'encoded ampersand',
      '```',
    ].join('\n'))
    const body = yDocBodyJSON(doc)
    const link = body.content?.[0]?.content?.[0]?.marks
      ?.find(mark => mark.type === 'link')
    expect(link?.attrs).toMatchObject({
      href: 'https://example.com/a#b',
      title: 'title &#35;',
    })
    const image = body.content?.find(node => node.type === 'image')
    expect(image?.attrs).toMatchObject({
      src: 'assets/a#b.png',
      title: 'image &#35;',
    })
    const inlineMath = body.content?.[2]?.content
      ?.filter(node => node.type === 'mathInline')
    expect(inlineMath?.map(node => node.attrs?.tex)).toEqual([
      'x=&#35;1',
      'y=&#38;#35;2',
    ])
    const blockMath = body.content?.filter(node => node.type === 'mathBlock')
    expect(blockMath?.map(node => node.attrs?.tex)).toEqual([
      'x=&#35;1',
      'y=&#38;#35;2',
    ])
    const codeBlocks = body.content?.filter(node => node.type === 'codeBlock')
    expect(codeBlocks?.map(node => node.attrs?.language)).toEqual([
      'lang&#35;',
      'lang&#38;#35;',
    ])
    expect(yDocToMarkdown(doc)).toContain('```lang&#35;\nraw entity\n```')
    expect(yDocToMarkdown(doc)).toContain('```lang&#38;#35;\nencoded ampersand\n```')
    expect(JSON.stringify(body)).not.toMatch(/[\uE002-\uF8FF]/u)
  })

  it('keeps block-escape entities literal in raw custom-node attributes', () => {
    const markdown = [
      '[[foo&#35;bar|label &#38;#35;]]',
      '',
      '{{atom:one&#35;two mode=&#38;#35;}}',
      '',
      '> [!note&#35;kind] Title &#38;#35;',
      '> body',
    ].join('\n')
    const body = yDocBodyJSON(markdownToYDoc(markdown))

    expect(body.content?.[0]?.content?.[0]).toMatchObject({
      type: 'wikilink',
      attrs: {
        target: 'foo&#35;bar',
        label: 'label &#38;#35;',
      },
    })
    expect(body.content?.[1]?.content?.[0]).toMatchObject({
      type: 'inlineAtom',
      attrs: {
        atomId: 'one&#35;two',
        params: 'mode=&#38;#35;',
        source: 'atom:one&#35;two mode=&#38;#35;',
      },
    })
    expect(body.content?.[2]).toMatchObject({
      type: 'callout',
      attrs: {
        calloutType: 'note&#35;kind',
        title: 'Title &#38;#35;',
      },
    })
    expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
  })

  it('sanitizes image schemes after restoring attribute entities', () => {
    for (const source of [
      'dohc&#45;file://workspace/secret.png',
      'custom&#46;scheme:secret.png',
      'custom&#43;scheme:secret.png',
    ]) {
      const doc = markdownToYDoc(`![image](${source})`)
      const image = yDocBodyJSON(doc).content
        ?.find(node => node.type === 'image')
      expect(image?.attrs?.src).toBe('')
      expect(yDocToMarkdown(doc)).toBe('![image]()')
    }
  })

  it('keeps literal block openers as paragraph text after a rich-document reopen', () => {
    const openers = [
      ['- not a bullet', '\\- not a bullet'],
      ['   - indented literal bullet', '   \\- indented literal bullet'],
      ['    four-space literal paragraph', '&#32;   four-space literal paragraph'],
      ['\tleading tab literal paragraph', '&#9;leading tab literal paragraph'],
      ['+ not a bullet', '\\+ not a bullet'],
      ['# not a heading', '\\# not a heading'],
      ['> not a quote', '&gt; not a quote'],
      ['1. not an ordered item', '1\\. not an ordered item'],
      ['1) not an ordered item', '1\\) not an ordered item'],
      ['123456789) still literal', '123456789\\) still literal'],
      ['---', '\\---'],
      ['***', '\\***'],
      ['* * *', '\\* * *'],
      ['_ _ _', '\\_ _ _'],
      ['___', '\\___'],
      ['```ts', '\\```ts'],
      ['~~~ts', '\\~~~ts'],
      ['$$not a math block$$', '\\$\\$not a math block$$'],
      ['[label]: not a definition', '\\[label]: not a definition'],
      ['![alt](not-an-image)', '!\\[alt](not-an-image)'],
    ] as const
    const body: JSONContent[] = [
      ...openers.map(([text]) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })),
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: '-' },
                  { type: 'text', text: ' nested literal' },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '[x] literal checked box' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '[X] literal checked box' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '[ ] literal checkbox' }] },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'before' },
          { type: 'hardBreak' },
          { type: 'text', text: '- after a hard break' },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '- marked text is already safe', marks: [{ type: 'bold' }] },
        ],
      },
    ]

    const once = yDocToMarkdown(yDocFromBody(body))
    for (const [, expected] of openers) expect(once).toContain(expected)
    expect(once).toContain('- \\- nested literal')
    expect(once).toContain('- \\[ ] literal checkbox')
    expect(once).toContain('- \\[x] literal checked box')
    expect(once).toContain('- \\[X] literal checked box')
    expect(once).toContain('before  \n\\- after a hard break')
    expect(once).toContain('**- marked text is already safe**')

    const reopened = markdownToYDoc(once)
    const reopenedBody = yDocBodyJSON(reopened)
    expect(reopenedBody.content?.slice(0, openers.length).map(node => node.type))
      .toEqual(openers.map(() => 'paragraph'))
    expect(reopenedBody.content?.at(openers.length)?.content).toHaveLength(4)
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps marked leading indentation as paragraph text after a rich-document reopen', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '\tmarked tab',
            marks: [{ type: 'italic' }],
          },
        ],
      },
    ]))

    expect(once).toBe('&#9;*marked tab*')
    const reopened = markdownToYDoc(once)
    expect(yDocBodyJSON(reopened).content?.[0]?.type).toBe('paragraph')
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps indentation split across marked runs as paragraph text after a rich-document reopen', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '   ', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' marked spaces', marks: [{ type: 'bold' }] },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '   ' },
          { type: 'text', text: '\tmarked tab', marks: [{ type: 'italic' }] },
        ],
      },
    ]))

    expect(once).toBe(
      '&#32;   **marked spaces**\n\n&#32;  \t*marked tab*',
    )
    const reopened = markdownToYDoc(once)
    expect(yDocBodyJSON(reopened).content?.map(node => node.type))
      .toEqual(['paragraph', 'paragraph'])
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps marked block openers after an inline newline as paragraph text', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'before\n# heading text',
            marks: [{ type: 'italic' }],
          },
        ],
      },
    ]))

    expect(once).toBe('*before*\n*&#35; heading text*')
    const reopened = markdownToYDoc(once)
    expect(yDocBodyJSON(reopened).content?.[0]?.type).toBe('paragraph')
    expect(yDocToMarkdown(reopened)).toBe(once)
  })

  it('keeps setext lines inside multiline paragraphs', () => {
    for (const [source, expected] of [
      ['before\n===', 'before\n&#61;=='],
      ['before\n--', 'before\n&#45;-'],
    ]) {
      const once = yDocToMarkdown(yDocFromBody([{
        type: 'paragraph',
        content: [{ type: 'text', text: source }],
      }]))
      expect(once).toBe(expected)
      const reopened = markdownToYDoc(once)
      expect(yDocBodyJSON(reopened).content?.map(node => node.type))
        .toEqual(['paragraph'])
      expect(yDocToMarkdown(reopened)).toBe(once)
    }

    const ordinary = [
      'before',
      '==x',
      'x=y',
      'a|b',
      '---|text',
      'one | two',
    ].join('\n')
    expect(yDocToMarkdown(yDocFromBody([{
      type: 'paragraph',
      content: [{ type: 'text', text: ordinary }],
    }]))).toBe(ordinary)

    for (const [source, expected] of [
      ['before\n\t===', 'before\n&#9;==='],
      ['before\n \t===', 'before\n&#32;\t==='],
    ]) {
      const once = yDocToMarkdown(yDocFromBody([{
        type: 'paragraph',
        content: [{ type: 'text', text: source }],
      }]))
      expect(once).toBe(expected)
      const reopened = markdownToYDoc(once)
      expect(yDocBodyJSON(reopened).content?.map(node => node.type))
        .toEqual(['paragraph'])
      expect(yDocToMarkdown(reopened)).toBe(once)
    }
  })

  it('encodes CR and starts a new Markdown line only after LF', () => {
    for (const [source, expected] of [
      ['before\r---\rnext', 'before&#13;---&#13;next'],
      ['before\r\n---\r\nnext', 'before&#13;\n---&#13;\nnext'],
    ]) {
      const once = yDocToMarkdown(yDocFromBody([{
        type: 'paragraph',
        content: [{ type: 'text', text: source }],
      }]))
      expect(once).toBe(expected)
      const reopened = markdownToYDoc(once)
      expect(yDocBodyJSON(reopened).content?.map(node => node.type))
        .toEqual(['paragraph'])
      expect(yDocBodyJSON(reopened).content?.[0]?.content?.[0]?.text)
        .toBe(source)
      expect(yDocToMarkdown(reopened)).toBe(once)
    }

    const markedSource = 'before\r\n---\r\nnext'
    const markedOnce = yDocToMarkdown(yDocFromBody([{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: markedSource,
        marks: [{ type: 'italic' }],
      }],
    }]))
    const markedReopened = markdownToYDoc(markedOnce)
    const markedText = yDocBodyJSON(markedReopened).content?.[0]?.content
    expect(markedText?.map(node => node.text).join('')).toBe(markedSource)
    expect(markedText?.filter(node => node.text !== '\n')
      .every(node => node.marks?.some(mark => mark.type === 'italic'))).toBe(true)
    expect(yDocToMarkdown(markedReopened)).toBe(markedOnce)
  })

  it('keeps representative marked multiline block openers in one paragraph', () => {
    const sourceText = [
      'before',
      '===',
      '# heading',
      '- list',
      '1. ordered',
      '---',
      '```backtick fence',
      '~~~tilde fence',
      '$$math$$',
      '[label]: definition',
    ].join('\n')
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: sourceText,
            marks: [{ type: 'italic' }],
          },
        ],
      },
    ]))

    for (const escaped of [
      '&#35;',
      '&#61;',
      '&#45;',
      '&#46;',
      '&#96;',
      '&#126;',
      '&#36;',
      '&#91;',
    ]) {
      expect(once).toContain(escaped)
    }
    const reopened = markdownToYDoc(once)
    const reopenedBody = yDocBodyJSON(reopened)
    expect(reopenedBody.content?.map(node => node.type))
      .toEqual(['paragraph'])
    const reopenedCharacters = reopenedBody.content?.[0]?.content?.flatMap((node) => {
      const value = node.type === 'escapedPunctuation'
        ? String(node.attrs?.value ?? '')
        : node.text ?? ''
      return Array.from(value)
        .filter(character => character !== '\n')
        .map(character => ({
          character,
          marks: node.marks?.map(mark => mark.type) ?? [],
        }))
    })
    expect(reopenedCharacters).toEqual(
      Array.from(sourceText)
        .filter(character => character !== '\n')
        .map(character => ({ character, marks: ['italic'] })),
    )
    expect(yDocToMarkdown(reopened)).toBe(once)
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

  it('projects a multiline fenced code block in a table cell as legal inline content', () => {
    const once = yDocToMarkdown(yDocFromBody([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Code' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{
                type: 'codeBlock',
                attrs: { language: 'mermaid' },
                content: [{
                  type: 'text',
                  text: 'const fence = ```;\nleft | right <&>',
                }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{
                type: 'codeBlock',
                attrs: { language: '' },
              }],
            }],
          },
        ],
      },
    ]))

    expect(once).toContain(
      '````const fence = ```;````<br>`left \\| right <&>`',
    )
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
    expect(yDocBodyJSON(markdownToYDoc(once)).content?.[0].content).toHaveLength(3)
    expect(once).not.toContain('DOHC_CODE_BLOCK')
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
  })

  it.each([
    {
      type: 'image',
      node: {
        type: 'image',
        attrs: {
          alt: 'plot | draft',
          src: 'assets/plot|`draft`.png',
          title: 'chart | `draft`',
        },
      },
      expected: '![plot \\| draft](assets/plot\\|`draft`.png "chart \\| `draft`")',
    },
    {
      type: 'escapedPunctuation',
      node: { type: 'escapedPunctuation', attrs: { value: '|' } },
      expected: '\\|',
    },
    {
      type: 'wikilink',
      node: {
        type: 'wikilink',
        attrs: { target: 'notes/`plan`', label: 'left | right' },
      },
      expected: '[[notes/`plan`\\|left \\| right]]',
    },
    {
      type: 'inlineAtom',
      node: {
        type: 'inlineAtom',
        attrs: {
          atomId: 'one',
          params: 'mode=left|`draft`',
          source: 'atom:one mode=left|`draft`',
        },
      },
      expected: '{{atom:one mode=left\\|`draft`}}',
    },
    {
      type: 'mathInline',
      node: { type: 'mathInline', attrs: { tex: 'a|`b`' } },
      expected: '$a\\|`b`$',
    },
  ])('escapes table pipes emitted by the $type renderer', ({ node, expected }) => {
    const once = serializeRichdocBody({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Value' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [node] }],
            }],
          },
        ],
      }],
    }).trimEnd()

    expect(once).toContain(expected)
    const roundTripDoc = markdownToYDoc(once)
    expect(yDocToMarkdown(roundTripDoc)).toBe(once)
    if (node.type !== 'escapedPunctuation') {
      const roundTripNode = yDocBodyJSON(roundTripDoc)
        .content?.[0].content?.[1].content?.[0].content?.[0].content?.[0]
      expect(roundTripNode).toMatchObject(node)
    }
    expect(once).not.toMatch(/DOHC_[A-Z_]+_\d+/u)
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
  })

  it('keeps the complete table-cell block and inline-node inventories explicit', () => {
    const schema = getDohcProseMirrorSchema()
    const tableCellContent = schema.nodes.tableCell.contentMatch
    const directCellBlocks = Object.values(schema.nodes)
      .filter(nodeType => tableCellContent.matchType(nodeType) !== null)
      .map(nodeType => nodeType.name)
      .sort()
    const inlineNodes = Object.values(schema.nodes)
      .filter(nodeType => nodeType.isInline)
      .map(nodeType => nodeType.name)
      .sort()

    expect(directCellBlocks).toEqual([
      'blockquote',
      'bulletList',
      'callout',
      'codeBlock',
      'heading',
      'horizontalRule',
      'mathBlock',
      'orderedList',
      'paragraph',
      'table',
      'taskList',
    ])
    expect(inlineNodes).toEqual([
      'escapedPunctuation',
      'hardBreak',
      'image',
      'inlineAtom',
      'mathInline',
      'text',
      'wikilink',
    ])
  })

  it.each([
    {
      type: 'blockquote',
      block: {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'quote | `tick`' }],
          },
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          },
        ],
      },
    },
    {
      type: 'bulletList',
      block: {
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'bullet | `tick`' }],
          }, {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          }],
        }],
      },
    },
    {
      type: 'callout',
      block: {
        type: 'callout',
        attrs: { calloutType: 'note', fold: '', title: 'Title | `tick`' },
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'body | `tick`' }],
          },
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          },
        ],
      },
    },
    {
      type: 'codeBlock',
      block: {
        type: 'codeBlock',
        attrs: { language: 'txt' },
        content: [{ type: 'text', text: 'code | ```' }],
      },
    },
    {
      type: 'heading',
      block: {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'heading | `tick`' }],
      },
    },
    {
      type: 'horizontalRule',
      block: { type: 'horizontalRule' },
    },
    {
      type: 'mathBlock',
      block: { type: 'mathBlock', attrs: { tex: 'a|`b`' } },
    },
    {
      type: 'orderedList',
      block: {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'ordered | `tick`' }],
          }, {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          }],
        }],
      },
    },
    {
      type: 'paragraph',
      block: {
        type: 'paragraph',
        content: [{ type: 'text', text: 'paragraph | `tick`' }],
      },
    },
    {
      type: 'table',
      block: {
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [{
            type: 'tableHeader',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'nested | `tick`' }],
            }, {
              type: 'codeBlock',
              content: [{ type: 'text', text: 'deeper | ```' }],
            }],
          }],
        }],
      },
    },
    {
      type: 'taskList',
      block: {
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: false },
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'task | `tick`' }],
          }, {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'nested | ```' }],
          }],
        }],
      },
    },
  ])('serializes the $type block shape inside a table cell without a sentinel', ({ block }) => {
    const once = serializeRichdocBody({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Value' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [block],
            }],
          },
        ],
      }],
    }).trimEnd()

    const normalized = yDocToMarkdown(markdownToYDoc(once))
    expect(yDocToMarkdown(markdownToYDoc(normalized))).toBe(normalized)
    expect(yDocBodyJSON(markdownToYDoc(once)).content?.[0].content?.[1].content)
      .toHaveLength(1)
    expect(once).not.toMatch(/DOHC_[A-Z_]+_\d+/u)
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
  })

  it.each([
    {
      type: 'text',
      content: [{ type: 'text', text: 'left | `right`' }],
    },
    {
      type: 'hardBreak',
      content: [
        { type: 'text', text: 'left' },
        { type: 'hardBreak' },
        { type: 'text', text: 'right | `tick`' },
      ],
    },
    {
      type: 'text with link mark',
      content: [{
        type: 'text',
        text: 'label',
        marks: [{
          type: 'link',
          attrs: { href: 'https://example.com/left|`right`' },
        }],
      }],
    },
  ])('serializes the $type inline shape inside a table cell without a sentinel', ({ content }) => {
    const once = serializeRichdocBody({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{
              type: 'tableHeader',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Value' }],
              }],
            }],
          },
          {
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              content: [{ type: 'paragraph', content }],
            }],
          },
        ],
      }],
    }).trimEnd()

    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
    expect(once).not.toMatch(/DOHC_[A-Z_]+_\d+/u)
    expect(once).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
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

  it('reserves many code-block tokens without rescanning the source per block', () => {
    const includes = vi.spyOn(String.prototype, 'includes')
    try {
      const markdown = serializeRichdocBody({
        type: 'doc',
        content: Array.from({ length: 200 }, (_, index) => ({
          type: 'codeBlock',
          attrs: { language: 'txt' },
          content: [{ type: 'text', text: `block ${index}` }],
        })),
      })
      const tokenSourceScans = includes.mock.calls.filter(
        ([search]) =>
          typeof search === 'string'
          && /^\uE000DOHC_CODE_BLOCK_\d+\uE001$/u.test(search),
      )

      expect(tokenSourceScans).toHaveLength(0)
      expect(markdown).toContain('block 0')
      expect(markdown).toContain('block 199')
      expect(markdown).not.toContain('DOHC_CODE_BLOCK')
    } finally {
      includes.mockRestore()
    }
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

// A bare TaskItem takes `paragraph+`, so an indented list under a checkbox is
// schema-invalid and the Y.Doc -> ProseMirror conversion returned an EMPTY
// document: the whole task list disappeared on open (#700).
describe('a list nested inside a task item', () => {
  const CASES = [
    ['bullet', '- [ ] parent\n  - child one\n  - child two'],
    ['ordered', '- [x] parent\n  1. first\n  2. second'],
    ['task', '- [ ] parent\n  - [x] done child\n  - [ ] open child'],
  ] as const

  for (const [kind, markdown] of CASES) {
    it(`survives the Y.Doc round-trip as a ${kind} list`, () => {
      expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown)
    })
  }
})

// CommonMark lets a fenced code block's opener carry up to three leading
// spaces. Four or more make an indented code block instead, which is a
// different construct. markdownToYDoc used to drop a top-level fence indented
// 1-3 spaces together with its whole body, so opening such a document and
// letting it settle wrote the deletion back to disk (#695). This mirrors the
// desktop editor's suite — both packages parse markdown with the same rules.
describe('indented code fences', () => {
  function bodyBlocks(markdown: string): JSONContent[] {
    return yDocBodyJSON(markdownToYDoc(markdown)).content ?? []
  }

  function codeText(node: JSONContent | undefined): string {
    return (node?.content ?? []).map((child) => child.text ?? '').join('')
  }

  for (const indent of [1, 2, 3]) {
    for (const fence of ['```', '~~~']) {
      for (const info of ['', 'ts']) {
        const opener = `${' '.repeat(indent)}${fence}${info}`
        const label = `a ${indent}-space ${fence} fence ${info ? `with the info string "${info}"` : 'with no info string'}`

        it(`keeps ${label}`, () => {
          const input = [
            'Para',
            '',
            opener,
            'const a = 1',
            `${' '.repeat(indent)}${fence}`,
            '',
            'After',
          ].join('\n')

          const blocks = bodyBlocks(input)
          expect(blocks.map((block) => block.type)).toEqual([
            'paragraph',
            'codeBlock',
            'paragraph',
          ])
          expect(codeText(blocks[1])).toBe('const a = 1')
          expect(blocks[1]?.attrs?.language ?? null).toBe(info || null)
        })
      }
    }
  }

  it('keeps every body line, stripping only the opener indent', () => {
    const input = [
      '  ```md',
      '  first',
      '',
      '# not a heading',
      '   deeper',
      '  ```',
    ].join('\n')
    const blocks = bodyBlocks(input)
    expect(blocks.map((block) => block.type)).toEqual(['codeBlock'])
    expect(codeText(blocks[0])).toBe('first\n\n# not a heading\n deeper')
    expect(blocks[0]?.attrs?.language).toBe('md')
  })

  it('normalizes an indented fence to column 0 on export', () => {
    const once = yDocToMarkdown(markdownToYDoc(' ```js\ncode\n ```'))
    expect(once).toBe('```js\ncode\n```')
  })

  // An empty fence has no body. The codeBlock must be built with no content at
  // all: a text node holding '' is schema-invalid, so markdownToYDoc would
  // throw `RangeError: Empty text nodes are not allowed` and the document would
  // fail to open.
  it('imports an empty indented fence as a codeBlock with no text node', () => {
    const input = ' ```js\n ```'
    const blocks = bodyBlocks(input)
    expect(blocks.map((block) => block.type)).toEqual(['codeBlock'])
    expect(blocks[0]?.attrs?.language).toBe('js')
    expect(codeText(blocks[0])).toBe('')

    const once = yDocToMarkdown(markdownToYDoc(input))
    expect(once).toBe('```js\n\n```')
    expect(yDocToMarkdown(markdownToYDoc(once))).toBe(once)
  })

  // Boundary: four spaces is an indented code block, NOT a fence.
  it('treats a 4-space-indented backtick run as code content, not a fence', () => {
    const blocks = bodyBlocks('    ```\nParagraph')
    expect(blocks.map((block) => block.type)).toEqual(['codeBlock', 'paragraph'])
    expect(codeText(blocks[0])).toBe('```')
    expect(blocks[0]?.attrs?.language ?? null).toBeNull()
  })

  // Boundary: fences that already worked must keep working.
  it('keeps a fence indented inside a list item nested in that item', () => {
    const blocks = bodyBlocks(['- item', '', '  ```', '  code', '  ```', '', 'After'].join('\n'))
    expect(blocks.map((block) => block.type)).toEqual(['bulletList', 'paragraph'])
    const itemBlocks = blocks[0]?.content?.[0]?.content ?? []
    expect(itemBlocks.map((block) => block.type)).toEqual(['paragraph', 'codeBlock'])
    expect(codeText(itemBlocks[1])).toBe('code')
  })

  // `round-trips fenced code inside $context` covers the quoted container in
  // the export direction only — it starts from a doc, not from markdown.
  it('keeps a fence inside a plain blockquote quoted', () => {
    const input = ['> ```', '> code', '> ```'].join('\n')
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })
})
