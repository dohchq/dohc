// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConvex } from 'convex/react'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { AppRuntimeHost } from './AppRuntimeHost'

vi.mock('convex/react', () => ({ useConvex: vi.fn() }))
vi.mock('../lib/active-workspace', () => ({ useActiveWorkspaceId: vi.fn() }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let rendered: { container: HTMLElement; root: Root } | null = null

afterEach(() => {
  if (!rendered) return
  act(() => {
    rendered?.root.unmount()
  })
  rendered.container.remove()
  rendered = null
})

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function renderHost(onRunAgent = vi.fn()) {
  const query = vi.fn(async () => ({
    ok: true,
    operation: 'dohc.agent.run',
    prompt: 'Draft update.',
    sources: ['finance/tasks.md'],
    requiresConfirmation: true,
  }))
  vi.mocked(useConvex).mockReturnValue({
    query,
    action: vi.fn(),
    mutation: vi.fn(),
  } as never)
  vi.mocked(useActiveWorkspaceId).mockReturnValue('ws_finance')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      React.createElement(AppRuntimeHost, {
        packageRoot: 'finance/.apps/tracker',
        scopePath: 'finance',
        title: 'Finance Tracker',
        writeScopes: [],
        srcDoc: '<!doctype html><div id="root"></div>',
        onOpenSource: vi.fn(),
        onRunAgent,
      }),
    )
  })
  rendered = { container, root }
  return { container, onRunAgent, query }
}

describe('AppRuntimeHost agent handoffs', () => {
  it('does not run the agent from an app message until the host confirmation is accepted', async () => {
    const { container, onRunAgent, query } = renderHost()
    const iframe = container.querySelector('iframe')
    expect(iframe?.contentWindow).toBeTruthy()

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe!.contentWindow,
        data: {
          id: 'agent-1',
          op: 'dohc.agent.run',
          args: { prompt: 'Draft update.', sources: ['tasks.md'] },
        },
      }))
      await flush()
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(onRunAgent).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Ask agent')

    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm',
    )
    expect(confirm).toBeTruthy()

    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    })

    expect(query).toHaveBeenCalledTimes(2)
    expect(onRunAgent).toHaveBeenCalledWith({
      prompt: 'Draft update.',
      sources: ['finance/tasks.md'],
      originatingApp: 'finance/.apps/tracker',
      titleHint: 'Finance Tracker',
    })
  })
})
