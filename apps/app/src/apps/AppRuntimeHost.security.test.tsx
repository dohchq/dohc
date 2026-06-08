import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useConvex } from 'convex/react'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { AppRuntimeHost } from './AppRuntimeHost'
import { parseAppRpcRequest } from './sdkProtocol'
import { buildAppShell } from './appShell'

vi.mock('convex/react', () => ({ useConvex: vi.fn() }))
vi.mock('../lib/active-workspace', () => ({ useActiveWorkspaceId: vi.fn() }))

describe('AppRuntimeHost security', () => {
  it('sandbox excludes same-origin and storage/cookie bridges', () => {
    vi.mocked(useConvex).mockReturnValue({ query: vi.fn(), action: vi.fn() } as never)
    vi.mocked(useActiveWorkspaceId).mockReturnValue('ws_active')

    const html = renderToStaticMarkup(
      createElement(AppRuntimeHost, {
        packageRoot: 'finance/.apps/tracker',
        scopePath: 'finance',
        title: 'Finance Tracker',
        writeScopes: [],
        srcDoc: '<!doctype html><div id="root"></div>',
        onOpenSource: () => {},
      }),
    )
    const shell = buildAppShell({ title: 'Finance Tracker' })

    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    expect(shell).not.toContain('document.cookie')
    expect(shell).not.toContain('localStorage')
    expect(shell).not.toContain('sessionStorage')
  })

  it('rejects unknown RPC and traversal payloads before host dispatch', () => {
    expect(parseAppRpcRequest({ id: 'unknown', op: 'dohc.nope', args: {} })).toBeNull()
    expect(parseAppRpcRequest({
      id: 'traversal',
      op: 'dohc.doc.get',
      args: { path: '../private.md' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: 'spoof-workspace',
      op: 'dohc.sources.list',
      args: { source: '.', activeWorkspaceId: 'ws_other' },
    })).toBeNull()
  })
})
