import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { Lexer, marked } from 'marked'
import { createHash } from 'node:crypto'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import type { JSONContent } from '@tiptap/core'
import { DohcTaskItem, dohcMarkdownExtensions, MarkdownListItem, MarkdownOrderedList, MarkdownTaskList } from './dohc-markdown-extensions.js'
import { createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'
import { markdownToYDoc, MarkdownNestingRefusal, yDocToMarkdown, serializeRichdocBody, parseRichdocMarkdown, getDohcProseMirrorSchema, writeBodyFragment } from './import-export.js'

const corpus = JSON.parse(readFileSync(new URL('../../../tools/rust-engine-program/nested-markdown-contract.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; source: string; canonical?: string; rereadCanonical?: string; sourceCanonical?: string; witnessSeed?: boolean; foldRefuse?: boolean; refuse?: boolean; projected?: boolean; rustBase64?: string; stableTree?: boolean; itemSpaces?: number; later?: boolean; interrupts?: boolean; inItem?: boolean; markedStart?: { type: string; attrs?: Record<string, string | null> }; markedText?: string }>
}
it.each(corpus.cases.filter(item => item.markedStart))('serializes marked leading spaces for $name', item => {
  const root = parseRichdocMarkdown(item.source, 'projection')
  let paragraph: JSONContent = root
  while (paragraph.type !== 'paragraph') paragraph = paragraph.content![0]
  paragraph.content = [{ type: 'text', text: item.markedText!, marks: [item.markedStart!] }]
  expect(serializeRichdocBody(root)).toBe(item.canonical)
  expect(parseRichdocMarkdown(serializeRichdocBody(root), 'projection')).toEqual(parseRichdocMarkdown(item.source, 'projection'))
})
it.each(corpus.cases)('shares the nested Markdown contract for $name', item => {
  if (item.refuse) {
    expect(() => markdownToYDoc(item.source)).toThrow(/not representable/)
    return
  }
  const doc = markdownToYDoc(item.source, { reading: item.projected ? 'projection' : 'source' })
  try { expect(yDocToMarkdown(doc)).toBe(item.sourceCanonical ?? item.canonical) }
  finally { doc.destroy() }
})

it.each(['1.', '1)', '01.', '001)', '2.'])('checks paragraph interruption against Marked for %s', marker => {
  expect(marked.lexer(`Prose\n${marker} item`).map(token => token.type)).toEqual(
    marker === '1.' || marker === '1)' ? ['paragraph', 'list'] : ['paragraph'],
  )
  expect(marked.lexer(`${marker} item`)[0].type).toBe('list')
})

it.each(corpus.cases.filter(item => item.stableTree))('preserves the native and desktop tree for $name', item => {
  const schema = getDohcProseMirrorSchema()
  const original = schema.nodeFromJSON(parseRichdocMarkdown(item.source, item.projected ? 'projection' : 'source')).toJSON()
  expect(schema.nodeFromJSON(parseRichdocMarkdown(item.canonical!, 'projection')).toJSON()).toEqual(original)
  if (item.itemSpaces) {
    const children = original.content[0].content[0].content
    expect(children.map((node: { type: string }) => node.type)).toEqual(
      item.later ? ['paragraph', 'paragraph', 'blockquote'] : ['paragraph', 'blockquote'],
    )
    expect(children[item.later ? 1 : 0].content[0].text).toBe(' '.repeat(item.itemSpaces) + 'literal')
  }
  if (item.interrupts !== undefined) {
    const blocks = item.inItem ? original.content[0].content[0].content : original.content
    expect(blocks.map((node: { type: string }) => node.type)).toEqual(
      item.interrupts ? ['paragraph', 'orderedList'] : ['paragraph'],
    )
  }
  const replay = new Y.Doc()
  try {
    Y.applyUpdate(replay, Buffer.from(item.rustBase64!, 'base64'))
    expect(yXmlFragmentToProseMirrorRootNode(replay.getXmlFragment('body'), schema).toJSON()).toEqual(original)
  } finally { replay.destroy() }
})

it('encodes the first leading space of a top-level paragraph', () => {
  expect(serializeRichdocBody({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '  literal' }] },
  ] })).toBe('&#32; literal')
})
it('combines list and quote XML depth', () => {
  const source = (quotes: number, lists: number) => Array.from({ length: lists }, (_, level) =>
    '> '.repeat(quotes) + '  '.repeat(level) + '- item\n').join('')
  const doc = markdownToYDoc(source(5, 60))
  doc.destroy()
  expect(() => markdownToYDoc(source(9, 60))).toThrow(/not representable/)
})

