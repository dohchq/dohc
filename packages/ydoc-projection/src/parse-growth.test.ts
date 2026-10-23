import { expect, it } from 'vitest'
import { Lexer } from 'marked'
import type { JSONContent } from '@tiptap/core'
import { parseRichdocMarkdown } from './import-export.js'
import { IMPORTER_RULES, MODELLED, parseWork } from './parse-work.fixture.js'

// The importer's work grows linearly with the note it reads. These shapes
// repeat each piece of syntax it reads alone, with a letter or a space, in
// pairs, before one closer, and inside containers and beside blocks, and fail
// when doubling a shape makes the importer read more than 2.2 times as many
// characters, or when it runs a pattern the counter has no model for. The
// pairs and longer shapes are sampled, the same ones each run.
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
const NEIGHBOURS: Array<[string, (text: string) => string]> = [
  ['after display math', text => `$$a\n${text}`],
  ['before a setext underline', text => `${text}\n===`],
  ['after a table', text => `| a |\n| - |\n${text}`],
]
const SIZES = [256, 512, 1_024]
// A wide timeout: the sweep reads thousands of notes, counting each read.
const SWEEP_MS = 600_000

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
const [LINE_SEPARATOR, PARAGRAPH_SEPARATOR, NO_BREAK_SPACE] = [0x2028, 0x2029, 0xa0].map(code => String.fromCharCode(code))
const FIXED: Shape[] = [
  ...['a*', 'a@', '[', '[[', 'a[[', '{{atom:', '$', '$$a\n', '*a ', '_a ', '~a ', '*.txt ', '[](', '[a](', '\\[', 'a<!--', `${NO_BREAK_SPACE}  \n`]
    .map(repeated),
  ...[
    ['*a ', 'a*'], ['_a ', 'a_'], ['~a ', 'a~'], ['\\[ *a ', 'a*'], ['*', '&'], ['_', '~'], ['\\```', '@'],
    ['.<?', ''], ['.<!a ', ''], ['.<![CDATA[', ''], ['.www.', ''], ['[x] ', '\n\n[x]: /u'],
    ...[LINE_SEPARATOR, PARAGRAPH_SEPARATOR].flatMap(separator => [
      ['$$a\n', `x${separator}\n---`], ['a\n$$b\n', `x${separator}\n---`], ['$$', `${separator}\n===`],
    ]),
    ['|\n| - |\n', ''], ['*\n| - |\n', ''], ['<!a ]]>', '\n---'],
  ].map(([unit, end]) => closed(unit!, end!)),
  { name: '"*" then as many " a*"', text: repetitions => `${'*'.repeat(repetitions)}${' a*'.repeat(repetitions)}` },
  // White space inside an HTML block, a tag's value and a definition's title.
  ...[['<div>', 'x\n'], ['a <b c="', 'x">\n'], ['[x]: /u "', 'x"\n']].map(([start, end]): Shape => ({
    name: `${JSON.stringify(start)} then as many spaces`,
    text: repetitions => `${start}${' '.repeat(repetitions)}${end}`,
  })),
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

// The sampled shapes each repetition of which opens a container inside the
// last, and whose work grows faster than their length. marked reads a
// container's text again for each container inside it, and the importer
// refuses a note past a depth of 128 only once marked has read it all, so
// their work grows as their depth times their length; inside a paragraph
// that a setext underline ends, as the square of their depth times their
// length. A stack overflow ends each before about 1,600 levels. `measured` is
// the most each grew in one doubling when listed, which shifts slightly with
// what the importer cached before; each may grow no faster than `bound`, a
// doubling of each factor.
const LEVELS = 'Each repetition opens a container in the last, which marked lexes again'
const SETEXT = `${LEVELS}, and each level's paragraph reads to the underline again`
const NESTING: ReadonlyArray<{ name: string; unit: string; measured: number; bound: number; reason: string; around?: (text: string) => string }> = [
  { name: '">"', unit: '>', measured: 3.97, bound: 4, reason: LEVELS },
  { name: '">\\t"', unit: '>\t', measured: 3.98, bound: 4, reason: LEVELS },
  { name: '"- [ ] "', unit: '- [ ] ', measured: 3.97, bound: 4, reason: LEVELS },
  { name: '"- [ ]  "', unit: '- [ ]  ', measured: 3.97, bound: 4, reason: LEVELS },
  { name: '"- [ ] - [ ] "', unit: '- [ ] - [ ] ', measured: 3.87, bound: 4, reason: LEVELS },
  { name: '"- [ ] >"', unit: '- [ ] >', measured: 3.92, bound: 4, reason: LEVELS },
  { name: '"- [ ]  " then ";"', unit: '- [ ]  ', measured: 3.96, bound: 4, reason: LEVELS, around: text => `${text};` },
  {
    name: '"- [ ] - [ ] " then "<!-- dohc:table row-heights=1:8 -->\\n"', unit: '- [ ] - [ ] ', measured: 3.87, bound: 4, reason: LEVELS,
    around: text => `${text}<!-- dohc:table row-heights=1:8 -->\n`,
  },
  { name: '"- [ ] \\t" then "&amp;"', unit: '- [ ] \t', measured: 3.96, bound: 4, reason: LEVELS, around: text => `${text}&amp;` },
  { name: '">>" before a setext underline, then "}"', unit: '>>', measured: 7.89, bound: 8, reason: SETEXT, around: text => `${text}}\n===` },
]
const EXEMPT = new Set(NESTING.map(({ name }) => name))

// The characters each size reads, whether any doubling grew by more than
// 2.2 times, and the patterns it ran that the counter has no model for.
function growth(shape: Shape): { work: number[]; ratio: number; unmodelled: string[] } {
  const by = new Map<string, number>()
  const work = SIZES.map(repetitions => parseWork(() => {
    try {
      parseRichdocMarkdown(shape.text(repetitions))
    } catch {
      // A note the importer refuses still costs the work it did.
    }
  }, by))
  const ratio = Math.max(...work.slice(1).map((at, index) => at / work[index]!))
  return { work, ratio, unmodelled: [...by.keys()].filter(key => key.startsWith('unmodelled ')) }
}

// Each shape no nesting exception names that grows faster than linearly or
// runs an unmodelled pattern.
function grown(shapes: Shape[]): string[] {
  return shapes.filter(shape => !EXEMPT.has(shape.name)).flatMap(shape => {
    const { work, ratio, unmodelled } = growth(shape)
    return ratio > 2.2 || unmodelled.length ? [`${shape.name}: ${work.join(' -> ')} ${unmodelled.join(', ')}`.trimEnd()] : []
  })
}

function expectLinear(shapes: Shape[]): void {
  const found = grown(shapes)
  expect(found, `${found.length} of ${shapes.length} shapes grow faster than linearly`).toEqual([])
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
  const [beside, neighbour] = NEIGHBOURS[Math.floor(nextPlace() * NEIGHBOURS.length)]!
  return nextPlace() < 0.5
    ? { name: `${JSON.stringify(container)} then ${shape.name} then ${JSON.stringify(closer)}`, text: repetitions => container + shape.text(repetitions) + closer }
    : { name: `${shape.name} ${beside}, then ${JSON.stringify(closer)}`, text: repetitions => neighbour(shape.text(repetitions) + closer) }
})
const SCHEDULED = [FIXED, SINGLES, SAMPLED_PAIRS, CLOSED, PLACED]

