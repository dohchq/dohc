/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import type { AppDescriptor, AppDescriptorError } from './apps'

const modules = import.meta.glob('./**/*.ts')

const W = 'ws_apps'

function assertDescriptor(
  value: AppDescriptor | AppDescriptorError | null,
): asserts value is AppDescriptor {
  expect(value).not.toBeNull()
  expect(value).not.toMatchObject({ ok: false })
  if (!value || 'ok' in value) throw new Error('expected app descriptor')
}

async function seedAtom(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body = '',
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('atoms', {
      workspaceId,
      path,
      body,
      updatedAt: Date.now(),
    })
  })
}

async function readPaths(t: ReturnType<typeof convexTest>, workspaceId: string) {
  return await t.run(async (ctx) => {
    const atoms = await ctx.db.query('atoms').collect()
    return atoms
      .filter((atom) => atom.workspaceId === workspaceId)
      .map((atom) => atom.path)
      .sort((a, b) => a.localeCompare(b))
  })
}

describe('api.apps.list', () => {
  it('discovers .apps packages with app.json manifests', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, '.apps/home/src/App.tsx')
    await seedAtom(
      t,
      W,
      'finance/.apps/tracker/app.json',
      JSON.stringify({ title: 'Finance Tracker', read: ['.'], write: ['transactions/**'] }),
    )
    await seedAtom(t, W, 'finance/.apps/tracker/src/App.tsx')
    await seedAtom(t, W, 'finance/transactions/2026-06.md', '# June')

    const result = await t.withIdentity({ subject: W }).query(api.apps.list, {})

    expect(result.apps.map((app) => ({
      packageRoot: app.packageRoot,
      scopePath: app.scopePath,
      appName: app.appName,
      title: app.title,
      entryPath: app.entryPath,
      hasConfig: app.hasConfig,
      configStatus: app.configStatus,
      read: app.read,
      write: app.write,
    }))).toEqual([
      {
        packageRoot: '.apps/home',
        scopePath: '',
        appName: 'home',
        title: 'Home',
        entryPath: '.apps/home/src/App.tsx',
        hasConfig: false,
        configStatus: { ok: true },
        read: [''],
        write: [],
      },
      {
        packageRoot: 'finance/.apps/tracker',
        scopePath: 'finance',
        appName: 'tracker',
        title: 'Finance Tracker',
        entryPath: 'finance/.apps/tracker/src/App.tsx',
        hasConfig: true,
        configStatus: { ok: true },
        read: ['finance'],
        write: ['finance/transactions/**'],
      },
    ])
  })

  it('does not discover legacy .views packages through the app API', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, '.views/home/src/App.tsx')
    await seedAtom(t, W, '.views/home/view.json', JSON.stringify({ title: 'Legacy View' }))

    const result = await t.withIdentity({ subject: W }).query(api.apps.list, {})

    expect(result.apps).toEqual([])
  })
})

