// The words every guard on a workspace's own .dohc paths refuses with.
//
// Three surfaces guard a workspace's internal paths: the desktop main
// process, the MCP server, and the engine client's session preparation. They
// answered in four different ways. Two returned a raw errno ("EEXIST: file
// already exists, mkdir …"); one wrote developer prose ("workspace trash
// directory is a symlink"); the engine client said "must not be a symlink"
// about a plain file and printed the absolute host path. None names the
// constraint and the way out (#544, #585, #612), and the refusals that did
// name a constraint disagreed on whether the thing at the path is a "folder"
// or a "directory" (#586).
//
// The copy lives here once so it cannot drift: one noun, one shape, every
// surface.
//
// The shape, per docs/brand/copy.md: what dohc could not do, what is at the
// path and what it must be, one instruction, then retry.

// What a guard learned from lstat. Structural, so node:fs Stats satisfies it
// and this module stays free of a filesystem import. lstat only: a symlink
// must read as a link, never as what it points at.
export interface SquattedPathStats {
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

export interface DohcPathGuard {
  // The path as the user sees it, relative to the workspace root.
  path: string;
  // What dohc could not do. Sentence one of every refusal.
  lead: string;
}

export const DOHC_METADATA_GUARD: DohcPathGuard = {
  path: ".dohc",
  lead: "dohc could not open this workspace's .dohc folder.",
};

export const DOHC_TRASH_GUARD: DohcPathGuard = {
  path: ".dohc/trash",
  lead: "dohc could not move this to the workspace trash.",
};

export const DOHC_ENGINE_GUARD: DohcPathGuard = {
  path: ".dohc/engine",
  lead: "dohc could not start the engine for this workspace.",
};

// Name the squatter by what the user can see at the path, so the instruction
// tells them what to look for. "item" covers the rest (a socket, a device
// node) and takes the other article.
function squatterNoun(stats: SquattedPathStats): string {
  if (stats.isSymbolicLink()) return "link";
  return stats.isFile() ? "file" : "item";
}

// Something that is not a real folder sits at a path dohc must own.
export function notARealFolderRefusal(
  guard: DohcPathGuard,
  stats: SquattedPathStats,
): string {
  const noun = squatterNoun(stats);
  const article = noun === "item" ? "An" : "A";
  return `${guard.lead} ${article} ${noun} is at ${guard.path}, which must be a real folder. Remove or rename that ${noun}. Then retry.`;
}

// The path is a real folder, but it leads out of the workspace. With the root
// already resolved and the path proven a real directory, a bind mount is the
// only way left to reach this, and "remove or rename it" does not undo a
// mount. The instruction stands because it is the only move the user owns; a
// reader who mounted something there knows what they did.
export function outsideWorkspaceRefusal(guard: DohcPathGuard): string {
  return `${guard.lead} The ${guard.path} folder points outside this workspace, and it must stay inside. Remove or rename it. Then retry.`;
}
