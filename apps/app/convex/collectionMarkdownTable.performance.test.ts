/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { listMarkdownTableRows } from './collectionMarkdownTable'

describe('markdown table collection performance', () => {
  it('parses 1k markdown rows under the phase threshold', () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      `| txn_${String(index).padStart(4, '0')} | Merchant ${index} | ${index} | No |`,
    )
    const body = ['| ID | Merchant | Amount | Reviewed |', '|---|---|---:|---|', ...rows].join('\n')
    const started = performance.now()
    const result = listMarkdownTableRows({ key: 'ID' }, { path: 'finance/transactions.md', body })
    const elapsed = performance.now() - started

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.rows).toHaveLength(1000)
    expect(elapsed).toBeLessThan(250)
  })
})
