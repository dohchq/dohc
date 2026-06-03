import type { FileRow, FolderInput } from './path-tree'

export type PendingTreeMove = {
  id: string
  kind: 'file' | 'folder'
  fromPath: string
  toPath: string
}

export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function pathInsideFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`)
}

function projectPathForMove(path: string, move: PendingTreeMove): string {
  if (move.kind === 'file') {
    return path === move.fromPath ? move.toPath : path
  }
  if (!pathInsideFolder(path, move.fromPath)) return path
  return `${move.toPath}${path.slice(move.fromPath.length)}`
}

export function projectTreePath(
  path: string | null,
  moves: ReadonlyArray<PendingTreeMove>,
): string | null {
  if (path === null || moves.length === 0) return path
  return moves.reduce((next, move) => projectPathForMove(next, move), path)
}

export function applyPendingTreeMoves(
  files: ReadonlyArray<FileRow>,
  folders: ReadonlyArray<FolderInput>,
  moves: ReadonlyArray<PendingTreeMove>,
): { files: FileRow[]; folders: FolderInput[] } {
  if (moves.length === 0) return { files: [...files], folders: [...folders] }
  return {
    files: files.map((file) => {
      const path = projectTreePath(file.path, moves)!
      return path === file.path ? file : { ...file, path }
    }),
    folders: folders.map((folder) => {
      const path = typeof folder === 'string' ? folder : folder.path
      const nextPath = projectTreePath(path, moves)!
      if (nextPath === path) return folder
      return typeof folder === 'string' ? nextPath : { ...folder, path: nextPath }
    }),
  }
}

export function pendingTreeMoveSettled(
  move: PendingTreeMove,
  files: ReadonlyArray<FileRow>,
  folders: ReadonlyArray<FolderInput>,
): boolean {
  if (move.kind === 'file') {
    return files.some((file) => file.path === move.toPath)
  }
  return (
    folders.some((folder) =>
      typeof folder === 'string'
        ? folder === move.toPath
        : folder.path === move.toPath,
    ) || files.some((file) => pathInsideFolder(file.path, move.toPath))
  )
}
