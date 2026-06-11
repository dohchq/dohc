import {
  classifyPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import type { ZipEntry } from "./zipWriter";

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
): Promise<{ files: WorkspaceFileEntry[]; folders: string[] }> {
  const entries: WorkspaceFileEntry[] = [];
  // Directories ride along so EMPTY folders stay visible in the explorer
  // tree (the walk already visits every dir — this is purely additive).
  const folders: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      // Never follow symlinks: a dir/file symlink could point outside the
      // workspace and leak names or recurse into foreign trees.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) {
          folders.push(rel);
          await walk(join(dir, dirent.name), rel);
        }
      } else if (dirent.isFile()) {
        entries.push({ path: rel, kind: classifyPath(rel).kind });
      }
    }
  }

  await walk(rootPath, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  folders.sort((a, b) => a.localeCompare(b));
  return { files: entries, folders };
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

// OS drag-in import. TRUST DELTA vs copyIntoWorkspace's dialog path: these
// absolute source paths are RENDERER-supplied (webUtils.getPathForFile in the
// preload), not minted by a main-process file dialog — a compromised renderer
// could name any readable file (e.g. ~/.ssh/id_rsa) and have it copied into a
// possibly cloud-synced workspace. Bound it: the payload caps the count (zod),
// only regular files import (no symlinks, no directories this phase), and a
// source inside ANY registered workspace's .dohc is refused — dohc metadata
// (credentials, history) must never be promoted into synced user content.
// Past those guards the copy itself is picker-grade: the same basename-only,
// COPYFILE_EXCL copyIntoWorkspace the import dialog uses.
export async function importDroppedPaths(
  rootPath: string,
  absolutePaths: string[],
  registeredRoots: string[],
): Promise<string[]> {
  const realRoots: string[] = [];
  for (const root of registeredRoots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // A registered-but-deleted workspace can't contain a source.
    }
  }
  const usable: string[] = [];
  for (const source of absolutePaths) {
    if (!isAbsolute(source)) continue;
    let real: string;
    try {
      real = await realpath(source);
      if (!(await lstat(real)).isFile()) continue;
    } catch {
      continue;
    }
    const insideMetadata = realRoots.some((root) =>
      isInside(join(root, ".dohc"), real),
    );
    if (insideMetadata) continue;
    usable.push(real);
  }
  return copyIntoWorkspace(rootPath, usable);
}

