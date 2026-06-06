export const financeTrackerManifest = {
  title: 'Finance Tracker',
  entry: 'src/App.tsx',
  read: ['transactions/**', 'categories.md', 'rules.md'],
  write: ['transactions/**'],
  collections: {
    transactions: {
      source: 'transactions/*.md',
      write: 'transactions/**',
      format: 'markdown-table',
      key: 'ID',
    },
    categories: {
      source: 'categories.md',
      format: 'markdown-table',
      key: 'Name',
    },
  },
  tests: [
    { name: 'add expense', collection: 'transactions' },
    { name: 'categorize transaction', collection: 'transactions' },
    { name: 'mark reviewed', collection: 'transactions' },
  ],
}

export const financeTrackerAppSource = `
import { dohc, useCollection, useDoc } from '@dohc/app'

export default function App() {
  const transactions = useCollection('transactions')
  const categories = useCollection('categories')
  const rules = useDoc('rules.md')
  const total = transactions.reduce((sum, row) => sum + Number(row.Amount || 0), 0)
  const reviewQueue = transactions.filter((row) => row.Reviewed !== 'Yes')
  const visibleReviewQueue = reviewQueue.slice(0, 20)

  async function addExpense() {
    await dohc.collection('transactions').insert({
      ID: 'txn_003',
      Date: '2026-06-08',
      Merchant: 'Bookstore',
      Amount: 900,
      Category: 'Learning',
      Reviewed: 'No'
    })
  }

  async function categorizeTransaction(id, category) {
    await dohc.collection('transactions').update(id, { Category: category })
  }

  async function markReviewed(id) {
    await dohc.collection('transactions').update(id, { Reviewed: 'Yes' })
  }

  return (
    <main>
      <h1>Finance Tracker</h1>
      <section>
        <h2>Total spend</h2>
        <strong>{total.toLocaleString()}</strong>
      </section>
      <section>
        <h2>Review queue</h2>
        <button onClick={addExpense}>Add expense</button>
        {visibleReviewQueue.map((row) => (
          <article key={row.ID}>
            <span>{row.Merchant}</span>
            <span>{row.Category}</span>
            <button onClick={() => categorizeTransaction(row.ID, categories[0]?.Name || 'Transport')}>
              Categorize
            </button>
            <button onClick={() => markReviewed(row.ID)}>Mark reviewed</button>
          </article>
        ))}
      </section>
      <aside>{rules?.body || 'Rules source connected'}</aside>
    </main>
  )
}
`

export const financeTrackerSqliteManifest = {
  title: 'Finance Tracker',
  entry: 'src/App.tsx',
  read: ['ledger.sqlite'],
  write: ['ledger.sqlite'],
  collections: {
    ledger: {
      source: 'ledger.sqlite',
      write: 'ledger.sqlite',
      format: 'sqlite',
      table: 'transactions',
      key: 'id',
    },
  },
  databases: {
    ledgerDb: { path: 'ledger.sqlite', write: true },
  },
  tests: [
    { name: 'add sqlite expense', collection: 'ledger' },
    { name: 'categorize sqlite transaction', collection: 'ledger' },
    { name: 'mark sqlite reviewed', collection: 'ledger' },
  ],
}

export const financeTrackerSqliteAppSource = `
import { dohc, useCollection, useDatabase } from '@dohc/app'

export default function App() {
  const ledger = useCollection('ledger')
  const database = useDatabase('ledger.sqlite')
  const transactions = dohc.database('ledger.sqlite').table('transactions')
  const total = ledger.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const reviewQueue = ledger.filter((row) => row.reviewed !== true)
  const visibleReviewQueue = reviewQueue.slice(0, 20)

  async function addExpense() {
    await transactions.insert({
      id: 'txn_003',
      date: '2026-06-08',
      merchant: 'Bookstore',
      amount: 900,
      category: 'Learning',
      reviewed: false
    })
  }

  async function categorizeTransaction(id, category) {
    await transactions.update(id, { category })
  }

  async function markReviewed(id) {
    await transactions.update(id, { reviewed: true })
  }

  return (
    <main>
      <h1>Finance Tracker</h1>
      <section>
        <h2>Total spend</h2>
        <strong>{total.toLocaleString()}</strong>
      </section>
      <button onClick={addExpense}>Add expense</button>
      {visibleReviewQueue.map((row) => (
        <article key={row.id}>
          <span>{row.merchant}</span>
          <span>{row.category}</span>
          <button onClick={() => categorizeTransaction(row.id, 'Transport')}>Categorize</button>
          <button onClick={() => markReviewed(row.id)}>Mark reviewed</button>
        </article>
      ))}
      <aside>{database ? 'Ledger database connected' : 'Connecting ledger'}</aside>
    </main>
  )
}
`

export const financeTrackerSqliteTables = {
  transactions: {
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true },
      { name: 'date', type: 'TEXT' },
      { name: 'merchant', type: 'TEXT' },
      { name: 'amount', type: 'REAL' },
      { name: 'category', type: 'TEXT' },
      { name: 'reviewed', type: 'INTEGER' },
    ],
    rows: [
      {
        id: 'txn_001',
        date: '2026-06-06',
        merchant: 'Grab',
        amount: 420,
        category: 'Uncategorized',
        reviewed: false,
      },
      {
        id: 'txn_002',
        date: '2026-06-07',
        merchant: 'Cafe',
        amount: 250,
        category: 'Food',
        reviewed: true,
      },
    ],
  },
}
