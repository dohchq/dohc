import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { createLiveMarkdownJournalValidator } from './liveDocumentValidation.js'

interface Body { type: string; tag?: string; attrs?: Record<string, unknown>; children?: Body[]; delta?: Array<{ insert: string; attributes?: Record<string, unknown> }> }
interface Case { source: string; canonical: string; body: Body; nativeBase64: string }
const cases = JSON.parse(readFileSync(new URL('../../../tools/rust-engine-program/nested1b-allowlist-witnesses.json', import.meta.url), 'utf8')) as Case[]

// Compare the Source-built native XML with a fresh desktop import. Defaults
// and empty text nodes have no semantic effect, but child order does.
function normalized(node: Body): unknown {
  if (node.type === 'xmlText') return { text: node.delta?.map(run => run.insert).join('') ?? '' }
  const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key, value]) =>
    value !== null && value !== undefined && !(key === 'start' && value === 1) && !(key === 'checked' && value === false)))
  return { tag: node.tag ?? 'body', attrs, children: (node.children ?? []).filter(child =>
    child.type !== 'xmlText' || child.delta?.some(run => run.insert !== '')).map(normalized) }
}
function fromXml(node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.XmlHook): Body {
  if (node instanceof Y.XmlHook) throw new Error('Unexpected XML hook in a Source import')
  if (node instanceof Y.XmlText) return { type: 'xmlText', delta: node.toDelta() }
  return { type: node instanceof Y.XmlElement ? 'element' : 'xmlFragment',
    ...(node instanceof Y.XmlElement ? { tag: node.nodeName, attrs: node.getAttributes() } : {}),
    children: node.toArray().map(child => fromXml(child)) }
}
const policy = {
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000,
}
const validate = createLiveMarkdownJournalValidator(policy)
const document = { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage' }

it('compares generated native Source trees and witnesses with desktop imports', () => {
  expect(cases.length).toBeGreaterThan(2000)
  for (const row of cases) {
    const imported = markdownToYDoc(row.source, { reading: 'source' })
    const native = new Y.Doc()
    try {
      const checkpoint = Buffer.from(row.nativeBase64, 'base64')
      Y.applyUpdate(native, checkpoint)
      expect(normalized(fromXml(imported.getXmlFragment('body'))), row.source).toEqual(normalized(row.body))
      expect(yDocToMarkdown(imported), row.source).toBe(row.canonical)
      expect(yDocToMarkdown(native), row.source).toBe(row.canonical)
      expect(validate({ document, currentPath: 'notes.md', checkpoint, suffix: [], candidate: Y.encodeStateAsUpdate(native) }), row.source)
        .toMatchObject({ kind: 'accepted', evidence: {
          projectedMarkdownSha256: createHash('sha256').update(row.source).digest('hex'),
          projectedMarkdownByteLength: Buffer.byteLength(row.source),
        } })
    } finally { imported.destroy(); native.destroy() }
  }
}, 60_000)

it('refuses a forged nested witness even when both claimed digests are fresh', () => {
  const row = cases.find(row => row.source.startsWith('- parent\n  - child'))!
  const checkpoint = Buffer.from(row.nativeBase64, 'base64')
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, checkpoint)
    const before = Y.encodeStateVector(doc)
    const forged = '- forged parent\n  - forged child'
    doc.getMap('meta').set('dohcMarkdownSource', forged)
    doc.getMap('meta').set('dohcMarkdownSourceSha256', createHash('sha256').update(forged).digest('hex'))
    doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', createHash('sha256').update(row.canonical).digest('hex'))
    expect(validate({ document, currentPath: 'notes.md', checkpoint, suffix: [], candidate: Y.encodeStateAsUpdate(doc, before) }))
      .toMatchObject({ kind: 'refused' })
  } finally { doc.destroy() }
})