// Creates a folder (recursively) with the createFile containment sandwich:
// lexical validation first, then realpath containment of the deepest existing
// ancestor BEFORE mkdir, re-checked after.
export async function createFolder(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid folder path (${validated.reason}): ${relativePath}`);
  }
  const absolute = join(rootPath, validated.normalized);
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(absolute))) {
    throw new Error(`Invalid folder path (escapes workspace): ${relativePath}`);
  }
  await mkdir(absolute, { recursive: true });
  if (!isInside(realRoot, await realpath(absolute))) {
    throw new Error(`Invalid folder path (escapes workspace): ${relativePath}`);
  }
  return validated.normalized;
}

// ONE move engine for rename + drag-move (F2 and DnD both land here).
// Rules, in order:
//   1. BOTH sides pass validateUserWritePath — traversal/absolute/.dohc are
//      refused on either side (isReservedPath inside; never special-cased).
//   2. Folder into itself/descendant refused (mirrors planDrop's UI no-op).
//   3. Source: realpath-contain the PARENT, then refuse a symlink source —
//      the tree never lists symlinks, so no legitimate caller moves one.
//   4. Destination parent: existingAncestor containment BEFORE mkdir -p,
//      re-checked after (the createFile sandwich, verbatim).
//   5. Overwrite refused: an existing destination throws — EXCEPT when
//      realpath(dest) === realpath(source), the case-only rename on a
//      case-insensitive filesystem (on Linux this branch never triggers).
//      No merge semantics this phase: dir-onto-dir with the same name fails.
//   6. One fs.rename (atomic on the same device). POSIX rename silently
//      clobbers, so step 5 is the only overwrite guard; the check→rename
//      TOCTOU window is accepted — main is the single writer on this path
//      and the watcher records whatever actually happened.
export async function movePath(
  rootPath: string,
  fromPath: string,
  toPath: string,
): Promise<string> {
  const from = validateUserWritePath(fromPath);
  if (!from.ok) {
    throw new Error(`Invalid move source (${from.reason}): ${fromPath}`);
  }
  const to = validateUserWritePath(toPath);
  if (!to.ok) {
    throw new Error(`Invalid move destination (${to.reason}): ${toPath}`);
  }
  if (to.normalized === from.normalized || to.normalized.startsWith(`${from.normalized}/`)) {
    throw new Error(`Cannot move a path into itself: ${fromPath}`);
  }
  const realRoot = await realpath(rootPath);
  const absFrom = join(rootPath, from.normalized);
  const realFromParent = await realpath(dirname(absFrom));
  if (!isInside(realRoot, realFromParent)) {
    throw new Error(`Invalid move source (escapes workspace): ${fromPath}`);
  }
  const sourceStat = await lstat(absFrom);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to move a symlink: ${fromPath}`);
  }
  const absTo = join(rootPath, to.normalized);
  if (!isInside(realRoot, await existingAncestor(dirname(absTo)))) {
    throw new Error(`Invalid move destination (escapes workspace): ${toPath}`);
  }
  await mkdir(dirname(absTo), { recursive: true });
  if (!isInside(realRoot, await realpath(dirname(absTo)))) {
    throw new Error(`Invalid move destination (escapes workspace): ${toPath}`);
  }
  const destExists = await lstat(absTo).then(
    () => true,
    () => false,
  );
  if (destExists) {
    // Case-only rename carve-out: on a case-insensitive filesystem the
    // destination "exists" because it IS the source under another case.
    // Compare REAL paths (never strings) so a genuinely distinct file that
    // case-collides still refuses — the carve-out must not reopen the
    // overwrite hole.
    const [realFrom, realTo] = await Promise.all([
      realpath(absFrom),
      realpath(absTo),
    ]);
    if (realFrom !== realTo) {
      throw new Error(`Destination already exists: ${toPath}`);
    }
  }
  await rename(absFrom, absTo);
  return to.normalized;
}

