// file-org-v1 D4.7 — drag-and-drop planning. Extracted as a pure
// function for the same reason as `navigateTree` (the harness is
// node-only, no DOM). The component sets up HTML5 DnD events; this
// function computes the move semantics from {source, target}.
//
// Drop semantics (VSCode + Finder convention):
//   • Source = file, target = folder ⇒ move file INTO folder.
//   • Source = file, target = file ⇒ move source NEXT TO target
//     (i.e., into target's parent folder).
//   • Source = folder, target = folder ⇒ move source INTO target.
//   • Source = folder, target = file ⇒ move source NEXT TO target
//     (i.e., into target's parent folder).
//   • Target = root (no row, just the tree container) ⇒ move to
//     workspace root.
//
// Refusals (planDrop returns 'noop' with a reason — caller may
// announce or alert):
//   • Source.path === target.parentDir + '/' + leaf (already in
//     target folder + same leaf name) ⇒ no-op.
//   • Folder dropped onto itself or a descendant ⇒ no-op (the
//     backend folders.move would also refuse, but a UI no-op is
//     cleaner than a confusing thrown error).
//   • Source.path === target row's path ⇒ no-op (dropping onto
//     itself).
//
// All other refusals (lock guards, FOLDER_MOVE_WRITE_CAP, etc.)
// surface from the backend mutation — the caller catches + alerts.

export type DragSource = {
  /** The full path of the dragged row. */
  path: string
  /** 'file' OR 'folder' — discriminates which mutation to call. */
  kind: 'file' | 'folder'
}

/** The target as resolved by the drop handler. `parentDir` is the
 *  folder that will CONTAIN the moved item — '' means workspace
 *  root. Computed by the caller based on what the user dropped on
 *  (a folder row, a file row's parent, or the root container). */
export type DropTarget = {
  parentDir: string
}

export type DropAction =
  | { kind: 'move-file'; fromPath: string; toPath: string }
  | { kind: 'move-folder'; fromPath: string; toPath: string }
  | { kind: 'noop'; reason: string }

function leafOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? path : path.slice(idx + 1)
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? '' : path.slice(0, idx)
}

export function planDrop(
  source: DragSource,
  target: DropTarget,
): DropAction {
  const sourceParent = parentOf(source.path)
  const leaf = leafOf(source.path)

  // Same parent ⇒ no-op (nothing to do; the item is already where
  // the user is asking).
  if (sourceParent === target.parentDir) {
    return { kind: 'noop', reason: 'already in target folder' }
  }

  // Folder dropped onto itself or a descendant ⇒ no-op. The
  // backend's folders.move would refuse with "can't move a folder
  // into itself"; this short-circuit gives the UI cleaner
  // feedback without round-tripping the error.
  if (source.kind === 'folder') {
    if (
      target.parentDir === source.path ||
      target.parentDir.startsWith(`${source.path}/`)
    ) {
      return { kind: 'noop', reason: 'cannot move a folder into itself' }
    }
  }

  const toPath =
    target.parentDir === '' ? leaf : `${target.parentDir}/${leaf}`

  return source.kind === 'file'
    ? { kind: 'move-file', fromPath: source.path, toPath }
    : { kind: 'move-folder', fromPath: source.path, toPath }
}
