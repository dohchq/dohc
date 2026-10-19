import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { marked } from 'marked'
import { createHash } from 'node:crypto'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import type { JSONContent } from '@tiptap/core'
import { DohcTaskItem, dohcMarkdownExtensions, MarkdownListItem, MarkdownOrderedList, MarkdownTaskList } from './dohc-markdown-extensions.js'
import { createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'
import { markdownToYDoc, yDocToMarkdown, serializeRichdocBody, parseRichdocMarkdown, getDohcProseMirrorSchema } from './import-export.js'

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

it.each(corpus.cases.filter(item => item.name.startsWith('r26-')))('keeps round 26 boundaries for $name in projected reading', item => {
  const doc = markdownToYDoc(item.source, { reading: 'projection' })
  try { expect(yDocToMarkdown(doc)).toBe(item.canonical) }
  finally { doc.destroy() }
})
