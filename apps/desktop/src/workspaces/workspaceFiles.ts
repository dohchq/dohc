import {
  classifyPath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { classifyEngineFilePathForRead } from "@dohc/workspace-engine";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
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

// `shared-with-me` is intentionally visible: accepted shares materialize there
// for read/preview by local sites. Publishing or re-sharing those files remains
// gated by the explicit publish/share flow, not by local file preview.
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

// Truncate a (decorative) basename so `${prefix}${name}` fits NAME_MAX — the
// 255-BYTE per-component limit on ext4/APFS/NTFS. Byte-accurate, not char:
// a multibyte sequence split at the cut decodes to U+FFFD, which we trim so
// the trash entry never carries a dangling replacement char.
function fitWithinNameMax(name: string, prefix: string): string {
  const NAME_MAX = 255;
  const budget = NAME_MAX - Buffer.byteLength(prefix, "utf8");
  if (budget <= 0) return "";
  if (Buffer.byteLength(name, "utf8") <= budget) return name;
  return Buffer.from(name, "utf8")
    .subarray(0, budget)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
}

// Head bytes read to find a markdown page's `icon` frontmatter. The icon is a
// short scalar near the top (id, title, icon priority order), so a small
// bounded read covers it without ever loading a whole document.
const MARKDOWN_ICON_HEAD_BYTES = 1024;

// Minimal, dependency-free scan for `icon:` inside a leading `--- ... ---`
// frontmatter block. Intentionally NOT a full YAML parse: the buffer may be
// truncated mid-document, and we only want one short scalar. Exported for
// unit testing. Returns undefined when there is no leading frontmatter, the
// block closes before an icon, or the value is empty/comment-only.
export function extractFrontmatterIcon(head: string): string | undefined {
  const lines = head.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") return undefined; // block closed, no icon
    const match = /^icon:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[1] ?? "").trim();
    if (!value || value.startsWith("#")) return undefined;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing inline comment on an unquoted scalar.
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    return value.slice(0, 64) || undefined;
  }
  return undefined;
}