it('reads each shape it once read quadratically in a linear amount of work', () => {
  expectLinear(FIXED)
}, SWEEP_MS)

it('reads each special character and token repeated in a linear amount of work', () => {
  expectLinear(SINGLES)
}, SWEEP_MS)

it('reads repeated pairs of them in a linear amount of work', () => {
  expectLinear(SAMPLED_PAIRS)
}, SWEEP_MS)

it('reads them before one closer or terminator in a linear amount of work', () => {
  expectLinear(CLOSED)
}, SWEEP_MS)

it('reads them inside containers and beside blocks in a linear amount of work', () => {
  expectLinear(PLACED)
}, SWEEP_MS)

it('excepts only the listed shapes that nest, each no faster than its bound', () => {
  const scheduled = new Map(SCHEDULED.flat().map(shape => [shape.name, shape]))
  for (const { name, bound } of NESTING) {
    const shape = scheduled.get(name)
    expect(shape, name).toBeDefined()
    // An error never makes a shape an exception: both depths parse.
    expect(depth(parseRichdocMarkdown(shape!.text(16))), name).toBeGreaterThan(depth(parseRichdocMarkdown(shape!.text(8))))
    expect(growth(shape!).ratio, name).toBeLessThanOrEqual(bound)
  }
}, SWEEP_MS)

it('does not except a shape that nests unless the list names it', () => {
  expect(grown([{ name: 'a shape the list does not name', text: repetitions => '>'.repeat(repetitions) }])).toHaveLength(1)
})

