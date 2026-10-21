import { describe, expect, it, vi } from 'vitest'
import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import { DohcMarkdownTable, dohcMarkdownExtensions } from './dohc-markdown-extensions.js'

describe('table rendering', () => {
  // The table renderer is Tiptap's, copied so a cell can be measured by
  // another width. Measured by length, a table with no pipe, `<br>` or row
  // height in it renders exactly as Tiptap's own does.
  it("matches Tiptap's renderer", () => {
    const render = (node: JSONContent): string => node.text ?? helpers.renderChildren(node.content ?? [])
    const helpers: MarkdownRendererHelpers = {
      renderChildren: nodes => [nodes].flat().map(render).join(''),
      wrapInBlock: (prefix, content) => prefix + content,
      indent: content => content,
    }
    const cell = (type: 'tableHeader' | 'tableCell', paragraphs: string[], align: string | null = null): JSONContent =>
      ({ type, attrs: { align }, content: paragraphs.map(text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })) })
    const row = (...cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells })
    const tables: JSONContent[] = [
      [row(cell('tableHeader', ['Event']), cell('tableHeader', ['Sent when'])), row(cell('tableCell', ['launched']), cell('tableCell', ['dohc starts.']))],
      [row(cell('tableHeader', ['a'], 'left'), cell('tableHeader', ['b'], 'center'), cell('tableHeader', ['c'], 'right')), row(cell('tableCell', ['1']), cell('tableCell', ['']), cell('tableCell', ['3']))],
      [row(cell('tableCell', ['no header'])), row(cell('tableCell', ['x']), cell('tableCell', ['a longer cell than its header']))],
      [row(cell('tableHeader', ['  spaced \t out  '])), row(cell('tableCell', ['first', 'second']))],
      [row(cell('tableHeader', ['Café 🎉'])), row(cell('tableCell', ['中文']))],
    ].map(rows => ({ type: 'table', content: rows }))
    const context = { index: 0, level: 0 }
    for (const table of tables) {
      expect(DohcMarkdownTable.config.renderMarkdown!(table, helpers, context), JSON.stringify(table))
        .toBe(Table.config.renderMarkdown!(table, helpers, context).replace(/\n$/u, ''))
    }
  })
})

function startFor(name: string): (source: string) => number {
  const start = dohcMarkdownExtensions.find(extension => extension.name === name)
    ?.config.markdownTokenizer?.start
  if (typeof start !== 'function') throw new Error(`Missing tokenizer: ${name}`)
  return start
}

describe('block start searches', () => {
  // marked uses a start only to cut the paragraph it is about to read, which
  // ends at the first line holding only spaces. A marker past that line cuts
  // nothing, so the search stops there.
  it.each([
    ['callout', /(?:^|\n)( {0,3}>\s?\[!)/],
    ['mathBlock', /(?:^|\n)(\$\$)/],
  ] as const)('finds %s markers in the paragraph marked reads', (name, pattern) => {
    const start = startFor(name)
    const check = (source: string) => {
      const match = pattern.exec(source)
      const marker = match ? (match.index === 0 ? 0 : match.index + 1) : -1
      const paragraphEnd = /\n *(?:\n|$)/.exec(source)?.index ?? source.length
      const expected = marker < paragraphEnd ? marker : -1
      expect(start(source), JSON.stringify(source)).toBe(expected)
    }
    for (const prefix of ['', '\n', '\n\n', 'paragraph\n', 'paragraph\n\n', 'escaped\\', 'x']) {
      for (const indent of ['', ' ', '   ', '    ', '\t']) {
        for (const space of ['', ' ', '\t', '\r', '\n', '\u00a0', '\u2028', '  ']) {
          check(`${prefix}${indent}>${space}[!note]\nbody`)
          check(`${prefix}${indent}$$tex$$\nbody`)
        }
      }
    }
    let seed = 42
    const chunks = ['x', '\n', ' ', '   ', '>', '\t', '\r', '[!', '$$', '$', '\\', '[', '!', '\u00a0']
    for (let sample = 0; sample < 2000; sample += 1) {
      let source = ''
      for (let index = 0; index < 24; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        source += chunks[seed % chunks.length]
      }
      check(source)
    }
  })

  it('limits regular-expression work to marker prefixes on a long line', () => {
    const starts = [startFor('callout'), startFor('mathBlock')]
    const exec = RegExp.prototype.exec
    let scanned = 0
    const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, source: string) {
      scanned += source.length
      return Reflect.apply(exec, this, [source])
    })
    let positions: number[]
    try {
      positions = starts.map(start => start('text[!$$'.repeat(8192)))
    } finally { spy.mockRestore() }
    expect(positions).toEqual([-1, -1])
    expect(scanned).toBeLessThanOrEqual(8192)
  })
})
