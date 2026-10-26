import type { ExplorerMenuCommand, ExplorerMenuEntry } from "../ipc/bridgeContract";
import { workspaceCreateOffers, type ShareViewWriteScope } from "./shareWriteGate";

// WHAT THE EXPLORER'S CONTEXT MENU OFFERS — one decision, in one place.
//
// main decides this menu and the renderer draws exactly the entries main
// returns, so the renderer cannot add an item back; that is why the reduction
// below is a security surface and not a convenience. It lives here rather than
// inside main's IPC closure because a menu built inline in a 9,000-line
// closure can only be pinned by reading the source, and a source pin proves
// position, never behaviour.
//
// The menu mirrors the write gates behind it. It must offer exactly what those
// handlers accept, because an item that is refused when clicked is the surface
// lying about what it can do.

export interface ExplorerMenuScope {
  // What was right-clicked.
  kind: "root" | "folder" | "file";
  pinned: boolean;
  // A shared-with-me/… path: a read-only projection of someone else's files.
  isMountPath: boolean;
  // That path is a mount ROOT with a matching mount record.
  hasMountRecord: boolean;
  // Sharing onward is offered only from this account's own files, not the root.
  canShare: boolean;
  // The share view this workspace IS, or null for an ordinary workspace.
  shareView: ShareViewWriteScope | null;
}

// Each platform's own name for its file manager, as its own apps word the
// command. The Explorer menu and the workspace manager both show it.
export function revealInFileManagerLabel(platform: string | undefined): string {
  if (platform === "darwin") return "Show in Finder";
  if (platform === "win32") return "Show in File Explorer";
  return "Show in file manager";
}

const item = (label: string, id: ExplorerMenuCommand): ExplorerMenuEntry => ({
  kind: "item",
  label,
  id,
});
const separator: ExplorerMenuEntry = { kind: "separator" };

export function explorerMenuEntries(scope: ExplorerMenuScope, platform: string): ExplorerMenuEntry[] {
  const isSharedView = scope.shareView !== null;
  const reveal = item(revealInFileManagerLabel(platform), "open-externally");
  // The four routed operations — create, rename, delete, import — offered
  // exactly where their handlers accept them. One rule, asked once, by the
  // menu, the command rows and the handlers.
  const {
    write: canWrite,
    folder: canCreateFolder,
    collection: canCreateCollection,
  } = workspaceCreateOffers(scope.shareView);

  if (scope.isMountPath) {
    return [
      ...(scope.hasMountRecord
        ? [
            item("Refresh share", "refresh-share-mount"),
            item("Remove share from workspace", "unmount-share"),
            separator,
          ]
        : [item("Refresh shares", "refresh-share-mount"), separator]),
      scope.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
      separator,
      item("Export as zip…", "export-zip"),
      reveal,
    ];
  }

  if (scope.kind === "root") {
    return [
      ...(canWrite
        ? [
            item("New file", "new-file"),
            ...(canCreateFolder ? [item("New folder", "new-folder")] : []),
            ...(canCreateCollection ? [item("New Collection…", "new-collection")] : []),
            separator,
            item("Import files…", "import-files"),
          ]
        : []),
      item("Export workspace as zip…", "export-zip"),
    ];
  }

  return [
    // Sharing onward is refused in a share view here, not only wherever
    // `canShare` is computed: someone else's files are not this account's to
    // grant, and a defense a comment claims but no code performs is not one.
    ...(scope.canShare && !isSharedView ? [item("Share…", "share"), separator] : []),
    ...(canWrite && scope.kind === "folder"
      ? [
          item("New file", "new-file"),
          ...(canCreateFolder ? [item("New folder", "new-folder")] : []),
          ...(canCreateCollection ? [item("New Collection…", "new-collection")] : []),
          // Folder-targeted import: files land IN this folder (the renderer
          // passes the folder as importWorkspaceFiles' targetDir, re-validated
          // main-side before any copy).
          item("Import files…", "import-files"),
          separator,
        ]
      : []),
    ...(canWrite ? [item("Rename", "rename"), item("Delete", "delete")] : []),
    scope.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
    separator,
    item("Export as zip…", "export-zip"),
    reveal,
  ];
}
