import { expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { parseRichdocMarkdown } from './import-export.js'
import { parseWork } from './parse-work.fixture.js'

// The importer's work grows linearly with the note it reads. These shapes
// repeat each piece of syntax it reads alone, with a letter or a space, in
// pairs, before one closer, and inside containers and beside blocks, and fail
// when doubling a shape makes the importer read more than 2.2 times as many
// characters. The pairs and longer shapes are sampled, the same ones each run.
//
// Each character marked, Tiptap or dohc's extensions read as syntax, with
// `\r`, the line and paragraph separators, which marked's `.` does not match,
// a no-break space, and the sentinels' private-use character.
const CHARACTERS = [
  '*', '_', '~', '`', '=', '+', '$', '\\', '[', ']', '(', ')', '{', '}', '<', '>', '!', '#', '|', '-', ':', '&', '@',
  '.', '/', '"', "'", '?', ';', '1', ' ', '\t', '\n', '\r',
  ...[0x2028, 0x2029, 0xa0, 0xe000].map(code => String.fromCharCode(code)),
]
// The longer openers and closers those read.
const TOKENS = [
  '{{atom:', '<!--', '-->', '<?', '<!a ', '<![CDATA[', ']]>', '&#91;', '&amp;', 'http://', 'www.', '[x]: /u\n',
  '> [!note] ', '- [ ] ', '  \n', '\n===', '\n---', '\n    ', '<b>', '</b>', '<a b="', '```', '~~~', '$$\n',
  '\n| - |\n', '<!-- dohc:table row-heights=1:8 -->\n',
]
const UNITS = [...CHARACTERS, ...TOKENS]
const CONTAINERS = ['> ', '- ', '1. ', '- [ ] ', '\t']
const NEIGHBOURS: Array<(text: string) => string> = [
  text => `$$a\n${text}`,
  text => `${text}\n===`,
  text => `| a |\n| - |\n${text}`,
]
const SIZES = [256, 512, 1_024]

type Shape = { name: string; text: (repetitions: number) => string }

// A small seeded generator, so each run reads the same shapes.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const repeated = (unit: string): Shape => ({ name: JSON.stringify(unit), text: repetitions => unit.repeat(repetitions) })
const closed = (unit: string, end: string): Shape => ({
  name: `${JSON.stringify(unit)} then ${JSON.stringify(end)}`,
  text: repetitions => unit.repeat(repetitions) + end,
})
// Every shape the importer once read in quadratic time, which the samples
// below need not draw.
const [LINE_SEPARATOR, PARAGRAPH_SEPARATOR] = [0x2028, 0x2029].map(code => String.fromCharCode(code))
const FIXED: Shape[] = [
  ...['a*', 'a@', '[', '[[', 'a[[', '{{atom:', '$', '$$a\n', '*a ', '_a ', '~a ', '*.txt ', '[](', '[a](', '\\[', 'a<!--'].map(repeated),
  ...[
    ['*a ', 'a*'], ['_a ', 'a_'], ['~a ', 'a~'], ['\\[ *a ', 'a*'], ['*', '&'], ['_', '~'], ['\\```', '@'],
    ['.<?', ''], ['.<!a ', ''], ['.<![CDATA[', ''], ['.www.', ''], ['[x] ', '\n\n[x]: /u'],
    ...[LINE_SEPARATOR, PARAGRAPH_SEPARATOR].flatMap(separator => [
      ['$$a\n', `x${separator}\n---`], ['a\n$$b\n', `x${separator}\n---`], ['$$', `${separator}\n===`],
    ]),
    ['|\n| - |\n', ''], ['*\n| - |\n', ''], ['<!a ]]>', '\n---'],
  ].map(([unit, end]) => closed(unit!, end!)),
  { name: '"*" then as many " a*"', text: repetitions => `${'*'.repeat(repetitions)}${' a*'.repeat(repetitions)}` },
]
const ALONE = UNITS.map(repeated)
const WITH_LETTER = UNITS.map(unit => repeated(`${unit}a`))
const WITH_SPACE = UNITS.map(unit => repeated(`${unit} `))
const PAIRS = UNITS.flatMap(first => UNITS.map(second => repeated(first + second)))
const BASES = [...ALONE, ...WITH_LETTER, ...WITH_SPACE, ...PAIRS]

// `count` different items, the same ones each run.
function sample<T>(items: readonly T[], count: number, seed: number): T[] {
  const next = random(seed)
  const picked = [...items]
  for (let at = 0; at < count; at += 1) {
    const other = at + Math.floor(next() * (picked.length - at));
    [picked[at], picked[other]] = [picked[other]!, picked[at]!]
  }
  return picked.slice(0, count)
}

const depth = (node: JSONContent): number => 1 + Math.max(0, ...(node.content ?? []).map(depth))

// A shape each repetition of which opens a container inside the last, such
// as `>` or `- [ ] `, nests as deep as it repeats. marked reads the rest of
// the text again at each level, and the importer refuses such a note only
// once marked has read them all, past a depth of 128, so its work grows as its
// depth times its length.
function nests(shape: Shape): boolean {
  const at = (repetitions: number) => {
    try {
      return depth(parseRichdocMarkdown(shape.text(repetitions)))
    } catch {
      return Infinity
    }
  }
  return at(16) > at(8)
}

// The characters each size reads, and whether any doubling grew by more
// than 2.2 times.
function growth(shape: Shape): { work: number[]; grows: boolean } {
  const work = SIZES.map(repetitions => parseWork(() => {
    try {
      parseRichdocMarkdown(shape.text(repetitions))
    } catch {
      // A note the importer refuses still costs the work it did.
    }
  }))
  return { work, grows: work.some((at, index) => index > 0 && at > work[index - 1]! * 2.2) }
}

function expectLinear(shapes: Shape[]): void {
  const grown = shapes.filter(shape => !nests(shape)).flatMap(shape => {
    const { work, grows } = growth(shape)
    return grows ? [`${shape.name}: ${work.join(' -> ')}`] : []
  })
  expect(grown, `${grown.length} of ${shapes.length} shapes grow faster than linearly`).toEqual([])
}

const SINGLES = [...ALONE, ...WITH_LETTER, ...WITH_SPACE]
const SAMPLED_PAIRS = sample(PAIRS, 800, 1)
const nextCloser = random(2)
const CLOSED = sample(BASES, 800, 3).map(shape => {
  const closer = UNITS[Math.floor(nextCloser() * UNITS.length)]!
  return { name: `${shape.name} then ${JSON.stringify(closer)}`, text: (repetitions: number) => shape.text(repetitions) + closer }
})
const nextPlace = random(4)
const PLACED = sample(BASES, 400, 5).map((shape): Shape => {
  const closer = UNITS[Math.floor(nextPlace() * UNITS.length)]!
  const container = CONTAINERS[Math.floor(nextPlace() * CONTAINERS.length)]!
  const neighbour = NEIGHBOURS[Math.floor(nextPlace() * NEIGHBOURS.length)]!
  return nextPlace() < 0.5
    ? { name: `${JSON.stringify(container)} then ${shape.name} then ${JSON.stringify(closer)}`, text: repetitions => container + shape.text(repetitions) + closer }
    : { name: `${shape.name} beside a block, then ${JSON.stringify(closer)}`, text: repetitions => neighbour(shape.text(repetitions) + closer) }
})

it('reads each shape it once read quadratically in a linear amount of work', () => {
  expectLinear(FIXED)
})

it('reads each special character and token repeated in a linear amount of work', () => {
  expectLinear(SINGLES)
})

it('reads repeated pairs of them in a linear amount of work', () => {
  expectLinear(SAMPLED_PAIRS)
})

it('reads them before one closer or terminator in a linear amount of work', () => {
  expectLinear(CLOSED)
})

it('reads them inside containers and beside blocks in a linear amount of work', () => {
  expectLinear(PLACED)
})
