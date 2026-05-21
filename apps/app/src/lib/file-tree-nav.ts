// file-org-v1 §4.5 / D4.3 — WAI-ARIA tree navigation. The keyboard
// behavior is extracted as a pure function so it's testable without
// a DOM (vitest is node + edge-runtime; no jsdom). The FileTree
// component flattens its visible rows in order, calls `navigateTree`
// on each keydown, and dispatches the returned action (focus a row,
// expand/collapse a folder, open a leaf).
//
// Spec source: WAI-ARIA Authoring Practices — tree pattern.
// https://www.w3.org/WAI/ARIA/apg/patterns/treeview/
//   • Roving tabIndex (one tabIndex=0; all others tabIndex=-1).
//   • ArrowUp/ArrowDown — focus prev/next visible row.
//   • ArrowRight — on collapsed folder: expand. On expanded folder:
//     focus first child. On leaf: no-op.
//   • ArrowLeft — on expanded folder: collapse. On collapsed folder
//     or leaf: focus parent (or no-op at root).
//   • Enter/Space — open the leaf (router nav) or toggle the folder.
//   • Home/End — focus first/last visible row.

export type FlatRow = {
  /** The canonical path that uniquely identifies the row. */
  fullPath: string
  /** True for folder rows (no `page`); false for leaf rows. */
  isFolder: boolean
  /** Folder-only: is this folder currently expanded? */
  isExpanded: boolean
  /** Depth (root rows are 0). Used for aria-level (= depth+1). */
  depth: number
  /** Parent folder's fullPath, or null at the root level. */
  parentPath: string | null
}

export type NavAction =
  | { kind: 'focus'; path: string }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'open'; path: string }
  | { kind: 'toggle'; path: string }
  | null

/** Pure: given the current visible-rows order, focused path, and the
 *  pressed key, return the navigation action to perform.
 *
 *  `rows` MUST be in render order (the visible row sequence the user
 *  sees top-to-bottom). The function tolerates a missing currentPath
 *  by returning a `focus` action onto the first row — initial-focus
 *  bootstrap. */
export function navigateTree(
  rows: ReadonlyArray<FlatRow>,
  currentPath: string | null,
  key: string,
): NavAction {
  if (rows.length === 0) return null

  const idx =
    currentPath === null
      ? -1
      : rows.findIndex((r) => r.fullPath === currentPath)
  const cur = idx >= 0 ? rows[idx]! : null

  switch (key) {
    case 'ArrowDown': {
      if (idx < 0) return { kind: 'focus', path: rows[0]!.fullPath }
      const next = rows[idx + 1]
      return next ? { kind: 'focus', path: next.fullPath } : null
    }
    case 'ArrowUp': {
      if (idx <= 0) return null
      return { kind: 'focus', path: rows[idx - 1]!.fullPath }
    }
    case 'ArrowRight': {
      if (!cur) return null
      if (cur.isFolder) {
        if (!cur.isExpanded) return { kind: 'expand', path: cur.fullPath }
        // Already expanded — focus first child if any.
        const child = rows[idx + 1]
        if (child && child.parentPath === cur.fullPath) {
          return { kind: 'focus', path: child.fullPath }
        }
        return null
      }
      return null
    }
    case 'ArrowLeft': {
      if (!cur) return null
      if (cur.isFolder && cur.isExpanded) {
        return { kind: 'collapse', path: cur.fullPath }
      }
      // Leaf, or collapsed folder ⇒ focus parent (if any).
      if (cur.parentPath !== null) {
        return { kind: 'focus', path: cur.parentPath }
      }
      return null
    }
    case 'Enter':
    case ' ': {
      if (!cur) return null
      return cur.isFolder
        ? { kind: 'toggle', path: cur.fullPath }
        : { kind: 'open', path: cur.fullPath }
    }
    case 'Home':
      return { kind: 'focus', path: rows[0]!.fullPath }
    case 'End':
      return { kind: 'focus', path: rows[rows.length - 1]!.fullPath }
    default:
      return null
  }
}
