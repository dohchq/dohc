import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { parseHostEpoch } from '@dohc/live-session-contract/host-control'
import { markdownToYDoc } from './import-export.js'
import { liveDeliveryBookkeepingBytes } from './liveDeliveryQuotaTestSupport.js'
import { liveBaselineStoredBytes } from './liveBaselineQuotaTestSupport.js'
import { createLiveMarkdownRegistrationValidator } from './liveDocumentValidation.js'
import { openSyncRelayStorage, type LiveDocumentBaselineRegistrationInput } from '../../../services/sync-relay/src/storage.js'

const validate = createLiveMarkdownRegistrationValidator({
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
})
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
function fixture(options: { workspaceQuotaBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dohc-baseline-storage-')); roots.push(root)
  const path = join(root, 'relay.sqlite')
  const storage = openSyncRelayStorage(path, options)
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

it('stores a real validated baseline with first fence 1 and replays without writes after reopen', () => {
  const f = fixture()
  try {
    const input = validated(); f.moment(input)
    const registered = f.storage.registerLiveDocumentBaseline(input)
    expect(registered).toEqual({ kind: 'registered', document: input.evidence.document, currentPath: input.evidence.currentPath,
      restoreFenceGeneration: 1, registeredAtMs: 10, replayed: false })
    const before = f.rows()
    const row = before.documents[0]!
    expect(row.baseline_digest).toBe(hash(input.baselineBytes))
    expect(Array.from(row.baseline_bytes as Uint8Array)).toEqual(Array.from(input.baselineBytes))
    expect(row.baseline_moment_relay_seq).toBe(1)
    expect(before.ranges.map(row => ({ clientId: row.client_id, startClock: row.start_clock, endClock: row.end_clock })))
      .toEqual(input.evidence.checkpoint.ranges)
    const reopened = openSyncRelayStorage(f.path)
    try {
      expect(reopened.registerLiveDocumentBaseline({ ...input, registeredAtMs: 99 })).toEqual({ ...registered, replayed: true })
    } finally { reopened.close() }
    expect(f.rows()).toEqual(before)
  } finally { f.close() }
})

it('observes a host replacement committed after real validation on another connection', () => {
  const f = fixture()
  try {
    const input = validated(); f.moment(input)
    const other = openSyncRelayStorage(f.path)
    try { other.registerLiveHost({ ...host, connectionId: 'replacement', updatedAtMs: 5, guard() {} }) }
    finally { other.close() }
    expect(f.storage.registerLiveDocumentBaseline(input)).toEqual({ kind: 'refused', reason: 'stale-host' })
    expect(f.rows().documents).toEqual([])
  } finally { f.close() }
})

it.each(['path', 'replacement'] as const)
('rechecks latest main moment and reverse path: %s', change => {
  const f = fixture()
  try {
    const input = validated()
    f.moment(input)
    if (change === 'path') f.moment(input, 2, { path: 'docs/moved.md' })
    if (change === 'replacement') f.moment(input, 2, { object_id: 'replacement' })
    expect(f.storage.registerLiveDocumentBaseline(input)).toEqual({ kind: 'refused', reason: 'stale-document' })
    expect(f.rows().documents).toEqual([])
  } finally { f.close() }
})

it('refuses another lineage with current history', () => {
  const f = fixture()
  try {
    const first = validated(); f.moment(first)
    expect(f.storage.registerLiveDocumentBaseline(first).kind).toBe('registered')
    const next = validated(); expect(next.evidence.document.lineageClaimId).not.toBe(first.evidence.document.lineageClaimId)
    const before = f.rows()
    expect(f.storage.registerLiveDocumentBaseline(next)).toEqual({ kind: 'refused', reason: 'lineage-conflict' })
    expect(f.rows()).toEqual(before)
  } finally { f.close() }
})

it('throws on stored bytes corruption without repair', () => {
  const f = fixture()
  try {
    const input = validated(); f.moment(input)
    expect(f.storage.registerLiveDocumentBaseline(input).kind).toBe('registered')
    f.raw.exec("UPDATE sync_relay_live_documents SET baseline_bytes = x'00'")
    const before = f.rows()
    expect(() => f.storage.registerLiveDocumentBaseline(input)).toThrow(/authority is damaged/)
    expect(f.rows()).toEqual(before)
  } finally { f.close() }
})

it('resolves current owner and exact named authority after real registration', () => {
  const f = fixture()
  try {
    const input = validated(); f.moment(input)
    expect(f.storage.registerLiveDocumentBaseline(input).kind).toBe('registered')
    f.raw.prepare(`INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms) VALUES (?, ?, ?, ?, ?)`)
      .run('share', 'workspace', 'owner', JSON.stringify({ paths: ['docs'], versionId: null }), 0)
    f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id, share_id, principal_kind, principal_user_id,
      principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
      VALUES ('grant', 'share', 'user', 'reader', NULL, 'edit', 4, 'active', 0, NULL, NULL)`).run()
    const owner = f.storage.resolveCurrentLiveDocumentBinding({ document: input.evidence.document,
      actor: { kind: 'owner', userId: 'owner' } })
    const named = f.storage.resolveCurrentLiveDocumentBinding({ document: input.evidence.document,
      actor: { kind: 'named', userId: 'reader', grantId: 'grant' } })
    expect(owner).toMatchObject({ kind: 'current', host, binding: { currentPath: 'docs/a.md', selectorPaths: ['docs/a.md'], restoreFenceGeneration: 1 },
      authority: { principalKind: 'owner', principalId: 'owner', grantId: null, grantGeneration: null } })
    expect(named).toMatchObject({ kind: 'current', host, binding: { currentPath: 'docs/a.md', selectorPaths: ['docs/a.md'], restoreFenceGeneration: 1 },
      authority: { principalKind: 'named', principalId: 'reader', grantId: 'grant', grantGeneration: 4 } })
    f.raw.exec("UPDATE sync_relay_share_grants SET access = 'view' WHERE grant_id = 'grant'")
    expect(f.storage.resolveCurrentLiveDocumentBinding({ document: input.evidence.document,
      actor: { kind: 'named', userId: 'reader', grantId: 'grant' } })).toEqual({ kind: 'refused', reason: 'stale-selector' })
  } finally { f.close() }
})

it('rejects malformed call, evidence, ranges and bytes without invoking hostile accessors', () => {
  const f = fixture()
  try {
    const input = validated(); f.moment(input)
    const getter = vi.fn(() => input.evidence)
    const proxyTrap = vi.fn(() => { throw new Error('proxy trap') })
    const badRanges = [...input.evidence.checkpoint.ranges]
    Object.defineProperty(badRanges, '0', { get: getter })
    const evidence = input.evidence
    const invalid: unknown[] = [
      null, Object.create(input), { ...input, extra: 1 }, { ...input, restoreFenceGeneration: 99 },
      Object.defineProperty({ ...input }, 'evidence', { get: getter }),
      new Proxy(input, { getOwnPropertyDescriptor: proxyTrap }),
      { ...input, evidence: { ...evidence, version: 2 } },
      { ...input, evidence: { ...evidence, version: undefined } },
      { ...input, evidence: Object.create(evidence) },
      { ...input, evidence: Object.defineProperty({ ...evidence }, 'document', { get: getter }) },
      { ...input, evidence: { ...evidence, document: { ...evidence.document, mainVersionId: 'branch' } } },
      { ...input, evidence: { ...evidence, document: { ...evidence.document, lineageClaimId: 'a'.repeat(64) } } },
      { ...input, evidence: { ...evidence, checkpoint: { ...evidence.checkpoint, ranges: badRanges } } },
      { ...input, evidence: { ...evidence, checkpoint: { ...evidence.checkpoint, ranges: [undefined] } } },
      { ...input, evidence: { ...evidence, checkpoint: { ...evidence.checkpoint, ranges: [...evidence.checkpoint.ranges, ...evidence.checkpoint.ranges] } } },
      { ...input, baselineBytes: new Uint8Array(new SharedArrayBuffer(8)) },
      { ...input, baselineBytes: new Uint8Array(Reflect.construct(ArrayBuffer, [8, { maxByteLength: 16 }]) as ArrayBuffer) },
      { ...input, baselineBytes: new Uint16Array(8) }, { ...input, baselineBytes: new Uint8Array([0]) },
      { ...input, baselineBytes: new Proxy(input.baselineBytes, { get: proxyTrap }) },
      { ...input, registeredAtMs: NaN }, { ...input, registeredAtMs: -1 },
      { ...input, evidence: { ...evidence, projectedMarkdownByteLength: 2_097_153 } },
    ]
    for (const bad of invalid) expect(f.storage.registerLiveDocumentBaseline(bad as LiveDocumentBaselineRegistrationInput))
      .toEqual({ kind: 'refused', reason: 'invalid-baseline' })
    const badHost = Object.defineProperty({ ...input.host }, 'hostId', { get: getter })
    expect(f.storage.registerLiveDocumentBaseline({ ...input, host: badHost })).toEqual({ kind: 'refused', reason: 'stale-host' })
    expect(getter).not.toHaveBeenCalled(); expect(proxyTrap).not.toHaveBeenCalled()
    expect(f.rows()).toEqual({ documents: [], ranges: [] })
  } finally { f.close() }
})

function usage(f: ReturnType<typeof fixture>): number {
  return Number(f.raw.prepare('SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?').get('workspace')!.usage_bytes)
}

it.each(['owner', 'named'] as const)('does not revive pre-reset %s authority after the same object is republished', kind => {
  const f = fixture()
  try {
    const input = validated()
    f.storage.claimWorkspaceIdentity({ workspaceId: 'workspace', replicationEpoch: 'epoch-a', streamIdentity: 'stream-a' })
    f.storage.appendLogBatch({ workspaceId: 'workspace', originId: 'origin',
      ops: [{ originSeq: 0, opKind: 'test', payloadJson: '{}', recordedAtMs: 1 }] })
    f.moment(input)
    f.raw.prepare(`INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms)
      VALUES ('share', 'workspace', 'owner', ?, 0)`).run(JSON.stringify({ paths: ['docs'], versionId: null }))
    f.raw.exec(`INSERT INTO sync_relay_share_grants (grant_id, share_id, principal_kind, principal_user_id,
      principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
      VALUES ('grant', 'share', 'user', 'reader', NULL, 'edit', 4, 'active', 0, NULL, NULL)`)
    const actor = kind === 'owner' ? { kind, userId: 'owner' } as const
      : { kind, userId: 'reader', grantId: 'grant' } as const
    const request = { document: input.evidence.document, actor }
    expect(f.storage.registerLiveDocumentBaseline(input).kind).toBe('registered')
    expect(f.storage.resolveCurrentLiveDocumentBinding(request).kind).toBe('current')
    expect(f.storage.rotateWorkspaceIdentity({ workspaceId: 'workspace', ownerUserId: 'owner',
      replicationEpoch: 'epoch-b', streamIdentity: 'stream-b', rotatedAtMs: 20 })).toBe('rotated')
    f.storage.appendLogBatch({ workspaceId: 'workspace', originId: 'origin',
      ops: [{ originSeq: 1, opKind: 'test', payloadJson: '{}', recordedAtMs: 21 }] })
    f.moment(input, 2)
    const before = f.rows(), beforeUsage = usage(f)
    for (const reopen of [false, true]) {
      const storage = reopen ? openSyncRelayStorage(f.path) : f.storage
      try {
        expect(storage.resolveCurrentLiveDocumentBinding(request)).toEqual({ kind: 'refused', reason: 'stale-document' })
        expect(storage.registerLiveDocumentBaseline(input)).toEqual({ kind: 'refused', reason: 'baseline-conflict' })
      } finally { if (storage !== f.storage) storage.close() }
    }
    expect(f.rows()).toEqual(before); expect(usage(f)).toBe(beforeUsage)
    f.storage.appendLogBatch({ workspaceId: 'workspace', originId: 'origin',
      ops: [{ originSeq: 2, opKind: 'test', payloadJson: '{}', recordedAtMs: 22 }] })
    const fresh = validated(checkpoint(), 'docs/new.md', 'new-object'); f.moment(fresh, 3)
    expect(f.storage.registerLiveDocumentBaseline(fresh).kind).toBe('registered')
    expect(f.storage.resolveCurrentLiveDocumentBinding({ ...request, document: fresh.evidence.document }).kind).toBe('current')
  } finally { f.close() }
})

it('does not revive pre-reset named authority after the same object is republished', () => {
  const f = fixture()
  try {
    const input = validated()
    f.storage.claimWorkspaceIdentity({ workspaceId: 'workspace', replicationEpoch: 'epoch-a', streamIdentity: 'stream-a' })
    f.storage.appendLogBatch({ workspaceId: 'workspace', originId: 'origin',
      ops: [{ originSeq: 0, opKind: 'test', payloadJson: '{}', recordedAtMs: 1 }] })
    f.moment(input)
    f.raw.prepare(`INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms)
      VALUES ('share', 'workspace', 'owner', ?, 0)`).run(JSON.stringify({ paths: ['docs'], versionId: null }))
    f.raw.exec(`INSERT INTO sync_relay_share_grants (grant_id, share_id, principal_kind, principal_user_id,
      principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
      VALUES ('grant', 'share', 'user', 'reader', NULL, 'edit', 4, 'active', 0, NULL, NULL)`)
    const actor = { kind: 'named', userId: 'reader', grantId: 'grant' } as const
    const request = { document: input.evidence.document, actor }
    expect(f.storage.registerLiveDocumentBaseline(input).kind).toBe('registered')
    expect(f.storage.resolveCurrentLiveDocumentBinding(request).kind).toBe('current')
    expect(f.storage.rotateWorkspaceIdentity({ workspaceId: 'workspace', ownerUserId: 'owner',
      replicationEpoch: 'epoch-b', streamIdentity: 'stream-b', rotatedAtMs: 20 })).toBe('rotated')
    f.storage.appendLogBatch({ workspaceId: 'workspace', originId: 'origin',
      ops: [{ originSeq: 1, opKind: 'test', payloadJson: '{}', recordedAtMs: 21 }] })
    f.moment(input, 2)
    const before = f.rows(), beforeUsage = usage(f)
    for (const reopen of [false, true]) {
      const storage = reopen ? openSyncRelayStorage(f.path) : f.storage
      try {
        expect(storage.resolveCurrentLiveDocumentBinding(request)).toEqual({ kind: 'refused', reason: 'stale-document' })
        expect(storage.registerLiveDocumentBaseline(input)).toEqual({ kind: 'refused', reason: 'baseline-conflict' })
      } finally { if (storage !== f.storage) storage.close() }
    }
    expect(f.rows()).toEqual(before); expect(usage(f)).toBe(beforeUsage)
    f.storage.appendLogBatch({ workspaceId: 'workspace', originId: 'origin',
      ops: [{ originSeq: 2, opKind: 'test', payloadJson: '{}', recordedAtMs: 22 }] })
    const fresh = validated(checkpoint(), 'docs/new.md', 'new-object'); f.moment(fresh, 3)
    expect(f.storage.registerLiveDocumentBaseline(fresh).kind).toBe('registered')
    expect(f.storage.resolveCurrentLiveDocumentBinding({ ...request, document: fresh.evidence.document }).kind).toBe('current')
  } finally { f.close() }
})

it('charges baseline payload, metadata, ranges and delivery once, preserving quota on replay', () => {
  const first = validated(), second = validated(checkpoint('Second'), 'docs/b.md', 'second-object')
  const probe = fixture()
  let total: number
  try {
    probe.moment(first); probe.moment(second, 2)
    expect(probe.storage.registerLiveDocumentBaseline(first).kind).toBe('registered')
    expect(probe.storage.registerLiveDocumentBaseline(second).kind).toBe('registered')
    total = liveBaselineStoredBytes(probe.raw) + liveDeliveryBookkeepingBytes(probe.raw)
    expect(usage(probe)).toBe(total)
    expect(probe.raw.prepare('SELECT COUNT(*) n FROM sync_relay_live_delivery_reservations').get()!.n).toBe(2)
  } finally { probe.close() }
  const f = fixture({ workspaceQuotaBytes: total })
  try {
    f.moment(first); f.moment(second, 2)
    expect(f.storage.registerLiveDocumentBaseline(first).kind).toBe('registered')
    expect(usage(f)).toBe(liveBaselineStoredBytes(f.raw) + liveDeliveryBookkeepingBytes(f.raw))
    expect(f.storage.registerLiveDocumentBaseline(second).kind).toBe('registered')
    expect(usage(f)).toBe(total)
    const before = f.rows(), reopened = openSyncRelayStorage(f.path, { workspaceQuotaBytes: total })
    try {
      expect(reopened.registerLiveDocumentBaseline(first)).toMatchObject({ replayed: true })
      expect(reopened.registerLiveDocumentBaseline(second)).toMatchObject({ replayed: true })
      expect(usage(f)).toBe(total)
      const excess = validated(checkpoint('Excess'), 'docs/c.md', 'third-object'); f.moment(excess, 3)
      expect(() => reopened.registerLiveDocumentBaseline(excess)).toThrow(/workspace storage quota exceeded/)
      expect(usage(f)).toBe(total); expect(f.rows()).toEqual(before)
    } finally { reopened.close() }
  } finally { f.close() }
})

it('rolls back baseline and range inserts when the usage charge fails', () => {
  const f = fixture()
  try {
    const input = validated(); f.moment(input)
    f.raw.exec(`CREATE TRIGGER fail_baseline_usage AFTER UPDATE ON sync_relay_workspace_usage
      BEGIN SELECT RAISE(ABORT, 'usage fault'); END`)
    expect(() => f.storage.registerLiveDocumentBaseline(input)).toThrow(/usage fault/)
    expect(usage(f)).toBe(0); expect(f.rows()).toEqual({ documents: [], ranges: [] })
    f.raw.exec('DROP TRIGGER fail_baseline_usage')
    expect(f.storage.registerLiveDocumentBaseline(input)).toMatchObject({ kind: 'registered', replayed: false })
    expect(usage(f)).toBe(liveBaselineStoredBytes(f.raw) + liveDeliveryBookkeepingBytes(f.raw))
  } finally { f.close() }
})
