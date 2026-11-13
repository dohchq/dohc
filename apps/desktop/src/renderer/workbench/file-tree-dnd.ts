import { basenameOf, dirnameOf } from "../path";
// Drag-and-drop planning. A pure function for the same reason as
// `navigateTree`: the test harness is node-only, with no DOM. The
// component sets up HTML5 DnD events; this function computes the
// move semantics from {source, target}.
//
// Drop semantics (the VSCode and Finder convention), for a file or
// a folder as the source:
//   • Target = folder ⇒ move the source into that folder.
//   • Target = file ⇒ move the source next to it, into its parent
//     folder.
//   • Target = root (no row, just the tree container) ⇒ move to
//     the workspace root.
//
// planDrop returns 'noop' with a reason, which the caller may
// announce or alert, in three cases:
//   • The source is already in the target folder under the same
//     leaf name.
//   • A folder is dropped onto itself or a descendant. The backend
//     folders.move would also refuse, but a UI no-op is clearer
//     than a thrown error.
//   • The source is dropped onto its own row.
//
// All other refusals (lock guards, FOLDER_MOVE_WRITE_CAP, etc.)
// surface from the backend mutation, and the caller alerts.

export type DragSource = {
  /** The full path of the dragged row. */
  path: string;
  /** 'file' OR 'folder' — discriminates which mutation to call. */
  kind: "file" | "folder";
};

/** The target as resolved by the drop handler. `parentDir` is the
 *  folder that will contain the moved item — '' means workspace
 *  root. Computed by the caller based on what the user dropped on
 *  (a folder row, a file row's parent, or the root container). */
type DropTarget = {
  parentDir: string;
};

type DropAction =
  | { kind: "move-file"; fromPath: string; toPath: string }
  | { kind: "move-folder"; fromPath: string; toPath: string }
  | { kind: "noop"; reason: string };

export function planDrop(source: DragSource, target: DropTarget): DropAction {
  const sourceParent = dirnameOf(source.path);
  const leaf = basenameOf(source.path);

  // Same parent ⇒ no-op (nothing to do; the item is already where
  // the user is asking).
  if (sourceParent === target.parentDir) {
    return { kind: "noop", reason: "already in target folder" };
  }

  // Folder dropped onto itself or a descendant ⇒ no-op. The
  // backend's folders.move would refuse with "can't move a folder
  // into itself"; this short-circuit gives the UI cleaner
  // feedback without round-tripping the error.
  if (source.kind === "folder") {
    if (target.parentDir === source.path || target.parentDir.startsWith(`${source.path}/`)) {
      return { kind: "noop", reason: "cannot move a folder into itself" };
    }
  }

  const toPath = target.parentDir === "" ? leaf : `${target.parentDir}/${leaf}`;

  return source.kind === "file"
    ? { kind: "move-file", fromPath: source.path, toPath }
    : { kind: "move-folder", fromPath: source.path, toPath };
}
