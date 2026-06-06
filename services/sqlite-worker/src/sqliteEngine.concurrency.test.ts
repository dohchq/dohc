import { describe, expect, it } from 'vitest'
import { createSqliteEngine } from './sqliteEngine'

const snapshot = {
  transactions: {
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true },
      { name: 'amount', type: 'REAL' },
    ],
    rows: [{ id: 'txn_001', amount: 420 }],
  },
}

describe('sqlite engine concurrency', () => {
  it('returns version conflicts for stale concurrent row operations', async () => {
    const engine = await createSqliteEngine()
    const first = await engine.apply({
      snapshot,
      version: 1,
      expectedVersion: 1,
      operationId: 'first',
      op: 'update',
      table: 'transactions',
      rowId: 'txn_001',
      payload: { amount: 430 },
    })

    expect(first).toMatchObject({ ok: true, version: 2 })
    await expect(engine.apply({
      snapshot: first.ok ? first.snapshot : snapshot,
      version: first.ok ? first.version : 1,
      expectedVersion: 1,
      operationId: 'stale',
      op: 'update',
      table: 'transactions',
      rowId: 'txn_001',
      payload: { amount: 440 },
    })).resolves.toMatchObject({
      ok: false,
      code: 'database-version-conflict',
      currentVersion: 2,
    })
  })
})
