import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { frontmatterEditsRefused, setFrontmatterValue } from './frontmatter.js'
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
  // `values` are set the way the desktop's editors set them, which keeps an
  // edited key's comments; `raw` values are plain Y.Map writes. Keys in
  // `remove` are deleted first.
  name: string; markdown: string; edit?: boolean; values?: Record<string, unknown>; raw?: Record<string, unknown>
  // Typed at the end of the body, and a replacement frontmatter source.
  typed?: string; remove?: string[]; source?: string
  // Values set on two replicas of the imported document, one each, then merged.
  concurrent?: [[string, unknown], [string, unknown]]
  // The settle must keep the frontmatter block exactly as written.
  keeps?: boolean
  checkImport?: boolean; editsRefused?: boolean
}
// The frontmatter block as written, read with a pattern and not a YAML loader,
// so a fault both loaders share cannot rewrite the expectation.
const WRITTEN_BLOCK = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/
// Frontmatter a person wrote, which a settle must keep as written: comments,
// order, spacing, and values the engine's JSON model cannot hold.
const KEEP_BLOCK_SCALAR = '---\n# note\nb: |+\n  keeps\n\nc: 1\n---\n\nBody\n'
const ALIAS_LADDER = Array.from({ length: 6 }, (_, level) => `l${level}: &l${level} [${
  Array(10).fill(level === 0 ? 'x' : `*l${level - 1}`).join(', ')
}]`).join('\n')
const STRING_BYTE_LADDER = [
  `s: &s "${'x'.repeat(1024)}"`,
  `l1: &l1 [${Array(100).fill('*s').join(', ')}]`,
  `l2: &l2 [${Array(100).fill('*l1').join(', ')}]`,
  'l3: [*l2, *l2]',
].join('\n')
const WRITTEN_FRONTMATTER = [
  '---', '# Trip plan', 'title:   Lisbon', 'score: .nan', 'id: 99999999999999999999', 'zero: -0',
  'octal: !!int 0o7', 'hex: 0x_1F', 'bin: 0b1010_1010', 'flag: !!bool yes', 'count: !custom 7',
  'tags:', '- a', '- b', '---', '', 'Body', '',
].join('\n')
const settleSamples: Sample[] = [
  { name: 'preserve-unreadable-crlf-key', markdown: '---\r\na: [\r\n---\r\n\r\nBody', keeps: true, checkImport: true },
  ...Object.entries({
    'bare-cr-in-key': 'a\r: [',
    'double-cr-in-key': 'a\r\r: [',
    'cr-at-start-of-key': '\rkey: [',
    'cr-after-value': 'a: [\r',
    'double-cr-after-value': 'a: [\r\r',
  }).map(([name, yaml]) => ({
    name: `preserve-unreadable-${name}`, markdown: `---\n${yaml}\n---\n\nBody`, keeps: true, checkImport: true,
  })),
  ...Object.entries({
    'cr-after-colon': 'a:\r\r\n',
    'cr-after-question': '?\r\r\n',
    'cr-before-first-entry': '\r\r\na: [\n',
    'lf-before-colon': 'a\n: [\n',
    'crlf-before-colon': 'a\r\n: [\r\n',
  }).map(([name, yaml]) => ({
    name: `body-unreadable-${name}`, markdown: `---\n${yaml}---\n\nBody`, checkImport: true,
  })),
  ...Object.entries({
    flow: '{a: 1, b: .nan}',
    anchor: '&root {a: 1, b: .nan}',
    tag: '!!map {a: 1, b: .nan}',
    'tag-anchor': '!<tag:yaml.org,2002:map> &root {a: 1, b: .nan}',
    'anchor-tag': '&root !custom\n{a: 1, b: .nan}',
    multiline: '{\n a: 1,\n b: .nan\n}',
    'empty-key': ': note\na: 1\nb: .nan',
    empty: '&root {}',
  }).map(([name, yaml]) => ({
    name: `refuse-property-edit-${name}`, markdown: `---\n${yaml}\n---\n\nBody`,
    keeps: true, checkImport: true, editsRefused: true,
  })),
  ...Object.entries({
    nested: 'a: 1\nb: {c: .nan}',
    block: '&root\na: 1\nb: .nan',
    'tagged-block': '!!map\na: 1\nb: .nan',
    empty: '',
  }).map(([name, yaml]) => ({
    name: `allow-property-edit-${name}`, markdown: `---\n${yaml}\n---\n\nBody`,
    keeps: true, checkImport: true, editsRefused: false,
  })),

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
    'keep-block-scalar': KEEP_BLOCK_SCALAR,
    'empty-block': '---\n---\n\nBody\n',
    'verbatim-tag': '---\nint: !<tag:yaml.org,2002:int> 7\n---\n\nBody\n',
    'number-keys': '---\n1e21: a\n1e-7: b\n-0.0: c\n1.0: d\n---\n\nBody\n',
    aliases: '---\nlist: &list [1, 2]\ncopy: *list\nname: &name key\n*name : value\n---\n\nBody\n',
    'empty-key': '---\n: note\ntitle: A\n---\n\nBody\n',
    proto: '---\n# Keep\n__proto__:   x\n---\n\nBody\n',
    'folded-keep': '---\nb: >+\n  folded\n\n\nc: 1\n---\n\nBody\n',
    written: WRITTEN_FRONTMATTER,
  }).map(([name, markdown]) => ({ name: `settle-typed-${name}`, markdown, typed: ', typed', keeps: true })),
  // A block both loaders refuse, whose first entry looks like a mapping key,
  // is kept byte for byte and not read as body Markdown.
  ...Object.entries({
    'quoted-continued-at-sequence-column': '---\na:\n- "x\ny"\n---\n\nBody\n',
    'collection-key': '---\n? [a, b]\n: 1\n---\n\nBody\n',
    'bare-carriage-return': '---\na: "x\ry"\n---\n\nBody\n',
    'question-key': '---\n?bad: [\n---\n\nBody\n',
    'question-entry': '---\n? [a\n---\n\nBody\n',
  }).map(([name, markdown]) => ({ name: `settle-typed-refused-${name}`, markdown, typed: ', typed', keeps: true })),
  // Other refused blocks stay body text.
  ...Object.entries({
    'tag-directive': '---\n%TAG !e! tag:example.com,2026:\na: !e!x 1\n---\n\nBody\n',
    'inner-document-start': '---\n--- # x\na: 1\n---\n\nBody\n',
    'thematic-breaks': '---\nJust a line\n---\n\nBody\n',
    'empty-key': '---\n: [\n---\n\nBody\n',
    'question-without-separator': '---\n?[a\n---\n\nBody\n',
  }).map(([name, markdown]) => ({ name: `settle-typed-refused-${name}`, markdown, typed: ', typed' })),
  { name: 'settle-key-changed', markdown: WRITTEN_FRONTMATTER, values: { title: 'Porto' } },
  { name: 'settle-key-removed', markdown: WRITTEN_FRONTMATTER, remove: ['score'] },
  { name: 'settle-key-added', markdown: WRITTEN_FRONTMATTER, values: { status: 'booked', icon: '🧳' } },
  { name: 'settle-all-keys-removed', markdown: '---\n# note\ntitle: Plan\n---\n\nBody\n', remove: ['title'] },
  { name: 'settle-crlf-key-changed', markdown: '---\r\n# note\r\nz: last\r\ntitle: First\r\n---\r\n\r\nBody\r\n', values: { title: 'Second' } },
  { name: 'settle-flow-mapping-changed', markdown: '---\n{a: 1, b: .nan}\n---\n\nBody\n', values: { a: 2 } },
  { name: 'settle-forged-source-body', markdown: '---\npriority: !custom high\n---\n\nBody', source: '---\npriority: !custom high\n---\n\ninjected body\n' },
  { name: 'settle-forged-source-value', markdown: '---\npriority: !custom high\n---\n\nBody', source: '---\npriority: !custom foreign\n---\n\n' },
  { name: 'settle-forged-source-deep', markdown: '---\ntitle: Plan\n---\n\nBody', source: `---\ntitle:\n${'- '.repeat(200)}Plan\n---\n\n` },
  { name: 'settle-forged-source-alias-ladder', markdown: '---\ntitle: Plan\n---\n\nBody', source: `---\n${ALIAS_LADDER}\ntitle: Plan\n---\n\n` },
  { name: 'settle-key-after-keep-block-scalar-changed', markdown: KEEP_BLOCK_SCALAR, values: { c: 2 } },
  // Removing the key under a kept blank line would change the block
  // scalar's value, so the settle writes canonical frontmatter.
  { name: 'settle-key-after-keep-block-scalar-removed', markdown: KEEP_BLOCK_SCALAR, remove: ['c'] },
  { name: 'settle-key-renamed', markdown: WRITTEN_FRONTMATTER, remove: ['title'], values: { heading: 'Lisbon' } },
  { name: 'settle-key-renamed-and-key-added', markdown: WRITTEN_FRONTMATTER, remove: ['title'], values: { heading: 'Lisbon', status: 'booked' } },
  // A key written directly keeps its place but not the comments above it.
  { name: 'settle-key-set-directly', markdown: WRITTEN_FRONTMATTER, raw: { title: 'Porto' } },
  // A deleted key's comment never returns: not when its name comes back, and
  // not when another key takes its value.
  { name: 'settle-key-deleted-then-name-reused', markdown: '---\n# Wi-Fi password\nwifi: hunter2\nbudget: 100\n---\n\nBody\n', remove: ['wifi'], values: { wifi: 'new' } },
  { name: 'settle-key-deleted-then-name-reused-directly', markdown: '---\n# Wi-Fi password\nwifi: hunter2\nbudget: 100\n---\n\nBody\n', remove: ['wifi'], raw: { wifi: 'new' } },
  { name: 'settle-key-deleted-then-value-reused', markdown: '---\n# delete before publishing\ndraft: true\ntitle: A\n---\n\nBody\n', remove: ['draft'], values: { featured: true } },
  { name: 'settle-concurrent-key-edits', markdown: '---\n# a note\na:   1\n# b note\nb:   2\n---\n\nBody\n', concurrent: [['a', 10], ['b', 20]] },
  { name: 'settle-last-key-forgotten', markdown: '---\nz: 1\n---\n\nBody\n', remove: ['z'] },
  { name: 'settle-key-replaced', markdown: '---\n# Wi-Fi password\nwifi: hunter2\nbudget: 100\n---\n\nBody\n', remove: ['wifi'], values: { note: 'x' } },
  { name: 'settle-keep-block-scalar-last-key-added', markdown: '---\nb: |+\n  keeps\n\n---\n\nBody\n', values: { c: 1 } },
  { name: 'settle-keep-block-scalar-changed', markdown: KEEP_BLOCK_SCALAR, values: { b: 'other\n\n' } },
  { name: 'settle-empty-key-changed', markdown: '---\n: note\ntitle: A\n---\n\nBody\n', values: { title: 'B' } },
  { name: 'settle-forged-source-tag-directive', markdown: '---\ntitle: Plan\n---\n\nBody', source: '---\n%TAG !e! tag:example.com,2026:\ntitle: !e!x Plan\n---\n\n' },
  { name: 'settle-forged-source-string-bytes', markdown: '---\ntitle: Plan\n---\n\nBody', source: `---\n${STRING_BYTE_LADDER}\ntitle: Plan\n---\n\n` },
  { name: 'settle-empty-block-key-added', markdown: '---\n---\n\nBody\n', values: { title: 'Plan' } },
  { name: 'settle-last-key-removed', markdown: '---\nz: 1\ntitle: Plan\n---\n\nBody\n', remove: ['z', 'title'] },
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
type Vector = { name: string; bytes: number[]; markdown: string; registrationAccepted: boolean; keptFrontmatter?: string; sourceMarkdown?: string; editsRefused?: boolean }
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
      if (sample.concurrent) {
        const peer = new Y.Doc()
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
        setFrontmatterValue(doc, ...sample.concurrent[0])
        setFrontmatterValue(peer, ...sample.concurrent[1])
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
        peer.destroy()
      }
      for (const key of sample.remove ?? []) doc.getMap('frontmatter').delete(key)
      if (sample.edit) doc.getMap('frontmatter').set('priority', 'low')
      for (const [key, value] of Object.entries(sample.values ?? {})) setFrontmatterValue(doc, key, value)
      for (const [key, value] of Object.entries(sample.raw ?? {})) doc.getMap('frontmatter').set(key, value)
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
        return {
          name: sample.name, bytes: [...bytes], markdown: yDocToMarkdown(decoded), registrationAccepted: admitted(bytes),
          ...(sample.checkImport ? { sourceMarkdown: sample.markdown, editsRefused: sample.editsRefused } : {}),
          ...(sample.keeps ? { keptFrontmatter: WRITTEN_BLOCK.exec(sample.markdown)![0] } : {}),
        }
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
      if (vector.editsRefused !== undefined) expect(frontmatterEditsRefused(doc)).toBe(vector.editsRefused)
      if (vector.sourceMarkdown !== undefined) {
        const imported = markdownToYDoc(vector.sourceMarkdown)
        try {
          expect(yDocToMarkdown(imported)).toBe(vector.markdown)
          if (vector.editsRefused !== undefined) expect(frontmatterEditsRefused(imported)).toBe(vector.editsRefused)
        } finally { imported.destroy() }
      }
      if (vector.keptFrontmatter !== undefined) expect(vector.markdown.startsWith(vector.keptFrontmatter)).toBe(true)
      if (vector.name === 'negative-zero') expect(Object.is(doc.getMap('frontmatter').get('value'), -0)).toBe(true)
      expect(admitted(bytes)).toBe(vector.registrationAccepted)
      if (!vector.name.endsWith('changed') && !/^(public-frontmatter-|scalar-|key-|nested-|number-)/.test(vector.name)) expect(vector.registrationAccepted).toBe(true)
    } finally { doc.destroy() }
  })
})
