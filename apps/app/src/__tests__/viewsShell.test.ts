import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from 'convex/react'
import { ActivityBar } from '../components/ActivityBar'
import { ViewFrame } from '../components/ViewFrame'
import { ViewsSidebar } from '../components/ViewsSidebar'
import { viewFromPathname } from '../lib/appViews'
import { decodeViewRef, encodeViewRef } from '../lib/viewRefs'
import { useActiveWorkspaceId } from '../lib/active-workspace'

vi.mock('convex/react', () => ({
  useQuery: vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}))
vi.mock('../lib/active-workspace', () => ({ useActiveWorkspaceId: vi.fn() }))

const useQueryMock = vi.mocked(useQuery as any)
const useActiveWorkspaceIdMock = vi.mocked(useActiveWorkspaceId)

const viewRows = [
  {
    packageRoot: '.views/home',
    scopePath: '',
    viewName: 'home',
    title: 'Home',
    entryPath: '.views/home/src/App.tsx',
    entryExists: true,
    hasConfig: false,
    configStatus: { ok: true },
    read: [''],
    write: [],
    network: false,
    agent: [],
  },
  {
    packageRoot: 'clients/acme/.views/overview',
    scopePath: 'clients/acme',
    viewName: 'overview',
    title: 'Overview',
    entryPath: 'clients/acme/.views/overview/src/App.tsx',
    entryExists: true,
    hasConfig: false,
    configStatus: { ok: true },
    read: ['clients/acme'],
    write: [],
    network: false,
    agent: [],
  },
]

beforeEach(() => {
  useQueryMock.mockReset()
  useActiveWorkspaceIdMock.mockReset()
})

describe('views shell route helpers', () => {
  it('recognizes Views routes as a first-class activity', () => {
    expect(viewFromPathname('/w/me/views')).toBe('views')
    expect(viewFromPathname('/w/org_123/v/abc123')).toBe('views')
    expect(viewFromPathname('/w/me/files')).toBe('atom')
  })

  it('round-trips package roots through URL-safe refs', () => {
    const root = 'clients/acme/.views/client-portal'
    const ref = encodeViewRef(root)
    expect(ref).not.toContain('/')
    expect(decodeViewRef(ref)).toBe(root)
    expect(decodeViewRef('not valid ***')).toBeNull()
  })
})

describe('Views activity shell', () => {
  it('adds Views to the activity bar between Files and Graph', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityBar, {
        view: 'views',
        onSelect: () => {},
      }),
    )

    expect(html).toContain('aria-label="Agent"')
    expect(html).toContain('aria-label="Files"')
    expect(html).toContain('aria-label="Views"')
    expect(html).toContain('aria-label="Graph"')
    expect(html.indexOf('aria-label="Views"')).toBeGreaterThan(
      html.indexOf('aria-label="Files"'),
    )
    expect(html.indexOf('aria-label="Views"')).toBeLessThan(
      html.indexOf('aria-label="Graph"'),
    )
  })

  it('groups discovered views by scope and exposes source editing', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock.mockReturnValue({ views: viewRows, truncated: false })

    const html = renderToStaticMarkup(
      createElement(ViewsSidebar, {
        selectedPackageRoot: 'clients/acme/.views/overview',
        onOpenView: () => {},
        onOpenSource: () => {},
      }),
    )

    expect(html).toContain('Workspace')
    expect(html).toContain('clients/acme')
    expect(html).toContain('Home')
    expect(html).toContain('Overview')
    expect(html).toContain('Open source')
    expect(useQueryMock.mock.calls[0]?.[1]).toEqual({
      activeWorkspaceId: 'ws_active',
    })
  })

  it('renders selected views inside a sandboxed frame shell', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock
      .mockReturnValueOnce(viewRows[1])
      .mockReturnValueOnce({
        ok: true,
        entry: 'src/App.tsx',
        truncated: false,
        files: [
          {
            relativePath: 'src/App.tsx',
            body: 'document.getElementById("root").textContent = "Overview"',
          },
        ],
      })

    const html = renderToStaticMarkup(
      createElement(ViewFrame, {
        packageRoot: 'clients/acme/.views/overview',
        onOpenSource: () => {},
      }),
    )

    expect(html).toContain('Overview')
    expect(html).toContain('Open source')
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    expect(useQueryMock.mock.calls[0]?.[1]).toEqual({
      packageRoot: 'clients/acme/.views/overview',
      activeWorkspaceId: 'ws_active',
    })
    expect(useQueryMock.mock.calls[1]?.[1]).toEqual({
      packageRoot: 'clients/acme/.views/overview',
      activeWorkspaceId: 'ws_active',
    })
  })
})
