import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'
import { yDocToMarkdown } from './import-export.js'
import { cleanupLiveDeliveryFixtures, registered } from './liveCommittedDeliveryTestSupport.js'

afterEach(cleanupLiveDeliveryFixtures)

const fixturePath = new URL('../../../crates/dohc-engine-collab/tests/owner-source/owner-source-public.json', import.meta.url)
const seedPath = new URL('../../../crates/dohc-engine-collab/tests/owner-source/owner-source-seed.json', import.meta.url)
const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { bytes: number[]; canonical: string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const validate = createLiveMarkdownRegistrationValidator({ maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000 })

it('registers the original lexical source moment and refuses a later moment with the same digest', () => {
  const f = registered({ baselineBytes: Uint8Array.from(seed.bytes) })
  try {
    const source = JSON.parse(readFileSync(seedPath, 'utf8')) as { markdown: string }
    expect(f.input.evidence.projectedMarkdown).toBe(source.markdown)
    expect(f.input.evidence.projectedMarkdownSha256).toBe(hash(source.markdown))
    expect(f.input.evidence.projectedMarkdownSha256).not.toBe(hash(seed.canonical))
    const row = f.raw.prepare('SELECT baseline_moment_relay_seq,baseline_projected_sha256 FROM sync_relay_live_documents').get()!
    expect(row.baseline_moment_relay_seq).toBe(1)
    expect(row.baseline_projected_sha256).toBe(hash(source.markdown))
    f.moment(f.input, 2)
    expect(f.storage.registerLiveDocumentBaseline(f.input)).toMatchObject({ kind: 'refused', reason: 'baseline-conflict' })
  } finally { f.close() }
})

it('preserved source admits exact owners, ignores stale witnesses, and refuses forged active witnesses', () => {
  const cases: [string, boolean, (doc: Y.Doc) => void][] = [
    ['original', true, () => {}],
    ['stale-after-edit', true, doc => {
      const heading = doc.getXmlFragment('body').get(0) as Y.XmlElement
      ;(heading.get(0) as Y.XmlText).insert(0, 'Edited ')
    }],
    ['forged-active', false, doc => {
      doc.getMap('meta').set('dohcMarkdownSource', 'Foreign source')
      doc.getMap('meta').set('dohcMarkdownSourceSha256', hash('Foreign source'))
    }],
    ['forged-stale', true, doc => {
      doc.getMap('meta').set('dohcMarkdownSource', 'Foreign historical source')
      doc.getMap('meta').set('dohcMarkdownSourceSha256', hash('Foreign historical source'))
      doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', hash('different historical projection'))
    }],
    ['wrong-source-hash', false, doc => doc.getMap('meta').set('dohcMarkdownSourceSha256', '0'.repeat(64))],
    ['missing-source', false, doc => doc.getMap('meta').delete('dohcMarkdownSource')],
    ['source-wrong-type', false, doc => doc.getMap('meta').set('dohcMarkdownSource', { text: 'source' })],
    ['invalid-witness', false, doc => doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', 'not-a-digest')],
    ['arbitrary-metadata', false, doc => doc.getMap('meta').set('otherMetadata', 'unexpected')],
  ]
  const generated = cases.map(([name, accepted, edit]) => {
    const doc = new Y.Doc({ gc: false })
    try {
      Y.applyUpdate(doc, Uint8Array.from(seed.bytes)); edit(doc)
      const canonical = yDocToMarkdown(doc)
      const markdown = accepted && doc.getMap('meta').get('dohcMarkdownSourceProjectionSha256') === hash(canonical)
        ? doc.getMap('meta').get('dohcMarkdownSource') as string : canonical
      return { name, accepted, bytes: Array.from(Y.encodeStateAsUpdate(doc)), markdown }
    } finally { doc.destroy() }
  })
  if (process.env.UPDATE_OWNER_SOURCE_PUBLIC_FIXTURE === '1') writeFileSync(fixturePath, `${JSON.stringify(generated)}\n`)
  const retained = JSON.parse(readFileSync(fixturePath, 'utf8')) as typeof generated
  expect(retained.map(({ name, accepted }) => ({ name, accepted }))).toEqual(generated.map(({ name, accepted }) => ({ name, accepted })))
  for (const row of [...generated, ...retained]) {
    const checkpoint = Uint8Array.from(row.bytes)
    const result = validate({ document: { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: hash('lineage') }, currentPath: 'owner.md', checkpoint })
    expect(result.kind, row.name).toBe(row.accepted ? 'accepted' : 'refused')
    if (result.kind === 'accepted') expect(result.evidence.projectedMarkdown, row.name).toBe(row.markdown)
    if (row.name === 'stale-after-edit') expect(row.markdown).toContain('Edited Shared')
    if (row.name === 'forged-stale') expect(row.markdown).toBe(seed.canonical)
  }
})

it('caps active lexical output at 2 MiB while allowing a stale historical source within the native bound', () => {
  for (const stale of [false, true]) {
    const doc = new Y.Doc({ gc: false })
    try {
      Y.applyUpdate(doc, Uint8Array.from(seed.bytes))
      const source = `${seed.canonical}${'\n'.repeat(2 * 1024 * 1024)}`
      const meta = doc.getMap('meta')
      meta.set('dohcMarkdownSource', source)
      meta.set('dohcMarkdownSourceSha256', hash(source))
      if (stale) meta.set('dohcMarkdownSourceProjectionSha256', hash('old canonical state'))
      const result = validate({ document: { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: hash('lineage') }, currentPath: 'owner.md', checkpoint: Y.encodeStateAsUpdate(doc) })
      expect(result.kind).toBe(stale ? 'accepted' : 'refused')
      if (result.kind === 'accepted') expect(result.evidence.projectedMarkdown).toBe(seed.canonical)
      else expect(result.reason).toBe('capacity-refused')
    } finally { doc.destroy() }
  }
})
