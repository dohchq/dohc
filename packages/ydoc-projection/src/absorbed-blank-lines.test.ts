import { expect, it } from 'vitest'
import type { MarkdownToken } from '@tiptap/core'
import { extractAbsorbedBlankLines } from '@tiptap/markdown'

// The pinned @tiptap/markdown matched this pattern against each token's raw,
// which read the white space after each line break to the end of the text
// again. The patch finds the same suffix in one backward pass.
const TRAILING_BLANK_LINES = /\n[^\S\n]*(?:\n[^\S\n]*)+$/

function original(tokens: MarkdownToken[]): MarkdownToken[] {
  return tokens.flatMap((token, index) => {
    if (token.type === 'space' || tokens[index + 1]?.type === 'space') return [token]
    const trailingBlankLines = (token.raw || '').match(TRAILING_BLANK_LINES)
    if (!trailingBlankLines) return [token]
    return [
      { ...token, raw: (token.raw || '').slice(0, -trailingBlankLines[0].length) },
      { type: 'space', raw: trailingBlankLines[0] } as MarkdownToken,
    ]
  })
}

// Every white space character `\s` and `trimEnd` share, the characters next
// to them that are not white space, and letters.
const WHITE_SPACE = ['\n', '\r', ' ', '\t', '\v', '\f', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿']
const OTHER = ['a', '{', '\u0085', '᠎', '​']

it.each([
  ['paragraph\n  \n', true],
  ['a\n\n', true],
  ['a\r\n\r\n', true],
  ['a\n\t\n ', true],
  ['a\n　\n \n', true],
  ['a\n \n \n{', false],
  ['a\n', false],
  ['a\n  ', false],
  ['a  \n', false],
  ['\n\n', true],
  ['a\n\nb\n', false],
  ['a\n​\n', false],
  ['a\n\u0085\n', false],
  ['a\r\r', false],
  ['', false],
])('splits trailing blank lines from %j as the original did', (raw, split) => {
  const tokens = [{ type: 'paragraph', raw, text: raw.trim(), tokens: [] }] as MarkdownToken[]
  const read = extractAbsorbedBlankLines(tokens)
  expect(read).toEqual(original(tokens))
  expect(read.length).toBe(split ? 2 : 1)
})

it('reads every token list as the original pattern did', () => {
  let seed = 7
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
  const text = () => {
    let raw = next() < 0.5 ? pick(OTHER) : ''
    const length = Math.floor(next() * 12)
    for (let at = 0; at < length; at += 1) raw += next() < 0.8 ? pick(WHITE_SPACE) : pick(OTHER)
    return raw
  }
  for (let round = 0; round < 50_000; round += 1) {
    const tokens = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, at) => ({
      type: next() < 0.2 ? 'space' : pick(['paragraph', 'list', 'blockquote']),
      raw: next() < 0.05 ? undefined : text(),
      text: `text ${at}`,
      ...(next() < 0.5 ? { tokens: [{ type: 'text', raw: 'x' }], depth: at } : {}),
    })) as MarkdownToken[]
    expect(extractAbsorbedBlankLines(tokens), JSON.stringify(tokens)).toEqual(original(tokens))
  }
})
