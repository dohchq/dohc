import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { parseRichdocMarkdown } from './import-export.js'

// Fragments of the syntax the importer reads, including the shapes whose
// searches once read the rest of a paragraph at each step.
const FRAGMENTS = [
  'plain words', 'a', 'Ab9', ' ', '  ', '\t', 'é ü', '😀',
  'a  \n', 'a   \n', 'a \n', 'a\\\n', '\\\n', 'end',
  '*em*', '**strong**', '***both***', '_u_', '__uu__', 'a_b_c', '*a', 'a*', '**', '*a *b', 'a*b*',
  '~~del~~', '~d~', '~', '~~', '`code`', '``a`b``', '`', '```',
  '==mark==', '==a\\=b==', '== no', 'a==b', '=', '==',
  '$x$', '$5 and $6', '$a$1', '\\$', '$', '$$', '$$\nx\n$$',
  '++under++', '++', '+',
  '[[Page]]', '[[Page|Label]]', '[[a\\]]b]]', '[[a\\|b|c]]', '[[', ']]', '[[]]', '[[ ]]',
  '[[open', '[[a\nb]]', '[[a\\\nb]]', '\\[[esc]]', '[', '[[[', 'a[[', '[[x]]@b.co',
  '[text](https://example.com)', '[t](u "title")', '[](https://example.com)', '[](u "t")', '![alt](i.png)',
  '[ref]', '[ref][]', '[x][ref]', '\n\n[ref]: https://ref.example\n\n', '[]', '[]( x',
  '<b>bold</b>', '<a href="x">', '</a>', '<br>', '<!-- c -->', '<', '>', '<span', '<https://auto.link>', '<me@mail.com>',
  '<a-b>', '</a-b>', '<A>', '</A>', '<a->', '</a-b-c>', '</b:c>', '<x-y>', '</x>', '<i>', '</i>', '<b>', '</b >', '<b/>',
  '&amp;', '&lt;', '&#91;', '&#42;', '&#32;', '&#9;', '&nbsp;', '&',
  'me@example.com', 'a.b+c@d-e.org', 'x@y', '@', '@@', 'a@', '@b.co', 'a*b@c.de', 'a!b@c.io', 'ab==c==d@e.com',
  'a$x$@b.co', 'a++b++@c.de', 'a{{atom:x}}@b.io', 'a\\@b.com', 'x_y@z.com', '.@a.co', 'a-@b.co',
  'a@a@a', '@a@', 'x@y.z@w.io', 'ftp://a@b.co', 'http://x@y.zz', 'a b@c.de', '`a@b.co`', 'a~b@c.de', '*a@b.co*',
  'a<b@c.de', '[x](y)@z.co', 'a  \nb@c.de', 'www.a@b.co',
  'https://example.com/path?q=1', 'www.example.com', 'http', 'HTTP', 'ftp://f.example', 'ftp', 'ttps://x',
  '{{atom:widget key=1}}', '{{atom:', '{{', '}}', '{{atom:a}', '{{atom: a}}', '{{atom:a}}}', '{{atom:a b}}', '{{atom:}}',
  '\\*', '\\_', '\\[', '\\]', '\\\\', '\\', '\\=', '\\|', '\\@',
  'a*'.repeat(9), '['.repeat(9), '[['.repeat(5), 'a[['.repeat(5), 'a@'.repeat(4), '*a '.repeat(4), 'a_'.repeat(6),
  '!'.repeat(5), '<'.repeat(4), '~'.repeat(5), '`a'.repeat(4), '=='.repeat(4), '$a'.repeat(4), '++a'.repeat(3),
  '{{atom:'.repeat(3), '</b>'.repeat(3), '<b><i>'.repeat(2), '[[a\n'.repeat(3), '[[a\\]'.repeat(3), '$'.repeat(5),
  '$$$', '$$$$', '$'.repeat(7), '$$a\n$$b', '$$\n', '$$ x', '\n$$a', '$$a$$', '$$$x', '$$a\n'.repeat(3),
  '*a ', '_a ', '~a ', '~~a ', '**a ', ' *', '* a', 'a *b', '_a_b', 'a_ ', ' _a', '~a~~', '~~a~', '*a**', '***a',
  '*.txt ', '*.txt '.repeat(3), '_a '.repeat(3), '~a '.repeat(3), '*a b*', '_a b_', '~a b~', '*(a)*', '_.a_',
  '[](', '[a](', '[a](b', '[a](<b', '[a](b "t', ')', '(', '![a](', '[a]( b )', '[a](b)c)', '[](()', '[a]((b))',
  '[a](b\\)', '[]('.repeat(3), '[a]('.repeat(3), '[a](\nb)', '[a]\n(b)',
  '\\[', '\\*a\\*', '\\😀', '\\€', '\\🎉\\*', '\\\\[', '`\\[`', '\\[a](b)', '\\['.repeat(3), '\\😀\\*', '\\😀*a*',
  'a<!--', '<!--', '-->', '<!-->', '<!--->', '<!-- x -->', '<!--a-->', 'a<!--'.repeat(3), '<!---->', '<!--\n-->',
  '| $ |', '|-|', '===', '# h', '> [!a', 'a\n===', 'a\n---', '    x',
  '`a`*b*', '*a`*`b*', '[*a*](b)*c*', '<i>*</i>*', '\\**a*', '~~a~~b~~', '**a*', 'a\u2028b',
]
const LINE_STARTS = [
  '# ', '## ', '> ', '> [!note] ', '- ', '* ', '1. ', '2) ', '- [ ] ', '- [x] ', '    ', '   ', '',
]
const BLOCKS = [
  '| a | b |\n| - | - |\n| c | d |', '```js\nconst a = 1\n```', '~~~\nfence\n~~~', '---', '***',
  'Setext\n===', '$$\nE = mc^2\n$$', '<div>\nhtml block\n</div>', '<!-- dohc:table row-heights=1:84 -->\n| a |\n| - |\n| b |',
  '$$a\n$$b\n$$c', `${'$'.repeat(9)}\nx`, '$$x\n---', '$$a\n> [!note] t', '$$a\n# h\n---', 'a\n$$\nb', '$$$$$\n===',
  '*a *b *c\nd', '| a | b |\n|-|\n| $ |', '$$a\n| b | c |\n| - | - |', '$$a\n```\nb\n```', '$$a\n- b', '$$a\n  \n$$b',
  'a\n- b\n---', 'a\n> b\n===', 'a\n    b\n---', 'a\u2028b\n---', 'a\u2028| b |\n| - |', '> a\n$$b\n$$c', '- [ ] $$$\n$$a',
]
const SEPARATORS = ['', '', ' ', ' ', '\n', '\n\n']

