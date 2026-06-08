import { describe, expect, it } from 'vitest'
import {
  deleteMarkdownTableRow,
  insertMarkdownTableRow,
  listMarkdownTableRows,
  updateMarkdownTableRow,
} from './collectionMarkdownTable'

const tableBody = `# June 2026 Transactions

| ID | Date | Account | Merchant | Category | Amount | Reviewed | Notes |
|---|---|---|---|---|---:|---|---|
| txn_001 | 2026-06-06 | BPI Platinum | Grab | Transport | 420.00 | No | commute |
| txn_002 | 2026-06-07 | BPI Platinum | Cafe | Meals | 250 | Yes | breakfast |
`

describe('markdown table collection adapter', () => {
  it('parses readable rows with a visible key column', () => {
    const result = listMarkdownTableRows(
      { key: 'ID' },
      { path: 'finance/transactions/2026-06.md', body: tableBody },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.rows).toEqual([
      expect.objectContaining({
        id: 'txn_001',
        ID: 'txn_001',
        Merchant: 'Grab',
        Amount: 420,
        Reviewed: 'No',
        sourcePath: 'finance/transactions/2026-06.md',
      }),
      expect.objectContaining({
        id: 'txn_002',
        ID: 'txn_002',
        Merchant: 'Cafe',
        Amount: 250,
        Reviewed: 'Yes',
      }),
    ])
  })

  it('inserts rows while preserving column order', () => {
    const result = insertMarkdownTableRow(
      { key: 'ID' },
      { path: 'finance/transactions/2026-06.md', body: tableBody },
      {
        ID: 'txn_003',
        Date: '2026-06-08',
        Account: 'BPI Platinum',
        Merchant: 'MRT',
        Category: 'Transport',
        Amount: 28,
        Reviewed: 'No',
        Notes: 'train',
      },
    )

    expect(result).toMatchObject({ ok: true, sourcePath: 'finance/transactions/2026-06.md' })
    expect(result.ok && result.body).toContain('| txn_003 | 2026-06-08 | BPI Platinum | MRT | Transport | 28 | No | train |')
  })

  it('updates only the target row and preserves unknown extra columns', () => {
    const result = updateMarkdownTableRow(
      { key: 'ID' },
      { path: 'finance/transactions/2026-06.md', body: tableBody },
      'txn_001',
      { Amount: 430, Reviewed: 'Yes' },
    )

    expect(result).toMatchObject({ ok: true })
    const body = result.ok ? result.body : ''
    expect(body).toContain('| txn_001 | 2026-06-06 | BPI Platinum | Grab | Transport | 430 | Yes | commute |')
    expect(body).toContain('| txn_002 | 2026-06-07 | BPI Platinum | Cafe | Meals | 250 | Yes | breakfast |')
  })

  it('deletes a row by visible ID', () => {
    const result = deleteMarkdownTableRow(
      { key: 'ID' },
      { path: 'finance/transactions/2026-06.md', body: tableBody },
      'txn_002',
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.body).toContain('txn_001')
    expect(result.ok && result.body).not.toContain('txn_002')
  })

  it('rejects tables without the configured key column', () => {
    const result = listMarkdownTableRows(
      { key: 'ID' },
      {
        path: 'finance/transactions/2026-06.md',
        body: '| Date | Merchant |\n|---|---|\n| 2026-06-06 | Grab |',
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'missing-key-column' })
  })

  it('rejects ambiguous duplicate IDs', () => {
    const result = listMarkdownTableRows(
      { key: 'ID' },
      {
        path: 'finance/transactions/2026-06.md',
        body: '| ID | Merchant |\n|---|---|\n| txn_001 | Grab |\n| txn_001 | Cafe |',
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'duplicate-id', id: 'txn_001' })
  })
})
