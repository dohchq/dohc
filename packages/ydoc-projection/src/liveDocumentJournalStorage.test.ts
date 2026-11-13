import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { parseHostEpoch } from '@dohc/live-session-contract/host-control'
import { markdownToYDoc } from './import-export.js'
import { journalMetadataBytes, liveDeliveryBookkeepingBytes } from './liveDeliveryQuotaTestSupport.js'
import { liveBaselineStoredBytes } from './liveBaselineQuotaTestSupport.js'
import { createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator } from './liveDocumentValidation.js'
import { initializeRelayDeployment, openRelayDeployment } from '../../../services/sync-relay/src/relayDeployment.js'
import { openSyncRelayStorage, type LiveUpdateJournalCommitInput } from '../../../services/sync-relay/src/storage.js'
import { openEmptyRelayTestStorage } from '../../../services/sync-relay/src/testing/emptyRelayStorage.js'
import type { StorageContext } from '../../../services/sync-relay/src/storage/context.js'
import type { SqliteDb } from '../../../services/sync-relay/src/storage/types.js'
import {attachLiveJournalHistory, createLiveJournalHistoryAuthority} from '../../../services/sync-relay/src/storage/liveJournalHistory.js'

function openJournalStorage(...args: Parameters<typeof openSyncRelayStorage>) {
  return withJournalHistory(openSyncRelayStorage(...args))
}
function withJournalHistory(storage: ReturnType<typeof openSyncRelayStorage>) {
  attachLiveJournalHistory(storage as StorageContext, createLiveJournalHistoryAuthority({namespace: 'journal-test', reconciled: true}))
  return storage
}

