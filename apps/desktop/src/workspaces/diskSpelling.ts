import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { isInside } from "../security/pathContainment";

// Resolve links, then read every name below the root from its folder. Linux
// realpath keeps lookup case even when the disk ignores it. An unreadable,
// missing, escaped, or ambiguous entry has no known spelling.
export async function diskSpelling(root: string, path: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    if (resolve(root) === resolve(path) || resolve(realRoot) === resolve(path)) return realRoot;
    // A handle's final path can name another hard link on Windows. Keep the
    // looked-up leaf unless it is itself a symlink; resolve its parent only.
    const entry = await lstat(path, { bigint: true });
    const file = entry.isSymbolicLink()
      ? await realpath(path)
      : join(await realpath(dirname(path)), basename(path));
    if (!isInside(realRoot, file)) return null;
    if (file === realRoot) return realRoot;
    let stored = realRoot;
    for (const leaf of relative(realRoot, file).split(sep)) {
      const folder = stored;
      const lookup = await lstat(join(folder, leaf), { bigint: true });
      const name = await storedNameAmong(leaf, await readdir(folder), async (candidate) => {
        const other = await lstat(join(folder, candidate), { bigint: true }).catch(() => null);
        return other !== null && other.dev === lookup.dev && other.ino === lookup.ino;
      });
      if (name === null) return null;
      stored = join(folder, name);
    }
    return stored;
  } catch {
    return null;
  }
}

// Exact names win. Among identity matches, prefer names that fold like the
// lookup so an unrelated hard link cannot claim it. Never choose between two.
export async function storedNameAmong(
  leaf: string,
  names: readonly string[],
  sameFile: (name: string) => Promise<boolean>,
): Promise<string | null> {
  if (names.includes(leaf)) return leaf;
  const folded = pathCollisionKey(leaf);
  const like: string[] = [];
  const other: string[] = [];
  for (const name of names) {
    (pathCollisionKey(name) === folded ? like : other).push(name);
  }
  for (const group of [like, other]) {
    let stored: string | null = null;
    for (const name of group) {
      if (!(await sameFile(name))) continue;
      if (stored !== null) return null;
      stored = name;
    }
    if (stored !== null) return stored;
  }
  return null;
}
