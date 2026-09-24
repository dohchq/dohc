import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'
import frontmatterFixtures from '../../../crates/dohc-engine-domain/tests/fixtures/collection-frontmatter.json'

const fixture = new URL('../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json', import.meta.url)
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
  // Numbers the frontmatter value model keeps as text.
  '9223372036854775808', '99999999999999999999', '0b1010_1010', '0x_1F', '0x1_F', '1e400',
]
const differentialSamples = scalarStrings.flatMap((value, index) => [
  { name: `scalar-${index}`, markdown: 'Body', values: { value } },
  { name: `key-${index}`, markdown: 'Body', values: { [value]: 'value' } },
  { name: `nested-${index}`, markdown: 'Body', values: { nested: [{ [value]: value }, [value, null, true, -0]] } },
])
const numericSamples = [0, -0, 1, -1, 1.25, Number.MIN_VALUE, Number.MAX_VALUE,
  Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 2 ** 53, 1e-6, 1e-7, 1e20, 1e21]
  .map((value, index) => ({ name: `number-${index}`, markdown: 'Body', values: { value } }))
type Sample = {
  name: string; markdown: string; edit?: boolean; values?: Record<string, unknown>
  // Typed at the end of the body, keys removed, and a replacement frontmatter source.
  typed?: string; remove?: string[]; source?: string
}
// Frontmatter a person wrote, which a settle must keep as written: comments,
// order, spacing, and values the engine's JSON model cannot hold.
const WRITTEN_FRONTMATTER = [
  '---', '# Trip plan', 'title:   Lisbon', 'score: .nan', 'id: 99999999999999999999', 'zero: -0',
  'octal: !!int 0o7', 'hex: 0x_1F', 'bin: 0b1010_1010', 'flag: !!bool yes', 'count: !custom 7',
  'tags:', '- a', '- b', '---', '', 'Body', '',
].join('\n')
const settleSamples: Sample[] = [
  ...Object.entries({
    'non-finite': '---\nnan: .nan\ninf: .inf\nneg: -.inf\n---\n\nBody\n',
    'beyond-i64': '---\nbig: 9223372036854775808\nsmall: -9223372036854775809\nid: 99999999999999999999\n---\n\nBody\n',
    'negative-zero': '---\nzero: -0\nfloat: -0.0\n---\n\nBody\n',
    'explicit-int': '---\ntagged: !!int 7\noctal: !!int 0o7\n---\n\nBody\n',
    'separated-radix': '---\nhex: 0x_1F\nbin: 0b1010_1010\nsep: 1_000\n---\n\nBody\n',
    'unresolvable-tag': '---\nflag: !!bool yes\ncount: !!int many\n---\n\nBody\n',
    'custom-tag': '---\ncount: !custom 7\n---\n\nBody\n',
    'comment-only': '---\n# note\n---\n\nBody\n',
    'no-blank-line': '---\ntitle: Plan\n---\nBody\n',
    'flow-mapping': '---\n{a: 1, b: .nan}\n---\n\nBody\n',
    'delimiter-at-end': '---\ntitle: Plan\n--- ',
    'crlf-delimiter-at-end': '---\r\ntitle: Plan\r\n---',
    written: WRITTEN_FRONTMATTER,
  }).map(([name, markdown]) => ({ name: `settle-typed-${name}`, markdown, typed: ', typed' })),
  { name: 'settle-key-changed', markdown: WRITTEN_FRONTMATTER, values: { title: 'Porto' } },
  { name: 'settle-key-removed', markdown: WRITTEN_FRONTMATTER, remove: ['score'] },
  { name: 'settle-key-added', markdown: WRITTEN_FRONTMATTER, values: { status: 'booked', icon: '🧳' } },
  { name: 'settle-all-keys-removed', markdown: '---\n# note\ntitle: Plan\n---\n\nBody\n', remove: ['title'] },
  { name: 'settle-crlf-key-changed', markdown: '---\r\n# note\r\nz: last\r\ntitle: First\r\n---\r\n\r\nBody\r\n', values: { title: 'Second' } },
  { name: 'settle-flow-mapping-changed', markdown: '---\n{a: 1, b: .nan}\n---\n\nBody\n', values: { a: 2 } },
  { name: 'settle-forged-source-body', markdown: '---\npriority: !custom high\n---\n\nBody', source: '---\npriority: !custom high\n---\n\ninjected body\n' },
  { name: 'settle-forged-source-value', markdown: '---\npriority: !custom high\n---\n\nBody', source: '---\npriority: !custom foreign\n---\n\n' },
]
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
  ...settleSamples,
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
      for (const key of sample.remove ?? []) doc.getMap('frontmatter').delete(key)
      if (sample.source !== undefined) doc.getMap('meta').set('dohcFrontmatterSource', sample.source)
      if (sample.typed !== undefined) {
        const body = doc.getXmlFragment('body')
        const paragraph = body.get(body.length - 1)
        const text = paragraph instanceof Y.XmlElement ? paragraph.get(paragraph.length - 1) : undefined
        if (text instanceof Y.XmlText) text.insert(text.length, sample.typed)
        else {
          const added = new Y.XmlElement('paragraph')
          added.insert(0, [new Y.XmlText(sample.typed)])
          body.push([added])
        }
      }
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
  it('pins actual Yjs signed-zero updates at the same client and clock', () => {
    const updates = JSON.parse(readFileSync(new URL('../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/signed-zero-same-clock.json', import.meta.url), 'utf8')) as { negative: number[]; positive: number[] }
    for (const [name, value] of [['negative', -0], ['positive', 0]] as const) {
      const source = new Y.Doc()
      const decoded = new Y.Doc()
      try {
        source.clientID = 7
        source.getMap('frontmatter').set('value', value)
        expect([...Y.encodeStateAsUpdate(source)]).toEqual(updates[name])
        Y.applyUpdate(decoded, new Uint8Array(updates[name]))
        expect(Object.is(decoded.getMap('frontmatter').get('value'), value)).toBe(true)
        expect([...Y.encodeStateVector(decoded)]).toEqual([1, 7, 1])
      } finally { source.destroy(); decoded.destroy() }
    }
  })
  it('decodes the Rust re-encoding of the actual Yjs negative-zero fixture', () => {
    const bytes = JSON.parse(readFileSync(new URL('../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap-negative-zero-yrs.json', import.meta.url), 'utf8')) as number[]
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
