import { describe, it, expect } from 'vitest'
import { navigateTree, type FlatRow } from './file-tree-nav'

// file-org-v1 D4.3 — keyboard-nav unit tests. Pure function; no DOM.

// Sample tree:
//   team/           (folder, expanded)
//     anna.md       (leaf)
//     ben.md        (leaf)
//   notes/          (folder, collapsed)
//   _map.md         (leaf, root)
function sampleRows(opts: { teamExpanded?: boolean } = {}): FlatRow[] {
  const teamExpanded = opts.teamExpanded ?? true
  return [
    {
      fullPath: 'team',
      isFolder: true,
      isExpanded: teamExpanded,
      depth: 0,
      parentPath: null,
    },
    ...(teamExpanded
      ? ([
          {
            fullPath: 'team/anna.md',
            isFolder: false,
            isExpanded: false,
            depth: 1,
            parentPath: 'team',
          },
          {
            fullPath: 'team/ben.md',
            isFolder: false,
            isExpanded: false,
            depth: 1,
            parentPath: 'team',
          },
        ] as FlatRow[])
      : []),
    {
      fullPath: 'notes',
      isFolder: true,
      isExpanded: false,
      depth: 0,
      parentPath: null,
    },
    {
      fullPath: '_map.md',
      isFolder: false,
      isExpanded: false,
      depth: 0,
      parentPath: null,
    },
  ]
}

describe('navigateTree — WAI-ARIA tree keyboard pattern', () => {
  it('ArrowDown moves focus to the next visible row; ArrowDown at last row is no-op', () => {
    const rows = sampleRows()
    expect(navigateTree(rows, 'team', 'ArrowDown')).toEqual({
      kind: 'focus',
      path: 'team/anna.md',
    })
    expect(navigateTree(rows, '_map.md', 'ArrowDown')).toBeNull()
  })

  it('ArrowUp moves focus to the previous visible row; ArrowUp at first row is no-op', () => {
    const rows = sampleRows()
    expect(navigateTree(rows, 'team/anna.md', 'ArrowUp')).toEqual({
      kind: 'focus',
      path: 'team',
    })
    expect(navigateTree(rows, 'team', 'ArrowUp')).toBeNull()
  })

  it('ArrowRight on collapsed folder expands; on expanded folder focuses first child; on leaf is no-op', () => {
    const collapsedRows = sampleRows({ teamExpanded: false })
    expect(navigateTree(collapsedRows, 'team', 'ArrowRight')).toEqual({
      kind: 'expand',
      path: 'team',
    })
    const expandedRows = sampleRows({ teamExpanded: true })
    expect(navigateTree(expandedRows, 'team', 'ArrowRight')).toEqual({
      kind: 'focus',
      path: 'team/anna.md',
    })
    // Leaf — no-op.
    expect(navigateTree(expandedRows, '_map.md', 'ArrowRight')).toBeNull()
  })

  it('ArrowLeft on expanded folder collapses; on collapsed folder or leaf focuses parent (or no-op at root)', () => {
    const rows = sampleRows({ teamExpanded: true })
    expect(navigateTree(rows, 'team', 'ArrowLeft')).toEqual({
      kind: 'collapse',
      path: 'team',
    })
    // Leaf at depth 1 — focus its parent.
    expect(navigateTree(rows, 'team/anna.md', 'ArrowLeft')).toEqual({
      kind: 'focus',
      path: 'team',
    })
    // Root-level leaf — no parent, no-op.
    expect(navigateTree(rows, '_map.md', 'ArrowLeft')).toBeNull()
    // Root-level collapsed folder — no parent, no-op (ArrowLeft on
    // an already-collapsed root folder cannot bubble further).
    expect(navigateTree(rows, 'notes', 'ArrowLeft')).toBeNull()
  })

  it('Enter / Space open a leaf or toggle a folder', () => {
    const rows = sampleRows()
    expect(navigateTree(rows, 'team/anna.md', 'Enter')).toEqual({
      kind: 'open',
      path: 'team/anna.md',
    })
    expect(navigateTree(rows, 'team', 'Enter')).toEqual({
      kind: 'toggle',
      path: 'team',
    })
    expect(navigateTree(rows, '_map.md', ' ')).toEqual({
      kind: 'open',
      path: '_map.md',
    })
  })

  it('Home / End jump to first / last visible row; null currentPath bootstraps focus on ArrowDown', () => {
    const rows = sampleRows()
    expect(navigateTree(rows, 'team/ben.md', 'Home')).toEqual({
      kind: 'focus',
      path: 'team',
    })
    expect(navigateTree(rows, 'team', 'End')).toEqual({
      kind: 'focus',
      path: '_map.md',
    })
    // null currentPath: first ArrowDown focuses the first row.
    expect(navigateTree(rows, null, 'ArrowDown')).toEqual({
      kind: 'focus',
      path: 'team',
    })
    // null currentPath + unrelated key: no-op.
    expect(navigateTree(rows, null, 'Enter')).toBeNull()
  })

  it('empty rows / unknown key are no-op', () => {
    expect(navigateTree([], 'anything', 'ArrowDown')).toBeNull()
    const rows = sampleRows()
    expect(navigateTree(rows, 'team', 'Escape')).toBeNull()
    expect(navigateTree(rows, 'team', 'q')).toBeNull()
  })
})
