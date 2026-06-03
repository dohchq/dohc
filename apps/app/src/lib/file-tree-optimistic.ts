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

export type PendingTreeChangeInput =
  | Omit<PendingTreeMove, 'id'>
  | { kind: 'create-file' | 'create-folder'; path: string }
  | { kind: 'delete-file' | 'delete-folder'; path: string }

export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

export function pathInsideFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`)
}

function titleForPath(path: string): string {
  const leaf = path.split('/').pop() ?? path
  return leaf.replace(/\.[a-z0-9]+$/i, '') || leaf
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
        nextFiles.push({
          _id: `pending:${change.id}`,
          path: change.path,
          title: titleForPath(change.path),
          source: 'user',
          fileId: null,
        })
      }
      continue
    }
    if (change.kind === 'create-folder') {
      const exists = nextFolders.some((folder) =>
        typeof folder === 'string'
          ? folder === change.path
          : folder.path === change.path,
      )
      if (!exists) nextFolders.push(change.path)
      continue
    }

    nextFiles = nextFiles.flatMap((file) => {
      const path = projectPathForChange(file.path, change)
      return path === null ? [] : [path === file.path ? file : { ...file, path }]
    })
    nextFolders = nextFolders.flatMap((folder) => {
      const path = typeof folder === 'string' ? folder : folder.path
      const nextPath = projectPathForChange(path, change)
      if (nextPath === null) return []
      if (nextPath === path) return [folder]
      return [typeof folder === 'string' ? nextPath : { ...folder, path: nextPath }]
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
    return folders.some((folder) =>
      typeof folder === 'string' ? folder === move.path : folder.path === move.path,
    )
  }
  if (move.kind === 'delete-file') {
    return !files.some((file) => file.path === move.path)
  }
  if (move.kind === 'delete-folder') {
    return (
      !folders.some((folder) =>
        typeof folder === 'string'
          ? pathInsideFolder(folder, move.path)
          : pathInsideFolder(folder.path, move.path),
      ) && !files.some((file) => pathInsideFolder(file.path, move.path))
    )
  }
  if (move.kind === 'file') {
    return files.some((file) => file.path === move.toPath)
  }
  if (move.kind === 'folder') {
    return (
      folders.some((folder) =>
        typeof folder === 'string'
          ? folder === move.toPath
          : folder.path === move.toPath,
      ) || files.some((file) => pathInsideFolder(file.path, move.toPath))
    )
  }
  return false
}
