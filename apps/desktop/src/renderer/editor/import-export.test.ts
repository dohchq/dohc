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

// These tests cover the desktop editor's markdown round-trip: idempotency,
// frontmatter ordering, and custom-node preservation. Inline fixtures keep the
// suite self-contained.
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

  it('preserves wikilinks, inline atoms, and ordinary brace text across the round-trip', () => {
    const output = yDocToMarkdown(
      markdownToYDoc('See [[notes/today|Today]] — budget {rate: 150} and {estimate pending}.'),
    )
    expect(output).toContain('[[notes/today|Today]]')
    expect(output).toContain('{rate: 150}')
    expect(output).toContain('{estimate pending}')
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
// different construct. The import path used to drop a top-level fence indented
// 1-3 spaces together with its whole body, so opening such a document and
// letting it settle wrote the deletion back to disk (#695).
describe('desktop editor markdown import: indented code fences', () => {
  function bodyBlocks(markdown: string): JSONContent[] {
    const root = yXmlFragmentToProseMirrorRootNode(
      getDohcYDocBodyFragment(markdownToYDoc(markdown)),
      getDohcProseMirrorSchema(),
    ).toJSON() as JSONContent
    return root.content ?? []
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

  // The suite above covers a fence inside a callout, whose tokenizer strips the
  // `>` prefix itself. This is the only case that reaches marked's blockquote
  // tokenizer with a fence inside it.
  it('keeps a fence inside a plain blockquote quoted', () => {
    const input = ['> ```', '> code', '> ```'].join('\n')
    expect(yDocToMarkdown(markdownToYDoc(input))).toBe(input)
  })
})
