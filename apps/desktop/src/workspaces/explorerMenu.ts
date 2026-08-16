import type { ExplorerMenuCommand } from "../ipc/bridgeContract";
import { shareViewTakesLocalWrites, type ShareViewWriteScope } from "./shareWriteGate";

// WHAT THE EXPLORER'S CONTEXT MENU OFFERS — one decision, in one place.
//
// main owns this menu, so the renderer cannot add an item back; that is why
// the reduction below is a security surface and not a convenience. It lives
// here rather than inside main's IPC closure for the reason `shareChatGate.ts`
// states: a menu built inline in a 9,000-line closure can only be pinned by
// reading the source, and a source pin proves position, never behaviour.
//
// The menu MIRRORS the write gates behind it. It must offer exactly what those
// handlers accept, because an item that is refused when clicked is the surface
// lying about what it can do.

export type ExplorerMenuEntry =
  | { kind: "item"; label: string; id: ExplorerMenuCommand }
  | { kind: "separator" };

export interface ExplorerMenuScope {
  // What was right-clicked.
  kind: "root" | "folder" | "file";
  pinned: boolean;
  // A shared-with-me/… path: a read-only projection of someone else's files.
  isMountPath: boolean;
  // That path is a mount ROOT with a matching mount record.
  hasMountRecord: boolean;
  // Sharing onward is offered only from a synced workspace this account owns.
  canShare: boolean;
  // The share view this workspace IS, or null for an ordinary workspace.
  shareView: ShareViewWriteScope | null;
}

const item = (label: string, id: ExplorerMenuCommand): ExplorerMenuEntry => ({
  kind: "item",
  label,
  id,
});
const separator: ExplorerMenuEntry = { kind: "separator" };

export function explorerMenuEntries(scope: ExplorerMenuScope): ExplorerMenuEntry[] {
  const isSharedView = scope.shareView !== null;
  // The four routed operations — create, rename, delete, import (#802) —
  // offered exactly where their handlers accept them: everywhere in an
  // ordinary workspace, and in a share view only at the level
  // `shareViewTakesLocalWrites` names. One rule, asked once, by the menu and
  // by the handlers both.
  const canWrite = scope.shareView === null || shareViewTakesLocalWrites(scope.shareView);
  // New folder is offered nowhere in a share view, at any level: the engine
  // has no folder object, so an empty folder is nothing the recipient could
  // send. `routeWorkspaceFolderCreate` says the same thing in words.
  const canCreateFolder = canWrite && !isSharedView;

  if (scope.isMountPath) {
    return [
      ...(scope.hasMountRecord
        ? [
            item("Refresh Share", "refresh-share-mount"),
            item("Remove Share from Workspace", "unmount-share"),
            separator,
          ]
        : [item("Refresh Shares", "refresh-share-mount"), separator]),
      scope.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
      separator,
      item("Export as Zip…", "export-zip"),
      item("Reveal in File Manager", "open-externally"),
    ];
  }

  if (scope.kind === "root") {
    return [
      ...(canWrite
        ? [
            item("New File", "new-file"),
            ...(canCreateFolder ? [item("New Folder", "new-folder")] : []),
            separator,
            item("Import Files…", "import-files"),
          ]
        : []),
      item("Export Workspace as Zip…", "export-zip"),
    ];
  }

  return [
    ...(scope.canShare ? [item("Share…", "share"), separator] : []),
    ...(canWrite && scope.kind === "folder"
      ? [
          item("New File", "new-file"),
          ...(canCreateFolder ? [item("New Folder", "new-folder")] : []),
          // Folder-targeted import: files land IN this folder (the renderer
          // passes the folder as importWorkspaceFiles' targetDir, re-validated
          // main-side before any copy).
          item("Import Files…", "import-files"),
          separator,
        ]
      : []),
    ...(canWrite ? [item("Rename", "rename"), item("Delete", "delete")] : []),
    scope.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
    separator,
    item("Export as Zip…", "export-zip"),
    item("Reveal in File Manager", "open-externally"),
  ];
}
