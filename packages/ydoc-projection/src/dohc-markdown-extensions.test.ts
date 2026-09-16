import { describe, expect, it, vi } from 'vitest'
import { dohcMarkdownExtensions } from './dohc-markdown-extensions.js'

function startFor(name: string): (source: string) => number {
  const start = dohcMarkdownExtensions.find(extension => extension.name === name)
    ?.config.markdownTokenizer?.start
  if (typeof start !== 'function') throw new Error(`Missing tokenizer: ${name}`)
  return start
}

describe('block start searches', () => {
  it.each([
    ['callout', /(?:^|\n)( {0,3}>\s?\[!)/],
    ['mathBlock', /(?:^|\n)(\$\$)/],
  ] as const)('preserves %s marker positions', (name, pattern) => {
    const start = startFor(name)
    const check = (source: string) => {
      const match = pattern.exec(source)
      const expected = match ? (match.index === 0 ? 0 : match.index + 1) : -1
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
