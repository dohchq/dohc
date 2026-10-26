import { describe, expect, it } from 'vitest'
import type { FileRow, FolderInput } from './path-tree'
import {
  applyPendingTreeMoves,
  pendingTreeChangeSettled,
  projectTreePath,
  type AnsweredTreeChange,
  type PendingTreeChange,
  type PendingTreeMove,
} from './file-tree-optimistic'

// Ported near as-is with the desktop row-type retype: rows are {path, kind}
// and folders are plain path strings.

const files: FileRow[] = [
  { path: 'inbox/note.md', kind: 'file' },
  { path: 'projects/alpha/spec.md', kind: 'file' },
]

const folders: FolderInput[] = ['inbox', 'projects/alpha']

describe('optimistic file tree moves', () => {
  it('preserves listing references when there are no pending changes', () => {
    const projected = applyPendingTreeMoves(files, folders, [])

    expect(projected.files).toBe(files)
    expect(projected.folders).toBe(folders)
  })

  it('projects a pending file move into the rendered file rows', () => {
    const pending: PendingTreeMove[] = [
      {
        id: 'move-1',
        kind: 'file',
        fromPath: 'inbox/note.md',
        toPath: 'projects/alpha/note.md',
      },
    ]

    const projected = applyPendingTreeMoves(files, folders, pending)

    expect(projected.files.map((file) => file.path)).toEqual([
      'projects/alpha/note.md',
      'projects/alpha/spec.md',
    ])
    expect(projectTreePath('inbox/note.md', pending)).toBe(
      'projects/alpha/note.md',
    )
  })

  it('projects a pending folder move across nested files and folders', () => {
    const pending: PendingTreeMove[] = [
      {
        id: 'move-1',
        kind: 'folder',
        fromPath: 'projects/alpha',
        toPath: 'archive/alpha',
      },
    ]

    const projected = applyPendingTreeMoves(files, folders, pending)

    expect(projected.files.map((file) => file.path)).toEqual([
      'inbox/note.md',
      'archive/alpha/spec.md',
    ])
    expect(projected.folders).toEqual(['inbox', 'archive/alpha'])
    expect(projectTreePath('projects/alpha/spec.md', pending)).toBe(
      'archive/alpha/spec.md',
    )
  })

  it('keeps a change main has not answered through every listing', () => {
    const move: AnsweredTreeChange = {
      id: 'move-1',
      kind: 'file',
      fromPath: 'inbox/note.md',
      toPath: 'projects/alpha/note.md',
    }

    expect(pendingTreeChangeSettled(move, 0)).toBe(false)
    expect(pendingTreeChangeSettled(move, 99)).toBe(false)
  })

  it('settles an answered change with its listing or a later one, never an earlier one', () => {
    const deleted: AnsweredTreeChange = {
      id: 'delete-1',
      kind: 'delete-file',
      path: 'inbox/note.md',
      listing: 4,
    }

    expect(pendingTreeChangeSettled(deleted, 3)).toBe(false)
    expect(pendingTreeChangeSettled(deleted, 4)).toBe(true)
    expect(pendingTreeChangeSettled(deleted, 5)).toBe(true)
  })

  it('projects pending creates into the rendered tree rows', () => {
    const pending: PendingTreeChange[] = [
      { id: 'create-file', kind: 'create-file', path: 'ideas/new.md' },
      { id: 'create-folder', kind: 'create-folder', path: 'ideas' },
    ]

    const projected = applyPendingTreeMoves(files, folders, pending)

    expect(projected.files.map((file) => file.path)).toContain('ideas/new.md')
    expect(projected.files.find((file) => file.path === 'ideas/new.md')).toEqual(
      { path: 'ideas/new.md', kind: 'file' },
    )
    expect(projected.folders).toContain('ideas')
  })

  it('projects pending deletes and clears active paths inside them', () => {
    const pending: PendingTreeChange[] = [
      { id: 'delete-folder', kind: 'delete-folder', path: 'projects/alpha' },
    ]

    const projected = applyPendingTreeMoves(files, folders, pending)

    expect(projected.files.map((file) => file.path)).toEqual(['inbox/note.md'])
    expect(projected.folders).toEqual(['inbox'])
    expect(projectTreePath('projects/alpha/spec.md', pending)).toBeNull()
  })

})
