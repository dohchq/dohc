// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDohcBackendClient,
  resolveDohcBackendMode,
  type DohcBackendClient,
} from '../backend/backendClient'
import { createPostgresBackendClient } from '../backend/postgresBackendClient'
import { UploadFileButton } from '../components/UploadFileButton'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const uploadState = vi.hoisted(() => ({
  mutationIndex: 0,
  generateUploadUrl: vi.fn(),
  registerWorkspaceFile: vi.fn(),
}))

vi.mock('convex/react', () => ({
  useMutation: () =>
    uploadState.mutationIndex++ === 0
      ? uploadState.generateUploadUrl
      : uploadState.registerWorkspaceFile,
}))

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROUTE_SRC = readFileSync(resolve(__dirname, '../routes/_app.tsx'), 'utf8')
const ATOM_VIEW_SRC = readFileSync(resolve(__dirname, '../components/AtomView.tsx'), 'utf8')
const FILE_TREE_SRC = readFileSync(resolve(__dirname, '../components/FileTree.tsx'), 'utf8')

function fakeClient(label: string): DohcBackendClient {
  return {
    listFiles: vi.fn(async () => [
      {
        _id: `${label}_file`,
        path: `${label}/note.md`,
        source: 'user',
        kind: 'atom' as const,
        contentType: 'text/markdown',
        revision: '1',
      },
    ]),
    readText: vi.fn(async () => ({ body: `${label} body`, revision: '1' })),
    createTextFile: vi.fn(async ({ path }) => ({
      _id: `${label}_created`,
      path,
      source: 'user',
      kind: 'atom' as const,
      contentType: 'text/markdown',
      revision: '1',
    })),
    uploadFile: vi.fn(async ({ path }) => ({
      _id: `${label}_uploaded`,
      path,
      source: 'user',
      kind: 'asset' as const,
      contentType: 'text/csv',
      revision: '1',
    })),
    renameFile: vi.fn(async ({ newName }) => ({
      _id: `${label}_renamed`,
      path: newName,
      source: 'user',
      kind: 'atom' as const,
      contentType: 'text/markdown',
      revision: '2',
    })),
  }
}

describe('frontend backend switch', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    uploadState.mutationIndex = 0
    uploadState.generateUploadUrl.mockReset()
    uploadState.registerWorkspaceFile.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.history.replaceState(null, '', '/')
  })

  it('defaults to Convex and ignores browser-controlled query strings', () => {
    expect(resolveDohcBackendMode({})).toBe('convex')
    window.history.replaceState(null, '', '/?DOHC_BACKEND=postgres&backend=postgres')
    expect(resolveDohcBackendMode({})).toBe('convex')
    expect(resolveDohcBackendMode({ DOHC_BACKEND: 'postgres' })).toBe('postgres')
  })

  it('routes common file operations through the selected Postgres client', async () => {
    const convex = fakeClient('convex')
    const postgres = fakeClient('postgres')
    const client = createDohcBackendClient({
      env: { DOHC_BACKEND: 'postgres' },
      convex,
      postgres,
    })

    await client.listFiles()
    await client.readText('finance/ledger.md')
    await client.createTextFile({
      path: 'finance/ledger.md',
      body: '# Ledger',
      contentType: 'text/markdown',
    })
    await client.uploadFile({
      file: new File(['a,b\n'], 'ledger.csv', { type: 'text/csv' }),
      path: 'finance/ledger.csv',
    })
    await client.renameFile({
      path: 'finance/ledger.md',
      newName: 'finance/books.md',
      expectedRevision: '1',
    })

    expect(postgres.listFiles).toHaveBeenCalledTimes(1)
    expect(postgres.readText).toHaveBeenCalledWith('finance/ledger.md')
    expect(postgres.createTextFile).toHaveBeenCalledTimes(1)
    expect(postgres.uploadFile).toHaveBeenCalledTimes(1)
    expect(postgres.renameFile).toHaveBeenCalledTimes(1)
    expect(convex.listFiles).not.toHaveBeenCalled()
    expect(convex.readText).not.toHaveBeenCalled()
    expect(convex.createTextFile).not.toHaveBeenCalled()
    expect(convex.uploadFile).not.toHaveBeenCalled()
    expect(convex.renameFile).not.toHaveBeenCalled()
  })

  it('calls services/workspace-api from the Postgres client', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/files/text?')) {
        return Response.json({ body: '# Ledger', revision: '4' })
      }
      if (url.endsWith('/files')) {
        return Response.json({ files: [] })
      }
      return Response.json({
        file: {
          _id: 'pg_file',
          path: 'finance/ledger.md',
          source: 'user',
          kind: 'atom',
          contentType: 'text/markdown',
          revision: '5',
        },
      })
    })
    const client = createPostgresBackendClient({
      baseUrl: '/services/workspace-api',
      fetch: fetchImpl,
    })

    await client.listFiles()
    await client.readText('finance/ledger.md')
    await client.createTextFile({
      path: 'finance/ledger.md',
      body: '# Ledger',
      contentType: 'text/markdown',
    })
    await client.uploadFile({
      file: new File(['a,b\n'], 'ledger.csv', { type: 'text/csv' }),
      path: 'finance/ledger.csv',
    })
    await client.renameFile({
      path: 'finance/ledger.md',
      newName: 'finance/books.md',
      expectedRevision: '5',
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/services/workspace-api/files', expect.any(Object))
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/services/workspace-api/files/text?path=finance%2Fledger.md',
      expect.any(Object),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      '/services/workspace-api/files/text',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      '/services/workspace-api/files/upload',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      5,
      '/services/workspace-api/files/rename',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps upload UI behavior when a backend client handles the upload', async () => {
    const postgres = fakeClient('postgres')
    const onUploaded = vi.fn()

    await act(async () => {
      root.render(
        React.createElement(UploadFileButton, {
          activeWorkspaceId: 'ws_test',
          backendClient: postgres,
          defaultFolderPath: 'uploads',
          onUploaded,
        }),
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File(['a,b\n1,2\n'], 'wallet.csv', {
      type: 'text/csv',
    })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })

    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(postgres.uploadFile).toHaveBeenCalledWith({
      file,
      path: 'uploads/wallet.csv',
    })
    expect(uploadState.generateUploadUrl).not.toHaveBeenCalled()
    expect(uploadState.registerWorkspaceFile).not.toHaveBeenCalled()
    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'uploads/wallet.csv', kind: 'asset' }),
    )
  })

  it('wires the selected backend client through route, editor, and file tree flows', () => {
    expect(APP_ROUTE_SRC).toMatch(/resolveDohcBackendMode/)
    expect(APP_ROUTE_SRC).toMatch(/createPostgresBackendClient/)
    expect(APP_ROUTE_SRC).toMatch(/backendMode === 'postgres'/)
    expect(APP_ROUTE_SRC).toContain('backendClient={backendClient ?? undefined}')
    expect(ATOM_VIEW_SRC).toContain('backendClient.readText')
    expect(ATOM_VIEW_SRC).toContain('backendClient.createTextFile')
    expect(FILE_TREE_SRC).toContain('backendClient={backendClient}')
  })
})
