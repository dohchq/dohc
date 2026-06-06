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

const bundleAppServerMock = vi.hoisted(() => vi.fn())

vi.mock('convex/react', () => ({
  useQuery: vi.fn(),
  useAction: () => vi.fn(),
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}))
vi.mock('../apps/buildAppBundle.functions', () => ({
  bundleAppServer: bundleAppServerMock,
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
const VIEW_FRAME_SRC = readFileSync(
  resolve(__dirname, '../components/ViewFrame.tsx'),
  'utf8',
)
const BUNDLE_FUNCTIONS_SRC = readFileSync(
  resolve(__dirname, '../apps/buildAppBundle.functions.ts'),
  'utf8',
)

const viewRows = [
  {
    packageRoot: '.apps/home',
    scopePath: '',
    appName: 'home',
    title: 'Home',
    entryPath: '.apps/home/src/App.tsx',
    entryExists: true,
    hasConfig: false,
    configStatus: { ok: true },
    read: [''],
    write: [],
    network: false,
    agent: [],
  },
  {
    packageRoot: 'clients/acme/.apps/overview',
    scopePath: 'clients/acme',
    appName: 'overview',
    title: 'Overview',
    entryPath: 'clients/acme/.apps/overview/src/App.tsx',
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
  bundleAppServerMock.mockReset()
})

describe('views shell route helpers', () => {
  it('recognizes Apps routes as a first-class activity', () => {
    expect(viewFromPathname('/ice/apps')).toBe('views')
    expect(viewFromPathname('/acme/a/abc123')).toBe('views')
    expect(viewFromPathname('/ice/files')).toBe('atom')
  })

  it('round-trips package roots through URL-safe refs', () => {
    const root = 'clients/acme/.apps/client-portal'
    const ref = encodeViewRef(root)
    expect(ref).not.toContain('/')
    expect(decodeViewRef(ref)).toBe(root)
    expect(decodeViewRef('not valid ***')).toBeNull()
  })
})

describe('Apps activity shell', () => {
  it('puts Apps at the top of the activity bar above Agent', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityBar, {
        view: 'views',
        onSelect: () => {},
      }),
    )

    expect(html).toContain('aria-label="Agent"')
    expect(html).toContain('aria-label="Files"')
    expect(html).toContain('aria-label="Apps"')
    expect(html).toContain('aria-label="Graph"')
    expect(html.indexOf('aria-label="Apps"')).toBeLessThan(
      html.indexOf('aria-label="Agent"'),
    )
  })

  it('groups discovered apps by scope and exposes source editing', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock
      .mockReturnValueOnce({ apps: viewRows, truncated: false })
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
        selectedPackageRoot: 'clients/acme/.apps/overview',
        onOpenView: () => {},
        onOpenSource: () => {},
      }),
    )

    expect(html).toContain('Workspace')
    expect(html).toContain('clients/acme')
    expect(html).toContain('Home')
    expect(html).toContain('Overview')
    expect(html).toContain('Open app source')
    expect(useQueryMock.mock.calls[0]?.[1]).toEqual({
      activeWorkspaceId: 'ws_active',
    })
  })

  it('does not expose add controls in Apps or Graph while Files does', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock
      .mockReturnValueOnce({ apps: viewRows, truncated: false })
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

  it('renders selected apps inside a sandboxed frame shell', () => {
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
        packageRoot: 'clients/acme/.apps/overview',
        onOpenSource: () => {},
      }),
    )

    expect(html).toContain('Overview')
    expect(html).toContain('Open app source')
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    expect(useQueryMock.mock.calls[0]?.[1]).toEqual({
      packageRoot: 'clients/acme/.apps/overview',
      activeWorkspaceId: 'ws_active',
    })
    expect(useQueryMock.mock.calls[1]?.[1]).toEqual({
      packageRoot: 'clients/acme/.apps/overview',
      activeWorkspaceId: 'ws_active',
    })
  })

  it('uses one stable runtime skeleton while a selected app loads', () => {
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined)
    const initialHtml = renderToStaticMarkup(
      createElement(ViewFrame, {
        packageRoot: 'clients/acme/.apps/overview',
        onOpenSource: () => {},
      }),
    )
    const initialSrcDoc = initialHtml.match(/srcDoc="([^"]+)"/)?.[1]

    useQueryMock.mockReset()
    useQueryMock.mockReturnValueOnce(viewRows[1]).mockReturnValueOnce(undefined)
    const metadataHtml = renderToStaticMarkup(
      createElement(ViewFrame, {
        packageRoot: 'clients/acme/.apps/overview',
        onOpenSource: () => {},
      }),
    )
    const metadataSrcDoc = metadataHtml.match(/srcDoc="([^"]+)"/)?.[1]

    expect(initialHtml).toContain('sandbox="allow-scripts"')
    expect(initialHtml).not.toContain('dohc-skeleton')
    expect(initialSrcDoc).toBeTruthy()
    expect(metadataSrcDoc).toBe(initialSrcDoc)
  })

  it('keeps the app bundler behind the server-function bridge module', () => {
    expect(VIEW_FRAME_SRC).toContain(
      "from '../apps/buildAppBundle.functions'",
    )
    expect(VIEW_FRAME_SRC).not.toContain(
      "from '../apps/buildAppBundle.server'",
    )
    expect(BUNDLE_FUNCTIONS_SRC).toContain("await import('./buildAppBundle.server')")
    expect(BUNDLE_FUNCTIONS_SRC).not.toMatch(
      /import\s*\{[\s\S]*\bbuildAppBundle\b[\s\S]*\}\s*from\s*['"]\.\/buildAppBundle\.server['"]/,
    )
  })
})
