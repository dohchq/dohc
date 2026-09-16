import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createSqliteEngine } from './sqliteEngine'

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

// Open the materialized bytes as a real SQLite file and read a table back.
async function readTable(bytesBase64: string, table: string) {
  const dir = await mkdtemp(join(tmpdir(), 'dohc-import-test-'))
  const file = join(dir, 'database.sqlite')
  await writeFile(file, Buffer.from(bytesBase64, 'base64'))
  const db = new DatabaseSync(file)
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

describe('sqlite worker data imports', () => {
  it.each([
    { name: 'quoted.csv', mediaType: 'text/csv', body: 'id,note,amount\na,"one,two",4.5\nb,"line one\nline two",8' },
    { name: 'data.json', mediaType: 'application/json', body: '[{"id":"a","value":true},{"id":"b","value":false}]' },
    { name: 'data.jsonl', mediaType: 'application/x-ndjson', body: '{"id":"a","value":2}\n{"id":"b","value":3}' },
    { name: 'data.md', mediaType: 'text/markdown', body: '| id | value |\n| --- | --- |\n| a | 2 |\n| b | 3 |' },
  ])('materializes the same complete SQLite bytes for $name without an encoded snapshot result', async source => {
    const engine = await createSqliteEngine()
    const input = { ...source, tableName: 'imported data' }
    const imported = await engine.importData(input)
    const materialized = await engine.materializeImport(input)
    if (!imported.ok || !materialized.ok) throw new Error('Import failed')
    expect(Object.keys(materialized).sort()).toEqual(['bytes', 'ok', 'rowCount', 'tableName'])
    expect(materialized.tableName).toBe(imported.tableName)
    expect(materialized.rowCount).toBe(imported.rowCount)
    expect(materialized.bytes).toEqual(Buffer.from(imported.bytesBase64, 'base64'))
    expect(createHash('sha256').update(materialized.bytes).digest('hex')).toBe(imported.sha256)
    expect(await readTable(materialized.bytes.toString('base64'), materialized.tableName)).toHaveLength(imported.rowCount)
  })

  it.each([
    { name: 'empty.csv', mediaType: 'text/csv', body: 'id,value' },
    { name: 'unsupported.bin', mediaType: 'application/octet-stream', body: 'data' },
    { name: 'duplicate.csv', mediaType: 'text/csv', body: 'id,value\na,1\na,2' },
  ])('keeps the same error for $name in both import paths', async source => {
    const engine = await createSqliteEngine()
    const input = { ...source, tableName: 'rows' }
    const imported = await engine.importData(input)
    const materialized = await engine.materializeImport(input)
    expect(imported.ok).toBe(false)
    expect(materialized).toEqual(imported)
  })

  it('imports CSV into a SQLite table and returns provenance + materialized bytes', async () => {
    const engine = await createSqliteEngine()
    const body = [
      'id,merchant,amount,reviewed',
      'tx_1,Grab,420,false',
      'tx_2,Cafe,250,true',
    ].join('\n')

    const imported = await engine.importData({
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

    if (!imported.ok) throw new Error(imported.message)
    expect(await readTable(imported.bytesBase64, 'transactions')).toEqual([
      expect.objectContaining({ id: 'tx_1', merchant: 'Grab', amount: 420, reviewed: 0 }),
      expect.objectContaining({ id: 'tx_2', merchant: 'Cafe', amount: 250, reviewed: 1 }),
    ])
  })

  it('imports JSON arrays, JSONL, markdown tables, and extracted PDF table text', async () => {
    const engine = await createSqliteEngine()

    await expect(
      engine.importData({
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
      engine.importData({
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
      engine.importData({
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
      engine.importData({
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
