import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { yDocToArtifactMarkdown } from './artifact-markdown.js'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { encodeRichdocSeed, richdocSeedFile, seedClientId, seedClientIdFromDigest, type SeedClientIdInput } from './richdoc-seed.js'

const directory = new URL('../../../crates/dohc-engine-collab/tests/first-open-base/', import.meta.url)
const read = <T>(name: string) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as T
const SEEDS = [
  { name: 'empty', markdown: '', clientId: 1 },
  { name: 'canonical-paragraph', markdown: 'Plain paragraph', clientId: 7 },
  { name: 'headings-numeric-attributes', markdown: '# Title\n\n### Third\n\n3. three\n4. four\n', clientId: 4_000_000_000 },
  { name: 'lists-marks-code', markdown: '- **bold** and *em* with `code`\n  - nested ~~gone~~\n\n```js\nconst x = 1\n```\n', clientId: 2_147_483_648 },
  { name: 'links', markdown: 'See [the docs](https://example.com/a "Title") and <https://example.com/b>.\n', clientId: 99 },
  { name: 'frontmatter-nested', markdown: '---\ntitle: Plan\ntags:\n  - a\n  - b\nnested:\n  key: value\n  count: 3\n---\n\nBody\n', clientId: 12_345 },
  { name: 'unicode', markdown: '# Café 🎉\n\nnaïve 中文 — ok\n', clientId: 65_536 },
  { name: 'source-witness', markdown: '* one\n* two\n', clientId: 3 },
  { name: 'integer-2147483648', markdown: '---\ncount: 2147483648\n---\n\nBody\n', clientId: 5 },
  // 300 integers lib0 writes as 4-byte float32s and yrs as 8-byte varints.
  {
    name: 'float32-integers',
    markdown: `---\nsizes: [${Array.from({ length: 300 }, (_, index) => index % 2 ? -(2 ** 48) : 2 ** 52).join(', ')}]\n---\n\nBody`,
    clientId: 11,
  },
] as const
// Whether yrs re-encodes the Yjs bytes exactly. Bases without a JSON object
// value re-encode deterministically; yrs writes integral floats such as
// 2147483648 as varints, and orders object keys by hash.
const YRS_BYTE_PARITY: Record<(typeof SEEDS)[number]['name'], boolean | 'unordered'> = {
  'empty': true,
  'canonical-paragraph': true,
  'headings-numeric-attributes': true,
  'lists-marks-code': true,
  'links': 'unordered',
  'frontmatter-nested': 'unordered',
  'unicode': true,
  'source-witness': true,
  'integer-2147483648': false,
  'float32-integers': false,
}

// The engine reads an autolink differently, so it settles the projection; the
// Rust fixture test pins the same set.
const SETTLES_CANONICAL = new Set(['links'])

type Base = { name: string; markdown: string; canonical: string; clientId: number; bytes: number[] }

function fingerprint(node: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment): unknown {
  if (node instanceof Y.XmlText) return node.toDelta()
  if (node instanceof Y.XmlElement) {
    return { name: node.nodeName, attributes: node.getAttributes(), children: node.toArray().map(fingerprint) }
  }
  if (node instanceof Y.XmlFragment) return node.toArray().map(fingerprint)
  throw new Error('Unexpected body node.')
}
function decoded(bytes: Uint8Array | readonly number[]) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, Uint8Array.from(bytes))
    return {
      roots: [...doc.share.keys()].sort(),
      body: fingerprint(doc.getXmlFragment('body')),
      frontmatter: doc.getMap('frontmatter').toJSON(),
      meta: doc.getMap('meta').toJSON(),
      stateVector: [...Y.encodeStateVector(doc)],
      projection: yDocToMarkdown(doc),
      file: yDocToArtifactMarkdown(doc),
    }
  } finally { doc.destroy() }
}

