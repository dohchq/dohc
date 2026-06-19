import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  MemoryYDocPersistenceBackend,
  PostgresYDocStore,
  PostgresYDocPersistenceBackend,
  type ProjectionJobInput,
} from './persistence.js'

function updateFromText(value: string, base?: Y.Doc): Uint8Array {
  const doc = base ?? new Y.Doc()
  const text = doc.getText('body')
  text.delete(0, text.length)
  text.insert(0, value)
  return Y.encodeStateAsUpdate(doc, base ? Y.encodeStateVector(base) : undefined)
}

function projectionJob(
  overrides: Partial<ProjectionJobInput> = {},
): ProjectionJobInput {
  return {
    documentName: 'workspace/ws/atom/a',
    workspaceId: 'ws',
    atomId: 'a',
    markdown: '---\nid: a\n---\n# A',
    projectionHash: 'hash-a',
    schemaVersion: 1,
    ydocStateVector: 'AQID',
    ydocSeq: 1,
    lastEditedByUserId: 'user_1',
    ...overrides,
  }
}

describe('Y.Doc persistence', () => {
  it('detects whether a document has any persisted state', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const documentName = 'workspace/ws/atom/a'

    await expect(store.hasDocumentState(documentName)).resolves.toBe(false)

    await store.appendUpdate({
      documentName,
      update: updateFromText('update state'),
      actorId: 'user_1',
      socketId: 'socket_1',
    })

    await expect(store.hasDocumentState(documentName)).resolves.toBe(true)
  })

  it('treats a sequence-zero snapshot as persisted document state', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const documentName = 'workspace/ws/atom/bootstrap'
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'bootstrapped')

    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    await expect(store.latestSequence(documentName)).resolves.toBe(0)
    await expect(store.hasDocumentState(documentName)).resolves.toBe(true)
  })

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
        if (sql.includes('pg_advisory_xact_lock')) {
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

  it('stores bootstrap snapshots only if no state appears under the document lock', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const documentName = 'workspace/ws/atom/bootstrap-race'
    const updateDoc = new Y.Doc()
    updateDoc.getText('body').insert(0, 'already won')
    await store.appendUpdate({
      documentName,
      update: Y.encodeStateAsUpdate(updateDoc),
      actorId: 'user_1',
      socketId: 'socket_1',
    })

    const bootstrapDoc = new Y.Doc()
    bootstrapDoc.getText('body').insert(0, 'stale bootstrap')

    await expect(
      store.storeSnapshotIfMissing(documentName, bootstrapDoc, { lastSeq: 0 }),
    ).resolves.toBeNull()
    await expect(backend.getLatestSnapshot(documentName)).resolves.toBeNull()
  })

  it('deletes all persisted state for a document before file-id reuse', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const documentName = 'workspace/ws/atom/reused'
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'old document')

    await store.appendUpdate({
      documentName,
      update: Y.encodeStateAsUpdate(doc),
      actorId: 'user_1',
      socketId: 'socket_1',
    })
    await store.storeSnapshot(documentName, doc)

    await store.deleteDocument(documentName)

    await expect(store.hasDocumentState(documentName)).resolves.toBe(false)
    await expect(store.latestSequence(documentName)).resolves.toBe(0)
    await expect(backend.getLatestSnapshot(documentName)).resolves.toBeNull()
    expect(backend.updatesFor(documentName)).toEqual([])
  })

  it('persists projection jobs with monotonic ids', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)

    const first = await store.enqueueProjectionJob(projectionJob())
    const second = await store.enqueueProjectionJob(
      projectionJob({ documentName: 'workspace/ws/atom/b', atomId: 'b' }),
    )

    expect(first.id).toBe(1)
    expect(second.id).toBe(2)
    await expect(store.listRetryableProjectionJobs()).resolves.toMatchObject([
      { id: 1, documentName: 'workspace/ws/atom/a', status: 'pending' },
      { id: 2, documentName: 'workspace/ws/atom/b', status: 'pending' },
    ])
  })

  it('skips older retryable projection jobs for the same document', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)

    const stale = await store.enqueueProjectionJob(projectionJob({ ydocSeq: 1 }))
    const latest = await store.enqueueProjectionJob(
      projectionJob({ markdown: '---\nid: a\n---\n# Latest', ydocSeq: 2 }),
    )

    expect(stale.status).toBe('pending')
    expect(latest.id).toBe(2)
    await expect(store.listRetryableProjectionJobs()).resolves.toMatchObject([
      { id: 2, markdown: '---\nid: a\n---\n# Latest', status: 'pending' },
    ])
    expect(backend.projectionJobsFor('workspace/ws/atom/a')[0]?.status).toBe(
      'skipped',
    )
  })

  it('keeps failed projection jobs retryable until they succeed', async () => {
    const backend = new MemoryYDocPersistenceBackend()
    const store = new PostgresYDocStore(backend)
    const job = await store.enqueueProjectionJob(projectionJob())

    await store.markProjectionJobFailed(job.id, 'backend unavailable')

    await expect(store.listRetryableProjectionJobs()).resolves.toMatchObject([
      { id: job.id, status: 'failed', attempts: 1, lastError: 'backend unavailable' },
    ])

    await store.markProjectionJobSucceeded(job.id)

    await expect(store.listRetryableProjectionJobs()).resolves.toEqual([])
    expect(backend.projectionJobsFor('workspace/ws/atom/a')[0]?.status).toBe(
      'succeeded',
    )
  })
})