// Best-effort, failure-tolerant read of a markdown file's icon: this runs for
// every markdown file on every listing, so it must never throw or read the
// whole file.
async function readMarkdownIcon(absolutePath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolutePath, "r");
    const buffer = Buffer.alloc(MARKDOWN_ICON_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MARKDOWN_ICON_HEAD_BYTES, 0);
    return extractFrontmatterIcon(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Icon cache: readMarkdownIcon does an open+read+close per markdown file, and
// listFiles' walk awaits it serially for every .md/.markdown file it visits.
// Without a cache, a full re-listing (e.g. after every save, via the
// fs-watch -> refreshFiles path) re-pays that IO for the ENTIRE tree even
// when nothing changed. Keyed by absolute path + (mtimeMs, size) — a plain
// `stat` (one syscall) is enough to prove a file is unchanged and skip the
// far more expensive open/read/close. Bounded so a huge/rarely-restarted
// workspace can't grow this without limit; a simple insertion-order Map
// doubles as an LRU (delete+re-set moves an entry to the "most recent" end).
const MAX_ICON_CACHE_ENTRIES = 4000;
type IconCacheEntry = { mtimeMs: number; size: number; icon: string | undefined };
const iconCache = new Map<string, IconCacheEntry>();

function rememberIcon(absolutePath: string, entry: IconCacheEntry): void {
  iconCache.delete(absolutePath);
  iconCache.set(absolutePath, entry);
  if (iconCache.size > MAX_ICON_CACHE_ENTRIES) {
    const oldest = iconCache.keys().next().value;
    if (oldest !== undefined) iconCache.delete(oldest);
  }
}

// Cache-checked wrapper around readMarkdownIcon. Never throws — a stat
// failure (e.g. a TOCTOU delete mid-walk) is treated as "no icon", matching
// readMarkdownIcon's own failure-tolerant contract.
async function getCachedMarkdownIcon(absolutePath: string): Promise<string | undefined> {
  let mtimeMs: number;
  let size: number;
  try {
    const st = await stat(absolutePath);
    // Round to whole milliseconds: some filesystems (observed via WSL bind
    // mounts) return a `mtimeMs` that jitters by a fraction of a millisecond
    // between two stats of a file whose timestamp was never touched, which
    // would otherwise cause a spurious cache miss on every single listing.
    mtimeMs = Math.round(st.mtimeMs);
    size = st.size;
  } catch {
    return undefined;
  }
  const cached = iconCache.get(absolutePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    rememberIcon(absolutePath, cached); // refresh LRU recency
    return cached.icon;
  }
  const icon = await readMarkdownIcon(absolutePath);
  rememberIcon(absolutePath, { mtimeMs, size, icon });
  return icon;
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
        const kind = classifyPath(rel).kind;
        const entry: WorkspaceFileEntry = { path: rel, kind };
        if (kind === "file" && /\.(md|markdown)$/i.test(rel)) {
          const icon = await getCachedMarkdownIcon(join(dir, dirent.name));
          if (icon) entry.icon = icon;
        }
        entries.push(entry);
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

// Import outcome: what landed (workspace-relative paths, destination prefix
// included) plus how many sources could NOT land — callers surface both, so
// an import is never silently smaller than what the user handed us.
export interface ImportCopyOutcome {
  imported: string[];
  skipped: number;
}

// Resolve + validate an import destination folder ("" / undefined = workspace
// root). The folder must be a user-writable workspace-relative path (traversal
// and reserved names refused by validateUserWritePath), must already EXIST as
// a real directory — imports target folders the user can see, never mkdir —
// and must be symlink-free: the final component by lstat, any ancestor by the
// realpath containment check (a symlinked folder must not teleport an import
// outside the workspace).
export async function resolveImportDestination(
  rootPath: string,
  targetDir: string | undefined,
): Promise<{ absDir: string; relDir: string }> {
  const realRoot = await realpath(rootPath);
  if (targetDir === undefined || targetDir === "") {
    return { absDir: realRoot, relDir: "" };
  }
  const validated = validateUserWritePath(targetDir);
  if (!validated.ok) {
    throw new Error(`Invalid import destination (${validated.reason}): ${targetDir}`);
  }
  // EVERY component must be a real directory — lstat refuses a symlink at
  // any depth, not just the final one. An ancestor symlink that resolves
  // inside the workspace would otherwise smuggle the import into a tree the
  // lexical check never saw (e.g. link -> shared-with-me puts "link/alex"
  // imports into the reserved projection). Workspace-internal destinations
  // have no legitimate ancestor symlinks (unlike macOS system paths on the
  // drag-in SOURCE side), so strict refusal costs nothing (codex P2).
  let absDir = realRoot;
  for (const segment of validated.normalized.split("/")) {
    absDir = join(absDir, segment);
    const linkStat = await lstat(absDir).catch(() => null);
    if (!linkStat || linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
      throw new Error(`Import destination is not a workspace folder: ${validated.normalized}`);
    }
  }
  if (!isInside(realRoot, await realpath(absDir))) {
    throw new Error(`Import destination escapes the workspace: ${validated.normalized}`);
  }
  return { absDir, relDir: validated.normalized };
}

// Collision budget: past this many "name (N).ext" variants the source counts
// as skipped instead of probing forever.
const MAX_COLLISION_RENAMES = 99;

// "report.md" + attempt 2 -> "report (2).md". Dotfiles (".env") and
// extensionless names suffix at the end (".env (2)", "Makefile (2)").
// The stem is byte-truncated so the variant never exceeds NAME_MAX — a
// near-255-byte basename colliding must degrade to a shorter variant, not
// abort the whole import with ENAMETOOLONG (codex P2).
function collisionVariant(name: string, attempt: number): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const marker = ` (${attempt})`;
  return `${fitWithinNameMax(stem, marker + extension)}${marker}${extension}`;
}

// One copy that never overwrites: COPYFILE_EXCL on every attempt, retrying
// through collision variants. Returns the basename that landed, or null when
// the rename budget ran out. Non-EEXIST errors still throw — a permission or
// IO failure is a real error, not a skip — with one exception: a name the
// filesystem cannot hold (ENAMETOOLONG, e.g. an extension longer than the
// variant budget) skips that source instead of aborting the whole batch.
async function copyWithoutOverwrite(
  source: string,
  absDir: string,
  name: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_COLLISION_RENAMES + 1; attempt += 1) {
    const candidate = attempt === 1 ? name : collisionVariant(name, attempt);
    try {
      await copyFile(source, join(absDir, candidate), constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENAMETOOLONG") return null;
      if (code !== "EEXIST") throw error;
    }
  }
  return null;
}

// Imports copy external files by basename into a destination folder inside
// the workspace (default: the root). Existing files are never overwritten;
// a name collision retries as "name (2).ext" so imports are additive AND
// lossless — a source only counts as skipped when its basename is invalid or
// the collision budget runs out.
// TRUSTS ITS CALLER: copyFile FOLLOWS symlinks and this does no lstat. Its only
// trusted entrypoint is the main-process file-dialog import (paths the user
// picked in a native dialog). The UNtrusted entrypoint (renderer-supplied OS
// drag-in) is importDroppedPaths, which lstat-screens sources first — never
// wire renderer input straight into here.
export async function copyIntoWorkspace(
  rootPath: string,
  absolutePaths: string[],
  targetDir?: string,
): Promise<ImportCopyOutcome> {
  const { absDir, relDir } = await resolveImportDestination(rootPath, targetDir);
  const imported: string[] = [];
  let skipped = 0;
  for (const source of absolutePaths) {
    const name = basename(source);
    const validated = validateUserWritePath(name);
    if (!validated.ok) {
      skipped += 1;
      continue;
    }
    const landed = await copyWithoutOverwrite(source, absDir, validated.normalized);
    if (landed === null) {
      skipped += 1;
      continue;
    }
    imported.push(relDir === "" ? landed : `${relDir}/${landed}`);
  }
  return { imported, skipped };
}

// Defense in depth beyond the zod cap (bridgeContract): the handler refuses an
// over-long batch ITSELF, so a code path that ever reaches here without the
// schema (a future internal caller, a test) still cannot flood the import.
const MAX_IMPORT_PATHS = 100;

// OS drag-in import. TRUST DELTA vs copyIntoWorkspace's dialog path: these
// absolute source paths are RENDERER-supplied (webUtils.getPathForFile in the
// preload), not minted by a main-process file dialog — a compromised renderer
// could forge the IPC array and name any readable file (e.g. ~/.ssh/id_rsa) to
// have it copied into a possibly cloud-synced workspace. That residual is
// inherent once file-write IPCs exist at all (renderer-compromise is already
// game-over) and a GENUINE user drag may legitimately include any file the
// user owns, so we do NOT gate by location. We DO bound it:
//   - count is capped HERE (not just at the zod boundary);
//   - only REAL regular files import — a FINAL-component symlink is refused
//     before it is followed (lstat the original source, never realpath-then-
//     isFile, which would promote a planted symlink-to-secret under the link's
//     own innocuous name); directories and special files are skipped;
//   - a source whose CANONICAL path is inside ANY registered workspace's .dohc
//     is refused (the check runs on realpath(source), so an ancestor symlink
//     cannot smuggle a metadata source past it).
// EXPLICIT RESIDUAL (adversarial review, e3fix): a real regular file reached
// through a symlinked ANCESTOR (e.g. drop `/stage/link/id_rsa` where
// `link -> ~/.ssh`) still imports — lstat refuses only the final component, and
// realpath then canonicalizes to the secret. This grants a compromised renderer
// NOTHING beyond the residual above (it could just name `~/.ssh/id_rsa`
// directly), and the only general guard — refusing every symlinked ancestor —
// would false-reject legitimate drags through SYSTEM symlinks (macOS
// /tmp -> /private/tmp, /var -> /private/var), i.e. silent import loss for zero
// security gain. The real defense if this matters is a visible import-confirm
// quarantine (deferred — needs product sign-off); until then it is accepted and
// named here. Past these guards the copy is picker-grade: the same basename-
// only, COPYFILE_EXCL copyIntoWorkspace the import dialog uses.
export async function importDroppedPaths(
  rootPath: string,
  absolutePaths: string[],
  registeredRoots: string[],
  targetDir?: string,
): Promise<ImportCopyOutcome> {
  if (absolutePaths.length > MAX_IMPORT_PATHS) {
    throw new Error(`Too many files dropped at once (max ${MAX_IMPORT_PATHS})`);
  }
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
      // lstat the ORIGINAL source (NOT realpath(source)): lstat does not follow
      // the FINAL component, so a dropped symlink is observed AS a symlink and
      // refused — never realpath-then-isFile, which would promote a planted
      // symlink-to-secret. Only a real, regular file imports — directories,
      // sockets, devices, FIFOs, and final-component symlinks all fall through.
      // (Ancestor symlinks are the named residual above; realpath below
      // canonicalizes for the .dohc-containment gate, which therefore holds
      // even when an ancestor link was traversed.)
      const linkStat = await lstat(source);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) continue;
      real = await realpath(source);
    } catch {
      continue;
    }
    const insideMetadata = realRoots.some((root) =>
      isInside(join(root, ".dohc"), real),
    );
    if (insideMetadata) continue;
    usable.push(real);
  }
  // Sources the screen refused (symlinks, directories, special files, .dohc
  // metadata) are reported as skipped — the user dropped them and deserves to
  // see they did not land, same as a collision-budget skip inside the copy.
  const outcome = await copyIntoWorkspace(rootPath, usable, targetDir);
  return {
    imported: outcome.imported,
    skipped: outcome.skipped + (absolutePaths.length - usable.length),
  };
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
//   1. BOTH sides pass validateUserWritePath — traversal, absolute paths, and
//      reserved/ignored internals are refused on either side.
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
  // Canonical source — used both for the descendant guard below and the
  // case-only-rename carve-out. The symlink refusal above means realpath here
  // resolves only ancestor links, never the source itself.
  const realFrom = await realpath(absFrom);
  const absTo = join(rootPath, to.normalized);
  if (!isInside(realRoot, await existingAncestor(dirname(absTo)))) {
    throw new Error(`Invalid move destination (escapes workspace): ${toPath}`);
  }
  await mkdir(dirname(absTo), { recursive: true });
  const realDestParent = await realpath(dirname(absTo));
  if (!isInside(realRoot, realDestParent)) {
    throw new Error(`Invalid move destination (escapes workspace): ${toPath}`);
  }
  // Descendant guard, case-fold safe. The lexical self/descendant refusal at
  // the top is case-SENSITIVE, so on a case-insensitive filesystem "Foo" ->
  // "foo/bar" slips past it and would move a folder into its own (same-inode)
  // subtree — corrupting it. Compare REAL paths: if the destination's parent
  // resolves to the source itself or anywhere beneath it, refuse. (For a file
  // source this is always false — a file has no descendants.)
  if (isInside(realFrom, realDestParent)) {
    throw new Error(`Cannot move a path into itself: ${fromPath}`);
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
    if (realFrom !== (await realpath(absTo))) {
      throw new Error(`Destination already exists: ${toPath}`);
    }
  }
  // One fs.rename (atomic on the same device). The dest-exists check above and
  // this rename have a TOCTOU window (a colluding LOCAL process could create
  // the destination in between, and POSIX rename clobbers); accepted because
  // main is the single writer on this path and Node exposes no renameat2
  // RENAME_NOREPLACE. The watcher records whatever actually landed.
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
  const absTarget = join(rootPath, validated.normalized);
  // lstat does NOT follow the final component: decide on the LINK, not what it
  // points at. Deleting a symlink must trash the LINK itself — realpath-ing it
  // would resolve to (and trash) its target, which could be a real file
  // anywhere on disk. A regular file/dir still goes through the realpath-then-
  // contain idiom; a symlinked ANCESTOR escape is caught either way (lstat
  // follows ancestor links, so realpath(absTarget) on a non-symlink leaf still
  // resolves an escaping ancestor and fails containment).
  const linkStat = await lstat(absTarget);
  let target: string;
  if (linkStat.isSymbolicLink()) {
    const realParent = await realpath(dirname(absTarget));
    if (!isInside(realRoot, realParent)) {
      throw new Error(`Delete path escapes workspace: ${relativePath}`);
    }
    target = join(realParent, basename(absTarget));
  } else {
    target = await realpath(absTarget);
    if (!isInside(realRoot, target)) {
      throw new Error(`Delete path escapes workspace: ${relativePath}`);
    }
    if (target === realRoot) {
      throw new Error("Refusing to delete the workspace root");
    }
  }
  try {
    await trashItem(target);
    return { trashed: true };
  } catch {
    const trashDir = join(await resolveWorkspaceMetadataDir(rootPath), "trash");
    await mkdir(trashDir, { recursive: true });
    // Validate AFTER mkdir, lstat-first (a pre-check is insufficient: mkdir
    // {recursive} silently no-ops on an existing symlink-to-dir, so only the
    // post-mkdir state proves where the rename would land). The check sits
    // immediately before the rename to keep the swap window minimal; a
    // colluding local process racing a symlink into .dohc between this check
    // and the rename is the accepted residual (Node has no renameat dirfd).
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
    // bytes. The per-call UUID makes every trash entry unique. The basename is
    // decorative, so truncate it to fit NAME_MAX (255 bytes on ext4/APFS/NTFS):
    // a long source name + the 50-odd-byte unique prefix must not ENAMETOOLONG.
    const prefix = `${Date.now()}-${randomUUID()}-`;
    await rename(target, join(trashDir, `${prefix}${fitWithinNameMax(basename(target), prefix)}`));
    return { trashed: false };
  }
}

