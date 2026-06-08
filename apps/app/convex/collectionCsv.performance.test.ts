/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { listCsvRows } from './collectionCsv'

describe('csv collection performance', () => {
  it('parses 10k CSV rows under the phase threshold', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) =>
      `txn_${index},Merchant ${index},${index},${index % 2 === 0 ? 'No' : 'Yes'}`,
    )
    const body = ['ID,Merchant,Amount,Reviewed', ...rows].join('\n')
    const started = performance.now()
    const result = listCsvRows({ key: 'ID' }, { path: 'finance/transactions.csv', body })
    const elapsed = performance.now() - started

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.rows).toHaveLength(10_000)
    expect(elapsed).toBeLessThan(1500)
  })
})
