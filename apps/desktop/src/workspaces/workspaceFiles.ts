import {
  classifyPath,
  DOHC_TRASH_GUARD,
  collisionVariantPlan,
  notARealFolderRefusal,
  outsideWorkspaceRefusal,
  nameUnitFor,
  sameFsEntry,
  entryCharBudget,
  trashEntryPlan,
  WINDOWS_MAX_PATH_CHARS,
  validateUserMaterializePath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
// The engine path floor is a CROSS-PROCESS security contract, not engine
// state: it has a deliberate Rust twin at crates/dohc-engine-files/src/policy.rs
// so a relay and a desktop cannot disagree about which paths hold secrets.
// It is imported directly rather than routed through the daemon because it is
// a pure string decision on fail-closed paths, called up to ~2,000 times per
// interaction here -- an RPC would add a failure mode where today there is none.
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
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
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isInside } from "../security/pathContainment";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import {
  utf8ByteLength,
  WORKSPACE_TEXT_EDITOR_MAX_BYTES,
  workspaceTextLimitReason,
} from "./workspaceTextLimits";
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
  initialText: string,
): Promise<string> {
  const validated = validateUserMaterializePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
  }
  const observedBytes = utf8ByteLength(initialText);
  if (observedBytes > WORKSPACE_TEXT_EDITOR_MAX_BYTES) {
    throw new Error(workspaceTextLimitReason(observedBytes));
  }
  const absolute = join(rootPath, validated.normalized);
  // Lexical validation can't see symlinks, and it read the path as SPELLED.
  // Both questions get asked of the real path BEFORE mkdir, so a symlinked
  // ancestor can neither have directories created through it nor name a
  // reserved area under an ordinary name.
  const { resolvedAbsolute: target } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: absolute,
    spelled: relativePath,
    label: "File path",
    access: "write",
  });
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(dirname(target)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await mkdir(dirname(target), { recursive: true });
  // Re-check after mkdir (the resolved parent now exists) as belt-and-braces;
  // wx + O_EXCL additionally prevents a final-segment symlink from escaping.
  if (!isInside(realRoot, await realpath(dirname(target)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await writeFile(target, initialText, { flag: "wx" }).catch((error: unknown) => {
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
  const validated = validateUserMaterializePath(targetDir);
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

// "report.md" + attempt 2 -> "report (2).md", longest first. The naming rule
// is shared with the trash, because it is the same rule: fit the component in
// the platform's unit, and keep a shorter candidate for the composed-path
// limit where one applies. Without that second rung a colliding multibyte name
// in a deep folder composes past MAX_PATH and copyFile answers ENOENT, which
// aborts the whole import.
function collisionVariants(
  name: string,
  attempt: number,
  maxEntryChars: number,
): string[] {
  return collisionVariantPlan(name, attempt, {
    unit: nameUnitFor(process.platform),
    maxEntryChars,
  });
}

/**
 * The same naming rule, for a caller that has to ASK whether a name is taken
 * rather than have `copyFile` refuse it.
 *
 * A share view's import writes its engine store, so it cannot discover a
 * collision through COPYFILE_EXCL. It asks `taken` instead, and gets the
 * ladder the disk copy walks: the name itself, then `name (2).ext`, and
 * shorter spellings only where a composed-path limit applies. Returns null
 * when the collision budget runs out — the same answer that counts a source
 * as skipped in `copyWithoutOverwrite`.
 *
 * `taken` is asynchronous because the honest answer comes from the
 * filesystem: where the filesystem folds case, `Note.md` and `note.md` are one
 * file, and only the filesystem knows that.
 */
export async function importNameFor(
  name: string,
  absDir: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  const maxEntryChars = entryCharBudget(absDir, process.platform);
  for (let attempt = 1; attempt <= MAX_COLLISION_RENAMES + 1; attempt += 1) {
    const candidates =
      attempt === 1 ? [name] : collisionVariants(name, attempt, maxEntryChars);
    for (const candidate of candidates) {
      if (!(await taken(candidate))) return candidate;
    }
  }
  return null;
}

/**
 * COULD this copy failure be about the name being too long? Exported for unit
 * testing, as `extractFrontmatterIcon` above is: neither an ENOENT from a
 * vanished source nor a real MAX_PATH refusal is arrangeable on demand in that
 * suite, and getting the two confused is the whole point.
 *
 * `maxEntryChars` must be the SAME budget that shaped the candidate list. An
 * earlier revision compared the composed path against `WINDOWS_MAX_PATH_CHARS`
 * directly, with no platform check anywhere in the copy loop -- so on macOS and
 * Linux, where a 259-character path is ordinary, a genuinely missing source
 * read as a length refusal, walked the shorter rungs, and was counted as
 * SKIPPED instead of aborting the batch. Two copies of one fact, disagreeing.
 *
 * "Could" is as far as arithmetic gets for ENOENT, so the copy loop asks the
 * filesystem first and only reaches here when both ends are there. See
 * `classifyCopyEnoent`.
 */
export function couldBeLengthRefusal(
  code: string | undefined,
  candidate: string,
  maxEntryChars: number,
): boolean {
  // Says so outright, on every platform.
  if (code === "ENAMETOOLONG") return true;
  // Windows reports an over-long path as ENOENT. So does a missing source,
  // everywhere -- so ENOENT can only be about length where a composed-path
  // limit actually applies AND this name exceeds it. Off Windows the budget is
  // Infinity and this is never true.
  return code === "ENOENT" && candidate.length > maxEntryChars;
}

// The arithmetic above says an over-budget name COULD be refused for length.
// It cannot say it WAS. On a long-path-aware Windows host the budget is not
// the real limit -- a 300-character path works there -- so an ENOENT means
// something that should exist does not: the source moved after the file dialog
// validated it, or the destination folder went away. Predicting from the
// budget silently counted that as `skipped`, and a user does not notice a
// skipped line.
//
// So ask, exactly as `copyFile` asks: `stat`, which FOLLOWS the source link,
// because that is what the copy did. An earlier revision asked `lstat`, which
// answers about the LINK -- so a source that was a symlink to a missing target
// read as "still there", its ENOENT was charged to length, and the broken link
// was skipped.
//
// `null` means both ends are there, so the ENOENT is about the composed path
// and the ladder may try a shorter name. "danglingLink" is the one thing dohc
// can say better than the copy's own error. "unexplained" is every other
// answer -- a source that is plainly gone, a destination folder that went away,
// a probe that could not look -- where the original ENOENT already names a
// path and dohc has nothing to add, so the batch aborts on that error.
type CopyEnoent = "danglingLink" | "unexplained";

/**
 * What one probe established about one end. Exported for unit testing, as
 * `classifyLadderProbe` below is: an EACCES or EIO on the probe is not
 * arrangeable in that suite, and it is the case that carries the defect.
 *
 * "unknown" is not "absent". Only ENOENT and ENOTDIR say a path is not there.
 * EACCES, EIO and the rest say dohc could not look -- and "the file it points
 * to is missing", written on that evidence, names a file that is fine.
 */
export function classifyEndProbe(
  probe: { looked: true } | { looked: false; code: string | undefined },
): "there" | "absent" | "unknown" {
  if (probe.looked) return "there";
  return probe.code === "ENOENT" || probe.code === "ENOTDIR"
    ? "absent"
    : "unknown";
}

async function probeEnd(path: string) {
  return classifyEndProbe(
    await stat(path).then(
      () => ({ looked: true as const }),
      (error: unknown) => ({
        looked: false as const,
        code: (error as NodeJS.ErrnoException).code,
      }),
    ),
  );
}

async function classifyCopyEnoent(
  source: string,
  absDir: string,
): Promise<CopyEnoent | null> {
  const [sourceProbe, dirProbe] = await Promise.all([
    probeEnd(source),
    probeEnd(absDir),
  ]);
  if (dirProbe !== "there") return "unexplained";
  if (sourceProbe === "there") return null;
  if (sourceProbe === "unknown") return "unexplained";
  // Say WHICH nothing the source resolved to. A dangling link is still at the
  // path the user picked, so "no such file" alone sends them to look at
  // something they can plainly see.
  const link = await lstat(source).then(
    (entry) => entry.isSymbolicLink(),
    () => false,
  );
  if (!link) return "unexplained";
  // The link this lstat saw need not be the one the probe missed -- something
  // can put a working link back at that path in between. So ask again, and
  // claim a missing target only while there still is one.
  const target = await probeEnd(source);
  if (target === "there") return null;
  return target === "absent" ? "danglingLink" : "unexplained";
}

// What the user gets to read when their pick was a link to nothing. A bare
// ENOENT would name a path that is still right there, so it says which part is
// missing and gives the two steps in the order they work: the target has to
// come back before the user can import it.
//
// The name goes LAST and once. This renders in a single-line truncate span
// (DesktopWorkspaceShell), and a basename can be 255 characters -- leading with
// it pushed both the reason and the instruction off the end of the line.
function danglingLinkRefusal(source: string): string {
  return `dohc did not import a symbolic link. The file it points to is missing. Restore that file. Then import it instead. The link is ${basename(source)}.`;
}

// Why a trash ladder stopped before its next rung. Three outcomes, not two:
// "dohc could not check" is a different fact from "something changed it", and
// reporting the second when only the first was established is the same defect
// this file's delete path was fixed for -- a confident claim on no evidence.
type LadderStop = "gone" | "replaced" | "unchecked";

/**
 * The decision, separated from the I/O. Exported for unit testing, as
 * extractFrontmatterIcon above is: an EACCES on the second look is not
 * arrangeable in this suite, and it is the case that carries the defect.
 *
 * `null` means "same entry, carry on".
 */
export function classifyLadderProbe(
  started: { ino: number; dev: number } | null,
  probe:
    | { looked: true; now: { ino: number; dev: number } }
    | { looked: false; code: string | undefined },
): LadderStop | null {
  // No starting identity means there is nothing to compare against, so the
  // question cannot be answered rather than answered "changed".
  if (!started) return "unchecked";
  // Only ENOENT means absence. EACCES, EIO and the rest establish nothing
  // about the path -- they establish that dohc could not look.
  if (!probe.looked) return probe.code === "ENOENT" ? "gone" : "unchecked";
  const identity = sameFsEntry(started, probe.now);
  if (identity === "same") return null;
  return identity === "replaced" ? "replaced" : "unchecked";
}

async function ladderStop(
  target: string,
  started: Stats | null,
): Promise<LadderStop | null> {
  const probe = await lstat(target).then(
    (now) => ({ looked: true as const, now }),
    (error: unknown) => ({
      looked: false as const,
      code: (error as NodeJS.ErrnoException).code,
    }),
  );
  return classifyLadderProbe(started, probe);
}

function ladderStopReason(name: string, stop: LadderStop): string {
  switch (stop) {
    case "gone":
      return `dohc did not move ${name} to the trash. ${name} is no longer at that path: something else moved or deleted it.`;
    case "replaced":
      return `dohc did not move ${name} to the trash. A different entry is at that path now: something replaced it while dohc worked.`;
    case "unchecked":
      return `dohc did not move ${name} to the trash. dohc could not check that path, so it stopped rather than move something it could not identify.`;
  }
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
  // ONE budget, used both to shape the candidates and to classify a failure.
  // Two copies of this fact can disagree, and did.
  const maxEntryChars = entryCharBudget(absDir, process.platform);
  for (let attempt = 1; attempt <= MAX_COLLISION_RENAMES + 1; attempt += 1) {
    // Longest first, exactly as the trash ladder does: a shorter name is used
    // only once the platform has actually refused the longer one for length.
    const candidates =
      attempt === 1 ? [name] : collisionVariants(name, attempt, maxEntryChars);
    for (const [rung, candidate] of candidates.entries()) {
      try {
        await copyFile(source, join(absDir, candidate), constants.COPYFILE_EXCL);
        return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // EEXIST is the collision itself: take the next attempt NUMBER, not a
        // shorter spelling of this one.
        if (code === "EEXIST") break;
        // ENOENT is the one code that also means something vanished, so ask
        // before any arithmetic reads it as length. A missing source or
        // destination folder is a real failure and must surface, not be
        // shortened into a skip.
        if (code === "ENOENT") {
          const enoent = await classifyCopyEnoent(source, absDir);
          if (enoent === "danglingLink") {
            throw new Error(danglingLinkRefusal(source), { cause: error });
          }
          if (enoent) throw error;
        }
        if (!couldBeLengthRefusal(code, candidate, maxEntryChars)) throw error;
        // No shorter rung left: a name this filesystem cannot hold skips the
        // source instead of aborting the batch.
        if (rung === candidates.length - 1) return null;
      }
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
    const validated = validateUserMaterializePath(name);
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

// OS drag-in import: the screen below, then the picker-grade copy — the
// same basename-only, COPYFILE_EXCL `copyIntoWorkspace` the import dialog
// uses. A share view runs the same screen and writes its engine store
// instead (`workspaceFileOps.ts`).
export async function importDroppedPaths(
  rootPath: string,
  absolutePaths: string[],
  registeredRoots: string[],
  targetDir?: string,
): Promise<ImportCopyOutcome> {
  const screened = await screenDroppedPaths(absolutePaths, registeredRoots);
  const outcome = await copyIntoWorkspace(rootPath, screened.usable, targetDir);
  return {
    imported: outcome.imported,
    skipped: outcome.skipped + screened.refused,
  };
}

// The drag-in screen, exported because a share view's import needs the same
// one before it writes its engine store — the destination differs, the trust
// question does not. `refused` counts the sources it dropped: the user handed
// them over and deserves to see they did not land, same as a collision-budget
// skip inside the copy.
//
// TRUST DELTA vs copyIntoWorkspace's dialog path: these
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
// named here.
export async function screenDroppedPaths(
  absolutePaths: string[],
  registeredRoots: string[],
): Promise<{ usable: string[]; refused: number }> {
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
  return { usable, refused: absolutePaths.length - usable.length };
}

// Creates a folder (recursively) with the createFile containment sandwich:
// lexical validation first, then realpath containment of the deepest existing
// ancestor BEFORE mkdir, re-checked after.
export async function createFolder(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const validated = validateUserMaterializePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid folder path (${validated.reason}): ${relativePath}`);
  }
  const absolute = join(rootPath, validated.normalized);
  const { resolvedAbsolute: target } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: absolute,
    spelled: relativePath,
    label: "Folder path",
    access: "write",
  });
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(target))) {
    throw new Error(`Invalid folder path (escapes workspace): ${relativePath}`);
  }
  await mkdir(target, { recursive: true });
  if (!isInside(realRoot, await realpath(target))) {
    throw new Error(`Invalid folder path (escapes workspace): ${relativePath}`);
  }
  return validated.normalized;
}

// ONE move engine for rename + drag-move (F2 and DnD both land here).
// Rules, in order:
//   1. Source passes Check A (reserved/traversal) — it already exists, so a
//      host-unsafe-but-real name must still be movable; destination passes the
//      full materialize check (we WRITE the new name on this disk).
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
  const fromValidated = validateUserWritePath(fromPath);
  if (!fromValidated.ok) {
    throw new Error(`Invalid move source (${fromValidated.reason}): ${fromPath}`);
  }
  const toValidated = validateUserMaterializePath(toPath);
  if (!toValidated.ok) {
    throw new Error(`Invalid move destination (${toValidated.reason}): ${toPath}`);
  }
  if (
    toValidated.normalized === fromValidated.normalized ||
    toValidated.normalized.startsWith(`${fromValidated.normalized}/`)
  ) {
    throw new Error(`Cannot move a path into itself: ${fromPath}`);
  }
  const realRoot = await realpath(rootPath);
  const absFrom = join(rootPath, fromValidated.normalized);
  const absTo = join(rootPath, toValidated.normalized);
  // A move leaks BOTH ways through an alias: `meta/manifest.json -> leak.json`
  // (meta -> .dohc) lifts workspace state into the visible tree, and
  // `notes.md -> meta/notes.md` buries a user file in it.
  //
  // BOTH ends are entries, because rename touches neither leaf: it moves the
  // source entry, link and all, and it replaces whatever entry sits at the
  // destination. Entry mode resolves each parent chain in full -- so an alias
  // into a reserved area still refuses -- and holds the final name as SPELLED,
  // which a rename needs: resolving the destination would answer with the
  // existing file's casing on a case-insensitive filesystem and turn a
  // case-only rename into a no-op.
  //
  // Every check and the rename itself then run on those two resolutions.
  const { resolvedAbsolute: from } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: absFrom,
    spelled: fromPath,
    label: "Move source",
    access: "entry",
  });
  const { resolvedAbsolute: to } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: absTo,
    spelled: toPath,
    label: "Move destination",
    access: "entry",
  });
  const realFromParent = await realpath(dirname(from));
  if (!isInside(realRoot, realFromParent)) {
    throw new Error(`Invalid move source (escapes workspace): ${fromPath}`);
  }
  const sourceStat = await lstat(from);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to move a symlink: ${fromPath}`);
  }
  // Canonical source — used both for the descendant guard below and the
  // case-only-rename carve-out. The symlink refusal above means realpath here
  // resolves only ancestor links, never the source itself.
  const realFrom = await realpath(from);
  if (!isInside(realRoot, await existingAncestor(dirname(to)))) {
    throw new Error(`Invalid move destination (escapes workspace): ${toPath}`);
  }
  await mkdir(dirname(to), { recursive: true });
  const realDestParent = await realpath(dirname(to));
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
  const destExists = await lstat(to).then(
    () => true,
    () => false,
  );
  if (destExists) {
    // Case-only rename carve-out: on a case-insensitive filesystem the
    // destination "exists" because it IS the source under another case.
    // Compare REAL paths (never strings) so a genuinely distinct file that
    // case-collides still refuses — the carve-out must not reopen the
    // overwrite hole.
    if (realFrom !== (await realpath(to))) {
      throw new Error(`Destination already exists: ${toPath}`);
    }
  }
  // One fs.rename (atomic on the same device). The dest-exists check above and
  // this rename have a TOCTOU window (a colluding LOCAL process could create
  // the destination in between, and POSIX rename clobbers); accepted because
  // main is the single writer on this path and Node exposes no renameat2
  // RENAME_NOREPLACE. The watcher records whatever actually landed.
  await rename(from, to);
  return toValidated.normalized;
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
  // Resolved as an ENTRY: trashing a link removes the link, so where it points
  // is not the question. Its parent chain still decides the reserved rule, so
  // `meta/settings.json` (meta -> .dohc) cannot delete workspace state.
  //
  // Its resolution is what gets inspected and trashed. In entry mode that is
  // the resolved parent plus the held-back name -- exactly the entry a delete
  // removes -- so the symlink branch below no longer has to rebuild it.
  const { resolvedAbsolute: resolvedTarget } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: absTarget,
    spelled: relativePath,
    label: "Delete path",
    access: "entry",
  });
  // lstat does NOT follow the final component: decide on the LINK, not what it
  // points at. Deleting a symlink must trash the LINK itself — realpath-ing it
  // would resolve to (and trash) its target, which could be a real file
  // anywhere on disk. A regular file/dir still goes through the realpath-then-
  // contain idiom; a symlinked ANCESTOR escape is caught either way (lstat
  // follows ancestor links, so realpath(absTarget) on a non-symlink leaf still
  // resolves an escaping ancestor and fails containment).
  const linkStat = await lstat(resolvedTarget);
  let target: string;
  if (linkStat.isSymbolicLink()) {
    const realParent = await realpath(dirname(resolvedTarget));
    if (!isInside(realRoot, realParent)) {
      throw new Error(`Delete path escapes workspace: ${relativePath}`);
    }
    target = join(realParent, basename(resolvedTarget));
  } else {
    target = await realpath(resolvedTarget);
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
    await moveIntoWorkspaceTrash(rootPath, target);
    return { trashed: false };
  }
}

// The workspace's own recovery location. MOVES an absolute path already proven
// to be inside the workspace into <root>/.dohc/trash and answers where it
// landed. Nothing here deletes: the recovery story is opening
// <workspace>/.dohc/trash in any file manager and moving the entry back.
export async function moveIntoWorkspaceTrash(
  rootPath: string,
  target: string,
): Promise<string> {
  const realRoot = await realpath(rootPath);
  const trashDir = join(await resolveWorkspaceMetadataDir(rootPath), "trash");
  // mkdir{recursive} throws a raw errno (EEXIST, or a Windows variant) when a
  // non-directory squats .dohc/trash. When SOMETHING is at the path, fall
  // through: the check below names the squatter and the way out, which the
  // errno does not. When nothing is there, the mkdir itself failed
  // (permissions, I/O) — rethrow that.
  try {
    await mkdir(trashDir, { recursive: true });
  } catch (error) {
    if (!(await lstat(trashDir).catch(() => null))) throw error;
  }
  // Validate AFTER mkdir, lstat-first (a pre-check is insufficient: mkdir
  // {recursive} silently no-ops on an existing symlink-to-dir, so only the
  // post-mkdir state proves where the rename would land). The check sits
  // immediately before the rename to keep the swap window minimal; a
  // colluding local process racing a symlink into .dohc between this check
  // and the rename is the accepted residual (Node has no renameat dirfd).
  const trashStat = await lstat(trashDir);
  if (trashStat.isSymbolicLink() || !trashStat.isDirectory()) {
    throw new Error(notARealFolderRefusal(DOHC_TRASH_GUARD, trashStat));
  }
  if (!isInside(realRoot, await realpath(trashDir))) {
    throw new Error(outsideWorkspaceRefusal(DOHC_TRASH_GUARD));
  }
  // Collision-resistant name: back-to-back deletes (multi-select) share a
  // Date.now() tick, and POSIX rename silently CLOBBERS an existing
  // destination — two same-basename deletes would destroy the first file's
  // bytes. The per-call UUID makes every trash entry unique. The basename is
  // decorative, so truncate it to fit NAME_MAX (255 bytes on ext4/APFS/NTFS):
  // a long source name + the 50-odd-byte unique prefix must not ENAMETOOLONG.
  // Renaming down a ladder rather than predicting which limit applies: the
  // real name first, then the component-fitted one, then one that also fits
  // the legacy MAX_PATH limit -- each reached only because the platform
  // refused the one above it. A name that fits is never shortened, and the
  // trash keeps no record of the original, so a dropped character is gone.
  const prefix = `${Date.now()}-${randomUUID()}-`;
  const plan = trashEntryPlan(basename(target), prefix, {
    unit: nameUnitFor(process.platform),
    maxEntryChars: entryCharBudget(trashDir, process.platform),
  });
  // Captured ONCE, before the first rename. A rung that failed for length
  // leaves a window in which another process can REPLACE the source, and the
  // next rung would move the replacement into the trash and report the delete
  // done -- for a file the user never selected. Re-reading this per rung would
  // compare the source with itself and reopen the window.
  const started = await lstat(target).catch(() => null);
  let moveError: unknown = null;
  for (const [rung, candidate] of plan.candidates.entries()) {
    if (rung > 0) {
      const stop = await ladderStop(target, started);
      // "could not check" stops it too: absent evidence is not permission to
      // move a file this code can no longer prove is the right one.
      if (stop) throw new Error(ladderStopReason(basename(target), stop));
    }
    const trashed = join(trashDir, candidate);
    try {
      await rename(target, trashed);
      return trashed;
    } catch (error) {
      moveError = error;
      // Only a length failure earns a shorter name. Windows reports an
      // over-long path as ENOENT, which is how #613 disguised itself;
      // anything else is not about length.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENAMETOOLONG" && code !== "ENOENT") throw error;
    }
  }
  if (plan.exhausted) {
    throw new Error(
      `dohc could not move ${basename(target)} to the workspace trash. The trash folder is ${trashDir.length} characters deep, and this platform allows ${WINDOWS_MAX_PATH_CHARS} characters for a whole path, which leaves no room for a trash entry name. Move the workspace to a shorter path.`,
    );
  }
  throw moveError;
}

// Export bounds: policy caps for what main will buffer into one in-memory
// archive (the container itself tops out at 65k entries / 4GB — zipWriter).
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

// Gathers the zip entries for a workspace export: the whole workspace, one
// folder, or one file. Ignored segments (.dohc, .git, node_modules) and
// symlinks never export. Secret-classified files (the .env family) never
// leave in an archive: the walk skips them, and an explicitly targeted secret
// refuses loudly (zips
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
    // The secret floor decided on BOTH spellings: `notes.md -> .env` spells an
    // ordinary file and exports the secret's bytes. The resolved location also
    // decides the reservation, so `link -> .dohc` cannot export workspace state.
    //
    // The archive is then read from the path this classified. Resolving a
    // second time would let the bytes come from somewhere the secret floor
    // never judged, which is the whole defect this guard exists for.
    const { relative: realRelative, resolvedAbsolute } = await assertResolvedWorkspacePath({
      rootPath,
      absolutePath: join(rootPath, validated.normalized),
      spelled: relativePath,
      label: "Export path",
      access: "read",
    });
    if (
      classifyEngineFilePathForRead(validated.normalized).kind === "secret" ||
      classifyEngineFilePathForRead(realRelative).kind === "secret"
    ) {
      throw new Error(
        `Secret files never leave the workspace in an export: ${validated.normalized}`,
      );
    }
    startAbsolute = resolvedAbsolute;
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
    //
    // O_NOFOLLOW is POSIX-only. On win32 it is undefined, so `?? 0` keeps the
    // flags well-formed instead of coercing the whole expression to 0, and the
    // no-follow half of the paragraph above does not hold there — the fstat and
    // the bounded read from one descriptor still do.
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
