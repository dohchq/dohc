import { describe, expect, it } from 'vitest'
import {
  getDohcYDocBodyFragment,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  getDohcYDocPlainText,
  yDocToMarkdown,
  markdownToYDoc,
  plainTextToYDoc,
} from './import-export'

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
})
