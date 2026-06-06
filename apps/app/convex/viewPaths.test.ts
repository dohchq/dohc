import { describe, expect, it } from 'vitest'
import {
  isAppPackageRoot,
  isAppPath,
  parseAppPath,
  resolveScopeRelativePath,
  titleFromAppName,
} from './appPaths'
import {
  isViewPackageRoot,
  isViewPath,
  parseViewPath,
  titleFromViewName,
} from './viewPaths'

describe('.apps path semantics', () => {
  it('parses root workspace app source files', () => {
    expect(parseAppPath('.apps/home/src/App.tsx')).toMatchObject({
      scopePath: '',
      packageRoot: '.apps/home',
      appName: 'home',
      relativePath: 'src/App.tsx',
    })
  })

  it('parses folder-local app source files and rejects legacy view paths', () => {
    expect(parseAppPath('finance/.apps/tracker/src/App.tsx')).toMatchObject({
      scopePath: 'finance',
      packageRoot: 'finance/.apps/tracker',
      appName: 'tracker',
      relativePath: 'src/App.tsx',
    })
    expect(parseAppPath('finance/.views/tracker/src/App.tsx')).toBeNull()
  })

  it('detects app source paths and package roots separately', () => {
    expect(isAppPath('clients/acme/.apps/overview/src/App.tsx')).toBe(true)
    expect(isAppPath('clients/acme/.views/overview/src/App.tsx')).toBe(false)
    expect(isAppPath('clients/acme/.apps/overview/src/\u0000App.tsx')).toBe(false)
    expect(isAppPackageRoot('clients/acme/.apps/overview')).toBe(true)
    expect(isAppPackageRoot('clients/acme/.apps/overview/src/App.tsx')).toBe(false)
  })

  it('derives calm titles from app folder names', () => {
    expect(titleFromAppName('client-portal')).toBe('Client Portal')
    expect(titleFromAppName('weekly_review')).toBe('Weekly Review')
    expect(titleFromAppName('')).toBe('Untitled App')
  })
})

describe('.views path semantics', () => {
  it('parses root workspace view source files', () => {
    expect(parseViewPath('.views/home/src/App.tsx')).toMatchObject({
      scopePath: '',
      packageRoot: '.views/home',
      viewName: 'home',
      relativePath: 'src/App.tsx',
    })
  })

  it('parses folder-local view source files', () => {
    expect(parseViewPath('clients/acme/.views/overview/src/App.tsx')).toMatchObject({
      scopePath: 'clients/acme',
      packageRoot: 'clients/acme/.views/overview',
      viewName: 'overview',
      relativePath: 'src/App.tsx',
    })
  })

  it('rejects incomplete or non-hidden view-looking paths', () => {
    expect(parseViewPath('clients/.views/overview')).toBeNull()
    expect(parseViewPath('clients/acme/views/overview/src/App.tsx')).toBeNull()
    expect(parseViewPath('.views/home')).toBeNull()
    expect(parseViewPath('clients/acme/.views//src/App.tsx')).toBeNull()
    expect(parseViewPath('clients/acme/.views/overview/src/\u0000App.tsx')).toBeNull()
    expect(parseViewPath('clients/.views/a/.views/b/src/App.tsx')).toBeNull()
    expect(parseViewPath('/.views/home/src/App.tsx')).toMatchObject({
      packageRoot: '.views/home',
      relativePath: 'src/App.tsx',
    })
  })

  it('detects source paths and package roots separately', () => {
    expect(isViewPath('clients/acme/.views/overview/src/App.tsx')).toBe(true)
    expect(isViewPath('clients/acme/views/overview/src/App.tsx')).toBe(false)
    expect(isViewPath('clients/acme/.views/overview/src/\u0000App.tsx')).toBe(false)
    expect(isViewPath('clients/.views/a/.views/b/src/App.tsx')).toBe(false)
    expect(isViewPackageRoot('clients/acme/.views/overview')).toBe(true)
    expect(isViewPackageRoot('clients/acme/.views/overview/src/App.tsx')).toBe(false)
    expect(isViewPackageRoot('clients/acme/.views/overview/\u0000')).toBe(false)
    expect(isViewPackageRoot('clients/.views/a/.views/b')).toBe(false)
  })

  it('derives calm titles from view folder names', () => {
    expect(titleFromViewName('client-portal')).toBe('Client Portal')
    expect(titleFromViewName('weekly_review')).toBe('Weekly Review')
    expect(titleFromViewName('')).toBe('Untitled View')
  })

  it('resolves scope-relative data paths without traversal', () => {
    expect(resolveScopeRelativePath('clients/acme', '.')).toBe('clients/acme')
    expect(resolveScopeRelativePath('clients/acme', 'tasks.md')).toBe('clients/acme/tasks.md')
    expect(resolveScopeRelativePath('', '.')).toBe('')
    expect(resolveScopeRelativePath('', 'tasks.md')).toBe('tasks.md')
    expect(resolveScopeRelativePath('clients/acme', '../private.md')).toBeNull()
    expect(resolveScopeRelativePath('clients/acme', '/absolute.md')).toBeNull()
    expect(resolveScopeRelativePath('clients/acme', 'bad//path.md')).toBe('clients/acme/bad/path.md')
  })
})
