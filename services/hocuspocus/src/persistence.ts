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

export type ProjectionJobStatus = 'pending' | 'failed' | 'succeeded' | 'skipped'

export type ProjectionJobInput = {
  documentName: string
  workspaceId: string
  atomId: string
  markdown: string
  projectionHash: string
  schemaVersion: number
  ydocStateVector: string
  ydocSeq: number
  lastEditedByUserId?: string | null
}

export type PersistedProjectionJob = ProjectionJobInput & {
  id: number
  status: ProjectionJobStatus
  attempts: number
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

export type PersistedSemanticOperation = {
  operationId: string
  response: unknown
  createdAt: Date
}

export type AppendUpdateAndRecordSemanticOperationInput = InsertUpdateInput & {
  operationId: string
  response: unknown
}

export type AppendUpdateAndRecordSemanticOperationResult = {
  operation: PersistedSemanticOperation
  update: PersistedUpdate | null
  deduped: boolean
}

export interface YDocPersistenceBackend {
  ensureSchema(): Promise<void>
  hasDocumentState(documentName: string): Promise<boolean>
  getLatestSnapshot(documentName: string): Promise<PersistedSnapshot | null>
  listUpdatesAfter(documentName: string, seq: number): Promise<PersistedUpdate[]>
  latestSequence(documentName: string): Promise<number>
  insertUpdate(input: InsertUpdateInput): Promise<PersistedUpdate>
  insertSnapshot(input: InsertSnapshotInput): Promise<PersistedSnapshot>
  insertSnapshotIfMissing(
    input: InsertSnapshotInput,
  ): Promise<PersistedSnapshot | null>
  enqueueProjectionJob(input: ProjectionJobInput): Promise<PersistedProjectionJob>
  listRetryableProjectionJobs(limit?: number): Promise<PersistedProjectionJob[]>
  markProjectionJobSucceeded(id: number): Promise<void>
  markProjectionJobFailed(id: number, error: string): Promise<void>
  getSemanticOperation(operationId: string): Promise<PersistedSemanticOperation | null>
  recordSemanticOperation(
    operationId: string,
    response: unknown,
  ): Promise<PersistedSemanticOperation>
  appendUpdateAndRecordSemanticOperation(
    input: AppendUpdateAndRecordSemanticOperationInput,
  ): Promise<AppendUpdateAndRecordSemanticOperationResult>
  deleteDocument(documentName: string): Promise<void>
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

async function lockDocumentForTransaction(
  client: SqlClient,
  documentName: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    documentName,
  ])
}

