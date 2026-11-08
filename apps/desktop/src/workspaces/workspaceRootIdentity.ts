import { readdirSync, statSync, type BigIntStats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, normalize, parse, relative, sep } from "node:path";
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

/** The names a folder lists, or null when it cannot be read. */
export function folderNamesSync(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

export async function folderNames(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch {
    return null;
  }
}

// The roots `at` may be another spelling of: the same names up to capitals,
// Unicode form and trailing dots or spaces. Only the disk can say if one is.
function respelledRoots<Entry>(
  roots: readonly RootCandidate<Entry>[],
  keys: readonly string[],
  at: string,
): RootCandidate<Entry>[] {
  const key = pathCollisionKey(at);
  return roots.filter((_, index) => keys[index] === key);
}

interface Respelling {
  // The folder that holds the name, in the anchor's spelling.
  folder: string;
  names: readonly [string, string];
}

// Each name the anchor spells another way than the root, or null when the
// two paths do not line up name by name.
function respellings(anchor: string, root: string): Respelling[] | null {
  const from = normalize(anchor);
  const to = normalize(root);
  const top = parse(from).root;
  if (parse(to).root !== top) return null;
  const fromNames = from.slice(top.length).split(sep).filter(Boolean);
  const toNames = to.slice(top.length).split(sep).filter(Boolean);
  if (fromNames.length !== toNames.length) return null;
  return fromNames.flatMap((name, index) => {
    const other = toNames[index] ?? name;
    return name === other ? [] : [{ folder: join(top, ...fromNames.slice(0, index)), names: [name, other] as const }];
  });
}

// A folder that ignores capitals lists one of two spellings of a name. A
// folder that tells them apart lists both when one is a mount of the other.
function listsOneOf(listed: readonly string[] | null, names: readonly [string, string]): boolean {
  return listed !== null && !(listed.includes(names[0]) && listed.includes(names[1]));
}

/**
 * The deepest folder on `path`, itself included, that is one of `roots`:
 * spelled the same, or else another spelling of the root's own name that the
 * disk folds onto it. `path` is absolute with links resolved. Another
 * spelling counts only when it is the same folder on disk and each folder
 * holding a respelled name lists at most one of the two spellings. So a root
 * reached through a mount does not match, because a mount inside either one
 * can put another file at the same place below it. Two roots that are both
 * other spellings of one folder match nothing. A call reads the disk only
 * where a folder on the path is a root spelled in other capitals or Unicode
 * forms.
 */
export function deepestRootSync<Entry>(
  path: string,
  roots: readonly RootCandidate<Entry>[],
  identify: (path: string) => FolderIdentity | null = (at) => folderIdentitySync(at),
  list: (path: string) => readonly string[] | null = folderNamesSync,
): RootMatch<Entry> | null {
  const keys = roots.map((root) => pathCollisionKey(root.path));
  for (let at = path; ; at = dirname(at)) {
    const spelled = roots.find((root) => samePath(root.path, at));
    if (spelled) return { entry: spelled.entry, root: spelled.path, anchor: at };
    const respelled = respelledRoots(roots, keys, at);
    const identity = respelled.length > 0 ? identify(at) : null;
    if (identity !== null) {
      const [match, ...others] = respelled.filter((root) => sameFolder(identify(root.path), identity));
      if (others.length > 0) return null;
      const names = match ? respellings(at, match.path) : null;
      if (match && names?.every(({ folder, names: pair }) => listsOneOf(list(folder), pair))) {
        return { entry: match.entry, root: match.path, anchor: at };
      }
    }
    if (dirname(at) === at) return null;
  }
}

/** deepestRootSync with asynchronous probes. */
export async function deepestRoot<Entry>(
  path: string,
  roots: readonly RootCandidate<Entry>[],
  identify: (path: string) => Promise<FolderIdentity | null> = (at) => folderIdentity(at),
  list: (path: string) => Promise<readonly string[] | null> = folderNames,
): Promise<RootMatch<Entry> | null> {
  const keys = roots.map((root) => pathCollisionKey(root.path));
  for (let at = path; ; at = dirname(at)) {
    const spelled = roots.find((root) => samePath(root.path, at));
    if (spelled) return { entry: spelled.entry, root: spelled.path, anchor: at };
    const respelled = respelledRoots(roots, keys, at);
    const identity = respelled.length > 0 ? await identify(at) : null;
    if (identity !== null) {
      const known = await Promise.all(respelled.map((root) => identify(root.path)));
      const [match, ...others] = respelled.filter((_, index) => sameFolder(known[index] ?? null, identity));
      if (others.length > 0) return null;
      const names = match ? respellings(at, match.path) : null;
      const listed = names ? await Promise.all(names.map(({ folder }) => list(folder))) : [];
      if (match && names?.every(({ names: pair }, index) => listsOneOf(listed[index] ?? null, pair))) {
        return { entry: match.entry, root: match.path, anchor: at };
      }
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
 * `path` spelled under `root` when one of its folders is `root`, as
 * deepestRoot finds it, or null. Both have links resolved. A path already spelled inside `root`
 * returns unchanged without a stat.
 */
export async function pathUnderRoot(
  root: string,
  path: string,
  identify?: (path: string) => Promise<FolderIdentity | null>,
  list?: (path: string) => Promise<readonly string[] | null>,
): Promise<string | null> {
  if (isInside(root, path)) return path;
  const match = await deepestRoot(path, [{ entry: root, path: root }], identify, list);
  return match === null ? null : onMatchedRoot(match, path);
}
