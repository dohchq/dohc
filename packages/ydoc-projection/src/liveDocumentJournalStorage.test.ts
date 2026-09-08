import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { parseHostEpoch } from '@dohc/live-session-contract/host-control'
import { markdownToYDoc } from './import-export.js'
import { liveDeliveryBookkeepingBytes, liveDeliveryEventReservationBytes } from './liveDeliveryQuotaTestSupport.js'
import { createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator } from './liveDocumentValidation.js'
import { initializeRelayDeployment, openRelayDeployment } from '../../../services/sync-relay/src/relayDeployment.js'
import { openSyncRelayStorage, type LiveUpdateJournalCommitInput } from '../../../services/sync-relay/src/storage.js'

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
  const storage = options.deployment ? openRelayDeployment(configPath, options).storage : openSyncRelayStorage(path, options)
  const raw = new DatabaseSync(path)
  try {
    raw.prepare('INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, ?)').run('workspace', 'owner', 0)
    storage.provisionLiveHostControl({ mode: host.mode, hostId: host.hostId, updatedAtMs: 1, guard() {} })
    storage.registerLiveHost({ ...host, updatedAtMs: 2, guard() {} })
  } catch (error) { raw.close(); storage.close(); throw error }
  const moment = (input: ReturnType<typeof validated>, sequence = 1, changes: Record<string, unknown> = {}) => {
    const row = { workspace_id: 'workspace', object_id: input.evidence.document.objectId, relay_seq: sequence, moment_id: `moment-${sequence}`,
      version_id: 'main', path: input.evidence.currentPath, blob_sha256: input.evidence.projectedMarkdownSha256,
      content_kind: 'text', byte_length: input.evidence.projectedMarkdownByteLength, recorded_at_ms: sequence, ...changes }
    raw.prepare(`INSERT INTO sync_relay_object_moments (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
      .run(...Object.values(row) as Array<string | number | null>)
  }
  const rows = () => ({ documents: raw.prepare('SELECT * FROM sync_relay_live_documents ORDER BY lineage_claim_id').all(),
    ranges: raw.prepare('SELECT * FROM sync_relay_live_document_baseline_ranges ORDER BY client_id, start_clock').all() })
  return { storage, raw, path, moment, rows, close() { raw.close(); storage.close() } }
}

function registered(options: { workspaceQuotaBytes?: number; deployment?: boolean; baselineBytes?: Uint8Array; journalPolicy?: typeof policy } = {}) {
  const f = fixture(options), input = validated(options.baselineBytes); f.moment(input)
  expect(f.storage.registerLiveDocumentBaseline(input).kind).toBe('registered')
  f.raw.prepare(`INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms)
    VALUES ('share','workspace','owner',?,0)`).run(JSON.stringify({ paths: ['docs'], versionId: null }))
  f.raw.exec(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('grant','share','user','reader',NULL,'edit',4,'active',0,NULL,NULL)`)
  const doc = new Y.Doc(); Y.applyUpdate(doc, input.baselineBytes)
  const actor = { kind: 'owner', userId: 'owner', shareId: 'share' } as const
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
      document: validation.evidence.document, currentPath: validation.evidence.currentPath, checkpointDigest: validation.evidence.checkpointDigest,
      suffixDigests: validation.evidence.suffixDigests, candidate: validation.evidence.candidate,
      ...state,
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

function journalMetadataBytes(db: InstanceType<typeof DatabaseSync>): number {
  const rows = db.prepare('SELECT * FROM sync_relay_live_update_journal').all();
  const metadata = rows.map(row => Object.entries(row).filter(([key]) =>
    key !== 'update_bytes' && key !== 'validation_checkpoint_bytes').map(([, value]) => value));
  const provenance = db.prepare('SELECT * FROM sync_relay_live_update_struct_provenance').all().map(Object.values);
  return [...metadata, ...provenance].reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0);
}

function probeJournalCharge(f: ReturnType<typeof registered>, input: LiveUpdateJournalCommitInput): number {
  const path = `${f.path}.quota-probe`;
  f.raw.prepare('VACUUM INTO ?').run(path);
  const probe = openSyncRelayStorage(path), raw = new DatabaseSync(path);
  try {
    const before = Number(f.journalRows().usage);
    expect(probe.commitLiveUpdateJournal(input).result.kind).toBe('accepted');
    return Number(raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes) - before;
  } finally { raw.close(); probe.close(); }
}

