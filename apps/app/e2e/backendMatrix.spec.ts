import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type {
  Actor,
  AtomKind,
  CreateAtomInput,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
  WriteAtomInput,
} from '@dohc/workspace-contracts'
import { materializeWorkspace, readManifest } from '../../../packages/workspace-fs/src'
import {
  captureWorkspaceShellDiff,
  runWorkspaceShellCommand,
  startWorkspaceShellSession,
} from '../../../services/agent-sandbox/src/server'
import { runAppTest } from '../../../services/app-tester/src/runAppTest'
import { buildAppShell } from '../src/apps/appShell'

type BackendMode = 'convex' | 'postgres'

type Transaction = {
  id: string
  Date: string
  Merchant: string
  Amount: number
  Category: string
  Reviewed: string
}

type MatrixWorkspaceSnapshot = {
  workspace: {
    id: string
    ownerId: string
    backendMode: BackendMode
  }
  walletCsv: string
  transactions: Transaction[]
  files: Record<string, string>
}

type MatrixFile = WorkspaceFile & {
  body: string
}

const backendMode: BackendMode = process.env.DOHC_BACKEND === 'postgres' ? 'postgres' : 'convex'
const actor: Actor = { userId: 'user_1', workspaceId: `ws_backend_matrix_${backendMode}` }

const walletCsv = [
  'id,Date,Merchant,Amount,Category',
  'txn_001,2026-06-01,Grab,420,Uncategorized',
  'txn_002,2026-06-02,Cafe,250,Food',
].join('\n') + '\n'

const financeTrackerSource = `
import { dohc, useCollection } from '@dohc/app'

export default function App() {
  const transactions = useCollection('transactions')
  const total = transactions.reduce((sum, row) => sum + Number(row.Amount || 0), 0)
  async function addExpense() {
    await dohc.collection('transactions').insert({
      id: 'txn_003',
      Date: '2026-06-03',
      Merchant: 'Bookstore',
      Amount: 900,
      Category: 'Learning',
      Reviewed: 'No'
    })
  }
  async function categorizeGrab() {
    await dohc.collection('transactions').update('txn_001', { Category: 'Transport' })
  }
  return (
    <main>
      <h1>Finance Tracker</h1>
      <strong>{total}</strong>
      <button onClick={addExpense}>Add expense</button>
      <button onClick={categorizeGrab}>Categorize Grab</button>
    </main>
  )
}
`

const financeTrackerRuntimeScript = `
  const root = document.getElementById('root')
  const money = (value) => '$' + Number(value).toLocaleString('en-US')
  function setError(message) {
    const alert = document.getElementById('app-error')
    if (alert) alert.textContent = message
  }
  async function refresh() {
    try {
      const rows = await window.dohc.collection('transactions').list()
      const total = rows.reduce((sum, row) => sum + Number(row.Amount || 0), 0)
      root.innerHTML = '<main>' +
        '<h1>Finance Tracker</h1>' +
        '<p data-testid="total">' + money(total) + ' tracked</p>' +
        '<p id="app-error" role="alert"></p>' +
        '<ul>' + rows.map((row) =>
          '<li data-id="' + row.id + '">' +
          row.Merchant + ' ' + money(row.Amount) + ' ' + row.Category + ' reviewed:' + row.Reviewed +
          '</li>'
        ).join('') + '</ul>' +
        '<button id="categorize">Categorize Grab</button>' +
        '<button id="add">Add expense</button>' +
        '</main>'
      document.getElementById('categorize').addEventListener('click', () => run(() =>
        window.dohc.collection('transactions').update('txn_001', { Category: 'Transport' })
      ))
      document.getElementById('add').addEventListener('click', () => run(() =>
        window.dohc.collection('transactions').insert({
          id: 'txn_003',
          Date: '2026-06-03',
          Merchant: 'Bookstore',
          Amount: 900,
          Category: 'Learning',
          Reviewed: 'No',
        })
      ))
    } catch (error) {
      root.innerHTML = '<main><h1>Finance Tracker</h1><p role="alert">Denied: ' +
        String(error && error.message ? error.message : error) +
        '</p></main>'
    }
  }
  async function run(action) {
    try {
      await action()
      await refresh()
    } catch (error) {
      setError(String(error && error.message ? error.message : error))
    }
  }
  refresh()
`

function appFiles(snapshot: MatrixWorkspaceSnapshot) {
  return [
    {
      relativePath: 'app.json',
      body: snapshot.files['finance/.apps/ledger/app.json'],
    },
    {
      relativePath: 'src/App.tsx',
      body: snapshot.files['finance/.apps/ledger/src/App.tsx'],
    },
  ]
}

