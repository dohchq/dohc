import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from 'convex/react'
import { ActivityBar } from '../components/ActivityBar'
import { FileTree } from '../components/FileTree'
import { ViewFrame } from '../components/ViewFrame'
import { ViewsSidebar } from '../components/ViewsSidebar'
import { viewFromPathname } from '../lib/appViews'
import { decodeViewRef, encodeViewRef } from '../lib/viewRefs'
import { useActiveWorkspaceId } from '../lib/active-workspace'

vi.mock('convex/react', () => ({
  useQuery: vi.fn(),
  useAction: () => vi.fn(),
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}))
vi.mock('../lib/active-workspace', () => ({
  useActiveWorkspaceId: vi.fn(),
  useActiveWorkspace: vi.fn(() => ({
    activeWorkspaceId: 'ws_active',
    setActiveWorkspaceId: vi.fn(),
  })),
}))

const useQueryMock = vi.mocked(useQuery as any)
const useActiveWorkspaceIdMock = vi.mocked(useActiveWorkspaceId)
const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_SRC = readFileSync(resolve(__dirname, '../routes/_app.tsx'), 'utf8')

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
  it('puts Views at the top of the activity bar above Agent', () => {
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
    expect(html.indexOf('aria-label="Views"')).toBeLessThan(
      html.indexOf('aria-label="Agent"'),
    )
  })

  it('groups discovered views by scope and exposes source editing', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock
      .mockReturnValueOnce({ views: viewRows, truncated: false })
      .mockReturnValueOnce([
        {
          workspaceId: 'ws_active',
          kind: 'personal',
          name: 'Personal',
          role: 'owner',
        },
      ])

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

  it('does not expose add controls in Views or Graph while Files does', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock
      .mockReturnValueOnce({ views: viewRows, truncated: false })
      .mockReturnValueOnce([
        {
          workspaceId: 'ws_active',
          kind: 'personal',
          name: 'Personal',
          role: 'owner',
        },
      ])

    const viewsHtml = renderToStaticMarkup(
      createElement(ViewsSidebar, {
        selectedPackageRoot: null,
        onOpenView: () => {},
        onOpenSource: () => {},
      }),
    )
    const fileTreeProps = {
      files: [],
      folders: [],
      activePath: null,
      view: 'atom' as const,
      user: null,
      onOpen: () => {},
      onCreatePage: async () => {},
      onCreateFolder: async () => {},
      onDeleteFolder: async () => {},
      onRenameFolder: async () => {},
      onDeleteFile: async () => {},
      onRenameFile: async () => {},
    }
    const fileTreeHtml = renderToStaticMarkup(
      createElement(FileTree, { ...fileTreeProps, allowCreate: true }),
    )
    const graphFileTreeHtml = renderToStaticMarkup(
      createElement(FileTree, { ...fileTreeProps, allowCreate: false }),
    )

    expect(viewsHtml).not.toContain('aria-label="new"')
    expect(fileTreeHtml).toContain('aria-label="new"')
    expect(graphFileTreeHtml).not.toContain('aria-label="new"')
    expect(APP_SRC).toMatch(
      /<FileTree[\s\S]*allowCreate=\{view !== 'graph'\}[\s\S]*onCreatePage=/,
    )
  })

  it('renders selected views inside a sandboxed frame shell', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock.mockReturnValueOnce(viewRows[1]).mockReturnValueOnce({
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
