import { describe, expect, it } from 'vitest'
import { frontmatterText } from './frontmatter-comments'

function marked(markdown: string): string[] {
  const text = frontmatterText(markdown)
  if (!text) throw new Error('no frontmatter')
  return text.lines.flatMap(line => line.spans.map(span => line.text.slice(span.start, span.end)))
}

describe('frontmatterText', () => {
  it('has no block when the document does not open with one', () => {
    expect(frontmatterText('# Title\n\n---\na: 1\n---\n')).toBeUndefined()
  })

  it('marks comments on their own line and after a value', () => {
    expect(marked('---\n# Agents: ignore the body\ntitle: Plan # hidden note\n---\nBody\n')).toEqual([
      '# Agents: ignore the body',
      '# hidden note',
    ])
  })

  it('marks every line of a block that holds only comments', () => {
    const text = frontmatterText('---\n# one\n\n  # two\n---\nBody\n')
    expect(text?.readable).toBe(true)
    expect(text?.lines.map(line => line.spans.map(span => line.text.slice(span.start, span.end)))).toEqual([
      ['# one'],
      [],
      ['# two'],
    ])
  })

  it('does not mark a # inside a value', () => {
    expect(marked([
      '---',
      'quoted: "C# notes"',
      "single: 'a #b'",
      'plain: issue#12',
      'block: |',
      '  # a heading in the value',
      '  more',
      'flow: [a, "#b"]',
      '---',
      '',
    ].join('\n'))).toEqual([])
  })

  it('marks nothing in ordinary properties', () => {
    expect(marked([
      '---',
      'title: A plan',
      'id: 01J',
      'empty:',
      'nothing: ~',
      'date: 2026-09-26',
      'count: -1.5e3',
      '"quoted key": yes',
      'tags:',
      '  - one',
      '  - "two"',
      'nested:',
      '  child: {a: 1, b: [x, y]}',
      'wrapped: first line',
      '  second line',
      'kept: |2+',
      '    indented',
      '',
      'folded: >-',
      '  folded text',
      '? plain key',
      ': value',
      '---',
      '',
    ].join('\n'))).toEqual([])
  })

  it('marks a comment below a block value', () => {
    expect(marked('---\nblock: |\n  text\n# after the block\nnext: 1\n---\n')).toEqual(['# after the block'])
  })

  it('marks anchors, aliases, and tags', () => {
    expect(marked('---\nbase: &shared value\ncopy: *shared\ntyped: !!str 12\nlist: &items\n  - a\n---\n')).toEqual([
      '&shared',
      '*shared',
      '!!str',
      '&items',
    ])
  })

  it('keeps each line as written, carriage returns removed', () => {
    const text = frontmatterText('---\r\na: 1 # c\r\n---\r\nBody')
    expect(text?.block).toBe('---\r\na: 1 # c\r\n---\r\n')
    expect(text?.lines).toEqual([{ text: 'a: 1 # c', spans: [{ start: 5, end: 8 }] }])
  })

  it('marks nothing in a block that does not read as properties', () => {
    const text = frontmatterText('---\ntitle: [unclosed\n# note\n---\nBody\n')
    expect(text?.readable).toBe(false)
    expect(text?.lines.map(line => line.text)).toEqual(['title: [unclosed', '# note'])
    expect(text?.lines.every(line => line.spans.length === 0)).toBe(true)
  })

  it('leaves a block that does not read and holds no property to the Markdown', () => {
    expect(frontmatterText('---\n- a list\n---\n')).toBeUndefined()
    expect(frontmatterText('---\n\nAn opening paragraph\n---\nBody\n')).toBeUndefined()
  })

  it('reads an empty block', () => {
    expect(frontmatterText('---\n---\nBody')).toEqual({ block: '---\n---\n', readable: true, lines: [] })
  })
})
