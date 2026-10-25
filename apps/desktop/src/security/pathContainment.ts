import { statSync, type BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import * as nativePath from "node:path";
import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";

type ContainmentPath = Pick<typeof nativePath, "isAbsolute" | "normalize" | "parse" | "sep" | "join">;
export type ContainmentStat = (path: string, options: { bigint: true }) => Pick<BigIntStats, "dev" | "ino">;

/**
 * True iff `child` is `parent` itself or nested under it — the one containment
 * predicate for canonical paths (realpath'd) on both sides. realpath carries
 * stored case on Windows and macOS, but Linux can retain the lookup spelling
 * on folders that ignore case. Exclusion checks use isInsideOrUnknown below
 * to resolve that ambiguity by folder identity. Keep this check case-sensitive
 * so distinct folders on case-sensitive disks stay distinct. Equality after
 * normalization counts as inside, including trailing-separator differences.
 */
export function isInside(parent: string, child: string, path: ContainmentPath = nativePath): boolean {
  const { isAbsolute, normalize, parse, sep } = path;
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

// The child's ancestor at the parent's depth, only when the folded prefix matches.
function foldedAncestor(parent: string, child: string, path: ContainmentPath): string | null {
  if (!path.isAbsolute(parent) || !path.isAbsolute(child)) return null;
  const normalizedParent = path.normalize(parent), normalizedChild = path.normalize(child);
  const parentRoot = path.parse(normalizedParent).root, childRoot = path.parse(normalizedChild).root;
  if (pathCollisionKey(parentRoot) !== pathCollisionKey(childRoot)) return null;
  const parentSegments = normalizedParent.slice(parentRoot.length).split(path.sep).filter(Boolean);
  const childSegments = normalizedChild.slice(childRoot.length).split(path.sep).filter(Boolean);
  if (parentSegments.length > childSegments.length
    || !parentSegments.every((segment, index) => pathCollisionKey(segment) === pathCollisionKey(childSegments[index]!))) return null;
  return path.join(childRoot, ...childSegments.slice(0, parentSegments.length));
}

/**
 * Exclusion only: true means inside or unable to check folder identity.
 * Never use this result to grant access. Callers resolve symlinks first.
 * Exact containment and prefixes that differ after folding need no stat.
 */
export function isInsideOrUnknownSync(parent: string, child: string, statPath: ContainmentStat = statSync, path: ContainmentPath = nativePath): boolean {
  if (isInside(parent, child, path)) return true;
  const ancestor = foldedAncestor(parent, child, path);
  if (ancestor === null) return false;
  try {
    const parentStat = statPath(parent, { bigint: true }), ancestorStat = statPath(ancestor, { bigint: true });
    return parentStat.dev === ancestorStat.dev && parentStat.ino === ancestorStat.ino;
  } catch { return true; }
}

/** Async form of isInsideOrUnknownSync, with the same exclusion-only rule. */
export async function isInsideOrUnknown(parent: string, child: string, statPath: (path: string, options: { bigint: true }) => Promise<ReturnType<ContainmentStat>> = stat, path: ContainmentPath = nativePath): Promise<boolean> {
  if (isInside(parent, child, path)) return true;
  const ancestor = foldedAncestor(parent, child, path);
  if (ancestor === null) return false;
  try {
    const [parentStat, ancestorStat] = await Promise.all([statPath(parent, { bigint: true }), statPath(ancestor, { bigint: true })]);
    return parentStat.dev === ancestorStat.dev && parentStat.ino === ancestorStat.ino;
  } catch { return true; }
}