// Export bounds: policy caps for what main will buffer into one in-memory
// archive (the container itself tops out at 65k entries / 4GB — zipWriter).
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

// Gathers the zip entries for a workspace export: the whole workspace, one
// folder, or one file. Ignored segments (.dohc, .git, node_modules) and
// symlinks never export — the same walk rules as listFiles — and
// secret-classified files (the .env family) never leave in an archive: the
// walk skips them, and an explicitly targeted secret refuses loudly (zips
// get shared onward; the effective-policy posture is that secrets stay out
// of everything that leaves the workspace). Bounded: more than
// MAX_ZIP_ENTRIES files or MAX_ZIP_TOTAL_BYTES refuses (loudly, before
// buffering everything) rather than producing a surprise multi-GB archive.
export async function collectZipEntries(
  rootPath: string,
  relativePath?: string,
): Promise<{ entries: ZipEntry[]; baseName: string }> {
  const realRoot = await realpath(rootPath);
  let startAbsolute = realRoot;
  let prefix = "";
  let prefixRel = "";
  let baseName = basename(realRoot);
  if (relativePath !== undefined) {
    // Read-side validation: export is a read, so mounted shares
    // (shared-with-me/…) export like the ordinary files they appear to be.
    const validated = validateUserReadPath(relativePath);
    if (!validated.ok) {
      throw new Error(`Invalid export path (${validated.reason}): ${relativePath}`);
    }
    if (classifyEngineFilePathForRead(validated.normalized).kind === "secret") {
      throw new Error(
        `Secret files never leave the workspace in an export: ${validated.normalized}`,
      );
    }
    const realTarget = await realpath(join(rootPath, validated.normalized));
    if (!isInside(realRoot, realTarget)) {
      throw new Error(`Export path escapes workspace: ${relativePath}`);
    }
    startAbsolute = realTarget;
    // Entries keep the exported folder/file as their top-level name so the
    // extracted archive unpacks to "notes/…", not loose children.
    prefix = basename(validated.normalized);
    prefixRel = validated.normalized;
    baseName = prefix.replace(/\.[^.]+$/, "") || prefix;
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;

  async function add(absolute: string, archivePath: string): Promise<void> {
    // Open no-follow, then fstat + bounded read from the SAME descriptor. The
    // walk skips symlink dirents, but a file that was regular at readdir() time
    // could be swapped for a symlink before we read it (TOCTOU) — O_NOFOLLOW
    // makes open fail (ELOOP) on a final-component symlink, closing that
    // window. Size comes from fstat on the open fd (not a prior stat that a
    // concurrent grow could outrun), and the read is bounded to that size, so a
    // file that grows after the cap check cannot blow the in-memory budget.
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        throw new Error(`Refusing to export a non-regular file: ${archivePath}`);
      }
      totalBytes += st.size;
      if (entries.length >= MAX_ZIP_ENTRIES || totalBytes > MAX_ZIP_TOTAL_BYTES) {
        throw new Error(
          `Export too large (over ${MAX_ZIP_ENTRIES} files or 256MB) — export a smaller folder`,
        );
      }
      const data = Buffer.alloc(st.size);
      let read = 0;
      while (read < data.length) {
        const { bytesRead } = await handle.read(data, read, data.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      entries.push({
        path: archivePath,
        data: read === data.length ? data : data.subarray(0, read),
        modifiedAt: st.mtime,
      });
    } finally {
      await handle.close();
    }
  }

  // relDir is the WORKSPACE-relative directory (for secret classification);
  // archiveDir is the path inside the archive (rooted at the export target).
  async function walk(dir: string, relDir: string, archiveDir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const archivePath = archiveDir ? `${archiveDir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) {
          await walk(join(dir, dirent.name), relPath, archivePath);
        }
      } else if (dirent.isFile()) {
        // Secret-classified files (.env family) stay out of archives —
        // including inside mounted shares (read-aware classification).
        if (classifyEngineFilePathForRead(relPath).kind === "secret") continue;
        await add(join(dir, dirent.name), archivePath);
      }
    }
  }

  const startRel = relativePath === undefined ? "" : prefixRel;
  if ((await stat(startAbsolute)).isDirectory()) {
    await walk(startAbsolute, startRel, prefix);
  } else {
    await add(startAbsolute, prefix);
  }
  return { entries, baseName };
}
