import {afterEach, expect, it, vi} from 'vitest'
import * as Y from 'yjs'
import type {LiveAuthorContext} from '@dohc/live-session-contract'
import type {LiveUpdateJournalCommitInput} from './storage.js'
import type {LiveJournalValidation} from './storage/types.js'
import type {EngineClient} from '@dohc/workspace-engine-client/daemon'
import {OwnerKnownRefusals} from '@dohc/workspace-engine-client/owner-ydoc-drainer'
import {registered, cleanupLiveDeliveryFixtures, policy, hash} from '../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js'
import type {StorageContext} from './storage/context.js'
import {appendValidatedLiveJournal} from './storage/liveUpdateJournal.js'
import {createLiveJournalHistoryAuthority} from './storage/liveJournalHistory.js'
import {createLiveValidationExecutor} from './liveValidation.js'
import {liveAuthorCheckpointAnticipated} from './storage/liveAuthorWindow.js'
import {captureNamedLiveFrameHost, createNamedFrameChanges} from './namedLiveFrameHost.js'
import {drainOwnerOutbox, type OwnerOutboxAdmission} from './ownerOutboxDelivery.js'

const close: Array<() => void> = []
afterEach(() => {vi.useRealTimers(); for (const fn of close.splice(0).reverse()) fn(); cleanupLiveDeliveryFixtures()})
function setup(options: Parameters<typeof registered>[0]) {
  const f = registered(options)
  close.push(f.close)
  f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: 'authorship-tests', reconciled: true}))
  return f
}
function authored(input: LiveUpdateJournalCommitInput, context: LiveAuthorContext, name = 'Alice') {
  return {...input, metadata: {...input.metadata, authorContext: context}, trustedAccount: {accountId: input.expectedAuthority.principalId, name}}
}
function authorGrantInsert(db: StorageContext['db'] | ReturnType<typeof setup>['raw'], ignoreExisting = false) {
  return db.prepare(`INSERT${ignoreExisting ? ' OR IGNORE' : ''} INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES (?,'share','user',?,NULL,'edit',4,'active',0,NULL,NULL)`)
}

// Seed only the middle of the window. The first, 959th, and 960th admissions
// use real validation and commit; replaying every growing prefix takes minutes.
// The seed omits settlement-cut rows for cursors 2-958 and author-client rows
// for seeded clients; later edits must not reuse a seeded client ID.
function seedMiddleAuthors(f: ReturnType<typeof setup>, source: 'named' | 'owner') {
  const document = f.input.evidence.document
  const read = f.storage.readLiveUpdateJournalCut({document})
  if (read.kind !== 'cut') throw new Error('Seed cut missing')
  expect(read.cut).toMatchObject({highWater: 1, suffixCount: 1, checkpoint: {cursor: null}})
  let prior = read.cut.suffix[0]!.metadata
  const binding = prior.accepted.binding
  const prefix = source === 'named' ? 'author' : 'outbox-author'
  f.write(db => {
    const insert = authorGrantInsert(db)
    for (let index = 1; index < 958; index++) {
      const accountId = `${prefix}-${index}`
      const grantId = source === 'named' ? `author-grant-${index}` : `outbox-grant-${index}`
      insert.run(grantId, accountId)
      f.doc.clientID = (source === 'named' ? 10_000 : 60_000) + index
      const bytes = f.update(`${prefix}-${index}`, String(index))
      prior = appendValidatedLiveJournal(f.storage as StorageContext, {document, namespace: 'authorship-tests',
        host: f.input.host, current: {binding, authority: {principalKind: 'named', principalId: accountId, grantId, grantGeneration: 4}},
        metadata: {deliveryId: source === 'named' ? `window-${index}` : `outbox-seed-${index}`, updateDigest: hash(bytes)},
        updateBytes: bytes, receivedAtMs: 30, authorContext: {kind: 'account', accountId},
        authorSnapshot: [{kind: 'human', humanId: accountId, humanName: 'Alice'}],
        firstSeen: [{clientId: f.doc.clientID, startClock: 0, endClock: 1}],
        checkpointBytes: null, checkpointDigest: null, priorMetadata: prior}).metadata
      expect(prior.accepted.receipt.journalCursor).toBe(index + 1)
    }
  })
}

