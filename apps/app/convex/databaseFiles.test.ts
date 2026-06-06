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
const W = 'ws_database_files'
const SQLITE_URL = 'http://sqlite-worker.local'
const SQLITE_TOKEN = 'sqlite-token'

const require = createRequire(import.meta.url)

async function sqliteBytes(rows = [{ id: 'tx_1', merchant: 'Grab', amount: 420, reviewed: 0 }]) {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...args: unknown[]): void }
      close(): void
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'dohc-db-files-'))
  const file = join(dir, 'ledger.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY, merchant TEXT, amount REAL, reviewed INTEGER)')
    const insert = db.prepare('INSERT INTO transactions (id, merchant, amount, reviewed) VALUES (?, ?, ?, ?)')
    for (const row of rows) insert.run(row.id, row.merchant, row.amount, row.reviewed)
    db.close()
    return await readFile(file)
  } finally {
    try {
      db.close()
    } catch {}
    await rm(dir, { recursive: true, force: true })
  }
}

async function storeSqliteBlob(t: ReturnType<typeof convexTest>, workspaceId = W) {
  const bytes = await sqliteBytes()
  const storageId = await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([bytes]))
  })
  await registerSqliteAsset(t, workspaceId, storageId)
  return storageId
}

async function registerSqliteAsset(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  storageId: string,
  createdByUserId = workspaceId,
) {
  await t.run(async (ctx) => {
    const metadata = await ctx.db.system.get('_storage', storageId as never)
    await ctx.db.insert('workspaceAssets', {
      workspaceId,
      storageId: storageId as never,
      filename: 'ledger.sqlite',
      mediaType: 'application/vnd.sqlite3',
      kind: 'file',
      size: metadata?.size ?? 0,
      sha256: metadata?.sha256,
      purpose: 'workspace',
      createdByUserId,
      createdAt: Date.now(),
    })
  })
}

