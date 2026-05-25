import type { Pool, PoolClient, QueryResult } from 'pg'
import * as Y from 'yjs'

export type SqlClient = Pick<Pool | PoolClient, 'query'>
type TransactionClient = Pick<PoolClient, 'query' | 'release'>
type SqlPool = SqlClient & {
  connect(): Promise<TransactionClient>
}

export type PersistedUpdate = {
  documentName: string
  seq: number
  updateBytes: Uint8Array
  actorId: string | null
  socketId: string | null
  receivedAt: Date
}

export type PersistedSnapshot = {
  snapshotId: number
  documentName: string
  snapshotBytes: Uint8Array
  stateVector: Uint8Array
  lastSeq: number
  createdAt: Date
}

export type InsertUpdateInput = {
  documentName: string
  updateBytes: Uint8Array
  actorId: string | null
  socketId: string | null
}

export type InsertSnapshotInput = {
  documentName: string
  snapshotBytes: Uint8Array
  stateVector: Uint8Array
  lastSeq: number
}

export interface YDocPersistenceBackend {
  ensureSchema(): Promise<void>
  hasDocumentState(documentName: string): Promise<boolean>
  getLatestSnapshot(documentName: string): Promise<PersistedSnapshot | null>
  listUpdatesAfter(documentName: string, seq: number): Promise<PersistedUpdate[]>
  latestSequence(documentName: string): Promise<number>
  insertUpdate(input: InsertUpdateInput): Promise<PersistedUpdate>
  insertSnapshot(input: InsertSnapshotInput): Promise<PersistedSnapshot>
}

function hasPoolConnect(client: SqlClient): client is SqlPool {
  return (
    'connect' in client &&
    typeof (client as { connect?: unknown }).connect === 'function'
  )
}

function hasRelease(client: SqlClient): client is TransactionClient {
  return (
    'release' in client &&
    typeof (client as { release?: unknown }).release === 'function'
  )
}

async function rollbackQuietly(client: SqlClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {}
}

async function withTransaction<T>(
  client: SqlClient,
  run: (transactionClient: SqlClient) => Promise<T>,
): Promise<T> {
  const transactionClient = hasPoolConnect(client) ? await client.connect() : client
  try {
    await transactionClient.query('BEGIN')
    const result = await run(transactionClient)
    await transactionClient.query('COMMIT')
    return result
  } catch (error) {
    await rollbackQuietly(transactionClient)
    throw error
  } finally {
    if (hasRelease(transactionClient)) {
      transactionClient.release()
    }
  }
}

