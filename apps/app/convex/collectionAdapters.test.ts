import { describe, expect, it } from 'vitest'
import {
  filterCollectionRows,
  getCollectionAdapter,
  listCollectionRows,
  getCollectionRow,
} from './collectionAdapters'

describe('collection adapter dispatch', () => {
  it('dispatches markdown-table collections and applies app query filters', () => {
    const result = listCollectionRows(
      {
        name: 'transactions',
        format: 'markdown-table',
        key: 'ID',
      },
      [
        {
          path: 'finance/transactions/2026-06.md',
          body: [
            '| ID | Merchant | Amount | Reviewed |',
            '|---|---|---:|---|',
            '| txn_001 | Grab | 420 | No |',
            '| txn_002 | Cafe | 250 | Yes |',
          ].join('\n'),
        },
      ],
      { where: { Reviewed: 'No' }, orderBy: [{ field: 'Amount', direction: 'desc' }], limit: 1 },
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.rows).toEqual([
      expect.objectContaining({ id: 'txn_001', Merchant: 'Grab', Amount: 420 }),
    ])
  })

  it('gets one row by ID without leaking unrelated rows', () => {
    const result = getCollectionRow(
      {
        name: 'transactions',
        format: 'markdown-table',
        key: 'ID',
      },
      [
        {
          path: 'finance/transactions/2026-06.md',
          body: '| ID | Merchant |\n|---|---|\n| txn_001 | Grab |\n| txn_002 | Cafe |',
        },
      ],
      'txn_002',
    )

    expect(result).toMatchObject({
      ok: true,
      row: expect.objectContaining({ id: 'txn_002', Merchant: 'Cafe' }),
    })
  })

  it('supports read-only jsonl and yaml collections', () => {
    expect(getCollectionAdapter('jsonl').mutable).toBe(false)
    expect(getCollectionAdapter('yaml').mutable).toBe(false)

    const jsonl = listCollectionRows(
      { name: 'events', format: 'jsonl', key: 'id' },
      [{ path: 'events.jsonl', body: '{"id":"evt_1","kind":"import"}\n{"id":"evt_2","kind":"review"}' }],
    )
    expect(jsonl).toMatchObject({
      ok: true,
      rows: [
        expect.objectContaining({ id: 'evt_1', kind: 'import' }),
        expect.objectContaining({ id: 'evt_2', kind: 'review' }),
      ],
    })

    const yaml = listCollectionRows(
      { name: 'rules', format: 'yaml', key: 'id' },
      [{ path: 'rules.yaml', body: '- id: rule_1\n  category: Transport\n  enabled: true' }],
    )
    expect(yaml).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'rule_1', category: 'Transport', enabled: true })],
    })
  })

  it('rejects unsupported collection formats', () => {
    expect(() => getCollectionAdapter('xml')).toThrow('Unsupported collection format: xml')
  })

  it('filters rows with stable exact-match semantics', () => {
    expect(filterCollectionRows(
      [
        { id: 'a', Amount: 10, Reviewed: 'No', sourcePath: 'rows.md' },
        { id: 'b', Amount: 20, Reviewed: 'Yes', sourcePath: 'rows.md' },
      ],
      { where: { Reviewed: 'No' }, limit: 10 },
    )).toEqual([{ id: 'a', Amount: 10, Reviewed: 'No', sourcePath: 'rows.md' }])
  })
})
