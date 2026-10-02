import {afterEach, expect, it} from 'vitest'
import * as Y from 'yjs'
import type {LiveAuthorContext} from '@dohc/live-session-contract'
import type {LiveUpdateJournalCommitInput} from './storage.js'
import {registered, cleanupLiveDeliveryFixtures, policy, hash} from '../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js'
import {createLiveJournalHistoryAuthority} from './storage/liveJournalHistory.js'
import {createLiveValidationExecutor} from './liveValidation.js'
import {liveAuthorCheckpointAnticipated} from './storage/liveAuthorWindow.js'

const close: Array<() => void> = []
afterEach(() => {for (const fn of close.splice(0).reverse()) fn(); cleanupLiveDeliveryFixtures()})
function setup(options: Parameters<typeof registered>[0]) {
  const f = registered(options)
  close.push(f.close)
  f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: 'authorship-tests', reconciled: true}))
  return f
}
function authored(input: LiveUpdateJournalCommitInput, context: LiveAuthorContext, name = 'Alice') {
  return {...input, metadata: {...input.metadata, authorContext: context}, trustedAccount: {accountId: input.expectedAuthority.principalId, name}}
}

it('cuts a complete checkpoint at 960 identities through production validation and continues admissions', async () => {
  const journalPolicy = { ...policy, maxIndexOperations: 100_000_000 }
  const f = setup({ journalPolicy }), executor = createLiveValidationExecutor(), validate = executor.validator(journalPolicy)
  const insert = f.raw.prepare("INSERT OR IGNORE INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES (?,'share','user',?,NULL,'edit',4,'active',0,NULL,NULL)")
  const parkedEdits = 3, checkpointCursor = 960 + parkedEdits
  async function capture(bytes: Uint8Array, deliveryId: string, index: number) {
    const accountId = `author-${index}`, grantId = `author-grant-${index}`
    insert.run(grantId, accountId)
    const actor = {kind: 'named' as const, userId: accountId, grantId}
    const current = f.storage.resolveCurrentLiveDocumentBinding({document: f.input.evidence.document, actor})
    const read = f.storage.readLiveUpdateJournalCut({document: f.input.evidence.document})
    if (current.kind !== 'current' || read.kind !== 'cut') throw new Error('Author cut missing')
    const cut = read.cut
    const validation = await validate({document: cut.document, currentPath: cut.currentPath, checkpoint: cut.checkpoint.bytes,
      suffix: cut.suffix.map(row => row.bytes), candidate: bytes,
      retainStateUpdate: liveAuthorCheckpointAnticipated(cut.suffix.map(row => row.metadata), [{kind: 'human', humanId: accountId, humanName: 'Alice'}])})
    if (validation.kind === 'retry') throw new Error('Unexpected validation capacity retry')
    return authored({host: current.host, actor, expectedAuthority: current.authority,
      metadata: {deliveryId, updateDigest: hash(bytes), binding: current.binding}, cutToken: cut, validation,
      updateBytes: bytes, receivedAtMs: 30}, {kind: 'account', accountId})
  }
  try {
    for (let index = 0; index < 960; index++) {
      if (index === 959) {
        for (let parked = 0; parked < parkedEdits; parked++) {
          f.doc.clientID = 30_000 + parked
          const known = await capture(f.update(`known-${parked}`), `known-delivery-${parked}`, 0)
          if (known.validation.kind !== 'accepted') throw new Error('Known-author validation refused')
          expect(known.validation.evidence.stateUpdate).toBeUndefined()
          const result = f.storage.commitLiveUpdateJournal(known)
          expect(result.result.kind).toBe('accepted')
          expect(result.admitted?.metadata.checkpointCoverage).toBeUndefined()
        }
      }
      f.doc.clientID = 10_000 + index
      const before = Y.encodeStateVector(f.doc)
      if (index === 959) f.doc.getMap('frontmatter').delete('author-0')
      f.doc.getMap('frontmatter').set(`author-${index}`, String(index))
      const input = await capture(Y.encodeStateAsUpdate(f.doc, before), `window-${index}`, index)
      expect(input.validation.kind, `Author ${index}: ${JSON.stringify(input.validation.kind === 'refused' ? input.validation : { kind: input.validation.kind })}`).toBe('accepted')
      const result = f.storage.commitLiveUpdateJournal(input)
      expect(result.result.kind, `Author ${index}: ${JSON.stringify(result.result)}`).toBe('accepted')
      if (index < 959) expect(result.admitted?.metadata.checkpointCoverage).toBeUndefined()
      else {
        if (input.validation.kind !== 'accepted') throw new Error('Checkpoint validation refused')
        expect(input.validation.evidence.stateUpdate).toBeInstanceOf(Uint8Array)
        expect(result.admitted?.metadata.checkpointCoverage).toHaveLength(960)
        const terminal = result.admitted!.metadata.checkpointCoverage!.find(entry => entry.author.kind === 'human' && entry.author.humanId === 'author-959')!
        expect(terminal.deletionRanges).toEqual([{ clientId: 10_000, startClock: 0, endClock: 1 }])
        for (const entry of result.admitted!.metadata.checkpointCoverage!) expect(entry.structRanges.length).toBeGreaterThan(0)
      }
    }
    const cut = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
    expect(cut.kind).toBe('cut')
    if (cut.kind !== 'cut') throw new Error('Checkpoint cut missing')
    expect(cut.cut).toMatchObject({ highWater: checkpointCursor, suffixCount: 0, checkpoint: { cursor: checkpointCursor } })
    expect(cut.cut.checkpoint.metadata?.checkpointCoverage).toHaveLength(960)
    expect(hash(cut.cut.checkpoint.bytes)).toBe(cut.cut.checkpoint.digest)
    f.doc.clientID = 20_000
    const next = f.storage.commitLiveUpdateJournal(await capture(f.update('next-window', 'Fresh'), 'next-window', 960))
    expect(next.result.kind).toBe('accepted')
    expect(next.admitted?.metadata.checkpointCoverage).toBeUndefined()
    const advanced = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
    expect(advanced).toMatchObject({ kind: 'cut', cut: { highWater: checkpointCursor + 1, suffixCount: 1, checkpoint: { cursor: checkpointCursor },
      suffix: [{ metadata: { authorSnapshot: [{kind: 'human', humanId: 'author-960', humanName: 'Alice'}] } }] } })
  } finally { await executor.close() }
}, 600_000)

