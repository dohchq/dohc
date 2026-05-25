import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  MemoryYDocPersistenceBackend,
  PostgresYDocStore,
  PostgresYDocPersistenceBackend,
} from './persistence'

function updateFromText(value: string, base?: Y.Doc): Uint8Array {
  const doc = base ?? new Y.Doc()
  const text = doc.getText('body')
  text.delete(0, text.length)
  text.insert(0, value)
  return Y.encodeStateAsUpdate(doc, base ? Y.encodeStateVector(base) : undefined)
}

describe('Y.Doc persistence', () => {
  it('appends updates with monotonic per-document sequence numbers and metadata', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)

    const first = await store.appendUpdate({
      documentName: 'workspace/ws/atom/a',
      update: updateFromText('one'),
      actorId: 'user_1',
      socketId: 'socket_1',
    })
    const second = await store.appendUpdate({
      documentName: 'workspace/ws/atom/a',
      update: updateFromText('two'),
      actorId: 'user_2',
      socketId: 'socket_2',
    })
    const otherDoc = await store.appendUpdate({
      documentName: 'workspace/ws/atom/b',
      update: updateFromText('other'),
      actorId: 'user_3',
      socketId: 'socket_3',
    })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(otherDoc.seq).toBe(1)
    expect(backend.updatesFor('workspace/ws/atom/a')[1]).toMatchObject({
      actorId: 'user_2',
      socketId: 'socket_2',
    })
  })

  it('loads the latest snapshot and replays newer updates in sequence', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const documentName = 'workspace/ws/atom/a'

    const snapshotDoc = new Y.Doc()
    snapshotDoc.getText('body').insert(0, 'hello')
    await backend.insertSnapshot({
      documentName,
      snapshotBytes: Y.encodeStateAsUpdate(snapshotDoc),
      stateVector: Y.encodeStateVector(snapshotDoc),
      lastSeq: 1,
    })

    const editedDoc = new Y.Doc()
    Y.applyUpdate(editedDoc, Y.encodeStateAsUpdate(snapshotDoc))
    editedDoc.getText('body').insert(5, ' world')
    await backend.insertUpdate({
      documentName,
      updateBytes: Y.encodeStateAsUpdate(editedDoc, Y.encodeStateVector(snapshotDoc)),
      actorId: 'user_1',
      socketId: 'socket_1',
    })

    const loaded = await store.loadDocument(documentName)

    expect(loaded.getText('body').toString()).toBe('hello world')
  })

  it('stores compact snapshots at the latest update sequence', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const documentName = 'workspace/ws/atom/a'
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'snapshot me')

    await store.appendUpdate({
      documentName,
      update: Y.encodeStateAsUpdate(doc),
      actorId: 'user_1',
      socketId: 'socket_1',
    })
    const snapshot = await store.storeSnapshot(documentName, doc)

    expect(snapshot.lastSeq).toBe(1)
    expect(snapshot.snapshotId).toBe(1)
  })

  it('uses one acquired Postgres client for transactional appends', async () => {
    const transactionQueries: string[] = []
    const poolQueries: string[] = []
    const client = {
      async query(sql: string) {
        transactionQueries.push(sql)
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO hocuspocus_ydoc_counters')) {
          return { rows: [{ seq: '1' }] }
        }
        if (sql.includes('INSERT INTO hocuspocus_ydoc_updates')) {
          return {
            rows: [
              {
                doc_name: 'workspace/ws/atom/a',
                seq: '1',
                update_bytes: Buffer.from([1, 2, 3]),
                actor_id: 'user_1',
                socket_id: 'socket_1',
                received_at: new Date('2026-05-25T00:00:00.000Z'),
              },
            ],
          }
        }
        throw new Error(`Unexpected transaction query: ${sql}`)
      },
      release: vi.fn(),
    }
    const pool = {
      async query(sql: string) {
        poolQueries.push(sql)
        throw new Error('pool.query must not be used inside transaction')
      },
      async connect() {
        return client
      },
    }
    const backend = new PostgresYDocPersistenceBackend(pool as never)

    const row = await backend.insertUpdate({
      documentName: 'workspace/ws/atom/a',
      updateBytes: new Uint8Array([1, 2, 3]),
      actorId: 'user_1',
      socketId: 'socket_1',
    })

    expect(row.seq).toBe(1)
    expect(poolQueries).toEqual([])
    expect(transactionQueries[0]).toBe('BEGIN')
    expect(transactionQueries.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })
})