it('charges wide actor selectors and provenance before committing within workspace quota', () => {
  const f = registered();
  try {
    const paths = ['docs', ...Array.from({ length: 99 }, (_, index) => `other/${index}/${'x'.repeat(200)}`)];
    f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='share'").run(JSON.stringify({ paths, versionId: null }));
    const input = f.capture(f.update()), initial = Number(f.journalRows().usage);
    expect(input.updateBytes.byteLength).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(input.metadata.binding.selectorPaths))).toBeGreaterThan(20_000);
    const payloadOnlyQuota = initial + input.updateBytes.byteLength + liveDeliveryEventReservationBytes(input.cutToken.document, host.hostId,
      { journalCursor: 1, deliveryId: input.metadata.deliveryId, updateDigest: input.metadata.updateDigest, acceptingHostEpoch: host.hostEpoch });
    const limited = openSyncRelayStorage(f.path, { workspaceQuotaBytes: payloadOnlyQuota });
    const before = f.journalRows();
    try { expect(() => limited.commitLiveUpdateJournal(input)).toThrow(/quota/); }
    finally { limited.close(); }
    expect(f.journalRows()).toEqual(before);
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted');
    const metadata = journalMetadataBytes(f.raw);
    expect(metadata).toBeGreaterThan(20_000);
    expect(f.journalRows().usage).toBe(f.input.baselineBytes.byteLength + input.updateBytes.byteLength + metadata + liveDeliveryBookkeepingBytes(f.raw));
    const after = f.journalRows();
    expect(f.storage.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', replayed: true });
    expect(f.journalRows()).toEqual(after);
  } finally { f.close(); }
});