it('cuts a complete checkpoint at the named frame host’s 960th identity and continues admissions', async () => {
  // Keep the admission deadline independent of host load; worker messages still run.
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
  const journalPolicy = { ...policy, maxIndexOperations: 100_000_000 }
  const f = setup({ journalPolicy }), executor = createLiveValidationExecutor(), validate = executor.validator(journalPolicy)
  const insert = authorGrantInsert(f.raw, true)
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
  async function submitNamed(bytes: Uint8Array, deliveryId: string, index: number) {
    const accountId = `author-${index}`, grantId = `author-grant-${index}`
    insert.run(grantId, accountId)
    const actor = {kind: 'named' as const, userId: accountId, grantId}
    const current = f.storage.resolveCurrentLiveDocumentBinding({document: f.input.evidence.document, actor})
    if (current.kind !== 'current' || current.authority.principalKind !== 'named') throw new Error('Named authority missing')
    const observed: {retained?: boolean; validation?: LiveJournalValidation} = {}
    const frameHost = captureNamedLiveFrameHost({
      ticket: {ticketId: 'boundary-ticket', audience: 'https://share.example.test', authority: current.authority,
        binding: current.binding, hostEpoch: current.host.hostEpoch, mintedAtMs: 0, expiresAtMs: 30_000, redeemedAtMs: 1},
      actor, trustedAccount: {accountId, name: 'Alice'}, storage: f.storage,
      validate: async (input, signal) => {
        observed.retained = input.retainStateUpdate
        const result = await validate(input, signal)
        if (result.kind !== 'retry') observed.validation = result
        return result
      },
      native: {client: {readLiveApplicationAck: async () => null} as never, workspace: 'handle', registrationId: 1,
        coordinate: current.host, binding: current.binding, invalidated: new AbortController().signal,
        changes: createNamedFrameChanges(1), deadlineMs: 1_000, nextRequestId: () => 1, drain: async () => {}},
      bounds: {maxClientVectorBytes: 1_000, maxSyncOutputBytes: 1_000_000, maxAppliedUpdateBytes: 1_000_000,
        maxSubmissionBytes: 1_000_000, maxAdmissionBytes: 128 * 1024 * 1024},
    })
    try {
      expect(await frameHost.submit({deliveryId, updateDigest: hash(bytes), updateBytes: bytes,
        authorContext: {kind: 'account', accountId}}, new AbortController().signal))
        .toEqual({result: 'retry', reason: 'application-pending'})
      if (observed.validation?.kind !== 'accepted') throw new Error('Named validation refused')
      return {validation: observed.validation, retained: observed.retained}
    } finally {frameHost.close()}
  }
  try {
    for (const index of [0, 958, 959]) {
      if (index === 958) seedMiddleAuthors(f, 'named')
      if (index === 959) {
        for (let parked = 0; parked < parkedEdits; parked++) {
          f.doc.clientID = 30_000 + parked
          const known = await submitNamed(f.update(`known-${parked}`), `known-delivery-${parked}`, 0)
          expect(known.retained).toBe(false)
          expect(known.validation.evidence.stateUpdate).toBeUndefined()
          const afterKnown = f.storage.readLiveUpdateJournalCut({document: f.input.evidence.document})
          if (afterKnown.kind !== 'cut') throw new Error('Known-author cut missing')
          expect(afterKnown.cut.suffix.at(-1)?.metadata.checkpointCoverage).toBeUndefined()
        }
      }
      f.doc.clientID = 10_000 + index
      const before = Y.encodeStateVector(f.doc)
      if (index === 959) f.doc.getMap('frontmatter').delete('author-0')
      f.doc.getMap('frontmatter').set(`author-${index}`, String(index))
      const bytes = Y.encodeStateAsUpdate(f.doc, before)
      if (index < 959) {
        const input = await capture(bytes, `window-${index}`, index)
        expect(input.validation.kind, `Author ${index}: ${JSON.stringify(input.validation.kind === 'refused' ? input.validation : {kind: input.validation.kind})}`).toBe('accepted')
        const result = f.storage.commitLiveUpdateJournal(input)
        expect(result.result.kind, `Author ${index}: ${JSON.stringify(result.result)}`).toBe('accepted')
        expect(result.admitted?.metadata.checkpointCoverage).toBeUndefined()
        if (index === 958) expect(f.storage.readLiveUpdateJournalCut({document: f.input.evidence.document}))
          .toMatchObject({kind: 'cut', cut: {highWater: 959, suffixCount: 959, checkpoint: {cursor: null}}})
      } else {
        const submitted = await submitNamed(bytes, `window-${index}`, index)
        expect(submitted.retained).toBe(true)
        expect(submitted.validation.evidence.stateUpdate).toBeInstanceOf(Uint8Array)
        const checkpoint = f.storage.readLiveUpdateJournalCut({document: f.input.evidence.document})
        if (checkpoint.kind !== 'cut') throw new Error('Named checkpoint missing')
        expect(checkpoint.cut).toMatchObject({highWater: checkpointCursor, suffixCount: 0, checkpoint: {cursor: checkpointCursor}})
        const coverage = checkpoint.cut.checkpoint.metadata!.checkpointCoverage!
        expect(coverage).toHaveLength(960)
      }
    }
    const cut = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
    expect(cut.kind).toBe('cut')
    if (cut.kind !== 'cut') throw new Error('Checkpoint cut missing')
    expect(cut.cut).toMatchObject({ highWater: checkpointCursor, suffixCount: 0, checkpoint: { cursor: checkpointCursor } })
    expect(cut.cut.checkpoint.metadata?.checkpointCoverage).toHaveLength(960)
    expect(Object.fromEntries(cut.cut.checkpoint.metadata!.checkpointCoverage!.map(entry => [
      entry.author.kind === 'human' ? entry.author.humanId : 'unexpected-author', entry,
    ]))).toEqual(Object.fromEntries(Array.from({length: 960}, (_, index) => [`author-${index}`, {
      author: {kind: 'human', humanId: `author-${index}`, humanName: 'Alice'},
      structRanges: [{clientId: 10_000 + index, startClock: 0, endClock: 1},
        ...(index === 0 ? Array.from({length: parkedEdits}, (_, parked) => ({clientId: 30_000 + parked, startClock: 0, endClock: 1})) : [])],
      deletionRanges: index === 959 ? [{clientId: 10_000, startClock: 0, endClock: 1}] : [],
    }])))
    expect(hash(cut.cut.checkpoint.bytes)).toBe(cut.cut.checkpoint.digest)
    const checkpointDoc = new Y.Doc()
    try {
      Y.applyUpdate(checkpointDoc, cut.cut.checkpoint.bytes)
      expect(Y.encodeStateAsUpdate(checkpointDoc)).toEqual(Y.encodeStateAsUpdate(f.doc))
    } finally {checkpointDoc.destroy()}
    f.doc.clientID = 20_000
    const next = await submitNamed(f.update('next-window', 'Fresh'), 'next-window', 960)
    expect(next.retained).toBe(false)
    expect(next.validation.evidence.stateUpdate).toBeUndefined()
    const advanced = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
    expect(advanced).toMatchObject({ kind: 'cut', cut: { highWater: checkpointCursor + 1, suffixCount: 1, checkpoint: { cursor: checkpointCursor },
      suffix: [{ metadata: { authorSnapshot: [{kind: 'human', humanId: 'author-960', humanName: 'Alice'}] } }] } })
  } finally { await executor.close() }
})

