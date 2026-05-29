import { describe, it, expect } from 'vitest'
import {
  deriveSearchFields,
  isAtomSearchable,
  htmlToText,
  markdownToText,
  atomPlaintext,
  normalizeQuery,
  queryTerms,
  snippetParts,
  MAX_PLAINTEXT,
} from './searchText'

describe('isAtomSearchable', () => {
  it('treats former map paths as ordinary searchable atoms', () => {
    expect(isAtomSearchable('.context/_map.md')).toBe(true)
    expect(isAtomSearchable('_map.md')).toBe(true)
  })
  it('includes html, markdown, and user files (NOT !isNonDataAtom)', () => {
    expect(isAtomSearchable('dashboard.html')).toBe(true) // html must be searchable
    expect(isAtomSearchable('clients/Acme.md')).toBe(true)
    expect(isAtomSearchable('me.md')).toBe(true)
    expect(isAtomSearchable('intent.md')).toBe(true)
    expect(isAtomSearchable('.skills/email.md')).toBe(true)
    expect(isAtomSearchable('.commands/draft-invoice.md')).toBe(true)
  })
})

describe('htmlToText', () => {
  it('strips tags + script/style and decodes entities', () => {
    const html =
      '<style>.x{color:red}</style><h1>Title</h1><p>Hello&nbsp;&amp; <b>world</b></p><script>evil()</script>'
    const t = htmlToText(html)
    expect(t).toContain('Title')
    expect(t).toContain('Hello & world')
    expect(t).not.toContain('color:red')
    expect(t).not.toContain('evil')
    expect(t).not.toMatch(/<[^>]+>/)
  })
})

describe('markdownToText', () => {
  it('keeps words, drops syntax, preserves link text', () => {
    const md = '# Heading\n\n- a bullet\n> quote\n**bold** and [a link](http://x) and `code`'
    const t = markdownToText(md)
    expect(t).toContain('Heading')
    expect(t).toContain('a bullet')
    expect(t).toContain('quote')
    expect(t).toContain('bold')
    expect(t).toContain('a link')
    expect(t).toContain('code')
    expect(t).not.toContain('#')
    expect(t).not.toContain('http://x')
  })
  it('keeps ASCII-sketch art (fence markers removed, art retained)', () => {
    const md = 'before\n\n```ascii\n+--+\n|  |\n+--+\n```\n\nafter'
    const t = markdownToText(md)
    expect(t).toContain('+--+')
    expect(t).toContain('|  |')
    expect(t).not.toContain('```')
  })
})

describe('deriveSearchFields', () => {
  it('markdown atom: searchable, title weighted, body text indexed', () => {
    const { searchText, searchable } = deriveSearchFields(
      'clients/Acme Corp.md',
      '---\ntitle: Acme Corp\n---\n# Acme Corp\nSigned the renewal in Q3.',
    )
    expect(searchable).toBe(true)
    // title appears 3× (weighting)
    expect(searchText.match(/Acme Corp/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(searchText).toContain('Signed the renewal in Q3')
    expect(searchText).toContain('clients/Acme Corp.md') // full path
  })

  it('HTML atom is searchable and indexes visible text, not tags', () => {
    const { searchText, searchable } = deriveSearchFields(
      'dashboard.html',
      '<h1>Quarterly</h1><p>revenue up</p>',
    )
    expect(searchable).toBe(true)
    expect(searchText).toContain('revenue up')
    expect(searchText).not.toContain('<h1>')
  })

  it('ASCII sketch text lands in the index', () => {
    const { searchText } = deriveSearchFields(
      'arch.md',
      '```ascii\n[client] --> [server]\n```',
    )
    expect(searchText).toContain('[client] --> [server]')
  })

  it('.context/_map.md indexes like any other markdown atom', () => {
    const { searchText, searchable } = deriveSearchFields('.context/_map.md', '# Map\n- stuff')
    expect(searchable).toBe(true)
    expect(searchText).toContain('Map')
    expect(searchText).toContain('stuff')
  })

  it('caps the indexed plaintext', () => {
    const big = 'x'.repeat(MAX_PLAINTEXT * 2)
    const { searchText } = deriveSearchFields('big.md', big)
    // searchText = title×3 + basename + path + capped plaintext; the
    // plaintext slice itself is capped at MAX_PLAINTEXT.
    expect(searchText.length).toBeLessThan(MAX_PLAINTEXT + 2000)
  })

  it('keeps body + searchText under the 1 MB doc limit by BYTES (multibyte)', () => {
    const enc = new TextEncoder()
    // ~900 KB UTF-8 but only 300k chars — a char-based budget would overflow.
    const huge = '日'.repeat(300_000)
    const { searchText } = deriveSearchFields('huge.md', huge)
    expect(
      enc.encode(huge).length + enc.encode(searchText).length,
    ).toBeLessThan(1_000_000)
  })

  it('still indexes a moderately large multibyte body within budget', () => {
    const enc = new TextEncoder()
    const body = '計画'.repeat(50_000) // ~300 KB UTF-8
    const { searchText } = deriveSearchFields('plan.md', body)
    expect(searchText.length).toBeGreaterThan(0)
    expect(searchText).toContain('計画')
    expect(
      enc.encode(body).length + enc.encode(searchText).length,
    ).toBeLessThan(1_000_000)
  })
})

describe('normalizeQuery / queryTerms', () => {
  it('lowercases and caps at 16 terms', () => {
    const many = Array.from({ length: 30 }, (_, i) => `T${i}`).join('  ')
    expect(queryTerms(many)).toHaveLength(16)
    expect(normalizeQuery('  Hello   WORLD ')).toBe('hello world')
  })
  it('empty / punctuation-only normalizes to empty (doesn\'t throw)', () => {
    expect(normalizeQuery('')).toBe('')
    expect(normalizeQuery('   ')).toBe('')
    expect(normalizeQuery('???')).toBe('') // → caller shows recent, not empty FTS
    expect(normalizeQuery('... !!!')).toBe('')
    expect(normalizeQuery('hi! there?')).toBe('hi! there?') // keeps tokens w/ letters
  })
})

describe('snippetParts', () => {
  it('highlights the matched term and only the matched term', () => {
    const parts = snippetParts('the quick brown fox jumps', 'brown')
    expect(parts.filter((p) => p.hit).map((p) => p.s)).toEqual(['brown'])
    expect(parts.map((p) => p.s).join('')).toContain('quick brown fox')
  })
  it('no match → a head preview with no hits', () => {
    const parts = snippetParts('alpha beta gamma', 'zzz')
    expect(parts.every((p) => !p.hit)).toBe(true)
    expect(parts.map((p) => p.s).join('')).toContain('alpha')
  })
  it('empty query → head preview', () => {
    const parts = snippetParts('alpha beta gamma', '')
    expect(parts).toEqual([{ s: 'alpha beta gamma', hit: false }])
  })
  it('plaintext helper composes for md', () => {
    expect(atomPlaintext('a.md', '# Hi\nthere')).toContain('there')
  })
})