export async function ensureYDocPersistenceSchema(client: SqlClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS hocuspocus_ydoc_counters (
      doc_name text PRIMARY KEY,
      last_seq bigint NOT NULL DEFAULT 0
    )
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS hocuspocus_ydoc_updates (
      doc_name text NOT NULL,
      seq bigint NOT NULL,
      update_bytes bytea NOT NULL,
      actor_id text,
      socket_id text,
      received_at timestamptz NOT NULL DEFAULT now(),
      snapshot_id bigint,
      PRIMARY KEY (doc_name, seq)
    )
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS hocuspocus_ydoc_snapshots (
      id bigserial PRIMARY KEY,
      doc_name text NOT NULL,
      snapshot_bytes bytea NOT NULL,
      state_vector bytea NOT NULL,
      last_seq bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS hocuspocus_ydoc_updates_doc_seq_idx
      ON hocuspocus_ydoc_updates (doc_name, seq)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS hocuspocus_ydoc_snapshots_doc_seq_idx
      ON hocuspocus_ydoc_snapshots (doc_name, last_seq DESC, id DESC)
  `)
}

export class PostgresYDocPersistenceBackend implements YDocPersistenceBackend {
  constructor(private readonly client: SqlClient) {}

  async ensureSchema(): Promise<void> {
    await ensureYDocPersistenceSchema(this.client)
  }

  async hasDocumentState(documentName: string): Promise<boolean> {
    const result = await this.client.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM hocuspocus_ydoc_snapshots WHERE doc_name = $1
          UNION ALL
          SELECT 1 FROM hocuspocus_ydoc_updates WHERE doc_name = $1
          LIMIT 1
        ) AS exists
      `,
      [documentName],
    )
    return result.rows[0]?.exists === true
  }

  async getLatestSnapshot(documentName: string): Promise<PersistedSnapshot | null> {
    const result = await this.client.query<{
      id: number | string
      doc_name: string
      snapshot_bytes: Buffer
      state_vector: Buffer
      last_seq: number | string
      created_at: Date
    }>(
      `
        SELECT id, doc_name, snapshot_bytes, state_vector, last_seq, created_at
        FROM hocuspocus_ydoc_snapshots
        WHERE doc_name = $1
        ORDER BY last_seq DESC, id DESC
        LIMIT 1
      `,
      [documentName],
    )
    const row = result.rows[0]
    if (!row) return null

    return {
      snapshotId: Number(row.id),
      documentName: row.doc_name,
      snapshotBytes: new Uint8Array(row.snapshot_bytes),
      stateVector: new Uint8Array(row.state_vector),
      lastSeq: Number(row.last_seq),
      createdAt: row.created_at,
    }
  }

  async listUpdatesAfter(
    documentName: string,
    seq: number,
  ): Promise<PersistedUpdate[]> {
    const result = await this.client.query<{
      doc_name: string
      seq: number | string
      update_bytes: Buffer
      actor_id: string | null
      socket_id: string | null
      received_at: Date
    }>(
      `
        SELECT doc_name, seq, update_bytes, actor_id, socket_id, received_at
        FROM hocuspocus_ydoc_updates
        WHERE doc_name = $1 AND seq > $2
        ORDER BY seq ASC
      `,
      [documentName, seq],
    )

    return result.rows.map((row) => ({
      documentName: row.doc_name,
      seq: Number(row.seq),
      updateBytes: new Uint8Array(row.update_bytes),
      actorId: row.actor_id,
      socketId: row.socket_id,
      receivedAt: row.received_at,
    }))
  }

  async latestSequence(documentName: string): Promise<number> {
    const result = await this.client.query<{ last_seq: number | string }>(
      'SELECT last_seq FROM hocuspocus_ydoc_counters WHERE doc_name = $1',
      [documentName],
    )
    return Number(result.rows[0]?.last_seq ?? 0)
  }

  async insertUpdate(input: InsertUpdateInput): Promise<PersistedUpdate> {
    return withTransaction(this.client, async (client) => {
      const counter = await client.query<{ seq: number | string }>(
        `
          INSERT INTO hocuspocus_ydoc_counters (doc_name, last_seq)
          VALUES ($1, 1)
          ON CONFLICT (doc_name)
          DO UPDATE SET last_seq = hocuspocus_ydoc_counters.last_seq + 1
          RETURNING last_seq AS seq
        `,
        [input.documentName],
      )
      const seq = Number(counter.rows[0]?.seq)
      const inserted = await client.query<{
        doc_name: string
        seq: number | string
        update_bytes: Buffer
        actor_id: string | null
        socket_id: string | null
        received_at: Date
      }>(
        `
          INSERT INTO hocuspocus_ydoc_updates
            (doc_name, seq, update_bytes, actor_id, socket_id)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING doc_name, seq, update_bytes, actor_id, socket_id, received_at
        `,
        [
          input.documentName,
          seq,
          Buffer.from(input.updateBytes),
          input.actorId,
          input.socketId,
        ],
      )

      const row = inserted.rows[0]
      return {
        documentName: row.doc_name,
        seq: Number(row.seq),
        updateBytes: new Uint8Array(row.update_bytes),
        actorId: row.actor_id,
        socketId: row.socket_id,
        receivedAt: row.received_at,
      }
    })
  }

  async insertSnapshot(input: InsertSnapshotInput): Promise<PersistedSnapshot> {
    const result = await this.client.query<{
      id: number | string
      doc_name: string
      snapshot_bytes: Buffer
      state_vector: Buffer
      last_seq: number | string
      created_at: Date
    }>(
      `
        INSERT INTO hocuspocus_ydoc_snapshots
          (doc_name, snapshot_bytes, state_vector, last_seq)
        VALUES ($1, $2, $3, $4)
        RETURNING id, doc_name, snapshot_bytes, state_vector, last_seq, created_at
      `,
      [
        input.documentName,
        Buffer.from(input.snapshotBytes),
        Buffer.from(input.stateVector),
        input.lastSeq,
      ],
    )
    const row = result.rows[0]
    return {
      snapshotId: Number(row.id),
      documentName: row.doc_name,
      snapshotBytes: new Uint8Array(row.snapshot_bytes),
      stateVector: new Uint8Array(row.state_vector),
      lastSeq: Number(row.last_seq),
      createdAt: row.created_at,
    }
  }
}

