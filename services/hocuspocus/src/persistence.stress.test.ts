import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  MemoryYDocPersistenceBackend,
  PostgresYDocStore,
} from './persistence.js'

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pickInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive)
}

function mutateText(doc: Y.Doc, rng: () => number, token: string): string {
  const text = doc.getText('body')
  if (text.length === 0 || rng() < 0.72) {
    const at = pickInt(rng, text.length + 1)
    text.insert(at, token)
    return `insert(${at}, ${token})`
  }

  const at = pickInt(rng, text.length)
  const count = 1 + pickInt(rng, Math.min(4, text.length - at))
  text.delete(at, count)
  return `delete(${at}, ${count})`
}

describe('Y.Doc persistence stress', () => {
  it('replays deterministic multi-client append logs and compact snapshots exactly', async () => {
    const seed = 0xdecafbad
    const rng = seededRandom(seed)
    const trace: string[] = []
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const documentName = 'workspace/stress/atom/live'
    const canonical = new Y.Doc()
    const clients = Array.from({ length: 4 }, () => new Y.Doc())

    try {
      for (let step = 0; step < 80; step++) {
        const clientIndex = pickInt(rng, clients.length)
        const client = clients[clientIndex]!
        const op = mutateText(client, rng, `[c${clientIndex}:s${step}]`)
        const update = Y.encodeStateAsUpdate(client)
        const persisted = await store.appendUpdate({
          documentName,
          update,
          actorId: `user_${clientIndex}`,
          socketId: `socket_${clientIndex}`,
        })
        trace.push(`step ${step}: ${op} -> seq ${persisted.seq}`)
        expect(persisted.seq).toBe(step + 1)

        // Broadcast after persistence succeeds, mirroring the server contract:
        // an accepted update must be durable before peers see it.
        for (const peer of clients) {
          if (peer !== client) Y.applyUpdate(peer, update)
        }
        Y.applyUpdate(canonical, update)

        if (step > 0 && step % 17 === 0) {
          const snapshot = await store.storeSnapshot(documentName, canonical)
          trace.push(`snapshot seq ${snapshot.lastSeq}`)
          expect(snapshot.lastSeq).toBe(step + 1)
        }
      }

      const loaded = await store.loadDocument(documentName)
      const expected = canonical.getText('body').toString()
      expect(loaded.getText('body').toString()).toBe(expected)
      for (const [index, client] of clients.entries()) {
        expect(client.getText('body').toString(), `client ${index}`).toBe(expected)
      }
      await expect(store.latestSequence(documentName)).resolves.toBe(80)
      expect(backend.updatesFor(documentName)).toHaveLength(80)
    } catch (error) {
      throw new Error(
        `persistence stress failed with seed ${seed}\n${trace.join('\n')}\n${String(error)}`,
      )
    } finally {
      for (const doc of [canonical, ...clients]) doc.destroy()
    }
  })
})
