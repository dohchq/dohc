/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import { runAppTest } from '../../../services/app-tester/src/runAppTest'
import {
  financeTrackerAppSource,
  financeTrackerManifest,
  financeTrackerSqliteAppSource,
  financeTrackerSqliteManifest,
  financeTrackerSqliteTables,
} from '../src/apps/fixtures/financeTrackerApp'
import { createSqliteEngine } from '../../../services/sqlite-worker/src/sqliteEngine'

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_finance_tracker_acceptance'
const APP_TESTER_URL = 'http://app-tester.local'
const HOCUSPOCUS_URL = 'http://hocuspocus.local'
const HOCUSPOCUS_TOKEN = 'hocuspocus-token'
const SQLITE_WORKER_URL = 'http://sqlite-worker.local'
const SQLITE_WORKER_TOKEN = 'sqlite-worker-token'

const transactionsMarkdown = [
  '# June 2026 Transactions',
  '',
  '| ID | Date | Merchant | Amount | Category | Reviewed |',
  '|---|---|---|---:|---|---|',
  '| txn_001 | 2026-06-06 | Grab | 420 | Uncategorized | No |',
  '| txn_002 | 2026-06-07 | Cafe | 250 | Food | Yes |',
].join('\n')

const categoriesMarkdown = [
  '# Categories',
  '',
  '| Name | Budget |',
  '|---|---:|',
  '| Transport | 5000 |',
  '| Food | 7000 |',
  '| Learning | 2500 |',
].join('\n')

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: string,
  updatedAt = Date.now(),
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', {
      workspaceId: W,
      path,
      body,
      updatedAt,
      source: 'agent',
    })
  })
}

async function storeSqliteBlob(t: ReturnType<typeof convexTest>) {
  const engine = await createSqliteEngine()
  const materialized = await engine.materialize({ snapshot: financeTrackerSqliteTables })
  if (!materialized.ok) throw new Error(materialized.message)
  return await t.run(async (ctx) => {
    const bytes = Uint8Array.from(atob(materialized.bytesBase64), (char) => char.charCodeAt(0))
    const storageId = await ctx.storage.store(new Blob([bytes]))
    const metadata = await ctx.db.system.get('_storage', storageId)
    await ctx.db.insert('workspaceAssets', {
      workspaceId: W,
      storageId,
      filename: 'ledger.sqlite',
      mediaType: 'application/vnd.sqlite3',
      kind: 'file',
      size: metadata?.size ?? 0,
      sha256: metadata?.sha256,
      purpose: 'workspace',
      createdByUserId: W,
      createdAt: Date.now(),
    })
    return storageId
  })
}

async function grantTrackerTrust(t: ReturnType<typeof convexTest>) {
  await t.withIdentity({ subject: W }).mutation(api.appTrust.grant, {
    packageRoot: 'finance/.apps/tracker',
  })
}

function stubAppTester() {
  vi.stubEnv('APP_TESTER_URL', APP_TESTER_URL)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === `${APP_TESTER_URL}/test_app`) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify(await runAppTest(body)), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected-url' }), { status: 404 })
  }))
}

async function stubSqliteWorker() {
  const engine = await createSqliteEngine()
  vi.stubEnv('SQLITE_WORKER_URL', SQLITE_WORKER_URL)
  vi.stubEnv('SQLITE_WORKER_TOKEN', SQLITE_WORKER_TOKEN)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (String(url) === `${SQLITE_WORKER_URL}/ingest`) {
      return new Response(JSON.stringify(await engine.ingest({ bytesBase64: String(body.bytesBase64 ?? '') })), { status: 200 })
    }
    if (String(url) === `${SQLITE_WORKER_URL}/materialize`) {
      return new Response(JSON.stringify(await engine.materialize({ snapshot: body.snapshot as never })), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected-url' }), { status: 404 })
  }))
}