it.each(['owner', 'named'] as const)('commits real %s journal evidence, original bytes and immutable replay', kind => {
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
    expect(before.usage).toBe(f.input.baselineBytes.byteLength + input.updateBytes.byteLength + journalMetadataBytes(f.raw) + liveDeliveryBookkeepingBytes(f.raw))
    for (const reopen of [false, true]) {
      const storage = reopen ? openSyncRelayStorage(f.path) : f.storage
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

it('retries a stale cut before applying its refused validation and admits a fresh dependent cut', () => {
  const f = registered()
  try {
    const first = f.capture(f.update('a','first'), 'first'), second = f.capture(f.update('a','second'), 'second')
    expect(f.storage.commitLiveUpdateJournal(first).result.kind).toBe('accepted')
    const before = f.journalRows()
    expect(f.storage.commitLiveUpdateJournal(second)).toEqual({ result: { kind: 'retry', reason: 'admission-unavailable' }, admitted: null })
    expect(f.journalRows()).toEqual(before)
    const fresh = f.capture(second.updateBytes, 'second'); expect(fresh.validation.kind).toBe('accepted')
    expect(f.storage.commitLiveUpdateJournal(fresh).result.kind).toBe('accepted')
    const cut = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
    expect(cut).toMatchObject({ kind: 'cut', cut: { highWater: 2, suffixCount: 2 } })
  } finally { f.close() }
})

it.each(['journal', 'provenance', 'usage'] as const)('rolls back every retained byte when %s insertion fails', stage => {
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

it('charges exact payload, metadata and delivery quota once and replays at full quota after reopen', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), quota = Number(f.journalRows().usage) + probeJournalCharge(f, input)
    const limited = openSyncRelayStorage(f.path, { workspaceQuotaBytes: quota })
    try {
      expect(limited.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
      expect(f.journalRows().usage).toBe(quota)
      const before = f.journalRows()
      expect(limited.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', replayed: true })
      expect(() => limited.commitLiveUpdateJournal(f.capture(f.update('more','payload'), 'second'))).toThrow(/quota/)
      expect(f.journalRows()).toEqual(before)
    } finally { limited.close() }
  } finally { f.close() }
})

it.each(['host', 'generation', 'grant', 'fence', 'path', 'owner'] as const)('checks current %s before exact replay', guard => {
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

it.each(['candidate', 'final', 'admitted-cut', 'call'] as const)('linearizes %s validation refusal without retained facts', source => {
  const f = registered()
  try {
    const input: LiveUpdateJournalCommitInput = { ...f.capture(f.update()), validation: { kind: 'refused', source, reason: 'capacity-refused' } }, before = f.journalRows()
    if (source === 'candidate' || source === 'final') expect(f.storage.commitLiveUpdateJournal(input)).toEqual({ result: { kind: 'refused', reason: 'capacity-refused' }, admitted: null })
    else expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow(source === 'call' ? /integration/ : /exceeds the validation policy/)
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it.each(['negative', 'fraction', 'missing', 'regressed', 'exhausted'] as const)('refuses %s sequence before INSERT', state => {
  const f = registered()
  try {
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(), 'first')).result.kind).toBe('accepted')
    const input = f.capture(f.update('next','second'), 'second')
    if (state === 'missing') f.raw.exec("DELETE FROM sqlite_sequence WHERE name='sync_relay_live_update_journal'")
    else f.raw.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='sync_relay_live_update_journal'")
      .run({ negative: -1, fraction: 1.5, regressed: 0, exhausted: Number.MAX_SAFE_INTEGER }[state])
    f.raw.exec("CREATE TRIGGER sequence_sentinel BEFORE INSERT ON sync_relay_live_update_journal BEGIN SELECT RAISE(ABORT,'insert reached'); END")
    const before = f.journalRows()
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow()
    try { f.storage.commitLiveUpdateJournal(input) } catch (error) { expect(String(error)).not.toContain('insert reached') }
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it('refuses a changed immutable cut at the same high water', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), before = f.journalRows()
    f.raw.exec('UPDATE sync_relay_live_documents SET registered_at_ms=99')
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow(/damaged/)
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it('same bytes under distinct delivery IDs remain separate receipts with no duplicate first authorship', () => {
  const f = registered()
  try {
    const bytes = f.update(), first = f.storage.commitLiveUpdateJournal(f.capture(bytes, 'first'))
    expect(first.result.kind).toBe('accepted')
    const second = f.storage.commitLiveUpdateJournal(f.capture(bytes, 'second'))
    expect(second.result).toMatchObject({ kind: 'accepted', receipt: { journalCursor: 2 } })
    expect(second.admitted?.metadata.firstSeen).toEqual([])
    expect(f.journalRows().journal).toHaveLength(2)
  } finally { f.close() }
})

it('does not read a finalized-state getter for a nondue checkpoint', () => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    if (input.validation.kind !== 'accepted') throw new Error('validation refused')
    const getter = vi.fn(() => { throw new Error('nondue state copied') })
    Object.defineProperty(input.validation.evidence, 'stateUpdate', { enumerable: true, get: getter })
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    expect(getter).not.toHaveBeenCalled()
    expect(f.journalRows().journal[0]!.validation_checkpoint_bytes).toBeNull()
  } finally { f.close() }
})

it('retries an actual SQLite writer lock before insertion without changing the cut', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), before = f.journalRows()
    f.raw.exec('BEGIN IMMEDIATE')
    try {
      expect(f.storage.commitLiveUpdateJournal(input)).toEqual({ result: { kind: 'retry', reason: 'admission-unavailable' }, admitted: null })
      expect(f.journalRows()).toEqual(before)
    } finally { f.raw.exec('ROLLBACK') }
    expect(f.storage.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', receipt: { journalCursor: 1 } })
  } finally { f.close() }
}, 15_000)

it('checkpoints exactly the 4095th real no-op delivery and starts a fresh suffix', () => {
  const f = registered()
  try {
    const noop = Y.encodeStateAsUpdate(f.doc, Y.encodeStateVector(f.doc))
    expect([...noop]).toEqual([0, 0])
    const stateCapture = vi.fn(() => { f.raw.exec('BEGIN IMMEDIATE'); f.raw.exec('ROLLBACK') })
    for (let index = 0; index < 4095; index++) {
      const input = f.capture(noop, `noop-${index}`, f.actor, stateCapture)
      expect(input.validation.kind).toBe('accepted')
      const result = f.storage.commitLiveUpdateJournal(input)
      expect(result.result).toMatchObject({ kind: 'accepted', replayed: false, receipt: { journalCursor: index + 1 } })
      expect(result.admitted!.metadata.firstSeen).toEqual([])
      if (index === 4093) {
        expect(stateCapture).not.toHaveBeenCalled()
        expect(f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document }))
          .toMatchObject({ kind: 'cut', cut: { suffixCount: 4094, checkpoint: { cursor: null } } })
      }
    }
    expect(stateCapture).toHaveBeenCalledTimes(1)
    const cut = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
    expect(cut).toMatchObject({ kind: 'cut', cut: { highWater: 4095, suffixCount: 0, suffixBytes: 0, checkpoint: { cursor: 4095 } } })
    if (cut.kind !== 'cut') throw new Error('cut refused')
    const state = Y.encodeStateAsUpdate(f.doc)
    expect(cut.cut.checkpoint.bytes).toEqual(state)
    expect(f.journalRows().usage).toBe(f.input.baselineBytes.byteLength + noop.byteLength * 4095 + state.byteLength + journalMetadataBytes(f.raw) + liveDeliveryBookkeepingBytes(f.raw))
    expect(f.storage.commitLiveUpdateJournal(f.capture(noop, 'next')).result.kind).toBe('accepted')
    expect(f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document }))
      .toMatchObject({ kind: 'cut', cut: { highWater: 4096, suffixCount: 1, checkpoint: { cursor: 4095 } } })
  } finally { f.close() }
}, 1_800_000)


it.each(['version', 'candidate-getter', 'evidence-proxy', 'range-getter', 'shared', 'resizable'] as const)('rejects journal boundary %s without writes or getter calls', kind => {
  const f = registered()
  try {
    const input = f.capture(f.update()), before = f.journalRows()
    if (input.validation.kind !== 'accepted') throw new Error('validation refused')
    const getter = vi.fn(() => { throw new Error('getter invoked') })
    if (kind === 'version') Object.defineProperty(input.validation.evidence, 'version', { value: 2 })
    if (kind === 'candidate-getter') Object.defineProperty(input.validation.evidence, 'candidate', { enumerable: true, get: getter })
    if (kind === 'evidence-proxy') Object.defineProperty(input.validation, 'evidence', { value: new Proxy(input.validation.evidence, { get: getter }) })
    if (kind === 'range-getter') {
      const candidate = { ...input.validation.evidence.candidate, ranges: [...input.validation.evidence.candidate.ranges] }
      Object.defineProperty(input.validation.evidence, 'candidate', { value: candidate })
      Object.defineProperty(candidate.ranges, '0', { enumerable: true, get: getter })
    }
    if (kind === 'shared') Object.defineProperty(input, 'updateBytes', { value: new Uint8Array(new SharedArrayBuffer(input.updateBytes.byteLength)) })
    if (kind === 'resizable') Object.defineProperty(input, 'updateBytes', { value: new Uint8Array(Reflect.construct(ArrayBuffer, [input.updateBytes.byteLength, { maxByteLength: input.updateBytes.byteLength + 1 }]) as ArrayBuffer) })
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow()
    expect(getter).not.toHaveBeenCalled()
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
  const f = registered(), second = openSyncRelayStorage(f.path)
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
    reopened = openSyncRelayStorage(f.path)
    expect(reopened.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', receipt: { journalCursor: 1 } })
  } finally {
    reopened?.close()
    if (!fixtureClosed) f.close()
  }
})

it('rolls back a changed inserted row before any receipt escapes', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), before = f.journalRows()
    f.raw.exec("CREATE TRIGGER corrupt_readback AFTER INSERT ON sync_relay_live_update_journal BEGIN UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=NEW.journal_cursor; END")
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow(/damaged/)
    expect(f.journalRows()).toEqual(before)
    f.raw.exec('DROP TRIGGER corrupt_readback')
    expect(f.storage.commitLiveUpdateJournal(input).result).toMatchObject({ kind: 'accepted', receipt: { journalCursor: 1 } })
  } finally { f.close() }
})