// A small seeded generator, so each run reads the same inputs.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function markdownInputs(count: number): string[] {
  const next = random(2069)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  return Array.from({ length: count }, () => {
    let text = ''
    const parts = 1 + Math.floor(next() * 14)
    for (let part = 0; part < parts; part += 1) {
      const roll = next()
      if (roll < 0.08) text += `\n\n${pick(BLOCKS)}\n\n`
      else if (roll < 0.2) text += `\n${pick(LINE_STARTS)}${pick(FRAGMENTS)}`
      else text += pick(SEPARATORS) + pick(FRAGMENTS)
    }
    return text
  })
}

function countNodes(node: JSONContent, counts: Map<string, number>): void {
  const kinds = [node.type ?? '', ...(node.marks ?? []).map(mark => `mark:${mark.type}`)]
  if (node.marks?.some(mark => String(mark.attrs?.href ?? '').startsWith('mailto:'))) kinds.push('email')
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  for (const child of node.content ?? []) countNodes(child, counts)
}

// Any change to what the importer reads changes this hash: a parser rewrite,
// a cache that answers from the wrong text, or an upgrade of marked or Tiptap.
// When a change is meant to read some text differently, show that change in a
// focused test first, then record the new hash here.
//
// The hash only notices a change; it cannot say whose it is. The importer's
// fast paths assume marked 17.0.6's own rules, so at the first upgrade of
// marked or Tiptap, before recording a new hash, read this corpus with the
// fast paths and with marked's own rules alone, and require the same result.
it('reads 6,000 generated Markdown inputs exactly as before', () => {
  const hash = createHash('sha256')
  const counts = new Map<string, number>()
  for (const markdown of markdownInputs(6_000)) {
    for (const reading of ['source', 'projection'] as const) {
      let result: string
      try {
        const parsed = parseRichdocMarkdown(markdown, reading)
        countNodes(parsed, counts)
        result = JSON.stringify(parsed)
      } catch (error) {
        result = `error: ${error instanceof Error ? error.message : String(error)}`      }
      hash.update(`${JSON.stringify(markdown)}\u0000${reading}\u0000${result}\u0000`)
    }
  }
  for (const kind of [
    'hardBreak', 'wikilink', 'email', 'mark:link', 'mark:highlight', 'mathInline', 'mathBlock', 'mark:underline',
    'escapedPunctuation', 'inlineAtom', 'mark:italic', 'mark:bold', 'mark:strike', 'mark:code', 'image',
    'table', 'codeBlock', 'callout', 'taskList', 'orderedList', 'bulletList', 'blockquote', 'heading',
  ]) {
    expect(counts.get(kind) ?? 0, kind).toBeGreaterThan(20)
  }
  expect(hash.digest('hex')).toBe('d731b842fd8a56847363ee4a0cd40a957b5f8af25123dab68de290f7f1367ddb')
})
