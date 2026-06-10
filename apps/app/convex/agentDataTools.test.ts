/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const W = 'ws_agent_data_tools'
const ALICE = 'ws_agent_data_alice'
const BOB = 'ws_agent_data_bob'
const SQLITE_URL = 'http://sqlite-worker.local'
const SQLITE_TOKEN = 'sqlite-token'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Agent Data Org' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

async function storedCsvAsset(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  body: string,
) {
  const storageId = await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([body], { type: 'text/csv' }))
  })
  await t.run(async (ctx) => {
    const metadata = await ctx.db.system.get('_storage', storageId as never)
    await ctx.db.insert('workspaceAssets', {
      workspaceId,
      storageId: storageId as never,
      path,
      filename: path.split('/').pop() ?? 'upload.csv',
      mediaType: 'text/csv',
      kind: 'file',
      size: metadata?.size ?? body.length,
      sha256: metadata?.sha256,
      purpose: 'workspace',
      createdByUserId: workspaceId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    })
  })
}

async function storedDatabaseFile(
  t: ReturnType<typeof convexTest>,
  workspaceId: string,
  path: string,
  createdByUserId: string,
) {
  const storageId = await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob(['SQLite format 3\0'], {
      type: 'application/vnd.sqlite3',
    }))
  })
  await t.run(async (ctx) => {
    await ctx.db.insert('databaseFiles', {
      workspaceId,
      storageId: storageId as never,
      path,
      filename: path.split('/').pop() ?? 'ledger.sqlite',
      size: 16,
      canonicalFormat: 'structured-snapshot',
      bytesOutOfDate: false,
      version: 1,
      tables: {
        transactions: {
          columns: [
            { name: 'id', type: 'TEXT', primaryKey: true },
            { name: 'amount', type: 'REAL' },
          ],
          rows: [{ id: 'tx_1', amount: 1 }],
        },
      },
      createdByUserId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
}

function stubImportWorker() {
  vi.stubEnv('SQLITE_WORKER_URL', SQLITE_URL)
  vi.stubEnv('SQLITE_WORKER_TOKEN', SQLITE_TOKEN)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${SQLITE_TOKEN}`,
      'content-type': 'application/json',
    })
    const input = JSON.parse(String(init?.body ?? '{}'))
    if (String(url) !== `${SQLITE_URL}/import-data`) {
      return new Response(JSON.stringify({ ok: false, code: 'unexpected-url' }), { status: 404 })
    }
    const tableName = String(input.tableName ?? 'rows')
    const body = String(input.body ?? '')
    const rows = input.mediaType === 'application/json'
      ? JSON.parse(body)
      : input.mediaType === 'application/pdf'
        ? [{ id: 'line_1', item: 'notebook', amount: 7.5 }]
        : [{ id: 'tx_1', merchant: 'Grab', amount: 420 }]
    return new Response(JSON.stringify({
      ok: true,
      tableName,
      rowCount: rows.length,
      sourceHash: `hash:${body.length}`,
      tableSchema: [
        { name: 'id', type: 'TEXT', primaryKey: true },
        ...Object.keys(rows[0] ?? {})
          .filter((name) => name !== 'id')
          .map((name) => ({ name, type: typeof rows[0][name] === 'number' ? 'REAL' : 'TEXT' })),
      ],
      snapshot: {
        [tableName]: {
          columns: [
            { name: 'id', type: 'TEXT', primaryKey: true },
            ...Object.keys(rows[0] ?? {})
              .filter((name) => name !== 'id')
              .map((name) => ({ name, type: typeof rows[0][name] === 'number' ? 'REAL' : 'TEXT' })),
          ],
          rows,
        },
      },
      operation: {
        op: 'import_data',
        table: tableName,
        rowCount: rows.length,
        sourceHash: `hash:${body.length}`,
      },
      bytesBase64: Buffer.from('SQLite format 3\0imported').toString('base64'),
      size: 24,
      sha256: 'sqlite-hash',
    }), { status: 200 })
  }))
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('agent-native file tools', () => {
  it('saves generated CSV, TXT, and JSON files as atoms', async () => {
    const t = convexTest(schema, modules)

    for (const input of [
      {
        path: 'generated/report.csv',
        mediaType: 'text/csv',
        content: 'id,name\n1,Ice',
      },
      {
        path: 'generated/notes.txt',
        mediaType: 'text/plain',
        content: 'plain text',
      },
      {
        path: 'generated/rows.json',
        mediaType: 'application/json',
        content: JSON.stringify([{ id: 'row_1' }]),
      },
    ]) {
      await expect(
        t.mutation((internal as any).agent._saveFileForAgent, {
          workspaceId: W,
          actorUserId: W,
          ...input,
        }),
      ).resolves.toMatchObject({
        ok: true,
        path: input.path,
        kind: 'atom',
      })
    }

    const atoms = await t.run(async (ctx) =>
      ctx.db.query('atoms').withIndex('by_workspace', (q) => q.eq('workspaceId', W)).collect(),
    )
    expect(atoms.map((atom) => [atom.path, atom.body]).sort()).toEqual([
      ['generated/notes.txt', '---\nid: generated.notes\n---\nplain text'],
      ['generated/report.csv', '---\nid: generated.report\n---\nid,name\n1,Ice'],
      [
        'generated/rows.json',
        `---\nid: generated.rows\n---\n${JSON.stringify([{ id: 'row_1' }])}`,
      ],
    ])
  })

  it('rejects elevated generated files and classifies by exact media subtype or extension', async () => {
    const t = convexTest(schema, modules)

    await expect(
      t.mutation((internal as any).agent._saveFileForAgent, {
        workspaceId: W,
        actorUserId: W,
        path: '.skills/shortcut.md',
        mediaType: 'text/markdown',
        content: '---\ntype: skill\n---\n# Shortcut\n',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'elevated-path-not-authorized',
    })

    await expect(
      t.mutation((internal as any).agent._saveFileForAgent, {
        workspaceId: W,
        actorUserId: W,
        path: 'generated/not-json.txt',
        mediaType: 'application/problem+jsonish',
        content: 'plain text',
      }),
    ).resolves.toMatchObject({
      ok: true,
      atomKind: 'text',
    })
  })

  it('enforces workspace and actor authorization at the data-tool boundaries', async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrgWithMembers(t)
    const asAlice = t.withIdentity({ subject: ALICE })

    await asAlice.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'private/seed.md',
      body: 'seed',
    })
    await asAlice.mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: orgId,
      folderPath: 'private',
      mode: 'private',
    })

    await expect(
      t.mutation((internal as any).agent._saveFileForAgent, {
        workspaceId: orgId,
        actorUserId: BOB,
        path: 'private/bob-note.txt',
        mediaType: 'text/plain',
        content: 'blocked',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'file-write-not-authorized',
    })

    await expect(
      t.mutation((internal as any).agent._saveFileForAgent, {
        workspaceId: orgId,
        actorUserId: BOB,
        path: 'shared/bob-note.txt',
        mediaType: 'text/plain',
        content: 'allowed',
      }),
    ).resolves.toMatchObject({ ok: true, path: 'shared/bob-note.txt' })

    await expect(
      t.mutation((internal as any).agent._saveFileForAgent, {
        workspaceId: orgId,
        actorUserId: BOB,
        path: 'shared/bob-note.txt',
        mediaType: 'text/plain',
        content: 'duplicate',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'file-exists' })

    const savedAccess = await t.run(async (ctx) => {
      const atom = await ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', orgId).eq('path', 'shared/bob-note.txt'),
        )
        .unique()
      expect(atom).not.toBeNull()
      return await ctx.db
        .query('atomAccess')
        .withIndex('by_atom', (q) => q.eq('atomId', atom!._id))
        .unique()
    })
    expect(savedAccess).toMatchObject({
      mode: 'private',
      ownerUserId: BOB,
    })

    await expect(
      t.withIdentity({ subject: 'ws_agent_data_intruder' }).action((api as any).databaseFiles.importData, {
        activeWorkspaceId: orgId,
        source: {
          kind: 'inline',
          name: 'people.json',
          mediaType: 'application/json',
          body: JSON.stringify([{ id: 'p1' }]),
        },
        target: {
          kind: 'sqlite',
          path: 'people.sqlite',
          tableName: 'people',
        },
        mode: 'infer-schema',
      }),
    ).rejects.toThrow(/Not a member of workspace/)

    await storedDatabaseFile(t, orgId, 'private/ledger.sqlite', ALICE)
    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.databaseOps.apply, {
        activeWorkspaceId: orgId,
        databasePath: 'private/ledger.sqlite',
        operationId: 'op_private_denied',
        expectedVersion: 1,
        op: 'update',
        table: 'transactions',
        rowId: 'tx_1',
        payload: { amount: 2 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'database-write-not-authorized',
    })
  })
})

describe('agent-native data imports', () => {
  it('imports an uploaded CSV asset into a first-class SQLite database', async () => {
    const t = convexTest(schema, modules)
    stubImportWorker()
    await storedCsvAsset(
      t,
      W,
      'uploads/transactions.csv',
      'id,merchant,amount\ntx_1,Grab,420',
    )

    await expect(
      t.withIdentity({ subject: W }).action((api as any).databaseFiles.importData, {
        source: { kind: 'asset', path: 'uploads/transactions.csv' },
        target: {
          kind: 'sqlite',
          path: 'finance/ledger.sqlite',
          tableName: 'transactions',
        },
        mode: 'infer-schema',
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: 'finance/ledger.sqlite',
      tableName: 'transactions',
      rowCount: 1,
      sourceHash: expect.any(String),
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'finance/ledger.sqlite',
        sql: 'select * from transactions',
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'tx_1', merchant: 'Grab', amount: 420 })],
    })
  })

  it('imports inline JSON array data into SQLite', async () => {
    const t = convexTest(schema, modules)
    stubImportWorker()

    await t.withIdentity({ subject: W }).action((api as any).databaseFiles.importData, {
      source: {
        kind: 'inline',
        name: 'people.json',
        mediaType: 'application/json',
        body: JSON.stringify([
          { id: 'p1', name: 'Ice', score: 10 },
          { id: 'p2', name: 'Ada', score: 12 },
        ]),
      },
      target: {
        kind: 'sqlite',
        path: 'people.sqlite',
        tableName: 'people',
      },
      mode: 'infer-schema',
    })

    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'people.sqlite',
        sql: 'select * from people where id = ?',
        params: ['p2'],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'p2', name: 'Ada', score: 12 })],
    })
  })

  it('stores extracted PDF table text as a source atom and imports structured rows when extraction is available', async () => {
    const t = convexTest(schema, modules)
    stubImportWorker()
    const extractedText = '| id | item | amount |\n| --- | --- | ---: |\n| line_1 | notebook | 7.5 |'

    const result = await t.withIdentity({ subject: W }).action((api as any).databaseFiles.importData, {
      source: {
        kind: 'inline',
        name: 'receipt.pdf',
        mediaType: 'application/pdf',
        body: extractedText,
      },
      target: {
        kind: 'sqlite',
        path: 'imports/receipt.sqlite',
        tableName: 'receipt_lines',
      },
      mode: 'infer-schema',
    })

    expect(result).toMatchObject({
      ok: true,
      path: 'imports/receipt.sqlite',
      sourceAtomPath: 'imports/receipt.source.md',
    })
    const sourceAtom = await t.run(async (ctx) =>
      ctx.db
        .query('atoms')
        .withIndex('by_workspace_path', (q) =>
          q.eq('workspaceId', W).eq('path', 'imports/receipt.source.md'),
        )
        .unique(),
    )
    expect(sourceAtom?.body).toContain(extractedText)
    await expect(
      t.withIdentity({ subject: W }).query(api.databaseFiles.query, {
        path: 'imports/receipt.sqlite',
        sql: 'select * from receipt_lines',
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'line_1', item: 'notebook', amount: 7.5 })],
    })
  })

  it('refuses to import private source data into an unrestricted folder without approval', async () => {
    const t = convexTest(schema, modules)
    stubImportWorker()
    const orgId = await seedOrgWithMembers(t)
    const asAlice = t.withIdentity({ subject: ALICE })
    await asAlice.mutation(api.atoms.upsert, {
      activeWorkspaceId: orgId,
      path: 'private/transactions.csv',
      body: 'id,merchant\ntx_1,Grab',
    })
    await asAlice.mutation(api.atomAccess.setFolderAccess, {
      activeWorkspaceId: orgId,
      folderPath: 'private',
      mode: 'private',
    })

    await expect(
      asAlice.action((api as any).databaseFiles.importData, {
        activeWorkspaceId: orgId,
        source: { kind: 'atom', path: 'private/transactions.csv' },
        target: {
          kind: 'sqlite',
          path: 'shared/ledger.sqlite',
          tableName: 'transactions',
        },
        mode: 'infer-schema',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'approval-required',
    })
  })
})
