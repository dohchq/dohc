import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeDocName } from '../doc-name.js'
import { markdownToYDoc, yDocToMarkdown } from '../import-export.js'
import {
  ensureYDocPersistenceSchema,
  PostgresYDocPersistenceBackend,
  PostgresYDocStore,
} from '../persistence.js'
import {
  createSemanticApiHandler,
  semanticOperationKey,
} from '../semantic-api.js'
import { createAnchorsForText } from '../suggestions.js'

const { Pool } = pg

const databaseUrl = process.env.HOCUSPOCUS_TEST_DATABASE_URL ?? ''
const adminToken = 'integration-admin-token'

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('HOCUSPOCUS_TEST_DATABASE_URL is required')
  }
  return databaseUrl
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

describe.sequential('semantic API Postgres persistence', () => {
  const pool = new Pool({ connectionString: requireDatabaseUrl() })
  const documentNames: string[] = []
  const operationKeys: string[] = []

  beforeAll(async () => {
    await ensureYDocPersistenceSchema(pool)
  })

  afterAll(async () => {
    for (const key of operationKeys) {
      await pool.query(
        'DELETE FROM hocuspocus_semantic_operations WHERE operation_id = $1',
        [key],
      )
    }
    for (const documentName of documentNames) {
      await pool.query('DELETE FROM hocuspocus_ydoc_snapshots WHERE doc_name = $1', [
        documentName,
      ])
      await pool.query('DELETE FROM hocuspocus_ydoc_updates WHERE doc_name = $1', [
        documentName,
      ])
      await pool.query('DELETE FROM hocuspocus_ydoc_counters WHERE doc_name = $1', [
        documentName,
      ])
    }
    await pool.end()
  })

  it('records idempotent semantic operation keys in Postgres', async () => {
    const workspaceId = uniqueId('workspace')
    const atomId = uniqueId('atom')
    const operationId = 'op:replace/1'
    const documentName = encodeDocName({ workspaceId, atomId })
    const operationKey = semanticOperationKey(documentName, operationId)
    documentNames.push(documentName)
    operationKeys.push(operationKey)

    const store = new PostgresYDocStore(new PostgresYDocPersistenceBackend(pool))
    const doc = markdownToYDoc(`---\nid: ${atomId}\n---\nHello world.`)
    const anchors = createAnchorsForText(doc, 'world')
    expect(anchors).not.toBeNull()
    await store.storeSnapshot(documentName, doc, { lastSeq: 0 })

    const handler = createSemanticApiHandler({
      adminToken,
      acl: {
        getWorkspaceAuthzVersion: async () => 1,
        canReadAtom: async () => true,
        canWriteAtom: async () => true,
      },
      store,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })

    const body = {
      operationId,
      workspaceId,
      atomId,
      actor: {
        userId: 'agent_1',
        actorKind: 'agent',
        authzVersion: 1,
      },
      anchorStart: anchors!.anchorStart,
      anchorEnd: anchors!.anchorEnd,
      replacement: 'earth',
      expectedText: 'world',
    }
    const request = () =>
      new Request('http://localhost/apply/replaceRange', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })

    const first = await handler(request())
    const second = await handler(request())

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      ok: true,
      operationId,
      deduped: true,
    })
    await expect(store.loadDocument(documentName).then(yDocToMarkdown)).resolves.toContain(
      'Hello earth.',
    )
    const recorded = await pool.query<{ operation_id: string }>(
      'SELECT operation_id FROM hocuspocus_semantic_operations WHERE operation_id = $1',
      [operationKey],
    )
    expect(recorded.rows[0]?.operation_id).toBe(operationKey)
  })
})
