/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { runAppTest } from '../../../services/app-tester/src/runAppTest'
import { financeTrackerAppSource, financeTrackerManifest } from '../src/apps/fixtures/financeTrackerApp'

const seed = {
  collections: {
    transactions: [
      { id: 'txn_001', ID: 'txn_001', Merchant: 'Grab', Amount: 420, Reviewed: 'No' },
      { id: 'txn_002', ID: 'txn_002', Merchant: 'Cafe', Amount: 250, Reviewed: 'Yes' },
    ],
  },
}

describe('onboarding generated app quality', () => {
  it('passes a generated finance tracker that uses real data and persistent SDK writes', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/tracker',
      files: [{ relativePath: 'src/App.tsx', body: financeTrackerAppSource }],
      manifest: financeTrackerManifest,
      seed,
      mode: 'browser',
    })).resolves.toMatchObject({ ok: true })
  })

  it('fails generated apps with placeholder metrics over real source data', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/tracker',
      files: [{
        relativePath: 'src/App.tsx',
        body: "import { useCollection } from '@dohc/app'; export default function App(){ useCollection('transactions'); return <main><strong>$0</strong></main> }",
      }],
      seed,
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ code: 'placeholder-metric' })],
    })
  })

  it('fails generated apps whose primary controls only mutate local React state', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/tracker',
      files: [{
        relativePath: 'src/App.tsx',
        body: "import { useState } from 'react'; import { useCollection } from '@dohc/app'; export default function App(){ const [rows,setRows]=useState([]); useCollection('transactions'); return <button onClick={() => setRows([...rows, {}])}>Add expense</button> }",
      }],
      seed,
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ code: 'fake-primary-button' })],
    })
  })

  it('fails generated apps that omit manifest-declared finance workflows', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/tracker',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useCollection } from '@dohc/app'
          export default function App() {
            const transactions = useCollection('transactions')
            return (
              <main>
                <strong>{transactions.length}</strong>
                <button onClick={() => dohc.collection('transactions').insert({ ID: 'txn_003', Amount: 900, Reviewed: 'No' })}>
                  Add expense
                </button>
              </main>
            )
          }
        `,
      }],
      manifest: financeTrackerManifest,
      seed,
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'manifest tests', code: 'manifest-test-missing-control' }),
      ]),
    })
  })
})