function textFile(
  path: string,
  body: string,
  workspaceId = actor.workspaceId,
  revision = `rev-${path.replace(/[^a-z0-9]+/gi, '-')}`,
): MatrixFile {
  return {
    id: `atom:${path}`,
    workspaceId,
    path,
    kind: 'atom',
    contentType: contentTypeForPath(path),
    revision,
    updatedAt: 1,
    body,
  }
}

function createMemoryBackend(snapshot: MatrixWorkspaceSnapshot) {
  const files = new Map<string, MatrixFile>(
    Object.entries(snapshot.files).map(([path, body]) => [path, textFile(path, body)]),
  )
  const backend: WorkspaceBackend = {
    async listFiles() {
      return Array.from(files.values()).map(({ body: _body, ...file }) => ({ ...file }))
    },
    async readText(_actor, path) {
      const file = files.get(path)
      if (!file) throw new Error(`missing text file: ${path}`)
      return { body: file.body, revision: file.revision }
    },
    async readAsset() {
      throw new Error('no binary assets in backend matrix fixture')
    },
    async createAtom(_actor, input: CreateAtomInput) {
      const file = textFile(input.path, input.body, actor.workspaceId, 'rev-created')
      file.contentType = contentTypeForAtomKind(input.kind, input.path)
      files.set(input.path, file)
      return { ...file }
    },
    async writeAtom(_actor, input: WriteAtomInput) {
      const file = files.get(input.path)
      if (!file) throw new Error(`missing text file: ${input.path}`)
      if (file.revision !== input.expectedRevision) throw new Error('stale revision')
      file.body = input.body
      file.revision = 'rev-updated'
      file.updatedAt += 1
      return { ...file }
    },
    async saveAsset(_actor, input: SaveAssetInput) {
      const file = textFile(input.path, new TextDecoder().decode(input.bytes), actor.workspaceId, 'rev-asset')
      file.kind = input.kind === 'sqlite' ? 'database' : 'asset'
      file.contentType = input.mediaType
      files.set(input.path, file)
      return { ...file }
    },
    async renameFile(_actor, input) {
      const file = files.get(input.fromPath)
      if (!file) throw new Error(`missing text file: ${input.fromPath}`)
      if (file.revision !== input.expectedRevision) throw new Error('stale revision')
      const folder = input.fromPath.includes('/') ? input.fromPath.slice(0, input.fromPath.lastIndexOf('/')) : ''
      const toPath = folder ? `${folder}/${input.toName}` : input.toName
      files.delete(input.fromPath)
      file.path = toPath
      file.revision = 'rev-renamed'
      files.set(toPath, file)
      return { ...file }
    },
    async deleteFile(_actor, path) {
      files.delete(path)
    },
  }
  return { backend, files }
}

function contentTypeForPath(path: string) {
  if (path.endsWith('.csv')) return 'text/csv'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.tsx')) return 'text/tsx'
  if (path.endsWith('.ts')) return 'text/typescript'
  if (path.endsWith('.js')) return 'text/javascript'
  return 'text/markdown'
}

