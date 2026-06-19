// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCloudApiOrigin, type DohcBackendClient } from '../backend/backendClient'
import {
  createDohcBackendClient,
  createPostgresBackendClient,
} from '../backend/postgresBackendClient'
import { createCloudApi } from '../cloud/cloudApi'
import { UploadFileButton } from '../components/UploadFileButton'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROUTE_SRC = readFileSync(resolve(__dirname, '../routes/_app.tsx'), 'utf8')
const WORKSPACE_ROUTE_SRC = readFileSync(
  resolve(__dirname, '../routes/_app.$workspaceSlug.tsx'),
  'utf8',
)
const CLOUD_SHELL_SRC = readFileSync(resolve(__dirname, '../cloud/CloudShell.tsx'), 'utf8')
const FILE_VIEWER_SRC = readFileSync(resolve(__dirname, '../cloud/FileViewer.tsx'), 'utf8')

function fakeClient(label: string): DohcBackendClient {
  return {
    listFiles: vi.fn(async () => [
      {
        id: `${label}_file`,
        workspaceId: 'ws-1',
        path: `${label}/note.md`,
        kind: 'atom' as const,
        contentType: 'text/markdown',
        revision: '1',
        updatedAt: 1,
      },
    ]),
    readText: vi.fn(async () => ({ body: `${label} body`, revision: '1' })),
    createTextFile: vi.fn(async ({ path }) => ({
      id: `${label}_created`,
      workspaceId: 'ws-1',
      path,
      kind: 'atom' as const,
      contentType: 'text/markdown',
      revision: '1',
      updatedAt: 1,
    })),
    writeText: vi.fn(async ({ path }) => ({
      id: `${label}_written`,
      workspaceId: 'ws-1',
      path,
      kind: 'atom' as const,
      contentType: 'text/markdown',
      revision: '2',
      updatedAt: 2,
    })),
    uploadFile: vi.fn(async ({ path }) => ({
      id: `${label}_uploaded`,
      workspaceId: 'ws-1',
      path,
      kind: 'asset' as const,
      contentType: 'text/csv',
      revision: '1',
      updatedAt: 1,
    })),
  }
}