const policy = {
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000,
}
const registration = createLiveMarkdownRegistrationValidator(policy)
const journal = createLiveMarkdownJournalValidator(policy)
const document = { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage' }
it.each(corpus.cases.filter(item => !item.refuse))('validates the Rust-seeded $name on the wire', item => {
  const checkpoint = Buffer.from(item.rustBase64!, 'base64')
  const replay = new Y.Doc()
  try {
    Y.applyUpdate(replay, checkpoint)
    expect(replay.getMap('meta').get('schemaVersion')).toBe(1)
    expect(yDocToMarkdown(replay)).toBe(item.canonical)
    const input = { document, currentPath: 'tasks/record.md', checkpoint }
    expect(replay.getMap('meta').has('dohcMarkdownSource')).toBe(!!item.witnessSeed)
    const expectedMarkdown = item.witnessSeed ? item.source : item.canonical!
    const verdict = registration(input)
    expect(verdict, JSON.stringify(verdict)).toMatchObject({ kind: 'accepted', evidence: { projectedMarkdown: expectedMarkdown } })
    expect(journal({ ...input, suffix: [], candidate: Y.encodeStateAsUpdate(replay) })).toMatchObject({
      kind: 'accepted', evidence: { projectedMarkdownSha256: createHash('sha256').update(expectedMarkdown).digest('hex') },
    })
  } finally { replay.destroy() }
})


it.each(['Mr. Smith arrived.', 'Dr. Jones', 'St. Louis', 'I. Overview', 'Intro\nMr. Jones', '***', '___', '* * *', '_ _ _', '~~~\ncode\n~~~', '\tliteral'])('fix1 accepts ordinary block lines: %s', source => {
  const doc = markdownToYDoc(source)
  try {
    const canonical = yDocToMarkdown(doc)
    const replay = markdownToYDoc(canonical)
    try { expect(yDocToMarkdown(replay)).toBe(canonical) } finally { replay.destroy() }
  } finally { doc.destroy() }
})
it('fix1 refuses inline nesting before marked can overflow its stack', () => {
  expect(() => markdownToYDoc('- '.repeat(5000) + 'x')).toThrow(/not representable/)
})
it.each(corpus.cases.filter(item => !item.refuse && !item.rereadCanonical))('fix1 accepts its canonical output for $name unchanged', item => {
  const doc = markdownToYDoc(item.canonical!, { reading: 'projection' })
  try { expect(yDocToMarkdown(doc)).toBe(item.canonical) } finally { doc.destroy() }
})

it.each(['- Mr. Smith arrived.', '- I. Overview', '- a. child'])('accepts projected item prose unchanged: %s', source => {
  const doc = markdownToYDoc(source, { reading: 'projection' })
  try { expect(yDocToMarkdown(doc)).toBe(source) } finally { doc.destroy() }
})

it.each(corpus.cases.filter(item => item.name.startsWith('empty-parent-')))('rebuilds $name from the file with its child inside the item', item => {
  const original = parseRichdocMarkdown(item.source)
  const file = serializeRichdocBody(original)
  expect(parseRichdocMarkdown(file, 'projection')).toEqual(original)
})

it.each(['source', 'projection'] as const)('admits an empty child after a same-line quote in %s reading', reading => {
  expect(serializeRichdocBody(parseRichdocMarkdown('- > - \n\n  >    x', reading))).toBe('- \n  > \\- \n\n  >    x')
})

it.each(['-\n     ' + '- '.repeat(5000) + 'x', '1.\n      ' + '- '.repeat(5000) + 'x', '-   a\n      ' + '- '.repeat(5000) + 'x', '1.   a\n       ' + '- '.repeat(5000) + 'x', '-   a\n      - 1. \n\n          x'])('refuses child nesting at the padded marker content column', source => {
  expect(() => markdownToYDoc(source)).toThrow(/not representable/)
})

it.each(['- a\n     &#32;b', '- a\n &#32;b', 'a\n  &#32;x', 'a\n  &#9;x', '- a\n  b &#32;c'])('keeps a whitespace entity outside an item line start: %s', source => {
  expect(JSON.stringify(parseRichdocMarkdown(source))).toContain(source.match(/&#(?:9|32);/u)![0])
})

it.each(['- a\nlazy\ttext', '- a\n b\tc', '1. a\nlazy\ttext'])('keeps a lazy continuation tab in projected reading: %s', source => {
  const original = parseRichdocMarkdown(source)
  const canonical = serializeRichdocBody(original)
  expect(parseRichdocMarkdown(canonical, 'projection')).toEqual(original)
})

it.each(['1.', '-', '- [ ]'])('keeps ordinary item text and trims the final item for %s', marker => {
  for (const [first, last] of [['A  ', 'B'], ['A', 'B  '], ['A\u2028b', 'C'], ['A', 'C\u2029d']]) for (const suffix of ['', '\n\nAfter']) {
    const root = parseRichdocMarkdown(`${marker} ${first}\n${marker === '1.' ? '2.' : marker} ${last}${suffix}`)
    expect(root.content?.[0]?.content?.map(item => item.content?.[0]?.content?.[0]?.text)).toEqual([first, last.trimEnd()])
  }
})

it.each(['1.', '1)'])('keeps ordered checkbox content tabs for %s', marker => {
  const root = parseRichdocMarkdown(`${marker} [ ]\tName\tValue`)
  expect(root.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('[ ]\tName\tValue')
})

it.each(['-', '1.', '- [ ]'])('resolves references in standalone Markdown managers for %s', marker => {
  const manager = new MarkdownManager({ extensions: [
    ...dohcMarkdownExtensions,
    StarterKit.configure({ listItem: false, orderedList: false }),
    MarkdownListItem, MarkdownOrderedList, MarkdownTaskList, DohcTaskItem,
  ] })
  const source = `${marker} See [docs]\n${marker} Next\n\nAfter\n\n[docs]: https://example.com`
  expect(JSON.stringify(manager.parse(source))).toContain('"href":"https://example.com"')
  parseRichdocMarkdown('- ordinary item')
  expect(JSON.stringify(manager.parse(source))).toContain('"href":"https://example.com"')
})

it.each(['-', '1.', '- [ ]'])('resolves later reference definitions in every %s item', marker => {
  for (const source of [
    `${marker} See [docs]\n${marker} Next\n\nAfter\n\n[docs]: https://example.com`,
    `- a\n  ${marker} See [docs]\n\n[docs]: https://example.com`,
    `> ${marker} See [docs]\n> ${marker} Next\n\n[docs]: https://example.com`,
  ]) expect(JSON.stringify(parseRichdocMarkdown(source))).toContain('"href":"https://example.com"')
})

it.each(['source', 'projection'] as const)('refuses bare empty-child chains in %s reading', reading => {
  for (const source of ['- -\n\n x', '1. -\n\n  x', '- -\n\n   x', '- a\n  - -\n\n x']) {
    expect(() => parseRichdocMarkdown(source, reading)).toThrow(/not representable/)
  }
})

it.each(['source', 'projection'] as const)('keeps content-tab emphasis boundaries in %s reading', reading => {
  const literal = parseRichdocMarkdown('- a *b\t* c', reading)
  expect(JSON.stringify(literal)).not.toContain('"marks"')
  expect(serializeRichdocBody(literal)).toBe('- a *b\t* c')
  expect(serializeRichdocBody(parseRichdocMarkdown('- a\t_b_ c', reading))).toBe('- a\t*b* c')
  for (const marker of ['-', '1.', '- [ ]']) {
    const source = `${marker} a\t\n\nAfter`
    expect(serializeRichdocBody(parseRichdocMarkdown(source, reading))).toBe(source)
  }
})

it.each(corpus.cases.filter(item => item.name.startsWith('r24-')))('keeps Marked item boundaries for $name in projected reading', item => {
  const doc = markdownToYDoc(item.source, { reading: 'projection' })
  try { expect(yDocToMarkdown(doc)).toBe((item as typeof item & { projectedCanonical: string }).projectedCanonical) }
  finally { doc.destroy() }
})

it.each(corpus.cases.filter(item => item.name.startsWith('r25-')))('keeps round 25 boundaries for $name in projected reading', item => {
  if (item.refuse) { expect(() => markdownToYDoc(item.source, { reading: 'projection' })).toThrow(/not representable/); return }
  const doc = markdownToYDoc(item.source, { reading: 'projection' })
  try { expect(yDocToMarkdown(doc)).toBe((item as typeof item & { projectedCanonical: string }).projectedCanonical) }
  finally { doc.destroy() }
})

it.each(corpus.cases.filter(item => item.rereadCanonical))('pins the one-time canonical reread for $name', item => {
  for (const reading of ['source', 'projection'] as const) {
    const second = serializeRichdocBody(parseRichdocMarkdown(item.canonical!, reading))
    expect(second).toBe(item.rereadCanonical)
    expect(serializeRichdocBody(parseRichdocMarkdown(second, reading))).toBe(second)
  }
})

// The refusal a note gets, and whether marked lexed any of it first.
function nestingRefusal(source: string, reading: 'source' | 'projection' = 'source'): { limit?: string; lexed: boolean } {
  const lexed = vi.spyOn(Lexer.prototype, 'blockTokens')
  try {
    parseRichdocMarkdown(source, reading)
    return { lexed: lexed.mock.calls.length > 0 }
  } catch (error) {
    if (!(error instanceof MarkdownNestingRefusal)) throw error
    return { limit: error.limit, lexed: lexed.mock.calls.length > 0 }
  } finally {
    lexed.mockRestore()
  }
}
const quoteDepth = (node: JSONContent): number =>
  (node.type === 'blockquote' ? 1 : 0) + Math.max(0, ...(node.content ?? []).map(quoteDepth))

// Each way a line can spell a quote, from its marker on.
const QUOTES = ['> ', '>', '>\t', '   >', ' > ']
it.each(QUOTES)('reads 120 quotes spelled %j and refuses 121 before marked lexes them', quote => {
  expect(quoteDepth(parseRichdocMarkdown(`${quote.repeat(120)}a`))).toBe(120)
  for (const source of [`${quote.repeat(121)}a`, `${quote.repeat(121)}`, `x\n\n${quote.repeat(121)}a\n\ny`]) {
    expect(nestingRefusal(source)).toEqual({ limit: 'depth', lexed: false })
  }
})

// Each container adds a quote or a list's two nodes, so 128 nested nodes is
// the most a line's containers can open; the deepest node may sit at 128.
const CONTAINERS: Array<[string, string, number]> = [
  ['bullets', '- ', 2], ['bullets after tabs', '-\t', 2], ['ordered items', '1. ', 2], ['ordered items with `)`', '2) ', 2],
  ['task items', '- [ ] ', 2], ['quoted items', '> - ', 3], ['bare quoted items', '>- ', 3], ['quoted tasks', '>\t- [x] ', 3],
  ['items spaced to their text', '-    ', 2],
]
it.each(CONTAINERS)('lets marked read 128 nodes of %s and refuses 129 before it does', (_name, unit, nodes) => {
  const at = (depth: number) => unit.repeat(Math.floor(depth / nodes)) + '> '.repeat(depth % nodes) + 'a'
  expect(nestingRefusal(at(126))).toEqual({ lexed: true })
  expect(nestingRefusal(at(128))).toEqual({ limit: 'depth', lexed: true })
  expect(nestingRefusal(at(129))).toEqual({ limit: 'depth', lexed: false })
})

it('reads a node at depth 128 and refuses one at 129', () => {
  expect(nestingRefusal(`${'- '.repeat(63)}> a`)).toEqual({ lexed: true })
  expect(nestingRefusal(`${'- '.repeat(63)}> > a`)).toEqual({ limit: 'depth', lexed: true })
})

it.each([
  ['quotes', '>'.repeat(200_000)],
  ['spaced quotes', '> '.repeat(100_000)],
  ['bullets', '- '.repeat(100_000)],
  ['tasks', '- [ ] '.repeat(50_000)],
  ['ordered items', '1. '.repeat(50_000)],
  ['quotes and bullets', '> - '.repeat(50_000)],
  ['bullets after quotes', `${'>'.repeat(60)}${'- '.repeat(40)}`],
])('refuses %s nested past any depth before marked lexes them', (_name, prefix) => {
  expect(nestingRefusal(`${prefix}a\n`)).toEqual({ limit: 'depth', lexed: false })
})

// Text marked reads literally, however many `>` or markers it holds.
const DEEP = '>'.repeat(200)
it.each([
  ['a backtick fence', `\`\`\`\n${DEEP}\n\`\`\``],
  ['a tilde fence', `~~~~\n${DEEP}\n~~~\n${DEEP}\n~~~~`],
  ['a fence in a quote', `> \`\`\`\n> ${DEEP}\n> \`\`\``],
  ['a fence behind bare quotes', `>>\`\`\`\n>>${DEEP}\n>>\`\`\``],
  ['a fence in an item', `- \`\`\`\n  ${DEEP}\n  \`\`\``],
  ['indented code', `    ${DEEP}\n    ${DEEP}`],
  ['code inside an item', `-      ${DEEP}`],
  ['a paragraph line', `a\n    ${DEEP}`],
  ['an HTML comment', `<!--\n\n${DEEP}\n-->`],
  ['an HTML block', `<div>\n${DEEP}\n</div>`],
  ['display math', `$$\n${DEEP}\n$$`],
  ['a definition title', `[x]: /u "\n${DEEP}\n"`],
  ['a definition destination', `[x]:\n${DEEP}`],
])('keeps the `>` in %s as text', (_name, source) => {
  expect(nestingRefusal(source)).toEqual({ lexed: true })
  expect(JSON.stringify(parseRichdocMarkdown(source))).toContain(DEEP)
})

// Text close to a literal region that marked reads as none, so the quotes
// after it would overflow the stack.
const DEEPER = `${'>'.repeat(2048)} a`
it.each([
  ['an incomplete HTML tag', '<a\n'],
  ['a backtick fence whose info holds a backtick', '```a`b\n'],
  ['unclosed display math', '$$\n'],
  ['an unclosed definition title', '[x]: /u "\n'],
  ['a fence in an item that has ended', '- ```\n  x\n'],
  ['a lone carriage return', 'a\r'],
])('refuses quotes after %s before marked lexes them', (_name, head) => {
  for (const reading of ['source', 'projection'] as const) {
    expect(nestingRefusal(head + DEEPER, reading)).toEqual({ limit: 'depth', lexed: false })
  }
})

// A fence ends only on a line with its opener's containers.
const CODE = `${'>'.repeat(123)} q`
it.each([
  ['a tilde fence', '   ~~~+<b>>[!WARN]\n> > ~~~\n'],
  ['a backtick fence', '```*a*<!DOCTYPE x>é ü\\\n> > ```\n'],
  ['a fence that ends an item holding an HTML block', '- [ ] <? x\n~~~\n?>\n'],
])('keeps quotes in %s as code', (_name, head) => {
  expect(nestingRefusal(head + CODE)).toEqual({ lexed: true })
  expect(JSON.stringify(parseRichdocMarkdown(head + CODE))).toContain(CODE)
})

// An earlier line's item holds these quotes, which the preflight does not
// read; marked's lexing still stops at the limit.
it.each([
  ['a tab', '- a\n\t'],
  ['indentation', '- a\n  - b\n      '],
])('refuses quotes an item holds after %s while marked lexes them', (_name, head) => {
  expect(nestingRefusal(head + DEEPER)).toEqual({ limit: 'depth', lexed: true })
})

// Depth 120 before a setext underline relexes each level's text for each
// level, about 2,400 times the note's length.
const RELEXED = `${'>'.repeat(120)} a\n===\n\n`.repeat(16)
it('refuses a note whose lexing passes the budget in the source reading', () => {
  expect(nestingRefusal(RELEXED)).toEqual({ limit: 'lexing', lexed: true })
  expect(() => markdownToYDoc(RELEXED)).toThrow(/not representable/)
})

it('settles a live note past the lexing budget in the projection reading', () => {
  expect(nestingRefusal(RELEXED, 'projection')).toEqual({ lexed: true })
  expect(quoteDepth(parseRichdocMarkdown(RELEXED, 'projection'))).toBe(120)
}, 60_000)

// A live note the serializer writes deep within the limits, whose lexing in
// the source reading passes the budget.
function quotedNote(quotes: number, bytes: number): Y.Doc {
  const prefix = '> '.repeat(quotes)
  const paragraph = `${prefix}${'word '.repeat(60)}end`
  const source = Array.from({ length: Math.ceil(bytes / paragraph.length) }, () => paragraph).join(`\n${prefix.trimEnd()}\n`)
  expect(nestingRefusal(source)).toEqual({ limit: 'lexing', lexed: true })
  return markdownToYDoc(source, { reading: 'projection' })
}
it.each([[120, 80_000], [30, 200_000]])('validates an edit to a note quoted %i deep in %i bytes', (quotes, bytes) => {
  const doc = quotedNote(quotes, bytes)
  try {
    const checkpoint = Y.encodeStateAsUpdate(doc)
    expect(journal({ document, currentPath: 'notes/deep.md', checkpoint, suffix: [], candidate: new Uint8Array([0, 0]) }))
      .toMatchObject({ kind: 'accepted' })
  } finally { doc.destroy() }
})

it('refuses an edit to a note quoted past the limit in either journal', () => {
  let node: JSONContent = { type: 'paragraph', content: [{ type: 'text', text: 'a' }] }
  for (let quotes = 0; quotes < 121; quotes += 1) node = { type: 'blockquote', content: [node] }
  const doc = markdownToYDoc('a')
  try {
    const body = doc.getXmlFragment('body')
    doc.transact(() => body.delete(0, body.length))
    writeBodyFragment({ type: 'doc', content: [node] }, body)
    const input = { document, currentPath: 'notes/deep.md', checkpoint: Y.encodeStateAsUpdate(doc), suffix: [], candidate: new Uint8Array([0, 0]) }
    expect(journal(input)).toMatchObject({ kind: 'refused', reason: 'invalid-schema' })
    expect(createLiveMarkdownJournalValidator(policy, true)(input)).toMatchObject({ kind: 'refused', reason: 'invalid-schema' })
  } finally { doc.destroy() }
})

it.each(corpus.cases.filter(item => item.name.startsWith('r26-')))('keeps round 26 boundaries for $name in projected reading', item => {
  const doc = markdownToYDoc(item.source, { reading: 'projection' })
  try { expect(yDocToMarkdown(doc)).toBe(item.canonical) }
  finally { doc.destroy() }
})