describe('seed client id', () => {
  it('matches the engine for every Rust fixture', () => {
    const fixtures = read<(SeedClientIdInput & { clientId: number })[]>('seed-client-ids.json')
    expect(fixtures.length).toBeGreaterThan(0)
    expect(fixtures.some(fixture => /[^\x00-\x7f]/.test(fixture.workspaceId + fixture.objectId + fixture.headMomentId))).toBe(true)
    expect(fixtures.some(fixture => fixture.clientId >= 2 ** 31)).toBe(true)
    for (const { clientId, ...input } of fixtures) expect(seedClientId(input), JSON.stringify(input)).toBe(clientId)
  })
  it('reads the first four digest bytes as an unsigned, nonzero client', () => {
    expect(seedClientIdFromDigest(new Uint8Array(32))).toBe(1)
    expect(seedClientIdFromDigest(Uint8Array.of(0, 0, 0, 2, 255))).toBe(2)
    expect(seedClientIdFromDigest(Uint8Array.of(255, 255, 255, 255, 1))).toBe(0xffff_ffff)
  })
})

describe('richdoc seed', () => {
  const written = SEEDS.map(({ name, markdown, clientId }) => {
    const bytes = encodeRichdocSeed(markdown, clientId)
    return { name, markdown, canonical: decoded(bytes).projection, clientId, bytes: [...bytes] }
  })
  if (process.env.DOHC_WRITE_FIRST_OPEN_FIXTURES === '1') {
    writeFileSync(new URL('ts-bases.json', directory), '[\n' + written.map(base => JSON.stringify(base)).join(',\n') + '\n]\n')
  }
  const bases = read<Base[]>('ts-bases.json')
  const yrs = new Map(read<{ name: string; bytes: number[] }[]>('yrs-bases.json').map(base => [base.name, base.bytes]))

  it('keeps the committed base bytes', () => {
    expect(bases).toEqual(written)
  })
  it.each(SEEDS.map(seed => seed.name))('%s settles to the file the engine settles to', name => {
    const base = bases.find(base => base.name === name)!
    const state = decoded(base.bytes)
    expect(state.file).toBe(SETTLES_CANONICAL.has(name) ? base.canonical : base.markdown)
    expect(richdocSeedFile(Uint8Array.from(base.bytes))).toBe(state.file)
    expect([...Y.decodeStateVector(Uint8Array.from(state.stateVector)).keys()]).toEqual([base.clientId])
    expect(Object.hasOwn(state.meta, 'dohcMarkdownSource')).toBe(state.projection !== base.markdown)
  })
  it('omits the witness when the projection reproduces the file', () => {
    const doc = markdownToYDoc('Plain paragraph')
    try { expect(yDocToMarkdown(doc)).toBe('Plain paragraph') } finally { doc.destroy() }
    expect(decoded(encodeRichdocSeed('Plain paragraph', 7)).meta).toEqual({ schemaVersion: 1 })
  })
  it.each(SEEDS.map(seed => seed.name))('%s decodes from the yrs full state as the same document', name => {
    const base = bases.find(base => base.name === name)!
    const native = yrs.get(name)
    expect(native).toBeDefined()
    expect(decoded(native!)).toEqual(decoded(base.bytes))
    const parity = YRS_BYTE_PARITY[name as keyof typeof YRS_BYTE_PARITY]
    if (parity !== 'unordered') expect(Buffer.from(native!).equals(Buffer.from(base.bytes))).toBe(parity)
  })
  it('pins 2147483648 as a float in Yjs and a varint in yrs', () => {
    const base = bases.find(base => base.name === 'integer-2147483648')!
    const native = yrs.get('integer-2147483648')!
    // lib0 writes 2^31 as float32 (124); yrs writes integral numbers as varints (125).
    expect(includes(base.bytes, [124, 0x4f, 0, 0, 0])).toBe(true)
    expect(includes(native, [124, 0x4f, 0, 0, 0])).toBe(false)
    expect(native.length).toBe(base.bytes.length + 1)
    expect(decoded(native).frontmatter).toEqual({ count: 2147483648 })
  })
  it('pins 300 wide integers growing by four bytes each in yrs', () => {
    const base = bases.find(base => base.name === 'float32-integers')!
    const native = yrs.get('float32-integers')!
    expect(native.length - base.bytes.length).toBe(300 * 4)
  })
})

function includes(haystack: readonly number[], needle: readonly number[]): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle))
}
