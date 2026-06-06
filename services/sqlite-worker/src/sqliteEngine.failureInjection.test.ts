import { describe, expect, it } from 'vitest'
import { createSqliteEngine } from './sqliteEngine'

const snapshot = {
  transactions: {
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true },
      { name: 'merchant', type: 'TEXT' },
    ],
    rows: [{ id: 'txn_001', merchant: 'Grab' }],
  },
}

describe('sqlite engine failure injection', () => {
  it('rejects invalid SQLite operations without changing the old snapshot version', async () => {
    const engine = await createSqliteEngine()

    await expect(engine.query({
      snapshot,
      sql: 'delete from transactions',
    })).resolves.toMatchObject({ ok: false, code: 'unsupported-sql' })

    await expect(engine.apply({
      snapshot,
      version: 1,
      expectedVersion: 1,
      operationId: 'bad-table',
      op: 'insert',
      table: 'missing',
      rowId: 'txn_002',
      payload: { id: 'txn_002' },
    })).resolves.toMatchObject({ ok: false, code: 'table-not-found', version: 1 })

    await expect(engine.apply({
      snapshot,
      version: 1,
      expectedVersion: 1,
      operationId: 'duplicate',
      op: 'insert',
      table: 'transactions',
      rowId: 'txn_001',
      payload: { id: 'txn_001', merchant: 'Duplicate' },
    })).resolves.toMatchObject({ ok: false, code: 'database-row-conflict', version: 1 })
  })
})
