import { statSync, type BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

function identityMatches<Entry>(
  roots: readonly RootCandidate<Entry>[],
  identities: readonly (FolderIdentity | null)[],
  identity: FolderIdentity | null,
  anchor: string,
): RootMatch<Entry>[] {
  if (identity === null) return [];
  return roots.flatMap((root, index) =>
    sameFolder(identities[index] ?? null, identity) ? [{ entry: root.entry, root: root.path, anchor }] : []);
}

/**
 * The deepest folder on `path`, itself included, that is one of `roots`:
 * spelled the same, or else the same folder on disk. `path` is absolute with
 * links resolved. Two roots that are one folder, neither spelled as the path,
 * match nothing. Unless the path itself is spelled as a root, a call stats
 * each root once and each folder on the path until one matches.
 */
export function deepestRootSync<Entry>(
  path: string,
  roots: readonly RootCandidate<Entry>[],
  identify: (path: string) => FolderIdentity | null = (at) => folderIdentitySync(at),
): RootMatch<Entry> | null {
  let identities: (FolderIdentity | null)[] | null = null;
  for (let at = path; ; at = dirname(at)) {
    const spelled = roots.find((root) => samePath(root.path, at));
    if (spelled) return { entry: spelled.entry, root: spelled.path, anchor: at };
    identities ??= roots.map((root) => identify(root.path));
    if (identities.some((identity) => identity !== null)) {
      const matches = identityMatches(roots, identities, identify(at), at);
      if (matches.length > 0) return matches.length === 1 ? matches[0] : null;
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
  let identities: (FolderIdentity | null)[] | null = null;
  for (let at = path; ; at = dirname(at)) {
    const spelled = roots.find((root) => samePath(root.path, at));
    if (spelled) return { entry: spelled.entry, root: spelled.path, anchor: at };
    identities ??= await Promise.all(roots.map((root) => identify(root.path)));
    if (identities.some((identity) => identity !== null)) {
      const matches = identityMatches(roots, identities, await identify(at), at);
      if (matches.length > 0) return matches.length === 1 ? matches[0] : null;
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
 * `path` spelled under `root` when `root` is one of its folders on disk, or
 * null. Both have links resolved. A path already spelled inside `root`
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
