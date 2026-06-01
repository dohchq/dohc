import { describe, expect, it } from 'vitest'
import {
  isSourceFirstPath,
  shouldRenderHtmlAtomFrame,
  viewPackageRootForSourcePath,
} from '../lib/viewSourceBehavior'

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
})
