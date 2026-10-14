import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { createHash } from 'node:crypto'
import { createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'
import { markdownToYDoc, yDocToMarkdown, serializeRichdocBody, parseRichdocMarkdown } from './import-export.js'

const corpus = JSON.parse(readFileSync(new URL('../../../tools/rust-engine-program/nested-markdown-contract.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; source: string; canonical?: string; sourceCanonical?: string; witnessSeed?: boolean; foldRefuse?: boolean; refuse?: boolean; projected?: boolean; rustBase64?: string }>
}
it.each(corpus.cases)('shares the nested Markdown contract for $name', item => {
  if (item.refuse) {
    expect(() => markdownToYDoc(item.source)).toThrow(/not representable/)
    return
  }
  const doc = markdownToYDoc(item.source, { reading: item.projected ? 'projection' : 'source' })
  try { expect(yDocToMarkdown(doc)).toBe(item.sourceCanonical ?? item.canonical) }
  finally { doc.destroy() }
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
    if (item.witnessSeed) expect(replay.getMap('meta').get('dohcMarkdownSource')).toBe(item.source)
    const expectedMarkdown = replay.getMap('meta').has('dohcMarkdownSource') ? item.source : item.canonical!
    expect(registration(input)).toMatchObject({ kind: 'accepted', evidence: { projectedMarkdown: expectedMarkdown } })
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
it.each(corpus.cases.filter(item => !item.refuse))('fix1 accepts its canonical output for $name unchanged', item => {
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
