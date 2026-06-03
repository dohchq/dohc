import { describe, expect, it } from 'vitest'
import type { FileRow, FolderInput } from './path-tree'
import {
  applyPendingTreeMoves,
  pendingTreeMoveSettled,
  projectTreePath,
  type PendingTreeMove,
} from './file-tree-optimistic'

const files: FileRow[] = [
  {
    _id: 'atom_a',
    path: 'inbox/note.md',
    title: 'Note',
    source: 'user',
    fileId: 'file_a',
  },
  {
    _id: 'atom_b',
    path: 'projects/alpha/spec.md',
    title: 'Spec',
    source: 'user',
    fileId: 'file_b',
  },
]

const folders: FolderInput[] = [
  'inbox',
  { path: 'projects/alpha', starred: true, color: 'green' },
]

describe('optimistic file tree moves', () => {
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

  it('projects a pending folder move across nested files and rich folders', () => {
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
    expect(projected.folders).toEqual([
      'inbox',
      { path: 'archive/alpha', starred: true, color: 'green' },
    ])
    expect(projectTreePath('projects/alpha/spec.md', pending)).toBe(
      'archive/alpha/spec.md',
    )
  })

  it('keeps a pending move until the live projection catches up', () => {
    const move: PendingTreeMove = {
      id: 'move-1',
      kind: 'file',
      fromPath: 'inbox/note.md',
      toPath: 'projects/alpha/note.md',
    }

    expect(pendingTreeMoveSettled(move, files, folders)).toBe(false)
    expect(
      pendingTreeMoveSettled(
        move,
        [{ ...files[0]!, path: 'projects/alpha/note.md' }],
        folders,
      ),
    ).toBe(true)
  })
})
