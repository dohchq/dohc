import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAppTest } from './runAppTest'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runAppTest browser checks', () => {
  it('fails syntax errors instead of passing regex-only source', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/syntax-error',
      files: [{
        relativePath: 'src/App.tsx',
        body: "import { dohc } from '@dohc/app'; export default function App(){ return <main><button onClick={() => dohc.collection('transactions').insert({ id: 'x' })}>Add</button></main> ",
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'compile', code: 'compile-error' }),
      ]),
    })
  })

  it('reports blank browser renders clearly', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/blank',
      files: [{ relativePath: 'src/App.tsx', body: "import { dohc } from '@dohc/app'; export default function App(){ return null }" }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'browser render', code: 'blank-render' }),
      ]),
    })
  })

  it('verifies primary controls call persistent collection/database/doc mutations', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/fake',
      files: [{
        relativePath: 'src/App.tsx',
        body: "import { useCollection } from '@dohc/app'; export default function App(){ useCollection('transactions'); return <button>Add expense</button> }",
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ name: 'mutation persistence', code: 'missing-persistence' })],
    })
  })

  it('fails visible no-op controls even when an unused helper contains a persistent write', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/adversarial',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useCollection } from '@dohc/app'
          export default function App() {
            useCollection('transactions')
            async function unused() {
              await dohc.collection('transactions').insert({ id: 'never' })
            }
            return <main><button>Add expense</button></main>
          }
        `,
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'mutation persistence', code: 'missing-persistence' }),
      ]),
    })
  })

  it('rejects app code that touches Node process globals', async () => {
    vi.stubEnv('APP_TESTER_PROBE_SECRET', 'harmless-probe')

    await expect(runAppTest({
      packageRoot: 'finance/.apps/process-probe',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useCollection } from '@dohc/app'
          export default function App() {
            useCollection('transactions')
            const leaked = globalThis.process?.env?.APP_TESTER_PROBE_SECRET || 'missing'
            return (
              <main>
                <strong>{leaked}</strong>
                <button onClick={() => dohc.collection('transactions').insert({ id: 'txn_003' })}>
                  Add expense
                </button>
              </main>
            )
          }
        `,
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'browser render', code: 'sandbox-violation' }),
      ]),
    })
  })

  it('rejects app code that tries to use network APIs', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/network-probe',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useCollection } from '@dohc/app'
          export default function App() {
            useCollection('transactions')
            async function addExpense() {
              await fetch('data:text/plain,probe')
              await dohc.collection('transactions').insert({ id: 'txn_003' })
            }
            return <main><button onClick={addExpense}>Add expense</button></main>
          }
        `,
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'browser render', code: 'sandbox-violation' }),
      ]),
    })
  })

  it('kills app code that hangs the render sandbox', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/hang-probe',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc } from '@dohc/app'
          export default function App() {
            while (true) {}
            return <main><button onClick={() => dohc.collection('transactions').insert({ id: 'txn_003' })}>Add</button></main>
          }
        `,
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'browser render', code: 'sandbox-timeout' }),
      ]),
    })
  })

  it('fails a mixed workflow when one visible control persists and another is a no-op', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/mixed-fake',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useCollection } from '@dohc/app'
          export default function App() {
            const transactions = useCollection('transactions')
            return (
              <main>
                <button onClick={() => dohc.collection('transactions').insert({ id: 'txn_003' })}>
                  Add expense
                </button>
                <button onClick={() => {}}>
                  Mark reviewed
                </button>
                <strong>{transactions.length}</strong>
              </main>
            )
          }
        `,
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420, Reviewed: 'No' }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'mutation persistence', code: 'control-missing-persistence' }),
      ]),
    })
  })

  it('requires SQLite-backed controls to write through dohc.database tables', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/sqlite-plain-collection',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useCollection } from '@dohc/app'
          export default function App() {
            const ledger = useCollection('ledger')
            return (
              <main>
                <strong>{ledger.length}</strong>
                <button onClick={() => dohc.collection('ledger').insert({ id: 'txn_003' })}>
                  Add expense
                </button>
              </main>
            )
          }
        `,
      }],
      manifest: {
        collections: {
          ledger: { source: 'ledger.sqlite', format: 'sqlite', table: 'transactions', key: 'id' },
        },
        databases: { ledgerDb: { path: 'ledger.sqlite', write: true } },
        tests: [{ name: 'add sqlite expense', collection: 'ledger' }],
      },
      seed: {
        collections: { ledger: [{ id: 'txn_001', amount: 420 }] },
        databases: { 'ledger.sqlite': { transactions: [{ id: 'txn_001', amount: 420 }] } },
      },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'mutation persistence', code: 'sqlite-sdk-path-required' }),
      ]),
    })
  })

  it('fails dead-code persistence writes and hidden primary buttons', async () => {
    await expect(runAppTest({
      packageRoot: 'finance/.apps/dead-code',
      files: [{
        relativePath: 'src/App.tsx',
        body: `
          import { dohc, useCollection } from '@dohc/app'
          export default function App() {
            useCollection('transactions')
            if (false) dohc.collection('transactions').insert({ id: 'never' })
            return <main><button style={{ display: 'none' }}>Add expense</button></main>
          }
        `,
      }],
      seed: { collections: { transactions: [{ id: 'txn_001', Amount: 420 }] } },
      mode: 'browser',
    })).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'mutation persistence', code: 'missing-persistence' }),
        expect.objectContaining({ name: 'browser render', code: 'fake-primary-button' }),
      ]),
    })
  })
})
