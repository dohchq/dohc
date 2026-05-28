// Sidebar section partition. The file tree is split into three
// VSCode-explorer-style sections — Personal workspace, Context, and
// Shared with me — but this is a PURE PRESENTATION layer: nothing here
// moves a file or invents a folder. We partition the existing flat
// atom/folder lists by path; paths and wikilinks are untouched.
//
// "Context" surfaces the AI-OS "maps & manuals" — the reserved files
// the agent and the user navigate by. The membership rule is exact on
// purpose (see the guard tests in file-tree-sections.test.ts): a
// user-made `map.md`, `guides/foo.md`, `skills.md`, or `efforts/me.md`
// stays in Personal workspace; only the exact reserved root paths and
// the real `skills/` folder qualify.

import type { FileRow, FolderInput } from '@/lib/path-tree'

// The reserved root atoms. `_map.md` mirrors MAP_PATH in
// convex/inlineAtom.ts (the agent-regenerated, system-locked index);
// the literal is duplicated here the same way path-tree.ts does, to
// avoid pulling Convex server code into the client bundle.
export const CONTEXT_ROOT_PATHS = [
  '_map.md',
  'me.md',
  'company.md',
  'intent.md',
] as const

const CONTEXT_ROOT = new Set<string>(CONTEXT_ROOT_PATHS)

/** True when a path belongs to the Context section. */
export function isContextPath(path: string): boolean {
  return CONTEXT_ROOT.has(path) || path.startsWith('skills/')
}

/** True for the `skills/` folder itself or anything under it. */
function isSkillsFolder(path: string): boolean {
  return path === 'skills' || path.startsWith('skills/')
}

/** `FolderInput` is a union of a bare path string or a rich object. */
function folderPath(fo: FolderInput): string {
  return typeof fo === 'string' ? fo : fo.path
}

export type Partition = {
  /** Files for the main Personal-workspace tree. */
  personalFiles: FileRow[]
  /** Folders for the Personal-workspace tree (skills/ excluded). */
  personalFolders: FolderInput[]
  /** Reserved files surfaced in the Context section. */
  contextFiles: FileRow[]
}

/**
 * Partition the flat file + folder lists into the Personal-workspace
 * tree inputs and the Context list. Each file lands in exactly one
 * section, so a reserved file never double-appears under Personal.
 */
export function partitionTree(
  files: FileRow[],
  folders: FolderInput[],
): Partition {
  const personalFiles: FileRow[] = []
  const contextFiles: FileRow[] = []
  for (const f of files) {
    if (isContextPath(f.path)) contextFiles.push(f)
    else personalFiles.push(f)
  }
  const personalFolders = folders.filter(
    (fo) => !isSkillsFolder(folderPath(fo)),
  )
  return { personalFiles, personalFolders, contextFiles }
}
