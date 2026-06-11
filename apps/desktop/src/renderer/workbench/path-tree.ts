// Path-tree model for the desktop explorer. Copied + slimmed from the old
// web app's path-tree lib (apps/web/src/lib/path-tree.ts) — the desktop never
// imports across apps. The workspace is path-addressed (flat relative paths);
// the explorer reads as a real recursive tree — buildTree bridges the two.
// Slimmed: rows are the desktop's WorkspaceFileEntry shape ({path, kind}),
// folders are plain path strings (pins/cosmetics live in ui-state, not here),
// and the pre-pivot fields (_id/source/title/star/lock/icon) are gone.

import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";

export type FileRow = WorkspaceFileEntry;

// Explicit folder paths keep EMPTY folders visible in the tree — exactly why
// listWorkspaceFiles returns a folders array beside files.
export type FolderInput = string;

export type TreeNode = {
  segment: string; // last path segment (e.g. "team" or "anna.md")
  fullPath: string; // unique key for state/expand maps
  file: FileRow | null; // the file that IS this node; null = folder
  children: TreeNode[];
};

// Build a tree from files + explicit folder rows. Obsidian-style: folders are
// first-class containers (can sit empty), files are leaves at their full path.
export function buildTree(
  files: ReadonlyArray<FileRow>,
  folders: ReadonlyArray<FolderInput> = [],
): TreeNode {
  const root: TreeNode = { segment: "", fullPath: "", file: null, children: [] };

  // Ensure every explicit folder has a node (even if empty).
  for (const folder of folders) ensureFolderNode(root, folder);

  for (const file of files) {
    const segments = file.path.split("/");
    let cursor = root;
    let acc = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isLast = i === segments.length - 1;
      acc = acc ? `${acc}/${seg}` : seg;
      let child = cursor.children.find((c) => c.segment === seg);
      if (!child) {
        child = { segment: seg, fullPath: acc, file: null, children: [] };
        cursor.children.push(child);
      }
      if (isLast) child.file = file;
      else cursor = child;
    }
  }
  sortTree(root);
  return root;
}

function ensureFolderNode(root: TreeNode, folderPath: string): TreeNode {
  const segments = folderPath.split("/");
  let cursor = root;
  let acc = "";
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    let child = cursor.children.find((c) => c.segment === seg);
    if (!child) {
      child = { segment: seg, fullPath: acc, file: null, children: [] };
      cursor.children.push(child);
    }
    cursor = child;
  }
  return cursor;
}

// Sort order: folders before leaves (Obsidian/VS Code convention), ties
// broken alphabetically (locale-aware). A folder is `file === null` — an
// EMPTY listed folder still sorts as a folder, never as a leaf.
function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    const aIsFolder = a.file === null;
    const bIsFolder = b.file === null;
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return a.segment.localeCompare(b.segment);
  });
  node.children.forEach(sortTree);
}
