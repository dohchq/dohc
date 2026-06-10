import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSqliteEngine } from './sqliteEngine'

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

describe('sqlite worker data imports', () => {
  it('imports CSV into a SQLite table and returns provenance + materialized bytes', async () => {
    const engine = await createSqliteEngine()
    const body = [
      'id,merchant,amount,reviewed',
      'tx_1,Grab,420,false',
      'tx_2,Cafe,250,true',
    ].join('\n')

    const imported = await (engine as any).importData({
      name: 'transactions.csv',
      mediaType: 'text/csv',
      body,
      tableName: 'transactions',
    })

    expect(imported).toMatchObject({
      ok: true,
      tableName: 'transactions',
      rowCount: 2,
      sourceHash: sha256(body),
      tableSchema: [
        { name: 'id', type: 'TEXT', primaryKey: true },
        { name: 'merchant', type: 'TEXT' },
        { name: 'amount', type: 'INTEGER' },
        { name: 'reviewed', type: 'INTEGER' },
      ],
      operation: {
        op: 'import_data',
        table: 'transactions',
        rowCount: 2,
      },
      bytesBase64: expect.any(String),
    })

    const reingested = await engine.ingest({ bytesBase64: imported.bytesBase64 })
    expect(reingested).toMatchObject({
      ok: true,
      snapshot: {
        transactions: {
          rows: [
            expect.objectContaining({ id: 'tx_1', merchant: 'Grab', amount: 420, reviewed: 0 }),
            expect.objectContaining({ id: 'tx_2', merchant: 'Cafe', amount: 250, reviewed: 1 }),
          ],
        },
      },
    })
  })

  it('imports JSON arrays, JSONL, markdown tables, and extracted PDF table text', async () => {
    const engine = await createSqliteEngine()

    await expect(
      (engine as any).importData({
        name: 'people.json',
        mediaType: 'application/json',
        body: JSON.stringify([
          { id: 'p1', name: 'Ice', score: 10 },
          { id: 'p2', name: 'Ada', score: 12 },
        ]),
        tableName: 'people',
      }),
    ).resolves.toMatchObject({
      ok: true,
      rowCount: 2,
      tableSchema: expect.arrayContaining([
        expect.objectContaining({ name: 'id', primaryKey: true }),
        expect.objectContaining({ name: 'score', type: 'INTEGER' }),
      ]),
    })

    await expect(
      (engine as any).importData({
        name: 'events.jsonl',
        mediaType: 'application/x-ndjson',
        body: '{"id":"e1","kind":"open"}\n{"id":"e2","kind":"close"}',
        tableName: 'events',
      }),
    ).resolves.toMatchObject({
      ok: true,
      rowCount: 2,
      snapshot: {
        events: {
          rows: [
            expect.objectContaining({ id: 'e1', kind: 'open' }),
            expect.objectContaining({ id: 'e2', kind: 'close' }),
          ],
        },
      },
    })

    await expect(
      (engine as any).importData({
        name: 'inventory.md',
        mediaType: 'text/markdown',
        body: '| id | sku | qty |\n| --- | --- | ---: |\n| r1 | A-1 | 3 |\n| r2 | B-2 | 5 |',
        tableName: 'inventory',
      }),
    ).resolves.toMatchObject({
      ok: true,
      rowCount: 2,
      snapshot: {
        inventory: {
          rows: [
            expect.objectContaining({ id: 'r1', sku: 'A-1', qty: 3 }),
            expect.objectContaining({ id: 'r2', sku: 'B-2', qty: 5 }),
          ],
        },
      },
    })

    await expect(
      (engine as any).importData({
        name: 'receipt.pdf',
        mediaType: 'application/pdf',
        body: '| id | item | amount |\n| --- | --- | ---: |\n| line_1 | notebook | 7.5 |',
        tableName: 'receipt_lines',
      }),
    ).resolves.toMatchObject({
      ok: true,
      sourceMediaType: 'application/pdf',
      rowCount: 1,
      snapshot: {
        receipt_lines: {
          rows: [expect.objectContaining({ id: 'line_1', item: 'notebook', amount: 7.5 })],
        },
      },
    })
  })
})
