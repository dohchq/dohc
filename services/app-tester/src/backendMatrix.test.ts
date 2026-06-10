import { describe, expect, it } from "vitest";
import { runAppTest, type RunAppTestInput } from "./runAppTest";

const financeTracker = `
import { dohc, useDatabase } from '@dohc/app'

export default function App() {
  const ledger = useDatabase('ledger.sqlite')
  const transactions = ledger?.transactions ?? []
  const reviewed = transactions.filter((row) => row.reviewed === 'Yes').length
  async function addExpense() {
    await dohc.database('ledger.sqlite').table('transactions').insert({
      id: 'txn_003',
      merchant: 'Bookstore',
      amount: 900,
      category: 'Books',
      reviewed: 'No'
    })
  }
  async function categorize() {
    await dohc.database('ledger.sqlite').table('transactions').update('txn_001', {
      category: 'Transport'
    })
  }
  async function markReviewed() {
    await dohc.database('ledger.sqlite').table('transactions').update('txn_001', {
      reviewed: 'Yes'
    })
  }
  return (
    <main>
      <h1>Finance Tracker</h1>
      <strong>{transactions.length} transactions</strong>
      <span>{reviewed} reviewed</span>
      <button onClick={addExpense}>Add expense</button>
      <button onClick={categorize}>Categorize transaction</button>
      <button onClick={markReviewed}>Mark reviewed</button>
    </main>
  )
}
`;

function fixture(backend: "convex" | "postgres"): RunAppTestInput {
  return {
    backend,
    packageRoot: "finance/.apps/tracker",
    files: [
      { relativePath: "app.json", body: JSON.stringify({
        title: "Finance Tracker",
        collections: {
          ledger: {
            source: "ledger.sqlite",
            format: "sqlite",
            table: "transactions",
            key: "id",
          },
        },
        databases: { ledger: { path: "ledger.sqlite", write: true } },
        tests: [
          { name: "add expense", collection: "ledger" },
          { name: "categorize transaction", collection: "ledger" },
          { name: "mark reviewed", collection: "ledger" },
        ],
      }) },
      { relativePath: "src/App.tsx", body: financeTracker },
    ],
    manifest: {
      collections: {
        ledger: {
          source: "ledger.sqlite",
          format: "sqlite",
          table: "transactions",
          key: "id",
        },
      },
      databases: { ledger: { path: "ledger.sqlite", write: true } },
      tests: [
        { name: "add expense", collection: "ledger" },
        { name: "categorize transaction", collection: "ledger" },
        { name: "mark reviewed", collection: "ledger" },
      ],
    },
    seed: {
      databases: {
        "ledger.sqlite": {
          transactions: [
            {
              id: "txn_001",
              merchant: "Grab",
              amount: 420,
              category: "Uncategorized",
              reviewed: "No",
            },
            {
              id: "txn_002",
              merchant: "Cafe",
              amount: 250,
              category: "Meals",
              reviewed: "Yes",
            },
          ],
        },
      },
    },
    mode: "browser",
  };
}

describe("app tester backend matrix", () => {
  it.each(["convex", "postgres"] as const)(
    "runs the finance tracker workflow against backend=%s",
    async (backend) => {
      const result = await runAppTest(fixture(backend));

      expect(result).toMatchObject({
        ok: true,
        backend,
        packageRoot: "finance/.apps/tracker",
      });
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "compile", status: "ok" }),
          expect.objectContaining({ name: "browser render", status: "ok" }),
          expect.objectContaining({ name: "mutation persistence", status: "ok" }),
          expect.objectContaining({ name: "manifest tests", status: "ok" }),
        ]),
      );
    },
  );
});
