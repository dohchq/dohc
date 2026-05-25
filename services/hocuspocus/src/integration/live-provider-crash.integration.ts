import { setTimeout as delay } from 'node:timers/promises'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { Server } from '@hocuspocus/server'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { mintCollabToken } from '../auth'
import { encodeDocName } from '../doc-name'
import { ensureYDocPersistenceSchema } from '../persistence'
import { createServerFromEnv } from '../server'

const { Pool } = pg

const databaseUrl = process.env.HOCUSPOCUS_TEST_DATABASE_URL ?? ''
const jwtSecret = 'integration-secret-with-enough-entropy-for-hs256'
const adminToken = 'integration-admin-token'

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('HOCUSPOCUS_TEST_DATABASE_URL is required')
  }
  return databaseUrl
}

async function startServer(): Promise<Server> {
  process.env.HOCUSPOCUS_DATABASE_URL = requireDatabaseUrl()
  process.env.HOCUSPOCUS_JWT_SECRET = jwtSecret
  process.env.HOCUSPOCUS_ADMIN_TOKEN = adminToken
  process.env.HOCUSPOCUS_ALLOW_DEV_ACL = 'true'
  process.env.HOCUSPOCUS_QUIET = 'true'
  process.env.HOCUSPOCUS_PORT = '0'

  const server = await createServerFromEnv()
  await server.listen()
  return server
}

async function tokenFor(workspaceId: string, userId = 'user_1'): Promise<string> {
  return mintCollabToken(
    {
      sub: userId,
      ws: workspaceId,
      actorKind: 'user',
      authzVersion: 1,
    },
    jwtSecret,
  )
}

function createProvider(input: {
  server: Server
  documentName: string
  token: string
  doc: Y.Doc
}): HocuspocusProvider {
  return new HocuspocusProvider({
    url: input.server.webSocketURL,
    name: input.documentName,
    document: input.doc,
    token: input.token,
    forceSyncInterval: false,
  })
}

async function waitForCondition(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 7_500,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForProviderSynced(provider: HocuspocusProvider): Promise<void> {
  await waitForCondition('provider synced', () => provider.synced)
}

function waitForProviderClose(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for provider close')),
      7_500,
    )
    provider.on('close', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function countUpdates(pool: pg.Pool, documentName: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) FROM hocuspocus_ydoc_updates WHERE doc_name = $1',
    [documentName],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function cleanupDocument(pool: pg.Pool, documentName: string): Promise<void> {
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

describe.sequential('live Hocuspocus provider persistence', () => {
  const pool = new Pool({ connectionString: requireDatabaseUrl() })
  const documentNames: string[] = []

  beforeAll(async () => {
    await ensureYDocPersistenceSchema(pool)
  })

  afterAll(async () => {
    for (const documentName of documentNames) {
      await cleanupDocument(pool, documentName)
    }
    await pool.end()
  })

  it('survives a server restart by replaying Postgres updates', async () => {
    const workspaceId = uniqueId('workspace')
    const documentName = encodeDocName({
      workspaceId,
      atomId: uniqueId('atom'),
    })
    documentNames.push(documentName)
    await cleanupDocument(pool, documentName)

    let server = await startServer()
    const token = await tokenFor(workspaceId)
    const textValue = 'survives restart from the append log'

    try {
      const doc = new Y.Doc()
      const provider = createProvider({ server, documentName, token, doc })
      try {
        await waitForProviderSynced(provider)
        doc.getText('body').insert(0, textValue)
        await waitForCondition('provider update ack', () => !provider.hasUnsyncedChanges)
        await waitForCondition(
          'persisted update row',
          async () => (await countUpdates(pool, documentName)) > 0,
        )
      } finally {
        provider.destroy()
      }

      await server.destroy()
      server = await startServer()

      const reloadedDoc = new Y.Doc()
      const reloadedProvider = createProvider({
        server,
        documentName,
        token,
        doc: reloadedDoc,
      })
      try {
        await waitForProviderSynced(reloadedProvider)
        await waitForCondition(
          'replayed document text',
          () => reloadedDoc.getText('body').toString() === textValue,
        )
        expect(reloadedDoc.getText('body').toString()).toBe(textValue)
      } finally {
        reloadedProvider.destroy()
      }
    } finally {
      await server.destroy()
    }
  })

  it('fails loud when Postgres cannot append accepted writes', async () => {
    const workspaceId = uniqueId('workspace')
    const documentName = encodeDocName({
      workspaceId,
      atomId: uniqueId('atom'),
    })
    documentNames.push(documentName)
    await cleanupDocument(pool, documentName)
    await pool.query('DROP TABLE IF EXISTS hocuspocus_ydoc_updates_broken')

    const server = await startServer()
    const token = await tokenFor(workspaceId)
    const doc = new Y.Doc()
    const provider = createProvider({ server, documentName, token, doc })

    try {
      await waitForProviderSynced(provider)
      await pool.query(
        'ALTER TABLE hocuspocus_ydoc_updates RENAME TO hocuspocus_ydoc_updates_broken',
      )

      const closePromise = waitForProviderClose(provider)
      doc.getText('body').insert(0, 'must not be acked')

      await closePromise
      expect(provider.hasUnsyncedChanges).toBe(true)
    } finally {
      provider.destroy()
      await pool.query(
        'ALTER TABLE IF EXISTS hocuspocus_ydoc_updates_broken RENAME TO hocuspocus_ydoc_updates',
      )
      expect(await countUpdates(pool, documentName)).toBe(0)
      await server.destroy()
    }
  })
})
