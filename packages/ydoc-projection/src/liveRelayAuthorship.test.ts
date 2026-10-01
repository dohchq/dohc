import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { LiveAuthorContext } from '@dohc/live-session-contract'
import type { LiveUpdateJournalCommitInput } from '../../../services/sync-relay/src/storage.js'
import type { StorageContext } from '../../../services/sync-relay/src/storage/context.js'
import { createLiveJournalHistoryAuthority } from '../../../services/sync-relay/src/storage/liveJournalHistory.js'
import { deriveLiveAuthorSnapshot, ensureLiveLinkPublicPrincipal } from '../../../services/sync-relay/src/storage/liveAuthorSnapshot.js'
import { liveBrowserActor } from '../../../services/sync-relay/src/liveBrowserContext.js'
import { hashLinkBearer, hashLinkProfileSecret } from '../../../services/sync-relay/src/linkSecurity.js'
import { registered, cleanupLiveDeliveryFixtures, policy, hash } from './liveCommittedDeliveryTestSupport.js'
import { createLiveMarkdownJournalValidator } from './liveDocumentValidation.js'

const close: Array<() => void> = []
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); cleanupLiveDeliveryFixtures() })

function setup(options: Parameters<typeof registered>[0] = {}) {
  const f = registered(options)
  close.push(f.close)
  f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({ namespace: 'authorship-tests', reconciled: true }))
  return f
}
type Fixture = ReturnType<typeof setup>
const alice = [{ kind: 'human', humanId: 'owner', humanName: 'Alice' }]
const bob = [{ kind: 'human', humanId: 'reader', humanName: 'Bob' }]
const bobActor = { kind: 'named', userId: 'reader', grantId: 'grant' } as const

function authored(input: LiveUpdateJournalCommitInput, context: LiveAuthorContext = { kind: 'account', accountId: 'owner' }, name = 'Alice'): LiveUpdateJournalCommitInput {
  return { ...input, metadata: { ...input.metadata, authorContext: context },
    trustedAccount: { accountId: input.expectedAuthority.principalId, name } }
}
function replica(f: Fixture, clientId: number, updates: readonly Uint8Array[] = []) {
  const doc = new Y.Doc()
  close.push(() => doc.destroy())
  Y.applyUpdate(doc, f.input.baselineBytes)
  for (const update of updates) Y.applyUpdate(doc, update)
  doc.clientID = clientId
  return doc
}
function edit(doc: Y.Doc, key: string, value: string) {
  const before = Y.encodeStateVector(doc)
  doc.getMap('frontmatter').set(key, value)
  return Y.encodeStateAsUpdate(doc, before)
}

it.each(['owner', 'named'] as const)('stamps the matching authenticated %s account and declared agent', kind => {
  const f = setup(), actor = kind === 'owner' ? f.actor : bobActor
  const accountId = actor.userId, name = kind === 'owner' ? 'Alice' : 'Bob'
  const agent = { agentId: 'agent', agentName: 'Declared agent', onBehalfOf: accountId, depth: 1 }
  const input = authored(f.capture(f.update(), 'matching', actor), { kind: 'account', accountId, agent }, name)
  const result = f.storage.commitLiveUpdateJournal(input)
  expect(result.result).toMatchObject({ kind: 'accepted', replayed: false })
  expect(result.admitted?.metadata).toMatchObject({ canonicalVersion: 2, firstSeenDeletes: [],
    authorSnapshot: [{ kind: 'human', humanId: accountId, humanName: name }, { kind: 'agent', ...agent }] })
  expect(f.journalRows().journal[0]!.author_context_json).toBe(JSON.stringify(input.metadata.authorContext))
})

it.each(['absent', 'legacy', 'mismatch', 'signed-out', 'untrusted-account'] as const)('admits %s account context unnamed', mode => {
  const f = setup(), captured = f.capture(f.update(), mode)
  const input = mode === 'absent' ? { ...captured, trustedAccount: { accountId: 'owner', name: 'Alice' } }
    : mode === 'legacy' ? captured
    : mode === 'untrusted-account' ? { ...captured, metadata: { ...captured.metadata, authorContext: { kind: 'account' as const, accountId: 'owner' } } }
    : authored(captured, mode === 'mismatch' ? { kind: 'account', accountId: 'reader', agent: { agentId: 'agent' } }
      : { kind: 'signed-out', agent: { agentId: 'agent', onBehalfOf: 'installation-private' } })
  const result = f.storage.commitLiveUpdateJournal(input)
  expect(result.result.kind).toBe('accepted')
  expect(result.admitted?.metadata.authorSnapshot).toEqual([])
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM sync_relay_live_author_clients').get()!.n).toBe(0)
  expect(JSON.stringify(result.admitted?.metadata.authorSnapshot)).not.toContain('installation-private')
})

