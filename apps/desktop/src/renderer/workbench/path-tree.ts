// Path-tree model for the desktop explorer. The workspace is path-addressed
// with flat relative paths;
// the explorer reads as a real recursive tree — buildTree bridges the two.
// Slimmed: rows are the desktop's WorkspaceFileEntry shape ({path, kind}),
// folders are plain path strings (pins/cosmetics live in ui-state, not here),
// and the pre-pivot fields (_id/source/title/star/lock/icon) are gone.

import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";

export type FileRow = WorkspaceFileEntry;

// Explicit folder paths keep empty folders visible in the tree — exactly why
// listWorkspaceFiles returns a folders array beside files.
export type FolderInput = string;

export type TreeNode = {
  segment: string; // last path segment (e.g. "team" or "anna.md")
  fullPath: string; // unique key for state/expand maps
  file: FileRow | null; // the file that IS this node; null = folder
  children: TreeNode[];
};

type BuilderTreeNode = {
  segment: string;
  fullPath: string;
  file: FileRow | null;
  childrenBySegment: Map<string, BuilderTreeNode>;
};

// The last path segment — the name a tree row displays. Lives beside the tree
// model (rather than inline in the explorer) so row-render tests can spy it as
// their render-count probe (the chatFileMentions precedent).
export function leafOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

// Build a tree from files + explicit folder rows. Obsidian-style: folders are
// first-class containers (can sit empty), files are leaves at their full path.
export function buildTree(
  files: ReadonlyArray<FileRow>,
  folders: ReadonlyArray<FolderInput> = [],
): TreeNode {
  const root: BuilderTreeNode = {
    segment: "",
    fullPath: "",
    file: null,
    childrenBySegment: new Map(),
  };

  // Ensure every explicit folder has a node (even if empty).
  for (const folder of folders) ensurePathNode(root, folder);

  for (const file of files) {
    ensurePathNode(root, file.path).file = file;
  }
  return materializeTree(root);
}

function ensurePathNode(root: BuilderTreeNode, path: string): BuilderTreeNode {
  const segments = path.split("/");
  let cursor = root;
  let acc = "";
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    let child = cursor.childrenBySegment.get(seg);
    if (!child) {
      child = {
        segment: seg,
        fullPath: acc,
        file: null,
        childrenBySegment: new Map(),
      };
      cursor.childrenBySegment.set(seg, child);
    }
    cursor = child;
  }
  return cursor;
}

// Sort order: folders before leaves (Obsidian/VS Code convention), ties
// broken alphabetically (locale-aware). A folder is `file === null` — an
// empty listed folder still sorts as a folder, never as a leaf.
function materializeTree(node: BuilderTreeNode): TreeNode {
  const children = [...node.childrenBySegment.values()].map(materializeTree);
  children.sort((a, b) => {
    const aIsFolder = a.file === null;
    const bIsFolder = b.file === null;
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return a.segment.localeCompare(b.segment);
  });
  return {
    segment: node.segment,
    fullPath: node.fullPath,
    file: node.file,
    children,
  };
}