it('retains production validation state at the author byte boundary and admits subsequent edits', async () => {
  const f = setup({}), executor = createLiveValidationExecutor(), validate = executor.validator(policy)
  const insert = f.raw.prepare("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES (?,'share','user',?,NULL,'edit',4,'active',0,NULL,NULL)")
  let checkpointCursor: number | null = null
  try {
    for (let index = 0; index < 65; index++) {
      const accountId = `byte-author-${index}`, grantId = `byte-grant-${index}`
      insert.run(grantId, accountId)
      const actor = {kind: 'named' as const, userId: accountId, grantId}
      const current = f.storage.resolveCurrentLiveDocumentBinding({document: f.input.evidence.document, actor})
      const read = f.storage.readLiveUpdateJournalCut({document: f.input.evidence.document})
      if (current.kind !== 'current' || read.kind !== 'cut') throw new Error('Byte-boundary cut missing')
      f.doc.clientID = 50_000 + index
      const bytes = f.update(`byte-author-${index}`), cut = read.cut
      const name = '"'.repeat(500)
      const agent = {agentId: `agent-${index}-` + '"'.repeat(490), agentName: '"'.repeat(500)}
      const validation = await validate({document: cut.document, currentPath: cut.currentPath, checkpoint: cut.checkpoint.bytes,
        suffix: cut.suffix.map(row => row.bytes), candidate: bytes,
        retainStateUpdate: liveAuthorCheckpointAnticipated(cut.suffix.map(row => row.metadata),
          [{kind: 'human', humanId: accountId, humanName: name}, {kind: 'agent', ...agent}])})
      if (validation.kind !== 'accepted') throw new Error('Byte-boundary validation refused')
      if (index === 0) expect(validation.evidence.stateUpdate).toBeUndefined()
      const result = f.storage.commitLiveUpdateJournal(authored({host: current.host, actor, expectedAuthority: current.authority,
        metadata: {deliveryId: `byte-delivery-${index}`, updateDigest: hash(bytes), binding: current.binding}, cutToken: cut,
        validation, updateBytes: bytes, receivedAtMs: 30},
        {kind: 'account', accountId, agent}, name))
      expect(result.result.kind).toBe('accepted')
      if (result.admitted?.metadata.checkpointCoverage) {
        expect(validation.evidence.stateUpdate).toBeInstanceOf(Uint8Array)
        expect(result.admitted.metadata.checkpointCoverage.length).toBeLessThan(960)
        checkpointCursor = result.admitted.metadata.accepted.receipt.journalCursor
      }
    }
    expect(checkpointCursor).not.toBeNull()
    const after = f.storage.readLiveUpdateJournalCut({document: f.input.evidence.document})
    expect(after).toMatchObject({kind: 'cut', cut: {highWater: 65, checkpoint: {cursor: checkpointCursor}}})
    if (after.kind !== 'cut') throw new Error('Byte checkpoint cut missing')
    expect(after.cut.suffixCount).toBeGreaterThan(0)
  } finally {await executor.close()}
}, 600_000)