it('preserves the admitted name on exact retries and conflicts on changed recording context', () => {
  const f = setup(), input = authored(f.capture(f.update(), 'immutable'), { kind: 'account', accountId: 'owner', agent: { agentId: 'original-agent' } })
  const first = f.storage.commitLiveUpdateJournal(input), before = f.journalRows()
  expect(first.result.kind).toBe('accepted')
  const retry = { ...input, trustedAccount: { accountId: 'owner', name: 'Later name' }, receivedAtMs: 999,
    validation: { kind: 'refused' as const, source: 'candidate' as const, reason: 'capacity-refused' as const } }
  expect(f.storage.commitLiveUpdateJournal(retry)).toEqual({ ...first, result: { ...first.result, replayed: true } })
  for (const context of [undefined, { kind: 'signed-out' as const }, { kind: 'account' as const, accountId: 'reader' },
    { kind: 'account' as const, accountId: 'owner', agent: { agentId: 'different-agent' } }]) {
    const { authorContext: _context, ...metadata } = input.metadata
    expect(f.storage.commitLiveUpdateJournal({ ...retry, metadata: { ...metadata, ...(context ? { authorContext: context } : {}) } }).result)
      .toEqual({ kind: 'refused', reason: 'delivery-conflict' })
  }
  expect(f.journalRows()).toEqual(before)
})

it('keeps Alice deletion coverage when Bob rewraps it with a new edit', () => {
  const f = setup(), inserted = f.update('remove-me', 'Alice text')
  expect(f.storage.commitLiveUpdateJournal(authored(f.capture(inserted, 'alice-insert'))).result.kind).toBe('accepted')
  const beforeDelete = Y.encodeStateVector(f.doc)
  f.doc.getMap('frontmatter').delete('remove-me')
  const deletion = Y.encodeStateAsUpdate(f.doc, beforeDelete)
  const deleted = f.storage.commitLiveUpdateJournal(authored(f.capture(deletion, 'alice-delete')))
  expect(deleted.result.kind).toBe('accepted')
  expect(deleted.admitted?.metadata.firstSeen).toEqual([])
  expect(deleted.admitted?.metadata.firstSeenDeletes?.length).toBeGreaterThan(0)
  expect(deleted.admitted?.metadata.authorSnapshot).toEqual(alice)
  const bobDoc = replica(f, 202, [inserted, deletion]), bobEdit = edit(bobDoc, 'bob', 'Bob text')
  const merged = Y.mergeUpdates([deletion, bobEdit])
  const result = f.storage.commitLiveUpdateJournal(authored(f.capture(merged, 'bob-rewrap', bobActor), { kind: 'account', accountId: 'reader' }, 'Bob'))
  expect(result.result.kind).toBe('accepted')
  expect(result.admitted?.metadata.authorSnapshot).toEqual(bob)
  expect(result.admitted?.metadata.firstSeen).toEqual([{ clientId: 202, startClock: 0, endClock: 1 }])
  expect(result.admitted?.metadata.firstSeenDeletes).toEqual([])
  expect(f.journalRows().journal[1]!.first_seen_deletes_json).toBe(JSON.stringify(deleted.admitted?.metadata.firstSeenDeletes))
})

it('refuses a reconstructed delta containing two unbound authored clients without writing', () => {
  const f = setup(), one = replica(f, 101), two = replica(f, 202)
  const mixed = Y.mergeUpdates([edit(one, 'one', 'Alice'), edit(two, 'two', 'Alice')])
  const input = authored(f.capture(mixed, 'mixed')), before = f.journalRows()
  expect(input.validation.kind).toBe('accepted')
  expect(f.storage.commitLiveUpdateJournal(input)).toEqual({ result: { kind: 'refused', reason: 'provenance-refused' }, admitted: null })
  expect(f.journalRows()).toEqual(before)
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM sync_relay_live_author_clients').get()!.n).toBe(0)
})

it('refuses new structs from a client already bound to another snapshot', () => {
  const f = setup(), first = f.update('alice', 'Alice')
  expect(f.storage.commitLiveUpdateJournal(authored(f.capture(first, 'alice'))).result.kind).toBe('accepted')
  const next = f.update('alice-again', 'Alice'), bobDoc = replica(f, 202, [first])
  const mixed = Y.mergeUpdates([next, edit(bobDoc, 'bob', 'Bob')]), before = f.journalRows()
  expect(f.storage.commitLiveUpdateJournal(authored(f.capture(mixed, 'other-snapshot', bobActor), { kind: 'account', accountId: 'reader' }, 'Bob')).result)
    .toEqual({ kind: 'refused', reason: 'provenance-refused' })
  expect(f.journalRows()).toEqual(before)
})

