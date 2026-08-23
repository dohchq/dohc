import { isAbsolute, normalize, parse, sep } from "node:path";

/**
 * True iff `child` is `parent` itself or nested under it — the one containment
 * predicate every desktop boundary imports. Callers pass canonical paths
 * (realpath'd) on both sides. A realpath carries the filesystem's on-disk
 * casing, so the same on-disk directory never differs in case between two
 * realpath'd strings. Exact segment comparison is therefore safe on
 * case-sensitive trees and does not refuse paths on case-insensitive trees.
 * Case folding was only ever a substitute for canonicalization, not a real
 * requirement, and is now removed. Equality after normalization counts as
 * inside, including trailing-separator differences; a Windows cross-drive
 * child does not; and a child under a real "..cache" segment is inside.
 */
export function isInside(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;

  const normalizedParent = normalize(parent);
  const normalizedChild = normalize(child);
  const parentRoot = parse(normalizedParent).root;
  const childRoot = parse(normalizedChild).root;
  if (parentRoot !== childRoot) return false;

  const parentSegments = normalizedParent
    .slice(parentRoot.length)
    .split(sep)
    .filter(Boolean);
  const childSegments = normalizedChild
    .slice(childRoot.length)
    .split(sep)
    .filter(Boolean);
  if (parentSegments.length > childSegments.length) return false;
  return parentSegments.every((segment, index) => segment === childSegments[index]);
}
