/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_app_testing_alice'
const BOB = 'ws_app_testing_bob'
const APP_TESTER_URL = 'http://app-tester.local'
const APP_TESTER_TOKEN = 'app-tester-token'

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
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', { workspaceId, path, body, updatedAt: Date.now() })
  })
}

async function seedFinanceTracker(t: ReturnType<typeof convexTest>, workspaceId: string) {
  const manifestBody = JSON.stringify({
    title: 'Finance Tracker',
    entry: 'src/App.tsx',
    read: ['transactions/**'],
    write: ['transactions/**'],
    collections: {
      transactions: {
        source: 'transactions/*.md',
        write: 'transactions/*.md',
        format: 'markdown-table',
        key: 'ID',
      },
    },
    tests: [{ name: 'add expense' }],
  })
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/tracker/app.json',
    `---
id: finance.apps.tracker.manifest
---
${manifestBody}`,
  )
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/tracker/src/App.tsx',
    [
      '---',
      'id: finance.apps.tracker.source',
      '---',
      "import { dohc, useCollection } from '@dohc/app'",
      'export default function App() {',
      "  const transactions = useCollection('transactions')",
      '  return <main>{transactions.length}<button onClick={() => dohc.collection("transactions").insert({ ID: "txn_003" })}>Add expense</button></main>',
      '}',
    ].join('\n'),
  )
  await seedAtom(
    t,
    workspaceId,
    'finance/transactions/2026-06.md',
    [
      '# June 2026 Transactions',
      '',
      '| ID | Merchant | Amount | Reviewed |',
      '|---|---|---:|---|',
      '| txn_001 | Grab | 420 | No |',
      '| txn_002 | Cafe | 250 | Yes |',
    ].join('\n'),
  )
}

async function seedDocBackedApp(t: ReturnType<typeof convexTest>, workspaceId: string) {
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/rules/app.json',
    JSON.stringify({
      title: 'Rules App',
      entry: 'src/App.tsx',
      read: ['rules.md'],
      write: [],
      tests: [{ name: 'reads rules doc' }],
    }),
  )
  await seedAtom(
    t,
    workspaceId,
    'finance/.apps/rules/src/App.tsx',
    [
      "import { useDoc } from '@dohc/app'",
      'export default function App() {',
      "  const rules = useDoc('rules.md')",
      '  return <main>{rules.body}</main>',
      '}',
    ].join('\n'),
  )
  await seedAtom(t, workspaceId, 'finance/rules.md', '# Rules\n- Review uncategorized transactions weekly.')
}

function stubAppTester(result: Record<string, unknown> = { ok: true }) {
  vi.stubEnv('APP_TESTER_URL', APP_TESTER_URL)
  vi.stubEnv('APP_TESTER_TOKEN', APP_TESTER_TOKEN)
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe(`${APP_TESTER_URL}/test_app`)
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${APP_TESTER_TOKEN}`,
      'content-type': 'application/json',
    })
    return new Response(JSON.stringify({
      packageRoot: 'finance/.apps/tracker',
      checks: [],
      failures: [],
      ...result,
    }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('appTesting', () => {
  it('calls the app tester with source files, manifest tests, and authorized source-backed rows', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedFinanceTracker(t, orgId)
    const fetch = stubAppTester({ ok: true })

    const result = await t.withIdentity({ subject: ALICE }).action(api.appTesting.testApp, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
      mode: 'browser',
    })

    expect(result).toMatchObject({ ok: true, packageRoot: 'finance/.apps/tracker' })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(body).toMatchObject({
      packageRoot: 'finance/.apps/tracker',
      mode: 'browser',
      seed: {
        collections: {
          transactions: [
            expect.objectContaining({ id: 'txn_001', Merchant: 'Grab', sourcePath: 'finance/transactions/2026-06.md' }),
            expect.objectContaining({ id: 'txn_002', Merchant: 'Cafe', sourcePath: 'finance/transactions/2026-06.md' }),
          ],
        },
      },
    })
    expect(body.files).toEqual([
      expect.objectContaining({ relativePath: 'app.json' }),
      expect.objectContaining({ relativePath: 'src/App.tsx' }),
    ])
    expect(body.files.find((file: { relativePath: string }) => file.relativePath === 'app.json')?.body)
      .not.toContain('finance.apps.tracker.manifest')
    expect(body.files.find((file: { relativePath: string }) => file.relativePath === 'src/App.tsx')?.body)
      .toMatch(/^import \{ dohc, useCollection \} from '@dohc\/app'/)
    expect(body.files.find((file: { relativePath: string }) => file.relativePath === 'src/App.tsx')?.body)
      .not.toContain('finance.apps.tracker.source')
    expect(body.manifest.tests).toEqual([{ name: 'add expense' }])

    const latest = await t.withIdentity({ subject: ALICE }).query(api.appTesting.latestResult, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
    })
    expect(latest).toMatchObject({ ok: true, packageRoot: 'finance/.apps/tracker' })

    await seedAtom(
      t,
      orgId,
      'finance/transactions/2026-07.md',
      [
        '# July 2026 Transactions',
        '',
        '| ID | Merchant | Amount | Reviewed |',
        '|---|---|---:|---|',
        '| txn_003 | Bookstore | 900 | No |',
      ].join('\n'),
    )

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.appTesting.latestResult, {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/tracker',
      }),
    ).resolves.toBeNull()
  })

  it('does not call the app tester when source ACLs hide collection rows', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedFinanceTracker(t, orgId)
    const source = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'finance/transactions/2026-06.md'),
        )
        .unique(),
    )
    await t.withIdentity({ subject: ALICE }).mutation(api.atomAccess.setAtomAccess, {
      activeWorkspaceId: orgId,
      atomId: source!._id,
      mode: 'private',
    })
    const fetch = stubAppTester()

    const result = await t.withIdentity({ subject: BOB }).action(api.appTesting.testApp, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/tracker',
      mode: 'static',
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'source-read-not-authorized',
      deniedSources: ['finance/transactions/2026-06.md'],
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('seeds authorized docs into app tests and stales results when doc sources change', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)
    await seedDocBackedApp(t, orgId)
    const fetch = stubAppTester({ ok: true })

    const result = await t.withIdentity({ subject: ALICE }).action(api.appTesting.testApp, {
      activeWorkspaceId: orgId,
      packageRoot: 'finance/.apps/rules',
      mode: 'browser',
    })

    expect(result).toMatchObject({ ok: true })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(body.seed.docs).toEqual({
      'rules.md': '# Rules\n- Review uncategorized transactions weekly.',
    })

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.appTesting.latestResult, {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/rules',
      }),
    ).resolves.toMatchObject({ ok: true })

    const rules = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'finance/rules.md'),
        )
        .unique(),
    )
    await t.run(async (ctx) => {
      await ctx.db.patch(rules!._id, {
        body: '# Rules\n- Review uncategorized and transport transactions daily.',
        updatedAt: Date.now() + 1,
      })
    })

    await expect(
      t.withIdentity({ subject: ALICE }).query(api.appTesting.latestResult, {
        activeWorkspaceId: orgId,
        packageRoot: 'finance/.apps/rules',
      }),
    ).resolves.toBeNull()
  })
})
