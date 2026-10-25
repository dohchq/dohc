import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { isInside } from "../security/pathContainment";

// Resolve links, then read every name below the root from its folder. Linux
// realpath keeps lookup case even when the disk ignores it. Missing or escaped
// entries return null; unknown identities throw so callers cannot infer absence.
export async function diskSpelling(root: string, path: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    if (resolve(root) === resolve(path) || resolve(realRoot) === resolve(path)) return realRoot;
    // A handle's final path can name another hard link on Windows. Keep the
    // looked-up leaf unless it is itself a symlink; resolve its parent only.
    const entry = await lstat(path);
    const file = entry.isSymbolicLink()
      ? await realpath(path)
      : join(await realpath(dirname(path)), basename(path));
    if (!isInside(realRoot, file)) return null;
    if (file === realRoot) return realRoot;
    let stored = realRoot;
    for (const leaf of relative(realRoot, file).split(sep)) {
      const folder = stored;
      const lookup = await lstat(join(folder, leaf), { bigint: true });
      let names: string[];
      try {
        names = await readdir(folder);
      } catch {
        stored = join(folder, basename(await realpath(join(folder, leaf))));
        continue;
      }
      const name = await storedNameAmong(leaf, names, async (candidate) => {
        const other = await lstat(join(folder, candidate), { bigint: true }).catch(absentAsNull);
        return other !== null && other.dev === lookup.dev && other.ino === lookup.ino;
      });
      if (name === null) throw new Error(`Could not identify the stored name: ${join(folder, leaf)}`);
      stored = join(folder, name);
    }
    return stored;
  } catch (error) {
    return absentAsNull(error);
  }
}

export function absentAsNull(error: unknown): null {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  throw error;
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