it('retains committed recovery after authority, share and object removal, then cascades workspace deletion without cursor reuse', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), committed = f.storage.commitLiveUpdateJournal(input)
    if (!committed.admitted) throw new Error('commit refused')
    f.raw.exec('DELETE FROM sync_relay_live_documents; DELETE FROM sync_relay_share_grants; DELETE FROM sync_relay_shares; DELETE FROM sync_relay_object_moments')
    const reopened = openSyncRelayStorage(f.path)
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

it('recovery rejects provenance that overlaps an existing baseline', () => {
  const f = registered()
  try {
    const noop = Y.encodeStateAsUpdate(f.doc, Y.encodeStateVector(f.doc))
    expect(f.storage.commitLiveUpdateJournal(f.capture(noop)).result.kind).toBe('accepted')
    f.raw.exec(`INSERT INTO sync_relay_live_update_struct_provenance(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock,end_clock,journal_cursor)
      SELECT workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock,end_clock,1 FROM sync_relay_live_document_baseline_ranges LIMIT 1`)
    expect(() => f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 1 })).toThrow(/damaged/)
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

it.each(['overlap', 'same-author-adjacency', 'wrong-parent'] as const)('rejects corrupt stored provenance %s before another admission', kind => {
  const f = registered()
  try {
    expect(f.storage.commitLiveUpdateJournal(f.capture(gcCandidate(91,0,5),'first')).result.kind).toBe('accepted')
    const next = f.capture(gcCandidate(91,0,8), 'second')
    if (kind === 'overlap') f.raw.exec(`INSERT INTO sync_relay_live_update_struct_provenance(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock,end_clock,journal_cursor)
      SELECT workspace_id,main_version_id,object_id,lineage_claim_id,client_id,1,3,journal_cursor FROM sync_relay_live_update_struct_provenance LIMIT 1`)
    if (kind === 'same-author-adjacency') {
      f.raw.exec('UPDATE sync_relay_live_update_struct_provenance SET end_clock=2')
      f.raw.exec(`INSERT INTO sync_relay_live_update_struct_provenance(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock,end_clock,journal_cursor)
        SELECT workspace_id,main_version_id,object_id,lineage_claim_id,client_id,2,5,journal_cursor FROM sync_relay_live_update_struct_provenance LIMIT 1`)
    }
    if (kind === 'wrong-parent') f.raw.exec("PRAGMA foreign_keys=OFF; UPDATE sync_relay_live_update_struct_provenance SET object_id='other'; PRAGMA foreign_keys=ON")
    const before = f.journalRows()
    expect(() => f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })).toThrow(/damaged/)
    expect(() => f.storage.commitLiveUpdateJournal(next)).toThrow(/damaged/)
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it('records delete-only deliveries without transferring first authorship', () => {
  const f = registered()
  try {
    const first = f.storage.commitLiveUpdateJournal(f.capture(f.update(), 'insert'))
    expect(first.result.kind).toBe('accepted')
    const vector = Y.encodeStateVector(f.doc)
    f.doc.getMap('frontmatter').delete('title')
    const deletion = Y.encodeStateAsUpdate(f.doc, vector)
    const second = f.storage.commitLiveUpdateJournal(f.capture(deletion,'delete'))
    expect(second.result.kind).toBe('accepted')
    expect(second.admitted?.metadata.firstSeen).toEqual([])
    expect(f.journalRows().provenance).toHaveLength(first.admitted!.metadata.firstSeen.length)
  } finally { f.close() }
})

function deletedPayload(targetLength: number): { checkpoint: Uint8Array; resend: Uint8Array } {
  let payloadLength = targetLength - 32
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = new Y.Doc({ gc: false }); doc.clientID = 1001
    try {
      doc.getMap('meta').set('schemaVersion', 1)
      const paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText()
      paragraph.insert(0, [text]); doc.getXmlFragment('body').insert(0, [paragraph])
      const map = doc.getMap('frontmatter')
      map.set('binary-history', new Uint8Array([1,2,3])); map.delete('binary-history')
      text.insertEmbed(0, { ['__proto__']: { ['json-key-💡']: [null, true, 1] } }); text.delete(0, 1); doc.clientID = 1002
      text.insert(0, 'a💡' + 'b'.repeat(payloadLength - 5)); text.delete(0, text.length)
      const update = Y.encodeStateAsUpdate(doc)
      if (update.byteLength === targetLength) {
        const encoding = createRequire(import.meta.url)('lib0/encoding') as typeof import('lib0/encoding')
        const vector = encoding.createEncoder()
        encoding.writeVarUint(vector, 1); encoding.writeVarUint(vector, 1002); encoding.writeVarUint(vector, 1)
        const resend = Y.encodeStateAsUpdate(doc, encoding.toUint8Array(vector))
        expect(resend.byteLength).toBe(targetLength - 1)
        return { checkpoint: update, resend }
      }
      payloadLength += targetLength - update.byteLength
    } finally { doc.destroy() }
  }
  throw new Error('Exact encoded payload construction did not converge')
}

it.each(['exact', 'over'] as const)('commits a real %s byte-trigger checkpoint including its candidate and charges quota once', boundary => {
  const payload = deletedPayload(20_971_520)
  expect(hash(payload.checkpoint)).toBe('5eb79d5c003665f71fd1cb052bb2e7f8507ed35b07ae7e9a53312f701d18f47f')
  expect(hash(payload.resend)).toBe('8f71392008b8bf8cb5eb9f697088a3a068a06a2f5a6e255f2d14482839579cc9')
  const diagnosticPolicy = { maxStructVisits: 36, maxValueNodeVisits: 66,
    maxDecodedPayloadByteVisits: boundary === 'exact' ? 125_828_710 : 125_828_708,
    maxStructClientGroupVisits: 12, maxDeleteClientGroupVisits: 12, maxDeleteIntervalVisits: 12,
    maxIndexOperations: boundary === 'exact' ? 2343 : 2375 }
  const f = registered({ baselineBytes: payload.checkpoint, journalPolicy: diagnosticPolicy })
  const empty = new Y.Doc(), noop = Y.encodeStateAsUpdate(empty); empty.destroy()
  expect([...noop]).toEqual([0,0])
  try {
    const large = boundary === 'exact' ? payload.checkpoint : payload.resend
    const stateCapture = vi.fn(() => { f.raw.exec('BEGIN IMMEDIATE'); f.raw.exec('ROLLBACK') })
    let due
    if (boundary === 'over') {
      const prior = f.capture(large, 'prior', f.actor, stateCapture)
      expect(prior.validation.kind, JSON.stringify(prior.validation.kind === 'refused' ? prior.validation : {kind:'accepted'})).toBe('accepted')
      expect(f.storage.commitLiveUpdateJournal(prior).result.kind).toBe('accepted')
      expect(stateCapture).not.toHaveBeenCalled()
      expect(f.journalRows().journal[0]!.validation_checkpoint_bytes).toBeNull()
      due = f.capture(noop, 'due', f.actor, stateCapture)
    } else due = f.capture(large, 'due', f.actor, stateCapture)
    expect(due.validation.kind, JSON.stringify(due.validation.kind === 'refused' ? due.validation : { kind: 'accepted' })).toBe('accepted')
    if (due.validation.kind !== 'accepted') throw new Error('due validation refused')
    const checkpointBytes = due.validation.evidence.stateUpdate!
    const snapshot = () => {
      const rows = f.journalRows()
      return { ...rows, journal: rows.journal.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) =>
        [key, value instanceof Uint8Array ? { byteLength: value.byteLength, sha256: hash(value) } : value]))) }
    }
    const before = snapshot(), quota = Number(before.usage) + probeJournalCharge(f, due)
    const short = openSyncRelayStorage(f.path, { workspaceQuotaBytes: quota - 1 })
    try { expect(() => short.commitLiveUpdateJournal(due)).toThrow(/quota/) } finally { short.close() }
    expect(snapshot()).toEqual(before)
    const exact = openSyncRelayStorage(f.path, { workspaceQuotaBytes: quota })
    try {
      const accepted = exact.commitLiveUpdateJournal(due)
      expect(accepted.result.kind).toBe('accepted')
      const replay = exact.commitLiveUpdateJournal(due)
      expect(replay.result).toEqual({ ...accepted.result, replayed: true })
      expect(replay.admitted!.metadata).toEqual(accepted.admitted!.metadata)
      expect(Buffer.compare(replay.admitted!.updateBytes, accepted.admitted!.updateBytes)).toBe(0)
    } finally { exact.close() }
    expect(stateCapture).toHaveBeenCalledTimes(1)
    expect(f.journalRows().usage).toBe(quota)
    const cut = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
    expect(cut).toMatchObject({ kind: 'cut', cut: { suffixCount: 0, suffixBytes: 0, checkpoint: { cursor: boundary === 'exact' ? 1 : 2 } } })
    if (cut.kind !== 'cut') throw new Error('cut refused')
    expect(cut.cut.checkpoint.bytes.byteLength).toBe(checkpointBytes.byteLength)
    expect(Buffer.compare(cut.cut.checkpoint.bytes, checkpointBytes)).toBe(0)
    expect(f.storage.commitLiveUpdateJournal(f.capture(noop, 'after')).result.kind).toBe('accepted')
    expect(f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document }))
      .toMatchObject({ kind: 'cut', cut: { suffixCount: 1 } })
    const damaged = Uint8Array.from(checkpointBytes)
    damaged[damaged.length - 1] ^= 1
    f.raw.prepare('UPDATE sync_relay_live_update_journal SET validation_checkpoint_bytes=? WHERE validation_checkpoint_bytes IS NOT NULL').run(damaged)
    expect(() => f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })).toThrow(/damaged/)
    expect(() => f.storage.commitLiveUpdateJournal(due)).toThrow(/damaged/)
    expect(() => f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: boundary === 'exact' ? 1 : 2 })).toThrow(/damaged/)
    f.raw.exec('UPDATE sync_relay_live_update_journal SET validation_checkpoint_bytes=NULL,validation_checkpoint_sha256=NULL')
    expect(() => f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })).toThrow(/damaged/)
    expect(() => f.storage.commitLiveUpdateJournal(due)).toThrow(/damaged/)
    expect(() => f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: boundary === 'exact' ? 1 : 2 })).toThrow(/damaged/)
  } finally { f.close() }
}, 30_000)