it('accepts original single-client A1b records and exact retries after another author advances the cut', () => {
  const f = setup(), aliceDoc = replica(f, 101), bobDoc = replica(f, 202)
  const original = authored(f.capture(edit(aliceDoc, 'alice', 'Alice'), 'original-alice'))
  const first = f.storage.commitLiveUpdateJournal(original)
  Y.applyUpdate(bobDoc, original.updateBytes)
  const second = authored(f.capture(edit(bobDoc, 'bob', 'Bob'), 'original-bob', bobActor), { kind: 'account', accountId: 'reader' }, 'Bob')
  expect(f.storage.commitLiveUpdateJournal(second).result.kind).toBe('accepted')
  const before = f.journalRows()
  expect(f.storage.commitLiveUpdateJournal({ ...original, validation: { kind: 'refused', source: 'candidate', reason: 'capacity-refused' } }))
    .toEqual({ ...first, result: { ...first.result, replayed: true } })
  expect(f.journalRows()).toEqual(before)
})

it('exempts the deterministic source-moment seed client from authored struct binding', () => {
  const f = setup(), source = f.raw.prepare('SELECT moment_id, blob_sha256 FROM sync_relay_object_moments WHERE relay_seq=1').get()!
  const hash = createHash('sha256').update('dohc:ydoc-seed-client:v1')
  for (const field of ['workspace', 'main', 'object', 'text', String(source.moment_id), String(source.blob_sha256)]) {
    const bytes = Buffer.from(field), length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes)
  }
  const seedId = Math.max(1, hash.digest().readUInt32BE(0)), seedDoc = replica(f, seedId), authoredDoc = replica(f, 101)
  const seed = edit(seedDoc, 'seed', 'Imported'), update = edit(authoredDoc, 'alice', 'Alice')
  const result = f.storage.commitLiveUpdateJournal(authored(f.capture(Y.mergeUpdates([seed, update]), 'seed-and-author')))
  expect(result.result.kind).toBe('accepted')
  expect(result.admitted?.metadata.firstSeen).toEqual([{ clientId: 101, startClock: 0, endClock: 1 }])
  expect(JSON.parse(String(f.journalRows().journal[0]!.seed_first_seen_json))).toEqual([{ clientId: seedId, startClock: 0, endClock: 1 }])
  expect(f.raw.prepare('SELECT client_id FROM sync_relay_live_author_clients').all()).toEqual([{ client_id: 101 }])
  expect(f.storage.commitLiveUpdateJournal(authored(f.capture(seed, 'seed-only', bobActor), { kind: 'account', accountId: 'reader' }, 'Bob')).admitted?.metadata.firstSeen).toEqual([])
})

