// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudApi } from './cloudApi'
import { WorkspaceList } from './WorkspaceList'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

describe('WorkspaceList', () => {
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

  it('renders workspaces from GET /workspaces', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        workspaces: [
          { workspaceId: 'ws-alpha', name: 'Alpha Notes' },
          { workspaceId: 'ws-beta' },
        ],
      }),
    )
    const api = createCloudApi({ env: { VITE_DOHC_CLOUD_URL: '' }, fetch: fetchImpl })

    await act(async () => {
      root.render(<WorkspaceList api={api} />)
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      '/workspaces',
      expect.objectContaining({ credentials: 'include' }),
    )
    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('[data-testid="workspace-link"]'),
    )
    expect(links).toHaveLength(2)
    expect(links[0]!.getAttribute('href')).toBe('/ws-alpha')
    expect(links[0]!.textContent).toContain('Alpha Notes')
    // No name → falls back to the workspace id, never a blank row.
    expect(links[1]!.textContent).toContain('ws-beta')
  })

  it('shows the empty state when the user has no workspaces', async () => {
    const api = createCloudApi({
      env: { VITE_DOHC_CLOUD_URL: '' },
      fetch: vi.fn(async () => Response.json({ workspaces: [] })),
    })
    await act(async () => {
      root.render(<WorkspaceList api={api} />)
    })
    expect(container.textContent).toMatch(/No cloud workspaces yet/)
  })

  it('surfaces a load failure', async () => {
    const api = createCloudApi({
      env: { VITE_DOHC_CLOUD_URL: '' },
      fetch: vi.fn(async () => new Response('boom', { status: 500 })),
    })
    await act(async () => {
      root.render(<WorkspaceList api={api} />)
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /Could not load your workspaces/,
    )
  })
})