it.each(['mode','hostId','hostEpoch','instanceId','connectionId'] as const)('rejects a different host %s before exact replay', field => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    const changed = { ...input.host, [field]: field === 'hostEpoch' ? 2 : field === 'mode' ? 'service' : 'other' }
    const before = f.journalRows()
    expect(f.storage.commitLiveUpdateJournal({ ...input, host: changed as typeof input.host }).result)
      .toEqual({ kind: 'refused', reason: 'stale-session' })
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

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

it('rejects runtime link actors and conflicts on another authorized principal or candidate under the same delivery', () => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    expect(f.storage.commitLiveUpdateJournal({ ...input, actor: { kind: 'link' } as unknown as typeof input.actor }).result.kind).toBe('refused')
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    const before = f.journalRows()
    const named = f.capture(input.updateBytes, 'delivery', { kind: 'named', userId: 'reader', grantId: 'grant' })
    expect(f.storage.commitLiveUpdateJournal(named).result).toEqual({ kind: 'refused', reason: 'delivery-conflict' })
    const changed = f.capture(f.update('another','change'), 'delivery')
    expect(f.storage.commitLiveUpdateJournal(changed).result).toEqual({ kind: 'refused', reason: 'delivery-conflict' })
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it('returns the original accepting epoch and time when a later current host replays a delivery', () => {
  const f = registered()
  try {
    const input = f.capture(f.update()), accepted = f.storage.commitLiveUpdateJournal(input)
    f.raw.exec('UPDATE sync_relay_session_host_control SET host_epoch=2')
    const next = f.capture(input.updateBytes)
    expect(next.host.hostEpoch).toBe(2)
    const replay = f.storage.commitLiveUpdateJournal({ ...next, receivedAtMs: 90 })
    expect(replay).toEqual({ ...accepted, result: { ...accepted.result, replayed: true } })
    expect(replay.admitted?.metadata.accepted.receipt.acceptingHostEpoch).toBe(1)
    expect(replay.admitted?.metadata.accepted.receivedAtMs).toBe(30)
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

it('retries an individually valid stale edit and preserves a fresh combined-body capacity refusal', () => {
  const f = registered()
  try {
    const first = f.capture(f.update('left', 'x'.repeat(1_100_000)), 'left')
    f.doc.clientID = (f.doc.clientID + 1) >>> 0
    const second = f.capture(f.update('right', 'y'.repeat(1_100_000)), 'right')
    expect(first.validation.kind).toBe('accepted')
    expect(second.validation.kind).toBe('accepted')
    expect(f.storage.commitLiveUpdateJournal(first).result.kind).toBe('accepted')
    expect(f.storage.commitLiveUpdateJournal(second).result).toEqual({ kind: 'retry', reason: 'admission-unavailable' })
    const fresh = f.capture(second.updateBytes, 'right')
    expect(fresh.validation).toMatchObject({ kind: 'refused', source: 'final', reason: 'capacity-refused' })
    expect(f.storage.commitLiveUpdateJournal(fresh).result).toEqual({ kind: 'refused', reason: 'capacity-refused' })
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM sync_relay_live_update_journal').get()!.n).toBe(1)
    expect(f.journalRows().usage).toBe(f.input.baselineBytes.byteLength + first.updateBytes.byteLength + journalMetadataBytes(f.raw) + liveDeliveryBookkeepingBytes(f.raw))
  } finally { f.close() }
}, 30_000)

it.each(['damaged-advance', 'regressed'] as const)('does not classify a %s journal cut as legitimate advancement', change => {
  const f = registered()
  try {
    const first = f.capture(f.update('first','value'),'first')
    let stale = f.capture(f.update('second','value'),'second')
    expect(f.storage.commitLiveUpdateJournal(first).result.kind).toBe('accepted')
    if (change === 'damaged-advance') {
      const damaged = Uint8Array.from(first.updateBytes); damaged[damaged.length - 1] ^= 1
      f.raw.prepare('UPDATE sync_relay_live_update_journal SET update_bytes=?').run(damaged)
    } else {
      stale = f.capture(stale.updateBytes,'second')
      f.raw.exec('DELETE FROM sync_relay_live_update_journal')
    }
    expect(() => f.storage.commitLiveUpdateJournal(stale)).toThrow(/damaged/)
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
      "maxIndexOperations": 1565
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

it('hashes no copied state while holding the SQLite writer transaction', () => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    const hashPrototype = Object.getPrototypeOf(createHash('sha256'))
    const originalUpdate = hashPrototype.update
    const originalExec = DatabaseSync.prototype.exec
    let writer = false, hashCalls = 0
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: InstanceType<typeof DatabaseSync>, sql: string) {
      const result = originalExec.call(this, sql)
      if (sql === 'BEGIN IMMEDIATE') writer = true
      if (sql === 'COMMIT' || sql === 'ROLLBACK') writer = false
      return result
    })
    vi.spyOn(hashPrototype, 'update').mockImplementation(function(this: unknown, ...args: unknown[]) {
      expect(writer).toBe(false); hashCalls++
      return originalUpdate.apply(this, args)
    })
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    expect(hashCalls).toBeGreaterThan(0)
    expect(writer).toBe(false)
    vi.restoreAllMocks()
  } finally { f.close() }
})

it.each(['early', 'digest-only', 'bytes-only'] as const)('rejects a malformed historical checkpoint %s', damage => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    f.raw.exec('PRAGMA ignore_check_constraints=ON')
    f.raw.prepare('UPDATE sync_relay_live_update_journal SET validation_checkpoint_sha256=?,validation_checkpoint_bytes=?')
      .run(damage === 'bytes-only' ? null : hash(f.input.baselineBytes), damage === 'digest-only' ? null : f.input.baselineBytes)
    f.raw.exec('PRAGMA ignore_check_constraints=OFF')
    expect(() => f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })).toThrow()
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow()
    expect(() => f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 1 })).toThrow()
  } finally { f.close() }
})

