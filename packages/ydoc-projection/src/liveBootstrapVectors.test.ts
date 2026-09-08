import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'
import frontmatterFixtures from '../../../crates/dohc-engine-domain/tests/fixtures/collection-frontmatter.json'

const fixture = new URL('../../../crates/dohc-engine-collab/tests/fixtures/live-bootstrap.json', import.meta.url)
// Exercise the actual public Y.Doc representation, including UTF-8 wire normalization.
const scalarStrings = [
  '', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE', 'null', 'Null', 'NULL', '~',
  'yes', 'no', 'on', 'off', 'y', 'n', '0', '-0', '+0', '01', '0o17', '0xFF', '0b10',
  '1_000', '1:20', '1.', '.5', '1e3', '1e+3', '-1e-7', '.inf', '-.Inf', '.NaN',
  '2026-09-08', '2026-09-08T01:02:03Z', ':', '?', '-', '---', '...', '--- x', '... x',
  'a:b', 'a: b', 'a #b', 'a#b', '[a]', '{a}', '&a', '*a', '!a', '|a', '>a', '=a',
  'a\'b', 'a"b', 'a\\b', ' leading', 'trailing ', '\t', '\r', '\r\n', '\n', '\n\n',
  'a\nb', ' a\nb', '\na\n', 'a\n\n', 'a\n b\n', 'a\t#b', 'a:\tb',
  '\0', '\x01', '\x07', '\x08', '\x0b', '\x0c', '\x1b', '\x1f', '\x7f', '\x85', '\xa0',
  '\u2028', '\u2029', '\ufeff', '\ufffe', '\uffff', '世界', '🦀', '\uE000', '\ud800', '\udfff',
]
const differentialSamples = scalarStrings.flatMap((value, index) => [
  { name: `scalar-${index}`, markdown: 'Body', values: { value } },
  { name: `key-${index}`, markdown: 'Body', values: { [value]: 'value' } },
  { name: `nested-${index}`, markdown: 'Body', values: { nested: [{ [value]: value }, [value, null, true, -0]] } },
])
const numericSamples = [0, -0, 1, -1, 1.25, Number.MIN_VALUE, Number.MAX_VALUE,
  Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 2 ** 53, 1e-6, 1e-7, 1e20, 1e21]
  .map((value, index) => ({ name: `number-${index}`, markdown: 'Body', values: { value } }))