async function stubSqliteWorker() {
  const engine = await createSqliteEngine()
  vi.stubEnv('SQLITE_WORKER_URL', SQLITE_URL)
  vi.stubEnv('SQLITE_WORKER_TOKEN', SQLITE_TOKEN)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${SQLITE_TOKEN}`,
      'content-type': 'application/json',
    })
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

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '',
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId, path, body, updatedAt: Date.now() })
  })
}

async function seedTrackerApp(t: ReturnType<typeof convexTest>, workspaceId: string) {
  await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/tracker/app.json',
    JSON.stringify({
      title: 'Finance Tracker',
      read: ['ledger.sqlite'],
      write: ['ledger.sqlite'],
      collections: {
        transactions: {
          source: 'ledger.sqlite',
          write: 'ledger.sqlite',
          format: 'sqlite',
          table: 'transactions',
          key: 'id',
        },
      },
      databases: {
        ledger: { path: 'ledger.sqlite', write: true },
      },
    }),
  )
}

async function seedLedgerDatabase(t: ReturnType<typeof convexTest>, workspaceId = W) {
  const storageId = await storeSqliteBlob(t, workspaceId)
  await t.withIdentity({ subject: workspaceId }).action(api.databaseFiles.create, {
    path: 'finance/ledger.sqlite',
    storageId,
    filename: 'ledger.sqlite',
    size: 20,
    mediaType: 'application/vnd.sqlite3',
    activeWorkspaceId: workspaceId,
  })
}

const ledgerTables = {
  transactions: {
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true },
      { name: 'merchant', type: 'TEXT' },
      { name: 'amount', type: 'REAL' },
      { name: 'reviewed', type: 'INTEGER' },
    ],
    rows: [
      { id: 'tx_1', merchant: 'Grab', amount: 420, reviewed: false },
    ],
  },
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('databaseFiles', () => {
  it('creates and lists first-class SQLite database files outside atom bodies', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    const storageId = await storeSqliteBlob(t)

    const created = await t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
      path: 'finance/ledger.sqlite',
      storageId,
      filename: 'ledger.sqlite',
      size: 20,
      mediaType: 'application/vnd.sqlite3',
    })

    expect(created).toMatchObject({
      ok: true,
      path: 'finance/ledger.sqlite',
      version: 1,
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
        path: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({
      ok: true,
      database: {
        path: 'finance/ledger.sqlite',
        filename: 'ledger.sqlite',
        version: 1,
      },
    })

    const tables = await t.withIdentity({ subject: W }).query(api.databaseFiles.tables, {
      path: 'finance/ledger.sqlite',
    })
    expect(tables).toMatchObject({
      ok: true,
      tables: [expect.objectContaining({ name: 'transactions' })],
    })
    expect(tables.ok && tables.tables[0]?.columns).toEqual([
      expect.objectContaining({ name: 'id', type: 'TEXT', primaryKey: true }),
      expect.objectContaining({ name: 'merchant', type: 'TEXT' }),
      expect.objectContaining({ name: 'amount', type: 'REAL' }),
      expect.objectContaining({ name: 'reviewed', type: 'INTEGER' }),
    ])

    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'finance/ledger.sqlite'),
        )
        .unique(),
    )
    expect(atom).toBeNull()
  })

  it('rejects invalid SQLite uploads with a stable diagnostic', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(['not sqlite']))
    })
    await registerSqliteAsset(t, W, storageId)

    await expect(
      t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
        path: 'finance/ledger.txt',
        storageId,
        filename: 'ledger.txt',
        size: 10,
        mediaType: 'text/plain',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'invalid-sqlite-file',
    })
  })

  it('runs read-only SQL over the structured database snapshot', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    const storageId = await storeSqliteBlob(t)
    await t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
      path: 'finance/ledger.sqlite',
      storageId,
      filename: 'ledger.sqlite',
      size: 20,
      mediaType: 'application/x-sqlite3',
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'finance/ledger.sqlite',
        sql: 'select * from transactions where id = ?',
        params: ['tx_1'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'tx_1', merchant: 'Grab', amount: 420 })],
    })
  })

  it('only exposes database reads to apps that declare the database in app.json', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    await seedTrackerApp(t, W)
    await seedLedgerDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.appQuery, {
        packageRoot: 'finance/.apps/tracker',
        path: 'ledger.sqlite',
        sql: 'select * from transactions where id = ?',
        params: ['tx_1'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'tx_1', merchant: 'Grab' })],
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.appQuery, {
        packageRoot: 'finance/.apps/tracker',
        path: 'private.sqlite',
        sql: 'select * from transactions',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'database-read-not-granted',
    })
  })

  it('fails app database reads closed when descriptor resolution would use a capped partial scan', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'finance/.apps/tracker/src/App.tsx', 'app')
    for (let index = 0; index < 5001; index += 1) {
      await seedAtom(t, W, `archive/${String(index).padStart(4, '0')}.md`, '# Archive')
    }
    await seedAtom(
      t,
      W,
      'finance/.apps/tracker/app.json',
      JSON.stringify({
        title: 'Finance Tracker',
        read: ['ledger.sqlite'],
        write: ['ledger.sqlite'],
        databases: { ledger: { path: 'ledger.sqlite', write: true } },
      }),
    )

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.appQuery, {
        packageRoot: 'finance/.apps/tracker',
        path: 'ledger.sqlite',
        sql: 'select * from transactions',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'source-scan-truncated',
    })
  })

  it('reads SQLite-backed collection rows through the app manifest', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    await seedTrackerApp(t, W)
    await seedLedgerDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.appCollectionRows, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        collection: 'transactions',
        query: { where: { reviewed: 0 } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'tx_1', merchant: 'Grab' })],
    })
  })

  it('derives tables from real SQLite bytes and ignores caller-supplied snapshots', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    const storageId = await storeSqliteBlob(t)

    await expect(
      t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
        path: 'finance/ledger.sqlite',
        storageId,
        filename: 'ledger.sqlite',
        size: 20,
        mediaType: 'application/vnd.sqlite3',
        tables: {
          fake: {
            columns: [{ name: 'id', type: 'TEXT', primaryKey: true }],
            rows: [{ id: 'fabricated' }],
          },
        },
      } as never),
    ).resolves.toMatchObject({ ok: true })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.tables, {
        path: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({
      ok: true,
      tables: [expect.objectContaining({ name: 'transactions' })],
    })
    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'finance/ledger.sqlite',
        sql: 'select * from fake',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'table-not-found' })
  })

  it('rejects storage blobs that are not registered to the caller workspace', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    const bytes = await sqliteBytes()
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob([bytes]))
    })
    await registerSqliteAsset(t, 'ws_database_files_owner', storageId, 'ws_database_files_owner')

    await expect(
      t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
        activeWorkspaceId: W,
        path: 'finance/ledger.sqlite',
        storageId,
        filename: 'ledger.sqlite',
        size: 20,
        mediaType: 'application/vnd.sqlite3',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'database-storage-not-authorized',
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
        path: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-not-found' })
  })

  it('rejects header-only SQLite-looking junk bytes', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    const storageId = await t.run(async (ctx) =>
      await ctx.storage.store(new Blob(['SQLite format 3\0junk'])),
    )
    await registerSqliteAsset(t, W, storageId)

    await expect(
      t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
        path: 'finance/junk.sqlite',
        storageId,
        filename: 'junk.sqlite',
        size: 22,
        mediaType: 'application/vnd.sqlite3',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-sqlite-file' })
  })

  it('rejects unsafe database paths before folder ACL checks', async () => {
    const t = convexTest(schema, modules)
    await stubSqliteWorker()
    const storageId = await storeSqliteBlob(t)

    for (const path of [
      '/ledger.sqlite',
      '../ledger.sqlite',
      'finance//ledger.sqlite',
      'finance/./ledger.sqlite',
      'finance\\ledger.sqlite',
      'finance/\u0000/ledger.sqlite',
    ]) {
      await expect(
        t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
          path,
          storageId,
          filename: 'ledger.sqlite',
          size: 20,
          mediaType: 'application/vnd.sqlite3',
        }),
      ).resolves.toMatchObject({ ok: false, code: 'invalid-path' })
    }
  })
})