// Each exception's containers at a fixed depth, repeated, read linearly.
it('reads the listed shapes at a fixed depth in a linear amount of work', () => {
  const fixed = NESTING.map(({ name, unit, around = text => text }): Shape => ({
    name: `${name} at a fixed depth`,
    text: repetitions => around(`${unit.repeat(8)}a\n`.repeat(repetitions)),
  }))
  expectLinear(fixed)
}, SWEEP_MS)

// What the counter charges one search: a fresh copy of `pattern`, from the
// start of `input`.
const charged = (pattern: RegExp, input: string) => {
  const copy = new RegExp(pattern.source, pattern.flags)
  return parseWork(() => copy.exec(input))
}

it('charges a pattern it has no model for the rest of the text, even when it fails or looks ahead', () => {
  const by = new Map<string, number>()
  expect(parseWork(() => /^a+b/.exec(`${'a'.repeat(100)}c`), by)).toBe(101)
  expect([...by.keys()]).toEqual(['unmodelled /^a+b/'])
  expect(charged(/^a(?=b+c)/, `a${'b'.repeat(100)}c`)).toBe(102)
  // A pattern with no unbounded repetition still counts each attempt.
  expect(charged(/^ab/, 'ac')).toBe(1)
  expect(charged(/ab/, 'xxab')).toBe(4)
})

// Each modelled pattern, before text its model's reads stop short of. Each
// charges at least `reads`, what the pattern itself reads there, and less than
// the rest of the text, or, with `beyond`, more than one per attempt. The
// counter charges marked's masks a copy of the text besides.
const INLINE = Lexer.rules.inline.gfm
const BLOCK = Lexer.rules.block.gfm
const A = 'a'.repeat(40)
const SPACES = ' '.repeat(40)
const END = `\n\n\n${'z'.repeat(100)}`
const runs = (text: string) => text.slice(text.indexOf('|') + 1)
// The importer's sentinel pattern, spelled with the escapes its source holds,
// and a sentinel left open after its digits.
const SENTINEL = ['', 'uE000DOHC_PARSE_', 'd+', 'uE001'].join('\\')
const UNCLOSED_SENTINEL = `${String.fromCharCode(0xe000)}DOHC_PARSE_${'1'.repeat(40)}`
type Check = { pattern: RegExp; input: string; reads: number; beyond?: true }
const check = (pattern: RegExp | string, input: string, reads: number, beyond?: true): Check =>
  ({ pattern: typeof pattern === 'string' ? new RegExp(pattern) : pattern, input, reads, ...beyond && { beyond } })