const policy = {
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
}
const validate = createLiveMarkdownRegistrationValidator(policy)
const validateJournal = createLiveMarkdownJournalValidator(policy)
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const host = { mode: 'device', hostId: 'host', hostEpoch: parseHostEpoch(1), instanceId: 'instance', connectionId: 'connection' } as const
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function checkpoint(markdown = 'Hello', edit?: (doc: Y.Doc) => void): Uint8Array {
  const doc = markdownToYDoc(markdown)
  try { edit?.(doc); return Y.encodeStateAsUpdate(doc) } finally { doc.destroy() }
}
function validated(bytes = checkpoint(), currentPath = 'docs/a.md', objectId = 'object') {
  const captured = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const document = { workspaceId: 'workspace', mainVersionId: 'main', objectId, lineageClaimId: hash(captured) }
  const result = validate({ document, currentPath, checkpoint: captured })
  expect(result.kind).toBe('accepted')
  if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  const baselineBytes = Uint8Array.from(captured)
  expect(hash(baselineBytes)).toBe(result.evidence.checkpoint.updateDigest)
  return { host: { ...host }, evidence: result.evidence, baselineBytes, registeredAtMs: 10 }
}
function fixture(options: { workspaceQuotaBytes?: number; deployment?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dohc-baseline-storage-')); roots.push(root)
  const path = options.deployment ? join(root, 'volume', 'relay.sqlite') : join(root, 'relay.sqlite')
  const configPath = join(root, 'deployment.json')
  if (options.deployment) initializeRelayDeployment({ configPath, relayPath: path, continuityDirectory: join(root, 'continuity') })
  const storage = options.deployment ? openRelayDeployment(configPath, options).storage : withJournalHistory(openEmptyRelayTestStorage(path, options))
  const raw = new DatabaseSync(path, { readOnly: options.deployment === true })
  const write = (run: (db: SqliteDb | InstanceType<typeof DatabaseSync>) => void) => {
    if (options.deployment) {
      const context = storage as StorageContext
      context.tx(() => run(context.db))
    } else run(raw)
  }
  try {
    write(db => { db.prepare('INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, ?)').run('workspace', 'owner', 0) })
    storage.provisionLiveHostControl({ mode: host.mode, hostId: host.hostId, updatedAtMs: 1, guard() {} })
    storage.registerLiveHost({ ...host, updatedAtMs: 2, guard() {} })
  } catch (error) { raw.close(); storage.close(); throw error }
  const moment = (input: ReturnType<typeof validated>, sequence = 1, changes: Record<string, unknown> = {}) => {
    const row = { workspace_id: 'workspace', object_id: input.evidence.document.objectId, relay_seq: sequence, moment_id: `moment-${sequence}`,
      version_id: 'main', path: input.evidence.currentPath, blob_sha256: input.evidence.projectedMarkdownSha256,
      content_kind: 'text', byte_length: input.evidence.projectedMarkdownByteLength, recorded_at_ms: sequence, ...changes }
    write(db => { db.prepare(`INSERT INTO sync_relay_object_moments (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
      .run(...Object.values(row) as Array<string | number | null>) })
  }
  const rows = () => ({ documents: raw.prepare('SELECT * FROM sync_relay_live_documents ORDER BY lineage_claim_id').all(),
    ranges: raw.prepare('SELECT * FROM sync_relay_live_document_baseline_ranges ORDER BY client_id, start_clock').all() })
  return { storage, raw, path, write, moment, rows, close() { raw.close(); storage.close() } }
}

function registered(options: { workspaceQuotaBytes?: number; deployment?: boolean; baselineBytes?: Uint8Array; journalPolicy?: typeof policy } = {}) {
  const f = fixture(options), input = validated(options.baselineBytes); f.moment(input)
  expect(f.storage.registerLiveDocumentBaseline(input).kind).toBe('registered')
  f.write(db => {
    db.prepare(`INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms)
      VALUES ('share','workspace','owner',?,0)`).run(JSON.stringify({ paths: ['docs'], versionId: null }))
    db.exec(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES ('grant','share','user','reader',NULL,'edit',4,'active',0,NULL,NULL)`)
  })
  const doc = new Y.Doc(); Y.applyUpdate(doc, input.baselineBytes)
  const actor = { kind: 'owner', userId: 'owner' } as const
  const update = (key = 'title', value = 'Changed') => {
    const before = Y.encodeStateVector(doc); doc.getMap('frontmatter').set(key, value)
    return Y.encodeStateAsUpdate(doc, before)
  }
  const capture = (bytes: Uint8Array, deliveryId = 'delivery', candidateActor: LiveUpdateJournalCommitInput['actor'] = actor,
    onStateCapture?: () => void): LiveUpdateJournalCommitInput => {
    const current = f.storage.resolveCurrentLiveDocumentBinding({ document: input.evidence.document, actor: candidateActor })
    if (current.kind !== 'current') throw new Error(JSON.stringify(current))
    const cut = f.storage.readLiveUpdateJournalCut({ document: input.evidence.document })
    if (cut.kind !== 'cut') throw new Error(JSON.stringify(cut))
    const captured = Uint8Array.from(bytes), digest = hash(captured)
    const validation = (options.journalPolicy ? createLiveMarkdownJournalValidator(options.journalPolicy) : validateJournal)({ document: cut.cut.document, currentPath: cut.cut.currentPath,
      checkpoint: cut.cut.checkpoint.bytes, suffix: cut.cut.suffix.map(row => row.bytes), candidate: captured })
    const due = cut.cut.suffixCount + 1 === 4095 || cut.cut.suffixBytes + captured.byteLength >= 20_971_520
    const state = validation.kind === 'accepted' && due ? (() => {
      onStateCapture?.()
      return { stateUpdate: validation.evidence.stateUpdate }
    })() : {}
    const owned = validation.kind === 'accepted' ? { kind: validation.kind, evidence: { version: validation.evidence.version,
      document: validation.evidence.document, currentPath: validation.evidence.currentPath, checkpointDigest: validation.evidence.checkpointDigest, checkpointRanges: validation.evidence.checkpointRanges,
      suffixDigests: validation.evidence.suffixDigests, candidate: validation.evidence.candidate,
      ...state,
      projectedMarkdownSha256:validation.evidence.projectedMarkdownSha256, projectedMarkdownByteLength:validation.evidence.projectedMarkdownByteLength,
              stateUpdateSha256: validation.evidence.stateUpdateSha256, stateUpdateByteLength: validation.evidence.stateUpdateByteLength } } : validation
    expect(hash(captured)).toBe(digest)
    if (owned.kind === 'accepted') expect(owned.evidence.candidate.updateDigest).toBe(digest)
    return { host: current.host, actor: candidateActor, expectedAuthority: current.authority,
      metadata: { deliveryId, updateDigest: digest, binding: current.binding }, cutToken: cut.cut, validation: owned,
      updateBytes: Uint8Array.from(captured), receivedAtMs: 30 }
  }
  const journalRows = () => ({ journal: f.raw.prepare('SELECT * FROM sync_relay_live_update_journal ORDER BY journal_cursor').all(),
    provenance: f.raw.prepare('SELECT * FROM sync_relay_live_update_struct_provenance ORDER BY client_id,start_clock').all(),
    usage: f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes })
  return { ...f, input, actor, doc, update, capture, journalRows, close() { doc.destroy(); f.close() } }
}

it.each(['named'] as readonly ('owner' | 'named')[])('commits real %s journal evidence, original bytes and immutable replay', kind => {
  const f = registered()
  try {
    const actor = kind === 'owner' ? f.actor : { kind, userId: 'reader', grantId: 'grant' } as const
    const input = f.capture(f.update(), 'delivery', actor)
    expect(input.validation.kind).toBe('accepted')
    if (input.validation.kind !== 'accepted') throw new Error('validation refused')
    expect(Array.from(input.updateBytes)).not.toEqual(Array.from(Y.encodeStateAsUpdate(f.doc)))
    const accepted = f.storage.commitLiveUpdateJournal(input)
    expect(accepted.result).toMatchObject({ kind: 'accepted', replayed: false, receipt: { deliveryId: 'delivery', journalCursor: 1, acceptingHostEpoch: 1 } })
    expect(accepted.admitted?.updateBytes).toEqual(input.updateBytes)
    expect(accepted.admitted?.metadata.firstSeen).toEqual(input.validation.evidence.candidate.ranges)
    const before = f.journalRows()
    expect(before.journal[0]!.validation_checkpoint_bytes).toBeNull()
    expect(before.usage).toBe(liveBaselineStoredBytes(f.raw) + input.updateBytes.byteLength + journalMetadataBytes(f.raw) + liveDeliveryBookkeepingBytes(f.raw))
    for (const reopen of [false, true]) {
      const storage = reopen ? openJournalStorage(f.path) : f.storage
      try {
        const replay = storage.commitLiveUpdateJournal({ ...input, receivedAtMs: 99,
          validation: { kind: 'refused', source: 'candidate', reason: 'capacity-refused' } })
        expect(replay).toEqual({ ...accepted, result: { ...accepted.result, replayed: true } })
        expect(storage.readCommittedLiveUpdate({ host, document: input.cutToken.document, journalCursor: 1 }))
          .toEqual({ kind: 'committed', admitted: accepted.admitted })
        expect(f.journalRows()).toEqual(before)
      } finally { if (reopen) storage.close() }
    }
  } finally { f.close() }
})

it.each(['usage'] as readonly ('journal' | 'provenance' | 'usage')[])('rolls back every retained byte when %s insertion fails', stage => {
  const f = registered()
  try {
    const input = f.capture(f.update()), before = f.journalRows()
    const table = stage === 'journal' ? 'sync_relay_live_update_journal' : stage === 'provenance' ? 'sync_relay_live_update_struct_provenance' : 'sync_relay_workspace_usage'
    f.raw.exec(`CREATE TRIGGER fail_journal BEFORE ${stage === 'usage' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'journal injected'); END`)
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow('journal injected')
    expect(f.journalRows()).toEqual(before)
    f.raw.exec('DROP TRIGGER fail_journal')
    expect(f.storage.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', receipt: { journalCursor: 1 } })
  } finally { f.close() }
})

it.each(['generation', 'grant', 'fence'] as readonly ('host' | 'generation' | 'grant' | 'fence' | 'path' | 'owner')[])('checks current %s before exact replay', guard => {
  const f = registered()
  try {
    const input = f.capture(f.update(), 'delivery', { kind: 'named', userId: 'reader', grantId: 'grant' })
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    const sql = { host: "UPDATE sync_relay_session_host_control SET admission_state='closed',registered_connection_id=NULL",
      generation: "UPDATE sync_relay_share_grants SET generation=5 WHERE grant_id='grant'",
      grant: "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=40 WHERE grant_id='grant'",
      fence: 'UPDATE sync_relay_live_documents SET restore_fence_generation=2',
      path: "UPDATE sync_relay_object_moments SET path='docs/other.md'",
      owner: "UPDATE sync_relay_workspaces SET owner_user_id='different'" }[guard]
    f.raw.exec(sql)
    const before = f.journalRows()
    if (guard === 'path') expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow()
    else if (guard === 'fence') expect(f.storage.commitLiveUpdateJournal(input).result).toEqual({ kind: 'refused', reason: 'restore-fenced' })
    else expect(f.storage.commitLiveUpdateJournal(input).result.kind).not.toBe('accepted')
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it.each(['candidate', 'admitted-cut', 'call'] as readonly ('candidate' | 'final' | 'admitted-cut' | 'call')[])('linearizes %s validation refusal without retained facts', source => {
  const f = registered()
  try {
    const input: LiveUpdateJournalCommitInput = { ...f.capture(f.update()), validation: { kind: 'refused', source, reason: 'capacity-refused' } }, before = f.journalRows()
    if (source === 'candidate' || source === 'final') expect(f.storage.commitLiveUpdateJournal(input)).toEqual({ result: { kind: 'refused', reason: 'capacity-refused' }, admitted: null })
    else expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow(source === 'call' ? /integration/ : /exceeds the validation policy/)
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it('copies caller bytes and committed result bytes independently of retained SQLite history', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), bytes = Uint8Array.from(input.updateBytes)
    const result = f.storage.commitLiveUpdateJournal(input)
    if (result.result.kind !== 'accepted' || !result.admitted) throw new Error('commit refused')
    const metadata = structuredClone(result.admitted.metadata)
    input.updateBytes.fill(0)
    input.cutToken.checkpoint.bytes.fill(0)
    result.admitted.updateBytes.fill(0)
    Object.defineProperty(result.admitted.metadata.firstSeen[0]!, 'startClock', { value: 999 })
    const recovered = f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 1 })
    expect(recovered).toEqual({ kind: 'committed', admitted: { updateBytes: bytes, metadata } })
    if (recovered.kind !== 'committed') throw new Error('recovery refused')
    recovered.admitted.updateBytes.fill(1)
    expect(f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 1 }))
      .toEqual({ kind: 'committed', admitted: { updateBytes: bytes, metadata } })
  } finally { f.close() }
})

it('two connections resolve identical delivery races and retry stale refused cuts before their refusal', () => {
  const f = registered(), second = openJournalStorage(f.path)
  try {
    const bytes = f.update(), left = f.capture(bytes, 'same'), right = f.capture(bytes, 'same')
    const stale = f.capture(bytes, 'different')
    const committed = f.storage.commitLiveUpdateJournal(left)
    expect(committed.result.kind).toBe('accepted')
    expect(second.commitLiveUpdateJournal(right)).toEqual({ ...committed, result: { ...committed.result, replayed: true } })
    expect(second.commitLiveUpdateJournal({ ...stale, validation: { kind: 'refused', source: 'candidate', reason: 'invalid-update' } }))
      .toEqual({ result: { kind: 'retry', reason: 'admission-unavailable' }, admitted: null })
    expect(second.commitLiveUpdateJournal(f.capture(bytes, 'different')).result).toMatchObject({ kind: 'accepted', replayed: false })
    expect(f.journalRows().journal).toHaveLength(2)
  } finally { second.close(); f.close() }
})

it('does not reinterpret post-write COMMIT busy as a retry or expose an accepted event', () => {
  const f = registered()
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined
  let fixtureClosed = false
  try {
    const input = f.capture(f.update()), before = f.journalRows(), original = DatabaseSync.prototype.exec
    const fault = Object.assign(new Error('commit locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      if (sql === 'COMMIT') throw fault
      return Reflect.apply(original, this, [sql])
    })
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow(fault)
    spy.mockRestore()
    expect(f.journalRows()).toEqual(before)
    expect(f.storage.unavailable.aborted).toBe(true)
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow('unavailable')
    f.close()
    fixtureClosed = true
    reopened = openJournalStorage(f.path)
    expect(reopened.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', receipt: { journalCursor: 1 } })
  } finally {
    reopened?.close()
    if (!fixtureClosed) f.close()
  }
})

it('retains committed recovery after authority, share and object removal, then cascades workspace deletion without cursor reuse', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), committed = f.storage.commitLiveUpdateJournal(input)
    if (!committed.admitted) throw new Error('commit refused')
    f.raw.exec('DELETE FROM sync_relay_live_documents; DELETE FROM sync_relay_share_grants; DELETE FROM sync_relay_shares; DELETE FROM sync_relay_object_moments')
    const reopened = openJournalStorage(f.path)
    try {
      expect(reopened.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 1 }))
        .toEqual({ kind: 'committed', admitted: committed.admitted })
      expect(reopened.readCommittedLiveUpdate({ host, document: { ...f.input.evidence.document, objectId: 'other' }, journalCursor: 1 })).toEqual({ kind: 'missing' })
    } finally { reopened.close() }
    f.raw.exec("DELETE FROM sync_relay_workspaces WHERE workspace_id='workspace'")
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM sync_relay_live_update_journal').get()!.n).toBe(0)
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM sync_relay_live_update_struct_provenance').get()!.n).toBe(0)
    expect(f.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_relay_live_update_journal'").get()!.seq).toBe(1)
    f.raw.prepare('INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES (?,?,?)').run('workspace','owner',0)
    f.moment(f.input, 2)
    expect(f.storage.registerLiveDocumentBaseline(f.input).kind).toBe('registered')
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','owner',?,0)").run(JSON.stringify({ paths: ['docs'], versionId: null }))
    expect(f.storage.commitLiveUpdateJournal(f.capture(input.updateBytes, 'new')).result)
      .toMatchObject({ kind: 'accepted', receipt: { journalCursor: 2 } })
  } finally { f.close() }
})