function stubSemanticApply() {
  vi.stubEnv('HOCUSPOCUS_ADMIN_URL', HOCUSPOCUS_URL)
  vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', HOCUSPOCUS_TOKEN)
  const replacements: Array<{ expectedText: string; replacement: string }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (String(url).endsWith('/createAnchorsForText')) {
      return new Response(JSON.stringify({
        ok: true,
        anchorStart: `start:${body.expectedText}`,
        anchorEnd: `end:${body.expectedText}`,
      }))
    }
    if (String(url).endsWith('/replaceRange')) {
      replacements.push({
        expectedText: String(body.expectedText ?? ''),
        replacement: String(body.replacement ?? ''),
      })
      return new Response(JSON.stringify({ ok: true, operationId: body.operationId }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, reason: 'unexpected-route' }), { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, replacements }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('finance tracker generated app acceptance', () => {
  it('adds expenses, categorizes transactions, marks reviewed, persists source-backed markdown, reloads, and passes test_app', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, 'finance/transactions/2026-06.md', transactionsMarkdown, 100)
    await seedAtom(t, 'finance/categories.md', categoriesMarkdown)
    await seedAtom(t, 'finance/rules.md', '# Rules\n- Review uncategorized transactions weekly.')
    await seedAtom(t, 'finance/.apps/tracker/app.json', JSON.stringify(financeTrackerManifest))
    await seedAtom(t, 'finance/.apps/tracker/src/App.tsx', financeTrackerAppSource)
    await grantTrackerTrust(t)
    stubAppTester()

    await expect(
      t.withIdentity({ subject: W }).action(api.appTesting.testApp, {
        packageRoot: 'finance/.apps/tracker',
        mode: 'browser',
      }),
    ).resolves.toMatchObject({ ok: true })

    const semantic = stubSemanticApply()
    await expect(
      t.withIdentity({ subject: W }).action(api.appData.runCollectionMutation, {
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'insert',
        record: {
          ID: 'txn_003',
          Date: '2026-06-08',
          Merchant: 'Bookstore',
          Amount: 900,
          Category: 'Learning',
          Reviewed: 'No',
        },
        clientMutationId: 'accept-add-expense',
        expectedSourceRevision: '100',
      }),
    ).resolves.toMatchObject({ ok: true, operation: 'collection.insert' })

    await expect(
      t.withIdentity({ subject: W }).action(api.appData.runCollectionMutation, {
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'update',
        id: 'txn_001',
        patch: { Category: 'Transport' },
        clientMutationId: 'accept-categorize',
        expectedSourceRevision: '100',
      }),
    ).resolves.toMatchObject({ ok: true, operation: 'collection.update' })

    await expect(
      t.withIdentity({ subject: W }).action(api.appData.runCollectionMutation, {
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        op: 'update',
        id: 'txn_001',
        patch: { Reviewed: 'Yes' },
        clientMutationId: 'accept-review',
        expectedSourceRevision: '100',
      }),
    ).resolves.toMatchObject({ ok: true, operation: 'collection.update' })

    expect(semantic.replacements).toEqual([
      expect.objectContaining({
        replacement: expect.stringContaining('| txn_003 | 2026-06-08 | Bookstore | 900 | Learning | No |'),
      }),
      expect.objectContaining({
        expectedText: '| txn_001 | 2026-06-06 | Grab | 420 | Uncategorized | No |',
        replacement: '| txn_001 | 2026-06-06 | Grab | 420 | Transport | No |',
      }),
      expect.objectContaining({
        expectedText: '| txn_001 | 2026-06-06 | Grab | 420 | Uncategorized | No |',
        replacement: '| txn_001 | 2026-06-06 | Grab | 420 | Uncategorized | Yes |',
      }),
    ])

    const provenance = await t.run(async (ctx) =>
      ctx.db
        .query('appProvenance')
        .withIndex('by_workspace_app', (q) =>
          q.eq('workspaceId', W).eq('packageRoot', 'finance/.apps/tracker'),
        )
        .collect(),
    )
    expect(provenance.map((row) => row.clientMutationId).sort()).toEqual([
      'accept-add-expense',
      'accept-categorize',
      'accept-review',
    ])
  })

  it('opens a SQLite ledger, reads it as a collection, mutates rows transactionally, logs operations, and passes test_app', async () => {
    const t = convexTest(schema, modules)
    expect(financeTrackerSqliteAppSource).toContain("dohc.database('ledger.sqlite').table('transactions')")
    expect(financeTrackerSqliteAppSource).not.toContain("dohc.collection('ledger')")
    await seedAtom(t, 'finance/.apps/tracker/app.json', JSON.stringify(financeTrackerSqliteManifest))
    await seedAtom(t, 'finance/.apps/tracker/src/App.tsx', financeTrackerSqliteAppSource)
    const storageId = await storeSqliteBlob(t)
    await stubSqliteWorker()
    await t.withIdentity({ subject: W }).action(api.databaseFiles.create, {
      path: 'finance/ledger.sqlite',
      storageId,
      filename: 'ledger.sqlite',
      size: 24,
      mediaType: 'application/vnd.sqlite3',
    })
    await grantTrackerTrust(t)
    stubAppTester()

    await expect(
      t.withIdentity({ subject: W }).action(api.appTesting.testApp, {
        packageRoot: 'finance/.apps/tracker',
        mode: 'browser',
      }),
    ).resolves.toMatchObject({ ok: true })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.tables, {
        path: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({
      ok: true,
      tables: [expect.objectContaining({ name: 'transactions' })],
    })
    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.appCollectionRows, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        collection: 'ledger',
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: expect.arrayContaining([
        expect.objectContaining({ id: 'txn_001', merchant: 'Grab' }),
      ]),
    })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'sqlite-add-expense',
        expectedVersion: 1,
        op: 'insert',
        table: 'transactions',
        rowId: 'txn_003',
        payload: {
          id: 'txn_003',
          date: '2026-06-08',
          merchant: 'Bookstore',
          amount: 900,
          category: 'Learning',
          reviewed: false,
        },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2 })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'sqlite-categorize',
        expectedVersion: 2,
        op: 'update',
        table: 'transactions',
        rowId: 'txn_001',
        payload: { category: 'Transport' },
      }),
    ).resolves.toMatchObject({ ok: true, version: 3 })

    await expect(
      t.withIdentity({ subject: W }).mutation(api.databaseOps.appApply, {
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'ledger.sqlite',
        operationId: 'sqlite-review',
        expectedVersion: 3,
        op: 'update',
        table: 'transactions',
        rowId: 'txn_001',
        payload: { reviewed: true },
      }),
    ).resolves.toMatchObject({ ok: true, version: 4 })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'finance/ledger.sqlite',
        sql: 'select * from transactions where id = ?',
        params: ['txn_001'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'txn_001', category: 'Transport', reviewed: true })],
    })
    await expect(
      t.withIdentity({ subject: W }).query(api.databaseOps.list, {
        databasePath: 'finance/ledger.sqlite',
      }),
    ).resolves.toMatchObject({
      ok: true,
      ops: [
        expect.objectContaining({ operationId: 'sqlite-add-expense', version: 2 }),
        expect.objectContaining({ operationId: 'sqlite-categorize', version: 3 }),
        expect.objectContaining({ operationId: 'sqlite-review', version: 4 }),
      ],
    })
  })
})
