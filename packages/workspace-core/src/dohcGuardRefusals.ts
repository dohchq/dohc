// The words every guard on a workspace's own .dohc paths refuses with.
//
// Three surfaces guard a workspace's internal paths: the desktop main
// process, the MCP server, and the engine client's session preparation. They
// answered in four different ways. Two returned a raw errno ("EEXIST: file
// already exists, mkdir …"); one wrote developer prose ("workspace trash
// directory is a symlink"); the engine client said "must not be a symlink"
// about a plain file and printed the absolute host path. None names the
// constraint and the way out, and the refusals that did
// name a constraint disagreed on whether the thing at the path is a "folder"
// or a "directory".
//
// The copy lives here once so it cannot drift: one noun, one shape, every
// surface.
//
// The shape, per the dohc-interface skill: what dohc could not do, what is at the
// path and what it must be, one instruction, then retry.

// What a guard learned from lstat. Structural, so node:fs Stats satisfies it
// and this module stays free of a filesystem import. lstat only: a symlink
// must read as a link, never as what it points at.
interface SquattedPathStats {
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
  path: ".dohc/local/trash",
  lead: "dohc could not move this to the workspace trash.",
};

export const DOHC_AGENT_RUNS_GUARD: DohcPathGuard = {
  path: ".dohc/agent-runs",
  lead: "dohc could not open this workspace's agent run history.",
};

export const DOHC_SYNC_HISTORY_GUARD: DohcPathGuard = {
  path: ".dohc/sync-history",
  lead: "dohc could not record this workspace's sync history.",
};

export const DOHC_COLLECTIONS_GUARD: DohcPathGuard = {
  path: ".dohc/collections.json",
  lead: "dohc could not read which computer keeps this workspace's Collections.",
};

export const DOHC_DATABASES_GUARD: DohcPathGuard = {
  path: ".dohc/databases",
  lead: "dohc could not save this database edit.",
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

// Something that is not a plain file sits at a path dohc writes as a file.
export function notAFileRefusal(
  guard: DohcPathGuard,
  stats: SquattedPathStats,
): string {
  const noun = squatterNoun(stats);
  const article = noun === "item" ? "An" : "A";
  return `${guard.lead} ${article} ${noun} is at ${guard.path}, which must be a file. Remove or rename that ${noun}. Then retry.`;
}

export function hardLinkedFileRefusal(guard: DohcPathGuard): string {
  return `${guard.lead} The file at ${guard.path} has another link, so changes here would change that file too. Remove or rename this file. Then retry.`;
}

export function fileChangedWhileOpeningRefusal(guard: DohcPathGuard): string {
  return `${guard.lead} The file at ${guard.path} changed while dohc opened it. Stop other programs from changing this file. Then retry.`;
}

export function folderChangedBeforeWritingRefusal(guard: DohcPathGuard): string {
  return `${guard.lead} The folder at ${guard.path} changed before dohc could save the edit. Stop other programs from changing this folder. Then retry.`;
}

// The path is a real folder, but another user owns it or can write in it, so
// they could replace what dohc keeps there. The folder can hold what only
// this computer has, such as the Collections or the workspace trash, so the
// way out keeps it.
export function notOnlyYoursRefusal(guard: DohcPathGuard): string {
  return `${guard.lead} Another user can change ${guard.path}. Make it a folder only you can change. Then retry.`;
}

// The path is a real folder, but it leads out of the workspace. With the root
// already resolved and the path proven a real directory, a bind mount is the
// only way left to reach this, and "remove or rename it" does not undo a
// mount. The instruction stands because it is the only move the user owns; a
// reader who mounted something there knows what they did.
export function outsideWorkspaceRefusal(guard: DohcPathGuard): string {
  return `${guard.lead} The ${guard.path} folder points outside this workspace, and it must stay inside. Remove or rename it. Then retry.`;
}
