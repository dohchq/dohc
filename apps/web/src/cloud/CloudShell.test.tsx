// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DohcBackendClient, WorkspaceFile } from '../backend/backendClient'
import { createCloudApi } from './cloudApi'
import { CloudShell } from './CloudShell'
import { CloudSessionProvider } from './session'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const FILES: WorkspaceFile[] = [
  {
    _id: 'f1',
    path: 'notes/plan.md',
    source: 'user',
    kind: 'atom',
    contentType: 'text/markdown',
    revision: '1',
  },
  {
    _id: 'f2',
    path: 'readme.md',
    source: 'user',
    kind: 'atom',
    contentType: 'text/markdown',
    revision: '1',
  },
]

function fakeBackend(): DohcBackendClient {
  return {
    listFiles: vi.fn(async () => FILES),
    readText: vi.fn(async () => ({ body: '# Plan', revision: '1' })),
    createTextFile: vi.fn(async ({ path }) => ({
      _id: 'f3',
      path,
      source: 'user',
      kind: 'atom' as const,
      contentType: 'text/markdown',
      revision: '1',
    })),
    writeText: vi.fn(),
    uploadFile: vi.fn(),
  }
}

function renderShell(root: Root, client: DohcBackendClient) {
  const api = createCloudApi({
    env: { VITE_DOHC_CLOUD_URL: '' },
    fetch: vi.fn(async () => Response.json({})),
  })
  root.render(
    <CloudSessionProvider
      value={{ user: { id: 'u1', email: 'ada@example.com' }, api, signOut: vi.fn() }}
    >
      <CloudShell workspaceId="ws-1" backendClient={client} />
    </CloudSessionProvider>,
  )
}

describe('CloudShell', () => {
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

  it('lists workspace files as a tree from backendClient.listFiles', async () => {
    const client = fakeBackend()
    await act(async () => {
      renderShell(root, client)
    })
    expect(client.listFiles).toHaveBeenCalled()
    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="tree-file"]'),
    )
    expect(rows.map((r) => r.dataset.path)).toEqual(['notes/plan.md', 'readme.md'])
  })

  it('opens a selected file in the viewer', async () => {
    const client = fakeBackend()
    await act(async () => {
      renderShell(root, client)
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="tree-file"][data-path="notes/plan.md"]')!
        .click()
    })
    expect(client.readText).toHaveBeenCalledWith('notes/plan.md')
    expect(container.querySelector('[data-testid="file-body"] h1')?.textContent).toBe('Plan')
  })

  it('creates a new markdown file through the backend client and selects it', async () => {
    const client = fakeBackend()
    await act(async () => {
      renderShell(root, client)
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="new-file-button"]')!.click()
    })
    const input = container.querySelector<HTMLInputElement>('[data-testid="new-file-name"]')!
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(input, 'ideas/next')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => {
      input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(client.createTextFile).toHaveBeenCalledWith({
      path: 'ideas/next.md',
      body: '',
      contentType: 'text/markdown',
    })
  })
})
