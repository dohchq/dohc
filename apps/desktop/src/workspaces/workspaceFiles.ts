import {
  classifyPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

// Deepest already-existing ancestor of a (possibly not-yet-created) path —
// the part realpath can resolve, so we can check containment BEFORE mkdir.
export async function existingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";

const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);

// True iff `child` is the same as or nested under `parent` (both real paths).
// On Windows, relative() across drives returns an absolute path (e.g.
// C:\ws -> D:\evil gives "D:\evil"), which is not a descendant.
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return (
    rel.length > 0 &&
    !isAbsolute(rel) &&
    !rel.startsWith("..") &&
    !rel.startsWith(`${sep}`)
  );
}

export async function listFiles(
  rootPath: string,
): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      // Never follow symlinks: a dir/file symlink could point outside the
      // workspace and leak names or recurse into foreign trees.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
      } else if (dirent.isFile()) {
        entries.push({ path: rel, kind: classifyPath(rel).kind });
      }
    }
  }

  await walk(rootPath, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export async function createFile(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
  }
  const absolute = join(rootPath, validated.normalized);
  // Lexical validation can't see symlinks: a workspace-internal symlinked
  // ancestor ("link/evil.md") could resolve outside the root. Check the real
  // deepest-existing ancestor BEFORE mkdir, so a symlinked ancestor can't even
  // cause directories to be created outside the workspace.
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(dirname(absolute)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  // Re-check after mkdir (the resolved parent now exists) as belt-and-braces;
  // wx + O_EXCL additionally prevents a final-segment symlink from escaping.
  if (!isInside(realRoot, await realpath(dirname(absolute)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return validated.normalized;
}

// Imports copy external files into the workspace root by basename; existing
// files are never overwritten (skipped, not errored — imports are additive).
export async function copyIntoWorkspace(
  rootPath: string,
  absolutePaths: string[],
): Promise<string[]> {
  const imported: string[] = [];
  for (const source of absolutePaths) {
    const name = basename(source);
    const validated = validateUserWritePath(name);
    if (!validated.ok) continue;
    try {
      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
      imported.push(validated.normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return imported;
}