// Deletes are always RECOVERABLE — never a hard delete:
//   1. shell.trashItem (injected): the OS trash on all three platforms
//      (Windows IFileOperation, macOS trashItemAtURL, Linux g_file_trash).
//   2. Fallback when the OS rejects (g_file_trash refuses cross-filesystem
//      paths without a .Trash topdir — e.g. /mnt/c under WSL): MOVE the
//      target into <root>/.dohc/trash/<epoch>-<leaf>. Same-filesystem by
//      construction (the trash dir lives inside the workspace), so the
//      rename succeeds exactly where trashItem failed. .dohc is invisible
//      to tree/watcher/sync (hasIgnoredSegment), so the entry disappears
//      like OS trash — and the RECOVERY STORY is opening
//      <workspace>/.dohc/trash in any file manager and moving it back.
// The metadata dir resolves through resolveWorkspaceMetadataDir (refuses a
// symlinked .dohc), and the trash SUBDIR is re-validated after mkdir the same
// way — a planted `.dohc/trash -> outside` symlink (the same malicious
// attached-workspace threat, one level deeper; mkdir{recursive} is a silent
// no-op on an existing symlink-to-dir) is refused before any rename.
export async function deletePath(
  rootPath: string,
  relativePath: string,
  trashItem: (absolutePath: string) => Promise<void>,
): Promise<{ trashed: boolean }> {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid delete path (${validated.reason}): ${relativePath}`);
  }
  const realRoot = await realpath(rootPath);
  // resolveWorkspaceFile idiom: realpath the full target, then contain — a
  // symlink that resolves outside the root is refused here.
  const realTarget = await realpath(join(rootPath, validated.normalized));
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`Delete path escapes workspace: ${relativePath}`);
  }
  if (realTarget === realRoot) {
    throw new Error("Refusing to delete the workspace root");
  }
  try {
    await trashItem(realTarget);
    return { trashed: true };
  } catch {
    const trashDir = join(await resolveWorkspaceMetadataDir(rootPath), "trash");
    await mkdir(trashDir, { recursive: true });
    // Validate AFTER mkdir, lstat-first (a pre-check is insufficient: mkdir
    // {recursive} silently no-ops on an existing symlink-to-dir, so only the
    // post-mkdir state proves where the rename would land).
    const trashStat = await lstat(trashDir);
    if (trashStat.isSymbolicLink() || !trashStat.isDirectory()) {
      throw new Error(".dohc/trash must be a real directory inside the workspace");
    }
    if (!isInside(realRoot, await realpath(trashDir))) {
      throw new Error(".dohc/trash resolves outside the workspace");
    }
    // Collision-resistant name: back-to-back deletes (multi-select) share a
    // Date.now() tick, and POSIX rename silently CLOBBERS an existing
    // destination — two same-basename deletes would destroy the first file's
    // bytes. The per-call UUID makes every trash entry unique.
    await rename(
      realTarget,
      join(trashDir, `${Date.now()}-${randomUUID()}-${basename(realTarget)}`),
    );
    return { trashed: false };
  }
}

// Export bounds: policy caps for what main will buffer into one in-memory
// archive (the container itself tops out at 65k entries / 4GB — zipWriter).
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

// Gathers the zip entries for a workspace export: the whole workspace, one
// folder, or one file. Ignored segments (.dohc, .git, node_modules) and
// symlinks never export — the same walk rules as listFiles. Bounded: more
// than MAX_ZIP_ENTRIES files or MAX_ZIP_TOTAL_BYTES refuses (loudly, before
// buffering everything) rather than producing a surprise multi-GB archive.
export async function collectZipEntries(
  rootPath: string,
  relativePath?: string,
): Promise<{ entries: ZipEntry[]; baseName: string }> {
  const realRoot = await realpath(rootPath);
  let startAbsolute = realRoot;
  let prefix = "";
  let baseName = basename(realRoot);
  if (relativePath !== undefined) {
    const validated = validateUserWritePath(relativePath);
    if (!validated.ok) {
      throw new Error(`Invalid export path (${validated.reason}): ${relativePath}`);
    }
    const realTarget = await realpath(join(rootPath, validated.normalized));
    if (!isInside(realRoot, realTarget)) {
      throw new Error(`Export path escapes workspace: ${relativePath}`);
    }
    startAbsolute = realTarget;
    // Entries keep the exported folder/file as their top-level name so the
    // extracted archive unpacks to "notes/…", not loose children.
    prefix = basename(validated.normalized);
    baseName = prefix.replace(/\.[^.]+$/, "") || prefix;
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;

  async function add(absolute: string, archivePath: string): Promise<void> {
    const stats = await stat(absolute);
    totalBytes += stats.size;
    if (entries.length >= MAX_ZIP_ENTRIES || totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(
        `Export too large (over ${MAX_ZIP_ENTRIES} files or 256MB) — export a smaller folder`,
      );
    }
    entries.push({
      path: archivePath,
      data: await readFile(absolute),
      modifiedAt: stats.mtime,
    });
  }

  async function walk(dir: string, archiveDir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const archivePath = archiveDir ? `${archiveDir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), archivePath);
      } else if (dirent.isFile()) {
        await add(join(dir, dirent.name), archivePath);
      }
    }
  }

  if ((await stat(startAbsolute)).isDirectory()) {
    await walk(startAbsolute, prefix);
  } else {
    await add(startAbsolute, prefix);
  }
  return { entries, baseName };
}
