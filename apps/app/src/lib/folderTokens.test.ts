import { describe, it, expect } from 'vitest'
import {
  FOLDER_COLORS,
  FOLDER_ICONS,
  iconComponentFor,
  colorVarFor,
  isFolderColor,
  isFolderIcon,
} from './folderTokens'

// file-org-v1 §2.2 + §4.3 / D4.5 — folderTokens catalog tests.
// The allowlists must MIRROR convex/atomLocks.ts (the data-layer
// source of truth that rejects misspelled writes). A drift between
// the two would let the user pick a color the server rejects.

describe('folderTokens — UI-side catalog of FOLDER_COLORS / FOLDER_ICONS', () => {
  it('FOLDER_COLORS includes the 8-entry list (default + 7 chromatic)', () => {
    expect(FOLDER_COLORS).toEqual([
      'default',
      'red',
      'orange',
      'yellow',
      'green',
      'blue',
      'purple',
      'pink',
    ])
  })

  it('FOLDER_ICONS includes the 9-entry list', () => {
    expect(FOLDER_ICONS.length).toBe(9)
    expect(FOLDER_ICONS).toContain('folder')
    expect(FOLDER_ICONS).toContain('folder-heart')
    expect(FOLDER_ICONS).toContain('folder-archive')
  })

  it('iconComponentFor returns a renderable React component for every allowlist entry', () => {
    for (const name of FOLDER_ICONS) {
      const Cmp = iconComponentFor(name)
      expect(typeof Cmp).toBe('object') // lucide components are forwardRef objects
    }
  })

  it('iconComponentFor fails soft for null / unknown / undefined ⇒ base Folder', () => {
    const base = iconComponentFor('folder')
    expect(iconComponentFor(null)).toBe(base)
    expect(iconComponentFor(undefined)).toBe(base)
    expect(iconComponentFor('nuke')).toBe(base)
  })

  it('colorVarFor maps default/null/undefined to --color-ink-dim; chromatic to --color-folder-<name>', () => {
    expect(colorVarFor(null)).toBe('var(--color-ink-dim)')
    expect(colorVarFor(undefined)).toBe('var(--color-ink-dim)')
    expect(colorVarFor('default')).toBe('var(--color-ink-dim)')
    expect(colorVarFor('blue')).toBe('var(--color-folder-blue, var(--color-ink-dim))')
    expect(colorVarFor('red')).toBe('var(--color-folder-red, var(--color-ink-dim))')
  })

  it('isFolderColor / isFolderIcon enforce the allowlist', () => {
    expect(isFolderColor('blue')).toBe(true)
    expect(isFolderColor('chartreuse')).toBe(false)
    expect(isFolderIcon('folder')).toBe(true)
    expect(isFolderIcon('atomic-nuke')).toBe(false)
  })
})

