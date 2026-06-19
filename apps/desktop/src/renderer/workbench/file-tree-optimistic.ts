// Optimistic pending-op overlay for the explorer tree, ported from the old
// web app's file-tree-optimistic lib. Retyped for the desktop: FileRow is the
// {path, kind} wire shape and folders are plain path strings (the pre-pivot
// _id/title/source fabrication is gone). Pure: pending changes are projected
// onto (files, folders) until the authoritative refresh confirms them.
import type { FileRow, FolderInput } from './path-tree'

export type PendingTreeMove = {
  id: string
  kind: 'file' | 'folder'
  fromPath: string
  toPath: string
}

export type PendingTreeChange =
  | PendingTreeMove
  | { id: string; kind: 'create-file' | 'create-folder'; path: string }
  | { id: string; kind: 'delete-file' | 'delete-folder'; path: string }

export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

// Not exported on the desktop (knip single-consumer rule): every caller
// lives in this module.
function pathInsideFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`)
}

function projectPathForChange(
  path: string,
  change: PendingTreeChange,
): string | null {
  if (change.kind === 'delete-file') {
    return path === change.path ? null : path
  }
  if (change.kind === 'delete-folder') {
    return pathInsideFolder(path, change.path) ? null : path
  }
  if (change.kind === 'file') {
    return path === change.fromPath ? change.toPath : path
  }
  if (change.kind === 'folder') {
    if (!pathInsideFolder(path, change.fromPath)) return path
    return `${change.toPath}${path.slice(change.fromPath.length)}`
  }
  return path
}

export function projectTreePath(
  path: string | null,
  moves: ReadonlyArray<PendingTreeChange>,
): string | null {
  if (path === null || moves.length === 0) return path
  return moves.reduce<string | null>(
    (next, move) => (next === null ? null : projectPathForChange(next, move)),
    path,
  )
}

export function applyPendingTreeMoves(
  files: ReadonlyArray<FileRow>,
  folders: ReadonlyArray<FolderInput>,
  moves: ReadonlyArray<PendingTreeChange>,
): { files: FileRow[]; folders: FolderInput[] } {
  if (moves.length === 0) return { files: [...files], folders: [...folders] }
  let nextFiles = [...files]
  let nextFolders = [...folders]

  for (const change of moves) {
    if (change.kind === 'create-file') {
      if (!nextFiles.some((file) => file.path === change.path)) {
        nextFiles.push({ path: change.path, kind: 'file' })
      }
      continue
    }
    if (change.kind === 'create-folder') {
      if (!nextFolders.includes(change.path)) nextFolders.push(change.path)
      continue
    }

    nextFiles = nextFiles.flatMap((file) => {
      const path = projectPathForChange(file.path, change)
      return path === null ? [] : [path === file.path ? file : { ...file, path }]
    })
    nextFolders = nextFolders.flatMap((folder) => {
      const nextPath = projectPathForChange(folder, change)
      if (nextPath === null) return []
      return [nextPath === folder ? folder : nextPath]
    })
  }

  return { files: nextFiles, folders: nextFolders }
}

export function pendingTreeMoveSettled(
  move: PendingTreeChange,
  files: ReadonlyArray<FileRow>,
  folders: ReadonlyArray<FolderInput>,
): boolean {
  if (move.kind === 'create-file') {
    return files.some((file) => file.path === move.path)
  }
  if (move.kind === 'create-folder') {
    return folders.includes(move.path)
  }
  if (move.kind === 'delete-file') {
    return !files.some((file) => file.path === move.path)
  }
  if (move.kind === 'delete-folder') {
    return (
      !folders.some((folder) => pathInsideFolder(folder, move.path)) &&
      !files.some((file) => pathInsideFolder(file.path, move.path))
    )
  }
  if (move.kind === 'file') {
    return files.some((file) => file.path === move.toPath)
  }
  if (move.kind === 'folder') {
    return (
      folders.includes(move.toPath) ||
      files.some((file) => pathInsideFolder(file.path, move.toPath))
    )
  }
  return false
}