describe('api.apps.get', () => {
  it('returns one .apps descriptor and rejects legacy package roots', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'clients/acme/.apps/overview/src/App.tsx')

    const app = await t.withIdentity({ subject: W }).query(api.apps.get, {
      packageRoot: 'clients/acme/.apps/overview',
    })
    expect(app).toMatchObject({
      packageRoot: 'clients/acme/.apps/overview',
      scopePath: 'clients/acme',
      appName: 'overview',
      title: 'Overview',
      entryPath: 'clients/acme/.apps/overview/src/App.tsx',
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.apps.get, {
        packageRoot: 'clients/acme/.views/overview',
      }),
    ).resolves.toBeNull()
  })

  it('strictly resolves app.json collection and database scopes', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'finance/.apps/tracker/src/App.tsx')
    await seedAtom(
      t,
      W,
      'finance/.apps/tracker/app.json',
      JSON.stringify({
        title: 'Finance Tracker',
        read: ['transactions/**', 'ledger.sqlite'],
        write: ['transactions/**', 'ledger.sqlite'],
        collections: {
          transactions: {
            source: 'transactions/*.md',
            write: 'transactions/**',
          },
        },
        databases: {
          ledger: {
            path: 'ledger.sqlite',
            write: true,
          },
        },
      }),
    )

    const app = await t.withIdentity({ subject: W }).query(api.apps.get, {
      packageRoot: 'finance/.apps/tracker',
    })

    expect(app).toMatchObject({
      packageRoot: 'finance/.apps/tracker',
      configStatus: { ok: true },
      read: ['finance/transactions/**', 'finance/ledger.sqlite'],
      write: ['finance/transactions/**', 'finance/ledger.sqlite'],
      collections: {
        transactions: {
          source: ['finance/transactions/*.md'],
          write: ['finance/transactions/**'],
        },
      },
      databases: {
        ledger: {
          path: 'finance/ledger.sqlite',
          write: true,
        },
      },
      writeTargets: [
        'finance/ledger.sqlite',
        'finance/transactions/**',
      ],
    })
    assertDescriptor(app)
    expect(app?.trustKey).toContain('finance/.apps/tracker')
  })

  it('marks invalid manifests as diagnostics instead of resolved capabilities', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'finance/.apps/tracker/src/App.tsx')
    await seedAtom(
      t,
      W,
      'finance/.apps/tracker/app.json',
      JSON.stringify({
        title: 'Finance Tracker',
        read: ['transactions/**'],
        write: ['transactions/**'],
        collections: {
          leaks: { source: '../private/*.md' },
        },
      }),
    )

    const app = await t.withIdentity({ subject: W }).query(api.apps.get, {
      packageRoot: 'finance/.apps/tracker',
    })

    expect(app).toMatchObject({
      configStatus: {
        ok: false,
        reason: 'invalid-config',
      },
      collections: {},
      databases: {},
      writeTargets: [],
    })
    assertDescriptor(app)
    expect(app?.trustKey).toBeNull()
  })

  it('fails closed instead of resolving descriptors from capped partial scans', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'finance/.apps/tracker/src/App.tsx', 'export default function App() {}')
    for (let index = 0; index < 5001; index += 1) {
      await seedAtom(t, W, `archive/${String(index).padStart(4, '0')}.md`, '# Archive')
    }
    await seedAtom(
      t,
      W,
      'finance/.apps/tracker/app.json',
      JSON.stringify({ title: 'Finance Tracker', read: ['rules.md'], write: [] }),
    )

    await expect(
      t.withIdentity({ subject: W }).query(api.apps.get, {
        packageRoot: 'finance/.apps/tracker',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'source-scan-truncated',
    })
  })
})

describe('api.apps.getSourceFiles', () => {
  it('fails closed instead of returning partial packages when the workspace scan is capped', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'finance/.apps/tracker/app.json', JSON.stringify({ title: 'Finance Tracker' }))
    await seedAtom(t, W, 'finance/.apps/tracker/src/App.tsx', "export default function App() { return <main /> }")
    for (let index = 0; index < 5001; index += 1) {
      await seedAtom(t, W, `archive/${String(index).padStart(4, '0')}.md`, '# Archive')
    }

    await expect(
      t.withIdentity({ subject: W }).query(api.apps.getSourceFiles, {
        packageRoot: 'finance/.apps/tracker',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'source-scan-truncated',
    })
  })
})

describe('api.apps.migrateLegacyViewsToApps', () => {
  it('moves legacy view package atoms into the app convention', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, 'finance/.views/tracker/view.json', JSON.stringify({ title: 'Tracker' }))
    await seedAtom(t, W, 'finance/.views/tracker/src/App.tsx', 'export default function App() {}')
    await seedAtom(t, W, 'finance/.views/tracker/src/styles.css', 'main { color: red }')

    const result = await t.withIdentity({ subject: W }).mutation(
      api.apps.migrateLegacyViewsToApps,
      {},
    )

    expect(result).toEqual({
      ok: true,
      migratedPackages: 1,
      migratedAtoms: 3,
    })
    expect(await readPaths(t, W)).toEqual([
      'finance/.apps/tracker/app.json',
      'finance/.apps/tracker/src/App.tsx',
      'finance/.apps/tracker/src/styles.css',
    ])
  })

  it('refuses to migrate when a target app path already exists', async () => {
    const t = convexTest(schema, modules)
    await seedAtom(t, W, '.views/home/view.json', JSON.stringify({ title: 'Legacy Home' }))
    await seedAtom(t, W, '.views/home/src/App.tsx', 'legacy')
    await seedAtom(t, W, '.apps/home/src/App.tsx', 'existing')

    const result = await t.withIdentity({ subject: W }).mutation(
      api.apps.migrateLegacyViewsToApps,
      {},
    )

    expect(result).toEqual({
      ok: false,
      code: 'target-exists',
      message: 'Cannot migrate legacy view package because the target app path already exists.',
      packageRoot: '.views/home',
      targetPackageRoot: '.apps/home',
      targetPath: '.apps/home/src/App.tsx',
    })
    expect(await readPaths(t, W)).toEqual([
      '.apps/home/src/App.tsx',
      '.views/home/src/App.tsx',
      '.views/home/view.json',
    ])
  })
})
