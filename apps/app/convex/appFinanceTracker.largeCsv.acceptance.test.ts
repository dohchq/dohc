/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { runAppTest } from '../../../services/app-tester/src/runAppTest'
import { financeTrackerAppSource, financeTrackerManifest } from '../src/apps/fixtures/financeTrackerApp'

describe('large CSV finance tracker acceptance', () => {
  it('tests a generated finance app over large imported transaction data without dumping CSV rows into output', async () => {
    const transactions = Array.from({ length: 10_000 }, (_, index) => ({
      id: `txn_${index}`,
      ID: `txn_${index}`,
      Merchant: `Merchant ${index}`,
      Amount: index,
      Category: index % 3 === 0 ? 'Transport' : 'Food',
      Reviewed: index % 2 === 0 ? 'No' : 'Yes',
    }))

    const result = await runAppTest({
      packageRoot: 'finance/.apps/tracker',
      files: [{ relativePath: 'src/App.tsx', body: financeTrackerAppSource }],
      manifest: financeTrackerManifest,
      seed: {
        collections: {
          transactions,
          categories: [{ id: 'Learning', Name: 'Learning', Budget: 2500 }],
        },
      },
      mode: 'browser',
    })

    expect(result).toMatchObject({ ok: true })
    expect(JSON.stringify(result)).not.toContain('Merchant 9999')
    expect(JSON.stringify(result).split(/\s+/).length).toBeLessThan(200)
  }, 15_000)
})