describe('cloud backend client seam', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('resolves the cloud API origin from env, defaulting to same-origin', () => {
    expect(resolveCloudApiOrigin({})).toBe('')
    expect(resolveCloudApiOrigin({ VITE_DOHC_CLOUD_URL: 'https://cloud.dohc.app/' })).toBe(
      'https://cloud.dohc.app',
    )
  })

  it('routes all file operations through the provided client (op-routing contract)', async () => {
    const client = fakeClient('pg')

    await client.listFiles()
    await client.readText('finance/ledger.md')
    await client.createTextFile({
      path: 'finance/ledger.md',
      body: '# Ledger',
      contentType: 'text/markdown',
    })
    await client.writeText({
      path: 'finance/ledger.md',
      body: '# Ledger v2',
      expectedRevision: '1',
    })
    await client.uploadFile({
      file: new File(['a,b\n'], 'ledger.csv', { type: 'text/csv' }),
      path: 'finance/ledger.csv',
    })

    expect(client.listFiles).toHaveBeenCalledTimes(1)
    expect(client.readText).toHaveBeenCalledWith('finance/ledger.md')
    expect(client.createTextFile).toHaveBeenCalledTimes(1)
    expect(client.writeText).toHaveBeenCalledWith({
      path: 'finance/ledger.md',
      body: '# Ledger v2',
      expectedRevision: '1',
    })
    expect(client.uploadFile).toHaveBeenCalledTimes(1)
  })

  it('calls the workspace-scoped services/workspace-api routes', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/files') && init?.method !== 'POST') {
        return Response.json({ ok: true, files: [] })
      }
      return Response.json({
        ok: true,
        file: {
          id: 'pg_file',
          workspaceId: 'ws-1',
          path: 'finance/ledger.md',
          kind: 'atom',
          contentType: 'text/markdown',
          revision: '5',
          updatedAt: 5,
          body: '# Ledger',
        },
      })
    })
    const client = createPostgresBackendClient({
      workspaceId: 'ws-1',
      baseUrl: 'https://cloud.example',
      fetch: fetchImpl,
    })

    await client.listFiles()
    await client.readText('finance/ledger.md')
    await client.createTextFile({
      path: 'finance/ledger.md',
      body: '# Ledger',
      contentType: 'text/markdown',
    })
    await client.writeText({
      path: 'finance/ledger.md',
      body: '# Ledger v2',
      expectedRevision: '5',
    })
    await client.uploadFile({
      file: new File(['a,b\n'], 'ledger.csv', { type: 'text/csv' }),
      path: 'finance/ledger.csv',
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://cloud.example/workspaces/ws-1/files',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://cloud.example/workspaces/ws-1/files/finance/ledger.md',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://cloud.example/workspaces/ws-1/files/finance/ledger.md',
      expect.objectContaining({ method: 'POST' }),
    )
    // The create body has NO expectedRevision (createAtom path); the
    // write body carries the revision guard (writeAtom path).
    const createBody = JSON.parse(String((fetchImpl.mock.calls[2]![1] as RequestInit).body))
    expect(createBody).toEqual({ body: '# Ledger', kind: 'markdown' })
    const writeBody = JSON.parse(String((fetchImpl.mock.calls[3]![1] as RequestInit).body))
    expect(writeBody).toEqual({ body: '# Ledger v2', expectedRevision: '5' })
    expect(fetchImpl).toHaveBeenNthCalledWith(
      5,
      'https://cloud.example/workspaces/ws-1/assets',
      expect.objectContaining({ method: 'POST' }),
    )
    const uploadBody = JSON.parse(String((fetchImpl.mock.calls[4]![1] as RequestInit).body))
    expect(uploadBody).toMatchObject({
      path: 'finance/ledger.csv',
      kind: 'csv',
      mediaType: 'text/csv',
    })
    expect(atob(uploadBody.bytesBase64)).toBe('a,b\n')
  })

  it('validates canonical workspace-api file ids before returning payloads', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/files')) {
        return Response.json({
          ok: true,
          files: [
            {
              id: 'pg_file',
              workspaceId: 'ws-1',
              path: 'notes/journal.md',
              kind: 'atom',
              contentType: 'text/markdown',
              revision: '7',
              updatedAt: 7,
            },
          ],
        })
      }
      return Response.json({
        ok: true,
        file: {
          id: 'pg_file',
          workspaceId: 'ws-1',
          path: 'notes/journal.md',
          kind: 'atom',
          contentType: 'text/markdown',
          revision: '7',
          updatedAt: 7,
          body: '# Journal\n',
        },
      })
    })
    const client = createPostgresBackendClient({
      workspaceId: 'ws-1',
      baseUrl: 'https://cloud.example',
      fetch: fetchImpl,
    })

    await expect(client.listFiles()).resolves.toEqual([
      expect.objectContaining({ id: 'pg_file', workspaceId: 'ws-1' }),
    ])
    await expect(client.readText('notes/journal.md')).resolves.toEqual({
      body: '# Journal\n',
      revision: '7',
    })
  })

  it('rejects malformed file responses before they weaken revision semantics', async () => {
    const client = createPostgresBackendClient({
      workspaceId: 'ws-1',
      baseUrl: 'https://cloud.example',
      fetch: vi.fn(async () =>
        Response.json({
          ok: true,
          file: {
            id: 'pg_file',
            workspaceId: 'ws-1',
            path: 'notes/missing.md',
            kind: 'atom',
            contentType: 'text/markdown',
            body: '# Missing',
            updatedAt: 5,
          },
        }),
      ),
    })

    await expect(client.readText('notes/missing.md')).rejects.toThrow(/missing file\.revision/)
  })

  it('rejects dot segments before encoding workspace paths into URLs', async () => {
    const client = createPostgresBackendClient({
      workspaceId: 'ws-1',
      baseUrl: 'https://cloud.example',
      fetch: vi.fn(async () => Response.json({ ok: true, files: [] })),
    })

    await expect(client.readText('notes/../secret.md')).rejects.toThrow(/Workspace paths/)
    await expect(client.readText('notes/./draft.md')).rejects.toThrow(/Workspace paths/)
  })

  it('keeps cookie credentials enforced even if a caller passes an override', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, user: null }))
    const api = createCloudApi({ env: { VITE_DOHC_CLOUD_URL: '' }, fetch: fetchImpl })

    await api.signInWithEmail({ email: 'ada@example.com', password: 'secret' })

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/sign-in/email',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('binds the workspace id into the default client factory', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, files: [] }))
    const client = createDohcBackendClient({
      workspaceId: 'ws-9',
      env: { VITE_DOHC_CLOUD_URL: 'https://cloud.example' },
      fetch: fetchImpl,
    })
    await client.listFiles()
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cloud.example/workspaces/ws-9/files',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('keeps upload UI behavior when the backend client handles the upload', async () => {
    const client = fakeClient('pg')
    const onUploaded = vi.fn()

    await act(async () => {
      root.render(
        React.createElement(UploadFileButton, {
          backendClient: client,
          defaultFolderPath: 'uploads',
          onUploaded,
        }),
      )
    })

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File(['a,b\n1,2\n'], 'wallet.csv', { type: 'text/csv' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })

    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(client.uploadFile).toHaveBeenCalledWith({ file, path: 'uploads/wallet.csv' })
    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'uploads/wallet.csv', kind: 'asset' }),
    )
  })

  it('wires the backend client through the cloud shell and viewer (wiring guard)', () => {
    // The /_app layout is the session gate; the workspace route mounts
    // the CloudShell, which owns the client and passes it down.
    expect(APP_ROUTE_SRC).toMatch(/createCloudApi/)
    expect(WORKSPACE_ROUTE_SRC).toMatch(/<CloudShell workspaceId=/)
    expect(CLOUD_SHELL_SRC).toMatch(/createDohcBackendClient\(\{ workspaceId \}\)/)
    expect(CLOUD_SHELL_SRC).toMatch(/client\.listFiles\(\)/)
    expect(CLOUD_SHELL_SRC).toMatch(/client\.createTextFile/)
    expect(CLOUD_SHELL_SRC).toMatch(/backendClient=\{client\}/)
    expect(FILE_VIEWER_SRC).toMatch(/backendClient\.readText/)
    expect(FILE_VIEWER_SRC).toMatch(/backendClient\.writeText/)
  })
})
