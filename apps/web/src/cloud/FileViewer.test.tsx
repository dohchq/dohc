// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DohcBackendClient, WorkspaceFile } from '../backend/backendClient'
import { FileViewer } from './FileViewer'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const FILE: WorkspaceFile = {
  id: 'f1',
  workspaceId: 'ws-1',
  path: 'notes/plan.md',
  kind: 'atom',
  contentType: 'text/markdown',
  revision: '3',
  updatedAt: 3,
}

function clientWith(overrides: Partial<DohcBackendClient> = {}): DohcBackendClient {
  return {
    listFiles: vi.fn(async () => []),
    readText: vi.fn(async () => ({ body: '# Plan', revision: '3' })),
    createTextFile: vi.fn(),
    writeText: vi.fn(async ({ path, body }) => ({
      id: 'f1',
      workspaceId: 'ws-1',
      path,
      body,
      kind: 'atom' as const,
      contentType: 'text/markdown',
      revision: '4',
      updatedAt: 4,
    })),
    uploadFile: vi.fn(),
    ...overrides,
  }
}

function setValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('FileViewer', () => {
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

  it('loads and renders markdown through backendClient.readText', async () => {
    const client = clientWith()
    await act(async () => {
      root.render(<FileViewer backendClient={client} file={FILE} />)
    })
    expect(client.readText).toHaveBeenCalledWith('notes/plan.md')
    expect(container.querySelector('[data-testid="file-body"] h1')?.textContent).toBe('Plan')
  })

  it('round-trips an edit through writeText with the loaded revision', async () => {
    const client = clientWith()
    await act(async () => {
      root.render(<FileViewer backendClient={client} file={FILE} />)
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="file-edit"]')!.click()
    })
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"]')!
    setValue(editor, '# Plan v2')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="file-save"]')!.click()
    })

    expect(client.writeText).toHaveBeenCalledWith({
      path: 'notes/plan.md',
      body: '# Plan v2',
      expectedRevision: '3',
    })
    // Back in view mode with the saved body rendered.
    expect(container.querySelector('[data-testid="file-editor"]')).toBeNull()
    expect(container.querySelector('[data-testid="file-body"] h1')?.textContent).toBe('Plan v2')
  })

  it('keeps the draft and surfaces the error when a save fails (no silent loss)', async () => {
    const client = clientWith({
      writeText: vi.fn(async () => {
        throw new Error('stale revision')
      }),
    })
    await act(async () => {
      root.render(<FileViewer backendClient={client} file={FILE} />)
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="file-edit"]')!.click()
    })
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"]')!
    setValue(editor, '# Plan v2 (unsaved)')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="file-save"]')!.click()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/stale revision/)
    const stillEditing = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="file-editor"]',
    )
    expect(stillEditing).not.toBeNull()
    expect(stillEditing!.value).toBe('# Plan v2 (unsaved)')
  })

  it('keeps the draft when a successful save response omits the next revision', async () => {
    const client = clientWith({
      writeText: vi.fn(
        async ({ path, body }) =>
          ({
            id: 'f1',
            workspaceId: 'ws-1',
            path,
            body,
            kind: 'atom' as const,
            contentType: 'text/markdown',
            updatedAt: 4,
          }) as unknown as WorkspaceFile,
      ),
    })
    await act(async () => {
      root.render(<FileViewer backendClient={client} file={FILE} />)
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="file-edit"]')!.click()
    })
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"]')!
    setValue(editor, '# Plan v2 (needs revision)')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="file-save"]')!.click()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/without a new revision/)
    const stillEditing = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="file-editor"]',
    )
    expect(stillEditing).not.toBeNull()
    expect(stillEditing!.value).toBe('# Plan v2 (needs revision)')
  })
})
