/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import { runAppTest } from '../../../services/app-tester/src/runAppTest'
import { computeAppSourceDigest } from './appSourceDigest'
import { createSqliteEngine } from '../../../services/sqlite-worker/src/sqliteEngine'

const modules = import.meta.glob('./**/*.ts')
const ALICE = 'ws_review_fixes_alice'
const BOB = 'ws_review_fixes_bob'
const HOCUSPOCUS_URL = 'http://hocuspocus.local'
const HOCUSPOCUS_TOKEN = 'hocuspocus-token'
const APP_TESTER_URL = 'http://app-tester.local'
const SQLITE_WORKER_URL = 'http://sqlite-worker.local'
const SQLITE_WORKER_TOKEN = 'sqlite-worker-token'

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Finance Team' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '',
  extra: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('atoms', {
      workspaceId,
      path,
      body,
      updatedAt: Date.now(),
      ...extra,
    })
  })
}

async function registerAsset(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  storageId: string,
  filename = 'ledger.sqlite',
  mediaType = 'application/vnd.sqlite3',
) {
  await t.run(async (ctx) => {
    const metadata = await ctx.db.system.get('_storage', storageId as never)
    await ctx.db.insert('workspaceAssets', {
      workspaceId,
      storageId: storageId as never,
      filename,
      mediaType,
      kind: 'file',
      size: metadata?.size ?? 0,
      sha256: metadata?.sha256,
      purpose: 'workspace',
      createdByUserId: workspaceId,
      createdAt: Date.now(),
    })
  })
}

async function storeBlob(t: ReturnType<typeof convexTest>, body: string, workspaceId = ALICE) {
  const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([body])))
  await registerAsset(t, workspaceId, storageId)
  return storageId
}

async function storeSqliteBlob(t: ReturnType<typeof convexTest>, workspaceId = ALICE) {
  const engine = await createSqliteEngine()
  const materialized = await engine.materialize({ snapshot: ledgerTables })
  if (!materialized.ok) throw new Error(materialized.message)
  const storageId = await t.run(async (ctx) => {
    const bytes = Uint8Array.from(atob(materialized.bytesBase64), (char) => char.charCodeAt(0))
    return await ctx.storage.store(new Blob([bytes]))
  })
  await registerAsset(t, workspaceId, storageId)
  return storageId
}

const ledgerTables = {
  transactions: {
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true },
      { name: 'merchant', type: 'TEXT' },
      { name: 'amount', type: 'REAL' },
      { name: 'reviewed', type: 'INTEGER' },
    ],
    rows: [{ id: 'tx_1', merchant: 'Grab', amount: 420, reviewed: false }],
  },
}

