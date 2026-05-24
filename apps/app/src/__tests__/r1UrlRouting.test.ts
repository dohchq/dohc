import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaceIdFromPathname } from '../lib/active-workspace'

// R1 (org-plan multiplayer-and-h-followups §5) — URL-based workspace
// routing. Two surfaces under test: (a) the URL parser
// `workspaceIdFromPathname`; (b) the new TanStack route files actually
// exist with the right route definitions. STRUCTURAL test for the
// route files matches this codebase's no-jsdom convention.

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTES = resolve(__dirname, '../../src/routes')

describe('workspaceIdFromPathname (R1 URL parser)', () => {
  it('returns undefined for legacy URLs (no /w/<wsId>/ prefix)', () => {
    expect(workspaceIdFromPathname('/')).toBeUndefined()
    expect(workspaceIdFromPathname('/p/atom_01XYZ')).toBeUndefined()
    expect(workspaceIdFromPathname('/shared/share_01XYZ')).toBeUndefined()
    expect(workspaceIdFromPathname('/r/atom_01XYZ')).toBeUndefined()
    expect(workspaceIdFromPathname('/playground')).toBeUndefined()
    expect(workspaceIdFromPathname('/signed-out')).toBeUndefined()
  })

  it('returns the wsId for /w/<wsId>/... URLs', () => {
    expect(workspaceIdFromPathname('/w/org_01ABC/p/dashboard')).toBe(
      'org_01ABC',
    )
    expect(workspaceIdFromPathname('/w/org_01ABC')).toBe('org_01ABC')
    expect(workspaceIdFromPathname('/w/org_01ABC/')).toBe('org_01ABC')
    expect(
      workspaceIdFromPathname('/w/org_01ABC/shared/share_xyz'),
    ).toBe('org_01ABC')
    expect(workspaceIdFromPathname('/w/org_01ABC/r/atom')).toBe('org_01ABC')
  })

  it('treats /w/me/ as personal (returns undefined — the API back-compat path)', () => {
    // The literal `me` sentinel is the URL handle for personal workspace;
    // at the API layer it maps to "no activeWorkspaceId arg" so
    // requireWorkspace(ctx) takes the v0 default-personal branch. The
    // hook MUST NOT expose `'me'` to consumers or Convex would try to
    // membership-lookup a workspace literally named `me`.
    expect(workspaceIdFromPathname('/w/me/p/dashboard')).toBeUndefined()
    expect(workspaceIdFromPathname('/w/me')).toBeUndefined()
    expect(workspaceIdFromPathname('/w/me/')).toBeUndefined()
    expect(workspaceIdFromPathname('/w/me/shared/x')).toBeUndefined()
  })

  it('decodes URL-encoded segments', () => {
    // Org ids are opaque Convex Ids today (no URL-unsafe chars), but
    // defensive: if a future workspace handle contains URL-encoded
    // characters they decode cleanly.
    expect(
      workspaceIdFromPathname('/w/org%20with%20space/p/x'),
    ).toBe('org with space')
  })

  it('empty /w// segment returns undefined (defensive — malformed URL)', () => {
    // The regex pattern requires at least one char in the wsId segment,
    // so `/w//something` does NOT match the `/w/<wsId>/...` shape.
    // Falls through to undefined ⇒ personal.
    expect(workspaceIdFromPathname('/w//p/x')).toBeUndefined()
  })
})

describe('R1 route file structure', () => {
  it('all four new workspace-scoped route files exist', () => {
    const files = [
      '_app.w.$wsId.tsx',
      '_app.w.$wsId.index.tsx',
      '_app.w.$wsId.p.$atomId.tsx',
      '_app.w.$wsId.shared.$shareId.tsx',
    ]
    for (const f of files) {
      expect(existsSync(resolve(ROUTES, f))).toBe(true)
    }
  })

  it('layout file declares the parent route /_app/w/$wsId and renders Outlet', () => {
    const src = readFileSync(resolve(ROUTES, '_app.w.$wsId.tsx'), 'utf8')
    expect(src).toMatch(/createFileRoute\(['"]\/_app\/w\/\$wsId['"]\)/)
    expect(src).toMatch(/<Outlet\s*\/>/)
  })

  it('child routes declare the correct paths with $wsId carried through', () => {
    expect(
      readFileSync(resolve(ROUTES, '_app.w.$wsId.index.tsx'), 'utf8'),
    ).toMatch(/createFileRoute\(['"]\/_app\/w\/\$wsId\/['"]\)/)
    expect(
      readFileSync(resolve(ROUTES, '_app.w.$wsId.p.$atomId.tsx'), 'utf8'),
    ).toMatch(/createFileRoute\(['"]\/_app\/w\/\$wsId\/p\/\$atomId['"]\)/)
    expect(
      readFileSync(
        resolve(ROUTES, '_app.w.$wsId.shared.$shareId.tsx'),
        'utf8',
      ),
    ).toMatch(/createFileRoute\(['"]\/_app\/w\/\$wsId\/shared\/\$shareId['"]\)/)
  })

  it('legacy routes still exist (no breaking removal in foundation commit)', () => {
    // The foundation commit adds new routes alongside legacy. Subsequent
    // commits add redirects from legacy → /w/me/... ; this test locks
    // that we don't accidentally remove the legacy routes here.
    expect(existsSync(resolve(ROUTES, '_app.p.$atomId.tsx'))).toBe(true)
    expect(existsSync(resolve(ROUTES, '_app.shared.$shareId.tsx'))).toBe(true)
    expect(existsSync(resolve(ROUTES, '_app.index.tsx'))).toBe(true)
  })
})

describe('active-workspace.tsx (R1 hook resolution)', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../../src/lib/active-workspace.tsx'),
    'utf8',
  )

  it('exports workspaceIdFromPathname for reuse by the shell', () => {
    expect(SRC).toMatch(/export function workspaceIdFromPathname\b/)
  })

  it('URL takes precedence over localStorage in the resolution', () => {
    // The Provider computes urlValue from useLocation, then resolves
    // `activeWorkspaceId = urlValue ?? storageValue`. Order matters.
    expect(SRC).toMatch(/urlValue\s*\?\?\s*storageValue/)
  })

  it("uses TanStack's useLocation (not window.location) for SSR safety", () => {
    expect(SRC).toMatch(
      /import\s+\{[\s\S]*?useLocation[\s\S]*?\}\s+from\s+['"]@tanstack\/react-router['"]/,
    )
  })

  it('localStorage cross-tab sync still wired (storage event listener)', () => {
    expect(SRC).toMatch(/addEventListener\(['"]storage['"]/)
  })
})
