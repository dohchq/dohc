import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isSourceFirstPath,
  shouldRenderHtmlAtomFrame,
  viewPackageRootForSourcePath,
} from '../lib/viewSourceBehavior'

const ATOM_VIEW_SRC = readFileSync(
  resolve(__dirname, '../components/AtomView.tsx'),
  'utf8',
)

describe('view source editing contracts', () => {
  it('opens .views source atoms in source mode by default', () => {
    expect(isSourceFirstPath('clients/acme/.views/overview/src/App.tsx')).toBe(true)
    expect(isSourceFirstPath('clients/acme/.views/overview/src/page.html')).toBe(true)
    expect(isSourceFirstPath('clients/acme/notes.md')).toBe(false)
  })

  it('does not render .html files inside .views as html atoms', () => {
    expect(shouldRenderHtmlAtomFrame({
      path: 'clients/acme/.views/overview/src/page.html',
      pathIsHtml: true,
      draft: '<main>View source</main>',
    })).toBe(false)
    expect(shouldRenderHtmlAtomFrame({
      path: 'clients/acme/home.html',
      pathIsHtml: true,
      draft: '<main>HTML atom</main>',
    })).toBe(true)
  })

  it('derives the rendered view target from .views source paths', () => {
    expect(viewPackageRootForSourcePath(
      'clients/acme/.views/overview/src/App.tsx',
    )).toBe('clients/acme/.views/overview')
    expect(viewPackageRootForSourcePath('clients/acme/tasks.md')).toBeNull()
  })

  it('keeps source-first files in the highlighted source editor without a done action', () => {
    expect(ATOM_VIEW_SRC).toContain('const sourceLocked = isSourceFirstPath(path)')
    expect(ATOM_VIEW_SRC).not.toContain('✓ done')
  })
})
