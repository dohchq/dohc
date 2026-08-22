import { isAbsolute, relative, sep } from "node:path";

/**
 * True iff `child` is `parent` itself or nested under it. Both paths must be
 * absolute; a caller that has to survive symlinks passes realpath() outputs.
 *
 * This is the one containment predicate every desktop boundary imports —
 * a fix that lands here lands everywhere, instead of being inherited
 * file by file.
 *
 * Semantics the callers rely on:
 * - `child === parent` counts as inside, and so does equality after
 *   normalization (case folding on Windows, trailing separators) — the
 *   filesystem treats those as the same directory.
 * - On Windows, relative() across drives returns an absolute path
 *   (C:\ws -> D:\evil gives "D:\evil"), which is not a descendant.
 * - The ".." has to be a whole segment. Testing the prefix alone rejected
 *   real contained names — a child under "..cache/" is inside the root.
 */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  if (rel === "") return true;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
