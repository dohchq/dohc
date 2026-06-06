import { describe, expect, it } from 'vitest'
import {
  deleteMarkdownCardRow,
  insertMarkdownCardRow,
  listMarkdownCardRows,
  updateMarkdownCardRow,
} from './collectionMarkdownCards'

const cardsBody = `# Transactions

## txn_001 -- Grab

Merchant: Grab
Amount: 420
Reviewed: No

Commute ride.
`

describe('markdown cards collection adapter', () => {
  it('parses card headings as record IDs and keeps prose body text', () => {
    const result = listMarkdownCardRows(
      { key: 'ID' },
      { path: 'finance/transactions/cards.md', body: cardsBody },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.rows).toEqual([
      expect.objectContaining({
        id: 'txn_001',
        ID: 'txn_001',
        Title: 'Grab',
        Merchant: 'Grab',
        Amount: 420,
        Reviewed: 'No',
        Body: 'Commute ride.',
      }),
    ])
  })

  it('appends a new card with visible key-value fields', () => {
    const result = insertMarkdownCardRow(
      { key: 'ID' },
      { path: 'finance/transactions/cards.md', body: cardsBody },
      { ID: 'txn_002', Title: 'Cafe', Merchant: 'Cafe', Amount: 250, Reviewed: 'No' },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.body).toContain('## txn_002 -- Cafe')
    expect(result.ok && result.body).toContain('Merchant: Cafe')
    expect(result.ok && result.body).toContain('Amount: 250')
  })

  it('updates a key-value line without dropping prose', () => {
    const result = updateMarkdownCardRow(
      { key: 'ID' },
      { path: 'finance/transactions/cards.md', body: cardsBody },
      'txn_001',
      { Reviewed: 'Yes' },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.body).toContain('Reviewed: Yes')
    expect(result.ok && result.body).toContain('Commute ride.')
  })

  it('deletes a whole card by visible ID', () => {
    const result = deleteMarkdownCardRow(
      { key: 'ID' },
      { path: 'finance/transactions/cards.md', body: cardsBody },
      'txn_001',
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.body).toBe('# Transactions\n')
    expect(result.ok && result.expectedText).toContain('## txn_001 -- Grab')
    expect(result.ok && result.replacement).toBe('')
  })
})
