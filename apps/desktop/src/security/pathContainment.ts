import { isAbsolute, relative, sep } from "node:path";

/**
 * True iff `child` is `parent` itself or nested under it — the one containment
 * predicate every desktop boundary imports. Both paths must be absolute; a
 * caller that has to survive symlinks passes realpath() outputs. Equality
 * after normalization (Windows case fold, trailing separators) counts as
 * inside; a Windows cross-drive child does not; and ".." escapes only as a
 * whole segment — a child under "..cache/" is inside the root.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
