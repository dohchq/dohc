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
const W = 'ws_database_ops'
const BOB = 'ws_database_ops_bob'
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
  const dir = await mkdtemp(join(tmpdir(), 'dohc-db-ops-'))
  const file = join(dir, 'ledger.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY, merchant TEXT, amount REAL, reviewed INTEGER)')
    db.prepare('INSERT INTO transactions (id, merchant, amount, reviewed) VALUES (?, ?, ?, ?)').run('tx_1', 'Grab', 420, 0)
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

async function seedTrackerApp(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  databaseWrite = true,
) {
  await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/tracker/app.json',
    JSON.stringify({
      title: 'Finance Tracker',
      read: ['ledger.sqlite'],
      write: databaseWrite ? ['ledger.sqlite'] : [],
      collections: {
        transactions: {
          source: 'ledger.sqlite',
          write: databaseWrite ? 'ledger.sqlite' : [],
          format: 'sqlite',
          table: 'transactions',
          key: 'id',
        },
      },
      databases: {
        ledger: { path: 'ledger.sqlite', write: databaseWrite },
      },
    }),
  )
}

async function seedDatabase(t: ReturnType<typeof convexTest>) {
  await stubSqliteWorker()
  const bytes = await sqliteBytes()
  const storageId = await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([bytes]))
  })
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
    size: 20,
    mediaType: 'application/vnd.sqlite3',
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('databaseOps', () => {
  it('applies row operations transactionally and records operation history', async () => {
    const t = convexTest(schema, modules)
    await seedDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_insert',
        expectedVersion: 1,
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_2',
        payload: { id: 'tx_2', merchant: 'Cafe', amount: 250, reviewed: false },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2 })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_update',
        expectedVersion: 2,
        op: 'update',
        table: 'transactions',
        rowId: 'tx_2',
        payload: { reviewed: true },
      }),
    ).resolves.toMatchObject({ ok: true, version: 3 })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'finance/ledger.sqlite',
        sql: 'select * from transactions where id = ?',
        params: ['tx_2'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'tx_2', merchant: 'Cafe', reviewed: true })],
    })

    const history = await t.withIdentity({ subject: W }).query(api.databaseOps.list, {
      databasePath: 'finance/ledger.sqlite',
    })
    expect(history).toMatchObject({
      ok: true,
      ops: [
        expect.objectContaining({
          operationId: 'op_insert',
          actorUserId: W,
          op: 'insert',
          table: 'transactions',
          rowId: 'tx_2',
          version: 2,
        }),
        expect.objectContaining({
          operationId: 'op_update',
          payload: { reviewed: true },
          version: 3,
        }),
      ],
    })
  })

  it('keeps row operations canonical in structured snapshots and never mirrors raw SQLite bytes into atoms', async () => {
    const t = convexTest(schema, modules)
    await seedDatabase(t)
    const before = await t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
      path: 'finance/ledger.sqlite',
    })
    expect(before).toMatchObject({
      ok: true,
      database: { version: 1, canonicalFormat: 'structured-snapshot' },
    })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_no_raw_crdt',
        expectedVersion: 1,
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_2',
        payload: { id: 'tx_2', merchant: 'Cafe', amount: 250, reviewed: false },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2 })

    const after = await t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
      path: 'finance/ledger.sqlite',
    })
    expect(after).toMatchObject({
      ok: true,
      database: { version: 2, canonicalFormat: 'structured-snapshot', bytesOutOfDate: true },
    })
    if (before.ok && after.ok) {
      expect(after.database.storageId).toBe(before.database.storageId)
      expect(after.database.tables).not.toEqual(before.database.tables)
    }
    const atom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'finance/ledger.sqlite'),
        )
        .unique(),
    )
    expect(atom).toBeNull()

    const exported = await t.withIdentity({ subject: W }).action(api.databaseFiles.materialize, {
      path: 'finance/ledger.sqlite',
    })
    expect(exported).toMatchObject({ ok: true, path: 'finance/ledger.sqlite', version: 2 })
    const materialized = await t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
      path: 'finance/ledger.sqlite',
    })
    expect(materialized).toMatchObject({
      ok: true,
      database: { version: 2, bytesOutOfDate: false },
    })
    if (after.ok && materialized.ok) {
      expect(materialized.database.storageId).not.toBe(after.database.storageId)
    }
  })

  it('rejects duplicate rows and leaves the previous database version intact', async () => {
    const t = convexTest(schema, modules)
    await seedDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_dup',
        expectedVersion: 1,
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_1',
        payload: { id: 'tx_1', merchant: 'Duplicate' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-row-conflict' })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
        path: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({ ok: true, database: { version: 1 } })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseOps.list, {
        databasePath: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({ ok: true, ops: [] })
  })

  it('rejects stale database versions before mutating rows', async () => {
    const t = convexTest(schema, modules)
    await seedDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_conflict',
        expectedVersion: 0,
        op: 'delete',
        table: 'transactions',
        rowId: 'tx_1',
        payload: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'database-version-conflict',
      currentVersion: 1,
    })
  })

  it('treats operation ids as idempotency keys', async () => {
    const t = convexTest(schema, modules)
    await seedDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_retry_once',
        expectedVersion: 1,
        op: 'update',
        table: 'transactions',
        rowId: 'tx_1',
        payload: { reviewed: true },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2 })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_retry_once',
        expectedVersion: 1,
        op: 'update',
        table: 'transactions',
        rowId: 'tx_1',
        payload: { reviewed: true },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2, idempotent: true })

    const history = await t.withIdentity({ subject: W }).query(api.databaseOps.list, {
      databasePath: 'finance/ledger.sqlite',
    })
    expect(history).toMatchObject({
      ok: true,
      ops: [expect.objectContaining({ operationId: 'op_retry_once', version: 2 })],
    })
  })

  it('rejects row payload fields outside the declared table schema', async () => {
    const t = convexTest(schema, modules)
    await seedDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.apply, {
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_unknown_column',
        expectedVersion: 1,
        op: 'update',
        table: 'transactions',
        rowId: 'tx_1',
        payload: { __not_a_column: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-column-not-found' })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
        path: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({ ok: true, database: { version: 1 } })
  })

  it('requires manifest database write grants and per-user trust for app row operations', async () => {
    const t = convexTest(schema, modules)
    await seedTrackerApp(t, W)
    await seedDatabase(t)

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'app_untrusted',
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_2',
        payload: { id: 'tx_2', merchant: 'Cafe', amount: 250, reviewed: false },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'app-trust-required' })

    await t.withIdentity({ subject: W }).mutation(api.appTrust.grant, {
      packageRoot: 'finance/.apps/tracker',
    })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'app_insert',
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_2',
        payload: { id: 'tx_2', merchant: 'Cafe', amount: 250, reviewed: false },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2 })

    const history = await t.withIdentity({ subject: W }).query(api.databaseOps.list, {
      databasePath: 'finance/ledger.sqlite',
    })
    expect(history).toMatchObject({
      ok: true,
      ops: [expect.objectContaining({ operationId: 'app_insert', actorUserId: W })],
    })

    await seedTrackerApp(t, BOB, false)
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'app_denied',
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_denied',
        payload: { id: 'tx_denied' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-write-not-granted' })
  })

  it('refuses database row operations when the database file is locked or review-gated', async () => {
    const t = convexTest(schema, modules)
    await seedTrackerApp(t, W)
    await seedDatabase(t)
    await t.withIdentity({ subject: W }).mutation(api.appTrust.grant, {
      packageRoot: 'finance/.apps/tracker',
    })
    await t.run(async (ctx) => {
      const database = await ctx.db
        .query('databaseFiles')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'finance/ledger.sqlite'),
        )
        .unique()
      await ctx.db.patch(database!._id, { userLocked: true })
    })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'locked-db-write',
        expectedVersion: 1,
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_locked',
        payload: { id: 'tx_locked', merchant: 'Locked' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-locked' })

    await t.run(async (ctx) => {
      const database = await ctx.db
        .query('databaseFiles')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'finance/ledger.sqlite'),
        )
        .unique()
      await ctx.db.patch(database!._id, { userLocked: false, reviewRequired: true })
    })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'review-db-write',
        expectedVersion: 1,
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_review',
        payload: { id: 'tx_review', merchant: 'Review' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-review-required' })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.get, {
        path: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({ ok: true, database: { version: 1 } })
    await expect(
      t.withIdentity({ subject: W }).query(api.databaseOps.list, {
        databasePath: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({ ok: true, ops: [] })
  })
})
