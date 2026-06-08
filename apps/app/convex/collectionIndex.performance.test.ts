/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { filterCollectionRows } from './collectionAdapters'

describe('collection index performance', () => {
  it('filters and orders a 100k derived index under the phase threshold', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => ({
      id: `txn_${index}`,
      Category: index % 10 === 0 ? 'Transport' : 'Other',
      Amount: index,
      sourcePath: 'finance/ledger.sqlite',
    }))
    const started = performance.now()
    const result = filterCollectionRows(rows, {
      where: { Category: 'Transport' },
      orderBy: [{ field: 'Amount', direction: 'desc' }],
      limit: 1,
    })
    const elapsed = performance.now() - started

    expect(result).toEqual([expect.objectContaining({ id: 'txn_99990', Amount: 99990 })])
    expect(elapsed).toBeLessThan(250)
  })
})
