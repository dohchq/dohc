// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UploadFileButton,
  WORKSPACE_UPLOAD_ACCEPT,
} from '../components/UploadFileButton'
import { uploadBlobToStorageUrl } from '../lib/storageUpload'

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

vi.mock('../lib/storageUpload', () => ({
  uploadBlobToStorageUrl: vi.fn(),
}))

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILE_TREE_SRC = readFileSync(
  resolve(__dirname, '../components/FileTree.tsx'),
  'utf8',
)

describe('workspace file uploads', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    uploadState.mutationIndex = 0
    uploadState.generateUploadUrl.mockReset()
    uploadState.registerWorkspaceFile.mockReset()
    vi.mocked(uploadBlobToStorageUrl).mockReset()
    uploadState.generateUploadUrl.mockResolvedValue('https://upload.example.test')
    vi.mocked(uploadBlobToStorageUrl).mockResolvedValue('storage_123' as never)
    uploadState.registerWorkspaceFile.mockResolvedValue({
      _id: 'asset_123',
      path: 'uploads/wallet.csv',
      title: 'wallet.csv',
      source: 'user',
      kind: 'asset',
      contentType: 'text/csv',
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('exposes an upload button in the file sidebar area', () => {
    expect(FILE_TREE_SRC).toMatch(/UploadFileButton/)
    expect(FILE_TREE_SRC).toMatch(/onUploadFile/)
  })

  it('accepts images, pdf, audio, data files, sqlite, and generic files', () => {
    for (const accepted of [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'audio/mp4',
      '.m4a',
      '.csv',
      '.txt',
      '.json',
      '.sqlite',
      '.db',
      'application/octet-stream',
    ]) {
      expect(WORKSPACE_UPLOAD_ACCEPT).toContain(accepted)
    }
  })

  it('reports the created workspace file after upload succeeds', async () => {
    const onUploaded = vi.fn()

    await act(async () => {
      root.render(
        React.createElement(UploadFileButton, {
          activeWorkspaceId: 'ws_test',
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

    expect(uploadState.generateUploadUrl).toHaveBeenCalledWith({
      activeWorkspaceId: 'ws_test',
    })
    expect(uploadState.registerWorkspaceFile).toHaveBeenCalledWith({
      activeWorkspaceId: 'ws_test',
      storageId: 'storage_123',
      filename: 'wallet.csv',
      mediaType: 'text/csv',
      path: 'uploads/wallet.csv',
    })
    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'uploads/wallet.csv', kind: 'asset' }),
    )
  })
})
