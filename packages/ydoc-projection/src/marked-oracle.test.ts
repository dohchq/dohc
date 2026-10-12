import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { emptyLinkRanges } from './import-export.js'

type MarkedOracle = {
  expected: {
    marked: string
    emptyLinks: Array<{
      text: string
      utf16: Array<[number, number]>
      utf8: Array<[number, number]> | null
      utf8Excluded?: string
    }>
  }
}

// The engine's fixture generator has marked 17.0.6 read a shared corpus of
// links with no text, and the engine's projector reads the same one. Ranges
// here are UTF-16 offsets, for every text, including one whose range ends
// between the two halves of a character, which has no UTF-8 ranges.
it('finds the links with no text marked finds in the shared corpus', () => {
  const oracle = JSON.parse(readFileSync(
    new URL('../../../crates/dohc-engine-collab/tests/fixtures/markedOracle.json', import.meta.url),
    'utf8',
  )) as MarkedOracle
  expect(oracle.expected.marked).toBe('17.0.6')
  expect(oracle.expected.emptyLinks.length).toBeGreaterThan(800)
  for (const { text, utf16, utf8, utf8Excluded } of oracle.expected.emptyLinks) {
    expect(text.isWellFormed(), JSON.stringify(text)).toBe(true)
    expect(emptyLinkRanges(text), JSON.stringify(text)).toEqual(utf16)
    // A text has UTF-8 ranges exactly when no range splits a character.
    const splits = utf16.flat().some(at => !text.slice(0, at).isWellFormed())
    expect(utf8 === null, JSON.stringify(text)).toBe(splits)
    expect(utf8Excluded !== undefined, JSON.stringify(text)).toBe(splits)
  }
})
