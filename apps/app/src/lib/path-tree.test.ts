import { describe, it, expect } from 'vitest'
import { buildTree, type FolderInput, type FileRow } from './path-tree'

// file-org-v1 §5.7 / D4.5 — buildTree + sort tests. The sort rule:
//   1. folders before leaves
//   2. starred before unstarred (within each tier)
//   3. alphabetical (locale-aware) ties broken last
// Empty folders STILL sort as folders (the previous code mis-handled
// this — children.length===0 was treated as a leaf for sort purposes).

function row(path: string, opts: Partial<FileRow> = {}): FileRow {
  return {
    _id: `id_${path}`,
    path,
    source: 'user',
    ...opts,
  }
}

describe('buildTree — D4.5 sort order (folders → starred → alphabetical)', () => {
  it('folders sort BEFORE leaves at every level', () => {
    const tree = buildTree(
      [row('zeta.md'), row('alpha/inner.md')],
      ['alpha'],
    )
    expect(tree.children.map((c) => c.segment)).toEqual(['alpha', 'zeta.md'])
  })

  it('starred folders sort BEFORE unstarred within the folder tier', () => {
    const folders: FolderInput[] = [
      { path: 'archive' },
      { path: 'team', starred: true },
      { path: 'notes' },
    ]
    const tree = buildTree([], folders)
    expect(tree.children.map((c) => c.segment)).toEqual([
      'team', // starred folder, first
      'archive', // alphabetical among unstarred
      'notes',
    ])
  })

  it('starred leaves sort BEFORE unstarred leaves within the leaf tier', () => {
    const tree = buildTree([
      row('readme.md'),
      row('alpha.md', { starred: true }),
      row('zeta.md', { starred: true }),
      row('beta.md'),
    ])
    expect(tree.children.map((c) => c.segment)).toEqual([
      'alpha.md', // starred, alphabetical first
      'zeta.md',  // starred
      'beta.md',  // unstarred alphabetical
      'readme.md',
    ])
  })

  it('decorated-empty folder carries icon + color + starred onto the TreeNode', () => {
    const folders: FolderInput[] = [
      { path: 'team', icon: 'folder-heart', color: 'blue', starred: true },
    ]
    const tree = buildTree([], folders)
    const team = tree.children.find((c) => c.segment === 'team')
    expect(team).toBeTruthy()
    expect(team!.icon).toBe('folder-heart')
    expect(team!.color).toBe('blue')
    expect(team!.starred).toBe(true)
  })

  // R3 fold (indep FAIL-5) — explicit lock on the new semantic.
  // Previously `children.length > 0` mis-classified empty listed
  // folders as leaves. The fix moved to `page === null`; this
  // test isolates that branch.
  it('an EMPTY listed folder still sorts BEFORE a leaf at the same level', () => {
    const tree = buildTree([row('zeta.md')], ['alpha'])
    expect(tree.children.map((c) => c.segment)).toEqual([
      'alpha', // empty folder
      'zeta.md', // leaf
    ])
  })

  it('legacy string-array folders continue to work (no cosmetics)', () => {
    const tree = buildTree([], ['team', 'archive'])
    expect(tree.children.map((c) => c.segment).sort()).toEqual([
      'archive',
      'team',
    ])
    expect(tree.children[0]!.icon).toBeFalsy()
    expect(tree.children[0]!.color).toBeFalsy()
    expect(tree.children[0]!.starred).toBeFalsy()
  })
})