function gcCandidate(clientId: number, startClock: number, length: number): Uint8Array {
  const { writeVarUint } = createRequire(import.meta.url)('lib0/encoding') as typeof import('lib0/encoding')
  const encoder = new Y.UpdateEncoderV1()
  writeVarUint(encoder.restEncoder, 1)
  writeVarUint(encoder.restEncoder, 1)
  encoder.writeClient(clientId)
  writeVarUint(encoder.restEncoder, startClock)
  new Y.GC(Y.createID(clientId, startClock), length).write(encoder, 0)
  writeVarUint(encoder.restEncoder, 1)
  writeVarUint(encoder.restEncoder, clientId)
  writeVarUint(encoder.restEncoder, 1)
  encoder.writeDsClock(startClock)
  encoder.writeDsLen(length)
  return encoder.toUint8Array()
}

it('refuses first-seen starting inside a stored row and accepts another cursor touching it', () => {
  const f = registered()
  try {
    expect(f.storage.commitLiveUpdateJournal(f.capture(gcCandidate(91, 0, 10), 'history')).result.kind).toBe('accepted')
    const input = f.capture(gcCandidate(91, 5, 3), 'overlap')
    if (input.validation.kind !== 'accepted') throw Error(input.validation.kind)
    const overlapping = {...input, validation: {...input.validation, evidence: {...input.validation.evidence,
      candidate: {...input.validation.evidence.candidate, firstSeen: [{clientId: 91, startClock: 5, endClock: 8}]}}}}
    expect(f.storage.commitLiveUpdateJournal(overlapping).result).toEqual({kind: 'refused', reason: 'provenance-refused'})
    expect(f.storage.commitLiveUpdateJournal(f.capture(gcCandidate(91, 10, 1), 'touching')).result.kind).toBe('accepted')
  } finally {f.close()}
})