export class PostgresYDocStore {
  constructor(private readonly backend: YDocPersistenceBackend) {}

  async ensureSchema(): Promise<void> {
    await this.backend.ensureSchema()
  }

  async hasDocumentState(documentName: string): Promise<boolean> {
    return this.backend.hasDocumentState(documentName)
  }

  async loadDocument(documentName: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    const snapshot = await this.backend.getLatestSnapshot(documentName)
    const snapshotSeq = snapshot?.lastSeq ?? 0

    if (snapshot) {
      Y.applyUpdate(doc, snapshot.snapshotBytes)
    }

    const updates = await this.backend.listUpdatesAfter(documentName, snapshotSeq)
    for (const update of updates) {
      Y.applyUpdate(doc, update.updateBytes)
    }

    return doc
  }

  async appendUpdate(input: {
    documentName: string
    update: Uint8Array
    actorId: string | null
    socketId: string | null
  }): Promise<{ seq: number }> {
    const row = await this.backend.insertUpdate({
      documentName: input.documentName,
      updateBytes: input.update,
      actorId: input.actorId,
      socketId: input.socketId,
    })
    return { seq: row.seq }
  }

  async storeSnapshot(
    documentName: string,
    doc: Y.Doc,
    options?: { lastSeq?: number },
  ): Promise<{ snapshotId: number; lastSeq: number }> {
    const lastSeq = options?.lastSeq ?? (await this.backend.latestSequence(documentName))
    const snapshot = await this.backend.insertSnapshot({
      documentName,
      snapshotBytes: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      lastSeq,
    })
    return {
      snapshotId: snapshot.snapshotId,
      lastSeq: snapshot.lastSeq,
    }
  }

  async latestSequence(documentName: string): Promise<number> {
    return this.backend.latestSequence(documentName)
  }
}

export class MemoryYDocPersistenceBackend implements YDocPersistenceBackend {
  private readonly updates = new Map<string, PersistedUpdate[]>()
  private readonly snapshots = new Map<string, PersistedSnapshot[]>()
  private readonly counters = new Map<string, number>()
  private snapshotCounter = 0

  async ensureSchema(): Promise<void> {}

  async hasDocumentState(documentName: string): Promise<boolean> {
    return (
      (this.updates.get(documentName)?.length ?? 0) > 0 ||
      (this.snapshots.get(documentName)?.length ?? 0) > 0
    )
  }

  updatesFor(documentName: string): PersistedUpdate[] {
    return this.updates.get(documentName) ?? []
  }

  async getLatestSnapshot(documentName: string): Promise<PersistedSnapshot | null> {
    const snapshots = this.snapshots.get(documentName) ?? []
    return snapshots.at(-1) ?? null
  }

  async listUpdatesAfter(
    documentName: string,
    seq: number,
  ): Promise<PersistedUpdate[]> {
    return this.updatesFor(documentName).filter((update) => update.seq > seq)
  }

  async latestSequence(documentName: string): Promise<number> {
    return this.counters.get(documentName) ?? 0
  }

  async insertUpdate(input: InsertUpdateInput): Promise<PersistedUpdate> {
    const seq = (this.counters.get(input.documentName) ?? 0) + 1
    this.counters.set(input.documentName, seq)

    const row: PersistedUpdate = {
      documentName: input.documentName,
      seq,
      updateBytes: input.updateBytes,
      actorId: input.actorId,
      socketId: input.socketId,
      receivedAt: new Date(),
    }
    this.updates.set(input.documentName, [...this.updatesFor(input.documentName), row])
    return row
  }

  async insertSnapshot(input: InsertSnapshotInput): Promise<PersistedSnapshot> {
    const snapshot: PersistedSnapshot = {
      snapshotId: ++this.snapshotCounter,
      documentName: input.documentName,
      snapshotBytes: input.snapshotBytes,
      stateVector: input.stateVector,
      lastSeq: input.lastSeq,
      createdAt: new Date(),
    }
    this.counters.set(
      input.documentName,
      Math.max(this.counters.get(input.documentName) ?? 0, input.lastSeq),
    )
    this.snapshots.set(input.documentName, [
      ...(this.snapshots.get(input.documentName) ?? []),
      snapshot,
    ])
    return snapshot
  }
}
