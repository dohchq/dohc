/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import schema from './schema'
import { api } from './_generated/api'
import { createSqliteEngine } from '../../../services/sqlite-worker/src/sqliteEngine'

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_database_ops_concurrency'
const SQLITE_URL = 'http://sqlite-worker.local'
const SQLITE_TOKEN = 'sqlite-token'
const require = createRequire(import.meta.url)

async function sqliteBytes() {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...args: unknown[]): void }
      close(): void
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'dohc-db-concurrency-'))
  const file = join(dir, 'ledger.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY, merchant TEXT, amount REAL)')
    db.prepare('INSERT INTO transactions (id, merchant, amount) VALUES (?, ?, ?)').run('txn_001', 'Grab', 420)
    db.close()
    return await readFile(file)
  } finally {
    try {
      db.close()
    } catch {}
    await rm(dir, { recursive: true, force: true })
  }
}

async function stubSqliteWorker() {
  const engine = await createSqliteEngine()
  vi.stubEnv('SQLITE_WORKER_URL', SQLITE_URL)
  vi.stubEnv('SQLITE_WORKER_TOKEN', SQLITE_TOKEN)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (String(url) === `${SQLITE_URL}/ingest`) {
      return new Response(JSON.stringify(await engine.ingest({ bytesBase64: String(body.bytesBase64 ?? '') })), { status: 200 })
    }
    if (String(url) === `${SQLITE_URL}/materialize`) {
      return new Response(JSON.stringify(await engine.materialize({ snapshot: body.snapshot as never })), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected-url' }), { status: 404 })
  }))
}

async function seedDatabase(t: ReturnType<typeof convexTest>) {
  await stubSqliteWorker()
  const bytes = await sqliteBytes()
  const storageId = await t.run(async (ctx) =>
    await ctx.storage.store(new Blob([bytes])),
  )
  await t.run(async (ctx) => {
    const metadata = await ctx.db.system.get('_storage', storageId)
    await ctx.db.insert('workspaceAssets', {
      workspaceId: W,
      storageId,
      filename: 'ledger.sqlite',
      mediaType: 'application/vnd.sqlite3',
      kind: 'file',
      size: metadata?.size ?? 0,
      sha256: metadata?.sha256,
      purpose: 'workspace',
      createdByUserId: W,
      createdAt: Date.now(),
    })
  })
  await t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
    path: 'finance/ledger.sqlite',
    storageId,
    filename: 'ledger.sqlite',
    size: 32,
    mediaType: 'application/vnd.sqlite3',
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('databaseOps concurrency', () => {
  it('serializes row writes by version and returns a conflict for stale concurrent attempts', async () => {
    const t = convexTest(schema, modules)
    await seedDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'first-writer',
        expectedVersion: 1,
        op: 'update',
        table: 'transactions',
        rowId: 'txn_001',
        payload: { amount: 430 },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2 })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'stale-writer',
        expectedVersion: 1,
        op: 'update',
        table: 'transactions',
        rowId: 'txn_001',
        payload: { amount: 440 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'database-version-conflict',
      currentVersion: 2,
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'finance/ledger.sqlite',
        sql: 'select * from transactions where id = ?',
        params: ['txn_001'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ amount: 430 })],
    })
  })
})