it('cuts a complete checkpoint when the owner outbox introduces the 960th identity and continues draining', async () => {
  const journalPolicy = {...policy, maxIndexOperations: 100_000_000}
  const f = setup({journalPolicy}), executor = createLiveValidationExecutor(), validate = executor.validator(journalPolicy)
  const document = f.input.evidence.document
  const insert = authorGrantInsert(f.raw)
  try {
    for (const index of [0, 958]) {
      if (index === 958) seedMiddleAuthors(f, 'owner')
      const accountId = index === 0 ? 'owner' : `outbox-author-${index}`, grantId = `outbox-grant-${index}`
      if (index !== 0) insert.run(grantId, accountId)
      const actor = index === 0 ? f.actor : {kind: 'named' as const, userId: accountId, grantId}
      const current = f.storage.resolveCurrentLiveDocumentBinding({document, actor})
      const read = f.storage.readLiveUpdateJournalCut({document})
      if (current.kind !== 'current' || read.kind !== 'cut') throw new Error('Owner seed cut missing')
      f.doc.clientID = 60_000 + index
      const bytes = f.update(`outbox-author-${index}`, String(index)), cut = read.cut
      const validation = await validate({document, currentPath: cut.currentPath, checkpoint: cut.checkpoint.bytes,
        suffix: cut.suffix.map(row => row.bytes), candidate: bytes,
        retainStateUpdate: liveAuthorCheckpointAnticipated(cut.suffix.map(row => row.metadata),
          [{kind: 'human', humanId: accountId, humanName: 'Alice'}])})
      if (validation.kind !== 'accepted') throw new Error('Owner seed validation refused')
      const committed = f.storage.commitLiveUpdateJournal(authored({host: current.host, actor, expectedAuthority: current.authority,
        metadata: {deliveryId: `outbox-seed-${index}`, updateDigest: hash(bytes), binding: current.binding}, cutToken: cut,
        validation, updateBytes: bytes, receivedAtMs: 30}, {kind: 'account', accountId}))
      expect(committed.result.kind).toBe('accepted')
      expect(committed.admitted?.metadata.checkpointCoverage).toBeUndefined()
    }
    expect(f.storage.readLiveUpdateJournalCut({document}))
      .toMatchObject({kind: 'cut', cut: {highWater: 959, suffixCount: 959, checkpoint: {cursor: null}}})
    const current = f.storage.resolveCurrentLiveDocumentBinding({document, actor: f.actor})
    if (current.kind !== 'current') throw new Error('Owner authority missing')
    const {binding, host} = current
    const agentDeclaration = {agentId: 'owner-agent', onBehalfOf: null, depth: 0}
    const updates = [0, 1].map(index => {
      f.doc.clientID = 70_000 + index
      return f.update(`owner-agent-${index}`, 'Agent edit')
    })
    const pending = updates.map((bytes, index) => ({sequence: index + 1, appendKey: `owner-agent-append-${index}`,
      deliveryId: `owner-agent-delivery-${index}`, updateDigest: hash(bytes), byteLength: bytes.byteLength,
      createdAtMs: index + 1, agentDeclaration}))
    const receipts: unknown[] = []
    const cursor = (snapshot: string, part: string, sequence = 0) => ({snapshot, part, sequence, offset: 0})
    const client = {sendRequest: async (request: {id: number; method: string; params: Record<string, unknown>}) => {
      const pendingBytes = pending.reduce((sum, entry) => sum + entry.byteLength, 0)
      if (request.method === 'liveApplication.ownerOutbox') {
        return {id: request.id, result: {outboxId: 'outbox', pendingBytes, state: 'active', retryDeliveryId: null}}
      }
      if (request.method === 'liveApplication.acknowledgeOwnerOutbox') {
        const receipt = (request.params.receipts as Array<{deliveryId: string; updateDigest: string}>)[0]!
        expect(receipt).toMatchObject({deliveryId: pending[0]!.deliveryId, updateDigest: pending[0]!.updateDigest})
        receipts.push(receipt)
        pending.shift()
        return {id: request.id, result: {acknowledged: 1,
          pendingBytes: pending.reduce((sum, entry) => sum + entry.byteLength, 0), oldestEntryAtMs: pending[0]?.createdAtMs ?? null}}
      }
      expect(request.method).toBe('liveApplication.readOwnerOutbox')
      const snapshot = hash(Buffer.from(JSON.stringify(pending)))
      const position = request.params.cursor as ReturnType<typeof cursor> | undefined
      const at = position ?? cursor(snapshot, 'header')
      expect(at.snapshot).toBe(snapshot)
      let bytes: Buffer, nextCursor: ReturnType<typeof cursor> | null
      if (at.part === 'header') {
        bytes = Buffer.from(JSON.stringify({outboxId: 'outbox', binding, baseUpdateDigest: binding.lineageClaimId,
          baseByteLength: f.input.baselineBytes.byteLength, state: 'active', pendingBytes, pendingEntryCount: pending.length,
          nextSequence: 3, oldestEntryAtMs: pending[0]?.createdAtMs ?? null, quarantineReason: null, observedBinding: null, retryDeliveryId: null,
          firstEntryCursor: pending[0] ? cursor(snapshot, 'entryHeader', pending[0].sequence) : null,
          frozenAtRefusedSeed: false, checkpointDigest: null, recoveryCheckpointDigest: null}))
        nextCursor = cursor(snapshot, 'base')
      } else if (at.part === 'entryHeader') {
        bytes = Buffer.from(JSON.stringify(pending.find(entry => entry.sequence === at.sequence)))
        nextCursor = cursor(snapshot, 'update', at.sequence)
      } else {
        expect(at.part).toBe('update')
        bytes = Buffer.from(updates[at.sequence - 1]!)
        const next = pending.find(entry => entry.sequence > at.sequence)
        nextCursor = next ? cursor(snapshot, 'entryHeader', next.sequence) : null
      }
      return {id: request.id, result: {kind: 'page', ...at, totalBytes: bytes.byteLength, digest: hash(bytes),
        bytesBase64: bytes.toString('base64'), nextCursor}}
    }}
    const retained: Array<boolean | undefined> = [], validations: LiveJournalValidation[] = []
    const admission: OwnerOutboxAdmission = {shares: new Map([[document.workspaceId, 'share']]), maxEntriesPerDrain: 1,
      maxBytesPerDrain: 10_000, refusals: new OwnerKnownRefusals(), trustedAccount: accountId => ({accountId, name: 'Alice'}),
      validate: async (input, signal) => {
        retained.push(input.retainStateUpdate)
        const result = await validate(input, signal)
        if (result.kind !== 'retry') validations.push(result)
        return result
      }}
    let requestId = 0
    const drain = () => drainOwnerOutbox({storage: f.storage, admission, client: client as unknown as EngineClient,
      workspace: 'handle', host, registrationId: 1, binding, adoption: {adoptionId: 'adoption', sequence: 1, applied() {}},
      nextRequestId: () => ++requestId, deadlineMs: 1_000, assertCurrent() {},
      applyThrough: async receipt => ({...receipt, localYDocSequence: receipt.journalCursor, applicationReplayed: false})})
    expect(await drain()).toEqual({admittedEntries: 1, hasMore: true})
    expect(retained).toEqual([true])
    expect(validations[0]).toMatchObject({kind: 'accepted', evidence: {stateUpdate: expect.any(Uint8Array)}})
    const checkpoint = f.storage.readLiveUpdateJournalCut({document})
    if (checkpoint.kind !== 'cut') throw new Error('Owner checkpoint missing')
    expect(checkpoint.cut).toMatchObject({highWater: 960, suffixCount: 0, checkpoint: {cursor: 960}})
    const coverage = checkpoint.cut.checkpoint.metadata!.checkpointCoverage!
    expect(coverage).toHaveLength(960)
    expect(Object.fromEntries(coverage.filter(entry => entry.author.kind === 'human').map(entry => [
      entry.author.kind === 'human' ? entry.author.humanId : 'unexpected-author', entry,
    ]))).toEqual(Object.fromEntries(Array.from({length: 959}, (_, index) => {
      const humanId = index === 0 ? 'owner' : `outbox-author-${index}`
      return [humanId, {author: {kind: 'human', humanId, humanName: 'Alice'},
        structRanges: [{clientId: 60_000 + index, startClock: 0, endClock: 1},
          ...(index === 0 ? [{clientId: 70_000, startClock: 0, endClock: 1}] : [])], deletionRanges: []}]
    })))
    expect(coverage).toContainEqual(expect.objectContaining({author: {kind: 'agent', agentId: 'owner-agent', onBehalfOf: 'owner', depth: 0},
      structRanges: [{clientId: 70_000, startClock: 0, endClock: 1}]}))
    expect(hash(checkpoint.cut.checkpoint.bytes)).toBe(checkpoint.cut.checkpoint.digest)
    const checkpointDoc = new Y.Doc()
    try {
      Y.applyUpdate(checkpointDoc, checkpoint.cut.checkpoint.bytes)
      expect(checkpointDoc.getMap('frontmatter').toJSON()).toEqual({
        ...Object.fromEntries(Array.from({length: 959}, (_, index) => [`outbox-author-${index}`, String(index)])),
        'owner-agent-0': 'Agent edit',
      })
    } finally {checkpointDoc.destroy()}
    expect(await drain()).toEqual({admittedEntries: 1, hasMore: false})
    expect(receipts).toHaveLength(2)
    expect(retained).toEqual([true, false])
    if (validations[1]?.kind !== 'accepted') throw new Error('Continued owner validation refused')
    expect(validations[1].evidence.stateUpdate).toBeUndefined()
    const advanced = f.storage.readLiveUpdateJournalCut({document})
    expect(advanced).toMatchObject({kind: 'cut', cut: {highWater: 961, suffixCount: 1, checkpoint: {cursor: 960},
      suffix: [{metadata: {authorSnapshot: [{kind: 'human', humanId: 'owner', humanName: 'Alice'},
        {kind: 'agent', agentId: 'owner-agent', onBehalfOf: 'owner', depth: 0}]}}]}})
  } finally {await executor.close()}
})

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
