import { describe, expect, it } from 'vitest'
import {
  deleteCsvRow,
  insertCsvRow,
  listCsvRows,
  updateCsvRow,
} from './collectionCsv'

const csvBody = [
  'ID,Merchant,Amount,Notes',
  '"txn,001",Grab,420,"ride, home"',
  'txn_002,Cafe,250,breakfast',
].join('\n')

describe('csv collection adapter', () => {
  it('parses quoted values and preserves headers', () => {
    const result = listCsvRows(
      { key: 'ID' },
      { path: 'finance/transactions/import.csv', body: csvBody },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.rows).toEqual([
      expect.objectContaining({
        id: 'txn,001',
        ID: 'txn,001',
        Merchant: 'Grab',
        Amount: 420,
        Notes: 'ride, home',
      }),
      expect.objectContaining({ id: 'txn_002', Merchant: 'Cafe' }),
    ])
  })

  it('appends rows with correct CSV quoting', () => {
    const result = insertCsvRow(
      { key: 'ID' },
      { path: 'finance/transactions/import.csv', body: csvBody },
      { ID: 'txn_003', Merchant: 'MRT', Amount: 28, Notes: 'train, commute' },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.body).toContain('txn_003,MRT,28,"train, commute"')
  })

  it('updates one row by visible ID', () => {
    const result = updateCsvRow(
      { key: 'ID' },
      { path: 'finance/transactions/import.csv', body: csvBody },
      'txn_002',
      { Amount: 275, Notes: 'brunch' },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.body).toContain('txn_002,Cafe,275,brunch')
    expect(result.ok && result.body).toContain('"txn,001",Grab,420,"ride, home"')
  })

  it('deletes one row by visible ID', () => {
    const result = deleteCsvRow(
      { key: 'ID' },
      { path: 'finance/transactions/import.csv', body: csvBody },
      'txn_002',
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.body).toBe([
      'ID,Merchant,Amount,Notes',
      '"txn,001",Grab,420,"ride, home"',
    ].join('\n'))
    expect(result.ok && result.expectedText).toBe('txn_002,Cafe,250,breakfast')
    expect(result.ok && result.replacement).toBe('')
  })
})