it('subtracts prior GC coverage, retaining adjacent first authors and separate clients', () => {
  const f = registered()
  try {
    const admitted = (bytes: Uint8Array, delivery: string) => {
      const input = f.capture(bytes, delivery)
      expect(input.validation.kind).toBe('accepted')
      const result = f.storage.commitLiveUpdateJournal(input)
      if (!result.admitted) throw new Error(JSON.stringify(result))
      return result.admitted.metadata.firstSeen
    }
    expect(admitted(gcCandidate(91, 0, 2), 'a')).toEqual([{ clientId: 91, startClock: 0, endClock: 2 }])
    expect(admitted(gcCandidate(91, 0, 5), 'b')).toEqual([{ clientId: 91, startClock: 2, endClock: 5 }])
    expect(admitted(gcCandidate(91, 1, 3), 'duplicate')).toEqual([])
    expect(admitted(gcCandidate(92, 0, 3), 'other')).toEqual([{ clientId: 92, startClock: 0, endClock: 3 }])
    expect(f.journalRows().provenance.map(row => [row.client_id,row.start_clock,row.end_clock,row.journal_cursor]))
      .toEqual([[91,0,2,1],[91,2,5,2],[92,0,3,4]])
  } finally { f.close() }
})

it.each(['connectionId'] as const)('rejects a different host %s before exact replay', field => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    const changed = { ...input.host, [field]: 'other' }
    const before = f.journalRows()
    expect(f.storage.commitLiveUpdateJournal({ ...input, host: changed as typeof input.host }).result)
      .toEqual({ kind: 'refused', reason: 'stale-session' })
    expect(f.journalRows()).toEqual(before)
it.each(['principalId','grantId','grantGeneration','principalKind'] as const)('compares the captured authority %s before replay', field => {
  const f = registered()
  try {
    const input = f.capture(f.update(), 'delivery', { kind: 'named', userId: 'reader', grantId: 'grant' })
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    const changed = field === 'principalKind' ? { principalKind: 'owner' as const, principalId: 'reader', grantId: null, grantGeneration: null }
      : { ...input.expectedAuthority, [field]: field === 'grantGeneration' ? 5 : 'other' }
    const before = f.journalRows()
    expect(f.storage.commitLiveUpdateJournal({ ...input, expectedAuthority: changed }).result)
      .toEqual({ kind: 'refused', reason: 'authority-refused' })
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

  } finally { f.close() }
})

it('rejects corrupted retained update bytes in cut, replay and committed recovery', () => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    const corrupted = Uint8Array.from(input.updateBytes); corrupted[corrupted.length - 1] ^= 1
    f.raw.prepare('UPDATE sync_relay_live_update_journal SET update_bytes=?').run(corrupted)
    expect(() => f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })).toThrow(/damaged/)
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow(/damaged/)
    expect(() => f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 1 })).toThrow(/damaged/)
  } finally { f.close() }
})

