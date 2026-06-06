import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useConvex } from 'convex/react'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { AppRuntimeHost } from './AppRuntimeHost'
import { buildAppBundle } from './buildAppBundle.server'
import { buildAppShell } from './appShell'
import { parseAppRpcRequest } from './sdkProtocol'
import { VIRTUAL_DOHC_SDK } from './virtualDohcAppSdk'

vi.mock('convex/react', () => ({
  useConvex: vi.fn(),
}))

vi.mock('../lib/active-workspace', () => ({
  useActiveWorkspaceId: vi.fn(),
}))

describe('AppRuntimeHost collaboration and security', () => {
  it('keeps app iframes sandboxed without same-origin, cookies, or storage bridge', () => {
    vi.mocked(useConvex).mockReturnValue({ query: vi.fn(), action: vi.fn() } as any)
    vi.mocked(useActiveWorkspaceId).mockReturnValue('ws_active')

    const html = renderToStaticMarkup(
      createElement(AppRuntimeHost, {
        packageRoot: 'finance/.apps/tracker',
        scopePath: 'finance',
        writeScopes: [],
        title: 'Finance Tracker',
        srcDoc: '<!doctype html><div id="root"></div>',
        onOpenSource: () => {},
      }),
    )

    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    const shell = buildAppShell({ title: 'Finance Tracker' })
    expect(shell).not.toContain('document.cookie')
    expect(shell).not.toContain('localStorage')
    expect(shell).not.toContain('sessionStorage')
  })

  it('rejects unknown RPC methods before host dispatch', () => {
    expect(parseAppRpcRequest({
      id: '1',
      op: 'dohc.unknown',
      args: {},
    })).toBeNull()
  })

  it('blocks direct Convex client imports from app bundles', async () => {
    const result = await buildAppBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: `import { useQuery } from 'convex/react'; console.log(useQuery)`,
        },
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'unsupported-import' })],
    })
  })

  it('exposes display-only presence without email fields', () => {
    const shell = buildAppShell({ title: 'Presence' })
    expect(shell).toContain("presence: { list: () => request('dohc.presence.list', {}) }")
    expect(VIRTUAL_DOHC_SDK).toContain('export function usePresence')
    expect(VIRTUAL_DOHC_SDK).not.toContain('email')
  })
})