function contentTypeForAtomKind(kind: AtomKind, path: string) {
  if (kind === 'csv') return 'text/csv'
  if (kind === 'json') return 'application/json'
  if (kind === 'html') return 'text/html'
  if (kind === 'text') return 'text/plain'
  return contentTypeForPath(path)
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test(`dual backend workspace flow stays equivalent in ${backendMode} mode`, async ({ page }) => {
  await page.setContent(`
    <main>
      <h1>dohc backend matrix</h1>
      <button id="create-workspace">Create workspace</button>
      <button id="upload-wallet" disabled>Upload wallet CSV</button>
      <button id="ask-agent" disabled>Ask agent</button>
      <p data-testid="status">not started</p>
      <ul data-testid="files"></ul>
      <iframe id="app" sandbox="allow-scripts" title="Finance Tracker"></iframe>
    </main>
    <script>
      const backendMode = ${JSON.stringify(backendMode)}
      const walletCsv = ${JSON.stringify(walletCsv)}
      const financeTrackerSource = ${JSON.stringify(financeTrackerSource)}
      const status = document.querySelector('[data-testid="status"]')
      const filesList = document.querySelector('[data-testid="files"]')

      function parseCsv(csv) {
        const [header, ...lines] = csv.trim().split('\\n')
        const keys = header.split(',')
        return lines.map((line) => {
          const values = line.split(',')
          const row = Object.fromEntries(keys.map((key, index) => [key, values[index]]))
          return {
            id: row.id,
            Date: row.Date,
            Merchant: row.Merchant,
            Amount: Number(row.Amount),
            Category: row.Category,
            Reviewed: 'No',
          }
        })
      }

      function renderTransactionsMarkdown(rows) {
        return [
          '# Finance transactions',
          '',
          '| id | Date | Merchant | Amount | Category | Reviewed |',
          '| --- | --- | --- | ---: | --- | --- |',
          ...rows.map((row) => '| ' + [
            row.id,
            row.Date,
            row.Merchant,
            row.Amount,
            row.Category,
            row.Reviewed,
          ].join(' | ') + ' |'),
          '',
        ].join('\\n')
      }

      function refreshFiles() {
        filesList.innerHTML = Object.keys(window.__workspace.files)
          .sort()
          .map((path) => '<li>' + path + '</li>')
          .join('')
      }

      document.getElementById('create-workspace').addEventListener('click', () => {
        window.__mode = 'permitted'
        window.__workspace = {
          workspace: {
            id: ${JSON.stringify(actor.workspaceId)},
            ownerId: ${JSON.stringify(actor.userId)},
            backendMode,
          },
          walletCsv: '',
          transactions: [],
          files: {},
        }
        status.textContent = 'workspace created on ' + backendMode
        document.getElementById('upload-wallet').disabled = false
      })

      document.getElementById('upload-wallet').addEventListener('click', () => {
        window.__workspace.walletCsv = walletCsv
        window.__workspace.files['finance/wallet.csv'] = walletCsv
        status.textContent = 'wallet CSV uploaded'
        document.getElementById('ask-agent').disabled = false
        refreshFiles()
      })

      document.getElementById('ask-agent').addEventListener('click', () => {
        window.__workspace.transactions = parseCsv(window.__workspace.walletCsv)
        window.__workspace.files['finance/transactions.md'] =
          renderTransactionsMarkdown(window.__workspace.transactions)
        window.__workspace.files['finance/.apps/ledger/app.json'] =
          JSON.stringify({ title: 'Finance Tracker', collections: { transactions: { source: 'finance/transactions.md' } } }, null, 2)
        window.__workspace.files['finance/.apps/ledger/src/App.tsx'] = financeTrackerSource
        status.textContent = 'agent built finance tracker'
        refreshFiles()
      })

      window.addEventListener('message', (event) => {
        const data = event.data
        if (!data || typeof data !== 'object' || !data.id) return
        const reply = (payload) => event.source.postMessage({ id: data.id, ...payload }, '*')
        const denied = (code, message) => reply({ ok: true, value: { ok: false, code, message } })
        if (window.__mode === 'denied' && data.op === 'dohc.collection.list') {
          denied('source-read-not-authorized', 'source read not authorized')
          return
        }
        if (data.op === 'dohc.collection.list') {
          reply({ ok: true, value: { ok: true, rows: window.__workspace.transactions } })
          return
        }
        if (data.op === 'dohc.collection.insert') {
          window.__workspace.transactions.push(data.args.record)
          window.__workspace.files['finance/transactions.md'] =
            renderTransactionsMarkdown(window.__workspace.transactions)
          reply({ ok: true, value: { ok: true } })
          return
        }
        if (data.op === 'dohc.collection.update') {
          window.__workspace.transactions = window.__workspace.transactions.map((row) =>
            row.id === data.args.id ? { ...row, ...data.args.patch } : row
          )
          window.__workspace.files['finance/transactions.md'] =
            renderTransactionsMarkdown(window.__workspace.transactions)
          reply({ ok: true, value: { ok: true } })
        }
      })
    </script>
  `)

  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page.getByTestId('status')).toHaveText(`workspace created on ${backendMode}`)

  await page.getByRole('button', { name: 'Upload wallet CSV' }).click()
  await expect(page.getByTestId('files')).toContainText('finance/wallet.csv')

  await page.getByRole('button', { name: 'Ask agent' }).click()
  await expect(page.getByTestId('status')).toHaveText('agent built finance tracker')
  await expect(page.getByTestId('files')).toContainText('finance/.apps/ledger/src/App.tsx')
  await expect(page.getByTestId('files')).toContainText('finance/transactions.md')

  const initialSnapshot = await page.evaluate(() => (window as any).__workspace as MatrixWorkspaceSnapshot)
  const appTestResult = await runAppTest({
    backend: backendMode,
    packageRoot: 'finance/.apps/ledger',
    files: appFiles(initialSnapshot),
    seed: { collections: { transactions: initialSnapshot.transactions } },
    manifest: {
      collections: { transactions: { source: 'finance/transactions.md' } },
      tests: [{ name: 'categorize Grab expense' }, { name: 'add expense' }],
    },
  })
  expect(appTestResult.ok, JSON.stringify(appTestResult.failures, null, 2)).toBe(true)

  const srcDoc = buildAppShell({
    title: 'Finance Tracker',
    script: financeTrackerRuntimeScript,
  })
  const attachApp = async (selector: string) => {
    await page.locator(selector).evaluate((node, html) => {
      ;(node as HTMLIFrameElement).srcdoc = html
    }, srcDoc)
  }

  await attachApp('#app')
  const app = page.frameLocator('#app')
  await expect(app.getByRole('heading', { name: 'Finance Tracker' })).toBeVisible()
  await expect(app.getByTestId('total')).toContainText('$670 tracked')
  await expect(app.getByText('Grab $420 Uncategorized reviewed:No')).toBeVisible()

  await app.getByRole('button', { name: 'Categorize Grab' }).click()
  await expect(app.getByText('Grab $420 Transport reviewed:No')).toBeVisible()

  await app.getByRole('button', { name: 'Add expense' }).click()
  await expect(app.getByText('Bookstore $900 Learning reviewed:No')).toBeVisible()
  await expect(app.getByTestId('total')).toContainText('$1,570 tracked')

  await attachApp('#app')
  await expect(app.getByText('Grab $420 Transport reviewed:No')).toBeVisible()
  await expect(app.getByText('Bookstore $900 Learning reviewed:No')).toBeVisible()

  await page.locator('body').evaluate((body) => {
    const frame = document.createElement('iframe')
    frame.id = 'collaborator'
    frame.title = 'Collaborator Finance Tracker'
    frame.setAttribute('sandbox', 'allow-scripts')
    body.append(frame)
  })
  await attachApp('#collaborator')
  const collaborator = page.frameLocator('#collaborator')
  await expect(collaborator.getByText('Grab $420 Transport reviewed:No')).toBeVisible()
  await expect(collaborator.getByText('Bookstore $900 Learning reviewed:No')).toBeVisible()

  await page.evaluate(() => {
    ;(window as any).__mode = 'denied'
  })
  await page.locator('body').evaluate((body) => {
    const frame = document.createElement('iframe')
    frame.id = 'denied'
    frame.title = 'Denied Finance Tracker'
    frame.setAttribute('sandbox', 'allow-scripts')
    body.append(frame)
  })
  await attachApp('#denied')
  const denied = page.frameLocator('#denied')
  await expect(denied.getByRole('alert')).toContainText('source read not authorized')
  await expect(denied.getByText('Bookstore')).toHaveCount(0)

  const snapshot = await page.evaluate(() => (window as any).__workspace as MatrixWorkspaceSnapshot)
  const { backend } = createMemoryBackend(snapshot)
  await withTempDir('dohc-backend-matrix-fs-', async (targetDir) => {
    const manifest = await materializeWorkspace({
      backend,
      actor,
      targetDir,
      backendMode,
    })
    expect(manifest.backend).toBe(backendMode)
    await expect(readFile(join(targetDir, 'finance/transactions.md'), 'utf8'))
      .resolves.toContain('Transport')
    await expect(readFile(join(targetDir, 'finance/.apps/ledger/src/App.tsx'), 'utf8'))
      .resolves.toContain('Finance Tracker')
    const manifestOnDisk = await readManifest(targetDir)
    expect(manifestOnDisk.files['finance/.apps/ledger/src/App.tsx']).toMatchObject({
      kind: 'atom',
      contentType: 'text/tsx',
    })
  })

  await withTempDir('dohc-backend-matrix-shell-', async (rootDir) => {
    const session = await startWorkspaceShellSession({
      backend,
      actor,
      backendMode,
      rootDir,
    })
    await expect(runWorkspaceShellCommand(session, { command: 'rg', args: ['Transport', 'finance'] }))
      .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining('finance/transactions.md') })
    await expect(runWorkspaceShellCommand(session, { command: 'cat', args: ['finance/.apps/ledger/app.json'] }))
      .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Finance Tracker') })
    await runWorkspaceShellCommand(session, {
      command: 'node',
      args: [
        '-e',
        "const fs=require('fs'); const p='finance/transactions.md'; fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\\nAgent proposal: split ride share subscriptions.\\n')",
      ],
    })
    const diff = await captureWorkspaceShellDiff(session)
    expect(diff.operations).toEqual([
      { op: 'update', path: 'finance/transactions.md', expectedRevision: expect.any(String) },
    ])
  })
})