it('keeps real admitted-cut capacity distinct without changing accepted history', () => {
  const witness = {
    "policy": {
      "maxStructVisits": 20,
      "maxValueNodeVisits": 4,
      "maxDecodedPayloadByteVisits": 144,
      "maxStructClientGroupVisits": 6,
      "maxDeleteClientGroupVisits": 1,
      "maxDeleteIntervalVisits": 1,
      "maxIndexOperations": 1000
    },
    "stateUpdate": [
      1,
      5,
      215,
      244,
      165,
      249,
      3,
      0,
      40,
      1,
      4,
      109,
      101,
      116,
      97,
      13,
      115,
      99,
      104,
      101,
      109,
      97,
      86,
      101,
      114,
      115,
      105,
      111,
      110,
      1,
      125,
      1,
      7,
      1,
      4,
      98,
      111,
      100,
      121,
      3,
      9,
      112,
      97,
      114,
      97,
      103,
      114,
      97,
      112,
      104,
      7,
      0,
      215,
      244,
      165,
      249,
      3,
      1,
      6,
      4,
      0,
      215,
      244,
      165,
      249,
      3,
      2,
      4,
      84,
      101,
      120,
      116,
      68,
      215,
      244,
      165,
      249,
      3,
      3,
      2,
      48,
      32,
      0
    ]
  }
  const f = registered({ baselineBytes: Uint8Array.from(witness.stateUpdate), journalPolicy: witness.policy })
  try {
    const empty = new Y.Doc()
    const noop = Y.encodeStateAsUpdate(empty); empty.destroy()
    const next = f.capture(noop, 'next')
    expect(next.validation).toMatchObject({ kind: 'refused', source: 'admitted-cut', reason: 'capacity-refused' })
    const before = f.journalRows()
    expect(() => f.storage.commitLiveUpdateJournal(next)).toThrow(/exceeds the validation policy/)
    try { f.storage.commitLiveUpdateJournal(next) } catch (error) {
      expect((error as Error).constructor.name).toBe('LiveJournalAdmittedCapacityError')
      expect(error).toMatchObject({ source: 'admitted-cut', reason: 'capacity-refused' })
    }
    expect(f.journalRows()).toEqual(before)
    expect(f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document }).kind).toBe('cut')
  } finally { f.close() }
})

