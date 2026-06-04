import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTES = resolve(__dirname, '../../src/routes')
const APP_SRC = readFileSync(resolve(ROUTES, '_app.tsx'), 'utf8')
const APP_VIEWS_SRC = readFileSync(
  resolve(__dirname, '../../src/lib/appViews.ts'),
  'utf8',
)
const ACTIVE_WORKSPACE_SRC = readFileSync(
  resolve(__dirname, '../../src/lib/active-workspace.tsx'),
  'utf8',
)
const SHARE_DIALOG_SRC = readFileSync(
  resolve(__dirname, '../../src/components/ShareDialog.tsx'),
  'utf8',
)

describe('canonical URL contract', () => {
  it('does not emit the viewer-relative personal sentinel anywhere in app source', () => {
    const sources = [APP_SRC, ACTIVE_WORKSPACE_SRC, SHARE_DIALOG_SRC]
    for (const src of sources) {
      expect(src).not.toContain(['/w', 'me'].join('/'))
      expect(src).not.toMatch(/wsId:\s*['"]me['"]/)
    }
  })

  it('removes workspace-scoped route files from the canonical app router', () => {
    const removed = [
      '_app.w.$wsId.tsx',
      '_app.w.$wsId.index.tsx',
      '_app.w.$wsId.p.$atomId.tsx',
      '_app.w.$wsId.shared.$shareId.tsx',
      '_app.w.$wsId.agent.tsx',
      '_app.w.$wsId.files.tsx',
      '_app.w.$wsId.views.tsx',
      '_app.w.$wsId.v.$viewRef.tsx',
      '_app.w.$wsId.graph.tsx',
    ]
    for (const f of removed) {
      expect(existsSync(resolve(ROUTES, f))).toBe(false)
    }
  })

  it('keeps workspace-slug app routes instead of /w/<wsId> routes', () => {
    const routes = [
      ['_app.index.tsx', '/_app/'],
      ['_app.$workspaceSlug.tsx', '/_app/$workspaceSlug'],
      ['_app.$workspaceSlug.agent.tsx', '/_app/$workspaceSlug/agent'],
      [
        '_app.$workspaceSlug.agent.$threadRef.tsx',
        '/_app/$workspaceSlug/agent/$threadRef',
      ],
      ['_app.$workspaceSlug.files.tsx', '/_app/$workspaceSlug/files'],
      ['_app.$workspaceSlug.views.tsx', '/_app/$workspaceSlug/views'],
      ['_app.$workspaceSlug.v.$viewRef.tsx', '/_app/$workspaceSlug/v/$viewRef'],
      ['_app.$workspaceSlug.graph.tsx', '/_app/$workspaceSlug/graph'],
      ['_app.$workspaceSlug.$pageRef.tsx', '/_app/$workspaceSlug/$pageRef'],
      ['_app.shared.$shareId.tsx', '/_app/shared/$shareId'],
    ] as const

    for (const [file, routePath] of routes) {
      const src = readFileSync(resolve(ROUTES, file), 'utf8')
      expect(src).toContain(`createFileRoute('${routePath}')`)
    }
  })

  it('parses pretty page refs and legacy share refs without /w prefixes', () => {
    expect(APP_SRC).toContain('pageIdFromRef')
    expect(APP_SRC).toContain('/^\\/shared\\/([^/]+)\\/?$/')
    expect(APP_SRC).not.toContain('/^(?:\\/w\\/[^/]+)?\\/p\\/(.+)$/')
    expect(APP_SRC).not.toContain('/^(?:\\/w\\/[^/]+)?\\/shared\\/(.+)$/')
  })

  it('navigates app surfaces into workspace-slug URLs', () => {
    for (const to of [
      "'/$workspaceSlug/agent'",
      "'/$workspaceSlug/files'",
      "'/$workspaceSlug/views'",
      "'/$workspaceSlug/graph'",
    ]) {
      expect(APP_SRC).toContain(`to: ${to}`)
    }
    expect(APP_SRC).toContain("to: '/$workspaceSlug/agent/$threadRef'")
    expect(APP_SRC).toContain('agentThreadRef(')
    expect(APP_SRC).toContain('agentThreadIdFromRef')
    expect(APP_SRC).toContain("to: '/$workspaceSlug/v/$viewRef'")
    expect(APP_SRC).toContain('pagePath(')
    expect(APP_SRC).not.toContain("to: '/w/$wsId")
  })

  it('maps primary app surfaces from root-level paths', () => {
    expect(APP_VIEWS_SRC).toContain('export function viewFromPathname')
    expect(APP_VIEWS_SRC).not.toContain('/w/')
    expect(APP_SRC).toContain('viewFromPathname(location.pathname)')
  })
})

describe('active workspace state after URL cleanup', () => {
  it('keeps workspace selection in localStorage instead of deriving it from /w/<wsId>', () => {
    expect(ACTIVE_WORKSPACE_SRC).not.toContain('workspaceIdFromPathname')
    expect(ACTIVE_WORKSPACE_SRC).not.toContain("const ME_SENTINEL = 'me'")
    expect(ACTIVE_WORKSPACE_SRC).toMatch(
      /const activeWorkspaceId\s*=\s*storageValue/,
    )
  })

  it('does not navigate inside the generic active-workspace setter', () => {
    expect(ACTIVE_WORKSPACE_SRC).not.toMatch(/\buseNavigate\b/)
    expect(ACTIVE_WORKSPACE_SRC).not.toMatch(/\bnavigate\(/)
    expect(ACTIVE_WORKSPACE_SRC).not.toContain('/w/$wsId')
  })
})