type Sample = { name: string; markdown: string; edit?: boolean; values?: Record<string, unknown>; alternateBaseline?: boolean }
const samples: Sample[] = [
  { name: 'empty', markdown: '' },
  { name: 'rich-unicode', markdown: '# Hello 世界\n\n**Bold** and 🦀.' },
  { name: 'ordinary-frontmatter-order', markdown: '---\nz: last\ntitle: First\na: next\n---\n\nBody' },
  { name: 'ordinary-frontmatter-array', markdown: '---\ntags:\n  - one\n  - two\n---\n\nBody' },
  { name: 'nested-order', markdown: '---\nnested:\n  z: last\n  a: first\n  10: ten\n  2: two\n---\n\nBody' },
  { name: 'nested-hostile-keys', markdown: '---\nnested:\n  __proto__: kept\n  constructor: own\n  prototype: literal\n  10: ten\n  2: two\n  🦀: astral\n  \uE000: bmp\n---\n\nBody' },
  { name: 'nested-arrays', markdown: '---\nvalues:\n  - name: one\n    tags: [first, second]\n  - [a, b]\n---\n\nBody' },
  { name: 'string-quotes', markdown: '---\na: "true"\nb: "it\'s: here"\nc: " leading "\nd: ""\ne: "null"\n---\n\nBody' },
  { name: 'multiline', markdown: '---\na: |-\n  first\n  second\nb: |+\n  keeps\n\n---\n\nBody' },
  { name: 'numbers', markdown: '---\na: -0.0\nb: 1e20\nc: 9007199254740993\nd: 1.25\ne: 1e-7\n---\n\nBody' },
  { name: 'negative-zero', markdown: '---\nvalue: -0.0\n---\n\nBody' },
  { name: 'numeric-root-order', markdown: '---\ntitle: Title\n10: ten\n2: two\n---\n\nBody' },
  { name: 'tagged', markdown: '---\npriority: !custom high\n---\n\nBody' },
  { name: 'tagged-crlf', markdown: '---\r\npriority: !custom high\r\n---\r\n\r\nBody\r\n\r\nNext' },
  { name: 'tagged-unicode-order', markdown: '---\nz: !custom 世界\ntitle: 🦀\na: first\n---\n\nBody' },
  { name: 'tagged-changed', markdown: '---\npriority: !custom high\n---\n\nBody', edit: true },
  { name: 'tagged-empty-map', markdown: '---\n!custom {}\n---\n\nBody' },
  { name: 'tagged-array', markdown: '---\npriority: !custom high\ntags:\n  - one\n  - two\n---\n\nBody' },
  { name: 'tagged-nested-order', markdown: '---\nnested: !custom\n  z: last\n  a: first\n---\n\nBody' },
  { name: 'tagged-equivalent-baseline-changed', markdown: '---\npriority: !custom high\n---\n\nBody', alternateBaseline: true },
  ...differentialSamples,
  ...numericSamples,
  ...frontmatterFixtures.vectors.map(vector => ({ name: `public-frontmatter-${vector.name}`, markdown: vector.markdown })),
]
type Vector = { name: string; bytes: number[]; markdown: string; registrationAccepted: boolean }
const validate = createLiveMarkdownRegistrationValidator({
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000,
})
function admitted(bytes: Uint8Array) {
  return validate({ document: { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage' },
    currentPath: 'notes/example.md', checkpoint: bytes }).kind === 'accepted'
}
if (process.env.DOHC_WRITE_BOOTSTRAP_VECTORS === '1') {
  const vectors: Vector[] = samples.map(sample => {
    const doc = markdownToYDoc(sample.markdown)
    try {
      if (sample.edit) doc.getMap('frontmatter').set('priority', 'low')
      if (sample.values) for (const [key, value] of Object.entries(sample.values)) doc.getMap('frontmatter').set(key, value)
      if (sample.alternateBaseline) doc.getMap('meta').set('dohcTaggedFrontmatterBaseline', 'priority: "high"\n')
      const bytes = Y.encodeStateAsUpdate(doc)
      const decoded = new Y.Doc()
      try {
        Y.applyUpdate(decoded, bytes)
        return { name: sample.name, bytes: [...bytes], markdown: yDocToMarkdown(decoded), registrationAccepted: admitted(bytes) }
      } finally { decoded.destroy() }
    } finally { doc.destroy() }
  })
  vectors.push({ name: 'zero-struct', bytes: [0, 0], markdown: '', registrationAccepted: true })
  writeFileSync(fixture, '[\n' + vectors.map(vector => JSON.stringify(vector)).join(',\n') + '\n]\n')
}
const vectors = JSON.parse(readFileSync(fixture, 'utf8')) as Vector[]
describe('shared bootstrap projections', () => {
  it('decodes the Rust re-encoding of the actual Yjs negative-zero fixture', () => {
    const bytes = JSON.parse(readFileSync(new URL('../../../crates/dohc-engine-collab/tests/fixtures/live-bootstrap-negative-zero-yrs.json', import.meta.url), 'utf8')) as number[]
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, new Uint8Array(bytes))
      expect(Object.is(doc.getMap('frontmatter').get('value'), -0)).toBe(true)
      expect(yDocToMarkdown(doc)).toBe(vectors.find(vector => vector.name === 'negative-zero')!.markdown)
    } finally { doc.destroy() }
  })
  it.each(vectors)('$name', vector => {
    const bytes = new Uint8Array(vector.bytes)
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, bytes)
      expect(yDocToMarkdown(doc)).toBe(vector.markdown)
      if (vector.name === 'negative-zero') expect(Object.is(doc.getMap('frontmatter').get('value'), -0)).toBe(true)
      expect(admitted(bytes)).toBe(vector.registrationAccepted)
      if (!vector.name.endsWith('changed') && !/^(public-frontmatter-|scalar-|key-|nested-|number-)/.test(vector.name)) expect(vector.registrationAccepted).toBe(true)
    } finally { doc.destroy() }
  })
})