it.each(['missing', 'closed', 'moved'] as readonly ('missing' | 'closed' | 'moved' | 'replaced')[])('refuses a %s current document without rewriting history', change => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    if (change === 'missing') f.raw.exec('DELETE FROM sync_relay_live_documents')
    if (change === 'closed') f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='closed'")
    if (change === 'moved') f.moment(f.input, 2, { path: 'docs/elsewhere.md' })
    if (change === 'replaced') f.moment(f.input, 2, { object_id: 'replacement' })
    const reason = change === 'missing' ? 'baseline-missing' : change === 'closed' ? 'authority-refused' : 'stale-binding'
    const before = f.journalRows()
    expect(f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })).toEqual({ kind: 'refused', reason })
    expect(f.storage.commitLiveUpdateJournal(input).result).toEqual({ kind: 'refused', reason })
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it('commits a journal update with continuity and replays without another mutation stamp', () => {
  const f = registered({ deployment: true })
  try {
    const stamp = () => Number(f.raw.prepare('SELECT stamp FROM sync_relay_continuity WHERE singleton=1').get()!.stamp)
    const before = stamp(), input = f.capture(f.update())
    const accepted = f.storage.commitLiveUpdateJournal(input)
    expect(accepted.result.kind).toBe('accepted')
    expect(stamp()).toBeGreaterThan(before)
    const committed = stamp()
    expect(f.storage.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', replayed: true })
    expect(stamp()).toBe(committed)
  } finally { f.close() }
})
