import { describe, expect, it } from 'vitest'
import { listJsonlRows } from './collectionJsonl'

describe('jsonl collection adapter', () => {
  it('parses readable append-only rows and rejects malformed lines', () => {
    expect(listJsonlRows(
      { key: 'id' },
      { path: 'events.jsonl', body: '{"id":"evt_1","amount":42}\n{"id":"evt_2","reviewed":false}' },
    )).toMatchObject({
      ok: true,
      rows: [
        expect.objectContaining({ id: 'evt_1', amount: 42 }),
        expect.objectContaining({ id: 'evt_2', reviewed: false }),
      ],
    })

    expect(listJsonlRows(
      { key: 'id' },
      { path: 'events.jsonl', body: '{"id":"evt_1"}\nnot-json' },
    )).toMatchObject({ ok: false, code: 'invalid-jsonl' })
  })
})
