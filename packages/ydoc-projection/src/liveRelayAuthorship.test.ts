import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { LiveAuthorContext } from '@dohc/live-session-contract'
import type { LiveUpdateJournalCommitInput } from '../../../services/sync-relay/src/storage.js'
import type { StorageContext } from '../../../services/sync-relay/src/storage/context.js'
import { createLiveJournalHistoryAuthority } from '../../../services/sync-relay/src/storage/liveJournalHistory.js'
import { assessLiveAuthorWindow } from '../../../services/sync-relay/src/storage/liveAuthorWindow.js'
import { deriveLiveAuthorSnapshot, ensureLiveLinkPublicPrincipal } from '../../../services/sync-relay/src/storage/liveAuthorSnapshot.js'
import { liveBrowserActor } from '../../../services/sync-relay/src/liveBrowserContext.js'
import { hashLinkBearer, hashLinkProfileSecret } from '../../../services/sync-relay/src/linkSecurity.js'
import { registered, cleanupLiveDeliveryFixtures } from './liveCommittedDeliveryTestSupport.js'

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

it('stamps the matching authenticated account and declared agent', () => {
  const f = setup(), actor = bobActor
  const accountId = actor.userId, name = 'Bob'
  const agent = { agentId: 'agent', agentName: 'Declared agent', onBehalfOf: accountId, depth: 1 }
  const input = authored(f.capture(f.update(), 'matching', actor), { kind: 'account', accountId, agent }, name)
  const result = f.storage.commitLiveUpdateJournal(input)
  expect(result.result).toMatchObject({ kind: 'accepted', replayed: false })
  expect(result.admitted?.metadata).toMatchObject({ canonicalVersion: 2, firstSeenDeletes: [],
    authorSnapshot: [{ kind: 'human', humanId: accountId, humanName: name }, { kind: 'agent', ...agent }] })
  expect(f.journalRows().journal[0]!.author_context_json).toBe(JSON.stringify(input.metadata.authorContext))
})

it.each(['mismatch', 'signed-out'])('admits %s account context unnamed', mode => {
  const f = setup(), captured = f.capture(f.update(), mode)
  const input = authored(captured, mode === 'mismatch' ? { kind: 'account', accountId: 'reader', agent: { agentId: 'agent' } }
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

it('admits an owner delta reconstructed from two unbound clients unattributed and replays its unchanged context', () => {
  const f = setup(), one = replica(f, 101), two = replica(f, 202)
  const mixed = Y.mergeUpdates([edit(one, 'one', 'Alice'), edit(two, 'two', 'Alice')])
  const input = authored(f.capture(mixed, 'mixed'))
  expect(input.validation.kind).toBe('accepted')
  const result = f.storage.commitLiveUpdateJournal(input)
  expect(result.result).toMatchObject({ kind: 'accepted', replayed: false })
  expect(result.admitted?.metadata.authorSnapshot).toEqual([])
  expect(result.admitted?.metadata.firstSeen).toEqual([
    { clientId: 101, startClock: 0, endClock: 1 }, { clientId: 202, startClock: 0, endClock: 1 },
  ])
  expect(assessLiveAuthorWindow([], { authorSnapshot: result.admitted!.metadata.authorSnapshot!,
    firstSeen: result.admitted!.metadata.firstSeen, firstSeenDeletes: [] }).coverage).toEqual([
    { author: { kind: 'unattributed' }, structRanges: result.admitted!.metadata.firstSeen, deletionRanges: [] },
  ])
  expect(f.journalRows().journal[0]!.author_context_json).toBe(JSON.stringify(input.metadata.authorContext))
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM sync_relay_live_author_clients').get()!.n).toBe(0)
  const beforeReplay = f.journalRows()
  expect(f.storage.commitLiveUpdateJournal(input)).toEqual({ ...result, result: { ...result.result, replayed: true } })
  expect(f.journalRows()).toEqual(beforeReplay)
})

it('refuses new structs from a client already bound to another identity', () => {
  const f = setup(), first = f.update('alice', 'Alice')
  expect(f.storage.commitLiveUpdateJournal(authored(f.capture(first, 'alice'))).result.kind).toBe('accepted')
  const next = f.update('alice-again', 'Alice'), bobDoc = replica(f, 202, [first])
  const mixed = Y.mergeUpdates([next, edit(bobDoc, 'bob', 'Bob')]), before = f.journalRows()
  expect(f.storage.commitLiveUpdateJournal(authored(f.capture(mixed, 'other-snapshot', bobActor), { kind: 'account', accountId: 'reader' }, 'Bob')).result)
    .toEqual({ kind: 'refused', reason: 'provenance-refused' })
  expect(f.journalRows()).toEqual(before)
})

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
  f.raw.prepare("UPDATE sync_relay_link_principals SET display_name='Relabeled' WHERE principal_id='private-link-principal'").run()
  const relabeled = f.capture(f.update('relabeled'), 'relabeled', liveBrowserActor(scope))
  const renamed = f.storage.commitLiveUpdateJournal({...relabeled, metadata: {...relabeled.metadata, authorContext: {kind: 'link', publicPrincipalId: publicId}}})
  expect(renamed.result.kind).toBe('accepted')
  expect(renamed.admitted?.metadata.authorSnapshot).toEqual(snapshot)
  const exported = JSON.stringify(result.admitted?.metadata.authorSnapshot)
  for (const privateValue of [authority.principalId, authority.grantId, scope.sessionId, scope.capabilityHash, scope.profileTokenHash]) expect(exported).not.toContain(privateValue)
  expect(storage.tx(() => deriveLiveAuthorSnapshot(storage, authority, { kind: 'link', publicPrincipalId: 'forged-public-id' }))).toEqual([])
})