const CHECKS: Check[] = [
  check(BLOCK.heading, `# ${A}${END}`, 42),
  check(BLOCK.text, `${A}${END}`, 40),
  check(/^ */u, `${SPACES}${END}`, 40),
  check(BLOCK.newline, `${' \n'.repeat(20)}z${END}`, 40),
  ...[BLOCK.hr, ...[0, 1, 2, 3].map(n => `^ {0,${n}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`),
    /^(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u,
    /^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:```|~~~)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:\*[ \t]*){3,}$|<[a-zA-Z!/])/,
  ].map(pattern => check(pattern, `${'- '.repeat(20)}x${END}`, 40)),
  check(/^(?:\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u, `${'* '.repeat(20)}x${END}`, 40),
  ...[/^[ \t]*$/, /^[ \t]*$/u, /^[ \t]*\n/u, /^[ \t]*/u].map(pattern => check(pattern, `${SPACES}x${END}`, 40)),
  ...[/^[ \t|:]*-[ \t|:-]*$/, /^[ \t|:]*-[ \t|:-]*$/u].map(pattern => check(pattern, `${'|-'.repeat(20)}x${END}`, 40)),
  ...[/^ *-+: *$/, /^ *:-+: *$/, /^ *:-+ *$/].map(pattern => check(pattern, `:${'-'.repeat(40)}x${END}`, 41)),
  check(/ {0,3}(?:\| *)?:?-/y, `|${SPACES}x${END}`, 41),
  ...[/^ {0,3}(`{3,}|~{3,})/, /^(?:`{3,}|~{3,})/u, /^(?:`{3,}|~{3,})/, /^([`~]+|[^`~])/]
    .map(pattern => check(pattern, `${'`'.repeat(40)}x${END}`, 40)),
  check(INLINE.emStrongLDelim, `${'*'.repeat(40)}x${END}`, 40),
  check(/^(\s+)(?:```)/, `${SPACES}x${END}`, 40),
  check(/^[A-Za-z ]+$/u, `${A}1${END}`, 40),
  check(/^&#(\d+);$/, `&#${'1'.repeat(40)}x${END}`, 42),
  ...[/^\[[ xX]\] +\S/, /^\[[ xX]\] +/, /^\[[ xX]\][ \t]+/u, /^\[([ xX])\][ \t]*(?:\n|$)/u].map(pattern => check(pattern, `[x]${SPACES}\n${END}`, 43)),
  check(/^(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)/u, `-${SPACES}x${END}`, 41),
  check(/^[ \t]*(?:(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)?/u, `${SPACES}-${SPACES}x${END}`, 81),
  check(/^(\s*)[-+*]\s+\[([ xX])\]\s+/, `${' \n'.repeat(20)}- [x]y${END}`, 45),
  check(/^<\/[\s]*[\w-]+/i, `</${A}${END}`, 42),
  check(/^<[\s]*([\w-]+)(\s|>|\/|$)/i, `<${A}!${END}`, 41),
  check(/^<\/\s*([\w-]+)/, `</${SPACES}a${END}`, 43),
  check(/[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/y, `${A}!${END}`, 40),
  ...[new RegExp(SENTINEL, 'uy'), new RegExp(`^${SENTINEL}`, 'u')].map(pattern => check(pattern, `${UNCLOSED_SENTINEL}x${END}`, 52)),
  check(/^<!-- dohc:table row-heights=(\d+:\d+(?:,\d+:\d+)*) -->[ \t]*(?:\n+|$)/u, `<!-- dohc:table row-heights=${'1:2,'.repeat(10)}x${END}`, 68),
  check(BLOCK.list, `- ${A}${END}`, 42),
  check(/^[ ]*(?:[-+*]|[0-9]{1,9}[.)])(?: \[([ xX])\])? *\n/u, `- ${SPACES}x${END}`, 42),
  check(/^[ ]*[-+*] \[([ xX])\] *\n?$/u, `- [x]${SPACES}y${END}`, 45),
  ...[0, 1, 2, 3].map(n => check(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`, `- ${A}${END}`, 42)),
  ...['\\-', '\\+', '\\*', '\\d{1,9}\\.', '\\d{1,9}\\)'].map((bullet, index) =>
    check(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`, `${['-', '+', '*', '1.', '1)'][index]} ${A}${END}`, 42)),
  check(/^<(.*)>$/, `<${A}${END}`, 41),
  ...[0, 1, 2, 3].map(n => check(new RegExp(`^ {0,${n}}<(?:[a-z].*>|!--)`, 'i'), `<a${A}${END}`, 42)),
  check(/^\[!([^\]\n]+)\]([+-]?)[ \t]*(.*)$/, `[!${A}${END}`, 42),
  check(/^([ \t]*)([^\n]*)$/u, `${A}${END}`, 40),
  check(/^([ \t]*(?:>[ \t]*)*(?:(?:[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|[0-9]{1,9}[.)][ \t]+)(?:>[ \t]*)*)*)([^\n]*)$/u, `${A}${END}`, 40),
  check(BLOCK.fences, `\`\`\`${'a'.repeat(20)}\`${END}`, 24),
  check(BLOCK.code, `    ${A}\nz${END}`, 45),
  check(BLOCK.blockquote, `> ${'a'.repeat(20)}\n\`\`\`${'b'.repeat(20)}\n${END}`, 47),
  check(BLOCK.table, `${A}\n|${SPACES}x${END}`, 82),
  check(IMPORTER_RULES.paragraph, `${'a'.repeat(20)}\n${'b'.repeat(20)}\n|-|\n${END}`, 45),
  check(BLOCK.html, `<a${' b'.repeat(20)}${END}`, 42),
  ...[
    /^(?:(?:[-+*]|[0-9]{1,9}[.)]) (?:\[[ xX]\] )?[A-Za-z][^\n\t]*(?:\n|$))+(?:\n[A-Za-z][^\n\t]*\n?)?$/u,
    /^([-+*]) [A-Za-z][^\n\t]*(?:\n\1 [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u,
    /^(?:(?:[-+*]|[0-9]{1,9}[.)]) (?![ \t]*(?:\n|$))[^\n\[]+(?:\n|$))+(?:\n|$)(?![ \t\n0-9*+-])/u,
  ].map(pattern => check(pattern, `${'- a\n'.repeat(10)}${END}`, 40)),
  check(/^([-+*]) \[[ xX]\] [A-Za-z][^\n\t]*(?:\n\1 \[[ xX]\] [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u, `${'- [ ] a\n'.repeat(10)}${END}`, 80),
  check(/^[0-9]{1,9}([.)]) [A-Za-z][^\n\t]*(?:\n[0-9]{1,9}\1 [A-Za-z][^\n\t]*)*(?=\n\n[A-Za-z]|\n?$)/u, `${'1. a\n'.repeat(10)}${END}`, 50),
  check(BLOCK.def, `[${A}]: /u "${A}${END.replace('\n', '"')}`, 89),
  check(BLOCK.lheading, `${A}\n===${END}`, 44),
  check(INLINE.reflink, `[${A}][${A}[${END}`, 84),
  check(INLINE.nolink, `[${A}[${END}`, 41),
  check(INLINE.link, `[${'a'.repeat(20)}](${'b'.repeat(20)} "${'c'.repeat(20)}"<${END}`, 66),
  check(INLINE.autolink, `<${A}<${END}`, 41),
  check(INLINE.tag, `<a b="${A}"<${END}`, 46),
  check(INLINE.code, `\`a\`${END}`, 3),
  check(INLINE.url, `${A}@!${END}`, 41),
  check(INLINE.br, `  \n${SPACES}x${END}`, 43),
  check(/( {2,}|\\)\n/y, `${SPACES}\n${END}`, 41),
  check(IMPORTER_RULES.text, `${'a'.repeat(20)}${' '.repeat(20)}\n${END}`, 41),
  check(/^(\+\+)([\s\S]+?)(\+\+)/, `++${A}++${END}`, 44),
  check(INLINE.emStrongRDelimAst, `${A}* *_*_*_${END}`, 41),
  check(runs(INLINE.emStrongRDelimAst.source), `${A}* *_*_*_${END}`, 41),
  check(INLINE.emStrongRDelimUnd, `${A}_ *_*_*_${END}`, 41),
  check(runs(INLINE.emStrongRDelimUnd.source), `${A}_ *_*_*_${END}`, 41),
  check(INLINE.delRDelim, `${A}~${END}`, 41),
  check(/[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/uy, `${A}__${A}*${A}_*_*_${END}`, 124),
  check(/[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/uy, `${A}**${A}_${A}*_*_${END}`, 124),
  check(/[^~]+(?=[^~])/uy, `${A}~${END}`, 41),
  check(INLINE.reflinkSearch, `x[${A}][${A}[${END}`, 85),
  check(INLINE.blockSkip, `x[${'a'.repeat(20)}](${'b'.repeat(20)}(${'z'.repeat(20)}`, 44, true),
  ...[new RegExp(SENTINEL, 'gu'), new RegExp(`${SENTINEL}|&(?:amp|lt|gt);`, 'gu')]
    .map(pattern => check(pattern, `${UNCLOSED_SENTINEL}x${END}`, 52, true)),
  check(/&(?:#(\d+)|(amp|lt|gt));/g, `&#${'1'.repeat(40)}x${END}`, 42, true),
  check(/^\||\| *$/g, `x|${SPACES}y${END}`, 40, true),
  check(/\s+/g, `a${SPACES}${A}${END}`, 41),
  check(/\n[^\S\n]*(?:\n[^\S\n]*)+$/, `a\n${SPACES}x${END}`, 40, true),
  check(/\n+$/u, `a${'\n'.repeat(40)}x`, 40, true),
  ...[/\n[ \t]*$/, /\n[ \t]*\n$/u, /\n[ \t]*\n[ \t]*$/].map(pattern => check(pattern, `a\n${SPACES}x${END}`, 40, true)),
  ...[/\n {0,3}(?:=+|-+) *(?:\n|$)/g, /\n {0,3}((?:=+|-+) *)(?=\n|$)/g].map(pattern => check(pattern, `a\n${'='.repeat(40)}x`, 40, true)),
  check(IMPORTER_RULES.interrupt, `a\n<${A}\nz`, 40, true),
]

const MASKS = new Set([INLINE.reflinkSearch, INLINE.blockSkip])

it.each(CHECKS.map(entry => [entry.pattern.source.slice(0, 60), entry] as const))('charges %s what it reads', (_source, { pattern, input, reads, beyond }) => {
  const work = charged(pattern, input) - (MASKS.has(pattern) ? input.length : 0)
  if (beyond) {
    expect(work).toBeGreaterThanOrEqual(input.length + reads)
  } else {
    expect(work).toBeGreaterThanOrEqual(reads)
    expect(work).toBeLessThan(input.length)
  }
})

it('checks each modelled pattern', () => {
  const checked = new Set(CHECKS.map(({ pattern }) => pattern.source))
  expect([...MODELLED].filter(([source, model]) => model !== 'rest' && !checked.has(source)).map(([source]) => source)).toEqual([])
})