async function hasDocumentStateInTransaction(
  client: SqlClient,
  documentName: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
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

function persistedSnapshotFromRow(row: {
  id: number | string
  doc_name: string
  snapshot_bytes: Buffer
  state_vector: Buffer
  last_seq: number | string
  created_at: Date
}): PersistedSnapshot {
  return {
    snapshotId: Number(row.id),
    documentName: row.doc_name,
    snapshotBytes: new Uint8Array(row.snapshot_bytes),
    stateVector: new Uint8Array(row.state_vector),
    lastSeq: Number(row.last_seq),
    createdAt: row.created_at,
  }
}

function persistedProjectionJobFromRow(row: {
  id: number | string
  doc_name: string
  workspace_id: string
  atom_id: string
  markdown: string
  projection_hash: string
  schema_version: number | string
  ydoc_state_vector: string
  ydoc_seq: number | string
  last_edited_by_user_id: string | null
  status: ProjectionJobStatus
  attempts: number | string
  last_error: string | null
  created_at: Date
  updated_at: Date
}): PersistedProjectionJob {
  return {
    id: Number(row.id),
    documentName: row.doc_name,
    workspaceId: row.workspace_id,
    atomId: row.atom_id,
    markdown: row.markdown,
    projectionHash: row.projection_hash,
    schemaVersion: Number(row.schema_version),
    ydocStateVector: row.ydoc_state_vector,
    ydocSeq: Number(row.ydoc_seq),
    lastEditedByUserId: row.last_edited_by_user_id,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function persistedSemanticOperationFromRow(row: {
  operation_id: string
  response_json: unknown
  created_at: Date
}): PersistedSemanticOperation {
  return {
    operationId: row.operation_id,
    response: row.response_json,
    createdAt: row.created_at,
  }
}

async function getSemanticOperationInTransaction(
  client: SqlClient,
  operationId: string,
): Promise<PersistedSemanticOperation | null> {
  const result = await client.query<{
    operation_id: string
    response_json: unknown
    created_at: Date
  }>(
    `
      SELECT operation_id, response_json, created_at
      FROM hocuspocus_semantic_operations
      WHERE operation_id = $1
    `,
    [operationId],
  )
  const row = result.rows[0]
  return row ? persistedSemanticOperationFromRow(row) : null
}

async function recordSemanticOperationInTransaction(
  client: SqlClient,
  operationId: string,
  response: unknown,
): Promise<PersistedSemanticOperation> {
  const result = await client.query<{
    operation_id: string
    response_json: unknown
    created_at: Date
  }>(
    `
      INSERT INTO hocuspocus_semantic_operations
        (operation_id, response_json)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (operation_id)
      DO UPDATE SET response_json = hocuspocus_semantic_operations.response_json
      RETURNING operation_id, response_json, created_at
    `,
    [operationId, JSON.stringify(response)],
  )
  return persistedSemanticOperationFromRow(result.rows[0])
}

async function insertUpdateInTransaction(
  client: SqlClient,
  input: InsertUpdateInput,
): Promise<PersistedUpdate> {
  await lockDocumentForTransaction(client, input.documentName)
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
  await client.query(`
    CREATE TABLE IF NOT EXISTS hocuspocus_projection_jobs (
      id bigserial PRIMARY KEY,
      doc_name text NOT NULL,
      workspace_id text NOT NULL,
      atom_id text NOT NULL,
      markdown text NOT NULL,
      projection_hash text NOT NULL,
      schema_version integer NOT NULL,
      ydoc_state_vector text NOT NULL,
      ydoc_seq bigint NOT NULL,
      last_edited_by_user_id text,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS hocuspocus_projection_jobs_retry_idx
      ON hocuspocus_projection_jobs (status, id)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS hocuspocus_projection_jobs_doc_status_idx
      ON hocuspocus_projection_jobs (doc_name, status, id)
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS hocuspocus_semantic_operations (
      operation_id text PRIMARY KEY,
      response_json jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

export class PostgresYDocPersistenceBackend implements YDocPersistenceBackend {
  constructor(private readonly client: SqlClient) {}

  async ensureSchema(): Promise<void> {
    await ensureYDocPersistenceSchema(this.client)
  }

  async hasDocumentState(documentName: string): Promise<boolean> {
    return hasDocumentStateInTransaction(this.client, documentName)
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

    return persistedSnapshotFromRow(row)
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
      return insertUpdateInTransaction(client, input)
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
    return persistedSnapshotFromRow(result.rows[0])
  }

  async insertSnapshotIfMissing(
    input: InsertSnapshotInput,
  ): Promise<PersistedSnapshot | null> {
    return withTransaction(this.client, async (client) => {
      await lockDocumentForTransaction(client, input.documentName)

      if (await hasDocumentStateInTransaction(client, input.documentName)) {
        return null
      }

      const result = await client.query<{
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
      return persistedSnapshotFromRow(result.rows[0])
    })
  }

  async enqueueProjectionJob(
    input: ProjectionJobInput,
  ): Promise<PersistedProjectionJob> {
    return withTransaction(this.client, async (client) => {
      await lockDocumentForTransaction(client, input.documentName)
      await client.query(
        `
          UPDATE hocuspocus_projection_jobs
          SET status = 'skipped', updated_at = now()
          WHERE doc_name = $1 AND status IN ('pending', 'failed')
        `,
        [input.documentName],
      )
      const result = await client.query<{
        id: number | string
        doc_name: string
        workspace_id: string
        atom_id: string
        markdown: string
        projection_hash: string
        schema_version: number | string
        ydoc_state_vector: string
        ydoc_seq: number | string
        last_edited_by_user_id: string | null
        status: ProjectionJobStatus
        attempts: number | string
        last_error: string | null
        created_at: Date
        updated_at: Date
      }>(
        `
          INSERT INTO hocuspocus_projection_jobs
            (doc_name, workspace_id, atom_id, markdown, projection_hash,
             schema_version, ydoc_state_vector, ydoc_seq, last_edited_by_user_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, doc_name, workspace_id, atom_id, markdown,
            projection_hash, schema_version, ydoc_state_vector, ydoc_seq,
            last_edited_by_user_id, status, attempts, last_error,
            created_at, updated_at
        `,
        [
          input.documentName,
          input.workspaceId,
          input.atomId,
          input.markdown,
          input.projectionHash,
          input.schemaVersion,
          input.ydocStateVector,
          input.ydocSeq,
          input.lastEditedByUserId ?? null,
        ],
      )
      return persistedProjectionJobFromRow(result.rows[0])
    })
  }

  async listRetryableProjectionJobs(
    limit = 100,
  ): Promise<PersistedProjectionJob[]> {
    const result = await this.client.query<{
      id: number | string
      doc_name: string
      workspace_id: string
      atom_id: string
      markdown: string
      projection_hash: string
      schema_version: number | string
      ydoc_state_vector: string
      ydoc_seq: number | string
      last_edited_by_user_id: string | null
      status: ProjectionJobStatus
      attempts: number | string
      last_error: string | null
      created_at: Date
      updated_at: Date
    }>(
      `
        SELECT id, doc_name, workspace_id, atom_id, markdown, projection_hash,
          schema_version, ydoc_state_vector, ydoc_seq, last_edited_by_user_id,
          status, attempts, last_error, created_at, updated_at
        FROM hocuspocus_projection_jobs
        WHERE status IN ('pending', 'failed')
        ORDER BY id ASC
        LIMIT $1
      `,
      [limit],
    )
    return result.rows.map(persistedProjectionJobFromRow)
  }

  async markProjectionJobSucceeded(id: number): Promise<void> {
    await this.client.query(
      `
        UPDATE hocuspocus_projection_jobs
        SET status = 'succeeded', updated_at = now()
        WHERE id = $1
      `,
      [id],
    )
  }

  async markProjectionJobFailed(id: number, error: string): Promise<void> {
    await this.client.query(
      `
        UPDATE hocuspocus_projection_jobs
        SET status = 'failed',
          attempts = attempts + 1,
          last_error = $2,
          updated_at = now()
        WHERE id = $1
      `,
      [id, error],
    )
  }

  async getSemanticOperation(
    operationId: string,
  ): Promise<PersistedSemanticOperation | null> {
    return getSemanticOperationInTransaction(this.client, operationId)
  }

  async recordSemanticOperation(
    operationId: string,
    response: unknown,
  ): Promise<PersistedSemanticOperation> {
    return recordSemanticOperationInTransaction(this.client, operationId, response)
  }

  async appendUpdateAndRecordSemanticOperation(
    input: AppendUpdateAndRecordSemanticOperationInput,
  ): Promise<AppendUpdateAndRecordSemanticOperationResult> {
    return withTransaction(this.client, async (client) => {
      await lockDocumentForTransaction(client, input.documentName)
      const existing = await getSemanticOperationInTransaction(
        client,
        input.operationId,
      )
      if (existing) {
        return { operation: existing, update: null, deduped: true }
      }
      const update = await insertUpdateInTransaction(client, input)
      const operation = await recordSemanticOperationInTransaction(
        client,
        input.operationId,
        input.response,
      )
      return { operation, update, deduped: false }
    })
  }

  async deleteDocument(documentName: string): Promise<void> {
    await withTransaction(this.client, async (client) => {
      await lockDocumentForTransaction(client, documentName)
      await client.query(
        'DELETE FROM hocuspocus_projection_jobs WHERE doc_name = $1',
        [documentName],
      )
      await client.query('DELETE FROM hocuspocus_ydoc_updates WHERE doc_name = $1', [
        documentName,
      ])
      await client.query('DELETE FROM hocuspocus_ydoc_snapshots WHERE doc_name = $1', [
        documentName,
      ])
      await client.query('DELETE FROM hocuspocus_ydoc_counters WHERE doc_name = $1', [
        documentName,
      ])
    })
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

  async storeSnapshotIfMissing(
    documentName: string,
    doc: Y.Doc,
    options?: { lastSeq?: number },
  ): Promise<{ snapshotId: number; lastSeq: number } | null> {
    const lastSeq = options?.lastSeq ?? (await this.backend.latestSequence(documentName))
    const snapshot = await this.backend.insertSnapshotIfMissing({
      documentName,
      snapshotBytes: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      lastSeq,
    })
    if (!snapshot) return null
    return {
      snapshotId: snapshot.snapshotId,
      lastSeq: snapshot.lastSeq,
    }
  }

  async latestSequence(documentName: string): Promise<number> {
    return this.backend.latestSequence(documentName)
  }

  async enqueueProjectionJob(
    input: ProjectionJobInput,
  ): Promise<PersistedProjectionJob> {
    return this.backend.enqueueProjectionJob(input)
  }

  async listRetryableProjectionJobs(
    limit?: number,
  ): Promise<PersistedProjectionJob[]> {
    return this.backend.listRetryableProjectionJobs(limit)
  }

  async markProjectionJobSucceeded(id: number): Promise<void> {
    await this.backend.markProjectionJobSucceeded(id)
  }

  async markProjectionJobFailed(id: number, error: string): Promise<void> {
    await this.backend.markProjectionJobFailed(id, error)
  }

  async getSemanticOperation(
    operationId: string,
  ): Promise<PersistedSemanticOperation | null> {
    return await this.backend.getSemanticOperation(operationId)
  }

  async recordSemanticOperation(
    operationId: string,
    response: unknown,
  ): Promise<PersistedSemanticOperation> {
    return await this.backend.recordSemanticOperation(operationId, response)
  }

  async appendUpdateAndRecordSemanticOperation(input: {
    documentName: string
    update: Uint8Array
    actorId: string | null
    socketId: string | null
    operationId: string
    response: unknown
  }): Promise<AppendUpdateAndRecordSemanticOperationResult> {
    return await this.backend.appendUpdateAndRecordSemanticOperation({
      documentName: input.documentName,
      updateBytes: input.update,
      actorId: input.actorId,
      socketId: input.socketId,
      operationId: input.operationId,
      response: input.response,
    })
  }

  async deleteDocument(documentName: string): Promise<void> {
    await this.backend.deleteDocument(documentName)
  }
}

export class MemoryYDocPersistenceBackend implements YDocPersistenceBackend {
  private readonly updates = new Map<string, PersistedUpdate[]>()
  private readonly snapshots = new Map<string, PersistedSnapshot[]>()
  private readonly projectionJobs: PersistedProjectionJob[] = []
  private readonly semanticOperations = new Map<string, PersistedSemanticOperation>()
  private readonly counters = new Map<string, number>()
  private snapshotCounter = 0
  private projectionJobCounter = 0

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

  async insertSnapshotIfMissing(
    input: InsertSnapshotInput,
  ): Promise<PersistedSnapshot | null> {
    if (await this.hasDocumentState(input.documentName)) return null
    return this.insertSnapshot(input)
  }

  projectionJobsFor(documentName: string): PersistedProjectionJob[] {
    return this.projectionJobs.filter((job) => job.documentName === documentName)
  }

  async enqueueProjectionJob(
    input: ProjectionJobInput,
  ): Promise<PersistedProjectionJob> {
    const now = new Date()
    for (const job of this.projectionJobs) {
      if (
        job.documentName === input.documentName &&
        (job.status === 'pending' || job.status === 'failed')
      ) {
        job.status = 'skipped'
        job.updatedAt = now
      }
    }
    const job: PersistedProjectionJob = {
      ...input,
      lastEditedByUserId: input.lastEditedByUserId ?? null,
      id: ++this.projectionJobCounter,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    this.projectionJobs.push(job)
    return { ...job }
  }

  async listRetryableProjectionJobs(
    limit = 100,
  ): Promise<PersistedProjectionJob[]> {
    return this.projectionJobs
      .filter((job) => job.status === 'pending' || job.status === 'failed')
      .sort((left, right) => left.id - right.id)
      .slice(0, limit)
      .map((job) => ({ ...job }))
  }

  async markProjectionJobSucceeded(id: number): Promise<void> {
    const job = this.projectionJobs.find((candidate) => candidate.id === id)
    if (!job) return
    job.status = 'succeeded'
    job.updatedAt = new Date()
  }

  async markProjectionJobFailed(id: number, error: string): Promise<void> {
    const job = this.projectionJobs.find((candidate) => candidate.id === id)
    if (!job) return
    job.status = 'failed'
    job.attempts += 1
    job.lastError = error
    job.updatedAt = new Date()
  }

  async getSemanticOperation(
    operationId: string,
  ): Promise<PersistedSemanticOperation | null> {
    const operation = this.semanticOperations.get(operationId)
    return operation ? { ...operation } : null
  }

  async recordSemanticOperation(
    operationId: string,
    response: unknown,
  ): Promise<PersistedSemanticOperation> {
    const existing = this.semanticOperations.get(operationId)
    if (existing) return { ...existing }

    const operation = {
      operationId,
      response,
      createdAt: new Date(),
    }
    this.semanticOperations.set(operationId, operation)
    return { ...operation }
  }

  async appendUpdateAndRecordSemanticOperation(
    input: AppendUpdateAndRecordSemanticOperationInput,
  ): Promise<AppendUpdateAndRecordSemanticOperationResult> {
    const existing = this.semanticOperations.get(input.operationId)
    if (existing) {
      return { operation: { ...existing }, update: null, deduped: true }
    }

    const seq = (this.counters.get(input.documentName) ?? 0) + 1
    this.counters.set(input.documentName, seq)
    const update: PersistedUpdate = {
      documentName: input.documentName,
      seq,
      updateBytes: input.updateBytes,
      actorId: input.actorId,
      socketId: input.socketId,
      receivedAt: new Date(),
    }
    this.updates.set(input.documentName, [
      ...this.updatesFor(input.documentName),
      update,
    ])
    const operation = {
      operationId: input.operationId,
      response: input.response,
      createdAt: new Date(),
    }
    this.semanticOperations.set(input.operationId, operation)
    return { operation, update, deduped: false }
  }

  async deleteDocument(documentName: string): Promise<void> {
    this.updates.delete(documentName)
    this.snapshots.delete(documentName)
    this.counters.delete(documentName)
    for (let i = this.projectionJobs.length - 1; i >= 0; i -= 1) {
      if (this.projectionJobs[i]?.documentName === documentName) {
        this.projectionJobs.splice(i, 1)
      }
    }
  }
}