function stubSemanticApply() {
  vi.stubEnv('HOCUSPOCUS_ADMIN_URL', HOCUSPOCUS_URL)
  vi.stubEnv('HOCUSPOCUS_ADMIN_TOKEN', HOCUSPOCUS_TOKEN)
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
      return new Response(JSON.stringify({ ok: true, operationId: body.operationId }))
    }
    return new Response(JSON.stringify({ ok: false, reason: 'unexpected-route' }), { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function stubAppTester() {
  vi.stubEnv('APP_TESTER_URL', APP_TESTER_URL)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === `${APP_TESTER_URL}/test_app`) {
      return new Response(JSON.stringify(await runAppTest(JSON.parse(String(init?.body ?? '{}')))), {
        status: 200,
      })
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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('review blocker regressions', () => {
  it('uses a versioned SHA-256 app freshness digest that includes seeded source data', async () => {
    const base = await computeAppSourceDigest({
      files: [{ relativePath: 'src/App.tsx', body: 'export default function App() { return null }' }],
      seed: { collections: { transactions: [{ id: 'tx_1', amount: 420 }] } },
    })
    const changedSeed = await computeAppSourceDigest({
      files: [{ relativePath: 'src/App.tsx', body: 'export default function App() { return null }' }],
      seed: { collections: { transactions: [{ id: 'tx_1', amount: 421 }] } },
    })

    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(changedSeed).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(changedSeed).not.toBe(base)
  })

  it('does not widen single-segment manifest globs into nested source access', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/app.json', JSON.stringify({
      title: 'Finance Tracker',
      read: ['*.md'],
      write: ['*.md'],
    }))
    await seedAtom(t, workspaceId, 'finance/public.md', '# Public')
    await seedAtom(t, workspaceId, 'finance/private/secrets.md', '# Secret')

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.appData.getAtom, {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        path: 'public.md',
      }),
    ).resolves.toMatchObject({ ok: true })

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.appData.getAtom, {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        path: 'private/secrets.md',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'source-read-not-granted' })
  })

  it('requires app trust before legacy action RPC semantic writes', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/app.json', JSON.stringify({
      title: 'Finance Tracker',
      read: ['notes.md'],
      write: ['notes.md'],
      actions: {
        markReviewed: {
          kind: 'field.set',
          path: 'notes.md',
          field: 'status',
          valueType: 'string',
        },
      },
    }))
    await seedAtom(
      t,
      workspaceId,
      'finance/notes.md',
      ['---', 'id: notes_1', '---', '{status: "open"}'].join('\n'),
    )
    const fetch = stubSemanticApply()

    await expect(
      t.withIdentity({ subject: ALICE }).action(api.appData.runAction, {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        name: 'markReviewed',
        input: { value: 'reviewed' },
        clientMutationId: 'legacy-action-untrusted',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'app-trust-required' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not expose a public collection collaboration mutation that patches atoms.body', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/app.json', JSON.stringify({
      title: 'Finance Tracker',
      read: ['transactions/**'],
      write: ['transactions/**'],
      collections: {
        transactions: { source: 'transactions/*.md', write: 'transactions/**' },
      },
    }))
    await seedAtom(t, workspaceId, 'finance/transactions/open.md', '# Open\n{Merchant: "Lyft"}')
    await t.withIdentity({ subject: ALICE }).mutation(api.appTrust.grant, {
      activeWorkspaceId: workspaceId,
      packageRoot: 'finance/.apps/tracker',
    })

    await expect(
      t.withIdentity({ subject: ALICE }).mutation(api.appCollaboration.insertCollectionRow, {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        collection: 'transactions',
        record: { id: 'tx_2', Merchant: 'Grab' },
        clientMutationId: 'direct-body-write',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'canonical-write-required' })

    const source = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', workspaceId).eq('path', 'finance/transactions/open.md'),
        )
        .unique(),
    )
    expect(source?.body).toBe('# Open\n{Merchant: "Lyft"}')
  })

  it('enforces folder ACLs for app database reads, writes, and app tester seeds', async () => {
    const t = convexTest(schema, modules)
    const workspaceId = await seedOrg(t)
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/src/App.tsx', 'app')
    await seedAtom(t, workspaceId, 'finance/.apps/tracker/app.json', JSON.stringify({
      title: 'Finance Tracker',
      read: ['private/ledger.sqlite'],
      write: ['private/ledger.sqlite'],
      collections: {
        ledger: {
          source: 'private/ledger.sqlite',
          write: 'private/ledger.sqlite',
          format: 'sqlite',
          table: 'transactions',
          key: 'id',
        },
      },
      databases: {
        ledger: { path: 'private/ledger.sqlite', write: true },
      },
    }))
    const storageId = await storeSqliteBlob(t, workspaceId)
    await stubSqliteWorker()
    await t.withIdentity({ subject: ALICE }).action(api.databaseFiles.create, {
      activeWorkspaceId: workspaceId,
      path: 'finance/private/ledger.sqlite',
      storageId,
      filename: 'ledger.sqlite',
      size: 20,
      mediaType: 'application/vnd.sqlite3',
    })
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: workspaceId,
      folderPath: 'finance/private',
      mode: 'private',
    })
    await t.withIdentity({ subject: BOB }).mutation(api.appTrust.grant, {
      activeWorkspaceId: workspaceId,
      packageRoot: 'finance/.apps/tracker',
    })

    await expect(
      t.withIdentity({ subject: BOB }).query(api.databaseFiles.appQuery, {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        path: 'private/ledger.sqlite',
        sql: 'select * from transactions',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-read-not-authorized' })

    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.databaseOps.appApply, {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
        databasePath: 'private/ledger.sqlite',
        operationId: 'bob-db-denied',
        expectedVersion: 1,
        op: 'insert',
        table: 'transactions',
        rowId: 'tx_2',
        payload: { id: 'tx_2', merchant: 'Cafe' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'database-read-not-authorized' })

    await expect(
      t.withIdentity({ subject: BOB }).action(api.appTesting.testApp, {
        activeWorkspaceId: workspaceId,
        packageRoot: 'finance/.apps/tracker',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'source-read-not-authorized' })
  })

  it('rejects fake SQLite bytes even when the caller supplies a plausible snapshot', async () => {
    const t = convexTest(schema, modules)
    const storageId = await storeBlob(t, 'not really sqlite')

    await expect(
      t.withIdentity({ subject: ALICE }).action(api.databaseFiles.create, {
        path: 'finance/fake.sqlite',
        storageId,
        filename: 'fake.sqlite',
        size: 17,
        mediaType: 'application/vnd.sqlite3',
        sha256: 'caller-supplied',
        tables: ledgerTables,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-sqlite-file' })
  })

  it('requires current app source digest before onboarding can finish', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, ALICE, '.context/me.md', '# Ice\nFinance operator')
    await seedAtom(t, ALICE, 'expenses.md', '# Expenses\n- Grab 420')
    await seedAtom(
      t,
      ALICE,
      '.runs/setup.md',
      [
        '# Setup Run',
        '## Objective',
        'Track expenses',
        '## Sources',
        'expenses.md',
        '## View',
        'finance/.apps/tracker',
        '## What I know',
        'Expenses matter',
        '## What I need',
        'Current app test',
        '## Next Action',
        'Run test_app',
      ].join('\n'),
    )
    await seedAtom(t, ALICE, 'finance/.apps/tracker/app.json', JSON.stringify({
      title: 'Finance Tracker',
      read: ['transactions/**'],
      write: ['transactions/**'],
    }))
    const appSourceId = await seedAtom(
      t,
      ALICE,
      'finance/.apps/tracker/src/App.tsx',
      "import { useCollection } from '@dohc/app'; export default function App(){ useCollection('transactions'); return <main>Useful</main> }",
    )
    const manifestTrustKey = JSON.stringify({
      packageRoot: 'finance/.apps/tracker',
      write: ['finance/transactions/**'],
      actions: [],
      collections: {},
      databases: {},
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('appTestResults', {
        workspaceId: ALICE,
        actorUserId: ALICE,
        packageRoot: 'finance/.apps/tracker',
        manifestTrustKey,
        sourceDigest: 'stale-digest',
        mode: 'browser',
        ok: true,
        result: { ok: true },
        createdAt: Date.now(),
      })
      await ctx.db.patch(appSourceId, {
        body: "import { useCollection } from '@dohc/app'; export default function App(){ useCollection('transactions'); return <main>Changed</main> }",
        updatedAt: Date.now() + 1,
      })
    })

    await expect(
      t.withIdentity({ subject: ALICE }).mutation(api.onboarding.completeIfReady, {}),
    ).rejects.toThrow(/run test_app/)
  })
})
