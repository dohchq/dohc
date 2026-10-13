import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { getDohcYDocFrontmatter, yDocToMarkdown } from './import-export.js'
import { createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'

const validate = createLiveMarkdownRegistrationValidator({
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
})
const document = { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'relation-source-object', lineageClaimId: 'lineage' }
const directory = new URL('../../../crates/dohc-engine-collab/tests/seeded-doc-fixtures/', import.meta.url)
const rewrites = JSON.parse(readFileSync(new URL('rewrites.json', directory), 'utf8')) as { markdown: string; update: number[] }[]
const cleanup = JSON.parse(readFileSync(new URL('cleanup.json', directory), 'utf8')) as {
  sourceId: string; targetId: string; seed: number[]; cleanup: number[]; checkpoint: number[]; afterRestart: number[]
}
function admitted(bytes: number[] | Uint8Array) {
  const result = validate({ document, currentPath: 'tasks/source.md', checkpoint: Uint8Array.from(bytes) })
  expect(result.kind, JSON.stringify(result.kind === 'refused' ? result : { kind: result.kind })).toBe('accepted')
  if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  return result.evidence
}

describe('engine-seeded documents', () => {
  it.each(rewrites)('admits a fresh rewrite of "$markdown", including empty content', ({ markdown, update }) => {
    const doc = new Y.Doc({ gc: false })
    try {
      Y.applyUpdate(doc, Uint8Array.from(update))
      expect(doc.getMap('meta').get('schemaVersion')).toBe(1)
      expect(admitted(update).projectedMarkdown).toBe(markdown)
    } finally { doc.destroy() }
  })

  it('admits the never-opened seed, cleared relation, and persisted checkpoint after restart', () => {
    admitted(cleanup.seed)
    for (const bytes of [cleanup.checkpoint, cleanup.afterRestart]) {
      const doc = new Y.Doc({ gc: false })
      try {
        Y.applyUpdate(doc, Uint8Array.from(bytes))
        expect(doc.getMap('meta').get('schemaVersion')).toBe(1)
        expect(getDohcYDocFrontmatter(doc)).toEqual({ id: cleanup.sourceId })
        expect(admitted(bytes).projectedMarkdown).not.toContain(cleanup.targetId)
      } finally { doc.destroy() }
    }
    const delivered = new Y.Doc({ gc: false })
    try {
      Y.applyUpdate(delivered, Uint8Array.from(cleanup.seed))
      expect(getDohcYDocFrontmatter(delivered).related).toBe(cleanup.targetId)
      Y.applyUpdate(delivered, Uint8Array.from(cleanup.cleanup))
      expect(getDohcYDocFrontmatter(delivered)).toEqual({ id: cleanup.sourceId })
      admitted(Y.encodeStateAsUpdate(delivered))
    } finally { delivered.destroy() }
  })

  it('changes a colliding editor client before editing and converges across replay orders', () => {
    const seed = Uint8Array.from(cleanup.seed)
    const seedClients = [...new Set(Y.decodeUpdate(seed).structs.map(struct => struct.id.client))]
    expect(seedClients).toHaveLength(1)
    const left = new Y.Doc({ gc: false }), right = new Y.Doc({ gc: false })
    const forward = new Y.Doc({ gc: false }), reverse = new Y.Doc({ gc: false })
    try {
      left.clientID = seedClients[0]!
      Y.applyUpdate(left, seed, 'engine')
      expect(left.clientID).not.toBe(seedClients[0])
      Y.applyUpdate(right, seed, 'engine')
      expect(right.clientID).not.toBe(seedClients[0])
      const vector = Y.encodeStateVector(left)
      const paragraph = new Y.XmlElement('paragraph')
      const text = new Y.XmlText()
      paragraph.insert(0, [text]); text.insert(0, 'Editor after seed')
      left.getXmlFragment('body').push([paragraph])
      right.getMap('frontmatter').set('reviewed', true)
      const edits = [Y.encodeStateAsUpdate(left, vector), Y.encodeStateAsUpdate(right, vector), Uint8Array.from(cleanup.cleanup)]
      // The cleanup can arrive before its seed; Yjs retains the dependency.
      for (const update of [seed, ...edits, ...edits]) Y.applyUpdate(forward, update, 'engine')
      for (const update of [...edits].reverse().concat([seed, ...edits])) Y.applyUpdate(reverse, update, 'engine')
      expect(Y.encodeStateVector(forward)).toEqual(Y.encodeStateVector(reverse))
      expect(yDocToMarkdown(forward)).toBe(yDocToMarkdown(reverse))
      expect(yDocToMarkdown(forward)).toContain('Editor after seed')
      expect(getDohcYDocFrontmatter(forward)).toEqual({ id: cleanup.sourceId, reviewed: true })
      admitted(Y.encodeStateAsUpdate(forward)); admitted(Y.encodeStateAsUpdate(reverse))
    } finally { for (const doc of [left, right, forward, reverse]) doc.destroy() }
  })

  it('still rejects incoming documents whose version is missing', () => {
    const doc = new Y.Doc({ gc: false })
    try {
      Y.applyUpdate(doc, Uint8Array.from(cleanup.checkpoint))
      doc.getMap('meta').delete('schemaVersion')
      expect(validate({ document, currentPath: 'tasks/source.md', checkpoint: Y.encodeStateAsUpdate(doc) }))
        .toEqual({ kind: 'refused', reason: 'invalid-schema', source: 'registration-input' })
    } finally { doc.destroy() }
  })
})
