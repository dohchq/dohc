import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DatabaseStudio } from '../components/DatabaseStudio'

describe('DatabaseStudio', () => {
  it('renders schema, rows, version, and operation history for SQLite files', () => {
    const html = renderToStaticMarkup(
      createElement(DatabaseStudio, {
        database: {
          path: 'finance/ledger.sqlite',
          version: 3,
          tables: [
            {
              name: 'transactions',
              columns: [
                { name: 'id', type: 'TEXT', primaryKey: true },
                { name: 'merchant', type: 'TEXT' },
                { name: 'amount', type: 'REAL' },
              ],
              rows: [{ id: 'tx_1', merchant: 'Grab', amount: 420 }],
            },
          ],
          ops: [
            {
              operationId: 'op_1',
              op: 'insert',
              table: 'transactions',
              rowId: 'tx_1',
              actorUserId: 'user_1',
              version: 3,
            },
          ],
        },
      }),
    )

    expect(html).toContain('finance/ledger.sqlite')
    expect(html).toContain('version 3')
    expect(html).toContain('transactions')
    expect(html).toContain('merchant')
    expect(html).toContain('Grab')
    expect(html).toContain('op_1')
  })
})
