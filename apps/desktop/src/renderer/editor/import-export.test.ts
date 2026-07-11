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

  it('strips unsafe image protocols and escaping paths while preserving http and relative images', () => {
    expectStableMarkdownRoundTrip(
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad](javascript:alert)',
        '![case-variant](JavaScript:alert)',
        '![data](data:image/svg+xml;base64,PHN2Zz4=)',
        '![parent](../secret/diagram.png)',
        '![absolute](/etc/diagram.png)',
        '![protocol-relative](//evil.example.com/diagram.png)',
      ].join('\n'),
      [
        '![relative](assets/diagram.png)',
        '![remote](https://example.com/diagram.png)',
        '![bad]()',
        '![case-variant]()',
        '![data]()',
        '![parent]()',
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
    // Backslash traversal (a Windows-style `..\secret\pic.png`) must be
    // folded to '/' before the parent-escape check, or a naive prefix test
    // lets it climb out of the document's folder. Driven through the node
    // attrs directly so the raw backslashes reach the sanitizer verbatim.
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
    for (const text of [
      'a==b',
      'a ==b== c',
      'a==b==c',
      '==edge==',
      'trailing==',
      'x = y',
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
    // shared by every inline atom (image, inlineAtom, formula, wikilink), not a
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
})
