import {
  classifyPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";

const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);

export async function listFiles(
  rootPath: string,
): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
      } else {
        const classified = classifyPath(rel);
        entries.push({
          path: rel,
          kind: classified.kind === "database" ? "database"
            : classified.kind === "app-source" ? "app-source"
            : "file",
        });
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
  await mkdir(dirname(absolute), { recursive: true });
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
