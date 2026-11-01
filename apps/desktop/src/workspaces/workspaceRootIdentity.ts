import { statSync, type BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { sameFsEntry, type FsEntryIdentity } from "@dohc/workspace-core";
import { isInside } from "../security/pathContainment";

// Which folder on disk a workspace root is. On Linux a folder that ignores
// capitals answers to both /x/Notes and /x/notes, and realpath keeps the
// capitals it was given, so the path alone cannot say two spellings are one
// folder. The identity only finds a registered workspace or refuses a second
// one for the same folder. It grants nothing: the entry it finds still passes
// every other check, under its own registered path.

export type FolderIdentity = FsEntryIdentity;

export type FolderStat = Pick<BigIntStats, "dev" | "ino" | "isDirectory">;

const statFolderSync = (path: string): FolderStat => statSync(path, { bigint: true });
const statFolder = (path: string): Promise<FolderStat> => stat(path, { bigint: true });

// Null means unknown: not a folder, or a disk that gives no inode number.
export function folderIdentityOf(stats: FolderStat): FolderIdentity | null {
  if (!stats.isDirectory() || stats.ino === 0n) return null;
  return { dev: stats.dev, ino: stats.ino };
}

// A fresh stat each call. A stat error is unknown, not a different folder.
export function folderIdentitySync(
  path: string,
  statPath: (path: string) => FolderStat = statFolderSync,
): FolderIdentity | null {
  try {
    return folderIdentityOf(statPath(path));
  } catch {
    return null;
  }
}

export async function folderIdentity(
  path: string,
  statPath: (path: string) => Promise<FolderStat> = statFolder,
): Promise<FolderIdentity | null> {
  try {
    return folderIdentityOf(await statPath(path));
  } catch {
    return null;
  }
}

// Unknown matches nothing, not even another unknown.
export function sameFolder(left: FolderIdentity | null, right: FolderIdentity | null): boolean {
  return left !== null && right !== null && sameFsEntry(left, right) === "same";
}

// A map key for a known identity. Both numbers stay whole.
export function folderIdentityKey(identity: FolderIdentity): string {
  return `${identity.dev}:${identity.ino}`;
}

export interface RootCandidate<Entry> {
  entry: Entry;
  // The root with links resolved, as the caller's realpath spells it.
  path: string;
}

export interface RootMatch<Entry> {
  entry: Entry;
  root: string;
  // The folder on the walked path that is the root, in that path's capitals.
  anchor: string;
}

function samePath(left: string, right: string): boolean {
  return isInside(left, right) && isInside(right, left);
}

// The roots spelled like `at` in other capitals. Only a stat can say
// whether one of them is the folder at `at`.
function capitalAliases<Entry>(
  roots: readonly RootCandidate<Entry>[],
  keys: readonly string[],
  at: string,
): RootCandidate<Entry>[] {
  const key = pathCollisionKey(at);
  return roots.filter((_, index) => keys[index] === key);
}

// Two roots that are one folder match nothing.
function soleMatch<Entry>(matches: readonly RootCandidate<Entry>[], anchor: string): RootMatch<Entry> | null {
  const [match] = matches;
  return matches.length === 1 && match ? { entry: match.entry, root: match.path, anchor } : null;
}

/**
 * The deepest folder on `path`, itself included, that is one of `roots`:
 * spelled the same, or else spelled the same in other capitals and the same
 * folder on disk. `path` is absolute with links resolved. A root reached
 * under another name, as through a bind mount, does not match, because a
 * mount inside either one can put another file at the same place below it.
 * A call stats only a folder on the path that differs from a root in capitals
 * alone, and that root.
 */
export function deepestRootSync<Entry>(
  path: string,
  roots: readonly RootCandidate<Entry>[],
  identify: (path: string) => FolderIdentity | null = (at) => folderIdentitySync(at),
): RootMatch<Entry> | null {
  const keys = roots.map((root) => pathCollisionKey(root.path));
  for (let at = path; ; at = dirname(at)) {
    const spelled = roots.find((root) => samePath(root.path, at));
    if (spelled) return { entry: spelled.entry, root: spelled.path, anchor: at };
    const aliases = capitalAliases(roots, keys, at);
    const identity = aliases.length > 0 ? identify(at) : null;
    if (identity !== null) {
      const matches = aliases.filter((root) => sameFolder(identify(root.path), identity));
      if (matches.length > 0) return soleMatch(matches, at);
    }
    if (dirname(at) === at) return null;
  }
}

/** deepestRootSync with an asynchronous probe. */
export async function deepestRoot<Entry>(
  path: string,
  roots: readonly RootCandidate<Entry>[],
  identify: (path: string) => Promise<FolderIdentity | null> = (at) => folderIdentity(at),
): Promise<RootMatch<Entry> | null> {
  const keys = roots.map((root) => pathCollisionKey(root.path));
  for (let at = path; ; at = dirname(at)) {
    const spelled = roots.find((root) => samePath(root.path, at));
    if (spelled) return { entry: spelled.entry, root: spelled.path, anchor: at };
    const aliases = capitalAliases(roots, keys, at);
    const identity = aliases.length > 0 ? await identify(at) : null;
    if (identity !== null) {
      const known = await Promise.all(aliases.map((root) => identify(root.path)));
      const matches = aliases.filter((_, index) => sameFolder(known[index] ?? null, identity));
      if (matches.length > 0) return soleMatch(matches, at);
    }
    if (dirname(at) === at) return null;
  }
}

// `path` moved from its anchor onto the matched root's spelling. The part
// below the anchor keeps the caller's capitals.
export function onMatchedRoot(match: Pick<RootMatch<unknown>, "root" | "anchor">, path: string): string {
  const suffix = relative(match.anchor, path);
  return suffix === "" ? match.root : join(match.root, suffix);
}

/**
 * `path` spelled under `root` when one of its folders is `root` in the same
 * or other capitals, as deepestRoot finds it, or null. Both have links resolved. A path already spelled inside `root`
 * returns unchanged without a stat.
 */
export async function pathUnderRoot(
  root: string,
  path: string,
  identify?: (path: string) => Promise<FolderIdentity | null>,
): Promise<string | null> {
  if (isInside(root, path)) return path;
  const match = await deepestRoot(path, [{ entry: root, path: root }], identify);
  return match === null ? null : onMatchedRoot(match, path);
}