it.each(['suffixCount', 'suffixBytes', 'checkpointCursor'] as const)('compares the cut token %s before insertion', field => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    const token = field === 'checkpointCursor'
      ? { ...input.cutToken, checkpoint: { ...input.cutToken.checkpoint, cursor: 7 } }
      : { ...input.cutToken, [field]: input.cutToken[field] + 1 }
    const before = f.journalRows()
    f.raw.exec("CREATE TRIGGER cut_sentinel BEFORE INSERT ON sync_relay_live_update_journal BEGIN SELECT RAISE(ABORT,'insert reached'); END")
    expect(() => f.storage.commitLiveUpdateJournal({ ...input, cutToken: token })).toThrow(/damaged/)
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it.each(['missing', 'closed', 'moved', 'replaced'] as const)('refuses a %s current document without rewriting history', change => {
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

it.each([
  ['final', 'projection-mutated', 'throw'],
  ['admitted-cut', 'invalid-schema', 'throw'],
  ['admitted-cut', 'invalid-update', 'throw'],
  ['final', 'invalid-input', 'invalid-update'],
  ['candidate', 'invalid-schema', 'invalid-update'],
] as const)('preserves the %s %s refusal mapping', (source, reason, outcome) => {
  const f = registered()
  try {
    const input: LiveUpdateJournalCommitInput = { ...f.capture(f.update()), validation: { kind: 'refused', source, reason } }
    const before = f.journalRows()
    if (outcome === 'throw') expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow()
    else expect(f.storage.commitLiveUpdateJournal(input).result).toEqual({ kind: 'refused', reason: outcome })
    expect(f.journalRows()).toEqual(before)
  } finally { f.close() }
})

it('treats malformed retained selectors as fatal in cut, replay and recovery', () => {
  const f = registered()
  try {
    const input = f.capture(f.update())
    expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe('accepted')
    f.raw.prepare('UPDATE sync_relay_live_update_journal SET selector_paths_json=?').run('[oops')
    expect(() => f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })).toThrow()
    expect(() => f.storage.commitLiveUpdateJournal(input)).toThrow()
    expect(() => f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 1 })).toThrow()
  } finally { f.close() }
})

it('preserves first authorship through the maximum portable clock', () => {
  const f = registered()
  try {
    const maximum = 4_294_967_295
    const first = f.capture(gcCandidate(91, 0, maximum - 1), 'first')
    expect(first.validation.kind).toBe('accepted')
    expect(f.storage.commitLiveUpdateJournal(first).admitted?.metadata.firstSeen)
      .toEqual([{ clientId: 91, startClock: 0, endClock: maximum - 1 }])
    const next = f.capture(gcCandidate(91, maximum - 1, 1), 'last')
    expect(next.validation.kind).toBe('accepted')
    expect(f.storage.commitLiveUpdateJournal(next).admitted?.metadata.firstSeen)
      .toEqual([{ clientId: 91, startClock: maximum - 1, endClock: maximum }])
    expect(f.storage.readCommittedLiveUpdate({ host, document: f.input.evidence.document, journalCursor: 2 }))
      .toMatchObject({ kind: 'committed', admitted: { metadata: { firstSeen: [{ clientId: 91, startClock: maximum - 1, endClock: maximum }] } } })
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
