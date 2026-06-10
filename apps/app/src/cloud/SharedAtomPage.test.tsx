// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudApi } from './cloudApi'
import { SharedAtomPage } from './SharedAtomPage'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

describe('SharedAtomPage (GET /shared/atoms/:atomId)', () => {
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

  it('renders the shared body from the contract response', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        atomId: 'atom-1',
        workspaceId: 'ws-1',
        path: 'notes/launch.md',
        body: '# Launch plan\n\nShip the desktop app.',
        capability: 'view',
      }),
    )
    const api = createCloudApi({ env: { VITE_DOHC_CLOUD_URL: '' }, fetch: fetchImpl })

    await act(async () => {
      root.render(<SharedAtomPage atomId="atom-1" api={api} />)
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      '/shared/atoms/atom-1',
      expect.objectContaining({ credentials: 'include' }),
    )
    const body = container.querySelector('[data-testid="shared-atom-body"]')
    expect(body).not.toBeNull()
    expect(body!.querySelector('h1')?.textContent).toBe('Launch plan')
    expect(container.textContent).toContain('notes/launch.md')
    expect(container.textContent).toContain('shared · view')
  })

  it('shows the denied state on 403 (revoked share / no session)', async () => {
    const api = createCloudApi({
      env: { VITE_DOHC_CLOUD_URL: '' },
      fetch: vi.fn(async () => new Response('forbidden', { status: 403 })),
    })
    await act(async () => {
      root.render(<SharedAtomPage atomId="atom-1" api={api} />)
    })
    expect(container.textContent).toMatch(/Sign in to view this page/)
    expect(container.querySelector('[data-testid="shared-atom-body"]')).toBeNull()
  })

  it('shows the gone state on 404', async () => {
    const api = createCloudApi({
      env: { VITE_DOHC_CLOUD_URL: '' },
      fetch: vi.fn(async () => new Response('missing', { status: 404 })),
    })
    await act(async () => {
      root.render(<SharedAtomPage atomId="atom-1" api={api} />)
    })
    expect(container.textContent).toMatch(/This shared page is gone/)
  })
})