it('cuts a complete checkpoint at 960 identities and starts the next author window', () => {
  const journalPolicy = { ...policy, maxIndexOperations: 100_000_000 }
  const f = setup({ journalPolicy }), validate = createLiveMarkdownJournalValidator(journalPolicy)
  for (let index = 0; index < 959; index++) {
    f.doc.clientID = 10_000 + index
    if (index === 958) f.doc.getMap('frontmatter').delete('author-0')
    let input = authored(f.capture(f.update(`author-${index}`, String(index)), `window-${index}`),
      { kind: 'account', accountId: 'owner', agent: { agentId: `agent-${index}` } })
    expect(input.validation.kind, `Author ${index}: ${JSON.stringify(input.validation.kind === 'refused' ? input.validation : { kind: input.validation.kind })}`).toBe('accepted')
    if (index === 958) {
      const cut = input.cutToken
      const validation = validate({ document: cut.document, currentPath: cut.currentPath,
        checkpoint: cut.checkpoint.bytes, suffix: cut.suffix.map(row => row.bytes), candidate: input.updateBytes })
      expect(validation.kind, `Checkpoint author ${index}: ${JSON.stringify(validation.kind === 'refused' ? validation : { kind: validation.kind })}`).toBe('accepted')
      if (validation.kind !== 'accepted') throw new Error('Checkpoint validation refused')
      input = { ...input, validation: { kind: 'accepted', evidence: { ...validation.evidence, stateUpdate: validation.evidence.stateUpdate } } }
    }
    const result = f.storage.commitLiveUpdateJournal(input)
    expect(result.result.kind, `Author ${index}: ${JSON.stringify(result.result)}`).toBe('accepted')
    if (index < 958) expect(result.admitted?.metadata.checkpointCoverage).toBeUndefined()
    else {
      expect(result.admitted?.metadata.checkpointCoverage).toHaveLength(960)
      const owner = result.admitted!.metadata.checkpointCoverage!.find(entry => entry.author.kind === 'human')!
      expect(owner.author).toEqual(alice[0])
      expect(owner.structRanges).toHaveLength(959)
      expect(owner.deletionRanges).toEqual([{ clientId: 10_000, startClock: 0, endClock: 1 }])
      for (const entry of result.admitted!.metadata.checkpointCoverage!) expect(entry.structRanges.length).toBeGreaterThan(0)
    }
  }
  const cut = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
  expect(cut.kind).toBe('cut')
  if (cut.kind !== 'cut') throw new Error('Checkpoint cut missing')
  expect(cut.cut).toMatchObject({ highWater: 959, suffixCount: 0, checkpoint: { cursor: 959 } })
  expect(cut.cut.checkpoint.metadata?.checkpointCoverage).toHaveLength(960)
  expect(hash(cut.cut.checkpoint.bytes)).toBe(cut.cut.checkpoint.digest)
  f.doc.clientID = 20_000
  const next = f.storage.commitLiveUpdateJournal(authored(f.capture(f.update('next-window', 'Fresh'), 'next-window'),
    { kind: 'account', accountId: 'owner', agent: { agentId: 'next-agent' } }))
  expect(next.result.kind).toBe('accepted')
  expect(next.admitted?.metadata.checkpointCoverage).toBeUndefined()
  const advanced = f.storage.readLiveUpdateJournalCut({ document: f.input.evidence.document })
  expect(advanced).toMatchObject({ kind: 'cut', cut: { highWater: 960, suffixCount: 1, checkpoint: { cursor: 959 },
    suffix: [{ metadata: { authorSnapshot: [...alice, { kind: 'agent', agentId: 'next-agent' }] } }] } })
}, 180_000)

it('uses a stable public link ID and exports no private principal or grant in its author snapshot', () => {
  const f = setup(), key = 'k'.repeat(32), time = Date.now()
  f.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL WHERE grant_id='grant'")
  const scope = { kind: 'link' as const, workspaceId: 'workspace', shareId: 'share', grantId: 'grant', sessionId: 'private-link-session',
    capabilityHash: hashLinkBearer(Buffer.alloc(32, 3).toString('base64url'), key), profileTokenHash: hashLinkProfileSecret(Buffer.alloc(32, 7).toString('base64url'), key) }
  expect(f.storage.mintLinkSession({ session: { sessionId: scope.sessionId, capabilityHash: scope.capabilityHash, grantId: 'grant',
    generation: 4, mintedAtMs: time, expiresAtMs: time + 60_000 } })).toBe(true)
  f.raw.prepare(`INSERT INTO sync_relay_link_principals
    (principal_id,grant_id,mint_generation,profile_token_hash,display_name,created_at_ms,blocked_at_ms,discussion_revision,storage_bytes)
    VALUES ('private-link-principal','grant',4,?,'Visitor',?,NULL,0,256)`).run(scope.profileTokenHash, time)
  f.raw.prepare('UPDATE sync_relay_link_sessions SET principal_id=? WHERE session_id=?').run('private-link-principal', scope.sessionId)
  const input = f.capture(f.update(), 'link-edit', liveBrowserActor(scope))
  const authority = input.expectedAuthority, storage = f.storage as StorageContext
  if (authority.principalKind !== 'link') throw new Error('Link authority missing')
  const publicId = storage.tx(() => ensureLiveLinkPublicPrincipal(storage, authority))
  expect(storage.tx(() => ensureLiveLinkPublicPrincipal(storage, authority))).toBe(publicId)
  const snapshot = storage.tx(() => deriveLiveAuthorSnapshot(storage, authority, { kind: 'link', publicPrincipalId: publicId }))
  expect(snapshot).toEqual([{ kind: 'link', publicPrincipalId: publicId, label: 'Visitor' }])
  const result = f.storage.commitLiveUpdateJournal({ ...input, metadata: { ...input.metadata, authorContext: { kind: 'link', publicPrincipalId: publicId } } })
  expect(result.result.kind).toBe('accepted')
  expect(result.admitted?.metadata.authorSnapshot).toEqual(snapshot)
  const exported = JSON.stringify(result.admitted?.metadata.authorSnapshot)
  for (const privateValue of [authority.principalId, authority.grantId, scope.sessionId, scope.capabilityHash, scope.profileTokenHash]) expect(exported).not.toContain(privateValue)
  expect(storage.tx(() => deriveLiveAuthorSnapshot(storage, authority, { kind: 'link', publicPrincipalId: 'forged-public-id' }))).toEqual([])
})
