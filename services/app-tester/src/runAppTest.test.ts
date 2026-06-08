import { describe, expect, it } from 'vitest'
import { createAppTestSdk } from './appTestSdk'
import { runAppTest } from './runAppTest'
import { createAppTesterHandler } from './server'

const financeTracker = `
import { dohc, useCollection } from '@dohc/app'

export default function App() {
  const transactions = useCollection('transactions')
  const total = transactions.reduce((sum, row) => sum + Number(row.Amount || 0), 0)
  async function addExpense() {
    await dohc.collection('transactions').insert({
      ID: 'txn_003',
      Merchant: 'Bookstore',
      Amount: 900,
      Reviewed: 'No'
    })
  }
  async function markReviewed(id) {
    await dohc.collection('transactions').update(id, { Reviewed: 'Yes' })
  }
  return <main><h1>Finance Tracker</h1><strong>{total}</strong><button onClick={addExpense}>Add expense</button><button onClick={() => markReviewed('txn_001')}>Mark reviewed</button></main>
}
`

const seedCollections = {
  transactions: [
    { id: 'txn_001', Merchant: 'Grab', Amount: 420, Reviewed: 'No' },
    { id: 'txn_002', Merchant: 'Cafe', Amount: 250, Reviewed: 'Yes' },
  ],
}

describe('runAppTest', () => {
  it('passes a useful persistent source-backed finance tracker', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/tracker',
      files: [
        { relativePath: 'app.json', body: '{"title":"Finance Tracker"}' },
        { relativePath: 'src/App.tsx', body: financeTracker },
      ],
      seed: { collections: seedCollections },
      manifest: {
        collections: { transactions: { source: 'transactions.md' } },
        tests: [{ name: 'add expense' }],
      },
    })

    expect(result).toMatchObject({
      ok: true,
      packageRoot: 'finance/.apps/tracker',
    })
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'compile', status: 'ok' }),
        expect.objectContaining({ name: 'source-backed data', status: 'ok' }),
        expect.objectContaining({ name: 'mutation persistence', status: 'ok' }),
        expect.objectContaining({ name: 'browser render', status: 'ok' }),
      ]),
    )
  })

  it('strips dohc atom frontmatter from app source before compiling', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/frontmatter',
      files: [
        { relativePath: 'app.json', body: '---\nid: app.manifest\n---\n{"title":"Finance Tracker"}' },
        {
          relativePath: 'src/App.tsx',
          body: `---
id: app.source
---
${financeTracker}`,
        },
      ],
      seed: { collections: seedCollections },
      manifest: {
        collections: { transactions: { source: 'transactions.md' } },
        tests: [{ name: 'add expense' }],
      },
    })

    expect(result).toMatchObject({
      ok: true,
      packageRoot: 'finance/.apps/frontmatter',
    })
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'compile', status: 'ok' }),
    )
  })

  it('catches blank renders', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/blank',
      files: [{ relativePath: 'src/App.tsx', body: "import { dohc } from '@dohc/app'; export default function App(){ return null }" }],
      seed: { collections: seedCollections },
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: 'browser render', code: 'blank-render' }),
    )
  })

  it('catches fake primary buttons that do not call persistent SDK writes', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/fake',
      files: [{
        relativePath: 'src/App.tsx',
        body: "import { useState } from 'react'; import { useCollection } from '@dohc/app'; export default function App(){ const [rows,setRows]=useState([]); useCollection('transactions'); return <button onClick={() => setRows([...rows, {}])}>Add expense</button> }",
      }],
      seed: { collections: seedCollections },
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: 'mutation persistence', code: 'fake-primary-button' }),
    )
  })

  it('catches placeholder metrics when real source data exists', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/placeholder',
      files: [{
        relativePath: 'src/App.tsx',
        body: "import { dohc } from '@dohc/app'; export default function App(){ return <main><h1>Total spend</h1><strong>$0</strong><button onClick={() => dohc.collection('transactions').insert({ID:'x'})}>Add expense</button></main> }",
      }],
      seed: { collections: seedCollections },
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: 'source-backed data', code: 'placeholder-metric' }),
    )
  })

  it('catches app controls that have no persistence path', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/local-only',
      files: [{
        relativePath: 'src/App.tsx',
        body: "import { useCollection } from '@dohc/app'; export default function App(){ useCollection('transactions'); return <form><input name='merchant'/><button>Save</button></form> }",
      }],
      seed: { collections: seedCollections },
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: 'mutation persistence', code: 'missing-persistence' }),
    )
  })

  it('simulates collection persistence through the app test SDK', async () => {
    const sdk = createAppTestSdk({ collections: seedCollections })
    await sdk.dohc.collection('transactions').insert({ id: 'txn_003', Merchant: 'Bookstore' })
    await sdk.dohc.collection('transactions').update('txn_001', { Reviewed: 'Yes' })

    expect(sdk.snapshot().collections.transactions).toEqual([
      expect.objectContaining({ id: 'txn_001', Reviewed: 'Yes' }),
      expect.objectContaining({ id: 'txn_002' }),
      expect.objectContaining({ id: 'txn_003', Merchant: 'Bookstore' }),
    ])
    expect(sdk.calls).toEqual([
      expect.objectContaining({ op: 'collection.insert', collection: 'transactions' }),
      expect.objectContaining({ op: 'collection.update', collection: 'transactions', id: 'txn_001' }),
    ])
  })

  it('treats doc replaceText controls as persistent source writes', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/doc-review',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useDoc } from '@dohc/app'
          export default function App() {
            const ledger = useDoc('finance/ledger.md')
            async function markReviewed() {
              await dohc.doc('finance/ledger.md').replaceText({
                find: 'review: no',
                with: 'review: yes'
              })
            }
            return <main><h1>Review</h1><p>{ledger.body}</p><button onClick={markReviewed}>Mark reviewed</button></main>
          }
        `,
      }],
      seed: { docs: { 'finance/ledger.md': 'review: no' } },
      manifest: { tests: [{ name: 'mark reviewed', path: 'finance/ledger.md' }] },
    })

    expect(result).toMatchObject({
      ok: true,
      packageRoot: 'finance/.apps/doc-review',
    })
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'mutation persistence', status: 'ok' }),
    )
  })

  it('serves test_app over the app tester handler', async () => {
    const handler = createAppTesterHandler({ allowInsecureLocal: true })
    const response = await handler(new Request('http://localhost/test_app', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packageRoot: 'finance/.apps/tracker',
        files: [{ relativePath: 'src/App.tsx', body: financeTracker }],
        seed: { collections: seedCollections },
      }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
  })

  it('fails closed without a token unless explicit local insecure mode is enabled', async () => {
    const handler = createAppTesterHandler()
    const response = await handler(new Request('http://localhost/test_app', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packageRoot: 'finance/.apps/tracker',
        files: [{ relativePath: 'src/App.tsx', body: financeTracker }],
        seed: { collections: seedCollections },
      }),
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'unauthorized' })
  })
})
