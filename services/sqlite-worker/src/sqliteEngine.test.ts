import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createSqliteWorkerHandler } from './server'
import { createSqliteEngine } from './sqliteEngine'

const require = createRequire(import.meta.url)

async function realLedgerBytes() {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...args: unknown[]): void }
      close(): void
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'dohc-sqlite-test-'))
  const file = join(dir, 'ledger.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY, merchant TEXT, amount REAL, reviewed INTEGER)')
    db.prepare('INSERT INTO transactions (id, merchant, amount, reviewed) VALUES (?, ?, ?, ?)').run('tx_1', 'Grab', 420, 0)
    db.prepare('INSERT INTO transactions (id, merchant, amount, reviewed) VALUES (?, ?, ?, ?)').run('tx_2', 'Cafe', 250, 1)
    db.close()
    return await readFile(file)
  } finally {
    try {
      db.close()
    } catch {}
    await rm(dir, { recursive: true, force: true })
  }
}

const ledgerSnapshot = {
  transactions: {
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true },
      { name: 'merchant', type: 'TEXT' },
      { name: 'category', type: 'TEXT' },
      { name: 'amount', type: 'REAL' },
      { name: 'reviewed', type: 'INTEGER' },
    ],
    rows: [
      { id: 'tx_1', merchant: 'Grab', category: 'Transport', amount: 420, reviewed: 0 },
      { id: 'tx_2', merchant: 'Cafe', category: 'Food', amount: 250, reviewed: 1 },
    ],
  },
}

describe('sqlite worker engine', () => {
  it('serves a preflight response from the worker handler', async () => {
    const handler = createSqliteWorkerHandler({
      engine: await createSqliteEngine(),
      allowInsecureLocal: true,
    })

    const response = await handler(new Request('http://localhost/preflight'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'dohc-sqlite-worker',
      sqlite: true,
    })
  })

  it('fails closed without a token unless explicit local insecure mode is enabled', async () => {
    const handler = createSqliteWorkerHandler({ engine: await createSqliteEngine() })

    const response = await handler(new Request('http://localhost/preflight'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'unauthorized' })
  })

  it('runs read-only SQL and rejects mutating SQL', async () => {
    const engine = await createSqliteEngine()

    await expect(
      engine.query({
        snapshot: ledgerSnapshot,
        sql: 'select * from transactions where category = ? order by amount desc limit 1',
        params: ['Transport'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'tx_1', merchant: 'Grab', amount: 420 })],
    })

    await expect(
      engine.query({
        snapshot: ledgerSnapshot,
        sql: 'delete from transactions',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'unsupported-sql',
    })
  })

  it('ingests real SQLite bytes into a server-derived snapshot and rejects header-only junk', async () => {
    const engine = await createSqliteEngine()
    const ingested = await engine.ingest({ bytesBase64: (await realLedgerBytes()).toString('base64') })

    expect(ingested).toMatchObject({
      ok: true,
      snapshot: {
        transactions: {
          columns: expect.arrayContaining([
            expect.objectContaining({ name: 'id', primaryKey: true }),
            expect.objectContaining({ name: 'merchant', type: 'TEXT' }),
          ]),
          rows: [
            expect.objectContaining({ id: 'tx_1', merchant: 'Grab', amount: 420 }),
            expect.objectContaining({ id: 'tx_2', merchant: 'Cafe', amount: 250 }),
          ],
        },
      },
    })

    await expect(
      engine.ingest({ bytesBase64: Buffer.from('SQLite format 3\0junk').toString('base64') }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'invalid-sqlite-file',
    })
  })

  it('materializes mutated snapshots back into SQLite bytes', async () => {
    const engine = await createSqliteEngine()
    const materialized = await engine.materialize({ snapshot: ledgerSnapshot })

    expect(materialized).toMatchObject({
      ok: true,
      bytesBase64: expect.any(String),
    })
    const reingested = materialized.ok
      ? await engine.ingest({ bytesBase64: materialized.bytesBase64 })
      : materialized
    expect(reingested).toMatchObject({
      ok: true,
      snapshot: {
        transactions: {
          rows: [
            expect.objectContaining({ id: 'tx_1', merchant: 'Grab' }),
            expect.objectContaining({ id: 'tx_2', merchant: 'Cafe' }),
          ],
        },
      },
    })
  })

  it('applies row operations transactionally and reports version conflicts', async () => {
    const engine = await createSqliteEngine()

    const inserted = await engine.apply({
      snapshot: ledgerSnapshot,
      version: 1,
      expectedVersion: 1,
      operationId: 'op_insert',
      op: 'insert',
      table: 'transactions',
      rowId: 'tx_3',
      payload: { id: 'tx_3', merchant: 'Bookstore', category: 'Learning', amount: 900, reviewed: 0 },
    })

    expect(inserted).toMatchObject({
      ok: true,
      version: 2,
      operation: { operationId: 'op_insert', table: 'transactions', rowId: 'tx_3' },
    })
    expect(inserted.ok && inserted.snapshot.transactions.rows).toEqual([
      expect.objectContaining({ id: 'tx_1' }),
      expect.objectContaining({ id: 'tx_2' }),
      expect.objectContaining({ id: 'tx_3', merchant: 'Bookstore' }),
    ])

    await expect(
      engine.apply({
        snapshot: inserted.ok ? inserted.snapshot : ledgerSnapshot,
        version: inserted.ok ? inserted.version : 1,
        expectedVersion: 1,
        operationId: 'op_stale',
        op: 'update',
        table: 'transactions',
        rowId: 'tx_3',
        payload: { reviewed: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'database-version-conflict',
      currentVersion: 2,
    })

    await expect(
      engine.apply({
        snapshot: ledgerSnapshot,
        version: 1,
        expectedVersion: 1,
        operationId: 'op_duplicate',
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_1',
        payload: { id: 'tx_1', merchant: 'Duplicate' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'database-row-conflict',
      version: 1,
    })
  })

  it('rebuilds text-backed collection indexes without returning raw SQLite bytes', async () => {
    const engine = await createSqliteEngine()
    const rebuilt = await engine.rebuildIndex({
      indexId: 'finance.transactions',
      rows: [
        { id: 'txn_001', Merchant: 'Grab', Category: 'Transport', Amount: 420, sourcePath: 'finance/transactions.md' },
        { id: 'txn_002', Merchant: 'Cafe', Category: 'Food', Amount: 250, sourcePath: 'finance/transactions.md' },
      ],
    })

    expect(rebuilt).toMatchObject({
      ok: true,
      index: {
        indexId: 'finance.transactions',
        rowCount: 2,
        columns: expect.arrayContaining(['id', 'Merchant', 'Category', 'Amount', 'sourcePath']),
      },
    })
    expect(JSON.stringify(rebuilt)).not.toContain('SQLite format 3')
    expect(rebuilt.ok && 'rawBytes' in rebuilt.index).toBe(false)

    await expect(
      rebuilt.ok
        ? engine.queryIndex(rebuilt.index, {
            where: { Category: 'Transport' },
            orderBy: [{ field: 'Amount', direction: 'desc' }],
            limit: 1,
          })
        : Promise.resolve(rebuilt),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'txn_001', Merchant: 'Grab' })],
    })
  })
})
